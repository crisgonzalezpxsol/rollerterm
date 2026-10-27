// Panel lateral de notas (📝 o ⌘⇧N): una lista y un editor visual que se guarda solo.
// Se acomoda a la derecha y corre la agenda y las terminales para hacerse lugar.
// El editor muestra títulos, listas y tareas ya formateados (las tareas se tildan con un clic);
// por dentro cada nota es Markdown («## título», «- [ ] tarea»).
// Cada nota puede ser de un cliente y llevar etiquetas; las de un mismo cliente se leen
// juntas en su historial (con las tareas pendientes arriba) y se exportan a Markdown.
import type { Note, Reminder, RollertermApi } from "../shared/types";
import { renderMarkdown } from "./markdown";
import { createNoteEditor, normalizeLegacy } from "./note-editor";
import { notify } from "./notify";

const SAVE_DELAY_MS = 400;
const DEFAULT_WIDTH = 420;

export interface NotesPanel {
  toggle(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** La primera línea con texto es el título (sin los # de un título de Markdown). */
function titleOf(n: Note): string {
  return (
    n.text
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .replace(/^#{1,4}\s+/, "") || "Nota vacía"
  );
}

/** «- [ ] algo» / «- [x] algo» (también con * o +). */
const CHECK = /^(\s*[-*+]\s+)\[( |x|X)\]\s?(.*)$/;

function checks(text: string): { done: number; total: number } {
  const items = text.split("\n").map((l) => CHECK.exec(l)).filter((m) => m !== null);
  return { done: items.filter((m) => m[2] !== " ").length, total: items.length };
}

function preview(n: Note): string {
  const lines = n.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines
    .slice(1)
    .map((l) => l.replace(CHECK, (_m, _b, x: string, t: string) => `${x === " " ? "☐" : "☑"} ${t}`).replace(/^#{1,4}\s+/, ""))
    .join(" ")
    .slice(0, 120);
}

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (d.toDateString() === now.toDateString()) return time;
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `ayer ${time}`;
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
}

/** Fecha completa para el historial y las entradas: «vie 23/10/2026 10:27». */
function stamp(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).replace(",", "");
  return `${day} ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

/** Para un <input type="datetime-local">: «2026-10-23T11:00» en hora local. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** «hoy 15:00», «mañana 09:00», «lun 27/10 09:00». */
function whenAhead(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toDateString();
  if (d.toDateString() === day(0)) return `hoy ${time}`;
  if (d.toDateString() === day(1)) return `mañana ${time}`;
  return `${d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" }).replace(",", "")} ${time}`;
}

/** Mismo cliente aunque cambien mayúsculas o espacios. */
const clientKey = (c: string | undefined) => (c ?? "").trim().toLowerCase();

function parseTags(v: string): string[] {
  return [...new Set(v.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean))];
}

function template(client: string): string {
  return [
    `Ficha · ${client || "Cliente"}`,
    "",
    "## Datos",
    "- Contacto: ",
    "- Email / teléfono: ",
    "- Producto / plan: ",
    "",
    "## Tareas",
    "- [ ] ",
    "",
    "## Historial",
    `### ${stamp(Date.now())}`,
    "",
  ].join("\n");
}

/** La nota en Markdown, con su cliente y etiquetas debajo del título (para exportar). */
function noteMarkdown(n: Note, level = 2): string {
  const lines = n.text.split("\n");
  const titleAt = lines.findIndex((l) => l.trim());
  const body = lines.slice(titleAt + 1).join("\n").trim();
  const meta = [stamp(n.createdAt), n.client && `Cliente: ${n.client}`, n.tags?.length && n.tags.map((t) => `#${t}`).join(" ")]
    .filter(Boolean)
    .join(" · ");
  return `${"#".repeat(level)} ${titleOf(n)}\n_${meta}_\n\n${body}\n`;
}

export function mountNotes(api: RollertermApi, onClose: () => void): NotesPanel {
  const aside = document.createElement("aside");
  aside.id = "notes";
  aside.innerHTML = `
    <div class="notes-resizer" title="Arrastrá para cambiar el ancho · doble clic: ancho por defecto"></div>
    <div class="notes-view notes-list-view">
      <header>
        <h2>Notas</h2>
        <button class="notes-new" title="Nueva nota">+ Nueva</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <div class="notes-filters">
        <input class="notes-search" type="search" placeholder="Buscar…" spellcheck="false" />
        <select class="notes-client-filter" title="Filtrar por cliente"></select>
        <button class="notes-pending-filter" title="Solo las notas con tareas sin completar">Pendientes</button>
        <button class="notes-history-open" title="Ver todas las notas del cliente como un documento" hidden>Historial</button>
      </div>
      <ol class="notes-list"></ol>
    </div>
    <div class="notes-view notes-edit-view" hidden>
      <header>
        <button class="notes-back" title="Volver a la lista">‹ Notas</button>
        <span class="notes-saved"></span>
        <button class="notes-delete" title="Borrar nota">Borrar</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <div class="notes-meta">
        <input class="notes-client" list="notes-clients" placeholder="Cliente" spellcheck="false" />
        <input class="notes-tags" placeholder="Etiquetas, separadas por coma" spellcheck="false" />
        <datalist id="notes-clients"></datalist>
      </div>
      <div class="notes-toolbar">
        <button data-fmt="h1" title="Título (⌘1)">H1</button>
        <button data-fmt="h2" title="Subtítulo (⌘2)">H2</button>
        <button data-fmt="h3" title="Sección (⌘3)">H3</button>
        <button data-fmt="bold" title="Negrita (⌘B)"><b>B</b></button>
        <button data-fmt="list" title="Lista">•</button>
        <button data-fmt="check" title="Lista de tareas (⌘L)">☑</button>
        <button data-fmt="hr" title="Separador">―</button>
        <button data-fmt="reminder" title="Recordatorio (con el texto seleccionado o la línea del cursor)">⏰</button>
        <button data-fmt="entry" title="Entrada de historial con fecha y hora (⌘D)">+ Entrada</button>
        <button data-fmt="template" title="Ficha de cliente: datos, tareas e historial">Ficha</button>
      </div>
      <div class="notes-editor"></div>
      <section class="notes-reminders">
        <header>
          <span>⏰ Recordatorios</span>
          <button class="notes-rem-add" title="Nuevo recordatorio para esta nota">+ Agregar</button>
        </header>
        <form class="notes-rem-form" hidden>
          <input class="notes-rem-text" placeholder="Qué hay que recordar" required spellcheck="true" />
          <div class="notes-rem-when">
            <input class="notes-rem-at" type="datetime-local" required />
            <button type="button" data-in="60">1 h</button>
            <button type="button" data-in="tomorrow">Mañana 9:00</button>
            <button type="button" data-in="monday">Lunes 9:00</button>
          </div>
          <div class="notes-rem-actions">
            <button type="button" class="notes-rem-cancel">Cancelar</button>
            <button type="submit" class="notes-rem-save">Guardar</button>
          </div>
        </form>
        <ol class="notes-rem-list"></ol>
      </section>
    </div>
    <div class="notes-view notes-history-view" hidden>
      <header>
        <button class="notes-history-back" title="Volver a la lista">‹ Notas</button>
        <strong class="notes-history-title"></strong>
        <button class="notes-history-copy" title="Copiar el historial como Markdown">Copiar</button>
        <button class="notes-history-export" title="Guardar el historial como archivo .md">Exportar</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <div class="notes-render notes-history" tabindex="0"></div>
    </div>`;
  document.body.append(aside);

  const $ = <T extends HTMLElement>(sel: string) => aside.querySelector(sel) as T;
  const listView = $<HTMLDivElement>(".notes-list-view");
  const editView = $<HTMLDivElement>(".notes-edit-view");
  const historyView = $<HTMLDivElement>(".notes-history-view");
  const list = $<HTMLOListElement>(".notes-list");
  const search = $<HTMLInputElement>(".notes-search");
  const clientFilter = $<HTMLSelectElement>(".notes-client-filter");
  const historyOpen = $<HTMLButtonElement>(".notes-history-open");
  const saved = $<HTMLSpanElement>(".notes-saved");
  const toolbar = $<HTMLDivElement>(".notes-toolbar");
  const clientInput = $<HTMLInputElement>(".notes-client");
  const tagsInput = $<HTMLInputElement>(".notes-tags");
  const clientsList = $<HTMLDataListElement>("#notes-clients");
  const history = $<HTMLDivElement>(".notes-history");
  const historyTitle = $<HTMLElement>(".notes-history-title");

  let notes: Note[] = [];
  let reminders: Reminder[] = [];
  /** Solo las notas con tareas sin completar. */
  let onlyPending = false;
  let current: Note | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let open = false;
  const editor = createNoteEditor($<HTMLDivElement>(".notes-editor"), {
    onChange(markdown) {
      if (!current) return;
      current.text = markdown;
      changed();
    },
    onEntry: () => applyFormat("entry"),
    onState: markActive,
  });
  /** Cliente elegido en el filtro de la lista (su clave); "" = todos, "-" = sin cliente. */
  let filterClient = "";

  async function load() {
    [notes, reminders] = await Promise.all([api.listNotes(), api.listReminders()]);
    if (!historyView.hidden) renderHistory();
    else renderList();
  }

  /** Los clientes con notas, con el nombre como se escribió la última vez. */
  function clients(): { key: string; name: string; count: number }[] {
    const by = new Map<string, { key: string; name: string; count: number; at: number }>();
    for (const n of notes) {
      const key = clientKey(n.client);
      if (!key) continue;
      const c = by.get(key);
      if (!c) by.set(key, { key, name: n.client!.trim(), count: 1, at: n.updatedAt });
      else {
        c.count++;
        if (n.updatedAt > c.at) Object.assign(c, { name: n.client!.trim(), at: n.updatedAt });
      }
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  function renderFilters() {
    const all = clients();
    if (filterClient && filterClient !== "-" && !all.some((c) => c.key === filterClient)) filterClient = "";
    clientFilter.replaceChildren();
    const opt = (value: string, label: string) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      clientFilter.append(o);
    };
    opt("", "Todos los clientes");
    for (const c of all) opt(c.key, `${c.name} (${c.count})`);
    if (notes.some((n) => !clientKey(n.client))) opt("-", "Sin cliente");
    clientFilter.value = filterClient;
    clientFilter.hidden = !all.length;
    historyOpen.hidden = !filterClient || filterClient === "-";
    pendingFilter.classList.toggle("on", onlyPending);
    clientsList.replaceChildren(
      ...all.map((c) => {
        const o = document.createElement("option");
        o.value = c.name;
        return o;
      }),
    );
  }

  /** Recordatorios por avisar de una nota, el más cercano primero. */
  const pendingReminders = (n: Note) => reminders.filter((r) => r.noteId === n.id && !r.done);

  function matches(n: Note): boolean {
    if (onlyPending) {
      const { done, total } = checks(n.text);
      if (done === total) return false;
    }
    if (filterClient === "-" ? clientKey(n.client) : filterClient && clientKey(n.client) !== filterClient) return false;
    const q = search.value.trim().toLowerCase();
    if (!q) return true;
    return [n.text, n.client ?? "", ...(n.tags ?? []).map((t) => `#${t}`)].some((s) => s.toLowerCase().includes(q));
  }

  function chip(label: string, cls: string, onClick?: () => void): HTMLSpanElement {
    const c = document.createElement("span");
    c.className = `notes-chip ${cls}`;
    c.textContent = label;
    if (onClick)
      c.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    return c;
  }

  function renderList() {
    renderFilters();
    list.innerHTML = "";
    if (!notes.length) {
      const empty = document.createElement("li");
      empty.className = "notes-empty";
      empty.textContent = "Todavía no hay notas. Tocá «+ Nueva».";
      list.append(empty);
      return;
    }
    const shown = notes.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!shown.length) {
      const empty = document.createElement("li");
      empty.className = "notes-empty";
      empty.textContent = "Ninguna nota coincide con el filtro.";
      list.append(empty);
      return;
    }
    for (const n of shown) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = titleOf(n);
      const meta = document.createElement("span");
      meta.className = "notes-when";
      meta.textContent = when(n.updatedAt);
      const prev = document.createElement("p");
      prev.textContent = preview(n);
      li.append(title, meta);
      const { done, total } = checks(n.text);
      if (total) {
        const badge = document.createElement("span");
        badge.className = "notes-progress";
        const left = total - done;
        // Las que tienen tareas sin hacer se marcan en la lista; las completas, con un ✓.
        li.classList.toggle("has-pending", left > 0);
        badge.classList.toggle("complete", !left);
        badge.textContent = left ? `${left} ${left === 1 ? "pendiente" : "pendientes"}` : `✓ ${total}`;
        badge.title = `${done} de ${total} tareas hechas`;
        meta.prepend(badge);
      }
      const next = pendingReminders(n)[0];
      if (next) {
        const r = document.createElement("span");
        r.className = "notes-rem-badge";
        r.textContent = `⏰ ${whenAhead(Date.parse(next.when))}`;
        r.title = next.text;
        meta.prepend(r);
      }
      if (n.client || n.tags?.length) {
        const chips = document.createElement("div");
        chips.className = "notes-chips";
        if (n.client)
          chips.append(
            chip(n.client, "client", () => {
              filterClient = clientKey(n.client);
              renderList();
            }),
          );
        for (const t of n.tags ?? [])
          chips.append(
            chip(`#${t}`, "tag", () => {
              search.value = `#${t}`;
              renderList();
            }),
          );
        li.append(chips);
      }
      li.append(prev);
      li.addEventListener("click", () => edit(n));
      list.append(li);
    }
  }

  function showList() {
    flush();
    // Una nota que quedó vacía no vale la pena guardarla.
    if (current && !current.text.trim()) void remove(current, false);
    current = null;
    editView.hidden = true;
    historyView.hidden = true;
    listView.hidden = false;
    renderList();
  }

  function edit(n: Note) {
    current = n;
    // Sin emitir cambios: abrir una nota no la reescribe.
    editor.commands.setContent(normalizeLegacy(n.text), { contentType: "markdown", emitUpdate: false });
    clientInput.value = n.client ?? "";
    tagsInput.value = (n.tags ?? []).join(", ");
    saved.textContent = `Editada ${when(n.updatedAt)}`;
    renderFilters();
    listView.hidden = true;
    historyView.hidden = true;
    editView.hidden = false;
    editor.commands.focus(n.text.trim() ? "end" : "start");
    markActive();
    remForm.hidden = true;
    renderReminders();
  }

  // ---------- recordatorios de la nota ----------

  const remSection = $<HTMLElement>(".notes-reminders");
  const remList = $<HTMLOListElement>(".notes-rem-list");
  const remForm = $<HTMLFormElement>(".notes-rem-form");
  const remText = $<HTMLInputElement>(".notes-rem-text");
  const remAt = $<HTMLInputElement>(".notes-rem-at");

  function renderReminders() {
    if (!current) return;
    const mine = reminders.filter((r) => r.noteId === current!.id).sort((a, b) => Number(a.done) - Number(b.done) || Date.parse(a.when) - Date.parse(b.when));
    remSection.classList.toggle("empty", !mine.length && remForm.hidden === true);
    remList.replaceChildren(
      ...mine.map((r) => {
        const li = document.createElement("li");
        li.classList.toggle("done", r.done);
        const at = document.createElement("time");
        at.textContent = r.done ? `avisado ${when(Date.parse(r.when))}` : whenAhead(Date.parse(r.when));
        at.title = stamp(Date.parse(r.when));
        const txt = document.createElement("span");
        txt.textContent = r.text;
        const del = document.createElement("button");
        del.textContent = "×";
        del.title = r.done ? "Quitar" : "Cancelar el recordatorio";
        del.addEventListener("click", () => {
          reminders = reminders.filter((x) => x.id !== r.id);
          renderReminders();
          void api.removeReminder(r.id);
        });
        li.append(at, txt, del);
        return li;
      }),
    );
  }

  /** El texto seleccionado o, si no hay, el de la línea del cursor. */
  function textAtCursor(): string {
    const { from, to, $from } = editor.state.selection;
    const sel = editor.state.doc.textBetween(from, to, " ").trim();
    return sel || $from.parent.textContent.trim();
  }

  function openReminderForm(text = "") {
    if (!current) return;
    remText.value = text;
    // Por defecto, dentro de una hora, en punto.
    const d = new Date(Date.now() + 60 * 60_000);
    d.setMinutes(0, 0, 0);
    remAt.value = localInput(d.getTime());
    remForm.hidden = false;
    renderReminders();
    remText.focus();
    remText.select();
  }

  function closeReminderForm() {
    remForm.hidden = true;
    renderReminders();
  }

  remForm.querySelectorAll<HTMLButtonElement>("[data-in]").forEach((b) =>
    b.addEventListener("click", () => {
      const d = new Date();
      if (b.dataset.in === "tomorrow") {
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
      } else if (b.dataset.in === "monday") {
        d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
        d.setHours(9, 0, 0, 0);
      } else d.setTime(d.getTime() + Number(b.dataset.in) * 60_000);
      remAt.value = localInput(d.getTime());
    }),
  );
  remForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!current) return;
    const text = remText.value.trim();
    const at = new Date(remAt.value).getTime();
    if (!text || Number.isNaN(at)) return;
    // Una nota vacía se borra al salir: el recordatorio le pone título para que quede.
    if (editor.isEmpty) editor.commands.setContent(text, { contentType: "markdown" });
    const note = current;
    flush();
    void api.saveNote(note);
    void api.addReminder(new Date(at).toISOString(), text, note.id).then((r) => {
      reminders.push(r);
      if (current?.id === note.id) closeReminderForm();
    });
  });
  $<HTMLButtonElement>(".notes-rem-cancel").addEventListener("click", closeReminderForm);
  remForm.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeReminderForm();
      editor.commands.focus();
    }
  });
  $<HTMLButtonElement>(".notes-rem-add").addEventListener("click", () => openReminderForm(textAtCursor()));

  // ---------- historial: texto con checks clicables ----------

  /**
   * El texto de una nota con sus checks clicables; el resto, con el markdown de siempre.
   * Con `withTitle` la primera línea se muestra como título; si no, se saltea (el historial
   * pone su propio encabezado).
   */
  function renderBody(into: HTMLElement, source: string, onToggle: (line: number, checked: boolean) => void, withTitle = true) {
    const lines = source.split("\n");
    let chunk: string[] = [];
    const flushChunk = () => {
      if (chunk.some((l) => l.trim())) {
        const div = document.createElement("div");
        div.className = "notes-md";
        div.append(renderMarkdown(chunk.join("\n")));
        into.append(div);
      }
      chunk = [];
    };
    const titleAt = lines.findIndex((l) => l.trim());
    lines.forEach((line, i) => {
      const m = CHECK.exec(line);
      if (i === titleAt && !m) {
        if (!withTitle) return;
        const title = document.createElement("div");
        title.className = "notes-title";
        title.textContent = line.trim().replace(/^#{1,4}\s+/, "");
        return into.append(title);
      }
      if (!m) return chunk.push(line);
      flushChunk();
      into.append(checkRow(m, (checked) => onToggle(i, checked)));
    });
    flushChunk();
  }

  function checkRow(m: RegExpExecArray, onChange: (checked: boolean) => void, source?: string): HTMLLabelElement {
    const row = document.createElement("label");
    row.className = "notes-item";
    row.style.paddingLeft = `${Math.min(m[1].search(/\S/), 8) * 8}px`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = m[2] !== " ";
    const label = document.createElement("span");
    label.textContent = m[3] || " ";
    row.classList.toggle("done", box.checked);
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, label);
    if (source) {
      const from = document.createElement("small");
      from.className = "notes-item-source";
      from.textContent = source;
      row.append(from);
    }
    return row;
  }

  function setLine(n: Note, i: number, checked: boolean) {
    const lines = n.text.split("\n");
    lines[i] = lines[i].replace(CHECK, (_m, b: string, _x, t: string) => `${b}[${checked ? "x" : " "}] ${t}`);
    n.text = lines.join("\n");
  }

  // ---------- formato ----------

  function applyFormat(fmt: string) {
    if (!current) return;
    const c = editor.chain().focus();
    if (fmt === "h1" || fmt === "h2" || fmt === "h3") c.toggleHeading({ level: Number(fmt[1]) as 1 | 2 | 3 }).run();
    else if (fmt === "bold") c.toggleBold().run();
    else if (fmt === "list") c.toggleBulletList().run();
    else if (fmt === "check") c.toggleTaskList().run();
    else if (fmt === "hr") c.setHorizontalRule().run();
    else if (fmt === "reminder") openReminderForm(textAtCursor());
    else if (fmt === "entry") {
      // Las entradas van al final: el historial se lee de arriba hacia abajo.
      const end = editor.state.doc.content.size;
      c.insertContentAt(end, [
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: stamp(Date.now()) }] },
        { type: "paragraph" },
      ])
        .focus("end")
        .run();
    } else if (fmt === "template") {
      const t = template(clientInput.value.trim());
      if (editor.isEmpty) c.setContent(t, { contentType: "markdown" }).focus("end").run();
      else c.insertContentAt(editor.state.doc.content.size, t.split("\n").slice(2).join("\n"), { contentType: "markdown" }).focus("end").run();
    }
  }

  const FMT_ACTIVE: Record<string, () => boolean> = {
    h1: () => editor.isActive("heading", { level: 1 }),
    h2: () => editor.isActive("heading", { level: 2 }),
    h3: () => editor.isActive("heading", { level: 3 }),
    bold: () => editor.isActive("bold"),
    list: () => editor.isActive("bulletList"),
    check: () => editor.isActive("taskList"),
  };
  /** Los botones de la barra se marcan según dónde está el cursor. */
  function markActive() {
    toolbar.querySelectorAll<HTMLButtonElement>("button[data-fmt]").forEach((b) => b.classList.toggle("on", FMT_ACTIVE[b.dataset.fmt!]?.() ?? false));
  }

  toolbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-fmt]");
    if (b) applyFormat(b.dataset.fmt!);
  });
  // Los botones no le roban el foco (ni la selección) al texto.
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());

  // ---------- historial del cliente ----------

  function clientNotes(): Note[] {
    return notes.filter((n) => clientKey(n.client) === filterClient).sort((a, b) => a.createdAt - b.createdAt);
  }

  function clientName(): string {
    return clients().find((c) => c.key === filterClient)?.name ?? filterClient;
  }

  function showHistory() {
    if (!filterClient || filterClient === "-") return;
    listView.hidden = true;
    editView.hidden = true;
    historyView.hidden = false;
    renderHistory();
    history.focus();
  }

  /** Todas las notas del cliente como un documento: tareas pendientes arriba y después cada nota, de la más vieja a la más nueva. */
  function renderHistory() {
    const items = clientNotes();
    if (!items.length) return showList();
    historyTitle.textContent = clientName();
    history.replaceChildren();

    const pending = items.flatMap((n) =>
      n.text.split("\n").flatMap((l, i) => {
        const m = CHECK.exec(l);
        return m && m[2] === " " ? [{ n, i, m }] : [];
      }),
    );
    const summary = document.createElement("div");
    summary.className = "notes-history-summary";
    const tasks = items.reduce((acc, n) => acc + checks(n.text).total, 0);
    summary.textContent = `${items.length} ${items.length === 1 ? "nota" : "notas"} · desde ${stamp(items[0].createdAt)} · ${tasks - pending.length}/${tasks} tareas hechas`;
    history.append(summary);
    const ids = new Set(items.map((n) => n.id));
    const upcoming = reminders.filter((r) => r.noteId && ids.has(r.noteId) && !r.done);
    if (upcoming.length) {
      const h = document.createElement("div");
      h.className = "notes-history-h";
      h.textContent = `Próximos recordatorios (${upcoming.length})`;
      history.append(h);
      const ol = document.createElement("ol");
      ol.className = "notes-rem-list";
      for (const r of upcoming) {
        const li = document.createElement("li");
        const at = document.createElement("time");
        at.textContent = whenAhead(Date.parse(r.when));
        const txt = document.createElement("span");
        txt.textContent = r.text;
        li.append(at, txt);
        ol.append(li);
      }
      history.append(ol);
    }
    if (pending.length) {
      const h = document.createElement("div");
      h.className = "notes-history-h";
      h.textContent = `Tareas pendientes (${pending.length})`;
      history.append(h);
      for (const { n, i, m } of pending) history.append(checkRow(m, (c) => toggleIn(n, i, c), titleOf(n)));
    }
    for (const n of items) {
      const section = document.createElement("section");
      section.className = "notes-history-note";
      const head = document.createElement("div");
      head.className = "notes-history-head";
      const title = document.createElement("strong");
      title.textContent = titleOf(n);
      title.title = "Abrir la nota";
      title.addEventListener("click", () => edit(n));
      const date = document.createElement("span");
      date.className = "notes-when";
      date.textContent = stamp(n.createdAt);
      head.append(title, date);
      if (n.tags?.length) {
        const chips = document.createElement("div");
        chips.className = "notes-chips";
        chips.append(...n.tags.map((t) => chip(`#${t}`, "tag")));
        head.append(chips);
      }
      section.append(head);
      renderBody(section, n.text, (i, c) => toggleIn(n, i, c), false);
      history.append(section);
    }
  }

  function toggleIn(n: Note, i: number, checked: boolean) {
    setLine(n, i, checked);
    n.updatedAt = Date.now();
    void api.saveNote(n);
    renderHistory();
  }

  function historyMarkdown(): string {
    const items = clientNotes();
    const pending = items.flatMap((n) =>
      n.text
        .split("\n")
        .map((l) => CHECK.exec(l))
        .filter((m) => m !== null && m[2] === " ")
        .map((m) => `- [ ] ${m![3]} _(${titleOf(n)})_`),
    );
    return [
      `# Historial · ${clientName()}`,
      `_Exportado el ${stamp(Date.now())} · ${items.length} notas_`,
      "",
      ...(pending.length ? ["## Tareas pendientes", ...pending, ""] : []),
      ...items.map((n) => `---\n\n${noteMarkdown(n)}`),
    ].join("\n");
  }

  const historyCopy = $<HTMLButtonElement>(".notes-history-copy");
  historyCopy.addEventListener("click", () => {
    void navigator.clipboard.writeText(historyMarkdown()).then(() => {
      historyCopy.textContent = "Copiado ✓";
      setTimeout(() => (historyCopy.textContent = "Copiar"), 1500);
    });
  });
  $<HTMLButtonElement>(".notes-history-export").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([historyMarkdown()], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    const slug = clientName()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    a.download = `historial-${slug || "cliente"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $<HTMLButtonElement>(".notes-history-back").addEventListener("click", showList);
  historyOpen.addEventListener("click", showHistory);

  // ---------- alta, guardado y borrado ----------

  function create() {
    const now = Date.now();
    const n: Note = { id: crypto.randomUUID(), text: "", createdAt: now, updatedAt: now };
    // Con un cliente filtrado, la nota nueva ya es de ese cliente.
    if (filterClient && filterClient !== "-") n.client = clientName();
    notes.push(n);
    edit(n);
  }

  /** Guarda ya lo pendiente (al salir del editor o cerrar el panel). */
  function flush() {
    if (saveTimer === undefined || !current) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (current.text.trim()) void api.saveNote(current);
  }

  async function remove(n: Note, ask = true) {
    if (ask && n.text.trim() && !confirm(`¿Borrar «${titleOf(n)}»?`)) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    notes = notes.filter((x) => x.id !== n.id);
    await api.deleteNote(n.id);
    if (current?.id === n.id) {
      current = null;
      editView.hidden = true;
      listView.hidden = false;
    }
    renderList();
  }

  clientInput.addEventListener("input", () => {
    if (!current) return;
    const v = clientInput.value.trim();
    // Si coincide con un cliente que ya existe, se usa su nombre tal cual (mismo historial).
    current.client = v ? (clients().find((c) => c.key === clientKey(v))?.name ?? v) : undefined;
    changed();
  });
  tagsInput.addEventListener("input", () => {
    if (!current) return;
    const tags = parseTags(tagsInput.value);
    current.tags = tags.length ? tags : undefined;
    changed();
  });

  function changed() {
    if (!current) return;
    current.updatedAt = Date.now();
    saved.textContent = "Guardando…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!current) return;
      void api.saveNote(current).then(() => (saved.textContent = "Guardado"));
    }, SAVE_DELAY_MS);
  }

  search.addEventListener("input", renderList);
  const pendingFilter = $<HTMLButtonElement>(".notes-pending-filter");
  pendingFilter.addEventListener("click", () => {
    onlyPending = !onlyPending;
    renderList();
  });

  // ---------- ancho del panel ----------

  function applyWidth(px: number) {
    const w = Math.round(Math.min(Math.max(320, px), Math.max(340, window.innerWidth - 420)));
    document.body.style.setProperty("--notes-w", `${w}px`);
    try {
      localStorage.setItem("notes-width", String(w));
    } catch {
      // no importa si no se puede recordar
    }
  }
  try {
    applyWidth(Number(localStorage.getItem("notes-width")) || DEFAULT_WIDTH);
  } catch {
    applyWidth(DEFAULT_WIDTH);
  }
  const resizer = $<HTMLDivElement>(".notes-resizer");
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
  clientFilter.addEventListener("change", () => {
    filterClient = clientFilter.value;
    renderList();
  });

  $<HTMLButtonElement>(".notes-new").addEventListener("click", create);
  $<HTMLButtonElement>(".notes-back").addEventListener("click", showList);
  $<HTMLButtonElement>(".notes-delete").addEventListener("click", () => current && void remove(current));
  aside.querySelectorAll(".notes-close").forEach((b) => b.addEventListener("click", () => panel.close()));
  aside.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      panel.close();
    }
  });

  const panel: NotesPanel = {
    get isOpen() {
      return open;
    },
    toggle() {
      if (open) panel.close();
      else {
        open = true;
        aside.classList.add("open");
        document.body.classList.add("dock-notes");
        document.getElementById("toggle-notes")?.classList.add("on");
        void load().then(() => {
          if (current) editor.commands.focus();
          else if (!historyView.hidden) history.focus();
          else $<HTMLButtonElement>(".notes-new").focus();
        });
      }
    },
    close() {
      if (!open) return;
      if (current) showList();
      open = false;
      aside.classList.remove("open");
      document.body.classList.remove("dock-notes");
      document.getElementById("toggle-notes")?.classList.remove("on");
      onClose();
    },
  };
  // Una nota creada por el asistente aparece sin tener que cerrar y abrir el panel.
  api.onNotesChanged(() => {
    if (open && !current) void load();
  });
  api.onRemindersChanged(() => {
    void api.listReminders().then((list) => {
      reminders = list;
      if (!open) return;
      if (current) renderReminders();
      else if (!historyView.hidden) renderHistory();
      else renderList();
    });
  });
  // El aviso de un recordatorio de nota abre esa nota.
  api.onReminder((r) => {
    if (!r.noteId) return;
    notify("⏰ Recordatorio", r.text, () => {
      window.focus();
      void openNote(r.noteId!);
    });
  });
  async function openNote(id: string) {
    if (!open) panel.toggle();
    [notes, reminders] = await Promise.all([api.listNotes(), api.listReminders()]);
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    if (current) showList();
    edit(n);
  }
  // Al salir de la app no se pierde lo último que se tipeó.
  window.addEventListener("beforeunload", flush);
  return panel;
}
