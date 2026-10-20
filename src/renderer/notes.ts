// Panel lateral de notas (📝 o ⌘⇧N): una lista y un editor de texto libre que se guarda solo.
// Se acomoda a la derecha y corre la agenda y las terminales para hacerse lugar.
// Las notas pueden tener checks («- [ ] algo»): en modo «Ver» se tildan con un clic.
import type { Note, RollertermApi } from "../shared/types";
import { renderMarkdown } from "./markdown";

const SAVE_DELAY_MS = 400;

export interface NotesPanel {
  toggle(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** La primera línea con texto es el título. */
function titleOf(n: Note): string {
  return n.text.split("\n").find((l) => l.trim())?.trim() || "Nota vacía";
}

/** «- [ ] algo» / «- [x] algo» (también con * o +). */
const CHECK = /^(\s*[-*+]\s+)\[( |x|X)\]\s?(.*)$/;

function checks(text: string): { done: number; total: number } {
  const items = text.split("\n").map((l) => CHECK.exec(l)).filter((m) => m !== null);
  return { done: items.filter((m) => m[2] !== " ").length, total: items.length };
}

function preview(n: Note): string {
  const lines = n.text.split("\n").filter((l) => l.trim());
  return lines
    .slice(1)
    .map((l) => l.replace(CHECK, (_m, _b, x: string, t: string) => `${x === " " ? "☐" : "☑"} ${t}`))
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

export function mountNotes(api: RollertermApi, onClose: () => void): NotesPanel {
  const aside = document.createElement("aside");
  aside.id = "notes";
  aside.innerHTML = `
    <div class="notes-view notes-list-view">
      <header>
        <h2>Notas</h2>
        <button class="notes-new" title="Nueva nota">+ Nueva</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <ol class="notes-list"></ol>
    </div>
    <div class="notes-view notes-edit-view" hidden>
      <header>
        <button class="notes-back" title="Volver a la lista">‹ Notas</button>
        <span class="notes-saved"></span>
        <button class="notes-check" title="Convertir la línea en un check (⌘L)">☑</button>
        <button class="notes-mode" title="Alternar entre ver (con checks para tildar) y editar (⌘E)">Ver</button>
        <button class="notes-delete" title="Borrar nota">Borrar</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <textarea class="notes-text" placeholder="Escribí… La primera línea es el título. «- [ ] algo» (o ⌘L) es un check." spellcheck="true"></textarea>
      <div class="notes-render" hidden tabindex="0"></div>
    </div>`;
  document.body.append(aside);

  const $ = <T extends HTMLElement>(sel: string) => aside.querySelector(sel) as T;
  const listView = $<HTMLDivElement>(".notes-list-view");
  const editView = $<HTMLDivElement>(".notes-edit-view");
  const list = $<HTMLOListElement>(".notes-list");
  const text = $<HTMLTextAreaElement>(".notes-text");
  const saved = $<HTMLSpanElement>(".notes-saved");
  const rendered = $<HTMLDivElement>(".notes-render");
  const modeBtn = $<HTMLButtonElement>(".notes-mode");
  const checkBtn = $<HTMLButtonElement>(".notes-check");

  let notes: Note[] = [];
  let current: Note | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let open = false;

  async function load() {
    notes = await api.listNotes();
    renderList();
  }

  function renderList() {
    list.innerHTML = "";
    if (!notes.length) {
      const empty = document.createElement("li");
      empty.className = "notes-empty";
      empty.textContent = "Todavía no hay notas. Tocá «+ Nueva».";
      list.append(empty);
      return;
    }
    for (const n of [...notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
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
        badge.classList.toggle("complete", done === total);
        badge.textContent = `${done}/${total}`;
        badge.title = `${done} de ${total} checks hechos`;
        meta.prepend(badge);
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
    listView.hidden = false;
    renderList();
  }

  function edit(n: Note) {
    current = n;
    text.value = n.text;
    saved.textContent = `Editada ${when(n.updatedAt)}`;
    listView.hidden = true;
    editView.hidden = false;
    // Una nota con checks abre para tildarlos; las demás, para escribir.
    setMode(checks(n.text).total ? "view" : "edit");
  }

  // ---------- ver (con checks) / editar ----------

  let mode: "view" | "edit" = "edit";
  function setMode(next: "view" | "edit") {
    mode = next;
    text.hidden = next === "view";
    rendered.hidden = next === "edit";
    checkBtn.hidden = next === "view";
    modeBtn.textContent = next === "view" ? "Editar" : "Ver";
    if (next === "view") {
      renderNote();
      rendered.focus();
    } else text.focus();
  }

  /** La nota con sus checks clicables; el resto del texto, con el markdown de siempre. */
  function renderNote() {
    if (!current) return;
    rendered.replaceChildren();
    const lines = current.text.split("\n");
    let chunk: string[] = [];
    const flushChunk = () => {
      if (chunk.some((l) => l.trim())) {
        const div = document.createElement("div");
        div.className = "notes-md";
        div.append(renderMarkdown(chunk.join("\n")));
        rendered.append(div);
      }
      chunk = [];
    };
    const titleAt = lines.findIndex((l) => l.trim());
    lines.forEach((line, i) => {
      const m = CHECK.exec(line);
      if (i === titleAt && !m) {
        const title = document.createElement("div");
        title.className = "notes-title";
        title.textContent = line.trim();
        return rendered.append(title);
      }
      if (!m) return chunk.push(line);
      flushChunk();
      const row = document.createElement("label");
      row.className = "notes-item";
      row.style.paddingLeft = `${Math.min(m[1].search(/\S/), 8) * 8}px`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = m[2] !== " ";
      const label = document.createElement("span");
      label.textContent = m[3] || " ";
      row.classList.toggle("done", box.checked);
      box.addEventListener("change", () => toggleLine(i, box.checked));
      row.append(box, label);
      rendered.append(row);
    });
    flushChunk();
    if (!current.text.trim()) {
      const empty = document.createElement("p");
      empty.className = "notes-empty";
      empty.textContent = "Nota vacía. Tocá «Editar» para escribir.";
      rendered.append(empty);
    }
  }

  function toggleLine(i: number, checked: boolean) {
    if (!current) return;
    const lines = current.text.split("\n");
    lines[i] = lines[i].replace(CHECK, (_m, b: string, _x, t: string) => `${b}[${checked ? "x" : " "}] ${t}`);
    current.text = lines.join("\n");
    text.value = current.text;
    changed();
    renderNote();
  }

  /** ⌘L: la línea del cursor (o las seleccionadas) pasan a ser checks, o dejan de serlo. */
  function toggleCheckLines() {
    const v = text.value;
    const from = v.lastIndexOf("\n", text.selectionStart - 1) + 1;
    const toNl = v.indexOf("\n", text.selectionEnd);
    const to = toNl < 0 ? v.length : toNl;
    const lines = v.slice(from, to).split("\n");
    // En una línea vacía, arranca un check ahí mismo.
    if (lines.length === 1 && !lines[0].trim()) {
      text.setRangeText(`${lines[0]}- [ ] `, from, to, "end");
      text.dispatchEvent(new Event("input"));
      return text.focus();
    }
    const allChecks = lines.every((l) => CHECK.test(l) || !l.trim());
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      if (allChecks) return l.replace(CHECK, (_m, b: string, _x, t: string) => `${b.replace(/[-*+]\s+$/, "")}${t}`);
      if (CHECK.test(l)) return l;
      const indent = /^\s*/.exec(l)![0];
      return `${indent}- [ ] ${l.slice(indent.length).replace(/^[-*+]\s+/, "")}`;
    });
    text.setRangeText(out.join("\n"), from, to, "end");
    text.dispatchEvent(new Event("input"));
    text.focus();
  }

  function create() {
    const now = Date.now();
    const n: Note = { id: crypto.randomUUID(), text: "", createdAt: now, updatedAt: now };
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

  text.addEventListener("input", () => {
    if (!current) return;
    current.text = text.value;
    changed();
  });

  // Enter en un check sigue la lista; Enter en un check vacío la termina.
  text.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      toggleCheckLines();
    } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.isComposing && text.selectionStart === text.selectionEnd) {
      const v = text.value;
      const from = v.lastIndexOf("\n", text.selectionStart - 1) + 1;
      const m = CHECK.exec(v.slice(from, text.selectionStart));
      if (!m) return;
      e.preventDefault();
      if (!m[3].trim()) text.setRangeText("", from, text.selectionStart, "end");
      else text.setRangeText(`\n${m[1]}[ ] `, text.selectionStart, text.selectionStart, "end");
      text.dispatchEvent(new Event("input"));
    }
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

  modeBtn.addEventListener("click", () => setMode(mode === "view" ? "edit" : "view"));
  checkBtn.addEventListener("click", toggleCheckLines);

  $<HTMLButtonElement>(".notes-new").addEventListener("click", create);
  $<HTMLButtonElement>(".notes-back").addEventListener("click", showList);
  $<HTMLButtonElement>(".notes-delete").addEventListener("click", () => current && void remove(current));
  aside.querySelectorAll(".notes-close").forEach((b) => b.addEventListener("click", () => panel.close()));
  aside.addEventListener("keydown", (e) => {
    if (current && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
      e.preventDefault();
      setMode(mode === "view" ? "edit" : "view");
    } else if (e.key === "Escape") {
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
          if (current) (mode === "view" ? rendered : text).focus();
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
  // Al salir de la app no se pierde lo último que se tipeó.
  window.addEventListener("beforeunload", flush);
  return panel;
}
