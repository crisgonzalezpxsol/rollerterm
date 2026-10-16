// Panel de correo: no leídos, direcciones importantes/bloqueadas y resumen de importantes.
// Los datos vienen del proceso main (MailSync); acá solo se pinta y se notifica.
import type { MailState, MailSummary, MailThread, RollertermApi } from "../shared/types";
import { connectionWatcher, fmtTime, renderAlert, statusText } from "./connector";
import { notify } from "./notify";

const LABEL = "Gmail";
/** Si llegan más que esto juntos (sin contar los importantes), se avisa con una sola notificación. */
const GROUP_OVER = 2;

/** Mismo criterio que el proceso main: una entrada es una dirección o un dominio entero. */
const matches = (email: string, entry: string) => {
  const e = email.toLowerCase();
  return e === entry || e.endsWith(`@${entry}`);
};

export function mountMail(root: HTMLElement, api: RollertermApi): void {
  root.classList.add("panel");
  root.innerHTML = `
    <div class="panel-head">
      <h2>Correo · no leídos</h2>
      <span class="panel-status"></span>
      <div class="panel-actions">
        <button class="panel-btn mail-summarize" title="Resumir lo que mandaron tus direcciones importantes en las últimas 24 h">Resumir</button>
        <button class="panel-btn mail-lists-toggle" title="Direcciones importantes y bloqueadas">Direcciones</button>
        <button class="panel-refresh" title="Actualizar ahora">↻</button>
      </div>
    </div>
    <div class="panel-alert" hidden></div>
    <div class="mail-lists" hidden>
      <section data-list="vip">
        <h3>★ Importantes <small>se destacan y se resumen</small></h3>
        <form><input placeholder="ana@empresa.com o empresa.com" /><button>Agregar</button></form>
        <ul></ul>
      </section>
      <section data-list="blocked">
        <h3>🚫 Bloqueadas <small>no aparecen ni avisan</small></h3>
        <form><input placeholder="spam@algo.com o algo.com" /><button>Agregar</button></form>
        <ul></ul>
      </section>
    </div>
    <details class="mail-summary" open hidden>
      <summary></summary>
      <p class="ms-error" hidden></p>
      <p class="ms-overview"></p>
      <ol class="ms-items"></ol>
    </details>
    <ol class="panel-list mail-list"></ol>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const statusEl = $<HTMLSpanElement>(".panel-status");
  const refreshBtn = $<HTMLButtonElement>(".panel-refresh");
  const summarizeBtn = $<HTMLButtonElement>(".mail-summarize");
  const listsBtn = $<HTMLButtonElement>(".mail-lists-toggle");
  const alertEl = $<HTMLDivElement>(".panel-alert");
  const listsEl = $<HTMLDivElement>(".mail-lists");
  const summaryEl = $<HTMLDetailsElement>(".mail-summary");
  const listEl = $<HTMLOListElement>(".mail-list");

  let state: MailState | null = null;
  /** createdAt del último resumen ya visto, para avisar solo de los nuevos. */
  let knownSummary: number | null | undefined;
  const watchConnection = connectionWatcher(LABEL, "Los avisos de correo pueden fallar.");

  refreshBtn.addEventListener("click", () => api.refreshMail());
  summarizeBtn.addEventListener("click", () => {
    summaryEl.hidden = false;
    api.summarizeMail();
  });
  listsBtn.addEventListener("click", () => {
    listsEl.hidden = !listsEl.hidden;
    listsBtn.classList.toggle("on", !listsEl.hidden);
  });

  // ---------- listas de direcciones ----------

  const isVip = (email: string) => !!state?.vip.some((v) => matches(email, v));

  /** Agrega a una lista y lo saca de la otra: una dirección no puede ser importante y bloqueada. */
  function addTo(list: "vip" | "blocked", entry: string) {
    if (!state) return;
    const e = entry.trim().toLowerCase().replace(/^@/, "");
    if (!e) return;
    const other = list === "vip" ? "blocked" : "vip";
    const next = { vip: state.vip, blocked: state.blocked };
    next[list] = [...next[list].filter((x) => x !== e), e];
    next[other] = next[other].filter((x) => x !== e);
    api.setMailLists(next.vip, next.blocked);
  }

  function removeFrom(list: "vip" | "blocked", entry: string) {
    if (!state) return;
    const next = { vip: state.vip, blocked: state.blocked };
    next[list] = next[list].filter((x) => x !== entry);
    api.setMailLists(next.vip, next.blocked);
  }

  for (const section of listsEl.querySelectorAll("section")) {
    const list = section.dataset.list as "vip" | "blocked";
    const form = section.querySelector("form")!;
    const input = section.querySelector("input")!;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      addTo(list, input.value);
      input.value = "";
    });
  }

  function renderLists() {
    if (!state) return;
    for (const section of listsEl.querySelectorAll("section")) {
      const list = section.dataset.list as "vip" | "blocked";
      const ul = section.querySelector("ul")!;
      ul.innerHTML = "";
      if (state[list].length === 0) {
        const li = document.createElement("li");
        li.className = "panel-empty";
        li.textContent = "Vacía.";
        ul.append(li);
      }
      for (const entry of state[list]) {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = entry;
        const del = document.createElement("button");
        del.textContent = "×";
        del.title = "Quitar";
        del.addEventListener("click", () => removeFrom(list, entry));
        li.append(text, del);
        ul.append(li);
      }
    }
  }

  // ---------- avisos ----------

  api.onNewMail((threads) => {
    const vip = threads.filter((t) => isVip(t.fromEmail));
    const rest = threads.filter((t) => !isVip(t.fromEmail));
    // Los importantes siempre se avisan uno por uno.
    for (const t of vip) notify(`★ ${t.fromName}`, t.subject, () => window.open(t.viewUrl));
    if (rest.length > GROUP_OVER) {
      const senders = [...new Set(rest.map((t) => t.fromName))].slice(0, 3).join(", ");
      notify(`✉️ ${rest.length} correos nuevos`, `De ${senders}${rest.length > 3 ? "…" : ""}`);
    } else {
      for (const t of rest) notify(`✉️ ${t.fromName}`, t.subject, () => window.open(t.viewUrl));
    }
  });

  function checkSummary(s: MailSummary | null) {
    const created = s?.createdAt ?? null;
    // El primer estado solo registra el resumen que ya había; no es nuevo.
    if (knownSummary !== undefined && created && created !== knownSummary && s!.items.length) {
      const pending = s!.items.filter((i) => i.needsAction).length;
      notify(
        `📋 Resumen de importantes: ${s!.items.length} hilo${s!.items.length === 1 ? "" : "s"}`,
        pending ? `${pending} esperan tu respuesta. ${s!.overview}` : s!.overview,
      );
    }
    knownSummary = created;
  }

  // ---------- pintar ----------

  function onState(next: MailState) {
    state = next;
    if (!next.syncing) watchConnection(next.status);
    checkSummary(next.summary);
    render();
  }

  function render() {
    if (!state) return;
    const { status, syncing, lastSync, message } = state;
    statusEl.dataset.status = status;
    statusEl.textContent = `${statusText(LABEL, status)}${lastSync ? ` · ${fmtTime(lastSync)}` : ""}`;
    refreshBtn.disabled = syncing;
    refreshBtn.classList.toggle("spinning", syncing);
    summarizeBtn.disabled = state.summarizing;
    renderAlert(alertEl, LABEL, status, message);
    renderLists();
    renderSummary();

    listEl.innerHTML = "";
    if (state.threads.length === 0) {
      const empty = document.createElement("li");
      empty.className = "panel-empty";
      empty.textContent = status === "loading" ? "Leyendo tu correo…" : "Nada sin leer en las últimas 48 h.";
      listEl.append(empty);
      return;
    }
    for (const t of state.threads) listEl.append(renderThread(t));
  }

  function renderSummary() {
    const { summary, summarizing, summaryError } = state!;
    summaryEl.hidden = !summary && !summarizing && !summaryError;
    if (summaryEl.hidden) return;
    const head = summaryEl.querySelector("summary")!;
    head.textContent = summarizing
      ? "Resumen de importantes · resumiendo…"
      : `Resumen de importantes${summary ? ` · ${fmtTime(summary.createdAt)}` : ""}`;
    const errorEl = summaryEl.querySelector(".ms-error") as HTMLParagraphElement;
    errorEl.hidden = !summaryError;
    errorEl.textContent = summaryError ?? "";
    (summaryEl.querySelector(".ms-overview") as HTMLParagraphElement).textContent = summary?.overview ?? "";
    const items = summaryEl.querySelector(".ms-items") as HTMLOListElement;
    items.innerHTML = "";
    for (const it of summary?.items ?? []) {
      const li = document.createElement("li");
      li.classList.toggle("action", it.needsAction);
      const title = document.createElement("strong");
      title.textContent = `${it.from} — ${it.subject}`;
      const gist = document.createElement("span");
      gist.textContent = it.gist;
      li.append(title, gist);
      if (it.needsAction) {
        const badge = document.createElement("em");
        badge.textContent = "Responder";
        li.prepend(badge);
      }
      li.title = "Abrir en Gmail";
      li.addEventListener("click", () => window.open(it.viewUrl));
      items.append(li);
    }
  }

  function renderThread(t: MailThread): HTMLLIElement {
    const vip = isVip(t.fromEmail);
    const li = document.createElement("li");
    li.className = "mail-thread";
    li.classList.toggle("vip", vip);
    li.title = "Abrir en Gmail";
    li.addEventListener("click", () => window.open(t.viewUrl));

    const from = document.createElement("span");
    from.className = "mt-from";
    from.textContent = `${vip ? "★ " : ""}${t.fromName}`;
    from.title = t.fromEmail;
    const body = document.createElement("span");
    body.className = "mt-body";
    const subject = document.createElement("span");
    subject.className = "mt-subject";
    subject.textContent = t.subject || "(sin asunto)";
    const snippet = document.createElement("span");
    snippet.className = "mt-snippet";
    snippet.textContent = t.snippet;
    body.append(subject, snippet);
    const time = document.createElement("span");
    time.className = "mt-time";
    time.textContent = fmtDay(Date.parse(t.date));

    const actions = document.createElement("span");
    actions.className = "mt-actions";
    const star = document.createElement("button");
    star.textContent = vip ? "☆" : "★";
    star.title = vip ? `Quitar ${t.fromEmail} de importantes` : `Marcar ${t.fromEmail} como importante`;
    star.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (vip) removeFrom("vip", state!.vip.find((v) => matches(t.fromEmail, v))!);
      else addTo("vip", t.fromEmail);
    });
    const block = document.createElement("button");
    block.textContent = "🚫";
    block.title = `Bloquear ${t.fromEmail} (para bloquear el dominio entero, usá Direcciones)`;
    block.addEventListener("click", (ev) => {
      ev.stopPropagation();
      addTo("blocked", t.fromEmail);
    });
    actions.append(star, block);

    li.append(from, body, time, actions);
    return li;
  }

  api.getMail().then(onState);
  api.onMail(onState);
}

/** "14:05" si es de hoy; "ayer 14:05"; si no, "13/10". */
function fmtDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return fmtTime(ms);
  if (d.toDateString() === yesterday.toDateString()) return `ayer ${fmtTime(ms)}`;
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}
