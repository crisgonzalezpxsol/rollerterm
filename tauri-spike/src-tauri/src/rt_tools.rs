// Herramientas de rollerterm para el asistente (las atiende el puente): notas,
// recordatorios y lo que la app ya está mostrando. Equivale a los bridge.on de main.ts.

use crate::bridge::Bridge;
use crate::calendar::CalendarSync;
use crate::mail::MailSync;
use crate::reminders::Reminders;
use crate::store::Store;
use crate::util::{now_ms, parse_iso_ms};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// "18/11/2026, 15:00:00", como toLocaleString("es-AR", { hourCycle: "h23" }) en Electron.
fn local_text(iso: &str) -> String {
    parse_iso_ms(iso)
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|d| d.with_timezone(&chrono::Local).format("%d/%m/%Y, %H:%M:%S").to_string())
        .unwrap_or_else(|| iso.into())
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn register(
    bridge: &Bridge,
    app: AppHandle,
    reminders: Arc<Reminders>,
    calendar: Arc<CalendarSync>,
    mail: Arc<MailSync>,
) {
    let a = app.clone();
    bridge.on("crear_nota", move |args, _| {
        let app = a.clone();
        async move {
            let now = now_ms();
            let client = text(&args["cliente"]).trim().to_string();
            let tags: Vec<String> = args["etiquetas"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| text(t).trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            let id = uuid::Uuid::new_v4().to_string();
            let mut note = json!({ "id": id, "text": text(&args["texto"]), "createdAt": now, "updatedAt": now });
            if !client.is_empty() {
                note["client"] = json!(client);
            }
            if !tags.is_empty() {
                note["tags"] = json!(tags);
            }
            if let Err(e) = app.state::<Store>().save_note(note) {
                return json!({ "error": e });
            }
            let _ = app.emit("notes:changed", ());
            json!({ "ok": true, "id": id })
        }
    });

    let a = app.clone();
    bridge.on("buscar_notas", move |args, _| {
        let app = a.clone();
        async move {
            let needle = text(&args["q"]).to_lowercase();
            let client = text(&args["cliente"]).trim().to_lowercase();
            let notes = app.state::<Store>().all_notes();
            let found: Vec<Value> = notes
                .iter()
                .filter(|n| client.is_empty() || text(&n["client"]).trim().to_lowercase() == client)
                .filter(|n| {
                    if needle.is_empty() {
                        return true;
                    }
                    let mut fields = vec![text(&n["text"]), text(&n["client"])];
                    fields.extend(n["tags"].as_array().into_iter().flatten().map(text));
                    fields.iter().any(|s| s.to_lowercase().contains(&needle))
                })
                .take(30)
                .map(|n| {
                    let edited = n["updatedAt"]
                        .as_i64()
                        .and_then(chrono::DateTime::from_timestamp_millis)
                        .map(|d| d.to_rfc3339())
                        .unwrap_or_default();
                    json!({
                        "id": n["id"], "texto": n["text"],
                        "cliente": if n["client"].is_string() { n["client"].clone() } else { Value::Null },
                        "etiquetas": n["tags"].as_array().cloned().unwrap_or_default(),
                        "editada": edited
                    })
                })
                .collect();
            json!(found)
        }
    });

    let r = reminders.clone();
    bridge.on("crear_recordatorio", move |args, _| {
        let r = r.clone();
        async move {
            let note = Some(text(&args["nota_id"])).filter(|s| !s.is_empty());
            match r.add(&text(&args["cuando"]), &text(&args["texto"]), note) {
                Ok(rem) => json!({ "ok": true, "id": rem.id, "cuando": local_text(&rem.when) }),
                Err(e) => json!({ "error": e }),
            }
        }
    });

    let r = reminders.clone();
    bridge.on("listar_recordatorios", move |_, _| {
        let r = r.clone();
        async move {
            json!(r
                .pending()
                .iter()
                .map(|x| json!({ "id": x.id, "cuando": local_text(&x.when), "texto": x.text }))
                .collect::<Vec<_>>())
        }
    });

    let r = reminders;
    bridge.on("borrar_recordatorio", move |args, _| {
        let r = r.clone();
        async move { json!({ "ok": r.remove(&text(&args["id"])) }) }
    });

    bridge.on("contexto_actual", move |_, _| {
        let (cal, m) = (calendar.current(), mail.current());
        async move {
            json!({
                "agenda": cal.events.iter().map(|e| json!({
                    "titulo": e.title, "inicio": e.start, "fin": e.end,
                    "videollamada": e.meet_url.as_deref().is_some_and(|u| !u.is_empty()),
                    "rechazado": e.declined
                })).collect::<Vec<_>>(),
                "correo": {
                    "importantes": m.vip,
                    "hilos": m.threads.iter().take(25).map(|x| json!({
                        "de": x.from_email, "asunto": x.subject, "fecha": x.date, "sinLeer": x.unread, "extracto": x.snippet
                    })).collect::<Vec<_>>()
                },
                // Tickets y producción llegan con la etapa 3 del port.
                "tickets": { "entorno": null, "mios": [], "sinDueno": [] },
                "produccion": []
            })
        }
    });
}
