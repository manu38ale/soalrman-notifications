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

(async () => {
  try {
    if (testTelegram) {
      await sendTelegram(`🔔 <b>Prueba del monitor Solarman</b> (${nowHavana()}). Si lees esto, el aviso por Telegram funciona.`);
      console.log('test telegram message sent');
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
      console.log(`\nheuristic check: ${GRID_FIELD}=${item[GRID_FIELD]} (grid up if it is a number, down if null)`);
      process.exit(0);
    }

    // Grid detection: purchasePower is null when the grid is down (no measurement),
    // and a number (positive, zero, or negative) when the grid is up.
    const ppRaw = item[GRID_FIELD];
    const gridUpNow = typeof ppRaw === 'number' && isFinite(ppRaw);
    const prev = state.gridUp;

    if (prev === null) {
      state = { ...state, gridUp: gridUpNow, agree: 1, lastPoll: nowHavana() };
      saveState(state);
      console.log(`initial state: grid ${gridUpNow ? 'UP' : 'DOWN'} (purchasePower=${item[GRID_FIELD]})`);
      return;
    }

    if (gridUpNow === prev) {
      state.agree = 0; state.lastPoll = nowHavana(); saveState(state);
      console.log(`steady: grid ${prev ? 'UP' : 'DOWN'} (purchasePower=${item[GRID_FIELD]})`);
      return;
    }

    state.agree = (state.agree || 0) + 1;
    if (state.agree >= AGREE_POLLS) {
      const wasDown = !prev && gridUpNow;
      state = { ...state, gridUp: gridUpNow, agree: 0, lastPoll: nowHavana(), lastChange: nowHavana() };
      saveState(state);
      console.log(`state change: grid ${prev ? 'UP' : 'DOWN'} -> ${gridUpNow ? 'UP' : 'DOWN'}`);
      if (wasDown) {
        await sendTelegram(`⚡ <b>Volvió la corriente</b> (${nowHavana()}). La red está en línea otra vez.`);
        console.log('telegram alert sent');
      }
      return;
    }
    state.lastPoll = nowHavana(); saveState(state);
    console.log(`flap guard: ${state.agree}/${AGREE_POLLS} agreeing polls (purchasePower=${item[GRID_FIELD]})`);
  } catch (e) {
    // Transient failure: keep previous state, do NOT alert. Cron will retry next run.
    console.error(`poll failed: ${e.message}`);
    process.exit(2);
  }
})();
