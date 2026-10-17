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

export function mountTickets(root: HTMLElement, api: RollertermApi, openTicket: (t: Pick<Ticket, "numero" | "asunto">) => void): void {
  root.classList.add("panel");
  root.innerHTML = `
    <div class="panel-head">
      <h2>Tickets · Agencias</h2>
      <span class="tk-env" hidden></span>
      <span class="panel-status"></span>
      <div class="panel-actions">
        <input class="tk-search" type="search" placeholder="Buscar # o texto" title="Filtrá por número de ticket, asunto o agencia. Enter abre el ticket con ese número (aunque no esté en la lista)." spellcheck="false" />
        <div class="tk-tabs"></div>
        <button class="panel-refresh" title="Actualizar ahora">↻</button>
      </div>
    </div>
    <div class="panel-alert" hidden></div>
    <p class="tk-note" hidden></p>
    <button class="panel-btn tk-open-num" hidden></button>
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
  const searchEl = $<HTMLInputElement>(".tk-search");
  const openNumBtn = $<HTMLButtonElement>(".tk-open-num");

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

  // Búsqueda: busca en todos los abiertos (no solo en la pestaña). Un número que no está en la
  // lista (por ejemplo, uno cerrado) se puede abrir igual con Enter o con el botón.
  const query = () => searchEl.value.trim().toLowerCase();
  const queryNumber = () => {
    const m = /^#?(\d+)$/.exec(query());
    return m ? Number(m[1]) : null;
  };
  function matches(t: Ticket, q: string): boolean {
    const num = q.replace(/^#/, "");
    if (/^\d+$/.test(num)) return String(t.numero).includes(num) || String(t.numeroEnNexus ?? "").includes(num);
    return [t.asunto, t.agencia ?? "", t.atiende ?? ""].some((x) => x.toLowerCase().includes(q));
  }
  function openByNumber(n: number) {
    open(state?.tickets.find((t) => t.numero === n) ?? { numero: n, asunto: "" });
  }
  searchEl.addEventListener("input", render);
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = queryNumber();
      const rows = currentRows();
      if (n !== null) openByNumber(n);
      else if (rows.length === 1) open(rows[0]);
    } else if (e.key === "Escape" && searchEl.value) {
      searchEl.value = "";
      render();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  openNumBtn.addEventListener("click", () => {
    const n = queryNumber();
    if (n !== null) openByNumber(n);
  });

  function currentRows(): Ticket[] {
    if (!state) return [];
    const q = query();
    const filter = q ? (t: Ticket) => matches(t, q) : TABS.find((t) => t.id === tab)!.filter;
    return state.tickets.filter(filter).sort(byUrgency);
  }

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

  const open = (t: Pick<Ticket, "numero" | "asunto">) => openTicket(t);

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
        searchEl.value = ""; // elegir una pestaña sale de la búsqueda
        try {
          localStorage.setItem("tickets-tab", tab);
        } catch {
          // no importa si no se puede recordar
        }
        render();
      });
      tabsEl.append(b);
    }

    const searching = query() !== "";
    tabsEl.classList.toggle("dim", searching);
    const rows = currentRows();
    const n = queryNumber();
    openNumBtn.hidden = n === null || rows.some((t) => t.numero === n);
    openNumBtn.textContent = `Abrir el ticket #${n} ↵`;
    tbody.innerHTML = "";
    table.hidden = rows.length === 0;
    table.classList.toggle("hide-who", tab === "mine" && !searching);
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent =
      status === "loading" ? "Leyendo los tickets…" : searching ? "Ningún ticket abierto coincide con la búsqueda." : "No hay tickets en esta pestaña.";
    for (const t of rows) tbody.append(renderRow(t));
  }

  function renderRow(t: Ticket): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.classList.toggle("sla", t.slaVencido);
    tr.title = "Ver el ticket completo";
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
