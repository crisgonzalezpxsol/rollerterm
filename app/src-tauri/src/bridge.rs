// Puente HTTP local entre el servidor MCP de rollerterm (que lanza Claude Code) y la app.
// Escucha solo en 127.0.0.1, en un puerto al azar, y exige un token que cambia en cada
// arranque. Equivale a src/main/bridge.ts.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

pub type BoxFuture = Pin<Box<dyn Future<Output = Value> + Send>>;
/// `conv`: la conversación del asistente que hizo la llamada (cada Claude la recibe por entorno).
pub type ToolHandler = Arc<dyn Fn(Value, Option<String>) -> BoxFuture + Send + Sync>;

pub struct Bridge {
    pub token: String,
    pub url: String,
    handlers: RwLock<HashMap<String, ToolHandler>>,
}

impl Bridge {
    pub fn start() -> Arc<Bridge> {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("no se pudo abrir el puente local");
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let bridge = Arc::new(Bridge { token, url: format!("http://127.0.0.1:{port}"), handlers: RwLock::new(HashMap::new()) });
        let me = bridge.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let me = me.clone();
                // Una por hilo: una aprobación puede esperar minutos al usuario.
                std::thread::spawn(move || me.handle(req));
            }
        });
        bridge
    }

    pub fn on<F, Fut>(&self, name: &str, handler: F)
    where
        F: Fn(Value, Option<String>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Value> + Send + 'static,
    {
        let h: ToolHandler = Arc::new(move |args, conv| Box::pin(handler(args, conv)));
        self.handlers.write().unwrap().insert(name.into(), h);
    }

    fn handle(&self, mut req: tiny_http::Request) {
        let reply = |req: tiny_http::Request, status: u16, body: Value| {
            let header = tiny_http::Header::from_bytes("content-type", "application/json").unwrap();
            let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(status).with_header(header));
        };
        if req.method() != &tiny_http::Method::Post || req.url() != "/tool" {
            return reply(req, 404, json!({ "error": "no existe" }));
        }
        let token_ok = req.headers().iter().any(|h| h.field.equiv("x-rt-token") && h.value.as_str() == self.token);
        if !token_ok {
            return reply(req, 403, json!({ "error": "token inválido" }));
        }
        let mut raw = String::new();
        if req.as_reader().take(1_000_000).read_to_string(&mut raw).is_err() {
            return reply(req, 400, json!({ "error": "cuerpo inválido" }));
        }
        let Ok(body) = serde_json::from_str::<Value>(&raw) else {
            return reply(req, 200, json!({ "error": "JSON inválido" }));
        };
        let name = body["name"].as_str().unwrap_or("").to_string();
        let conv = body["conv"].as_str().filter(|c| !c.is_empty()).map(String::from);
        let args = if body["args"].is_object() { body["args"].clone() } else { json!({}) };
        let handler = self.handlers.read().unwrap().get(&name).cloned();
        let result = match handler {
            Some(h) => tauri::async_runtime::block_on(h(args, conv)),
            None => json!({ "error": format!("Herramienta desconocida: {name}") }),
        };
        reply(req, 200, result);
    }
}
