/** Notificación del sistema; el clic trae la ventana al frente o hace lo que se indique. */
export function notify(title: string, body: string, onClick?: () => void): void {
  try {
    const n = new Notification(title, { body });
    n.onclick = () => (onClick ? onClick() : window.focus());
  } catch (err) {
    console.error("[notify]", err);
  }
}
