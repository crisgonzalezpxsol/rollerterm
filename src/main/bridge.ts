// Puente HTTP local entre el servidor MCP de rollerterm (que lanza Claude Code) y la app.
// Escucha solo en 127.0.0.1, en un puerto al azar, y exige un token que cambia en cada arranque.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export class Bridge {
  readonly token = randomBytes(24).toString("hex");
  private server: Server | null = null;
  private handlers = new Map<string, ToolHandler>();
  url = "";

  on(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/tool") return reply(404, { error: "no existe" });
      if (req.headers["x-rt-token"] !== this.token) return reply(403, { error: "token inválido" });
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString();
        if (raw.length > 1_000_000) req.destroy();
      });
      req.on("end", async () => {
        try {
          const { name, args } = JSON.parse(raw) as { name: string; args: Record<string, unknown> };
          const handler = this.handlers.get(name);
          if (!handler) return reply(200, { error: `Herramienta desconocida: ${name}` });
          reply(200, await handler(args ?? {}));
        } catch (err) {
          reply(200, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    });
    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.url = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }
}
