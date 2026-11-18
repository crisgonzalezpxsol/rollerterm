// Atajos que cambian según el sistema: en Linux Ctrl+W y Ctrl+T son de la shell
// (borrar palabra, intercambiar letras), así que la app usa Ctrl+Shift como las terminales.
const MAC = navigator.userAgent.includes("Mac");

export const CLOSE_KEY = MAC ? "⌘W" : "Ctrl+Shift+W";
export const NEW_KEY = MAC ? "⌘T" : "Ctrl+Shift+T";
