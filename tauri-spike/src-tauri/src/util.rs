// Utilidades compartidas: hora, actividad de la ventana y escritura de JSON.

use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Escritura atómica: un cierre a mitad de camino no deja el JSON roto.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Si el usuario está mirando la app. En Linux no hay un "tiempo inactivo del sistema" portable
/// (Electron usa powerMonitor), así que se aproxima con el foco de la ventana.
pub struct Activity {
    focused: AtomicBool,
    since: AtomicI64,
}

impl Activity {
    pub fn new() -> Self {
        Activity { focused: AtomicBool::new(true), since: AtomicI64::new(now_ms()) }
    }

    pub fn set_focused(&self, focused: bool) {
        if self.focused.swap(focused, Ordering::Relaxed) != focused {
            self.since.store(now_ms(), Ordering::Relaxed);
        }
    }

    /// Hace cuánto que la ventana no tiene el foco (cero si lo tiene).
    pub fn idle_for(&self) -> Duration {
        if self.focused.load(Ordering::Relaxed) {
            return Duration::ZERO;
        }
        Duration::from_millis((now_ms() - self.since.load(Ordering::Relaxed)).max(0) as u64)
    }
}

/// Repite `tick` cada `every`. Si entre dos vueltas pasó mucho más de lo esperado, la compu
/// estuvo suspendida (Electron lo avisa con powerMonitor "resume"): se llama a `on_resume`.
pub fn every<F, R>(every: Duration, mut tick: F, mut on_resume: R)
where
    F: FnMut() + Send + 'static,
    R: FnMut() + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut last = now_ms();
        loop {
            tokio::time::sleep(every).await;
            let now = now_ms();
            if now - last > every.as_millis() as i64 + 60_000 {
                on_resume();
            } else {
                tick();
            }
            last = now;
        }
    });
}

/// Milisegundos de una fecha ISO 8601, tan permisivo como Date.parse de JS en los formatos
/// que devuelven los conectores (con o sin segundos, con offset o en UTC).
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    use chrono::{DateTime, NaiveDateTime, TimeZone};
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M%:z", "%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%dT%H:%M%z"] {
        if let Ok(d) = DateTime::parse_from_str(s, fmt) {
            return Some(d.timestamp_millis());
        }
    }
    // Sin offset: hora local, como hace Date.parse.
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return chrono::Local.from_local_datetime(&n).single().map(|d| d.timestamp_millis());
        }
    }
    None
}
