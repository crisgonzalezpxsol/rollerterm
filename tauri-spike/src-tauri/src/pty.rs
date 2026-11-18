// Equivalente en Rust de src/main/pty-manager.ts: una shell por pestaña,
// indexada por el id de la pestaña. La salida viaja al frontend por un
// Channel de Tauri (más rápido que los eventos globales).

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: u32 },
}

struct Pty {
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    map: Arc<Mutex<HashMap<String, Pty>>>,
    next_gen: AtomicU64,
}

impl Ptys {
    /// Directorio actual de la shell (en Linux sale de /proc, igual que en Electron).
    pub fn cwd(&self, id: &str) -> Option<String> {
        let pid = self.map.lock().unwrap().get(id)?.child.process_id()?;
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }

    pub fn kill_all(&self) {
        for (_, p) in self.map.lock().unwrap().drain() {
            kill_entry(p);
        }
    }
}

fn kill_entry(mut p: Pty) {
    let _ = p.child.kill();
    // Cosechar el proceso en otro hilo para no dejar zombies ni bloquear.
    std::thread::spawn(move || {
        let _ = p.child.wait();
    });
}

#[tauri::command]
pub fn pty_create(
    state: State<'_, Ptys>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    if let Some(old) = state.map.lock().unwrap().remove(&id) {
        kill_entry(old);
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let dir = cwd.filter(|d| !d.is_empty() && Path::new(d).is_dir()).unwrap_or(home);

    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Shell de login (-l) para que cargue el PATH y los alias, igual que la versión Electron.
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "rollerterm");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let generation = state.next_gen.fetch_add(1, Ordering::Relaxed);
    state.map.lock().unwrap().insert(
        id.clone(),
        Pty { generation, master: pair.master, writer, child },
    );

    let map = state.map.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        // Bytes de un carácter UTF-8 que quedó partido entre dos lecturas.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(s) => s.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(), // basura real: se manda con reemplazo
                    };
                    let chunk: Vec<u8> = pending.drain(..valid).collect();
                    let data = String::from_utf8_lossy(&chunk).into_owned();
                    if on_event.send(PtyEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
        // Si la pestaña ya tiene otra shell (o se cerró a mano), no avisar.
        let entry = {
            let mut m = map.lock().unwrap();
            match m.get(&id) {
                Some(p) if p.generation == generation => m.remove(&id),
                _ => None,
            }
        };
        if let Some(mut p) = entry {
            let code = p.child.wait().map(|s| s.exit_code()).unwrap_or(1);
            let _ = on_event.send(PtyEvent::Exit { code });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, id: String, data: String) {
    if let Some(p) = state.map.lock().unwrap().get_mut(&id) {
        let _ = p.writer.write_all(data.as_bytes());
    }
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Ptys>, id: String, cols: u16, rows: u16) {
    if cols == 0 || rows == 0 {
        return;
    }
    if let Some(p) = state.map.lock().unwrap().get(&id) {
        let _ = p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Ptys>, id: String) {
    if let Some(p) = state.map.lock().unwrap().remove(&id) {
        kill_entry(p);
    }
}

#[tauri::command]
pub fn pty_cwd(state: State<'_, Ptys>, id: String) -> Option<String> {
    state.cwd(&id)
}
