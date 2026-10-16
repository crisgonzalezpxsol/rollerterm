// Ejecuta Claude Code en modo -p para leer conectores de claude.ai (Google Calendar,
// Gmail) con la cuenta logueada. No hay credenciales de Google en la app.
//
// Para que cada consulta sea barata se usa Haiku, sin herramientas propias de Claude
// Code, y se bloquean todos los demás servidores MCP: si no, al usar una herramienta
// MCP se cargan las definiciones de todos los conectores (cientos de miles de tokens).
import { execFile } from "node:child_process";
import { app } from "electron";
import type { ConnectorStatus } from "../shared/types";

// Variables que Claude Code pone en sus procesos hijos: si la app se lanzó desde una
// sesión de Claude Code, el CLI creería que corre anidado.
const INHERITED_CLAUDE_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
];

interface StreamMessage {
  type?: string;
  subtype?: string;
  mcp_servers?: { name: string; status: string }[];
  message?: { content?: { type: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }[] };
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

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
  /** Solo presente si status === "connected". */
  output?: T;
}

export class ClaudeRunner {
  private claude: { bin: string; env: NodeJS.ProcessEnv } | null = null;
  /** Nombres de todos los servidores MCP de la cuenta, para bloquear los que no se usan. */
  private servers: string[] | null = null;
  private probing: Promise<void> | null = null;

  async query<T>(opts: QueryOptions): Promise<QueryResult<T>> {
    const label = opts.server.replace(/^claude\.ai /, "");
    this.claude ??= await findClaude();
    if (!this.claude) return { status: "no-claude", message: "No se encontró el comando `claude` (Claude Code)." };
    if (!this.servers) await (this.probing ??= this.probe().finally(() => (this.probing = null)));

    const denied = (this.servers ?? []).filter((s) => s !== opts.server).map(mcpPrefix);
    const messages = await this.run(opts.prompt, opts.timeoutMs ?? 120_000, [
      "--allowedTools", ...opts.allow,
      "--disallowedTools", ...opts.deny, ...denied,
      "--json-schema", JSON.stringify(opts.schema),
    ]);

    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    const result = messages.find((m) => m.type === "result");
    const server = init?.mcp_servers?.find((s) => s.name === opts.server);

    // Un resultado vacío solo vale si de verdad se llamó al conector y respondió sin error;
    // si no, "no hay nada" podría ser en realidad "no pude leerlo".
    const content = messages.flatMap((m) => m.message?.content ?? []);
    const callIds = new Set(content.filter((c) => c.type === "tool_use" && opts.allow.includes(c.name ?? "")).map((c) => c.id));
    const answered = content.some((c) => c.type === "tool_result" && callIds.has(c.tool_use_id) && !c.is_error);

    if (init && !server) return { status: "not-configured", message: `Tu cuenta de Claude no tiene el conector de ${label}.` };
    if (answered && result?.structured_output && !result.is_error) {
      return { status: "connected", message: null, output: result.structured_output as T };
    }
    if (server && server.status !== "connected" && server.status !== "pending") {
      return { status: "disconnected", message: `El conector de ${label} está en estado "${server.status}".` };
    }
    if (result?.is_error) return { status: "error", message: result.result || "Claude Code devolvió un error." };
    return { status: "disconnected", message: `El conector de ${label} no respondió.` };
  }

  /** Consulta mínima (sin herramientas) solo para conocer los servidores MCP de la cuenta. */
  private async probe(): Promise<void> {
    await this.run("Respondé ok.", 60_000, ["--max-turns", "1"]);
  }

  private async run(prompt: string, timeoutMs: number, extraArgs: string[]): Promise<StreamMessage[]> {
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
    const stdout = await exec(bin, args, { env, cwd: app.getPath("userData"), input: prompt, timeoutMs });
    const messages = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as StreamMessage];
      } catch {
        return [];
      }
    });
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    if (init?.mcp_servers) this.servers = init.mcp_servers.map((s) => s.name);
    return messages;
  }
}

/** Nombre de servidor MCP → prefijo de sus herramientas ("claude.ai Gmail" → "mcp__claude_ai_Gmail"). */
function mcpPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Hora local sin offset ("2026-10-15T09:30:00"), como la piden las herramientas de Google. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Busca `claude` con el PATH de una shell interactiva: abierta desde el Finder, la app
 * no hereda el PATH de la terminal y ~/.local/bin suele agregarse en ~/.zshrc.
 */
async function findClaude(): Promise<{ bin: string; env: NodeJS.ProcessEnv } | null> {
  const env = { ...process.env };
  for (const name of INHERITED_CLAUDE_VARS) delete env[name];
  const shell = process.env.SHELL || "/bin/zsh";
  const out = await exec(shell, ["-ilc", 'printf "__RT__%s__RT__%s__RT__" "$PATH" "$(command -v claude)"'], {
    env,
    timeoutMs: 15_000,
  }).catch(() => "");
  const [, path, bin] = out.match(/__RT__(.*)__RT__(.*)__RT__/s) ?? [];
  if (path) env.PATH = path;
  return bin ? { bin, env } : null;
}

function exec(
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Claude Code puede salir con código ≠ 0 y aun así haber escrito el resultado.
        if (err && !stdout) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}
