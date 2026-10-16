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

/** Pinta el cartel rojo con el problema, cómo arreglarlo y el detalle técnico para copiar. */
export function renderAlert(
  el: HTMLElement,
  label: string,
  status: ConnectorStatus,
  message: string | null,
  detail: string | null,
): void {
  el.hidden = !isDown(status);
  if (el.hidden) return;
  // El detalle abierto se mantiene abierto aunque el panel se vuelva a pintar.
  const wasOpen = !!el.querySelector("pre:not([hidden])");
  el.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = statusText(label, status);
  const text = document.createElement("p");
  text.textContent = [message, fixText(label, status)].filter(Boolean).join(" ");
  el.append(title, text);
  if (detail) el.append(...detailControls(detail, wasOpen));
}

/** Botones "Ver detalle" / "Copiar detalle" y el bloque con el texto técnico. */
export function detailControls(detail: string, open = false): HTMLElement[] {
  const pre = document.createElement("pre");
  pre.className = "detail";
  pre.textContent = detail;
  pre.hidden = !open;
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const toggle = document.createElement("button");
  toggle.textContent = open ? "Ocultar detalle" : "Ver detalle";
  toggle.addEventListener("click", () => {
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? "Ver detalle" : "Ocultar detalle";
  });
  const copy = document.createElement("button");
  copy.textContent = "Copiar detalle";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(detail).then(
      () => {
        copy.textContent = "¡Copiado!";
        setTimeout(() => (copy.textContent = "Copiar detalle"), 1500);
      },
      (err) => console.error("[copiar detalle]", err),
    );
  });
  actions.append(toggle, copy);
  return [actions, pre];
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
