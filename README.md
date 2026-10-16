# rollerterm

App de escritorio (macOS) con dos mitades:

- **Arriba, a la izquierda, la agenda:** tus reuniones de Google Calendar de las próximas 24 h,
  con aviso 5 minutos antes y al empezar cada llamada, y un botón para unirte.
- **Arriba, a la derecha, el correo:** tus no leídos de Gmail, aviso de los nuevos, direcciones
  importantes y bloqueadas, y un resumen cada 3 horas de lo que mandaron las importantes.
- **Abajo, la terminal:** pestañas con nombre, una por ticket o por funcionalidad. Las pestañas,
  sus nombres y el directorio donde quedó cada una se recuerdan al cerrar y se restauran al abrir.

Y un pomodoro en la barra de arriba.

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
git clone <url-del-repo> rollerterm   # o descomprimí el .zip que te pasaron
cd rollerterm
npm install    # instala dependencias y compila la parte nativa de la terminal
npm start      # compila y abre la app
```

La primera vez, macOS pregunta si la app puede mandar **notificaciones**: decí que sí, porque si no
los avisos de llamadas no aparecen. Si lo rechazaste, activalas en Configuración del Sistema →
Notificaciones → Electron.

A los ~15–30 segundos la agenda y el correo tienen que mostrar **● Conectado**.

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
| Pomodoro: iniciar / pausar | clic en 🍅 (arriba a la derecha) · `⌘⇧P` |
| Pomodoro: reiniciar | `↺` junto al reloj · menú Pomodoro → Reiniciar |

### Agenda

- Se actualiza cada 10 minutos, al despertar la Mac y con `↻`.
- Avisa **5 minutos antes y al empezar** cada reunión que tenga link de videollamada (Meet, Zoom
  o Teams) y que no hayas rechazado. Los eventos sin videollamada se muestran pero no avisan.
- Si Google Calendar se desconecta, o Claude Code deja de funcionar, aparece un cartel rojo con
  cómo arreglarlo y una notificación. Mientras siga caído, la notificación se repite cada hora.
  Los eventos que ya se conocían se siguen avisando.

### Correo

- Muestra los **no leídos del inbox de las últimas 48 h** y se actualiza cada 5 minutos, al
  despertar la Mac y con `↻`.
- Avisa de cada correo nuevo; si llegan más de 2 juntos, en una sola notificación. Los de
  direcciones **importantes (★)** se avisan siempre uno por uno y se destacan en amarillo. La
  primera vez que abrís la app no avisa de lo que ya tenías sin leer.
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
consulta sea liviana. Uso aproximado de tu plan: agenda ~US$0,005 cada 10 min, correo ~US$0,01
cada 5 min, y cada resumen ~US$0,05.

### Pomodoro

25 min de foco → 5 min de descanso → 1 min de gracia para acomodarse → foco otra vez, en ciclo,
con una notificación en cada cambio de fase.

La sesión de pestañas se guarda en `~/Library/Application Support/rollerterm/session.json`.

## Problemas comunes

| Síntoma | Solución |
| --- | --- |
| Cualquier panel: **Claude Code no encontrado** | Instalá Claude Code (paso 1) y verificá que `claude --version` funcione en una terminal nueva. Después reabrí la app. |
| **Google Calendar / Gmail no configurado** | Falta el paso 3: conectalo en claude.ai → Configuración → Conectores y tocá `↻`. |
| **Google Calendar / Gmail desconectado** | En una pestaña: `claude` → `/mcp` → **claude.ai Google Calendar** (o **Gmail**) **→ Authenticate**. Después `↻`. |
| **Error al leer…** con "Not logged in" | La sesión de Claude Code expiró: corré `claude` en una pestaña, logueate y tocá `↻`. |
| No llegan notificaciones | Configuración del Sistema → Notificaciones → Electron → permitir. Revisá también que no esté activo "No molestar". |
| **`posix_spawnp failed`** al abrir una pestaña | npm instala el `spawn-helper` de node-pty sin permiso de ejecución. Corré `npm run postinstall`. |
| La terminal falla después de actualizar Electron | Hay que recompilar node-pty: `npm run postinstall`. |

## Arquitectura

Electron + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty)
(la misma base que la terminal integrada de VS Code), todo en TypeScript y empaquetado con esbuild.

```
src/main/       proceso principal: ventana, menú/atajos, una shell (pty) por pestaña, sesión,
                agenda y correo vía Claude Code (claude-runner.ts, calendar.ts, mail.ts)
src/preload/    puente aislado: expone window.rollerterm a la ventana (sin Node en el renderer)
src/renderer/   la ventana: agenda, correo, pomodoro, barra de pestañas y una terminal xterm por pestaña
src/shared/     tipos compartidos (Session, CalendarState, MailState, MenuCommand, RollertermApi)
```
