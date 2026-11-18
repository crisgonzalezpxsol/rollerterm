# Prototipo de rollerterm con Tauri

Prueba para medir cuánto más liviano sería rollerterm con Tauri (Rust + el webview del sistema) en vez de Electron.

Corre **la misma interfaz** de `src/renderer/`, sin cambios. `frontend/tauri-api.ts` reemplaza al preload: implementa `window.rollerterm` sobre comandos de Rust (`src-tauri/src/`).

**Portado:** todo `src/main/` de Electron.
- Terminales, pestañas, sectores y sesión.
- Configuración, notas y recordatorios.
- Agenda y correo, vía conectores de claude.ai.
- Asistente: el servidor MCP es este mismo binario con `--mcp`, así que no hace falta Node.
- Tickets (MCP por stdio), Railway, uso de Claude y exportar/importar.
- Notificaciones nativas.

**Solo en Tauri:** monitor de sistema en la cabecera (CPU y RAM disponible/total, leídos de `/proc`).

**Diferencias en Linux:**
- Los links se abren con el navegador predeterminado (`xdg-open`).
- La inactividad se aproxima con el foco de la ventana.
- El asistente no lee en voz alta, porque WebKitGTK no tiene síntesis de voz.

**Datos:** se guardan en `~/.config/rollerterm-tauri`, aparte de Electron, así las dos versiones conviven. La primera vez se copian de `~/.config/rollerterm` la sesión, la configuración, las notas, el correo, los recordatorios y la carpeta del asistente (memoria, diario y conversaciones).

| Pieza | Electron | Tauri |
|---|---|---|
| PTY | `node-pty` (`src/main/pty-manager.ts`) | `portable-pty` (`pty.rs`) |
| Sesión, ajustes, notas | `session-store.ts`, `settings.ts`, `notes.ts` | `store.rs` |
| Claude Code, agenda, correo | `claude-runner.ts`, `calendar.ts`, `mail.ts` | `claude_runner.rs`, `calendar.rs`, `mail.rs` |
| Asistente | `assistant.ts`, `bridge.ts`, `rollerterm-mcp.cjs` | `assistant.rs`, `bridge.rs`, `mcp_server.rs`, `rt_tools.rs` |
| Tickets, Railway, uso | `tickets.ts`, `mcp-client.ts`, `railway.ts`, `claude-usage.ts` | `tickets.rs`, `mcp_client.rs`, `railway.rs`, `usage.rs` |
| IPC | `ipcMain` + preload | `#[tauri::command]` + `frontend/tauri-api.ts` |
| Motor de la interfaz | Chromium empaquetado | WebKitGTK del sistema |

Los errores de JavaScript de la ventana salen por la consola con el prefijo `[ventana]`, porque en release no hay devtools.

## Instalar dependencias (una sola vez, Ubuntu 24.04)

```sh
sudo apt install -y build-essential curl libwebkit2gtk-4.1-dev libgtk-3-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libssl-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
```

## Correr

Desde la raíz del repo:

```sh
npm run spike:tauri          # compila en release y abre la app
npm run spike:tauri:build    # solo compila
```

La primera compilación tarda unos minutos; después es incremental. El binario queda en `tauri-spike/src-tauri/target/release/rollerterm-tauri`.

## Instalar como app

```sh
npm run spike:tauri:install
```

Compila y la agrega al menú de aplicaciones como «rollerterm (Tauri)», al lado de la versión Electron (no la reemplaza). Queda en `~/.local/opt/rollerterm-tauri`. Para actualizarla después de un cambio, se corre lo mismo; se puede reinstalar con la app abierta y el cambio se ve al reabrirla.

## Medir

```sh
ls -lh tauri-spike/src-tauri/target/release/rollerterm-tauri   # tamaño (contra los 311 MB de out/linux-unpacked)
sh tauri-spike/measure.sh rollerterm-tauri                     # RAM del prototipo y de los procesos de WebKit
sh tauri-spike/measure.sh rollerterm                           # RAM de la versión Electron, misma vara
```

`measure.sh` suma la PSS del proceso y de sus hijos, sin contar las shells de las pestañas. Electron no deja leer la PSS de sus procesos sandboxeados, así que para esos usa RSS y lo marca. Eso infla un poco el total de Electron.

Para ver cómo rinde xterm.js en WebKitGTK, probá en las dos apps:

```sh
time seq 1 2000000           # mucha salida de golpe
htop                         # redibujado de pantalla completa
claude                       # una TUI real
```

Fijate también en la latencia al tipear, el scroll y la nitidez de las fuentes.
