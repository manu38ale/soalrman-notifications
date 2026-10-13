#!/usr/bin/env node
/*
 * grid-alert-poller.js — Solarman grid-return monitor for the home solar setup.
 *
 * One run = one poll. Intended to be scheduled every 5 minutes.
 *
 *   1. Gets an access token from Solarman Open API.
 *   2. Resolves the plant (station) id (discovered once via --probe, then cached in state).
 *   3. Reads station real-time data and derives grid presence from purchased power.
 *   4. Debounced state machine (2 agreeing polls before a state change), persisted in a state file.
 *   5. On down -> up transition, sends a Telegram DM via @museisposting_bot.
 *   6. Also checks inverter/device alarms each poll (best-effort); new alarms
 *      trigger a Telegram DM too. Every notification includes a status summary.
 *
 * Secrets come ONLY from environment variables. Tokens are never logged verbatim.
 *
 *   SOLARMAN_APP_ID        from Solarman's API-credentials email
 *   SOLARMAN_APP_SECRET    from Solarman's API-credentials email
 *   SOLARMAN_EMAIL         his Solarman app login email
 *   SOLARMAN_PASSWORD      his Solarman app login password (plain; the script sha256-hashes it)
 *   SOLARMAN_STATION_ID    optional; discovered via --probe on first run
 *   TELEGRAM_BOT_TOKEN     @museisposting_bot token (secure vault)
 *   TELEGRAM_CHAT_ID       his chat id with the bot (he must /start the bot once)
 *   STATE_FILE             optional; default ./grid-alert-state.json
 *
 * Modes:
 *   node grid-alert-poller.js --probe   print raw real-time fields (values only); no state changes, no alerts.
 *   node grid-alert-poller.js           normal poll.
 *
 * Exit codes: 0 = ok (or nothing to do), 1 = config error, 2 = transient API error.
 */

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const API_BASE = 'https://globalapi.solarmanpv.com';
const GRID_FIELD = 'purchasePower';   // "Purchased Power" (import from grid). See --probe notes.
const GRID_WATTS_ON = 20;             // above this = grid is up
const AGREE_POLLS = 2;                // consecutive agreeing polls needed for a state change

const probe = process.argv.includes('--probe');
const probeAlarms = process.argv.includes('--probe-alarms');
const testTelegram = process.argv.includes('--test-telegram');
const statePath = process.env.STATE_FILE || './grid-alert-state.json';

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env ${name}`); process.exit(1); }
  return v;
}

function reqJson(url, { method = 'POST', body = null, bearer = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    if (bearer) headers['Authorization'] = `bearer ${bearer}`;
    const req = https.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* keep raw */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sha256lower(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); // already lowercase
}

async function getToken() {
  const appId = need('SOLARMAN_APP_ID');
  const appSecret = need('SOLARMAN_APP_SECRET');
  const email = need('SOLARMAN_EMAIL');
  const password = need('SOLARMAN_PASSWORD');
  const url = `${API_BASE}/account/v1.0/token?appId=${encodeURIComponent(appId)}&language=en`;
  const res = await reqJson(url, {
    body: { appSecret, email, password: sha256lower(password) },
  });
  if (!res || !res.access_token) throw new Error(`no access_token in response (code=${res && res.code})`);
  return res.access_token;
}

async function listStations(token) {
  const res = await reqJson(`${API_BASE}/station/v1.0/list?language=en`, {
    body: { page: 1, size: 20 }, bearer: token,
  });
  const infos = res && (res.stationList || res.stationInfos || res.data || res.list) || [];
  if (!infos.length) {
    console.error('DEBUG station/list raw:', JSON.stringify(res).slice(0, 600));
  }
  return infos.map((s) => ({ id: s.id ?? s.stationId, name: s.name ?? s.stationName, networkStatus: s.networkStatus }));
}

async function realTime(token, stationId) {
  return reqJson(`${API_BASE}/station/v1.0/realTime?language=en`, {
    body: { stationId }, bearer: token,
  });
}

function firstDataItem(res) {
  // station/v1.0/realTime returns a flat object (fields directly on the response),
  // not nested under stationDataItems.
  if (res && typeof res === 'object' && ('purchasePower' in res || 'gridPower' in res)) return res;
  const items = res && (res.stationDataItems || res.dataItems || res.data);
  return (Array.isArray(items) && items[0]) || null;
}

async function sendTelegram(text) {
  const token = need('TELEGRAM_BOT_TOKEN');
  const chatId = need('TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await reqJson(url, { body: { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true } });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (e) { return { stationId: null, gridUp: null, agree: 0 }; }
}
function saveState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }

function nowHavana() {
  return new Date().toLocaleString('es-CU', { timeZone: 'America/Havana', hour12: false });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Multi-line status summary from the station realTime data (Spanish, plain).
function buildSummary(item, gridUp) {
  const lines = [];
  lines.push(gridUp ? 'Red: en línea' : 'Red: sin corriente');
  const soc = item.batterySoc;
  if (soc !== null && soc !== undefined) {
    let batt = `Batería: ${soc}%`;
    const dis = Number(item.dischargePower) || 0;
    const chg = Number(item.chargePower) || 0;
    if (dis > 0) batt += ` (descargando ${dis}W)`;
    else if (chg > 0) batt += ` (cargando ${chg}W)`;
    lines.push(batt);
  }
  if (typeof item.usePower === 'number') lines.push(`Casa: ${item.usePower}W`);
  if (typeof item.generationPower === 'number' && item.generationPower > 0) {
    lines.push(`Solar: ${item.generationPower}W`);
  } else {
    lines.push('Solar: 0W');
  }
  if (typeof item.purchasePower === 'number') lines.push(`De la red: ${item.purchasePower}W`);
  return lines.join('\n');
}

// --- Inverter-level data (via SOLARMAN_DEVICE_SN, the inverter's SN) ---
function invVal(dataList, key) {
  const e = dataList.find((d) => d.key === key);
  return e ? e.value : undefined;
}

// Grid presence from the inverter's mains input voltage (direct measurement).
function gridUpFromInverter(dataList) {
  const v1 = parseFloat(invVal(dataList, 'L1_MAIN_V'));
  const v2 = parseFloat(invVal(dataList, 'L2_MAIN_V'));
  return (isFinite(v1) && v1 > 50) || (isFinite(v2) && v2 > 50);
}

// Specific alarm/protection registers on this inverter family.
const ALARM_FIELDS = [
  { key: 'A_1', name: 'Alarms 1' },
  { key: 'A_2', name: 'Alarms 2' },
  { key: 'P_1', name: 'Protection 1' },
  { key: 'P_2', name: 'Protection 2' },
];

function extractInverterAlarms(dataList) {
  const alarms = [];
  for (const { key, name } of ALARM_FIELDS) {
    const v = invVal(dataList, key);
    if (v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0') {
      alarms.push(`${name}: ${v}`);
    }
  }
  return alarms;
}

function buildInverterSummary(dataList, gridUp) {
  const lines = [];
  const v1 = invVal(dataList, 'L1_MAIN_V');
  const v2 = invVal(dataList, 'L2_MAIN_V');
  lines.push(gridUp ? `Red: en línea (L1 ${v1}V / L2 ${v2}V)` : 'Red: sin corriente');
  const soc = invVal(dataList, 'B_left_cap1');
  const bv = invVal(dataList, 'B_V1');
  const bc = parseFloat(invVal(dataList, 'B_C1'));
  if (soc !== undefined) {
    let batt = `Batería: ${soc}%`;
    const parts = [];
    if (bv !== undefined) parts.push(`${bv}V`);
    if (isFinite(bc) && bc !== 0) parts.push(`${Math.abs(bc)}A ${bc > 0 ? 'descargando' : 'cargando'}`);
    if (parts.length) batt += ` (${parts.join(', ')})`;
    lines.push(batt);
  }
  const use = invVal(dataList, 'E_Puse_t1');
  if (use !== undefined) lines.push(`Casa: ${use}W`);
  const status = invVal(dataList, 'INV_ST1');
  if (status) lines.push(`Inversor: ${status}`);
  return lines.join('\n');
}

// --- Device alarm checking (best-effort; never breaks the main poll) ---
async function listDevices(token, stationId) {
  try {
    const res = await reqJson(`${API_BASE}/device/v1.0/list?language=en`, {
      body: { stationId, page: 1, size: 20 }, bearer: token,
    });
    return res && (res.deviceListInfos || res.deviceList || res.list || res.data) || [];
  } catch (e) {
    return [];
  }
}

async function getDeviceData(token, device) {
  const sn = device.deviceSn || device.sn || device.deviceSN;
  if (!sn) return null;
  try {
    return await reqJson(`${API_BASE}/device/v1.0/currentData?language=en`, {
      body: { deviceSn: sn }, bearer: token,
    });
  } catch (e) {
    return null;
  }
}

function extractAlarms(devData) {
  const alarms = [];
  const list = devData && (devData.dataList || devData.data);
  if (!Array.isArray(list)) return alarms;
  for (const d of list) {
    const key = String(d.key || d.name || '');
    const val = d.value;
    if (/alarm|fault|error|warning|fail/i.test(key)) {
      const v = String(val == null ? '' : val).toLowerCase().trim();
      if (v !== '' && v !== '0' && v !== 'no' && v !== 'normal' && v !== 'none' && v !== 'ok') {
        alarms.push(`${key}: ${val}`);
      }
    }
  }
  return alarms;
}

async function checkAlarms(token, stationId, state) {
  try {
    let sns = state.deviceSns;
    if (!sns) {
      if (process.env.SOLARMAN_DEVICE_SN) {
        sns = [process.env.SOLARMAN_DEVICE_SN];
      } else {
        const devices = await listDevices(token, stationId);
        sns = devices.map((d) => d.deviceSn || d.sn || d.deviceSN).filter(Boolean);
      }
      state.deviceSns = sns;
    }
    const found = [];
    for (const sn of sns) {
      const data = await getDeviceData(token, { deviceSn: sn });
      if (data) found.push(...extractAlarms(data));
    }
    return [...new Set(found)];
  } catch (e) {
    return [];
  }
}

(async () => {
  try {
    if (testTelegram) {
      await sendTelegram(`🔔 <b>Prueba del monitor Solarman</b> (${nowHavana()}). Si lees esto, el aviso por Telegram funciona.`);
      console.log('test telegram message sent');
      return;
    }
    if (probeAlarms) {
      const tkn = await getToken();
      const stations = await listStations(tkn);
      if (!stations.length) throw new Error('no stations on this account');
      const withDevices = stations.find((s) => s.networkStatus && s.networkStatus !== 'NO_DEVICE');
      const sid = process.env.SOLARMAN_STATION_ID || (withDevices || stations[0]).id;
      console.log(`station id=${sid}`);
      // Prefer a known device SN (env) to skip the device/list endpoint.
      const knownSn = process.env.SOLARMAN_DEVICE_SN;
      let sns = knownSn ? [knownSn] : [];
      if (!sns.length) {
        const devRes = await reqJson(`${API_BASE}/device/v1.0/list?language=en`, {
          body: { stationId: sid, page: 1, size: 20 }, bearer: tkn,
        });
        console.log('device/list raw:', JSON.stringify(devRes).slice(0, 600));
        const devices = devRes && (devRes.deviceListInfos || devRes.deviceList || devRes.list || devRes.data) || [];
        sns = devices.map((d) => d.deviceSn || d.sn || d.deviceSN).filter(Boolean);
      }
      if (!sns.length) { console.log('no device SNs found'); return; }
      for (const sn of sns) {
        console.log(`\n--- device sn=${sn} ---`);
        const cur = await reqJson(`${API_BASE}/device/v1.0/currentData?language=en`, {
          body: { deviceSn: sn }, bearer: tkn,
        });
        console.log('currentData keys:', cur ? Object.keys(cur).join(', ') : 'null');
        const list = cur && (cur.dataList || cur.data);
        if (Array.isArray(list)) {
          for (const e of list) {
            console.log(`  key="${e.key}" name="${e.name}" value=${JSON.stringify(e.value)}`);
          }
        } else {
          console.log('raw:', JSON.stringify(cur).slice(0, 1500));
        }
      }
      return;
    }
    const token = await getToken();
    let state = loadState();

    if (!state.stationId) {
      const stations = await listStations(token);
      if (!stations.length) throw new Error('no stations on this account');
      // Prefer the station that has devices (skip empty ones like NO_DEVICE),
      // unless SOLARMAN_STATION_ID is set explicitly.
      const withDevices = stations.find((s) => s.networkStatus && s.networkStatus !== 'NO_DEVICE');
      state.stationId = process.env.SOLARMAN_STATION_ID || (withDevices || stations[0]).id;
      const chosen = stations.find((s) => String(s.id) === String(state.stationId));
      console.log(`using station id=${state.stationId} (name="${(chosen && chosen.name) || '?'}")`);
      if (!state.stationId) throw new Error('empty station id');
    }

    const rt = await realTime(token, state.stationId);
    const item = firstDataItem(rt);
    if (!item) {
      console.error('DEBUG realTime raw:', JSON.stringify(rt).slice(0, 800));
      throw new Error('no stationDataItems in realTime response');
    }

    if (probe) {
      // Values only, keys sorted, no secrets, no state changes, no alerts.
      const clean = {};
      for (const k of Object.keys(item).sort()) clean[k] = item[k];
      console.log(JSON.stringify(clean, null, 2));
      const psn = process.env.SOLARMAN_DEVICE_SN;
      if (psn) {
        const pdata = await getDeviceData(token, { deviceSn: psn });
        const pdl = pdata && (pdata.dataList || pdata.data);
        if (Array.isArray(pdl) && pdl.length) {
          console.log(`\nheuristic check (inverter): L1_MAIN_V=${invVal(pdl, 'L1_MAIN_V')}V L2_MAIN_V=${invVal(pdl, 'L2_MAIN_V')}V (grid up if either > 50V)`);
          console.log(`alarms: ${JSON.stringify(extractInverterAlarms(pdl))}`);
          console.log(`\nsummary preview:\n${buildInverterSummary(pdl, gridUpFromInverter(pdl))}`);
        } else {
          console.log('\nheuristic check: no inverter dataList');
        }
      } else {
        console.log(`\nheuristic check: ${GRID_FIELD}=${item[GRID_FIELD]} (grid up if it is a number, down if null)`);
      }
      process.exit(0);
    }

    // Inverter-level data (direct mains voltage + alarm registers), when the
    // inverter SN is configured. Falls back to station-level purchasePower.
    let invList = null;
    const invSn = process.env.SOLARMAN_DEVICE_SN;
    if (invSn) {
      const invData = await getDeviceData(token, { deviceSn: invSn });
      const dl = invData && (invData.dataList || invData.data);
      if (Array.isArray(dl) && dl.length) invList = dl;
      else console.error('warning: no inverter dataList, using station-level fallback');
    }

    // Grid detection: prefer the inverter's mains input voltage (direct),
    // fall back to purchasePower (null = down, number = up).
    let gridUpNow, gridDetail;
    if (invList) {
      gridUpNow = gridUpFromInverter(invList);
      gridDetail = `mains L1=${invVal(invList, 'L1_MAIN_V')}V L2=${invVal(invList, 'L2_MAIN_V')}V`;
    } else {
      const ppRaw = item[GRID_FIELD];
      gridUpNow = typeof ppRaw === 'number' && isFinite(ppRaw);
      gridDetail = `purchasePower=${item[GRID_FIELD]}`;
    }
    const prev = state.gridUp;

    const summaryFor = (up) => invList ? buildInverterSummary(invList, up) : buildSummary(item, up);

    if (prev === null) {
      state = { ...state, gridUp: gridUpNow, agree: 1, lastPoll: nowHavana() };
      saveState(state);
      console.log(`initial state: grid ${gridUpNow ? 'UP' : 'DOWN'} (${gridDetail})`);
      return;
    }

    if (gridUpNow === prev) {
      state.agree = 0; state.lastPoll = nowHavana(); saveState(state);
      console.log(`steady: grid ${prev ? 'UP' : 'DOWN'} (${gridDetail})`);
    } else {
      state.agree = (state.agree || 0) + 1;
      if (state.agree >= AGREE_POLLS) {
        const wasDown = !prev && gridUpNow;
        state = { ...state, gridUp: gridUpNow, agree: 0, lastPoll: nowHavana(), lastChange: nowHavana() };
        if (wasDown) {
          await sendTelegram(`⚡ <b>Volvió la corriente</b> (${nowHavana()})\n${escapeHtml(summaryFor(true))}`);
          console.log('telegram alert sent');
        }
      } else {
        state.lastPoll = nowHavana();
        console.log(`flap guard: ${state.agree}/${AGREE_POLLS} agreeing polls (${gridDetail})`);
      }
      saveState(state);
    }

    // Alarm check (independent of grid state; best-effort).
    // Prefer the inverter's specific alarm registers; fall back to generic scan.
    const alarms = invList ? extractInverterAlarms(invList) : await checkAlarms(token, state.stationId, state);
    const prevAlarms = state.alarms || [];
    const newAlarms = alarms.filter((a) => !prevAlarms.includes(a));
    if (newAlarms.length) {
      const alarmLines = newAlarms.map(escapeHtml).join('\n');
      await sendTelegram(`🚨 <b>Alarma del inversor</b> (${nowHavana()})\n${alarmLines}\n${escapeHtml(summaryFor(gridUpNow))}`);
      console.log(`telegram alarm sent: ${newAlarms.length} new alarm(s)`);
    }
    if (JSON.stringify(alarms) !== JSON.stringify(prevAlarms)) {
      state.alarms = alarms;
    }
    saveState(state); // also persists discovered deviceSns
    return;
  } catch (e) {
    // Transient failure: keep previous state, do NOT alert. Cron will retry next run.
    console.error(`poll failed: ${e.message}`);
    process.exit(2);
  }
})();
