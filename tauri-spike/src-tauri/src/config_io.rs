// Exportar e importar la configuración: un solo .json con los ajustes, las direcciones de
// correo importantes y bloqueadas, las notas, los recordatorios pendientes y las pestañas.
// Importar suma (notas, recordatorios, correos, pestañas) y reemplaza los ajustes.
// Mismo formato que Electron (src/main/config-io.ts): un archivo sirve para las dos.

use crate::mail::MailSync;
use crate::reminders::{Reminder, Reminders};
use crate::store::Store;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn downloads(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().download_dir().ok()
}

/// Guarda todo en un archivo .json que elige el usuario; None si canceló.
#[tauri::command]
pub async fn config_export(app: AppHandle, ui: Value) -> Result<Option<String>, String> {
    let today = chrono::Local::now().format("%Y-%m-%d");
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Exportar configuración")
        .set_file_name(format!("rollerterm-config-{today}.json"))
        .add_filter("Configuración de rollerterm", &["json"]);
    if let Some(d) = downloads(&app) {
        dialog = dialog.set_directory(d);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };

    let store = app.state::<Store>();
    let mail = app.state::<Arc<MailSync>>();
    let reminders = app.state::<Arc<Reminders>>();
    let (vip, blocked) = mail.lists();
    let notes = store.all_notes();
    let pending = reminders.pending();
    let session = store.load_session();
    let tabs = session.as_ref().and_then(|s| s["tabs"].as_array()).map(|t| t.len()).unwrap_or(0);
    let bundle = json!({
        "app": "rollerterm",
        "version": 1,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "settings": store.settings(),
        "mail": { "vip": vip, "blocked": blocked },
        "notes": notes,
        "reminders": pending,
        "session": session,
        "ui": ui,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&bundle).unwrap()).map_err(|e| e.to_string())?;

    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let detail = [
        plural(notes.len(), "nota", "notas"),
        plural(pending.len(), "recordatorio", "recordatorios"),
        plural(vip.len(), "correo importante", "correos importantes"),
        plural(blocked.len(), "correo bloqueado", "correos bloqueados"),
        plural(tabs, "pestaña", "pestañas"),
    ]
    .join(" · ");
    let listo = app
        .dialog()
        .message(format!("{name}\n\n{detail}"))
        .title("Configuración exportada")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Listo".into(), "Mostrar en la carpeta".into()))
        .blocking_show();
    if !listo {
        if let Some(dir) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Pide un archivo, confirma y aplica; None si canceló o no era válido.
#[tauri::command]
pub async fn config_import(app: AppHandle) -> Result<Option<Value>, String> {
    let mut dialog = app.dialog().file().set_title("Importar configuración").add_filter("Configuración de rollerterm", &["json"]);
    if let Some(d) = downloads(&app) {
        dialog = dialog.set_directory(d);
    }
    let Some(path) = dialog.blocking_pick_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };

    let bundle: Value = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
        .and_then(|b| if b["app"] == "rollerterm" { Ok(b) } else { Err("no es un archivo de configuración de rollerterm".into()) })
    {
        Ok(b) => b,
        Err(e) => {
            app.dialog().message(e).title("No se pudo importar").kind(MessageDialogKind::Error).blocking_show();
            return Ok(None);
        }
    };
    let notes: Vec<Value> = bundle["notes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["id"].is_string() && n["text"].is_string())
        .cloned()
        .collect();
    let reminders: Vec<Reminder> = bundle["reminders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| serde_json::from_value(r.clone()).ok())
        .collect();
    let strings = |v: &Value| -> Vec<String> {
        v.as_array().into_iter().flatten().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()
    };
    let vip = strings(&bundle["mail"]["vip"]);
    let blocked = strings(&bundle["mail"]["blocked"]);
    let session = if bundle["session"]["tabs"].is_array() { bundle["session"].clone() } else { Value::Null };
    let tabs = session["tabs"].as_array().map(|t| t.len()).unwrap_or(0);

    let exported = bundle["exportedAt"]
        .as_str()
        .and_then(crate::util::parse_iso_ms)
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|d| format!(" (exportada el {})", d.with_timezone(&chrono::Local).format("%d/%m/%Y, %H:%M:%S")))
        .unwrap_or_default();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let detail = format!(
        "{name}{exported}\n\n• Ajustes: se reemplazan por los del archivo.\n• Se suman {}, {}, {}, {} y {}.\n\nNo se borra nada: si una nota ya existe, queda la versión más nueva. Las pestañas que ya están abiertas no se tocan.",
        plural(notes.len(), "nota", "notas"),
        plural(reminders.len(), "recordatorio", "recordatorios"),
        plural(vip.len(), "correo importante", "correos importantes"),
        plural(blocked.len(), "correo bloqueado", "correos bloqueados"),
        plural(tabs, "pestaña", "pestañas"),
    );
    let confirmed = app
        .dialog()
        .message(detail)
        .title("¿Importar esta configuración?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Importar".into(), "Cancelar".into()))
        .blocking_show();
    if !confirmed {
        return Ok(None);
    }

    let store = app.state::<Store>();
    let settings = if bundle["settings"].is_object() { store.replace_settings(bundle["settings"].clone())? } else { store.settings() };
    let mail = app.state::<Arc<MailSync>>();
    let (cur_vip, cur_blocked) = mail.lists();
    mail.set_lists([cur_vip, vip].concat(), [cur_blocked, blocked].concat());
    store.merge_notes(notes)?;
    app.state::<Arc<Reminders>>().merge(reminders);
    let _ = app.emit("notes:changed", ());
    let ui = if bundle["ui"].is_object() { bundle["ui"].clone() } else { json!({}) };
    Ok(Some(json!({ "settings": settings, "session": session, "ui": ui })))
}
