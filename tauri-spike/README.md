# Prototipo de rollerterm con Tauri

Prueba para medir cuánto más liviano sería rollerterm con Tauri (Rust + el webview del sistema) en vez de Electron.

Corre **la misma interfaz** de `src/renderer/`, sin cambios. `frontend/tauri-api.ts` reemplaza al preload: implementa `window.rollerterm` sobre comandos de Rust (`src-tauri/src/`).

**Ya portado:**
- Terminales.
- Pestañas: renombrar, etiquetas de estado, arrastrar entre sectores.
- Sectores (Tickets, En espera, Leer luego).
- Sesión: al cerrar la ventana se guarda la carpeta en la que quedó cada shell.
- Configuración y selector de carpetas.
- Notas.
- Links: se abren con `xdg-open`.
- Atajos: los de Electron en Linux.

**Pendiente:** correo, agenda, tickets (panel MCP), asistente, Railway, uso de Claude, recordatorios y exportar/importar. Hasta portarlos responden «todavía no está disponible».

**Datos:** se guardan en `~/.config/rollerterm-tauri`, aparte de Electron, así las dos versiones conviven. La primera vez se copian `session.json`, `settings.json` y `notes.json` de `~/.config/rollerterm`.

| Pieza | Electron | Tauri |
|---|---|---|
| PTY | `node-pty` (`src/main/pty-manager.ts`) | `portable-pty` (`src-tauri/src/pty.rs`) |
| Sesión, ajustes, notas | `session-store.ts`, `settings.ts`, `notes.ts` | `src-tauri/src/store.rs` |
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
