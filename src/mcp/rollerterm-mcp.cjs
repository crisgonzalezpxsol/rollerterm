#!/usr/bin/env node
// Servidor MCP de rollerterm para el asistente: Claude Code lo lanza por stdio y cada
// herramienta se reenvía a la app por HTTP local (RT_BRIDGE + RT_TOKEN). La app es la dueña
// de las notas, los recordatorios y las aprobaciones; acá solo está el protocolo.
//
// stdout es el canal del protocolo (JSON-RPC, un mensaje por línea): nada más se escribe ahí.
"use strict";

const BRIDGE = process.env.RT_BRIDGE;
const TOKEN = process.env.RT_TOKEN;
// De qué conversación del asistente es este Claude (para que las aprobaciones caigan en su chat).
const CONV = process.env.RT_CONV || null;

const TOOLS = [
  {
    name: "crear_nota",
    description:
      "Crea una nota en el panel de notas de rollerterm. La primera línea es el título. Usala cuando el usuario pida anotar algo.",
    inputSchema: {
      type: "object",
      properties: { texto: { type: "string", description: "Texto de la nota; la primera línea es el título." } },
      required: ["texto"],
    },
  },
  {
    name: "buscar_notas",
    description: "Lista las notas del usuario (las más recientes primero), opcionalmente filtradas por texto.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "Texto a buscar (opcional)." } } },
  },
  {
    name: "crear_recordatorio",
    description:
      "Programa un recordatorio: a esa hora la app avisa con una notificación y un mensaje en el chat. " +
      "`cuando` es fecha y hora local en ISO 8601 (por ejemplo 2026-10-16T15:00).",
    inputSchema: {
      type: "object",
      properties: {
        cuando: { type: "string", description: "Fecha y hora local, ISO 8601." },
        texto: { type: "string", description: "Qué hay que recordar." },
      },
      required: ["cuando", "texto"],
    },
  },
  {
    name: "listar_recordatorios",
    description: "Recordatorios pendientes (los que todavía no sonaron).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "borrar_recordatorio",
    description: "Cancela un recordatorio pendiente por su id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "contexto_actual",
    description:
      "Lo que la app ya está mostrando ahora mismo, sin consultar nada de nuevo: reuniones de las próximas 24 h, " +
      "correos del inbox de las últimas 48 h, tickets abiertos (míos, sin dueño) y salud de producción. " +
      "Usala primero cuando pregunten «¿qué tengo hoy?», «¿qué hay pendiente?» o similar.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "aprobar",
    description:
      "Uso interno de rollerterm: le pide al usuario que apruebe una acción antes de ejecutarla. No la llames vos.",
    inputSchema: {
      type: "object",
      properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
      required: ["tool_name", "input"],
    },
  },
];

async function bridge(name, args) {
  if (!BRIDGE || !TOKEN) return { error: "rollerterm no está abierto (falta RT_BRIDGE)." };
  try {
    const res = await fetch(`${BRIDGE}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rt-token": TOKEN },
      body: JSON.stringify({ name, args, conv: CONV }),
      // Una aprobación espera a que el usuario conteste: sin tope corto.
      signal: AbortSignal.timeout(name === "aprobar" ? 30 * 60_000 : 30_000),
    });
    return await res.json();
  } catch (e) {
    return { error: `No se pudo hablar con rollerterm: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

async function handle(msg) {
  if (msg.id === undefined) return; // notificación: no se responde
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "rollerterm", version: "0.1.0" },
        },
      });
    case "tools/list":
      return send({ id: msg.id, result: { tools: TOOLS } });
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      const r = await bridge(name, args ?? {});
      // La herramienta de permisos de Claude Code espera exactamente el JSON de la decisión.
      const text = name === "aprobar" && r && r.behavior ? JSON.stringify(r) : JSON.stringify(r, null, 2);
      return send({ id: msg.id, result: { content: [{ type: "text", text }], isError: Boolean(r && r.error) } });
    }
    case "ping":
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `Método no soportado: ${msg.method}` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => process.stderr.write(`[rollerterm-mcp] ${e}\n`));
  }
});
process.stdin.on("end", () => process.exit(0));
