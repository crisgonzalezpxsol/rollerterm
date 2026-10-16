// Ejecuta Claude Code en modo -p para leer conectores de claude.ai (Google Calendar,
// Gmail) con la cuenta logueada. No hay credenciales de Google en la app.
//
// Para que cada consulta sea barata se usa Haiku, sin herramientas propias de Claude
// Code, y se bloquean todos los demás servidores MCP: si no, al usar una herramienta
// MCP se cargan las definiciones de todos los conectores (cientos de miles de tokens).
import { appendFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { ConnectorStatus } from "../shared/types";
import { exec, findCommand, type Command } from "./shell-env";

interface StreamMessage {
  type?: string;
  subtype?: string;
  mcp_servers?: { name: string; status: string }[];
  message?: {
    content?: { type: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string }[];
  };
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  permission_denials?: unknown[];
}

interface RunOutput {
  messages: StreamMessage[];
  stderr: string;
  /** Error del proceso (timeout, código de salida), si hubo. */
  exitError: string | null;
}

/**
 * Pausas entre reintentos cuando el conector no respondió. Lo típico es que estuviera
 * "pending" (todavía conectando): Claude arranca sin esperar a los conectores de claude.ai, y
 * si no llegaron a conectar, el modelo no tiene la herramienta.
 */
const RETRY_DELAYS_MS = [8_000, 20_000];
const LOG_MAX_BYTES = 1_000_000;

export interface QueryOptions {
  /** Servidor MCP a usar, tal como lo nombra Claude Code ("claude.ai Gmail"). */
  server: string;
  /** Herramientas permitidas; al menos una tiene que responder para que la consulta valga. */
  allow: string[];
  /** Herramientas de ese mismo servidor que se prohíben explícitamente (las que escriben). */
  deny: string[];
  prompt: string;
  schema: object;
  timeoutMs?: number;
}

export interface QueryResult<T> {
  status: ConnectorStatus;
  message: string | null;
  /** Detalle técnico para copiar y diagnosticar, cuando algo falló. */
  detail?: string;
  /** Solo presente si status === "connected". */
  output?: T;
}

export class ClaudeRunner {
  private claude: Command | null = null;
  /** Nombres de todos los servidores MCP de la cuenta, para bloquear los que no se usan. */
  private servers: string[] | null = null;
  private probing: Promise<void> | null = null;

  /** El comando `claude` (con el PATH de la terminal), o null si no está instalado. */
  async command(): Promise<Command | null> {
    this.claude ??= await findCommand("claude");
    return this.claude;
  }

  /** Nombres de todos los servidores MCP de la cuenta (se averiguan una vez). */
  async serverNames(): Promise<string[]> {
    if (!(await this.command())) return [];
    if (!this.servers) await (this.probing ??= this.probe().finally(() => (this.probing = null)));
    return this.servers ?? [];
  }

  /** Las consultas de fondo van en fila, una por vez (ver `query`). */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Consulta de fondo (agenda, correo, resúmenes). Van de a una: varias instancias de Claude
   * Code a la vez hacen que los conectores de claude.ai tarden más en conectar y queden
   * "pending" justo cuando el modelo los necesita. Solas conectan en ~3 s.
   */
  query<T>(opts: QueryOptions): Promise<QueryResult<T>> {
    const run = this.queue.then(() => this.queryNow<T>(opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async queryNow<T>(opts: QueryOptions): Promise<QueryResult<T>> {
    this.claude ??= await findCommand("claude");
    if (!this.claude) return { status: "no-claude", message: "No se encontró el comando `claude` (Claude Code)." };
    if (!this.servers) await (this.probing ??= this.probe().finally(() => (this.probing = null)));

    let res = await this.attempt<T>(opts);
    // Un conector que tropieza unos segundos no se marca como desconectado: se reintenta.
    for (const delay of RETRY_DELAYS_MS) {
      if (res.status !== "disconnected" && res.status !== "error") break;
      await new Promise((r) => setTimeout(r, delay));
      res = await this.attempt<T>(opts);
    }
    if (res.detail) void log(res.detail);
    return res;
  }

  private async attempt<T>(opts: QueryOptions): Promise<QueryResult<T>> {
    const label = opts.server.replace(/^claude\.ai /, "");
    const denied = (this.servers ?? []).filter((s) => s !== opts.server).map(mcpPrefix);
    let out: RunOutput;
    try {
      out = await this.run(opts.prompt, opts.timeoutMs ?? 120_000, [
        "--allowedTools", ...opts.allow,
        "--disallowedTools", ...opts.deny, ...denied,
        "--json-schema", JSON.stringify(opts.schema),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", message, detail: this.describe(opts, null, message) };
    }
    const { messages } = out;

    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    const result = messages.find((m) => m.type === "result");
    const server = init?.mcp_servers?.find((s) => s.name === opts.server);

    // Un resultado vacío solo vale si de verdad se llamó al conector y respondió sin error;
    // si no, "no hay nada" podría ser en realidad "no pude leerlo".
    const content = messages.flatMap((m) => m.message?.content ?? []);
    const callIds = new Set(content.filter((c) => c.type === "tool_use" && opts.allow.includes(c.name ?? "")).map((c) => c.id));
    const answered = content.some((c) => c.type === "tool_result" && callIds.has(c.tool_use_id) && !c.is_error);

    if (answered && result?.structured_output && !result.is_error) {
      return { status: "connected", message: null, output: result.structured_output as T };
    }
    const fail = (status: ConnectorStatus, message: string): QueryResult<T> => ({
      status,
      message,
      detail: this.describe(opts, out, message),
    });
    if (init && !server) return fail("not-configured", `Tu cuenta de Claude no tiene el conector de ${label}.`);
    if (server && server.status !== "connected" && server.status !== "pending") {
      return fail("disconnected", `El conector de ${label} está en estado "${server.status}".`);
    }
    if (!init) return fail("error", "Claude Code no arrancó la sesión (ver detalle).");
    if (result?.is_error) return fail("error", result.result || "Claude Code devolvió un error.");
    const toolError = content.find((c) => c.type === "tool_result" && callIds.has(c.tool_use_id) && c.is_error);
    if (toolError) return fail("disconnected", `El conector de ${label} devolvió un error: ${short(toolError.content, 200)}`);
    if (callIds.size === 0) return fail("disconnected", `Claude no llegó a usar el conector de ${label} (estado al arrancar: "${server?.status}").`);
    return fail("disconnected", `El conector de ${label} no respondió.`);
  }

  /** Texto técnico de una consulta fallida, para copiar y pegar al diagnosticar. */
  private describe(opts: QueryOptions, out: RunOutput | null, message: string): string {
    const lines = [
      `rollerterm · ${new Date().toISOString()} · ${opts.server}`,
      `motivo: ${message}`,
      `claude: ${this.claude?.bin ?? "?"}`,
      `permitidas: ${opts.allow.join(", ")}`,
    ];
    if (out) {
      const init = out.messages.find((m) => m.type === "system" && m.subtype === "init") as
        | (StreamMessage & { tools?: string[]; claude_code_version?: string; model?: string })
        | undefined;
      const result = out.messages.find((m) => m.type === "result");
      lines.push(
        `versión: ${init?.claude_code_version ?? "?"} · modelo: ${init?.model ?? "?"}`,
        `estado del conector al arrancar: ${init?.mcp_servers?.find((s) => s.name === opts.server)?.status ?? "(no figura)"}`,
        `herramientas permitidas disponibles: ${opts.allow.filter((t) => init?.tools?.includes(t)).join(", ") || "(ninguna)"}`,
      );
      for (const m of out.messages) {
        for (const c of m.message?.content ?? []) {
          if (c.type === "tool_use") lines.push(`→ llamó ${c.name}`);
          else if (c.type === "tool_result") lines.push(`← respuesta${c.is_error ? " (ERROR)" : ""}: ${short(c.content, 400)}`);
          else if (c.type === "text" && m.type === "assistant") lines.push(`texto: ${short(c.text, 300)}`);
        }
      }
      lines.push(
        `resultado: ${result ? `${result.subtype} · is_error=${result.is_error} · ${short(result.result, 400)}` : "(sin resultado)"}`,
        `permisos denegados: ${short(result?.permission_denials ?? [], 300)}`,
      );
      if (out.exitError) lines.push(`proceso: ${out.exitError}`);
      if (out.stderr.trim()) lines.push(`stderr: ${short(out.stderr.trim(), 800)}`);
    }
    return lines.join("\n");
  }

  /** Consulta mínima (sin herramientas) solo para conocer los servidores MCP de la cuenta. */
  private async probe(): Promise<void> {
    await this.run("Respondé ok.", 60_000, ["--max-turns", "1"]);
  }

  private async run(prompt: string, timeoutMs: number, extraArgs: string[]): Promise<RunOutput> {
    const { bin, env } = this.claude!;
    const args = [
      "-p",
      "--model", "haiku",
      "--tools", "",
      "--disable-slash-commands",
      "--system-prompt", "Sos un lector de datos. Seguí las instrucciones al pie de la letra.",
      "--output-format", "stream-json",
      "--verbose",
      ...extraArgs,
    ];
    // El prompt va por stdin: --allowedTools y --disallowedTools aceptan varios valores y se
    // comerían un argumento suelto.
    const { stdout, stderr, exitError } = await exec(bin, args, { env, cwd: app.getPath("userData"), input: prompt, timeoutMs });
    const messages = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as StreamMessage];
      } catch {
        return [];
      }
    });
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    if (init?.mcp_servers) this.servers = init.mcp_servers.map((s) => s.name);
    return { messages, stderr, exitError };
  }
}

/** Nombre de servidor MCP → prefijo de sus herramientas ("claude.ai Gmail" → "mcp__claude_ai_Gmail"). */
export function mcpPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Hora local sin offset ("2026-10-15T09:30:00"), como la piden las herramientas de Google. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function short(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Guarda los fallos en ~/Library/Application Support/rollerterm/claude.log (rota al pasar 1 MB). */
async function log(detail: string): Promise<void> {
  const file = join(app.getPath("userData"), "claude.log");
  try {
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    if (size > LOG_MAX_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${detail}\n\n`);
  } catch (err) {
    console.error("[claude.log]", err);
  }
}
