// rollerterm sobre Tauri: la interfaz es la misma de src/renderer/ y este proceso
// reemplaza a src/main/ de Electron, módulo por módulo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pty;
mod store;

use pty::Ptys;
use serde_json::Value;
use store::Store;
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Selector nativo de carpetas; None si se cancela. Es async para no trabar la ventana.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, default_path: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Abrir terminal en…");
    if let Some(p) = default_path.filter(|p| !p.is_empty()) {
        dialog = dialog.set_directory(p);
    }
    dialog.blocking_pick_folder()?.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Abre un link http(s) con el navegador del sistema (los de la terminal, Unirme, correos…).
#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Errores de la ventana a la consola (en WebKitGTK no hay devtools en release).
#[tauri::command]
fn js_log(message: String) {
    eprintln!("[ventana] {message}");
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Al cerrar, guarda en qué directorio quedó cada shell para reabrirla ahí.
fn save_with_current_cwds(app: &tauri::AppHandle) {
    let store = app.state::<Store>();
    let ptys = app.state::<Ptys>();
    let Some(mut session) = store.last_session.lock().unwrap().clone() else { return };
    if let Some(tabs) = session.get_mut("tabs").and_then(Value::as_array_mut) {
        for tab in tabs {
            let id = tab.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(cwd) = id.and_then(|id| ptys.cwd(&id)) {
                tab["cwd"] = Value::String(cwd);
            }
        }
    }
    if let Err(e) = store.write("session.json", &session) {
        eprintln!("[save_with_current_cwds] {e}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Ptys::default())
        .manage(Store::open())
        .invoke_handler(tauri::generate_handler![
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            store::session_load,
            store::session_save,
            store::settings_get,
            store::settings_set,
            store::notes_list,
            store::notes_save,
            store::notes_delete,
            pick_folder,
            open_url,
            js_log,
            quit,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                save_with_current_cwds(app);
                app.state::<Ptys>().kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar rollerterm-tauri");
}
