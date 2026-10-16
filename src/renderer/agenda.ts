// Panel de agenda: muestra las próximas 24 h y avisa antes de cada llamada.
// Los datos vienen del proceso main (CalendarSync); acá solo se pinta y se alerta.
import type { CalendarEvent, CalendarState, RollertermApi } from "../shared/types";
import { connectionWatcher, fmtTime, renderAlert, statusText } from "./connector";
import { notify } from "./notify";

const LABEL = "Google Calendar";
const MINUTE = 60_000;
/** Avisos por llamada: minutos antes del inicio (0 = al empezar). */
const ALERT_OFFSETS_MIN = [5, 0];

const isCall = (e: CalendarEvent) => e.meetUrl !== null && !e.declined;

export function mountAgenda(root: HTMLElement, api: RollertermApi): void {
  root.classList.add("panel");
  root.innerHTML = `
    <div class="panel-head">
      <h2>Agenda · próximas 24 h</h2>
      <span class="panel-status"></span>
      <button class="panel-refresh" title="Actualizar ahora">↻</button>
    </div>
    <div class="panel-alert" hidden></div>
    <ol class="panel-list"></ol>`;
  const statusEl = root.querySelector(".panel-status") as HTMLSpanElement;
  const refreshBtn = root.querySelector(".panel-refresh") as HTMLButtonElement;
  const alertEl = root.querySelector(".panel-alert") as HTMLDivElement;
  const listEl = root.querySelector(".panel-list") as HTMLOListElement;

  let state: CalendarState | null = null;
  const alerted = new Set<string>();
  const watchConnection = connectionWatcher(LABEL, "Los avisos de llamadas pueden fallar.");

  refreshBtn.addEventListener("click", () => api.refreshCalendar());

  function onState(next: CalendarState) {
    state = next;
    if (!next.syncing) watchConnection(next.status);
    render();
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
    statusEl.textContent = `${statusText(LABEL, status)}${synced}`;
    refreshBtn.disabled = syncing;
    refreshBtn.classList.toggle("spinning", syncing);

    renderAlert(alertEl, LABEL, status, message);

    const now = Date.now();
    const upcoming = state.events.filter((e) => Date.parse(e.end) > now);
    listEl.innerHTML = "";
    if (upcoming.length === 0) {
      const empty = document.createElement("li");
      empty.className = "panel-empty";
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

function relative(start: number, end: number, now: number): string {
  if (start <= now) return now < end ? "ahora" : "";
  const mins = Math.round((start - now) / MINUTE);
  if (mins < 60) return `en ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `en ${h} h ${m} min` : `en ${h} h`;
}
