// Asistente de la jornada: un chat con Claude Code que recuerda.
//
// - Varias conversaciones. La «Jornada» usa una sesión de Claude por día: cada mensaje del día
//   continúa la misma conversación (--resume), así tiene todo el contexto de la jornada. Las
//   demás son hilos aparte con su propia sesión, y pueden responder a la vez que la Jornada.
// - Memoria de largo plazo en archivos, en su carpeta de trabajo: memoria.md (lo durable) y
//   diario/AAAA-MM-DD.md (lo de cada día). Claude los mantiene y los consulta solo.
// - Herramientas: las de rollerterm (notas, recordatorios, contexto de la app) por un MCP
//   propio, más Gmail, Google Calendar y tickets. Lo que tiene efecto afuera pasa por
//   --permission-prompt-tool y espera el OK del usuario en el chat.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { ApprovalRequest, ChatMessage, ChatStreamEvent, Conversation } from "../shared/types";
import type { Bridge } from "./bridge";
import { mcpPrefix, type ClaudeRunner } from "./claude-runner";

const HISTORY_LIMIT = 600;
/** La conversación de la jornada: siempre existe y no se borra. */
const DAILY_ID = "jornada";
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

const GMAIL = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const RT = "mcp__rollerterm__";

/** Se usan sin preguntar: leen, o escriben solo en lo propio del usuario (notas, borradores). */
const SAFE_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep",
  ...["crear_nota", "buscar_notas", "crear_recordatorio", "listar_recordatorios", "borrar_recordatorio", "contexto_actual"].map((t) => RT + t),
  ...["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "get_draft", "create_draft", "update_draft"].map((t) => GMAIL + t),
  ...["list_events", "get_event", "search_events", "list_calendars", "suggest_time"].map((t) => CAL + t),
];
const SAFE_TICKET_TOOLS = ["listar_tickets", "ver_ticket", "preguntar", "analizar_ticket"];

const KEPT_SERVERS = ["claude.ai Gmail", "claude.ai Google Calendar"];

/** Instrucciones que Claude Code carga solo desde la carpeta de trabajo. Las mantiene la app. */
const INSTRUCTIONS = `# Asistente de la jornada (rollerterm)

Sos el asistente de la jornada laboral del usuario, dentro de la app rollerterm. El usuario te
cuenta qué está haciendo durante el día y te pide cosas: recordar, anotar, buscar y responder
correos, mirar la agenda y los tickets. Respondé en español rioplatense, breve y al grano.

## Memoria

Esta carpeta es tu memoria de largo plazo; la conversación de cada día empieza de cero.

- \`memoria.md\`: lo durable — personas y su rol, proyectos, clientes, preferencias, compromisos
  que siguen abiertos. Leela al empezar cada jornada (primer mensaje del día).
- \`diario/AAAA-MM-DD.md\`: el diario de cada día — qué hizo, qué decidió, qué quedó pendiente.

Después de cada intercambio que deje algo para recordar, actualizá el diario de hoy (agregando,
sin reescribir lo anterior) y, si es algo durable, \`memoria.md\`. Hacelo en silencio: no
digas «registro en el diario» ni nada parecido, el usuario no necesita enterarse.
Cuando pregunten por otro día o por algo pasado («¿qué hablé con René la semana pasada?»),
buscá en \`diario/\` con Grep y Read antes de responder. No inventes: si no está, decilo.

## Herramientas

- \`contexto_actual\` (rollerterm): lo que la app ya muestra — agenda, correos, tickets,
  producción. Usala primero para «¿qué tengo hoy?», «¿algo urgente?».
- \`crear_nota\`, \`buscar_notas\`: las notas del panel de notas.
- \`crear_recordatorio\`: para «recordame…». Hora local, ISO 8601. Confirmá la hora en la respuesta.
- Gmail, Google Calendar y tickets de Pxsol Agencias: para buscar, leer y resumir.

## Acciones con efecto afuera

Enviar o responder correos, crear o cambiar eventos, comentar o cambiar tickets: la app le
muestra al usuario lo que vas a hacer y espera su aprobación. Antes de pedirlo, mostrá en tu
respuesta el texto final (destinatario, asunto, cuerpo). Si el usuario no pidió enviar,
preferí crear un borrador. Si rechaza, no insistas: preguntá qué cambiar.
`;

function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Nombre corto para mostrar qué herramienta está usando ("📧 Buscando correos"). */
function toolLabel(name: string): string {
  const t = name.split("__").pop() ?? name;
  if (name.startsWith(GMAIL)) return `📧 Gmail · ${t}`;
  if (name.startsWith(CAL)) return `📅 Calendario · ${t}`;
  if (name.startsWith(RT)) {
    const map: Record<string, string> = {
      crear_nota: "📝 Creando nota",
      buscar_notas: "📝 Buscando notas",
      crear_recordatorio: "⏰ Programando recordatorio",
      listar_recordatorios: "⏰ Viendo recordatorios",
      borrar_recordatorio: "⏰ Cancelando recordatorio",
      contexto_actual: "👀 Mirando la app",
    };
    return map[t] ?? `rollerterm · ${t}`;
  }
  if (name.startsWith("mcp__")) return `🎫 Tickets · ${t}`;
  if (["Read", "Grep", "Glob"].includes(name)) return "🧠 Consultando memoria";
  if (["Write", "Edit"].includes(name)) return "🧠 Guardando en memoria";
  return name;
}

/** Descripción legible de una acción que necesita aprobación. */
function describe(tool: string, input: Record<string, unknown>): string {
  const used = new Set<string>();
  const get = (...keys: string[]) => {
    const k = keys.find((x) => input[x] !== undefined && input[x] !== "");
    if (k) used.add(k);
    return k ? input[k] : undefined;
  };
  const show = (v: unknown): string => (Array.isArray(v) ? v.map(show).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));
  const lines = [toolLabel(tool)];
  const to = get("to", "toRecipients", "recipients", "attendees");
  const cc = get("cc", "ccRecipients");
  const subject = get("subject", "summary", "title", "asunto");
  const start = get("startTime", "start", "inicio");
  const end = get("endTime", "end", "fin");
  const where = get("location", "lugar");
  const ticket = get("ticket", "numero");
  const state = get("estado", "status");
  const body = get("body", "plaintextBody", "text", "description", "comentario", "mensaje", "texto");
  if (to) lines.push(`Para: ${show(to)}`);
  if (cc) lines.push(`CC: ${show(cc)}`);
  if (ticket) lines.push(`Ticket: #${show(ticket).replace(/^#/, "")}`);
  if (subject) lines.push(`Asunto: ${show(subject)}`);
  const when = (v: unknown) => {
    const ms = Date.parse(show(v));
    return Number.isNaN(ms)
      ? show(v)
      : new Date(ms).toLocaleString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  };
  if (start) lines.push(`Cuándo: ${when(start)}${end ? ` → ${when(end)}` : ""}`);
  if (where) lines.push(`Dónde: ${show(where)}`);
  if (state) lines.push(`Estado nuevo: ${show(state)}`);
  // Lo demás que sea corto también se muestra: mejor de más que una sorpresa.
  for (const [k, v] of Object.entries(input)) {
    if (used.has(k) || v === undefined || v === "" || v === null) continue;
    const text = show(v);
    if (text.length <= 120) lines.push(`${k}: ${text}`);
  }
  if (body) lines.push("", show(body).slice(0, 2000));
  return lines.join("\n");
}

/** Lo que se guarda de cada conversación (sin el estado en vivo). */
interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  daily: boolean;
  /** Sesión de Claude de un hilo aparte (la Jornada usa una por día, en sesiones.json). */
  sessionId?: string;
  /** Ya tuvo una respuesta: los mensajes siguientes van con --resume. */
  started?: boolean;
}

type Emit = ChatStreamEvent extends infer E ? (E extends { convId: string } ? Omit<E, "convId"> : never) : never;

export class Assistant {
  readonly dir = join(app.getPath("userData"), "asistente");
  private convs: StoredConversation[] = [];
  private histories = new Map<string, ChatMessage[]>();
  private sessions: Record<string, string> = {};
  private children = new Map<string, ChildProcess>();
  private approvals = new Map<string, { conv: string; resolve: (approved: boolean) => void }>();

  constructor(
    private claude: ClaudeRunner,
    private bridge: Bridge,
    private opts: {
      model: () => string;
      ticketServer: () => Promise<string | null>;
      emit: (event: ChatStreamEvent) => void;
    },
  ) {}

  private emit(convId: string, event: Emit): void {
    this.opts.emit({ convId, ...event } as ChatStreamEvent);
  }

  private get convDir(): string {
    return join(this.dir, "conversaciones");
  }

  private file(convId: string): string {
    // La Jornada sigue en chat.jsonl (así no se mueve el historial que ya había).
    return convId === DAILY_ID ? join(this.dir, "chat.jsonl") : join(this.convDir, `${convId}.jsonl`);
  }

  async start(): Promise<void> {
    await mkdir(join(this.dir, "diario"), { recursive: true });
    await mkdir(this.convDir, { recursive: true });
    await writeFile(join(this.dir, "CLAUDE.md"), INSTRUCTIONS);
    // El MCP de rollerterm va como servidor del proyecto (.mcp.json en la carpeta) y no con
    // --mcp-config: con esa opción Claude Code espera a que conecten TODOS los servidores de la
    // cuenta antes de responder (~20 s); así arranca en ~3 s y los demás conectan cuando hacen falta.
    await writeFile(
      join(this.dir, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            rollerterm: {
              command: process.execPath,
              args: [join(__dirname, "rollerterm-mcp.cjs")],
              // Electron hace de Node (no hace falta tener node instalado); el puerto y el token
              // del puente cambian en cada arranque y llegan por el entorno de Claude Code.
              env: { ELECTRON_RUN_AS_NODE: "1", RT_BRIDGE: "${RT_BRIDGE}", RT_TOKEN: "${RT_TOKEN}", RT_CONV: "${RT_CONV}" },
            },
          },
        },
        null,
        2,
      ),
    );
    await mkdir(join(this.dir, ".claude"), { recursive: true });
    await writeFile(join(this.dir, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["rollerterm"] }, null, 2));
    if (!existsSync(join(this.dir, "memoria.md"))) {
      await writeFile(join(this.dir, "memoria.md"), "# Memoria\n\nLo que conviene recordar siempre.\n");
    }
    try {
      this.convs = JSON.parse(await readFile(join(this.dir, "conversaciones.json"), "utf8"));
    } catch {
      this.convs = [];
    }
    if (!this.convs.some((c) => c.id === DAILY_ID)) {
      const now = Date.now();
      this.convs.unshift({ id: DAILY_ID, title: "Jornada", createdAt: now, updatedAt: now, daily: true });
      await this.saveIndex();
    }
    try {
      this.sessions = JSON.parse(await readFile(join(this.dir, "sesiones.json"), "utf8"));
    } catch {
      this.sessions = {};
    }
    this.bridge.on("aprobar", (args, ctx) => this.requestApproval(args, ctx.conv ?? DAILY_ID));
  }

  list(): Conversation[] {
    return this.convs.map(({ id, title, createdAt, updatedAt, daily }) => ({ id, title, createdAt, updatedAt, daily, busy: this.children.has(id) }));
  }

  private changed(): void {
    this.emit(DAILY_ID, { type: "conversations", list: this.list() });
  }

  async history(convId: string): Promise<ChatMessage[]> {
    const cached = this.histories.get(convId);
    if (cached) return cached;
    let messages: ChatMessage[] = [];
    try {
      messages = (await readFile(this.file(convId), "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as ChatMessage];
          } catch {
            return [];
          }
        })
        .slice(-HISTORY_LIMIT);
    } catch {
      // conversación nueva: sin historial
    }
    this.histories.set(convId, messages);
    return messages;
  }

  async create(): Promise<Conversation> {
    const now = Date.now();
    const conv: StoredConversation = { id: randomUUID(), title: "Conversación nueva", createdAt: now, updatedAt: now, daily: false, sessionId: randomUUID() };
    this.convs.push(conv);
    this.histories.set(conv.id, []);
    await this.saveIndex();
    this.changed();
    return this.list().find((c) => c.id === conv.id)!;
  }

  async rename(convId: string, title: string): Promise<void> {
    const conv = this.convs.find((c) => c.id === convId);
    if (!conv || !title.trim()) return;
    conv.title = title.trim().slice(0, 80);
    await this.saveIndex();
    this.changed();
  }

  async remove(convId: string): Promise<void> {
    if (convId === DAILY_ID) throw new Error("La conversación de la jornada no se borra.");
    this.stop(convId);
    this.convs = this.convs.filter((c) => c.id !== convId);
    this.histories.delete(convId);
    await rm(this.file(convId), { force: true });
    await this.saveIndex();
    this.changed();
  }

  /** Un mensaje que no es de la conversación (un recordatorio que sonó, por ejemplo). Va a la Jornada. */
  async addEvent(text: string): Promise<void> {
    const message: ChatMessage = { id: randomUUID(), role: "event", text, at: Date.now() };
    await this.append(DAILY_ID, message);
    this.emit(DAILY_ID, { type: "event", message });
  }

  stop(convId: string): void {
    this.children.get(convId)?.kill();
    for (const [id, a] of this.approvals) {
      if (a.conv !== convId) continue;
      a.resolve(false);
      this.approvals.delete(id);
    }
  }

  approve(id: string, approved: boolean): void {
    const a = this.approvals.get(id);
    if (!a) return;
    a.resolve(approved);
    this.approvals.delete(id);
    this.emit(a.conv, { type: "approval-done", id, approved });
  }

  async send(convId: string, text: string): Promise<void> {
    const conv = this.convs.find((c) => c.id === convId);
    if (!conv) throw new Error("Esa conversación ya no existe.");
    if (this.children.has(convId)) throw new Error("Esperá a que termine la respuesta anterior.");
    const user: ChatMessage = { id: randomUUID(), role: "user", text, at: Date.now() };
    await this.history(convId);
    await this.append(convId, user);
    // El primer mensaje le pone nombre a un hilo nuevo.
    if (!conv.daily && conv.title === "Conversación nueva") conv.title = text.replace(/\s+/g, " ").trim().slice(0, 48);
    conv.updatedAt = Date.now();
    void this.saveIndex();

    let reply: { message: ChatMessage; missingSession: boolean };
    if (conv.daily) {
      const day = dayKey();
      const resume = this.sessions[day];
      reply = await this.run(convId, text, resume ?? randomUUID(), Boolean(resume));
      // Si la sesión del día ya no existe (se borró la caché de Claude Code), se empieza otra.
      if (reply.missingSession) reply = await this.run(convId, text, randomUUID(), false);
    } else {
      conv.sessionId ??= randomUUID();
      reply = await this.run(convId, text, conv.sessionId, Boolean(conv.started));
      if (reply.missingSession) {
        conv.sessionId = randomUUID();
        reply = await this.run(convId, text, conv.sessionId, false);
      }
      conv.started = true;
      void this.saveIndex();
    }
    await this.append(convId, reply.message);
    this.emit(convId, { type: "done", message: reply.message });
  }

  private async run(
    convId: string,
    text: string,
    sessionId: string,
    resume: boolean,
  ): Promise<{ message: ChatMessage; missingSession: boolean }> {
    const messageId = randomUUID();
    this.emit(convId, { type: "start", messageId });
    const fail = (t: string): { message: ChatMessage; missingSession: boolean } => ({
      message: { id: messageId, role: "assistant", text: t, at: Date.now(), error: true },
      missingSession: false,
    });

    const cmd = await this.claude.command();
    if (!cmd) return fail("No encontré Claude Code (`claude`). Instalalo y logueate (ver README).");

    // Solo los servidores que el asistente usa: cargar todos cuesta cientos de miles de tokens.
    const ticketServer = await this.opts.ticketServer();
    const keep = new Set([...KEPT_SERVERS, ...(ticketServer ? [ticketServer] : [])]);
    const denied = (await this.claude.serverNames()).filter((s) => !keep.has(s)).map(mcpPrefix);
    const ticketTools = ticketServer ? SAFE_TICKET_TOOLS.map((t) => `${mcpPrefix(ticketServer)}__${t}`) : [];

    const now = new Date();
    const args = [
      "-p",
      "--model", this.opts.model(),
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
      "--append-system-prompt",
      `Ahora es ${now.toLocaleString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} (hora local, ${dayKey(now)}).`,
      "--permission-mode", "acceptEdits",
      "--permission-prompt-tool", `${RT}aprobar`,
      "--tools", "Read,Write,Edit,Glob,Grep",
      "--disable-slash-commands",
      "--allowedTools", ...SAFE_TOOLS, ...ticketTools,
      "--disallowedTools", ...denied,
    ];

    return new Promise((resolve) => {
      const env = { ...cmd.env, RT_BRIDGE: this.bridge.url, RT_TOKEN: this.bridge.token, RT_CONV: convId };
      const child = spawn(cmd.bin, args, { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      this.children.set(convId, child);
      this.changed();
      // El prompt va por stdin: --allowedTools y --disallowedTools se comerían un argumento suelto.
      child.stdin.end(text);

      let full = "";
      let needsBreak = false;
      const tools: string[] = [];
      let resultText: string | null = null;
      let isError = false;
      let stderr = "";
      let buffer = "";
      const timer = setTimeout(() => child.kill(), RESPONSE_TIMEOUT_MS);

      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.stdout.on("data", (d: Buffer) => {
        buffer += d.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let m: {
            type?: string;
            event?: { type?: string; delta?: { type?: string; text?: string } };
            message?: { content?: { type: string; name?: string }[] };
            result?: string;
            is_error?: boolean;
          };
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.type === "stream_event") {
            // Un turno nuevo del modelo (después de usar una herramienta): párrafo aparte.
            if (m.event?.type === "message_start" && full) needsBreak = true;
            if (m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta" && m.event.delta.text) {
              const delta = (needsBreak ? "\n\n" : "") + m.event.delta.text;
              needsBreak = false;
              full += delta;
              this.emit(convId, { type: "text", messageId, delta });
            }
          } else if (m.type === "assistant") {
            for (const c of m.message?.content ?? []) {
              if (c.type === "tool_use" && c.name) {
                const label = toolLabel(c.name);
                if (!tools.includes(label)) tools.push(label);
                this.emit(convId, { type: "tool", messageId, label });
              }
            }
          } else if (m.type === "result") {
            resultText = m.result ?? null;
            isError = Boolean(m.is_error);
          }
        }
      });

      child.on("close", () => {
        clearTimeout(timer);
        this.children.delete(convId);
        this.changed();
        const missing = resume && /no conversation found|session.*not found/i.test(stderr + (resultText ?? ""));
        if (missing) return resolve({ ...fail(""), missingSession: true });
        // La sesión existe desde que Claude arrancó; si no, el próximo --resume cae en "missing" y se rehace.
        if (this.convs.find((c) => c.id === convId)?.daily) void this.saveSession(dayKey(), sessionId);
        const textOut = full.trim() || resultText?.trim() || "";
        if (!textOut) {
          const why = isError ? resultText : stderr.trim().split("\n").slice(-3).join(" ");
          return resolve(fail(why ? `No pude responder: ${why}` : "La respuesta se cortó."));
        }
        resolve({
          message: { id: messageId, role: "assistant", text: textOut, at: Date.now(), tools, error: isError || undefined },
          missingSession: false,
        });
      });
    });
  }

  private async requestApproval(args: Record<string, unknown>, conv: string): Promise<unknown> {
    const tool = String(args.tool_name ?? "");
    const input = (args.input ?? {}) as Record<string, unknown>;
    const request: ApprovalRequest = { id: randomUUID(), tool, summary: describe(tool, input), input };
    const approved = await new Promise<boolean>((resolve) => {
      this.approvals.set(request.id, { conv, resolve });
      this.emit(conv, { type: "approval", request });
    });
    const message: ChatMessage = { id: randomUUID(), role: "event", text: `${approved ? "✅ Aprobado" : "🚫 Rechazado"}: ${request.summary.split("\n")[0]}`, at: Date.now() };
    await this.append(conv, message);
    this.emit(conv, { type: "event", message });
    return approved
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "El usuario no lo aprobó. No lo vuelvas a intentar; preguntale qué cambiar." };
  }

  private async saveSession(day: string, id: string): Promise<void> {
    if (this.sessions[day] === id) return;
    this.sessions[day] = id;
    await writeFile(join(this.dir, "sesiones.json"), JSON.stringify(this.sessions, null, 2));
  }

  private async append(convId: string, message: ChatMessage): Promise<void> {
    if (message.role === "assistant" && !message.text) return;
    const history = await this.history(convId);
    this.histories.set(convId, [...history, message].slice(-HISTORY_LIMIT));
    await appendFile(this.file(convId), `${JSON.stringify(message)}\n`);
  }

  private async saveIndex(): Promise<void> {
    await writeFile(join(this.dir, "conversaciones.json"), JSON.stringify(this.convs, null, 2));
  }
}
