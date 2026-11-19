// Tickets de Pxsol Agencias: se leen y se gestionan con el MCP de tickets que ya usa Claude
// Code, lanzándolo directo (no pasa por Claude). La lista se refresca sola; el detalle, los
// comentarios y los cambios de estado o dueño se piden al abrir un ticket.
// Equivale a src/main/tickets.ts.

use crate::mcp_client::{list_servers, with_mcp, ServerConfig};
use crate::util::{every, now_ms};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CHECK_EVERY: Duration = Duration::from_secs(3 * 60);
const OPEN_STATUSES: [&str; 3] = ["OPEN", "IN_PROGRESS", "WAITING"];
const LIMIT: u64 = 50;
const TIMEOUT: Duration = Duration::from_secs(60);

/// El servidor elegido o, si no hay elección, el primero que parezca de tickets.
pub fn resolve_server(cfg: &Value) -> Option<ServerConfig> {
    let servers = list_servers();
    if let Some(name) = cfg["server"].as_str() {
        return servers.into_iter().find(|s| s.name == name);
    }
    servers.into_iter().find(|s| {
        let n = s.name.to_lowercase();
        n.contains("ticket") || n.contains("arturito") || s.args.iter().any(|a| a.contains("mcp-tickets"))
    })
}

/// "https://testing.pxsolagencias.com" → "testing"; "app." o sin subdominio → "producción".
fn environment_of(url: Option<&str>) -> Option<String> {
    let host = url?.split("://").nth(1)?.split(['/', ':']).next()?;
    let parts: Vec<&str> = host.split('.').collect();
    let sub = parts.first()?;
    Some(if parts.len() > 2 && *sub != "app" && *sub != "www" { sub.to_string() } else { "producción".into() })
}

fn web_url(s: &ServerConfig) -> Option<String> {
    s.env.get("AGENCIAS_WEB_URL").map(|u| u.trim_end_matches('/').to_string()).filter(|u| !u.is_empty())
}

fn actor(s: &ServerConfig) -> Option<String> {
    s.env.get("TICKETS_ACTOR_EMAIL").cloned().filter(|e| !e.is_empty())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketsState {
    pub status: String,
    pub message: Option<String>,
    pub checking: bool,
    pub last_check: Option<i64>,
    /// Tickets sin cerrar, tal como los lista el MCP, más `mine`.
    pub tickets: Vec<Value>,
    pub web_url: Option<String>,
    pub environment: Option<String>,
}

pub struct TicketsMonitor {
    state: Mutex<TicketsState>,
    settings: Box<dyn Fn() -> Value + Send + Sync>,
    app: AppHandle,
}

impl TicketsMonitor {
    pub fn new(settings: impl Fn() -> Value + Send + Sync + 'static, app: AppHandle) -> Arc<Self> {
        Arc::new(TicketsMonitor {
            state: Mutex::new(TicketsState {
                status: "loading".into(),
                message: None,
                checking: false,
                last_check: None,
                tickets: vec![],
                web_url: None,
                environment: None,
            }),
            settings: Box::new(settings),
            app,
        })
    }

    pub fn current(&self) -> TicketsState {
        self.state.lock().unwrap().clone()
    }

    pub fn start(self: &Arc<Self>) {
        self.spawn_check();
        let (a, b) = (self.clone(), self.clone());
        every(CHECK_EVERY, move || a.spawn_check(), move || b.spawn_check());
    }

    pub fn spawn_check(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.check().await });
    }

    async fn check(&self) {
        if self.current().checking {
            return;
        }
        let cfg = (self.settings)();
        if cfg["enabled"] == false {
            self.update(|s| {
                s.status = "disabled".into();
                s.message = None;
                s.tickets = vec![];
            });
            return;
        }
        self.update(|s| s.checking = true);
        let Some(server) = resolve_server(&cfg) else {
            let message = match cfg["server"].as_str() {
                Some(name) => format!("No está el servidor MCP «{name}» en Claude Code."),
                None => "No se encontró un servidor MCP de tickets en Claude Code.".into(),
            };
            self.update(|s| {
                s.status = "not-configured".into();
                s.message = Some(message);
                s.checking = false;
            });
            return;
        };
        let me = actor(&server);
        let result = with_mcp(&server, TIMEOUT, |session| async move {
            // Una llamada por estado: la herramienta filtra por uno solo y el total de cerrados es enorme.
            // Los míos también por estado: sin filtrar, los cerrados taparían a los abiertos en el límite.
            let mut calls = vec![];
            for status in OPEN_STATUSES {
                let s = session.clone();
                calls.push(tokio::spawn(async move { s.call("listar_tickets", json!({ "status": status, "limit": LIMIT })).await }));
            }
            let mut mine_calls = vec![];
            if let Some(me) = &me {
                for status in OPEN_STATUSES {
                    let (s, me) = (session.clone(), me.clone());
                    mine_calls.push(tokio::spawn(async move {
                        s.call("listar_tickets", json!({ "status": status, "assignee": me, "limit": LIMIT })).await
                    }));
                }
            }
            let mut tickets = vec![];
            let mut cut = 0u64;
            for c in calls {
                let r = c.await.map_err(|e| e.to_string())??;
                let list = r["tickets"].as_array().cloned().unwrap_or_default();
                cut += r["total"].as_u64().unwrap_or(0).saturating_sub(list.len() as u64);
                tickets.extend(list);
            }
            let mut mine: HashSet<String> = HashSet::new();
            for c in mine_calls {
                let r = c.await.map_err(|e| e.to_string())??;
                mine.extend(r["tickets"].as_array().into_iter().flatten().map(|t| t["numero"].to_string()));
            }
            Ok((tickets, mine, cut))
        })
        .await;
        match result {
            Ok((tickets, mine, cut)) => {
                let web = web_url(&server);
                self.update(|s| {
                    s.status = "ok".into();
                    s.message = (cut > 0).then(|| format!("Se muestran los {LIMIT} más recientes de cada estado: quedan {cut} afuera."));
                    s.last_check = Some(now_ms());
                    s.environment = environment_of(web.as_deref());
                    s.web_url = web;
                    s.tickets = tickets
                        .into_iter()
                        .map(|mut t| {
                            t["mine"] = json!(mine.contains(&t["numero"].to_string()));
                            t
                        })
                        .collect();
                    s.checking = false;
                });
            }
            Err(e) => self.update(|s| {
                s.status = "error".into();
                s.message = Some(e);
                s.checking = false;
            }),
        }
    }

    /// El hilo completo de un ticket, y si viene `action`, la aplica antes de leerlo.
    pub async fn view(self: &Arc<Self>, numero: u64, action: Option<Value>) -> Result<Value, String> {
        let server = resolve_server(&(self.settings)()).ok_or("No se encontró el servidor MCP de tickets.")?;
        let ticket = numero.to_string();
        let act = action.clone();
        let detail = with_mcp(&server, TIMEOUT, |s| async move {
            if let Some(a) = &act {
                match a["type"].as_str() {
                    Some("comment") => s.call("comentar_ticket", json!({ "ticket": ticket, "texto": a["texto"] })).await?,
                    Some("status") => s.call("cambiar_estado", json!({ "ticket": ticket, "estado": a["estado"] })).await?,
                    Some("assign") => s.call("asignar_ticket", json!({ "ticket": ticket, "assigneeEmail": a["email"] })).await?,
                    _ => Value::Null,
                };
            }
            s.call("ver_ticket", json!({ "ticket": ticket })).await
        })
        .await?;
        // Que la tabla refleje el cambio (estado, dueño, comentarios) sin esperar al ciclo.
        if action.is_some() {
            self.spawn_check();
        }
        let mut detail = detail;
        if !detail["comentarios"].is_array() {
            detail["comentarios"] = json!([]);
        }
        if !detail["adjuntos"].is_array() {
            detail["adjuntos"] = json!([]);
        }
        Ok(json!({ "ticket": detail, "me": actor(&server), "webUrl": web_url(&server) }))
    }

    fn update(&self, f: impl FnOnce(&mut TicketsState)) {
        let state = {
            let mut s = self.state.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.app.emit("tickets:state", state);
    }
}
