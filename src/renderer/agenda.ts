// Panel de agenda: muestra las próximas 24 h y avisa antes de cada llamada.
// Los datos vienen del proceso main (CalendarSync); acá solo se pinta y se alerta.
import type { CalendarEvent, CalendarState, CalendarStatus, RollertermApi } from "../shared/types";
import { notify } from "./notify";

const MINUTE = 60_000;
/** Avisos por llamada: minutos antes del inicio (0 = al empezar). */
const ALERT_OFFSETS_MIN = [5, 0];
/** Mientras el calendario siga caído, se vuelve a avisar cada tanto. */
const DOWN_REMINDER_MS = 60 * MINUTE;

const STATUS_TEXT: Record<CalendarStatus, string> = {
  loading: "Conectando…",
  connected: "Conectado",
  disconnected: "Google Calendar desconectado",
  "not-configured": "Google Calendar no configurado",
  "no-claude": "Claude Code no encontrado",
  error: "Error al leer el calendario",
};

const FIX_TEXT: Partial<Record<CalendarStatus, string>> = {
  disconnected: "Abrí una pestaña, corré claude, escribí /mcp y volvé a autenticar «claude.ai Google Calendar».",
  "not-configured": "Conectá Google Calendar en claude.ai → Configuración → Conectores y después tocá ↻.",
  "no-claude": "Instalá Claude Code y logueate (ver README → Instalación desde cero).",
  error: "Revisá que claude funcione en una pestaña (por ejemplo, que la sesión no haya expirado) y tocá ↻.",
};

const isDown = (s: CalendarStatus) => s !== "loading" && s !== "connected";
const isCall = (e: CalendarEvent) => e.meetUrl !== null && !e.declined;

export function mountAgenda(root: HTMLElement, api: RollertermApi): void {
  root.innerHTML = `
    <div class="agenda-head">
      <h2>Agenda · próximas 24 h</h2>
      <span class="agenda-status"></span>
      <button class="agenda-refresh" title="Actualizar ahora">↻</button>
    </div>
    <div class="agenda-alert" hidden></div>
    <ol class="agenda-list"></ol>`;
  const statusEl = root.querySelector(".agenda-status") as HTMLSpanElement;
  const refreshBtn = root.querySelector(".agenda-refresh") as HTMLButtonElement;
  const alertEl = root.querySelector(".agenda-alert") as HTMLDivElement;
  const listEl = root.querySelector(".agenda-list") as HTMLOListElement;

  let state: CalendarState | null = null;
  const alerted = new Set<string>();
  let lastDownAlert = 0;
  let prevStatus: CalendarStatus = "loading";

  refreshBtn.addEventListener("click", () => api.refreshCalendar());

  function onState(next: CalendarState) {
    state = next;
    checkConnection(next);
    render();
  }

  // ---------- avisos de desconexión ----------

  function checkConnection(s: CalendarState) {
    if (s.syncing) return;
    const now = Date.now();
    if (isDown(s.status)) {
      const changed = s.status !== prevStatus;
      if (changed || now - lastDownAlert >= DOWN_REMINDER_MS) {
        lastDownAlert = now;
        notify(`rollerterm · ${STATUS_TEXT[s.status]}`, "Los avisos de llamadas pueden fallar. " + (FIX_TEXT[s.status] ?? ""));
      }
    } else if (s.status === "connected" && isDown(prevStatus)) {
      notify("rollerterm · Google Calendar", "Conectado de nuevo: los avisos de llamadas siguen activos.");
    }
    prevStatus = s.status;
  }

  // ---------- avisos de llamadas ----------

  function checkCalls() {
    if (!state) return;
    const now = Date.now();
    for (const e of state.events.filter(isCall)) {
      const start = Date.parse(e.start);
      for (const min of ALERT_OFFSETS_MIN) {
        const key = `${e.id}@${e.start}:${min}`;
        const at = start - min * MINUTE;
        // Ventana de 2 min: si la Mac estuvo dormida no se avisa de llamadas viejas.
        if (now >= at && now < at + 2 * MINUTE && !alerted.has(key)) {
          alerted.add(key);
          const when = min === 0 ? "Empieza ahora" : `En ${min} min`;
          notify(`📞 ${when}: ${e.title}`, "Clic para unirte a la llamada.", () => window.open(e.meetUrl!));
        }
      }
    }
  }

  // ---------- pintar ----------

  function render() {
    if (!state) return;
    const { status, syncing, lastSync, message } = state;
    statusEl.dataset.status = status;
    const synced = lastSync ? ` · ${fmtTime(lastSync)}` : "";
    statusEl.textContent = syncing && status === "loading" ? STATUS_TEXT.loading : `${STATUS_TEXT[status]}${synced}`;
    refreshBtn.disabled = syncing;
    refreshBtn.classList.toggle("spinning", syncing);

    alertEl.hidden = !isDown(status);
    if (isDown(status)) {
      alertEl.innerHTML = "";
      const title = document.createElement("strong");
      title.textContent = STATUS_TEXT[status];
      const detail = document.createElement("p");
      detail.textContent = [message, FIX_TEXT[status]].filter(Boolean).join(" ");
      alertEl.append(title, detail);
    }

    const now = Date.now();
    const upcoming = state.events.filter((e) => Date.parse(e.end) > now);
    listEl.innerHTML = "";
    if (upcoming.length === 0) {
      const empty = document.createElement("li");
      empty.className = "agenda-empty";
      empty.textContent = status === "loading" ? "Leyendo tu calendario…" : "Sin eventos en las próximas 24 horas.";
      listEl.append(empty);
      return;
    }
    for (const e of upcoming) listEl.append(renderEvent(e, now));
  }

  function renderEvent(e: CalendarEvent, now: number): HTMLLIElement {
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    const li = document.createElement("li");
    li.className = "agenda-event";
    li.classList.toggle("declined", e.declined);
    li.classList.toggle("now", start <= now && now < end);
    li.classList.toggle("soon", start > now && start - now <= 10 * MINUTE);

    const time = document.createElement("span");
    time.className = "ev-time";
    time.textContent = `${fmtTime(start)}–${fmtTime(end)}`;
    const title = document.createElement("span");
    title.className = "ev-title";
    title.textContent = e.title;
    title.title = e.title;
    const rel = document.createElement("span");
    rel.className = "ev-rel";
    rel.textContent = relative(start, end, now);
    li.append(time, title, rel);

    if (e.meetUrl) {
      const join = document.createElement("button");
      join.className = "ev-join";
      join.textContent = "Unirme";
      join.title = e.meetUrl;
      join.addEventListener("click", () => window.open(e.meetUrl!));
      li.append(join);
    }
    return li;
  }

  api.getCalendar().then(onState);
  api.onCalendar(onState);
  // Cada 15 s: revisar avisos y refrescar los "en X min".
  setInterval(() => {
    checkCalls();
    render();
  }, 15_000);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function relative(start: number, end: number, now: number): string {
  if (start <= now) return now < end ? "ahora" : "";
  const mins = Math.round((start - now) / MINUTE);
  if (mins < 60) return `en ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `en ${h} h ${m} min` : `en ${h} h`;
}
