# rollerterm

App de escritorio (macOS) con dos mitades:

- **Arriba, la agenda:** tus reuniones de Google Calendar de las próximas 24 h, con aviso
  5 minutos antes y al empezar cada llamada, y un botón para unirte.
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

### 3. Conectar Google Calendar

1. En el navegador, entrá a [claude.ai](https://claude.ai) → **Configuración → Conectores**.
2. Buscá **Google Calendar**, tocá **Conectar** y autorizá con tu cuenta de Google (la del trabajo).
3. Verificalo desde la terminal:

   ```bash
   claude mcp list | grep "Google Calendar"
   ```

   Tiene que decir `✔ Connected`. Si dice `! Needs authentication`, corré `claude`, escribí `/mcp`,
   elegí **claude.ai Google Calendar → Authenticate** y seguí los pasos en el navegador.

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

A los ~15 segundos la agenda tiene que mostrar **● Conectado** y tus reuniones.

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
| Actualizar la agenda ya | `↻` en la agenda |
| Pomodoro: iniciar / pausar | clic en 🍅 (arriba a la derecha) · `⌘⇧P` |
| Pomodoro: reiniciar | `↺` junto al reloj · menú Pomodoro → Reiniciar |

### Agenda

- Se actualiza cada 10 minutos, al despertar la Mac y con `↻`.
- Avisa **5 minutos antes y al empezar** cada reunión que tenga link de videollamada (Meet, Zoom
  o Teams) y que no hayas rechazado. Los eventos sin videollamada se muestran pero no avisan.
- Si Google Calendar se desconecta, o Claude Code deja de funcionar, aparece un cartel rojo con
  cómo arreglarlo y una notificación. Mientras siga caído, la notificación se repite cada hora.
  Los eventos que ya se conocían se siguen avisando.
- **Cómo funciona por dentro:** la app no guarda ninguna credencial de Google. Le pide los eventos
  a Claude Code (`claude -p`), que usa el conector de Google Calendar de tu cuenta de claude.ai,
  con permiso **solo de lectura**. Cada consulta usa el modelo Haiku y cuesta alrededor de
  US$0,005 de uso de tu plan.

### Pomodoro

25 min de foco → 5 min de descanso → 1 min de gracia para acomodarse → foco otra vez, en ciclo,
con una notificación en cada cambio de fase.

La sesión de pestañas se guarda en `~/Library/Application Support/rollerterm/session.json`.

## Problemas comunes

| Síntoma | Solución |
| --- | --- |
| Agenda: **Claude Code no encontrado** | Instalá Claude Code (paso 1) y verificá que `claude --version` funcione en una terminal nueva. Después reabrí la app. |
| Agenda: **Google Calendar no configurado** | Falta el paso 3: conectá Google Calendar en claude.ai → Configuración → Conectores y tocá `↻`. |
| Agenda: **Google Calendar desconectado** | En una pestaña: `claude` → `/mcp` → **claude.ai Google Calendar → Authenticate**. Después `↻`. |
| Agenda: **Error al leer el calendario** con "Not logged in" | La sesión de Claude Code expiró: corré `claude` en una pestaña, logueate y tocá `↻`. |
| No llegan notificaciones | Configuración del Sistema → Notificaciones → Electron → permitir. Revisá también que no esté activo "No molestar". |
| **`posix_spawnp failed`** al abrir una pestaña | npm instala el `spawn-helper` de node-pty sin permiso de ejecución. Corré `npm run postinstall`. |
| La terminal falla después de actualizar Electron | Hay que recompilar node-pty: `npm run postinstall`. |

## Arquitectura

Electron + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty)
(la misma base que la terminal integrada de VS Code), todo en TypeScript y empaquetado con esbuild.

```
src/main/       proceso principal: ventana, menú/atajos, una shell (pty) por pestaña, sesión,
                sincronización de la agenda vía Claude Code (calendar.ts)
src/preload/    puente aislado: expone window.rollerterm a la ventana (sin Node en el renderer)
src/renderer/   la ventana: agenda, pomodoro, barra de pestañas y una terminal xterm por pestaña
src/shared/     tipos compartidos (Session, CalendarState, MenuCommand, RollertermApi)
```
