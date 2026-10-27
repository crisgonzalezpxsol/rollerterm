// Consumo de Claude Code en la barra de título: lee los logs que Claude Code deja en
// ~/.claude/projects/**/*.jsonl (cada respuesta trae su `usage`) y suma tokens y un costo
// estimado a precio de API. No llama a nada: solo lee archivos, y de a pedazos (lo nuevo).
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { powerMonitor } from "electron";
import type { UsageBlock, UsageRow, UsageState, UsageTotals } from "../shared/types";

const ROOT = join(homedir(), ".claude", "projects");
const CHECK_EVERY_MS = 60_000;
/** Se mira una semana; un día de margen para que el corte "7 días" no pierda nada. */
const KEEP_MS = 8 * 24 * 60 * 60_000;
/** Las ventanas de uso del plan duran 5 h desde el primer mensaje (redondeado a la hora). */
const BLOCK_MS = 5 * 60 * 60_000;

/** USD por millón de tokens. Escritura de caché: 1,25× (5 min) o 2× (1 h) del input. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

// El orden importa: gana el primer patrón que coincide (los más específicos arriba).
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-4-1|opus-4-0|opus-4-2025|claude-3-opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-3-5/, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
];

interface Entry {
  ts: number;
  model: string;
  project: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string;
}

function priceOf(model: string): Price | null {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null;
}

function costOf(model: string, u: RawUsage): number {
  const p = priceOf(model);
  if (!p) return 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : write;
  const usd =
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      write5m * p.input * 1.25 +
      write1h * p.input * 2 +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6;
  // El modo rápido cuesta el doble.
  return u.speed === "fast" ? usd * 2 : usd;
}

function emptyTotals(): UsageTotals {
  return { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
}

function add(t: UsageTotals, e: Entry): void {
  t.cost += e.cost;
  t.input += e.input;
  t.output += e.output;
  t.cacheWrite += e.cacheWrite;
  t.cacheRead += e.cacheRead;
  t.messages++;
}

/** "claude-opus-5-5" → "Opus 5.5". */
function modelLabel(model: string): string {
  const m = model.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

export class ClaudeUsage {
  private state: UsageState = {
    status: "loading",
    lastCheck: null,
    today: emptyTotals(),
    week: emptyTotals(),
    block: null,
    models: [],
    projects: [],
  };
  /** Hasta dónde se leyó cada archivo (bytes). */
  private offsets = new Map<string, number>();
  /** Una entrada por respuesta: Claude Code repite la misma respuesta en varias líneas. */
  private entries = new Map<string, Entry>();
  private checking = false;

  constructor(private onChange: (state: UsageState) => void) {}

  get current(): UsageState {
    return this.state;
  }

  start(): void {
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
    powerMonitor.on("resume", () => void this.check());
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const since = Date.now() - KEEP_MS;
      for (const file of await this.recentFiles(since)) await this.readNew(file.path, file.size);
      for (const [key, e] of this.entries) if (e.ts < since) this.entries.delete(key);
      this.state = this.summarize();
    } catch (err) {
      console.error("[claude-usage]", err);
      this.state = { ...this.state, status: "error", lastCheck: Date.now() };
    } finally {
      this.checking = false;
    }
    this.onChange(this.state);
  }

  /** Los .jsonl tocados en la última semana (incluye los de subagentes, en subcarpetas). */
  private async recentFiles(since: number): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    const walk = async (dir: string, depth: number) => {
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const path = join(dir, it.name);
        if (it.isDirectory()) {
          if (depth < 3 && it.name !== "memory") await walk(path, depth + 1);
        } else if (it.name.endsWith(".jsonl")) {
          const s = await stat(path).catch(() => null);
          if (s && s.mtimeMs >= since) out.push({ path, size: s.size });
        }
      }
    };
    await walk(ROOT, 0);
    return out;
  }

  /** Lee solo lo agregado desde la última vez (los logs crecen al final). */
  private async readNew(path: string, size: number): Promise<void> {
    let from = this.offsets.get(path) ?? 0;
    if (size < from) from = 0; // se reescribió
    if (size === from) return;
    let consumed = from;
    const rl = createInterface({ input: createReadStream(path, { start: from, end: size - 1 }), crlfDelay: Infinity });
    let pending = "";
    for await (const line of rl) {
      // Una línea a medio escribir se vuelve a leer en la próxima vuelta.
      if (pending) consumed += Buffer.byteLength(pending) + 1;
      pending = line;
      if (line.includes('"usage"')) this.parse(line);
    }
    // La última línea solo cuenta si ya terminó de escribirse (JSON completo).
    if (pending) {
      try {
        JSON.parse(pending);
        consumed += Buffer.byteLength(pending) + 1;
      } catch {
        /* incompleta */
      }
    }
    this.offsets.set(path, Math.min(consumed, size));
  }

  private parse(line: string): void {
    let d: {
      type?: string;
      timestamp?: string;
      cwd?: string;
      requestId?: string;
      message?: { id?: string; model?: string; usage?: RawUsage };
    };
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const msg = d.message;
    if (d.type !== "assistant" || !msg?.usage || !msg.model || msg.model.startsWith("<")) return;
    const ts = Date.parse(d.timestamp ?? "");
    if (!Number.isFinite(ts)) return;
    const u = msg.usage;
    const key = `${msg.id ?? ""}:${d.requestId ?? ts}`;
    this.entries.set(key, {
      ts,
      model: msg.model,
      // El asistente de la app corre Claude Code desde su carpeta de datos.
      project: !d.cwd ? "?" : d.cwd.includes("Application Support/rollerterm") ? "asistente de rollerterm" : basename(d.cwd),
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cost: costOf(msg.model, u),
    });
  }

  private summarize(): UsageState {
    const now = Date.now();
    const midnight = new Date().setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * 24 * 60 * 60_000;
    const today = emptyTotals();
    const week = emptyTotals();
    const models = new Map<string, UsageRow>();
    const projects = new Map<string, UsageRow>();
    const sorted = [...this.entries.values()].sort((a, b) => a.ts - b.ts);

    // Ventana de 5 h como las del plan: arranca a la hora en punto del primer mensaje y,
    // pasadas las 5 h, la próxima arranca con el siguiente mensaje.
    let block: UsageBlock | null = null;
    for (const e of sorted) {
      if (e.ts >= weekAgo) add(week, e);
      if (e.ts >= now - 2 * BLOCK_MS) {
        if (!block || e.ts >= block.end) {
          const start = new Date(e.ts).setMinutes(0, 0, 0);
          block = { start, end: start + BLOCK_MS, totals: emptyTotals() };
        }
        add(block.totals, e);
      }
      if (e.ts < midnight) continue;
      add(today, e);
      const label = modelLabel(e.model);
      const m = models.get(label) ?? { name: label, cost: 0, tokens: 0 };
      m.cost += e.cost;
      m.tokens += e.input + e.output + e.cacheWrite + e.cacheRead;
      models.set(label, m);
      const p = projects.get(e.project) ?? { name: e.project, cost: 0, tokens: 0 };
      p.cost += e.cost;
      p.tokens += e.input + e.output + e.cacheWrite + e.cacheRead;
      projects.set(e.project, p);
    }
    const byCost = (a: UsageRow, b: UsageRow) => b.cost - a.cost;
    return {
      status: "ok",
      lastCheck: now,
      today,
      week,
      block: block && block.end > now ? block : null,
      models: [...models.values()].sort(byCost),
      projects: [...projects.values()].sort(byCost).slice(0, 6),
    };
  }
}
