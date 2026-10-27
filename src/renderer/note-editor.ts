// Editor visual de las notas (TipTap): títulos, negrita, listas y tareas que se tildan ahí
// mismo, sin ver la sintaxis. Por dentro la nota se sigue guardando como Markdown, así el
// asistente, la búsqueda y el historial leen el mismo texto de siempre.
// Atajos al escribir: «## » título, «- » viñeta, «[ ] » tarea, «---» separador, **negrita**.
import { Editor, Extension } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export interface NoteEditorHooks {
  /** El usuario cambió algo: llega la nota en Markdown. */
  onChange(markdown: string): void;
  /** ⌘D: entrada de historial con fecha. */
  onEntry(): void;
  /** Cambió la selección o el contenido (para marcar los botones activos). */
  onState(): void;
}

/**
 * Las notas viejas se escribían a mano: «- []» (sin espacio) o «[] algo» al principio de la
 * línea también son tareas.
 */
export function normalizeLegacy(md: string): string {
  return md
    .replace(/^(\s*[-*+]\s+)\[\](?=\s|$)\s?/gm, "$1[ ] ")
    .replace(/^(\s*)\[( |x|X)?\]\s+(?=\S)/gm, (_m, indent: string, x?: string) => `${indent}- [${x && x !== " " ? "x" : " "}] `);
}

export function createNoteEditor(element: HTMLElement, hooks: NoteEditorHooks): Editor {
  const Shortcuts = Extension.create({
    name: "rollertermShortcuts",
    addKeyboardShortcuts() {
      return {
        "Mod-1": () => this.editor.commands.toggleHeading({ level: 1 }),
        "Mod-2": () => this.editor.commands.toggleHeading({ level: 2 }),
        "Mod-3": () => this.editor.commands.toggleHeading({ level: 3 }),
        "Mod-l": () => this.editor.commands.toggleTaskList(),
        "Mod-d": () => (hooks.onEntry(), true),
      };
    },
  });

  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: { openOnClick: true, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: ({ editor }) =>
          editor.isEmpty ? "Escribí… La primera línea es el título. Probá «## » para un subtítulo o «[ ] » para una tarea." : "",
      }),
      // breaks: un salto de línea simple es un salto de línea (así se escribían las notas a mano).
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      Shortcuts,
    ],
    editorProps: { attributes: { class: "notes-doc", spellcheck: "true" } },
    onUpdate: ({ editor }) => {
      hooks.onChange(editor.getMarkdown());
      hooks.onState();
    },
    onSelectionUpdate: () => hooks.onState(),
  });
}
