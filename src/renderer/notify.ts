import { stopSpeaking } from "./speech";

/** Silencio global: sin sonidos ni notificaciones. Lo maneja el botón 🔔/🔕 de la barra. */
let muted = false;
export const isMuted = () => muted;
export function setMuted(value: boolean): void {
  muted = value;
  if (muted) stopSpeaking(); // también calla al asistente si estaba leyendo
}

/** Notificación del sistema; el clic trae la ventana al frente o hace lo que se indique. */
export function notify(title: string, body: string, onClick?: () => void): void {
  if (muted) return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => (onClick ? onClick() : window.focus());
  } catch (err) {
    console.error("[notify]", err);
  }
}
