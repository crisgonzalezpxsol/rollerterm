# rollerterm

App de escritorio (macOS) con dos mitades:

- **Arriba, a la izquierda, la agenda:** tus reuniones de Google Calendar de las próximas 24 h,
  con aviso 5 minutos antes y al empezar cada llamada, y un botón para unirte.
- **Debajo de la agenda, los tickets** de Pxsol Agencias: tuyos, sin dueño y todos los abiertos.
- **Arriba, a la derecha, el correo:** tu bandeja de entrada de Gmail (leídos y no leídos), aviso
  de los nuevos, direcciones importantes y bloqueadas, y un resumen cada 3 horas de lo que
  mandaron las importantes.
- **Abajo, la terminal:** pestañas con nombre, una por ticket o por funcionalidad. Las pestañas,
  sus nombres y el directorio donde quedó cada una se recuerdan al cerrar y se restauran al abrir.

Y en la barra de arriba: un indicador de **producción en Railway**, un pomodoro, un **asistente**
(chat con Claude Code que recuerda tu jornada) y un panel lateral de **notas**.

## Instalación desde cero

Lleva unos 10 minutos. Se hace una sola vez.

### 1. Requisitos

| Qué | Cómo verificar | Si falta |
| --- | --- | --- |
| macOS | — | La app es solo para Mac. |
| Herramientas de línea de comandos de Xcode (git, compilador) | `xcode-select -p` muestra una ruta | `xcode-select --install` |
| Node.js 20 o más nuevo | `node -v` | Bajalo de [nodejs.org](https://nodejs.org) (versión LTS) o `brew install node` |
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` y abrí una terminal nueva |
| Cuenta de Claude (Pro, Max, Team o Enterprise) | — | La agenda usa los conectores de claude.ai; una API key sola no alcanza. |
| MCP de tickets de pxsol-agencias (opcional, para el panel de tickets) | `claude mcp list` muestra el servidor de tickets | Ver `scripts/mcp-tickets/README.md` en el repo pxsol-agencias |
| Railway CLI (opcional, para el indicador de producción) | `railway whoami` | `npm i -g @railway/cli` y después `railway login` |

### 2. Loguear Claude Code con tu cuenta de claude.ai

```bash
claude
```

La primera vez te pide iniciar sesión: elegí **la cuenta de claude.ai** (no "API key") y seguí los
pasos en el navegador. Cuando veas el prompt de Claude, salí con `/exit`.

### 3. Conectar Google Calendar y Gmail

1. En el navegador, entrá a [claude.ai](https://claude.ai) → **Configuración → Conectores**.
2. Buscá **Google Calendar**, tocá **Conectar** y autorizá con tu cuenta de Google (la del trabajo).
3. Repetí lo mismo con **Gmail**.
4. Verificalo desde la terminal:

   ```bash
   claude mcp list | grep -E "Google Calendar|Gmail"
   ```

   Las dos líneas tienen que decir `✔ Connected`. Si alguna dice `! Needs authentication`, corré
   `claude`, escribí `/mcp`, elegí **claude.ai Google Calendar** (o **claude.ai Gmail**) →
   **Authenticate** y seguí los pasos en el navegador.

Podés usar solo uno de los dos: el panel del que no esté conectado muestra un cartel y el otro
funciona igual.

### 4. Instalar y abrir la app

```bash
git clone https://github.com/crisgonzalezpxsol/rollerterm.git
cd rollerterm
npm install    # instala dependencias y compila la parte nativa de la terminal
npm start      # compila y abre la app
```

La primera vez, macOS pregunta si la app puede mandar **notificaciones**: decí que sí, porque si no
los avisos de llamadas no aparecen. Si lo rechazaste, activalas en Configuración del Sistema →
Notificaciones → rollerterm.

A los ~15–30 segundos la agenda y el correo tienen que mostrar **● Conectado**.

### 5. (Opcional) Instalarla como app

```bash
npm run install-app   # arma rollerterm.app y la copia a /Applications
```

Desde ahí se abre como cualquier app (Spotlight, Launchpad, Dock). Después de cambiar el código,
volvé a correr `npm run install-app`. Si solo querés el `.app` sin instalarlo: `npm run dist`
(queda en `out/mac-arm64/`). Usa la misma carpeta de datos que `npm start`, así que pestañas,
notas y configuración se comparten.

## Uso

| Acción | Cómo |
| --- | --- |
| Nueva pestaña | `⌘T` · botón `+` · doble clic en el hueco de la barra de pestañas |
| Renombrar | doble clic en el nombre · `⌘⇧R` (Enter guarda, Esc cancela) |
| Cerrar | `⌘W` · `×` · clic con la rueda |
| Cambiar de pestaña | `⌘1`…`⌘8`, `⌘9` = la última · `⌘⇧]` / `⌘⇧[` |
| Reordenar | arrastrar la pestaña |
| Reabrir una shell que terminó | Enter dentro de la pestaña (conserva el nombre) |
| Unirse a una llamada | botón **Unirme** en la agenda · clic en la notificación |
| Actualizar la agenda o el correo ya | `↻` en cada panel |
| Abrir un correo | clic en el correo (se abre en Gmail, en el navegador) · clic en la notificación |
| Marcar un remitente como importante / bloquearlo | pasá el mouse por el correo → `★` / `🚫` |
| Editar direcciones importantes y bloqueadas | botón **Direcciones** (acepta direcciones o dominios enteros: `empresa.com`) |
| Resumir lo de las importantes ahora | botón **Resumir** (últimas 24 h) |
| Abrir un ticket | clic en la fila (se abre en Pxsol Agencias) |
| Ver qué servicios de producción no están OK | clic en **Prod N/M** arriba a la derecha (clic en un servicio lo abre en Railway) |
| Asistente (abrir / cerrar el chat) | 💬 arriba a la derecha · `⌘⇧K` · `Esc` o `⌘W` lo cierran |
| Notas (abrir / cerrar el panel lateral) | 📝 arriba a la derecha · `⌘⇧N` · `Esc` o `⌘W` lo cierran |
| Silenciar sonidos y avisos | 🔔/🔕 arriba a la derecha · `⌘⇧M` |
| Configuración | ⚙ arriba a la derecha · `⌘,` |
| Pomodoro: menú (pausar, ir a foco / descanso / gracia, siguiente fase, reiniciar) | clic en 🍅 o en el reloj (arriba a la derecha) |
| Pomodoro: pausar / continuar directo | `⌘⇧P` |

### Agenda

- Se actualiza cada 10 minutos, al despertar la Mac y con `↻`.
- Avisa **5 minutos antes y al empezar** cada reunión que tenga link de videollamada (Meet, Zoom
  o Teams) y que no hayas rechazado. Los eventos sin videollamada se muestran pero no avisan.
- Si Google Calendar se desconecta, o Claude Code deja de funcionar, aparece un cartel rojo con
  cómo arreglarlo y una notificación. Mientras siga caído, la notificación se repite cada hora.
  Los eventos que ya se conocían se siguen avisando.

### Correo

- Muestra **todo el inbox de las últimas 48 h** (sin spam ni papelera). Los no leídos van en
  negrita con un punto azul.
- Se revisa cada 5 minutos mientras usás la Mac y cada 15 si está inactiva hace 10 minutos o más.
  También al despertar la Mac, al volver a la ventana (si pasaron más de 2 minutos) y con `↻`.
- Los correos **nuevos** (que llegan con la app abierta) se destacan en **cian** con la etiqueta
  NUEVO hasta que los abrís o los leés en otro lado; el encabezado muestra cuántos hay.
- Avisa con notificación cada correo nuevo sin leer; si llegan más de 2 juntos, en una sola. La
  primera vez que abrís la app no avisa de lo que ya tenías.
- Las direcciones **importantes (★)** van **arriba de todo**, resaltadas en amarillo, y se avisan
  siempre una por una.
- Las direcciones **bloqueadas (🚫)** se excluyen de la búsqueda misma: no aparecen ni avisan.
  Podés bloquear un dominio entero (`empresa.com`). Una dirección no puede estar en las dos listas.
- **Resumen de importantes:** cada 3 horas (si hay alguna dirección importante), Claude lee los
  hilos que mandaron desde el resumen anterior y arma un resumen en castellano, marcando los que
  esperan tu respuesta. Si hay algo, llega una notificación. El botón **Resumir** lo hace en el
  momento con las últimas 24 h.
- Las listas y el último resumen se guardan en `~/Library/Application Support/rollerterm/mail.json`.

### Cómo funciona por dentro

La app no guarda ninguna credencial de Google. Le pide los datos a Claude Code (`claude -p`), que
usa los conectores de Google Calendar y Gmail de tu cuenta de claude.ai, con permiso **solo de
lectura**: crear, modificar o borrar eventos y mandar, responder, borrar o etiquetar correos está
prohibido explícitamente. Se usa el modelo Haiku y se bloquean los demás conectores para que cada
consulta sea liviana. Uso aproximado de tu plan: agenda ~US$0,005 cada 10 min, correo ~US$0,015
por revisión, y cada resumen ~US$0,05.

### Tickets (Pxsol Agencias)

Tabla debajo de la agenda con los tickets sin cerrar, en tres pestañas: **Míos**, **Sin dueño**
y **Abiertos** (con la cantidad de cada una). Van primero los de SLA vencido, después por
prioridad y después los más nuevos. Un clic abre el ticket en la web de Agencias.

- Se revisa cada 3 minutos y al despertar la Mac.
- Avisa cuando te asignan un ticket nuevo y cuando a uno tuyo se le vence el SLA.
- La etiqueta junto al título muestra contra qué entorno se mira (**TESTING** o **PRODUCCIÓN**),
  según el `AGENCIAS_WEB_URL` del servidor MCP.
- Usa el **MCP de tickets** de pxsol-agencias tal como está configurado en Claude Code
  (`~/.claude.json`), lanzándolo directo y solo con `listar_tickets`: no pasa por Claude ni
  escribe nada. En Configuración → Tickets se elige el servidor (por defecto, el primero que
  parezca de tickets) o se oculta el panel.

### Producción (Railway)

El indicador **Prod N/M** de la barra de título muestra cuántos servicios del entorno
`production` de tus proyectos de Railway están OK. El punto:

- **verde:** todo OK (corriendo, o durmiendo en servicios serverless);
- **ámbar:** algo se está desplegando, o el último deploy falló pero sigue corriendo la versión
  anterior;
- **rojo (titila):** algún servicio está **caído**: crasheado o sin ninguna versión corriendo.

Un clic abre el detalle con lo que no está OK; un clic en un servicio lo abre en Railway. Se revisa
cada 2 minutos y al despertar la Mac. Avisa con notificación cuando un servicio se cae y cuando se
recupera (y, al abrir la app, si ya había alguno caído). En Configuración → Producción se elige
qué proyectos vigilar o se apaga el indicador.

Usa el CLI de Railway con tu sesión (`railway list` y `railway api`, solo lectura). No pasa por
Claude: no gasta uso del plan.

### Silencio

El botón 🔔 de la barra de título (o `⌘⇧M`) silencia la app de una: sin tictac ni timbre del
pomodoro y sin ninguna notificación (llamadas, correos, tickets, producción). Todo lo demás
sigue funcionando y a la vista. Se ve 🔕 mientras está silenciada y se recuerda al cerrar la app.

### Asistente

Un chat con Claude Code (💬 o `⌘⇧K`) para ir contándole la jornada y pedirle cosas:
«¿qué tengo hoy?», «recordame a las 15 llamar a René», «anotá que…», «resumime los correos de
Jorge de esta semana», «respondele a … que …».

- **Recuerda.** Cada día es una conversación (cada mensaje del día sigue la misma sesión de
  Claude). Lo que conviene recordar, Claude lo va guardando en su carpeta:
  `memoria.md` (lo durable: personas, proyectos, compromisos) y `diario/AAAA-MM-DD.md` (lo de cada
  día). Cuando le preguntás por otro día, lo busca ahí. Todo queda en
  `~/Library/Application Support/rollerterm/asistente/` (también el historial del chat, `chat.jsonl`).
- **Hace.** Crea **notas** (aparecen en el panel de notas) y **recordatorios** (a la hora suena
  una notificación y aparece en el chat). Busca, lee y resume **correos**, **agenda** y
  **tickets**, y ve lo que la app ya está mostrando sin volver a consultarlo.
- **Pregunta antes.** Todo lo que tiene efecto afuera — **enviar o responder un correo**, crear o
  cambiar un evento, comentar o cambiar un ticket — aparece en el chat como una tarjeta con lo
  que va a hacer exactamente (destinatario, asunto, cuándo, texto) y se ejecuta recién cuando
  tocás **Aprobar**. Los borradores de correo los crea sin preguntar (no salen de tu cuenta).
- **Modelo:** Sonnet por defecto; se cambia en Configuración → Asistente (Opus, más capaz; Haiku,
  más rápido). Usa el uso de tu plan de Claude como cualquier conversación.
- Por dentro: `claude -p` con `--resume` por día, un servidor MCP propio de la app
  (`rollerterm-mcp.cjs`, registrado en la carpeta del asistente) y `--permission-prompt-tool`
  para las aprobaciones. Solo se cargan los conectores que usa (Gmail, Calendar, tickets).

### Notas

Un panel lateral que se desliza desde la derecha, encima de todo, y no ocupa lugar en la
pantalla principal. Lista de notas (la más reciente arriba) y un editor de texto libre: la
primera línea es el título y se guarda sola mientras escribís. **Borrar** pide confirmación;
una nota que quedó vacía se descarta sola. Con el panel abierto, `⌘W` lo cierra en vez de cerrar
la pestaña de la terminal. Se guardan en `~/Library/Application Support/rollerterm/notes.json`.

### Configuración

Con ⚙ o `⌘,`. Los cambios se guardan al instante en
`~/Library/Application Support/rollerterm/settings.json`.

- **Navegador:** con cuál se abren «Unirme», los correos y los links de la terminal. Por defecto,
  el del sistema. En Chrome, Brave, Edge y otros basados en Chromium también se elige el **perfil**
  (por ejemplo, el de la cuenta del trabajo, para que Meet y Gmail abran con esa cuenta). **Probar**
  abre Google Calendar con lo elegido.
- **Pomodoro:** tictac sí/no, timbre sí/no y volumen.
- **Asistente:** modelo (Sonnet, Opus o Haiku).
- **Tickets:** mostrar u ocultar el panel y qué servidor MCP usar.
- **Producción (Railway):** mostrar u ocultar el indicador y qué proyectos vigilar.

### Pomodoro

Suena un **tictac** de reloj mientras corre y un **timbre** en cada cambio de fase: un *ding* al
empezar el descanso, uno suave al empezar la gracia y *ding-ding* al volver a trabajar. Se apagan
o se ajusta el volumen en Configuración → Pomodoro (con **Probar sonido**).

25 min de foco → 5 min de descanso → 1 min de gracia para acomodarse → foco otra vez, en ciclo,
con una notificación en cada cambio de fase. Un clic en el reloj abre un menú para pausar o
continuar, ir directo a foco, descanso o gracia (arranca esa fase de cero), pasar a la siguiente
fase o reiniciar.

La sesión de pestañas se guarda en `~/Library/Application Support/rollerterm/session.json`.

## Problemas comunes

Si un panel muestra un cartel rojo, tocá **Copiar detalle**: copia qué pasó exactamente (estado del
conector, qué respondió, errores de Claude Code) para pegarlo en un mensaje o un ticket. Cada fallo
también queda guardado en `~/Library/Application Support/rollerterm/claude.log`. Antes de mostrar
el cartel, la app reintenta una vez sola: los conectores de claude.ai a veces tropiezan unos segundos.

| Síntoma | Solución |
| --- | --- |
| Cualquier panel: **Claude Code no encontrado** | Instalá Claude Code (paso 1) y verificá que `claude --version` funcione en una terminal nueva. Después reabrí la app. |
| **Google Calendar / Gmail no configurado** | Falta el paso 3: conectalo en claude.ai → Configuración → Conectores y tocá `↻`. |
| **Google Calendar / Gmail desconectado** | En una pestaña: `claude` → `/mcp` → **claude.ai Google Calendar** (o **Gmail**) **→ Authenticate**. Después `↻`. |
| **Error al leer…** con "Not logged in" | La sesión de Claude Code expiró: corré `claude` en una pestaña, logueate y tocá `↻`. |
| No llegan notificaciones | Configuración del Sistema → Notificaciones → rollerterm → permitir. Revisá también que no esté activo "No molestar". |
| Tickets: **MCP de tickets no configurado** | Configurá el servidor de tickets de pxsol-agencias en Claude Code o elegilo en Configuración → Tickets. |
| Indicador **Prod ?** | Pasá el mouse para ver el motivo. Casi siempre es el CLI: instalalo (`npm i -g @railway/cli`) o renová la sesión con `railway login`. |
| En la barra de menú dice "Electron" en vez de "rollerterm" | Corré `npm run postinstall` (renombra el Electron que trae npm) y reabrí la app. |
| **`posix_spawnp failed`** al abrir una pestaña | npm instala el `spawn-helper` de node-pty sin permiso de ejecución. Corré `npm run postinstall`. |
| La terminal falla después de actualizar Electron | Hay que recompilar node-pty: `npm run postinstall`. |

## Arquitectura

Electron + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty)
(la misma base que la terminal integrada de VS Code), todo en TypeScript y empaquetado con esbuild.

```
src/main/       proceso principal: ventana, menú/atajos, una shell (pty) por pestaña, sesión,
                agenda y correo vía Claude Code (claude-runner.ts, calendar.ts, mail.ts),
                producción vía Railway CLI (railway.ts), tickets vía su MCP (tickets.ts,
                mcp-client.ts), notas (notes.ts), asistente (assistant.ts, bridge.ts,
                reminders.ts), configuración (settings.ts)
src/mcp/        servidor MCP de rollerterm que usa el asistente (notas, recordatorios, aprobaciones)
src/preload/    puente aislado: expone window.rollerterm a la ventana (sin Node en el renderer)
src/renderer/   la ventana: agenda, correo, tickets, notas, pomodoro, barra de pestañas y una terminal
                xterm por pestaña
src/shared/     tipos compartidos (Session, CalendarState, MailState, MenuCommand, RollertermApi)
assets/         logo.svg (fuente) e icon.png (ícono del Dock)
```

Si cambiás `assets/logo.svg`, regenerá el PNG con `npm run icon` (y el `.icns` con `iconutil`).
`scripts/brand-electron.sh` corre en el `postinstall`: le pone a la copia de Electron de
`node_modules` el nombre, el identificador (`com.pxsol.rollerterm`) y el ícono de la app.
