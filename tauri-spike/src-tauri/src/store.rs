// Datos de la app en JSON: sesión (pestañas y sectores), configuración y notas.
// Equivale a session-store.ts, settings.ts y notes.ts de la versión Electron.
//
// Se guardan en ~/.config/rollerterm-tauri, aparte de la versión Electron
// (~/.config/rollerterm), para que las dos puedan convivir sin pisarse. La primera vez
// se copian los archivos de Electron, así arrancás con tus pestañas, sectores y notas.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

const FILES: [&str; 4] = ["session.json", "settings.json", "notes.json", "mail.json"];

fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"))
}

/// Carpeta de datos de la versión Tauri.
pub fn data_dir() -> PathBuf {
    config_home().join("rollerterm-tauri")
}

pub struct Store {
    pub dir: PathBuf,
    settings: Mutex<Value>,
    notes: Mutex<Vec<Value>>,
    /// Última sesión que mandó la ventana: al cerrar se le actualizan las carpetas.
    pub last_session: Mutex<Option<Value>>,
}

impl Store {
    pub fn open() -> Store {
        let dir = data_dir();
        let _ = fs::create_dir_all(&dir);
        let electron = config_home().join("rollerterm");
        for f in FILES {
            if !dir.join(f).exists() && electron.join(f).exists() {
                let _ = fs::copy(electron.join(f), dir.join(f));
            }
        }
        let read = |f: &str| -> Option<Value> {
            serde_json::from_str(&fs::read_to_string(dir.join(f)).ok()?).ok()
        };
        let settings = with_defaults(read("settings.json").unwrap_or(json!({})));
        let notes = match read("notes.json") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        };
        Store { settings: Mutex::new(settings), notes: Mutex::new(notes), last_session: Mutex::new(None), dir }
    }

    /// Escritura atómica: un cierre a mitad de camino no deja el JSON roto.
    pub fn write(&self, name: &str, value: &Value) -> Result<(), String> {
        let path = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.tmp"));
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
}

fn defaults() -> Value {
    json!({
        "browser": { "appPath": null, "profile": null },
        "pomodoro": { "ticking": true, "bell": true, "volume": 0.6 },
        "railway": { "enabled": true, "projects": null },
        "tickets": { "enabled": true, "server": null },
        "muted": false,
        "speak": false,
        "assistant": { "model": "sonnet", "voice": null, "rate": 1.05 },
        "terminal": { "paths": [], "recent": [] }
    })
}

/// Lo guardado completado con los valores por defecto (un nivel de profundidad, como en Electron).
fn with_defaults(saved: Value) -> Value {
    let mut out = defaults();
    let (Value::Object(out_map), Value::Object(saved_map)) = (&mut out, saved) else {
        return out;
    };
    for (k, v) in saved_map {
        match (out_map.get_mut(&k), v) {
            (Some(Value::Object(d)), Value::Object(s)) => d.extend(s),
            (_, v) => {
                out_map.insert(k, v);
            }
        }
    }
    out
}

// ---------- sesión ----------

#[tauri::command]
pub fn session_load(store: State<'_, Store>) -> Option<Value> {
    let text = fs::read_to_string(store.dir.join("session.json")).ok()?;
    let session: Value = serde_json::from_str(&text).ok()?;
    // Primera vez o archivo sin pestañas: la ventana arranca con una nueva.
    let has_tabs = session.get("tabs").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
    has_tabs.then_some(session)
}

#[tauri::command]
pub fn session_save(store: State<'_, Store>, session: Value) -> Result<(), String> {
    *store.last_session.lock().unwrap() = Some(session.clone());
    store.write("session.json", &session)
}

// ---------- configuración ----------

#[tauri::command]
pub fn settings_get(store: State<'_, Store>) -> Value {
    store.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(store: State<'_, Store>, patch: Map<String, Value>) -> Result<Value, String> {
    let mut s = store.settings.lock().unwrap();
    if let Value::Object(m) = &mut *s {
        m.extend(patch);
    }
    store.write("settings.json", &s)?;
    Ok(s.clone())
}

// ---------- notas ----------

fn updated_at(n: &Value) -> f64 {
    n.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0)
}

#[tauri::command]
pub fn notes_list(store: State<'_, Store>) -> Vec<Value> {
    let mut notes = store.notes.lock().unwrap().clone();
    notes.sort_by(|a, b| updated_at(b).total_cmp(&updated_at(a)));
    notes
}

#[tauri::command]
pub fn notes_save(store: State<'_, Store>, note: Value) -> Result<(), String> {
    let mut notes = store.notes.lock().unwrap();
    let id = note.get("id").cloned();
    match notes.iter_mut().find(|n| n.get("id") == id.as_ref()) {
        Some(existing) => *existing = note,
        None => notes.push(note),
    }
    store.write("notes.json", &Value::Array(notes.clone()))
}

#[tauri::command]
pub fn notes_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    let mut notes = store.notes.lock().unwrap();
    notes.retain(|n| n.get("id").and_then(Value::as_str) != Some(id.as_str()));
    store.write("notes.json", &Value::Array(notes.clone()))
}
