// Panel del asistente (✦ Asistente o ⌘⇧K): chats con Claude Code. La «Jornada» recuerda el día;
// con «+» se abren conversaciones aparte (como pestañas), que pueden responder a la vez.
// Muestra el historial por día, la respuesta mientras llega, qué herramientas usa y las aprobaciones.
import type { ApprovalRequest, ChatMessage, ChatStreamEvent, Conversation, RollertermApi } from "../shared/types";
import { showContextMenu } from "./context-menu";
import { renderMarkdown } from "./markdown";
import { isMuted, notify } from "./notify";
import { speak, stopSpeaking } from "./speech";

export interface AssistantPanel {
  toggle(): void;
  close(): void;
  /** Conversación nueva (⌘T con el foco en el chat). */
  newConversation(): void;
  readonly isOpen: boolean;
  /** El foco está en el panel. */
  readonly hasFocus: boolean;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return "Ayer";
  return d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
}

const time = (ms: number) => new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const EXAMPLES = {
  daily: ["¿Qué tengo hoy?", "Recordame a las 15 llamar a René", "Anotá que el #357 lo veo con MercadHotel", "Resumime los correos de Jorge de esta semana"],
  thread: ["Ayudame a redactar la respuesta del #381", "Armame un plan para la integración con Emerging Travel", "¿Qué tickets sin dueño son urgentes?"],
};

/** Lo que el panel tiene de cada conversación: su log, la respuesta en curso y el borrador. */
interface ConvView {
  conv: Conversation;
  log: HTMLDivElement;
  loaded: boolean;
  lastDay: string;
  /** La respuesta que está llegando: su burbuja, el texto acumulado y las herramientas. */
  live: { id: string; el: HTMLDivElement; body: HTMLDivElement; tools: HTMLDivElement; text: string } | null;
  approvalCards: Map<string, HTMLDivElement>;
  draft: string;
  /** Llegó una respuesta que todavía no se vio. */
  unread: boolean;
}

export function mountAssistant(api: RollertermApi, hooks: { onOpen: () => void; onClose: () => void }): AssistantPanel {
  const aside = document.createElement("aside");
  aside.id = "assistant";
  aside.innerHTML = `
    <div class="as-resizer" title="Arrastrá para cambiar el ancho · doble clic: ancho por defecto"></div>
    <header>
      <div>
        <h2>Asistente</h2>
        <small>Contale tu jornada · recuerda, anota, busca y te pregunta antes de enviar</small>
      </div>
      <button class="as-voice" title="Leer las respuestas en voz alta">🔈</button>
      <button class="as-close" title="Cerrar (Esc)">×</button>
    </header>
    <nav class="as-convs">
      <div class="as-conv-list"></div>
      <button class="as-conv-new" title="Conversación nueva (⌘T con el foco en el chat)">+</button>
    </nav>
    <div class="as-logs"></div>
    <form class="as-composer">
      <textarea rows="1" placeholder="Escribile… (Enter envía, Shift+Enter nueva línea)"></textarea>
      <button type="submit" class="as-send">Enviar</button>
    </form>`;
  document.body.append(aside);

  const logs = aside.querySelector(".as-logs") as HTMLDivElement;
  const convList = aside.querySelector(".as-conv-list") as HTMLDivElement;
  const form = aside.querySelector(".as-composer") as HTMLFormElement;
  const input = aside.querySelector("textarea") as HTMLTextAreaElement;
  const sendBtn = aside.querySelector(".as-send") as HTMLButtonElement;
  const voiceBtn = aside.querySelector(".as-voice") as HTMLButtonElement;

  let open = false;
  let convs: Conversation[] = [];
  const views = new Map<string, ConvView>();
  let current: ConvView | null = null;

  // ---------- voz ----------

  let voiceOn = false;
  /** El botón ▶ de la burbuja que se está leyendo, para volverlo a ▶ al terminar. */
  let playing: HTMLButtonElement | null = null;
  function renderVoice() {
    voiceBtn.textContent = voiceOn ? "🔊" : "🔈";
    voiceBtn.classList.toggle("on", voiceOn);
    voiceBtn.title = voiceOn ? "Leyendo las respuestas en voz alta. Clic para dejar de leer" : "Leer las respuestas en voz alta";
  }
  void api.getSettings().then((s) => {
    voiceOn = s.speak;
    renderVoice();
  });
  voiceBtn.addEventListener("click", async () => {
    voiceOn = !voiceOn;
    renderVoice();
    if (!voiceOn) quiet();
    voiceOn = (await api.setSettings({ speak: voiceOn })).speak;
  });
  function quiet() {
    stopSpeaking();
    if (playing) playing.textContent = "▶";
    playing = null;
  }
  function read(text: string, btn: HTMLButtonElement | null) {
    quiet();
    if (btn) {
      btn.textContent = "■";
      playing = btn;
    }
    speak(text, () => {
      if (playing === btn && btn) btn.textContent = "▶";
      if (playing === btn) playing = null;
    });
  }

  // ---------- botón de la barra y ancho del panel ----------

  const toggleBtn = document.getElementById("toggle-assistant");
  const dot = toggleBtn?.querySelector<HTMLSpanElement>(".ta-dot") ?? null;
  /** Punto en el botón: alguna conversación tiene una respuesta sin ver. */
  function renderButton() {
    const unread = [...views.values()].some((v) => v.unread);
    if (dot) dot.hidden = !unread;
    toggleBtn?.classList.toggle("unread", unread);
    toggleBtn?.classList.toggle("busy", convs.some((c) => c.busy));
  }

  const DEFAULT_WIDTH = 520;
  function applyWidth(px: number) {
    const w = Math.round(Math.min(Math.max(360, px), Math.max(380, window.innerWidth - 480)));
    document.body.style.setProperty("--assistant-w", `${w}px`);
    try {
      localStorage.setItem("assistant-width", String(w));
    } catch {
      // no importa si no se puede recordar
    }
  }
  try {
    applyWidth(Number(localStorage.getItem("assistant-width")) || DEFAULT_WIDTH);
  } catch {
    applyWidth(DEFAULT_WIDTH);
  }
  const resizer = aside.querySelector(".as-resizer") as HTMLDivElement;
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-dock");
    const onMove = (ev: PointerEvent) => applyWidth(window.innerWidth - ev.clientX);
    const onUp = () => {
      document.body.classList.remove("resizing-dock");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });
  resizer.addEventListener("dblclick", () => applyWidth(DEFAULT_WIDTH));

  // ---------- conversaciones (pestañas del chat) ----------

  function viewFor(conv: Conversation): ConvView {
    let v = views.get(conv.id);
    if (!v) {
      const log = document.createElement("div");
      log.className = "as-log";
      log.hidden = true;
      logs.append(log);
      v = { conv, log, loaded: false, lastDay: "", live: null, approvalCards: new Map(), draft: "", unread: false };
      views.set(conv.id, v);
    }
    v.conv = conv;
    return v;
  }

  function renderConvs() {
    convList.replaceChildren();
    for (const c of convs) {
      const v = viewFor(c);
      const b = document.createElement("button");
      b.className = "as-conv";
      b.classList.toggle("on", current?.conv.id === c.id);
      b.classList.toggle("busy", c.busy);
      b.classList.toggle("unread", v.unread);
      b.title = c.daily ? "La jornada: recuerda todo lo de hoy" : `${c.title}\nDoble clic: renombrar · clic derecho: más opciones`;
      const label = document.createElement("span");
      label.textContent = c.daily ? `☀ ${c.title}` : c.title;
      b.append(label);
      b.addEventListener("click", () => select(c.id));
      b.addEventListener("dblclick", () => !c.daily && renameConv(c, b, label));
      b.addEventListener("contextmenu", (e) =>
        showContextMenu(e, [
          { label: "Renombrar", action: () => renameConv(c, b, label), disabled: c.daily },
          { label: "Conversación nueva", action: () => void newConv() },
          "-",
          { label: "Borrar conversación", action: () => void deleteConv(c), disabled: c.daily, danger: true },
        ]),
      );
      convList.append(b);
    }
    convList.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    renderButton();
  }

  function renameConv(c: Conversation, btn: HTMLButtonElement, label: HTMLSpanElement) {
    if (c.daily) return;
    const field = document.createElement("input");
    field.value = c.title;
    label.replaceWith(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      field.replaceWith(label);
      const value = field.value.trim();
      if (commit && value && value !== c.title) {
        label.textContent = value;
        void api.chatRename(c.id, value);
      }
      input.focus();
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    field.addEventListener("click", (e) => e.stopPropagation());
    field.addEventListener("blur", () => finish(true));
    btn.classList.add("editing");
  }

  async function newConv() {
    const c = await api.chatNew();
    if (!convs.some((x) => x.id === c.id)) convs.push(c);
    await select(c.id);
  }

  async function deleteConv(c: Conversation) {
    if (c.daily) return;
    const v = views.get(c.id);
    const has = v?.log.querySelector(".as-msg");
    if (has && !confirm(`¿Borrar la conversación «${c.title}»? Se pierde su historial.`)) return;
    await api.chatDelete(c.id);
    v?.log.remove();
    views.delete(c.id);
    convs = convs.filter((x) => x.id !== c.id);
    if (current?.conv.id === c.id) await select(convs[0]?.id);
    else renderConvs();
  }

  async function select(id: string | undefined) {
    const conv = convs.find((c) => c.id === id) ?? convs[0];
    if (!conv) return;
    if (current) current.draft = input.value;
    for (const v of views.values()) v.log.hidden = true;
    const v = viewFor(conv);
    current = v;
    v.log.hidden = false;
    v.unread = false;
    input.value = v.draft;
    autosize();
    try {
      localStorage.setItem("assistant-conv", conv.id);
    } catch {
      // no importa si no se puede recordar
    }
    renderConvs();
    renderBusy();
    if (!v.loaded) await loadHistory(v);
    scrollDown(v, true);
    if (open) input.focus();
  }

  api.chatList().then((list) => {
    convs = list;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("assistant-conv");
    } catch {
      // sin almacenamiento local: la Jornada
    }
    current = viewFor(convs.find((c) => c.id === saved) ?? convs[0]);
    current.log.hidden = false;
    renderConvs();
    renderBusy();
  });

  // ---------- pintar ----------

  const atBottom = (v: ConvView) => v.log.scrollHeight - v.log.scrollTop - v.log.clientHeight < 80;
  const scrollDown = (v: ConvView, force = false) => {
    if (force || atBottom(v)) v.log.scrollTop = v.log.scrollHeight;
  };

  function separator(v: ConvView, at: number) {
    const label = dayLabel(at);
    if (label === v.lastDay) return;
    v.lastDay = label;
    const sep = document.createElement("div");
    sep.className = "as-day";
    sep.textContent = label;
    v.log.append(sep);
  }

  function copyButton(text: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "as-copy";
    b.textContent = "⧉";
    b.title = "Copiar";
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      b.textContent = "✓";
      b.classList.add("done");
      setTimeout(() => {
        b.textContent = "⧉";
        b.classList.remove("done");
      }, 1200);
    });
    return b;
  }

  function bubble(v: ConvView, m: ChatMessage): HTMLDivElement {
    separator(v, m.at);
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
    if (m.role !== "event" && m.text) meta.prepend(copyButton(m.text));
    if (m.role === "assistant" && m.text) {
      const play = document.createElement("button");
      play.className = "as-play";
      play.textContent = "▶";
      play.title = "Escuchar";
      play.addEventListener("click", () => (playing === play ? quiet() : read(m.text, play)));
      meta.prepend(play);
    }
    el.append(meta);
    v.log.append(el);
    return el;
  }

  /** Copiar un bloque de código entero, sin seleccionarlo. */
  function addCodeCopy(container: HTMLElement) {
    for (const pre of container.querySelectorAll("pre")) {
      if (pre.querySelector(".as-copy")) continue;
      const btn = copyButton(pre.textContent ?? "");
      btn.classList.add("code");
      pre.append(btn);
    }
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

  function liveBubble(v: ConvView, messageId: string) {
    separator(v, Date.now());
    const el = document.createElement("div");
    el.className = "as-msg assistant live";
    const body = document.createElement("div");
    body.className = "as-body";
    body.innerHTML = '<span class="as-typing"><i></i><i></i><i></i></span>';
    const tools = document.createElement("div");
    tools.className = "as-tools";
    el.append(body, tools);
    v.log.append(el);
    v.live = { id: messageId, el, body, tools, text: "" };
  }

  function approvalCard(v: ConvView, req: ApprovalRequest) {
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
    v.log.append(card);
    v.approvalCards.set(req.id, card);
    scrollDown(v, true);
    // Que se note aunque el panel esté cerrado, en otra conversación o con la app en segundo plano.
    if (!open || current !== v) {
      v.unread = true;
      renderConvs();
    }
    notify(`💬 ${v.conv.daily ? "El asistente" : v.conv.title} necesita tu OK`, req.summary.split("\n")[0], () => reveal(v.conv.id));
  }

  /** Abre el panel en esa conversación (desde una notificación). */
  function reveal(convId: string) {
    if (!open) panel.toggle();
    void select(convId);
  }

  /** El botón Enviar/Detener sigue a la conversación que se está viendo. */
  function renderBusy() {
    const busy = Boolean(current?.conv.busy);
    sendBtn.textContent = busy ? "Detener" : "Enviar";
    sendBtn.classList.toggle("stop", busy);
    aside.classList.toggle("busy", busy);
  }

  // ---------- eventos del asistente ----------

  api.onChat((e: ChatStreamEvent) => {
    if (e.type === "conversations") {
      convs = e.list;
      for (const v of views.values()) if (!convs.some((c) => c.id === v.conv.id)) v.log.remove();
      for (const id of [...views.keys()]) if (!convs.some((c) => c.id === id)) views.delete(id);
      renderConvs();
      renderBusy();
      return;
    }
    const conv = convs.find((c) => c.id === e.convId);
    const v = conv ? viewFor(conv) : null;
    // Sin el historial cargado, se pinta todo junto al abrir esa conversación.
    if (!v?.loaded) {
      if (v && e.type === "done" && !e.message.error) {
        v.unread = true;
        renderConvs();
        notify(`💬 Respondió ${v.conv.daily ? "el asistente" : `«${v.conv.title}»`}`, e.message.text.slice(0, 120), () => reveal(v.conv.id));
      }
      return;
    }
    // La burbuja «escribiendo» que se armó al abrir la conversación adopta la respuesta en curso.
    if (v.live && !v.live.id && "messageId" in e) v.live.id = e.messageId;
    if (e.type === "start") {
      v.live?.el.remove();
      liveBubble(v, e.messageId);
      scrollDown(v, true);
    } else if (e.type === "text" && v.live?.id === e.messageId) {
      v.live.text += e.delta;
      v.live.body.replaceChildren(renderMarkdown(v.live.text));
      scrollDown(v);
    } else if (e.type === "tool" && v.live?.id === e.messageId) {
      if (![...v.live.tools.children].some((c) => c.textContent === e.label)) {
        const chip = document.createElement("span");
        chip.className = "running";
        chip.textContent = e.label;
        v.live.tools.append(chip);
        scrollDown(v);
      }
    } else if (e.type === "approval") {
      approvalCard(v, e.request);
    } else if (e.type === "approval-done") {
      const card = v.approvalCards.get(e.id);
      if (card) {
        card.classList.add(e.approved ? "approved" : "rejected");
        card.querySelector(".as-approval-actions")!.replaceChildren(
          Object.assign(document.createElement("span"), { textContent: e.approved ? "✅ Aprobado" : "🚫 Rechazado" }),
        );
      }
    } else if (e.type === "done") {
      v.live?.el.remove();
      v.live = null;
      const done = bubble(v, e.message);
      addCodeCopy(done);
      const seen = open && current === v;
      if (voiceOn && !isMuted() && !e.message.error && seen) read(e.message.text, done.querySelector(".as-play"));
      scrollDown(v, true);
      if (!seen) {
        v.unread = true;
        renderConvs();
        notify(`💬 Respondió ${v.conv.daily ? "el asistente" : `«${v.conv.title}»`}`, e.message.text.slice(0, 120), () => reveal(v.conv.id));
      }
    } else if (e.type === "event") {
      bubble(v, e.message);
      scrollDown(v, true);
    }
  });

  // Los de una nota los avisa el panel de notas (el clic abre la nota).
  api.onReminder((r) => r.noteId || notify("⏰ Recordatorio", r.text, () => reveal("jornada")));

  // ---------- enviar ----------

  async function send() {
    const v = current;
    const text = input.value.trim();
    if (!v || !text || v.conv.busy) return;
    input.value = "";
    v.draft = "";
    autosize();
    quiet();
    if (!v.loaded) await loadHistory(v);
    v.log.querySelector(".as-empty")?.remove();
    bubble(v, { id: "", role: "user", text, at: Date.now() });
    scrollDown(v, true);
    // Se marca ya: el aviso de «respondiendo» del proceso main llega un instante después.
    v.conv.busy = true;
    renderBusy();
    renderConvs();
    try {
      await api.chatSend(v.conv.id, text);
    } catch (err) {
      v.conv.busy = false;
      renderBusy();
      v.live?.el.remove();
      v.live = null;
      bubble(v, { id: "", role: "event", text: `No se pudo enviar: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)}`, at: Date.now() });
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (current?.conv.busy) api.chatStop(current.conv.id);
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
  aside.querySelector(".as-conv-new")!.addEventListener("click", () => void newConv());
  aside.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      panel.close();
    }
  });

  async function loadHistory(v: ConvView) {
    const history = await api.chatHistory(v.conv.id);
    v.log.replaceChildren();
    v.lastDay = "";
    if (!history.length) {
      const hello = document.createElement("div");
      hello.className = "as-empty";
      const p1 = document.createElement("p");
      p1.textContent = v.conv.daily ? "Contame cómo arranca tu jornada, o pedime algo:" : "Una conversación aparte. Pedime algo:";
      const ul = document.createElement("ul");
      for (const ex of v.conv.daily ? EXAMPLES.daily : EXAMPLES.thread) {
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
      v.log.append(hello);
    }
    for (const m of history) addCodeCopy(bubble(v, m));
    // Si está respondiendo, que se vea aunque la respuesta haya empezado antes de abrirla.
    if (v.conv.busy) liveBubble(v, "");
    v.loaded = true;
  }

  const panel: AssistantPanel = {
    get isOpen() {
      return open;
    },
    get hasFocus() {
      return open && aside.contains(document.activeElement);
    },
    newConversation() {
      if (!open) panel.toggle();
      void newConv();
    },
    toggle() {
      if (open) return panel.close();
      hooks.onOpen();
      open = true;
      aside.classList.add("open");
      // Se acomoda al costado: corre la agenda y las terminales en vez de taparlas.
      document.body.classList.add("dock-assistant");
      toggleBtn?.classList.add("on");
      void select(current?.conv.id);
    },
    close() {
      if (!open) return;
      open = false;
      if (current) current.draft = input.value;
      aside.classList.remove("open");
      document.body.classList.remove("dock-assistant");
      toggleBtn?.classList.remove("on");
      hooks.onClose();
    },
  };
  return panel;
}
