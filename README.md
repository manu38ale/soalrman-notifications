# Solarman → Telegram: aviso de corriente

[![grid-alert](https://github.com/manu38ale/soalrman-notifications/actions/workflows/grid-alert.yml/badge.svg)](https://github.com/manu38ale/soalrman-notifications/actions/workflows/grid-alert.yml)

Recibe un DM en Telegram cuando **se va** o **vuelve** la corriente de la red, usando los datos de tu inversor Solarman. Corre **gratis en GitHub Actions cada 5 minutos**: sin servidores, sin PC encendida.

## Qué hace

- 🔌 Detecta la presencia de red midiendo el **voltaje de entrada del inversor** (L1/L2). Directo, sin adivinanzas.
- ⚡ Te avisa por Telegram cuando **se va** o **vuelve** la corriente.
- 🚨 Te avisa si el inversor reporta **alarmas o protecciones** nuevas.
- 📊 Cada aviso incluye un resumen: red, batería (% y cargando/descargando), consumo de la casa, estado del inversor.
- 🔇 Sin spam: confirma cada cambio con **2 lecturas seguidas** y el estado solo se guarda cuando algo cambia (los chequeos sin novedad no generan commits).

## Qué necesitas

1. Un inversor monitoreado con la app de Solarman.
2. Credenciales de la API de Solarman (**App ID** + **App Secret**). Se piden gratis a Solarman; en [doc.solarmanpv.com](https://doc.solarmanpv.com) explican cómo.
3. Un bot de Telegram (créalo con [@BotFather](https://t.me/BotFather)) y tu **chat ID** (escríbele `/start` al bot y revisa `https://api.telegram.org/bot<TU_TOKEN>/getUpdates`).
4. Una cuenta de GitHub. El fork debe ser **público** para que los minutos de Actions sean ilimitados y gratis.

## Uso en 5 minutos

1. Haz **fork** de este repo.
2. En tu fork, ve a **Settings → Secrets and variables → Actions → New repository secret** y crea uno por uno:

   | Secret | De dónde sale |
   |---|---|
   | `SOLARMAN_APP_ID` | Correo de Solarman con las credenciales API |
   | `SOLARMAN_APP_SECRET` | Correo de Solarman con las credenciales API |
   | `SOLARMAN_EMAIL` | Tu login de la app de Solarman |
   | `SOLARMAN_PASSWORD` | Tu contraseña de la app de Solarman |
   | `SOLARMAN_DEVICE_SN` | Número de serie del **inversor** (en la app, info del equipo) |
   | `TELEGRAM_BOT_TOKEN` | @BotFather → `/token` |
   | `TELEGRAM_CHAT_ID` | Tu chat con el bot |

3. Ve a **Actions → grid-alert → Run workflow → Run workflow**. Tiene que correr en verde.
4. Listo. El cron (`*/5 * * * *`) lo ejecuta solo cada 5 minutos.

## Cómo funciona

Un solo script en Node.js, sin dependencias (`grid-alert-poller.js`):

1. Se autentica contra la API de Solarman (la contraseña va en SHA256, como pide Solarman).
2. Lee los datos en tiempo real del inversor vía `device/v1.0/currentData`.
3. Determina si hay red: voltaje de entrada L1/L2 > 50V = hay corriente.
4. Revisa los registros de alarma del inversor (`Alarms 1/2`, `Protection 1/2`).
5. Si hubo un cambio confirmado (2 lecturas seguidas) o una alarma nueva, manda el DM.
6. Guarda el estado en `grid-alert-state.json` en el propio repo.

Sin `SOLARMAN_DEVICE_SN`, usa como respaldo los datos de la planta (`station/v1.0/realTime`, campo `purchasePower`), pero sin alarmas del inversor.

## Probarlo en local (opcional)

```bash
# Ver los datos de tu planta sin guardar estado ni mandar alertas
node grid-alert-poller.js --probe

# Ver todos los campos de tu inversor (para encontrar alarmas en otros modelos)
SOLARMAN_DEVICE_SN=tu_sn node grid-alert-poller.js --probe-alarms

# Probar que el Telegram funciona
node grid-alert-poller.js --test-telegram
```

Con un `.env` así (no lo subas al repo):

```
SOLARMAN_APP_ID=...
SOLARMAN_APP_SECRET=...
SOLARMAN_EMAIL=...
SOLARMAN_PASSWORD=...
SOLARMAN_DEVICE_SN=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Otros modelos de inversor

Los nombres de los campos (`L1_MAIN_V`, `A_1`, etc.) son de mi inversor. Si el tuyo es otro modelo, corre `--probe-alarms`, busca los campos equivalentes y ajusta las constantes al inicio del script (`ALARM_FIELDS` y la función `gridUpFromInverter`).

## Notas

- La API de Solarman rechaza contraseñas largas o con caracteres especiales (error `2101025`) aunque en la app funcionen bien. Si te da ese error, cambia tu contraseña de Solarman a una de máximo 16 caracteres, solo letras y números.
- El endpoint `device/v1.0/list` puede devolver `auth invalid token` según tu cuenta; por eso el script usa el SN del inversor directo en vez de descubrirlo.
- Los horarios de GitHub Actions son aproximados: el cron de 5 minutos a veces se demora unos minutos.
