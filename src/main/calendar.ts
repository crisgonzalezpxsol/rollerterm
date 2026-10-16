// Agenda: eventos de Google Calendar de las próximas 24 h, leídos vía Claude Code.
import { powerMonitor } from "electron";
import type { CalendarEvent, CalendarState } from "../shared/types";
import { localIso, type ClaudeRunner } from "./claude-runner";

const SYNC_EVERY_MS = 10 * 60_000;
const WINDOW_HOURS = 24;
const SERVER = "claude.ai Google Calendar";
const TOOL = "mcp__claude_ai_Google_Calendar__";
const READ_TOOLS = [`${TOOL}list_events`];
const WRITE_TOOLS = ["create_event", "update_event", "delete_event", "respond_to_event"].map((t) => TOOL + t);

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

export class CalendarSync {
  private state: CalendarState = { status: "loading", events: [], lastSync: null, message: null, detail: null, syncing: false };

  constructor(
    private claude: ClaudeRunner,
    private onChange: (state: CalendarState) => void,
  ) {}

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
      const res = await this.claude.query<{ events: CalendarEvent[] }>({
        server: SERVER,
        allow: READ_TOOLS,
        deny: WRITE_TOOLS,
        prompt: buildPrompt(),
        schema: EVENTS_SCHEMA,
      });
      if (res.output) {
        // Los eventos que ya se conocían se conservan si una sincronización falla.
        // Si esta vez el modelo no extrajo el link de un evento que ya lo tenía, se conserva el
        // anterior: sin link, esa llamada no avisaría.
        const knownLinks = new Map(this.state.events.map((e) => [e.id, e.meetUrl]));
        const events = res.output.events
          .filter((e) => e.start.includes("T") && !Number.isNaN(Date.parse(e.start)))
          .map((e) => ({ ...e, title: e.title.trim(), meetUrl: e.meetUrl || knownLinks.get(e.id) || null }));
        this.update({ status: res.status, message: null, detail: null, events, lastSync: Date.now() });
      } else {
        this.update({ status: res.status, message: res.message, detail: res.detail ?? null });
      }
    } catch (err) {
      this.update({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ syncing: false });
    }
  }

  private update(patch: Partial<CalendarState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

function buildPrompt(): string {
  const now = new Date();
  const end = new Date(now.getTime() + WINDOW_HOURS * 3_600_000);
  return [
    `Llamá UNA sola vez a list_events con startTime="${localIso(now)}", endTime="${localIso(end)}",`,
    `orderBy="startTime", pageSize=50, eventType=["DEFAULT"]. No llames a ninguna otra herramienta.`,
    `Con el resultado devolvé los eventos con hora (ignorá los de día completo).`,
    `start y end en ISO 8601 con offset.`,
    `meetUrl: el link de videollamada. Tomalo de hangoutLink; si no está, de conferenceData.entryPoints`,
    `(el de entryPointType "video"); si no, de un link de meet.google.com, zoom.us o teams.microsoft.com`,
    `que aparezca en location o description. Solo null si no hay ninguno.`,
    `declined = true si mi respuesta a la invitación es "declined".`,
  ].join(" ");
}
