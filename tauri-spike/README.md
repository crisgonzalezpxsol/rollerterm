# Prototipo de rollerterm con Tauri

Prueba para medir cuánto más liviano sería rollerterm con Tauri (Rust + el webview del sistema) en vez de Electron.

**Qué incluye:** pestañas con nombre (doble clic para renombrar), `+`, `Ctrl+Shift+T` / `Ctrl+Shift+W`, y xterm.js con el mismo tema, conectado a una shell de login por pestaña.

**Qué no incluye:** notas, tickets, asistente, mail, calendario, sesiones guardadas ni ajustes.

| Pieza | Electron | Prototipo |
|---|---|---|
| PTY | `node-pty` (`src/main/pty-manager.ts`) | `portable-pty` (`src-tauri/src/main.rs`) |
| IPC | `ipcMain` + preload | `#[tauri::command]` + `Channel` |
| Interfaz | Chromium empaquetado | WebKitGTK del sistema |
| Frontend | `src/renderer/` | `frontend/main.ts` (el mismo xterm.js de `node_modules`) |

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
