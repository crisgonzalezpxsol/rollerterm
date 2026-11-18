// Cliente MCP mínimo por stdio: lanza un servidor tal como lo tiene configurado Claude Code
// (~/.claude.json → mcpServers), llama herramientas y lo cierra. Sin pasar por Claude.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findCommand } from "./shell-env";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Carpeta del proyecto, para los servidores de proyecto: se lanzan parados ahí (sus rutas pueden ser relativas). */
  cwd?: string;
}

type RawServers = Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string> }>;

function stdioServers(servers: RawServers | undefined, cwd?: string): McpServerConfig[] {
  return Object.entries(servers ?? {}).flatMap(([name, c]) =>
    c.command && (!c.type || c.type === "stdio") ? [{ name, command: c.command, args: c.args ?? [], env: c.env ?? {}, cwd }] : [],
  );
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Servidores MCP por stdio configurados en Claude Code: los de cada proyecto (alcance local, en
 * ~/.claude.json, y el .mcp.json del repo) y los de usuario. Con la prioridad de Claude Code
 * (local, proyecto, usuario); si un nombre se repite, queda el primero.
 */
export async function listMcpServers(): Promise<McpServerConfig[]> {
  const parsed = await readJson<{ mcpServers?: RawServers; projects?: Record<string, { mcpServers?: RawServers }> }>(
    `${homedir()}/.claude.json`,
  );
  if (!parsed) return [];
  const projects = Object.entries(parsed.projects ?? {}).filter(([dir]) => existsSync(dir));
  const local = projects.flatMap(([dir, p]) => stdioServers(p.mcpServers, dir));
  const shared: McpServerConfig[] = [];
  for (const [dir] of projects) {
    const file = await readJson<{ mcpServers?: RawServers }>(join(dir, ".mcp.json"));
    shared.push(...stdioServers(file?.mcpServers, dir));
  }
  const seen = new Set<string>();
  return [...local, ...shared, ...stdioServers(parsed.mcpServers)].filter((s) => !seen.has(s.name) && Boolean(seen.add(s.name)));
}

/** "${VAR}" → valor del entorno, como hace Claude Code al lanzar el servidor. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(\w+)\}/g, (_, v: string) => env[v] ?? "");
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Abre una sesión con el servidor, corre `fn` y lo cierra. Las herramientas que devuelven
 * `{ error }` en su contenido se convierten en excepciones.
 */
export async function withMcp<T>(cfg: McpServerConfig, fn: (call: CallTool) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  // `node` (o lo que sea) se busca con el PATH de la terminal: con nvm no está en el PATH de la app.
  const found = isAbsolute(cfg.command) ? null : await findCommand(cfg.command);
  const baseEnv = found?.env ?? process.env;
  const bin = isAbsolute(cfg.command) ? cfg.command : found?.bin;
  if (!bin) throw new Error(`No se encontró el comando «${cfg.command}» del servidor MCP ${cfg.name}.`);
  const env = { ...baseEnv, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expand(v, baseEnv)])) };

  const child = spawn(bin, cfg.args, { env, cwd: cfg.cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id!);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        // Una línea que no es JSON-RPC: se ignora (el protocolo exige que no las haya).
      }
    }
  });
  const died = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(err));
    child.on("exit", (code) =>
      reject(new Error(`El servidor MCP ${cfg.name} terminó (código ${code}). ${stderr.trim()}`.trim())),
    );
  });
  died.catch(() => {}); // se observa abajo; evita "unhandled rejection" si nadie espera

  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const call: CallTool = async (name, args) => {
    const res = (await Promise.race([request("tools/call", { name, arguments: args }), died])) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "null";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (res.isError || (data && typeof data === "object" && "error" in data)) {
      throw new Error(String((data as { error?: unknown })?.error ?? text));
    }
    return data;
  };

  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    await Promise.race([
      request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rollerterm", version: "0.1.0" } }),
      died,
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await fn(call);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
