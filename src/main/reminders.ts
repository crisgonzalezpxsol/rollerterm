// Recordatorios que programa el asistente: se guardan en reminders.json y, a la hora, la
// app avisa (notificación + mensaje en el chat).
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { Reminder } from "../shared/types";

const file = () => join(app.getPath("userData"), "reminders.json");

export class Reminders {
  private list: Reminder[] = [];

  constructor(private onFire: (r: Reminder) => void) {}

  async start(): Promise<void> {
    try {
      this.list = JSON.parse(await readFile(file(), "utf8")) as Reminder[];
    } catch {
      this.list = [];
    }
    // Cada 15 s alcanza: un recordatorio no necesita precisión de segundos.
    setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  pending(): Reminder[] {
    return this.list.filter((r) => !r.done).sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
  }

  async add(when: string, text: string): Promise<Reminder> {
    const ms = Date.parse(when);
    if (Number.isNaN(ms)) throw new Error(`Fecha inválida: ${when}`);
    const r: Reminder = { id: randomUUID().slice(0, 8), when: new Date(ms).toISOString(), text, done: false };
    this.list.push(r);
    await this.save();
    return r;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.list.length;
    this.list = this.list.filter((r) => r.id !== id);
    await this.save();
    return this.list.length < before;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = this.list.filter((r) => !r.done && Date.parse(r.when) <= now);
    if (!due.length) return;
    for (const r of due) {
      r.done = true;
      this.onFire(r);
    }
    // Los ya avisados se guardan un tiempo (para "¿qué me recordaste ayer?") y después se limpian.
    const weekAgo = now - 7 * 86_400_000;
    this.list = this.list.filter((r) => !r.done || Date.parse(r.when) > weekAgo);
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFile(`${file()}.tmp`, JSON.stringify(this.list, null, 2));
    await rename(`${file()}.tmp`, file());
  }
}
