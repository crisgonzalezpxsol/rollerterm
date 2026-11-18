// rollerterm sobre Tauri: la interfaz es la misma de src/renderer/ y este proceso
// reemplaza a src/main/ de Electron, módulo por módulo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assistant;
mod bridge;
mod calendar;
mod claude_runner;
mod mail;
mod mcp_server;
mod notify;
mod pty;
mod reminders;
mod rt_tools;
mod shell_env;
mod store;
mod sysmon;
mod util;

use assistant::Assistant;
use calendar::{CalendarState, CalendarSync};
use reminders::{Reminder, Reminders};
use claude_runner::ClaudeRunner;
use mail::{MailState, MailSync};
use pty::Ptys;
use serde_json::Value;
use std::sync::Arc;
use store::Store;
use bridge::Bridge;
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use util::Activity;

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

// ---------- agenda y correo ----------

#[tauri::command]
fn calendar_get(cal: State<'_, Arc<CalendarSync>>) -> CalendarState {
    cal.current()
}

#[tauri::command]
fn calendar_refresh(cal: State<'_, Arc<CalendarSync>>) {
    cal.spawn_sync();
}

#[tauri::command]
fn mail_get(mail: State<'_, Arc<MailSync>>) -> MailState {
    mail.current()
}

#[tauri::command]
fn mail_refresh(mail: State<'_, Arc<MailSync>>) {
    mail.spawn_sync();
}

#[tauri::command]
fn mail_summarize(mail: State<'_, Arc<MailSync>>) {
    mail.spawn_summarize();
}

#[tauri::command]
fn mail_lists(mail: State<'_, Arc<MailSync>>, vip: Vec<String>, blocked: Vec<String>) {
    mail.set_lists(vip, blocked);
}

// ---------- recordatorios ----------

#[tauri::command]
fn reminders_list(r: State<'_, Arc<Reminders>>) -> Vec<Reminder> {
    r.all()
}

#[tauri::command]
fn reminders_add(r: State<'_, Arc<Reminders>>, when: String, text: String, note_id: Option<String>) -> Result<Reminder, String> {
    r.add(&when, &text, note_id)
}

#[tauri::command]
fn reminders_remove(r: State<'_, Arc<Reminders>>, id: String) -> bool {
    r.remove(&id)
}

// ---------- asistente ----------

#[tauri::command]
fn chat_list(a: State<'_, Arc<Assistant>>) -> Vec<Value> {
    a.list()
}

#[tauri::command]
fn chat_new(a: State<'_, Arc<Assistant>>) -> Value {
    a.create()
}

#[tauri::command]
fn chat_rename(a: State<'_, Arc<Assistant>>, conv_id: String, title: String) {
    a.rename(&conv_id, &title);
}

#[tauri::command]
fn chat_delete(a: State<'_, Arc<Assistant>>, conv_id: String) -> Result<(), String> {
    a.remove(&conv_id)
}

#[tauri::command]
fn chat_history(a: State<'_, Arc<Assistant>>, conv_id: String) -> Vec<Value> {
    a.history(&conv_id)
}

/// Igual que en Electron, la promesa se resuelve cuando termina la respuesta.
#[tauri::command]
async fn chat_send(a: State<'_, Arc<Assistant>>, conv_id: String, text: String) -> Result<(), String> {
    a.inner().clone().send(conv_id, text).await
}

#[tauri::command]
fn chat_stop(a: State<'_, Arc<Assistant>>, conv_id: String) {
    a.stop(&conv_id);
}

#[tauri::command]
fn chat_approve(a: State<'_, Arc<Assistant>>, id: String, approved: bool) {
    a.approve(&id, approved);
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
    // Claude Code lanza este mismo binario como servidor MCP del asistente.
    if std::env::args().any(|a| a == "--mcp") {
        mcp_server::run();
        return;
    }
    let store = Store::open();
    let dir = store.dir.clone();
    let activity = Arc::new(Activity::new());
    let claude = Arc::new(ClaudeRunner::new(dir.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Ptys::default())
        .manage(sysmon::SysMon::default())
        .manage(store)
        .manage(activity.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let calendar = CalendarSync::new(claude.clone(), handle.clone());
            let mail = MailSync::new(&dir, claude.clone(), activity.clone(), handle.clone());
            calendar.start();
            mail.start();

            let bridge = Bridge::start();
            let h = handle.clone();
            let assistant = Assistant::new(
                dir.join("asistente"),
                claude.clone(),
                bridge.clone(),
                handle.clone(),
                move || h.state::<Store>().settings()["assistant"]["model"].as_str().unwrap_or("sonnet").to_string(),
                // El servidor MCP de tickets llega con la etapa 3 del port.
                || None,
            );
            assistant.start()?;
            let (h, a) = (handle.clone(), assistant.clone());
            let h2 = handle.clone();
            let reminders = Reminders::new(
                &dir,
                move |r| {
                    let _ = h.emit("reminder:fire", &r);
                    a.add_event(&format!("⏰ Recordatorio: {}", r.text));
                },
                move || {
                    let _ = h2.emit("reminders:changed", ());
                },
            );
            reminders.start();
            rt_tools::register(&bridge, handle.clone(), reminders.clone(), calendar.clone(), mail.clone());

            app.manage(calendar);
            app.manage(mail);
            app.manage(assistant);
            app.manage(reminders);
            Ok(())
        })
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
            calendar_get,
            calendar_refresh,
            mail_get,
            mail_refresh,
            mail_summarize,
            mail_lists,
            notify::notify,
            reminders_list,
            reminders_add,
            reminders_remove,
            chat_list,
            chat_new,
            chat_rename,
            chat_delete,
            chat_history,
            chat_send,
            chat_stop,
            chat_approve,
            sysmon::sys_stats,
            pick_folder,
            open_url,
            js_log,
            quit,
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(focused) => {
                let app = window.app_handle();
                app.state::<Arc<Activity>>().set_focused(*focused);
                if *focused {
                    if let Some(mail) = app.try_state::<Arc<MailSync>>() {
                        mail.sync_if_stale();
                    }
                }
            }
            WindowEvent::CloseRequested { .. } => {
                let app = window.app_handle();
                save_with_current_cwds(app);
                app.state::<Ptys>().kill_all();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar rollerterm-tauri");
}
