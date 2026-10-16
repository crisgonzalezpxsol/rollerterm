// Agenda: le pide a Claude Code (modo -p) los eventos de Google Calendar usando el
// conector de claude.ai de la cuenta logueada. No hay credenciales de Google en la app.
//
// Para que cada consulta sea barata (~US$0,005) se usa Haiku, sin herramientas
// propias de Claude Code, y se bloquean todos los demás servidores MCP: si no, al
// usar una herramienta MCP se cargan las definiciones de todos los conectores.
import { execFile } from "node:child_process";
import { app, powerMonitor } from "electron";
import type { CalendarEvent, CalendarState } from "../shared/types";

const SYNC_EVERY_MS = 10 * 60_000;
const WINDOW_HOURS = 24;
const CALENDAR_SERVER = "claude.ai Google Calendar";
const LIST_TOOL = "mcp__claude_ai_Google_Calendar__list_events";

const EVENTS_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 con offset" },
          end: { type: "string", description: "ISO 8601 con offset" },
          meetUrl: { type: ["string", "null"] },
          declined: { type: "boolean" },
        },
        required: ["id", "title", "start", "end", "meetUrl", "declined"],
      },
    },
  },
  required: ["events"],
};

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
  structured_output?: { events?: CalendarEvent[] };
}

export class CalendarSync {
  private state: CalendarState = { status: "loading", events: [], lastSync: null, message: null, syncing: false };
  private claude: { bin: string; env: NodeJS.ProcessEnv } | null = null;
  /** Nombres de todos los servidores MCP de la cuenta, para bloquear los que no son el calendario. */
  private servers: string[] | null = null;

  constructor(private onChange: (state: CalendarState) => void) {}

  get current(): CalendarState {
    return this.state;
  }

  start(): void {
    void this.sync();
    setInterval(() => void this.sync(), SYNC_EVERY_MS);
    powerMonitor.on("resume", () => void this.sync());
  }

  async sync(): Promise<void> {
    if (this.state.syncing) return;
    this.update({ syncing: true });
    try {
      this.claude ??= await findClaude();
      if (!this.claude) {
        this.update({ status: "no-claude", message: "No se encontró el comando `claude` (Claude Code)." });
        return;
      }
      if (!this.servers) await this.probe();
      this.applyResult(await this.run(buildPrompt(), ["--allowedTools", LIST_TOOL, "--json-schema", JSON.stringify(EVENTS_SCHEMA)]));
    } catch (err) {
      this.update({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ syncing: false });
    }
  }

  /** Consulta mínima (sin herramientas) solo para conocer los servidores MCP de la cuenta. */
  private async probe(): Promise<void> {
    await this.run("Respondé ok.", ["--max-turns", "1"]);
  }

  private async run(prompt: string, extraArgs: string[]): Promise<StreamMessage[]> {
    const { bin, env } = this.claude!;
    const denied = (this.servers ?? []).filter((s) => s !== CALENDAR_SERVER).map(mcpPrefix);
    const args = [
      "-p",
      "--model", "haiku",
      "--tools", "",
      "--disable-slash-commands",
      "--system-prompt", "Sos un lector de calendario. Seguí las instrucciones al pie de la letra.",
      "--output-format", "stream-json",
      "--verbose",
      ...extraArgs,
      ...(denied.length ? ["--disallowedTools", ...denied] : []),
    ];
    // El prompt va por stdin: --disallowedTools acepta varios valores y se comería un argumento suelto.
    const stdout = await exec(bin, args, { env, cwd: app.getPath("userData"), input: prompt, timeoutMs: 120_000 });
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

  private applyResult(messages: StreamMessage[]): void {
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    const result = messages.find((m) => m.type === "result");
    const server = init?.mcp_servers?.find((s) => s.name === CALENDAR_SERVER);

    // Una lista vacía solo vale si de verdad se llamó al calendario y respondió sin error;
    // si no, "no tenés reuniones" podría ser en realidad "no pude leer el calendario".
    const content = messages.flatMap((m) => m.message?.content ?? []);
    const callIds = new Set(content.filter((c) => c.type === "tool_use" && c.name === LIST_TOOL).map((c) => c.id));
    const calendarAnswered = content.some((c) => c.type === "tool_result" && callIds.has(c.tool_use_id) && !c.is_error);
    const events = result?.structured_output?.events;

    if (init && !server) {
      this.update({ status: "not-configured", message: "Tu cuenta de Claude no tiene el conector de Google Calendar." });
    } else if (calendarAnswered && events && !result?.is_error) {
      const valid = events
        .filter((e) => e.start.includes("T") && !Number.isNaN(Date.parse(e.start)))
        .map((e) => ({ ...e, title: e.title.trim() }));
      this.update({ status: "connected", events: valid, lastSync: Date.now(), message: null });
    } else if (server && server.status !== "connected" && server.status !== "pending") {
      this.update({ status: "disconnected", message: `El conector de Google Calendar está en estado "${server.status}".` });
    } else if (result?.is_error) {
      this.update({ status: "error", message: result.result || "Claude Code devolvió un error." });
    } else {
      this.update({ status: "disconnected", message: "El conector de Google Calendar no respondió." });
    }
  }

  private update(patch: Partial<CalendarState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

/** Nombre de servidor MCP → prefijo de sus herramientas ("claude.ai Gmail" → "mcp__claude_ai_Gmail"). */
function mcpPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function buildPrompt(): string {
  const now = new Date();
  const end = new Date(now.getTime() + WINDOW_HOURS * 3_600_000);
  return [
    `Llamá UNA sola vez a list_events con startTime="${localIso(now)}", endTime="${localIso(end)}",`,
    `orderBy="startTime", pageSize=50, eventType=["DEFAULT"]. No llames a ninguna otra herramienta.`,
    `Con el resultado devolvé los eventos con hora (ignorá los de día completo).`,
    `start y end en ISO 8601 con offset. meetUrl = link de videollamada (Meet, Zoom o Teams) o null.`,
    `declined = true si mi respuesta a la invitación es "declined".`,
  ].join(" ");
}

/** Hora local sin offset, como la pide list_events ("2026-10-15T09:30:00"). */
function localIso(d: Date): string {
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
