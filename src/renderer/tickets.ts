// Panel de tickets de Pxsol Agencias (debajo de la agenda): pestañas Míos / Sin dueño /
// Abiertos, una tabla ordenada por urgencia, y avisos de lo nuevo que te asignan.
import type { RollertermApi, Ticket, TicketPriority, TicketsState, TicketStatus } from "../shared/types";
import { fmtTime } from "./connector";
import { notify } from "./notify";

type Tab = "mine" | "unassigned" | "all";

const TABS: { id: Tab; label: string; filter: (t: Ticket) => boolean }[] = [
  { id: "mine", label: "Míos", filter: (t) => t.mine },
  { id: "unassigned", label: "Sin dueño", filter: (t) => !t.atiende },
  { id: "all", label: "Abiertos", filter: () => true },
];

const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: "Abierto",
  IN_PROGRESS: "En curso",
  WAITING: "Esperando",
  CLOSED: "Cerrado",
};
const PRIORITY_LABEL: Record<TicketPriority, string> = { URGENT: "Urgente", HIGH: "Alta", MEDIUM: "Media", LOW: "Baja" };
const PRIORITY_RANK: Record<TicketPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** SLA vencido primero, después prioridad, después lo más nuevo. */
function byUrgency(a: Ticket, b: Ticket): number {
  return (
    Number(b.slaVencido) - Number(a.slaVencido) ||
    PRIORITY_RANK[a.prioridad] - PRIORITY_RANK[b.prioridad] ||
    Date.parse(b.creadoEl) - Date.parse(a.creadoEl)
  );
}

export function mountTickets(root: HTMLElement, api: RollertermApi): void {
  root.classList.add("panel");
  root.innerHTML = `
    <div class="panel-head">
      <h2>Tickets · Agencias</h2>
      <span class="tk-env" hidden></span>
      <span class="panel-status"></span>
      <div class="panel-actions">
        <div class="tk-tabs"></div>
        <button class="panel-refresh" title="Actualizar ahora">↻</button>
      </div>
    </div>
    <div class="panel-alert" hidden></div>
    <p class="tk-note" hidden></p>
    <div class="tk-table-wrap">
      <table class="tk-table">
        <thead><tr><th>#</th><th>Asunto</th><th>Estado</th><th>Prioridad</th><th>Agencia</th><th>Atiende</th><th>Creado</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="panel-empty" hidden></p>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const envEl = $<HTMLSpanElement>(".tk-env");
  const statusEl = $<HTMLSpanElement>(".panel-status");
  const tabsEl = $<HTMLDivElement>(".tk-tabs");
  const refreshBtn = $<HTMLButtonElement>(".panel-refresh");
  const alertEl = $<HTMLDivElement>(".panel-alert");
  const noteEl = $<HTMLParagraphElement>(".tk-note");
  const tbody = $<HTMLTableSectionElement>("tbody");
  const table = $<HTMLTableElement>(".tk-table");
  const emptyEl = $<HTMLParagraphElement>(".panel-empty");

  let state: TicketsState | null = null;
  let tab: Tab = "mine";
  try {
    tab = (localStorage.getItem("tickets-tab") as Tab) || "mine";
  } catch {
    // sin almacenamiento local: se queda en "Míos"
  }
  /** Lo que ya se conocía: para avisar solo de lo nuevo. null hasta el primer estado. */
  let known: { mine: Set<number>; sla: Set<number> } | null = null;

  refreshBtn.addEventListener("click", () => api.refreshTickets());

  function checkNews(s: TicketsState) {
    if (s.status !== "ok" || s.checking) return;
    const mine = new Set(s.tickets.filter((t) => t.mine).map((t) => t.numero));
    const sla = new Set(s.tickets.filter((t) => t.mine && t.slaVencido).map((t) => t.numero));
    if (known) {
      for (const t of s.tickets) {
        if (t.mine && !known.mine.has(t.numero)) {
          notify(`🎫 Te asignaron el #${t.numero}`, t.asunto, () => open(t));
        } else if (t.mine && t.slaVencido && !known.sla.has(t.numero)) {
          notify(`⏰ SLA vencido: #${t.numero}`, t.asunto, () => open(t));
        }
      }
    }
    known = { mine, sla };
  }

  function open(t: Ticket) {
    if (state?.webUrl) window.open(`${state.webUrl}/tickets?q=${t.numero}`);
  }

  function render() {
    if (!state) return;
    const { status, checking, lastCheck, message } = state;
    root.hidden = status === "disabled";

    envEl.hidden = !state.environment;
    envEl.textContent = state.environment ?? "";
    envEl.classList.toggle("prod", state.environment === "producción");
    statusEl.dataset.status = status === "ok" ? "connected" : status === "loading" ? "loading" : "error";
    // Corto, para dejarle lugar a las pestañas: el punto verde ya dice "conectado".
    statusEl.textContent = status === "loading" ? "Conectando…" : status === "ok" ? (lastCheck ? fmtTime(lastCheck) : "") : "Sin conexión";
    statusEl.title = status === "ok" ? "Conectado" : (message ?? "");
    refreshBtn.disabled = checking;
    refreshBtn.classList.toggle("spinning", checking);

    const down = status === "error" || status === "not-configured";
    alertEl.hidden = !down;
    if (down) {
      alertEl.innerHTML = "";
      const title = document.createElement("strong");
      title.textContent = status === "not-configured" ? "MCP de tickets no configurado" : "No se pudieron leer los tickets";
      const p = document.createElement("p");
      p.textContent = `${message ?? ""} ${
        status === "not-configured"
          ? "Configurá el MCP de tickets de pxsol-agencias en Claude Code (ver scripts/mcp-tickets/README.md) o elegilo en Configuración."
          : "Tocá ↻ para reintentar."
      }`;
      alertEl.append(title, p);
    }
    noteEl.hidden = !(status === "ok" && message);
    noteEl.textContent = status === "ok" ? (message ?? "") : "";

    // Pestañas con su cantidad.
    tabsEl.innerHTML = "";
    for (const t of TABS) {
      const b = document.createElement("button");
      b.className = "tk-tab";
      b.classList.toggle("on", t.id === tab);
      b.textContent = `${t.label} ${state.tickets.filter(t.filter).length}`;
      b.addEventListener("click", () => {
        tab = t.id;
        try {
          localStorage.setItem("tickets-tab", tab);
        } catch {
          // no importa si no se puede recordar
        }
        render();
      });
      tabsEl.append(b);
    }

    const rows = state.tickets.filter(TABS.find((t) => t.id === tab)!.filter).sort(byUrgency);
    tbody.innerHTML = "";
    table.hidden = rows.length === 0;
    table.classList.toggle("hide-who", tab === "mine");
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = status === "loading" ? "Leyendo los tickets…" : "No hay tickets en esta pestaña.";
    for (const t of rows) tbody.append(renderRow(t));
  }

  function renderRow(t: Ticket): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.classList.toggle("sla", t.slaVencido);
    tr.title = state?.webUrl ? "Abrir en Pxsol Agencias" : "";
    tr.addEventListener("click", () => open(t));
    const cell = (text: string, cls?: string) => {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = text;
      tr.append(td);
      return td;
    };
    cell(`#${t.numero}`, "tk-num");
    const subject = cell(t.asunto, "tk-subject");
    subject.title = t.asunto;
    if (t.slaVencido) {
      const badge = document.createElement("em");
      badge.textContent = "SLA vencido";
      subject.prepend(badge);
    }
    const st = cell("", "tk-status");
    const chip = document.createElement("span");
    chip.className = `chip st-${t.estado.toLowerCase()}`;
    chip.textContent = STATUS_LABEL[t.estado];
    st.append(chip);
    const pr = cell("", "tk-prio");
    const pchip = document.createElement("span");
    pchip.className = `chip pr-${t.prioridad.toLowerCase()}`;
    pchip.textContent = PRIORITY_LABEL[t.prioridad];
    pr.append(pchip);
    cell(t.agencia ?? "—", "tk-agency");
    cell(t.atiende ?? "Sin dueño", t.atiende ? "tk-who" : "tk-who none");
    cell(age(Date.parse(t.creadoEl)), "tk-age");
    return tr;
  }

  function onState(next: TicketsState) {
    state = next;
    checkNews(next);
    render();
  }

  api.getTickets().then(onState);
  api.onTickets(onState);
  setInterval(render, 60_000);
}

function age(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
