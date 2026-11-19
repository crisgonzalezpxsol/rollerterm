// Agenda: eventos de Google Calendar de las próximas 24 h, leídos vía Claude Code.
// Equivale a src/main/calendar.ts.

use crate::claude_runner::{local_iso, ClaudeRunner, QueryOptions};
use crate::util::{every, now_ms, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SYNC_EVERY: Duration = Duration::from_secs(10 * 60);
const WINDOW_HOURS: i64 = 24;
const SERVER: &str = "claude.ai Google Calendar";
const TOOL: &str = "mcp__claude_ai_Google_Calendar__";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    /// ISO 8601 con offset.
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub meet_url: Option<String>,
    #[serde(default)]
    pub declined: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarState {
    pub status: String,
    pub events: Vec<CalendarEvent>,
    pub last_sync: Option<i64>,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub syncing: bool,
}

pub struct CalendarSync {
    state: Mutex<CalendarState>,
    claude: Arc<ClaudeRunner>,
    app: AppHandle,
}

impl CalendarSync {
    pub fn new(claude: Arc<ClaudeRunner>, app: AppHandle) -> Arc<Self> {
        Arc::new(CalendarSync {
            state: Mutex::new(CalendarState {
                status: "loading".into(),
                events: vec![],
                last_sync: None,
                message: None,
                detail: None,
                syncing: false,
            }),
            claude,
            app,
        })
    }

    pub fn current(&self) -> CalendarState {
        self.state.lock().unwrap().clone()
    }

    pub fn start(self: &Arc<Self>) {
        self.spawn_sync();
        let (a, b) = (self.clone(), self.clone());
        every(SYNC_EVERY, move || a.spawn_sync(), move || b.spawn_sync());
    }

    pub fn spawn_sync(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.sync().await });
    }

    async fn sync(&self) {
        if self.current().syncing {
            return;
        }
        self.update(|s| s.syncing = true);
        let res = self
            .claude
            .query(QueryOptions {
                server: SERVER,
                allow: vec![format!("{TOOL}list_events")],
                deny: ["create_event", "update_event", "delete_event", "respond_to_event"]
                    .iter()
                    .map(|t| format!("{TOOL}{t}"))
                    .collect(),
                prompt: build_prompt(),
                schema: events_schema(),
                timeout: Duration::from_secs(120),
            })
            .await;
        let events: Option<Vec<CalendarEvent>> =
            res.output.as_ref().and_then(|o| serde_json::from_value(o["events"].clone()).ok());
        match events {
            Some(events) => self.update(|s| {
                // Si esta vez el modelo no extrajo el link de un evento que ya lo tenía, se conserva
                // el anterior: sin link, esa llamada no avisaría.
                let known: HashMap<String, Option<String>> =
                    s.events.iter().map(|e| (e.id.clone(), e.meet_url.clone())).collect();
                s.events = events
                    .into_iter()
                    .filter(|e| e.start.contains('T') && parse_iso_ms(&e.start).is_some())
                    .map(|mut e| {
                        e.title = e.title.trim().to_string();
                        if e.meet_url.as_deref().is_none_or(str::is_empty) {
                            e.meet_url = known.get(&e.id).cloned().flatten();
                        }
                        e
                    })
                    .collect();
                s.status = res.status.into();
                s.message = None;
                s.detail = None;
                s.last_sync = Some(now_ms());
            }),
            // Los eventos que ya se conocían se conservan si una sincronización falla.
            None => self.update(|s| {
                s.status = if res.status == "connected" { "error" } else { res.status }.into();
                s.message = res.message.clone().or(Some("Respuesta inesperada de Claude.".into()));
                s.detail = res.detail.clone();
            }),
        }
        self.update(|s| s.syncing = false);
    }

    fn update(&self, f: impl FnOnce(&mut CalendarState)) {
        let state = {
            let mut s = self.state.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.app.emit("calendar:state", state);
    }
}

fn build_prompt() -> String {
    let now = chrono::Local::now();
    let end = now + chrono::Duration::hours(WINDOW_HOURS);
    [
        format!("Llamá UNA sola vez a list_events con startTime=\"{}\", endTime=\"{}\",", local_iso(now), local_iso(end)),
        "orderBy=\"startTime\", pageSize=50, eventType=[\"DEFAULT\"]. No llames a ninguna otra herramienta.".into(),
        "Con el resultado devolvé los eventos con hora (ignorá los de día completo).".into(),
        "start y end en ISO 8601 con offset.".into(),
        "meetUrl: el link de videollamada. Tomalo de hangoutLink; si no está, de conferenceData.entryPoints".into(),
        "(el de entryPointType \"video\"); si no, de un link de meet.google.com, zoom.us o teams.microsoft.com".into(),
        "que aparezca en location o description. Solo null si no hay ninguno.".into(),
        "declined = true si mi respuesta a la invitación es \"declined\".".into(),
    ]
    .join(" ")
}

fn events_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "events": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "start": { "type": "string", "description": "ISO 8601 con offset" },
                        "end": { "type": "string", "description": "ISO 8601 con offset" },
                        "meetUrl": { "type": ["string", "null"] },
                        "declined": { "type": "boolean" }
                    },
                    "required": ["id", "title", "start", "end", "meetUrl", "declined"]
                }
            }
        },
        "required": ["events"]
    })
}
