// Recordatorios que programa el asistente o una nota: se guardan en reminders.json y, a la
// hora, la app avisa (notificación + mensaje en el chat). Equivale a src/main/reminders.ts.

use crate::util::{now_ms, parse_iso_ms, write_json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    /// ISO.
    pub when: String,
    pub text: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub note_id: Option<String>,
}

impl Reminder {
    fn when_ms(&self) -> i64 {
        parse_iso_ms(&self.when).unwrap_or(0)
    }
}

pub struct Reminders {
    file: PathBuf,
    list: Mutex<Vec<Reminder>>,
    on_fire: Box<dyn Fn(Reminder) + Send + Sync>,
    on_change: Box<dyn Fn() + Send + Sync>,
}

impl Reminders {
    pub fn new(
        dir: &std::path::Path,
        on_fire: impl Fn(Reminder) + Send + Sync + 'static,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Arc<Self> {
        let file = dir.join("reminders.json");
        let list = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Arc::new(Reminders { file, list: Mutex::new(list), on_fire: Box::new(on_fire), on_change: Box::new(on_change) })
    }

    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                me.tick();
                // Cada 15 s alcanza: un recordatorio no necesita precisión de segundos.
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }

    pub fn pending(&self) -> Vec<Reminder> {
        let mut out: Vec<Reminder> = self.list.lock().unwrap().iter().filter(|r| !r.done).cloned().collect();
        out.sort_by_key(Reminder::when_ms);
        out
    }

    /// Pendientes y ya avisados (estos se guardan una semana).
    pub fn all(&self) -> Vec<Reminder> {
        let mut out = self.list.lock().unwrap().clone();
        out.sort_by_key(Reminder::when_ms);
        out
    }

    pub fn add(&self, when: &str, text: &str, note_id: Option<String>) -> Result<Reminder, String> {
        let ms = parse_iso_ms(when).ok_or_else(|| format!("Fecha inválida: {when}"))?;
        let when = chrono::DateTime::from_timestamp_millis(ms)
            .ok_or_else(|| format!("Fecha inválida: {when}"))?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let id: String = uuid::Uuid::new_v4().to_string().chars().take(8).collect();
        let r = Reminder { id, when, text: text.into(), done: false, note_id: note_id.filter(|n| !n.is_empty()) };
        self.list.lock().unwrap().push(r.clone());
        self.save();
        Ok(r)
    }

    /// Suma recordatorios importados que todavía no pasaron y que no estaban.
    pub fn merge(&self, incoming: Vec<Reminder>) -> usize {
        let now = now_ms();
        let added = {
            let mut list = self.list.lock().unwrap();
            let fresh: Vec<Reminder> = incoming
                .into_iter()
                .filter(|r| !r.done && r.when_ms() > now && !list.iter().any(|x| x.id == r.id))
                .collect();
            let n = fresh.len();
            list.extend(fresh);
            n
        };
        if added > 0 {
            self.save();
        }
        added
    }

    pub fn remove(&self, id: &str) -> bool {
        let removed = {
            let mut list = self.list.lock().unwrap();
            let before = list.len();
            list.retain(|r| r.id != id);
            list.len() < before
        };
        self.save();
        removed
    }

    fn tick(&self) {
        let now = now_ms();
        let due: Vec<Reminder> = {
            let mut list = self.list.lock().unwrap();
            let due: Vec<Reminder> = list.iter_mut().filter(|r| !r.done && r.when_ms() <= now).map(|r| {
                r.done = true;
                r.clone()
            }).collect();
            if !due.is_empty() {
                // Los ya avisados se guardan un tiempo (para "¿qué me recordaste ayer?") y después se limpian.
                let week_ago = now - 7 * 86_400_000;
                list.retain(|r| !r.done || r.when_ms() > week_ago);
            }
            due
        };
        if due.is_empty() {
            return;
        }
        for r in due {
            (self.on_fire)(r);
        }
        self.save();
    }

    fn save(&self) {
        let list = self.list.lock().unwrap().clone();
        if let Err(e) = write_json(&self.file, &list) {
            eprintln!("[reminders] no se pudo guardar: {e}");
        }
        (self.on_change)();
    }
}
