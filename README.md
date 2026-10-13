# Alerta de retorno de corriente (Solarman → Telegram)

Script en Node.js (solo librerías estándar, sin dependencias) que revisa cada
pocos minutos si volvió la corriente de la red en tu casa y te avisa por
Telegram con un DM de @museisposting_bot.

## Requisitos

- Node.js instalado (cualquier versión reciente).
- Tu Mac (o PC) encendido con internet cuando quieras que vigile.

## Configuración

El script lee todo de variables de entorno. Crea un archivo `.env` junto al
script (no lo compartas con nadie) con estos valores:

```
SOLARMAN_APP_ID=tu_app_id
SOLARMAN_APP_SECRET=tu_app_secret
SOLARMAN_EMAIL=tu_correo_de_solarman
SOLARMAN_PASSWORD=tu_contraseña_de_solarman
TELEGRAM_BOT_TOKEN=token_de_tu_bot
TELEGRAM_CHAT_ID=ID_del_bot
```

De dónde sale cada cosa:

- `SOLARMAN_APP_ID` y `SOLARMAN_APP_SECRET`: del correo que te mandó
  Solarman con las credenciales de la API.
- `SOLARMAN_EMAIL` y `SOLARMAN_PASSWORD`: tu login de la app de Solarman.
- `TELEGRAM_BOT_TOKEN`: abre @BotFather en Telegram, manda `/token` y
  elige @museisposting_bot. (Es tu bot, el token es tuyo.)
- `TELEGRAM_CHAT_ID`: ya viene puesto, es tu DM con el bot.

Para cargar las variables al correr el script:

```bash
set -a; source .env; set +a
```

## Probarlo

```bash
node grid-alert-poller.js --probe
```

Esto imprime los datos en tiempo real de tu planta SIN guardar estado ni
mandar alertas. Revisa que el campo `purchasePower` tenga sentido: si es
mayor de 20 W significa que hay corriente de la red.

Si el campo que indica la red en tu inversor es otro, edita las constantes
`GRID_FIELD` y `GRID_WATTS_ON` al inicio del script.

## Ponerlo a correr cada 5 minutos

En Mac o Linux, con cron:

```bash
crontab -e
```

Agrega esta línea (ajusta la ruta a donde guardaste el script y el `.env`):

```
*/5 * * * * cd /ruta/a/la/carpeta && set -a; source .env; set +a && /usr/local/bin/node grid-alert-poller.js >> grid-alert.log 2>&1
```

## Cómo funciona

- Guarda el último estado conocido en `grid-alert-state.json` (se crea solo).
- Necesita 2 lecturas seguidas que coincidan antes de declarar un cambio
  (evita falsas alarmas por un dato raro).
- Solo avisa cuando la corriente VUELVE (pasa de no hay a hay). Si se va la
  corriente no avisa, solo lo registra.
- Si la API falla un chequeo, no avisa ni borra el estado; reintenta al
  siguiente ciclo.
