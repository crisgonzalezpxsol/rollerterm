// Vista completa de un ticket (clic en una fila de la tabla): descripción, hilo de comentarios,
// adjuntos y diagnóstico, y desde acá se comenta, se cambia el estado y se toma o suelta.
import type { RollertermApi, Ticket, TicketAction, TicketDetail, TicketStatus, TicketView } from "../shared/types";
import { renderMarkdown } from "./markdown";

export interface TicketViewer {
  open(t: Pick<Ticket, "numero" | "asunto">): void;
}

const STATUS: { id: TicketStatus; label: string }[] = [
  { id: "OPEN", label: "Abierto" },
  { id: "IN_PROGRESS", label: "En curso" },
  { id: "WAITING", label: "Esperando" },
  { id: "CLOSED", label: "Cerrado" },
];
const PRIORITY_LABEL = { URGENT: "Urgente", HIGH: "Alta", MEDIUM: "Media", LOW: "Baja" } as const;

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function mountTicketView(api: RollertermApi, hooks: { onClose: () => void }): TicketViewer {
  const dialog = document.createElement("dialog");
  dialog.id = "ticket";
  dialog.innerHTML = `
    <header>
      <span class="tv-num"></span>
      <h2 class="tv-subject"></h2>
      <a class="tv-web" hidden title="Abrir en Pxsol Agencias">Web ↗</a>
      <button class="tv-close" title="Cerrar (Esc)">×</button>
    </header>
    <div class="tv-meta"></div>
    <div class="tv-scroll"><div class="tv-content"></div></div>
    <form class="tv-composer">
      <textarea rows="3" placeholder="Comentario para la agencia… (⌘Enter envía)"></textarea>
      <div class="tv-composer-row">
        <small>La agencia lo ve en su ficha, se avisa al equipo y se copia en Nexus. Sale a tu nombre.</small>
        <span class="tv-status-msg"></span>
        <button type="submit" class="tv-send">Comentar</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector(sel) as T;
  const numEl = $<HTMLSpanElement>(".tv-num");
  const subjectEl = $<HTMLHeadingElement>(".tv-subject");
  const webEl = $<HTMLAnchorElement>(".tv-web");
  const metaEl = $<HTMLDivElement>(".tv-meta");
  const scrollEl = $<HTMLDivElement>(".tv-scroll");
  const contentEl = $<HTMLDivElement>(".tv-content");
  const form = $<HTMLFormElement>(".tv-composer");
  const input = $<HTMLTextAreaElement>("textarea");
  const sendBtn = $<HTMLButtonElement>(".tv-send");
  const msgEl = $<HTMLSpanElement>(".tv-status-msg");

  let numero = 0;
  let view: TicketView | null = null;
  let busy = false;
  /** Para descartar respuestas de un ticket que ya se cerró o se cambió por otro. */
  let seq = 0;

  function setBusy(value: boolean, text = "") {
    busy = value;
    dialog.classList.toggle("busy", value);
    sendBtn.disabled = value;
    for (const el of metaEl.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) el.disabled = value;
    msgEl.textContent = text;
    msgEl.classList.remove("error");
  }

  function fail(err: unknown) {
    msgEl.textContent = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
    msgEl.classList.add("error");
  }

  // ---------- pintar ----------

  function chip(text: string, cls: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = `chip ${cls}`;
    el.textContent = text;
    return el;
  }

  function field(label: string, value: Node | string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = "tv-field";
    const k = document.createElement("small");
    k.textContent = label;
    el.append(k, value);
    return el;
  }

  function renderMeta(t: TicketDetail, me: string | null) {
    metaEl.replaceChildren();
    const status = document.createElement("select");
    status.className = `tv-state st-${t.estado.toLowerCase()}`;
    for (const s of STATUS) status.append(new Option(s.label, s.id, false, s.id === t.estado));
    status.addEventListener("change", () => {
      const estado = status.value as TicketStatus;
      if (estado === "CLOSED" && !confirm(`¿Cerrar el #${t.numero}? La agencia recibe el aviso.`)) {
        status.value = t.estado;
        return;
      }
      void act({ type: "status", estado }, "Cambiando el estado…");
    });
    metaEl.append(field("Estado", status), field("Prioridad", chip(PRIORITY_LABEL[t.prioridad], `pr-${t.prioridad.toLowerCase()}`)));

    const who = document.createElement("span");
    who.className = "tv-who";
    who.textContent = t.atiende ?? "Sin dueño";
    who.classList.toggle("none", !t.atiende);
    const mine = Boolean(me && t.atiendeEmail?.toLowerCase() === me.toLowerCase());
    if (me) {
      const b = document.createElement("button");
      b.className = "tv-assign";
      b.textContent = mine ? "Soltar" : "Asignarme";
      b.title = mine ? "Dejarlo sin dueño" : `Asignarlo a ${me}`;
      b.addEventListener("click", () => void act({ type: "assign", email: mine ? null : me }, mine ? "Soltando…" : "Asignando…"));
      who.append(b);
    }
    metaEl.append(field("Atiende", who));
    if (t.agencia) metaEl.append(field("Agencia", t.agencia));
    if (t.abiertoPor) metaEl.append(field("Abrió", t.abiertoPor));
    metaEl.append(field("Creado", when(t.creadoEl)));
    if (t.venceEl) {
      const due = document.createElement("span");
      due.textContent = when(t.venceEl);
      if (t.slaVencido) due.append(" ", chip("SLA vencido", "pr-urgent"));
      metaEl.append(field("Vence", due));
    }
    if (t.numeroEnNexus) metaEl.append(field("Nexus", `#${t.numeroEnNexus}`));
    if (t.categoria) metaEl.append(field("Categoría", t.categoria));
  }

  function section(title: string): HTMLElement {
    const s = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    contentEl.append(s);
    return s;
  }

  function renderContent(t: TicketDetail) {
    contentEl.replaceChildren();
    const desc = section("Descripción");
    const body = document.createElement("div");
    body.className = "tv-md";
    if (t.descripcion?.trim()) body.append(renderMarkdown(t.descripcion));
    else body.textContent = "Sin descripción.";
    desc.append(body);

    if (t.adjuntos.length) {
      const s = section(`Adjuntos (${t.adjuntos.length})`);
      const ul = document.createElement("ul");
      ul.className = "tv-files";
      for (const a of t.adjuntos) {
        const name = String(a.nombre ?? a.name ?? a.filename ?? a.archivo ?? "archivo");
        const url = [a.url, a.href, a.link].find((u): u is string => typeof u === "string");
        const li = document.createElement("li");
        if (url) {
          const link = document.createElement("a");
          link.textContent = `📎 ${name}`;
          link.addEventListener("click", () => window.open(url));
          li.append(link);
        } else li.textContent = `📎 ${name}`;
        ul.append(li);
      }
      s.append(ul);
    }

    const d = t.diagnostico;
    const errors = (d?.erroresDeConsola?.length ?? 0) + (d?.llamadasFallidas?.length ?? 0);
    if (d && (errors || d.pantalla)) {
      const s = section("Diagnóstico del navegador");
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = errors ? `${errors} error${errors === 1 ? "" : "es"} · ${d.pantalla ?? ""}` : `Sin errores · ${d.pantalla ?? ""}`;
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify({ erroresDeConsola: d.erroresDeConsola, llamadasFallidas: d.llamadasFallidas }, null, 2);
      det.append(sum, pre);
      s.append(det);
    }

    const thread = section(`Comentarios (${t.comentarios.length})`);
    if (!t.comentarios.length) {
      const p = document.createElement("p");
      p.className = "tv-empty";
      p.textContent = "Todavía no hay comentarios.";
      thread.append(p);
    }
    for (const c of t.comentarios) {
      const el = document.createElement("article");
      el.className = "tv-comment";
      el.classList.toggle("ours", c.rol === "PXSOL");
      const head = document.createElement("header");
      const who = document.createElement("strong");
      who.textContent = c.autor;
      const role = document.createElement("small");
      role.textContent = c.rol === "PXSOL" ? "Pxsol" : c.rol.toLowerCase() === "agencia" ? "Agencia" : c.rol;
      const at = document.createElement("time");
      at.textContent = when(c.cuando);
      head.append(who, role, at);
      const text = document.createElement("div");
      text.className = "tv-md";
      text.append(renderMarkdown(c.texto));
      el.append(head, text);
      thread.append(el);
    }
  }

  function render(v: TicketView) {
    view = v;
    numEl.textContent = `#${v.ticket.numero}`;
    subjectEl.textContent = v.ticket.asunto;
    subjectEl.title = v.ticket.asunto;
    webEl.hidden = !v.webUrl;
    renderMeta(v.ticket, v.me);
    renderContent(v.ticket);
  }

  // ---------- acciones ----------

  async function load() {
    const mySeq = ++seq;
    setBusy(true, "Leyendo el ticket…");
    try {
      const v = await api.viewTicket(numero);
      if (mySeq !== seq) return;
      render(v);
      setBusy(false);
    } catch (err) {
      if (mySeq !== seq) return;
      setBusy(false);
      contentEl.replaceChildren();
      const retry = document.createElement("button");
      retry.className = "tv-retry";
      retry.textContent = "Reintentar";
      retry.addEventListener("click", () => void load());
      contentEl.append(retry);
      fail(err);
    }
  }

  async function act(action: TicketAction, text: string): Promise<boolean> {
    if (busy) return false;
    const mySeq = ++seq;
    setBusy(true, text);
    try {
      const v = await api.ticketAction(numero, action);
      if (mySeq === seq) render(v);
      setBusy(false, "Listo ✓");
      return true;
    } catch (err) {
      setBusy(false);
      if (view) renderMeta(view.ticket, view.me); // vuelve el select al estado real
      fail(err);
      return false;
    }
  }

  async function comment() {
    const texto = input.value.trim();
    if (!texto || busy) return;
    if (await act({ type: "comment", texto }, "Enviando el comentario…")) {
      input.value = "";
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void comment();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void comment();
    }
  });
  webEl.addEventListener("click", () => {
    if (view?.webUrl) window.open(`${view.webUrl}/tickets?q=${numero}`);
  });
  $<HTMLButtonElement>(".tv-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // clic en el fondo oscuro
  });
  dialog.addEventListener("close", () => {
    seq++;
    hooks.onClose();
  });

  return {
    open(t) {
      // Un comentario a medio escribir se conserva si se vuelve a abrir el mismo ticket.
      if (t.numero !== numero) input.value = "";
      numero = t.numero;
      view = null;
      numEl.textContent = `#${t.numero}`;
      subjectEl.textContent = t.asunto;
      webEl.hidden = true;
      metaEl.replaceChildren();
      contentEl.replaceChildren();
      if (!dialog.open) dialog.showModal();
      input.focus();
      void load();
    },
  };
}
