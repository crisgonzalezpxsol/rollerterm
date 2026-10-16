// Panel del asistente (💬 o ⌘⇧K): el chat de la jornada con Claude Code. Muestra el
// historial por día, la respuesta mientras llega, qué herramientas usa y las aprobaciones.
import type { ApprovalRequest, ChatMessage, ChatStreamEvent, RollertermApi } from "../shared/types";
import { renderMarkdown } from "./markdown";
import { notify } from "./notify";

export interface AssistantPanel {
  toggle(): void;
  close(): void;
  readonly isOpen: boolean;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return "Ayer";
  return d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
}

const time = (ms: number) => new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function mountAssistant(api: RollertermApi, hooks: { onOpen: () => void; onClose: () => void }): AssistantPanel {
  const aside = document.createElement("aside");
  aside.id = "assistant";
  aside.innerHTML = `
    <header>
      <div>
        <h2>Asistente</h2>
        <small>Contale tu jornada · recuerda, anota, busca y te pregunta antes de enviar</small>
      </div>
      <button class="as-close" title="Cerrar (Esc)">×</button>
    </header>
    <div class="as-log"></div>
    <form class="as-composer">
      <textarea rows="1" placeholder="Escribile… (Enter envía, Shift+Enter nueva línea)"></textarea>
      <button type="submit" class="as-send">Enviar</button>
    </form>`;
  document.body.append(aside);

  const log = aside.querySelector(".as-log") as HTMLDivElement;
  const form = aside.querySelector(".as-composer") as HTMLFormElement;
  const input = aside.querySelector("textarea") as HTMLTextAreaElement;
  const sendBtn = aside.querySelector(".as-send") as HTMLButtonElement;

  let open = false;
  let loaded = false;
  let busy = false;
  let lastDay = "";
  /** La respuesta que está llegando: su burbuja, el texto acumulado y las herramientas. */
  let live: { id: string; el: HTMLDivElement; body: HTMLDivElement; tools: HTMLDivElement; text: string } | null = null;
  const approvalCards = new Map<string, HTMLDivElement>();

  // ---------- pintar ----------

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollDown = (force = false) => {
    if (force || atBottom()) log.scrollTop = log.scrollHeight;
  };

  function separator(at: number) {
    const label = dayLabel(at);
    if (label === lastDay) return;
    lastDay = label;
    const sep = document.createElement("div");
    sep.className = "as-day";
    sep.textContent = label;
    log.append(sep);
  }

  function bubble(m: ChatMessage): HTMLDivElement {
    separator(m.at);
    const el = document.createElement("div");
    el.className = `as-msg ${m.role}`;
    el.classList.toggle("error", Boolean(m.error));
    const body = document.createElement("div");
    body.className = "as-body";
    if (m.role === "assistant") body.append(renderMarkdown(m.text));
    else body.textContent = m.text;
    el.append(body);
    if (m.tools?.length) el.append(toolRow(m.tools));
    const meta = document.createElement("span");
    meta.className = "as-time";
    meta.textContent = time(m.at);
    el.append(meta);
    log.append(el);
    return el;
  }

  function toolRow(labels: string[]): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "as-tools";
    for (const l of labels) {
      const chip = document.createElement("span");
      chip.textContent = l;
      row.append(chip);
    }
    return row;
  }

  function approvalCard(req: ApprovalRequest) {
    const card = document.createElement("div");
    card.className = "as-approval";
    const title = document.createElement("strong");
    title.textContent = "Necesito tu OK para esto:";
    const pre = document.createElement("pre");
    pre.textContent = req.summary;
    const actions = document.createElement("div");
    actions.className = "as-approval-actions";
    const yes = document.createElement("button");
    yes.className = "as-approve";
    yes.textContent = "Aprobar";
    const no = document.createElement("button");
    no.className = "as-reject";
    no.textContent = "Rechazar";
    const details = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Ver los datos exactos";
    const raw = document.createElement("pre");
    raw.textContent = `${req.tool}\n${JSON.stringify(req.input, null, 2)}`;
    details.append(sum, raw);
    yes.addEventListener("click", () => api.chatApprove(req.id, true));
    no.addEventListener("click", () => api.chatApprove(req.id, false));
    actions.append(yes, no);
    card.append(title, pre, details, actions);
    log.append(card);
    approvalCards.set(req.id, card);
    scrollDown(true);
    // Que se note aunque el panel esté cerrado o la app en segundo plano.
    notify("💬 El asistente necesita tu OK", req.summary.split("\n")[0], () => panel.toggle());
  }

  function setBusy(value: boolean) {
    busy = value;
    sendBtn.textContent = value ? "Detener" : "Enviar";
    sendBtn.classList.toggle("stop", value);
    aside.classList.toggle("busy", value);
  }

  // ---------- eventos del asistente ----------

  api.onChat((e: ChatStreamEvent) => {
    if (!loaded) return; // se pinta todo al cargar el historial
    if (e.type === "start") {
      separator(Date.now());
      const el = document.createElement("div");
      el.className = "as-msg assistant live";
      const body = document.createElement("div");
      body.className = "as-body";
      body.innerHTML = '<span class="as-typing"><i></i><i></i><i></i></span>';
      const tools = document.createElement("div");
      tools.className = "as-tools";
      el.append(body, tools);
      log.append(el);
      live = { id: e.messageId, el, body, tools, text: "" };
      scrollDown(true);
    } else if (e.type === "text" && live?.id === e.messageId) {
      live.text += e.delta;
      live.body.replaceChildren(renderMarkdown(live.text));
      scrollDown();
    } else if (e.type === "tool" && live?.id === e.messageId) {
      if (![...live.tools.children].some((c) => c.textContent === e.label)) {
        const chip = document.createElement("span");
        chip.className = "running";
        chip.textContent = e.label;
        live.tools.append(chip);
        scrollDown();
      }
    } else if (e.type === "approval") {
      approvalCard(e.request);
    } else if (e.type === "approval-done") {
      const card = approvalCards.get(e.id);
      if (card) {
        card.classList.add(e.approved ? "approved" : "rejected");
        card.querySelector(".as-approval-actions")!.replaceChildren(
          Object.assign(document.createElement("span"), { textContent: e.approved ? "✅ Aprobado" : "🚫 Rechazado" }),
        );
      }
    } else if (e.type === "done") {
      live?.el.remove();
      live = null;
      bubble(e.message);
      setBusy(false);
      scrollDown(true);
      if (!open) notify("💬 Respondió el asistente", e.message.text.slice(0, 120), () => panel.toggle());
    } else if (e.type === "event") {
      bubble(e.message);
      scrollDown(true);
    }
  });

  api.onReminder((r) => notify("⏰ Recordatorio", r.text, () => panel.toggle()));

  // ---------- enviar ----------

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    autosize();
    bubble({ id: "", role: "user", text, at: Date.now() });
    scrollDown(true);
    setBusy(true);
    try {
      await api.chatSend(text);
    } catch (err) {
      setBusy(false);
      bubble({ id: "", role: "event", text: `No se pudo enviar: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() });
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) api.chatStop();
    else void send();
  });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  aside.querySelector(".as-close")!.addEventListener("click", () => panel.close());
  aside.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      panel.close();
    }
  });

  async function loadHistory() {
    const history = await api.chatHistory();
    log.replaceChildren();
    lastDay = "";
    if (!history.length) {
      const hello = document.createElement("div");
      hello.className = "as-empty";
      hello.innerHTML = "";
      const p1 = document.createElement("p");
      p1.textContent = "Contame cómo arranca tu jornada, o pedime algo:";
      const ul = document.createElement("ul");
      for (const ex of ["¿Qué tengo hoy?", "Recordame a las 15 llamar a René", "Anotá que el #357 lo veo con MercadHotel", "Resumime los correos de Jorge de esta semana"]) {
        const li = document.createElement("li");
        li.textContent = ex;
        li.addEventListener("click", () => {
          input.value = ex;
          autosize();
          input.focus();
        });
        ul.append(li);
      }
      hello.append(p1, ul);
      log.append(hello);
    }
    for (const m of history) bubble(m);
    loaded = true;
    scrollDown(true);
  }

  const panel: AssistantPanel = {
    get isOpen() {
      return open;
    },
    toggle() {
      if (open) return panel.close();
      hooks.onOpen();
      open = true;
      aside.classList.add("open");
      document.getElementById("toggle-assistant")?.classList.add("on");
      if (!loaded) void loadHistory().then(() => input.focus());
      else {
        scrollDown(true);
        input.focus();
      }
    },
    close() {
      if (!open) return;
      open = false;
      aside.classList.remove("open");
      document.getElementById("toggle-assistant")?.classList.remove("on");
      hooks.onClose();
    },
  };
  return panel;
}
