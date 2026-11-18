// Entrada del frontend en Tauri: primero instala `window.rollerterm` sobre Rust y
// después carga la interfaz de siempre (src/renderer/), sin cambios.
import "./tauri-api";
import "../../src/renderer/renderer";
