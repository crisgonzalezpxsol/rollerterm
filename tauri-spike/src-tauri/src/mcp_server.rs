// Servidor MCP de rollerterm para el asistente. Claude Code lanza este mismo binario con
// `--mcp` y le habla por stdio; cada herramienta se reenvía a la app por HTTP local
// (RT_BRIDGE + RT_TOKEN). Reemplaza a src/mcp/rollerterm-mcp.cjs, sin necesitar Node.
//
// stdout es el canal del protocolo (JSON-RPC, un mensaje por línea): nada más se escribe ahí.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::Duration;

fn tools() -> Value {
    json!([
        {
            "name": "crear_nota",
            "description": "Crea una nota en el panel de notas de rollerterm. La primera línea es el título; el resto admite Markdown («## subtítulo», «- [ ] tarea»). Usala cuando el usuario pida anotar algo. Si la nota es de un cliente (agencia, hotel…), pasá `cliente` para que quede en su historial.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "texto": { "type": "string", "description": "Texto de la nota; la primera línea es el título." },
                    "cliente": { "type": "string", "description": "Cliente al que pertenece la nota (opcional)." },
                    "etiquetas": { "type": "array", "items": { "type": "string" }, "description": "Etiquetas (opcional)." }
                },
                "required": ["texto"]
            }
        },
        {
            "name": "buscar_notas",
            "description": "Lista las notas del usuario (las más recientes primero), opcionalmente filtradas por texto o por cliente. Con `cliente` devuelve su historial: todas las notas de ese cliente.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": { "type": "string", "description": "Texto a buscar (opcional)." },
                    "cliente": { "type": "string", "description": "Solo las notas de este cliente (opcional)." }
                }
            }
        },
        {
            "name": "crear_recordatorio",
            "description": "Programa un recordatorio: a esa hora la app avisa con una notificación y un mensaje en el chat. `cuando` es fecha y hora local en ISO 8601 (por ejemplo 2026-10-16T15:00).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cuando": { "type": "string", "description": "Fecha y hora local, ISO 8601." },
                    "texto": { "type": "string", "description": "Qué hay que recordar." },
                    "nota_id": { "type": "string", "description": "Id de una nota (de buscar_notas) para que el recordatorio quede en ella (opcional)." }
                },
                "required": ["cuando", "texto"]
            }
        },
        {
            "name": "listar_recordatorios",
            "description": "Recordatorios pendientes (los que todavía no sonaron).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "borrar_recordatorio",
            "description": "Cancela un recordatorio pendiente por su id.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        },
        {
            "name": "contexto_actual",
            "description": "Lo que la app ya está mostrando ahora mismo, sin consultar nada de nuevo: reuniones de las próximas 24 h, correos del inbox de las últimas 48 h, tickets abiertos (míos, sin dueño) y salud de producción. Usala primero cuando pregunten «¿qué tengo hoy?», «¿qué hay pendiente?» o similar.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "aprobar",
            "description": "Uso interno de rollerterm: le pide al usuario que apruebe una acción antes de ejecutarla. No la llames vos.",
            "inputSchema": {
                "type": "object",
                "properties": { "tool_name": { "type": "string" }, "input": { "type": "object" }, "tool_use_id": { "type": "string" } },
                "required": ["tool_name", "input"]
            }
        }
    ])
}

fn bridge(name: &str, args: &Value) -> Value {
    let (Ok(url), Ok(token)) = (std::env::var("RT_BRIDGE"), std::env::var("RT_TOKEN")) else {
        return json!({ "error": "rollerterm no está abierto (falta RT_BRIDGE)." });
    };
    // Sin la app, Claude Code deja el texto literal "${RT_BRIDGE}" del .mcp.json.
    if url.is_empty() || url.starts_with("${") {
        return json!({ "error": "rollerterm no está abierto (falta RT_BRIDGE)." });
    }
    // De qué conversación del asistente es este Claude (para que las aprobaciones caigan en su chat).
    let conv = std::env::var("RT_CONV").ok().filter(|c| !c.is_empty());
    // Una aprobación espera a que el usuario conteste: sin tope corto.
    let timeout = Duration::from_secs(if name == "aprobar" { 30 * 60 } else { 30 });
    let body = json!({ "name": name, "args": args, "conv": conv });
    let res = ureq::post(&format!("{url}/tool"))
        .timeout(timeout)
        .set("content-type", "application/json")
        .set("x-rt-token", &token)
        .send_string(&body.to_string());
    match res {
        Ok(r) => r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({ "error": "respuesta inválida" })),
        Err(e) => json!({ "error": format!("No se pudo hablar con rollerterm: {e}") }),
    }
}

/// Un mensaje por línea, con stdout bloqueado: las respuestas salen de varios hilos.
fn send(msg: Value) {
    let mut msg = msg;
    msg["jsonrpc"] = json!("2.0");
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

pub fn run() {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notificación: no se responde
        match msg["method"].as_str().unwrap_or("") {
            "initialize" => send(json!({
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "rollerterm", "version": "0.1.0" }
                }
            })),
            "tools/list" => send(json!({ "id": id, "result": { "tools": tools() } })),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
                let args = if msg["params"]["arguments"].is_object() { msg["params"]["arguments"].clone() } else { json!({}) };
                // Las aprobaciones pueden tardar minutos: en otro hilo, para no frenar otras llamadas.
                let id = id.clone();
                std::thread::spawn(move || {
                    let r = bridge(&name, &args);
                    // La herramienta de permisos de Claude Code espera exactamente el JSON de la decisión.
                    let text = if name == "aprobar" && r.get("behavior").is_some() {
                        r.to_string()
                    } else {
                        serde_json::to_string_pretty(&r).unwrap_or_default()
                    };
                    let is_error = r.get("error").is_some_and(|e| !e.is_null());
                    send(json!({
                        "id": id,
                        "result": { "content": [{ "type": "text", "text": text }], "isError": is_error }
                    }));
                });
            }
            "ping" => send(json!({ "id": id, "result": {} })),
            other => send(json!({
                "id": id,
                "error": { "code": -32601, "message": format!("Método no soportado: {other}") }
            })),
        }
    }
}
