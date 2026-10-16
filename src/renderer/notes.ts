// Panel lateral de notas (📝 o ⌘⇧N): una lista y un editor de texto libre que se guarda solo.
// No ocupa lugar en la pantalla principal: se desliza encima desde la derecha.
import type { Note, RollertermApi } from "../shared/types";

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

function preview(n: Note): string {
  const lines = n.text.split("\n").filter((l) => l.trim());
  return lines.slice(1).join(" ").slice(0, 120);
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
        <button class="notes-delete" title="Borrar nota">Borrar</button>
        <button class="notes-close" title="Cerrar (Esc)">×</button>
      </header>
      <textarea class="notes-text" placeholder="Escribí… La primera línea es el título." spellcheck="true"></textarea>
    </div>`;
  document.body.append(aside);

  const $ = <T extends HTMLElement>(sel: string) => aside.querySelector(sel) as T;
  const listView = $<HTMLDivElement>(".notes-list-view");
  const editView = $<HTMLDivElement>(".notes-edit-view");
  const list = $<HTMLOListElement>(".notes-list");
  const text = $<HTMLTextAreaElement>(".notes-text");
  const saved = $<HTMLSpanElement>(".notes-saved");

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
      li.append(title, meta, prev);
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
    current.updatedAt = Date.now();
    saved.textContent = "Guardando…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!current) return;
      void api.saveNote(current).then(() => (saved.textContent = "Guardado"));
    }, SAVE_DELAY_MS);
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
        document.getElementById("toggle-notes")?.classList.add("on");
        void load().then(() => {
          if (current) text.focus();
          else $<HTMLButtonElement>(".notes-new").focus();
        });
      }
    },
    close() {
      if (!open) return;
      if (current) showList();
      open = false;
      aside.classList.remove("open");
      document.getElementById("toggle-notes")?.classList.remove("on");
      onClose();
    },
  };
  // Al salir de la app no se pierde lo último que se tipeó.
  window.addEventListener("beforeunload", flush);
  return panel;
}
