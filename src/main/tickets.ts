// Tickets de Pxsol Agencias: se leen y se gestionan con el MCP de tickets que ya usa Claude
// Code, lanzándolo directo (no pasa por Claude). La lista se refresca sola; el detalle, los
// comentarios y los cambios de estado o dueño se piden al abrir un ticket.
import { powerMonitor } from "electron";
import type { Ticket, TicketAction, TicketDetail, TicketsSettings, TicketsState, TicketStatus, TicketView } from "../shared/types";
import { listMcpServers, withMcp, type McpServerConfig } from "./mcp-client";

const CHECK_EVERY_MS = 3 * 60_000;
const OPEN_STATUSES: TicketStatus[] = ["OPEN", "IN_PROGRESS", "WAITING"];
const LIMIT = 50;

type Listed = Omit<Ticket, "mine">;

/** El servidor elegido o, si no hay elección, el primero que parezca de tickets. */
export async function resolveServer(cfg: TicketsSettings): Promise<McpServerConfig | null> {
  const servers = await listMcpServers();
  if (cfg.server) return servers.find((s) => s.name === cfg.server) ?? null;
  return servers.find((s) => /ticket|arturito/i.test(s.name) || s.args.some((a) => /mcp-tickets/.test(a))) ?? null;
}

/** "https://testing.pxsolagencias.com" → "testing"; "app." o sin subdominio → "producción". */
function environmentOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const sub = host.split(".")[0];
    return host.split(".").length > 2 && sub !== "app" && sub !== "www" ? sub : "producción";
  } catch {
    return null;
  }
}

export class TicketsMonitor {
  private state: TicketsState = {
    status: "loading",
    message: null,
    checking: false,
    lastCheck: null,
    tickets: [],
    webUrl: null,
    environment: null,
  };

  constructor(
    private settings: () => TicketsSettings,
    private onChange: (state: TicketsState) => void,
  ) {}

  get current(): TicketsState {
    return this.state;
  }

  start(): void {
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
    powerMonitor.on("resume", () => void this.check());
  }

  async check(): Promise<void> {
    if (this.state.checking) return;
    const cfg = this.settings();
    if (!cfg.enabled) {
      this.update({ status: "disabled", message: null, tickets: [] });
      return;
    }
    this.update({ checking: true });
    try {
      const server = await resolveServer(cfg);
      if (!server) {
        this.update({
          status: "not-configured",
          message: cfg.server
            ? `No está el servidor MCP «${cfg.server}» en Claude Code.`
            : "No se encontró un servidor MCP de tickets en Claude Code.",
        });
        return;
      }
      const webUrl = server.env.AGENCIAS_WEB_URL?.replace(/\/$/, "") || null;
      const me = server.env.TICKETS_ACTOR_EMAIL || null;

      const { tickets, mineIds, cut } = await withMcp(server, async (call) => {
        // Una llamada por estado: la herramienta filtra por uno solo y el total de cerrados es enorme.
        const byStatus = await Promise.all(
          OPEN_STATUSES.map(
            (status) => call("listar_tickets", { status, limit: LIMIT }) as Promise<{ total: number; tickets: Listed[] }>,
          ),
        );
        // Los míos también por estado: sin filtrar, los cerrados taparían a los abiertos en el límite.
        const mine = me
          ? await Promise.all(
              OPEN_STATUSES.map(
                (status) => call("listar_tickets", { status, assignee: me, limit: LIMIT }) as Promise<{ tickets: Listed[] }>,
              ),
            )
          : [];
        const cut = byStatus.reduce((n, r) => n + Math.max(0, (r.total ?? 0) - r.tickets.length), 0);
        return {
          cut,
          tickets: byStatus.flatMap((r) => r.tickets),
          mineIds: new Set(mine.flatMap((r) => r.tickets.map((t) => t.numero))),
        };
      });

      this.update({
        status: "ok",
        message: cut ? `Se muestran los ${LIMIT} más recientes de cada estado: quedan ${cut} afuera.` : null,
        lastCheck: Date.now(),
        webUrl,
        environment: environmentOf(webUrl),
        tickets: tickets.map((t) => ({ ...t, mine: mineIds.has(t.numero) })),
      });
    } catch (err) {
      this.update({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ checking: false });
    }
  }

  /** El hilo completo de un ticket, y si viene `action`, la aplica antes de leerlo. */
  async view(numero: number, action?: TicketAction): Promise<TicketView> {
    const server = await resolveServer(this.settings());
    if (!server) throw new Error("No se encontró el servidor MCP de tickets.");
    const ticket = String(numero);
    const detail = await withMcp(server, async (call) => {
      if (action?.type === "comment") await call("comentar_ticket", { ticket, texto: action.texto });
      else if (action?.type === "status") await call("cambiar_estado", { ticket, estado: action.estado });
      else if (action?.type === "assign") await call("asignar_ticket", { ticket, assigneeEmail: action.email });
      return (await call("ver_ticket", { ticket })) as TicketDetail;
    });
    // Que la tabla refleje el cambio (estado, dueño, cantidad de comentarios) sin esperar al ciclo.
    if (action) void this.check();
    return {
      ticket: { ...detail, comentarios: detail.comentarios ?? [], adjuntos: detail.adjuntos ?? [] },
      me: server.env.TICKETS_ACTOR_EMAIL || null,
      webUrl: server.env.AGENCIAS_WEB_URL?.replace(/\/$/, "") || null,
    };
  }

  private update(patch: Partial<TicketsState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
