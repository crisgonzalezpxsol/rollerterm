// Notas del panel lateral, guardadas en notes.json dentro de los datos de la app.
import { app } from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Note } from "../shared/types";

const file = () => join(app.getPath("userData"), "notes.json");

export class NotesStore {
  private notes: Note[] | null = null;
  /** Las escrituras van en fila: dos guardados seguidos no se pisan a mitad de camino. */
  private writing: Promise<void> = Promise.resolve();

  async list(): Promise<Note[]> {
    if (!this.notes) {
      try {
        const parsed = JSON.parse(await readFile(file(), "utf8")) as Note[];
        this.notes = Array.isArray(parsed) ? parsed : [];
      } catch {
        // Primera vez o archivo corrupto: sin notas.
        this.notes = [];
      }
    }
    return [...this.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async save(note: Note): Promise<void> {
    await this.list();
    const i = this.notes!.findIndex((n) => n.id === note.id);
    if (i >= 0) this.notes![i] = note;
    else this.notes!.push(note);
    await this.persist();
  }

  /** Suma notas importadas: las que ya están se quedan con la versión más nueva. */
  async merge(incoming: Note[]): Promise<number> {
    await this.list();
    let changed = 0;
    for (const note of incoming) {
      const i = this.notes!.findIndex((n) => n.id === note.id);
      if (i < 0) this.notes!.push(note);
      else if (note.updatedAt > this.notes![i].updatedAt) this.notes![i] = note;
      else continue;
      changed++;
    }
    if (changed) await this.persist();
    return changed;
  }

  async delete(id: string): Promise<void> {
    await this.list();
    this.notes = this.notes!.filter((n) => n.id !== id);
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.notes, null, 2);
    // Escritura atómica: un cierre a mitad de camino no deja el JSON roto.
    this.writing = this.writing.then(async () => {
      await writeFile(`${file()}.tmp`, snapshot);
      await rename(`${file()}.tmp`, file());
    });
    return this.writing;
  }
}
