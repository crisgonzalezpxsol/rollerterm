// Estado de un conector de claude.ai (Google Calendar, Gmail): textos para mostrar y
// avisos cuando se cae o vuelve.
import type { ConnectorStatus } from "../shared/types";
import { notify } from "./notify";

/** Mientras siga caído, se vuelve a avisar cada tanto. */
const DOWN_REMINDER_MS = 60 * 60_000;

export const isDown = (s: ConnectorStatus) => s !== "loading" && s !== "connected";

export function statusText(label: string, s: ConnectorStatus): string {
  switch (s) {
    case "loading": return "Conectando…";
    case "connected": return "Conectado";
    case "disconnected": return `${label} desconectado`;
    case "not-configured": return `${label} no configurado`;
    case "no-claude": return "Claude Code no encontrado";
    case "error": return `Error al leer ${label}`;
  }
}

export function fixText(label: string, s: ConnectorStatus): string {
  switch (s) {
    case "disconnected": return `Abrí una pestaña, corré claude, escribí /mcp y volvé a autenticar «claude.ai ${label}». Después tocá ↻.`;
    case "not-configured": return `Conectá ${label} en claude.ai → Configuración → Conectores y después tocá ↻.`;
    case "no-claude": return "Instalá Claude Code y logueate (ver README → Instalación desde cero).";
    case "error": return "Revisá que claude funcione en una pestaña (por ejemplo, que la sesión no haya expirado) y tocá ↻.";
    default: return "";
  }
}

/** Notifica cuando el conector se cae (y cada hora mientras siga caído) y cuando vuelve. */
export function connectionWatcher(label: string, consequence: string): (status: ConnectorStatus) => void {
  let prev: ConnectorStatus = "loading";
  let lastAlert = 0;
  return (status) => {
    const now = Date.now();
    if (isDown(status)) {
      if (status !== prev || now - lastAlert >= DOWN_REMINDER_MS) {
        lastAlert = now;
        notify(`rollerterm · ${statusText(label, status)}`, `${consequence} ${fixText(label, status)}`);
      }
    } else if (status === "connected" && isDown(prev)) {
      notify(`rollerterm · ${label}`, "Conectado de nuevo.");
    }
    prev = status;
  };
}

/** Pinta el cartel rojo con el problema y cómo arreglarlo. */
export function renderAlert(el: HTMLElement, label: string, status: ConnectorStatus, message: string | null): void {
  el.hidden = !isDown(status);
  if (el.hidden) return;
  el.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = statusText(label, status);
  const detail = document.createElement("p");
  detail.textContent = [message, fixText(label, status)].filter(Boolean).join(" ");
  el.append(title, detail);
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
