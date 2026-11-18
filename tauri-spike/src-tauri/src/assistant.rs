// Asistente de la jornada: un chat con Claude Code que recuerda. Equivale a src/main/assistant.ts.
//
// - Varias conversaciones. La «Jornada» usa una sesión de Claude por día (--resume); las demás
//   son hilos aparte con su propia sesión, y pueden responder a la vez que la Jornada.
// - Memoria de largo plazo en archivos, en su carpeta de trabajo: memoria.md y diario/AAAA-MM-DD.md.
// - Herramientas: las de rollerterm (notas, recordatorios, contexto) por el MCP propio (este mismo
//   binario con --mcp), más Gmail, Google Calendar y tickets. Lo que tiene efecto afuera pasa por
//   --permission-prompt-tool y espera el OK del usuario en el chat.

use crate::bridge::Bridge;
use crate::claude_runner::{mcp_prefix, ClaudeRunner};
use crate::util::{now_ms, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

const HISTORY_LIMIT: usize = 600;
/// La conversación de la jornada: siempre existe y no se borra.
const DAILY_ID: &str = "jornada";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const GMAIL: &str = "mcp__claude_ai_Gmail__";
const CAL: &str = "mcp__claude_ai_Google_Calendar__";
const RT: &str = "mcp__rollerterm__";
const KEPT_SERVERS: [&str; 2] = ["claude.ai Gmail", "claude.ai Google Calendar"];
const SAFE_TICKET_TOOLS: [&str; 4] = ["listar_tickets", "ver_ticket", "preguntar", "analizar_ticket"];

/// Se usan sin preguntar: leen, o escriben solo en lo propio del usuario (notas, borradores).
fn safe_tools() -> Vec<String> {
    let mut v: Vec<String> = ["Read", "Write", "Edit", "Glob", "Grep"].map(String::from).to_vec();
    v.extend(
        ["crear_nota", "buscar_notas", "crear_recordatorio", "listar_recordatorios", "borrar_recordatorio", "contexto_actual"]
            .map(|t| format!("{RT}{t}")),
    );
    v.extend(
        ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "get_draft", "create_draft", "update_draft"]
            .map(|t| format!("{GMAIL}{t}")),
    );
    v.extend(["list_events", "get_event", "search_events", "list_calendars", "suggest_time"].map(|t| format!("{CAL}{t}")));
    v
}

/// Instrucciones que Claude Code carga solo desde la carpeta de trabajo. Las mantiene la app.
const INSTRUCTIONS: &str = r#"# Asistente de la jornada (rollerterm)

Sos el asistente de la jornada laboral del usuario, dentro de la app rollerterm. El usuario te
cuenta qué está haciendo durante el día y te pide cosas: recordar, anotar, buscar y responder
correos, mirar la agenda y los tickets. Respondé en español rioplatense, breve y al grano.

## Memoria

Esta carpeta es tu memoria de largo plazo; la conversación de cada día empieza de cero.

- `memoria.md`: lo durable — personas y su rol, proyectos, clientes, preferencias, compromisos
  que siguen abiertos. Leela al empezar cada jornada (primer mensaje del día).
- `diario/AAAA-MM-DD.md`: el diario de cada día — qué hizo, qué decidió, qué quedó pendiente.

Después de cada intercambio que deje algo para recordar, actualizá el diario de hoy (agregando,
sin reescribir lo anterior) y, si es algo durable, `memoria.md`. Hacelo en silencio: no
digas «registro en el diario» ni nada parecido, el usuario no necesita enterarse.
Cuando pregunten por otro día o por algo pasado («¿qué hablé con René la semana pasada?»),
buscá en `diario/` con Grep y Read antes de responder. No inventes: si no está, decilo.

## Herramientas

- `contexto_actual` (rollerterm): lo que la app ya muestra — agenda, correos, tickets,
  producción. Usala primero para «¿qué tengo hoy?», «¿algo urgente?».
- `crear_nota`, `buscar_notas`: las notas del panel de notas.
- `crear_recordatorio`: para «recordame…». Hora local, ISO 8601. Confirmá la hora en la respuesta.
- Gmail, Google Calendar y tickets de Pxsol Agencias: para buscar, leer y resumir.

## Acciones con efecto afuera

Enviar o responder correos, crear o cambiar eventos, comentar o cambiar tickets: la app le
muestra al usuario lo que vas a hacer y espera su aprobación. Antes de pedirlo, mostrá en tu
respuesta el texto final (destinatario, asunto, cuerpo). Si el usuario no pidió enviar,
preferí crear un borrador. Si rechaza, no insistas: preguntá qué cambiar.
"#;

const WEEKDAYS: [&str; 7] = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const MONTHS: [&str; 12] = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

fn day_key(d: chrono::DateTime<chrono::Local>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// "martes, 18 de noviembre de 2026, 17:30", como toLocaleString("es-AR") en Electron.
fn long_date(d: chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike, Timelike};
    format!(
        "{}, {} de {} de {}, {:02}:{:02}",
        WEEKDAYS[d.weekday().num_days_from_monday() as usize],
        d.day(),
        MONTHS[d.month0() as usize],
        d.year(),
        d.hour(),
        d.minute()
    )
}

/// Nombre corto para mostrar qué herramienta está usando ("📧 Gmail · search_threads").
fn tool_label(name: &str) -> String {
    let t = name.rsplit("__").next().unwrap_or(name);
    if name.starts_with(GMAIL) {
        return format!("📧 Gmail · {t}");
    }
    if name.starts_with(CAL) {
        return format!("📅 Calendario · {t}");
    }
    if name.starts_with(RT) {
        return match t {
            "crear_nota" => "📝 Creando nota".into(),
            "buscar_notas" => "📝 Buscando notas".into(),
            "crear_recordatorio" => "⏰ Programando recordatorio".into(),
            "listar_recordatorios" => "⏰ Viendo recordatorios".into(),
            "borrar_recordatorio" => "⏰ Cancelando recordatorio".into(),
            "contexto_actual" => "👀 Mirando la app".into(),
            _ => format!("rollerterm · {t}"),
        };
    }
    if name.starts_with("mcp__") {
        return format!("🎫 Tickets · {t}");
    }
    match name {
        "Read" | "Grep" | "Glob" => "🧠 Consultando memoria".into(),
        "Write" | "Edit" => "🧠 Guardando en memoria".into(),
        _ => name.into(),
    }
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(show).collect::<Vec<_>>().join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Descripción legible de una acción que necesita aprobación.
fn describe(tool: &str, input: &Value) -> String {
    let empty = serde_json::Map::new();
    let obj = input.as_object().unwrap_or(&empty);
    let mut used: HashSet<&str> = HashSet::new();
    let mut get = |keys: &[&'static str]| -> Option<Value> {
        let k = keys.iter().find(|k| obj.get(**k).is_some_and(|v| !v.is_null() && v != ""))?;
        used.insert(k);
        obj.get(*k).cloned()
    };
    let to = get(&["to", "toRecipients", "recipients", "attendees"]);
    let cc = get(&["cc", "ccRecipients"]);
    let subject = get(&["subject", "summary", "title", "asunto"]);
    let start = get(&["startTime", "start", "inicio"]);
    let end = get(&["endTime", "end", "fin"]);
    let place = get(&["location", "lugar"]);
    let ticket = get(&["ticket", "numero"]);
    let state = get(&["estado", "status"]);
    let body = get(&["body", "plaintextBody", "text", "description", "comentario", "mensaje", "texto"]);
    let when = |v: &Value| {
        let text = show(v);
        match parse_iso_ms(&text).and_then(chrono::DateTime::from_timestamp_millis) {
            Some(d) => {
                use chrono::Datelike;
                let d = d.with_timezone(&chrono::Local);
                let wd = &WEEKDAYS[d.weekday().num_days_from_monday() as usize][..3];
                format!("{wd} {}", d.format("%d/%m %H:%M"))
            }
            None => text,
        }
    };
    let mut lines = vec![tool_label(tool)];
    if let Some(v) = &to {
        lines.push(format!("Para: {}", show(v)));
    }
    if let Some(v) = &cc {
        lines.push(format!("CC: {}", show(v)));
    }
    if let Some(v) = &ticket {
        lines.push(format!("Ticket: #{}", show(v).trim_start_matches('#')));
    }
    if let Some(v) = &subject {
        lines.push(format!("Asunto: {}", show(v)));
    }
    if let Some(v) = &start {
        let end = end.as_ref().map(|e| format!(" → {}", when(e))).unwrap_or_default();
        lines.push(format!("Cuándo: {}{end}", when(v)));
    }
    if let Some(v) = &place {
        lines.push(format!("Dónde: {}", show(v)));
    }
    if let Some(v) = &state {
        lines.push(format!("Estado nuevo: {}", show(v)));
    }
    // Lo demás que sea corto también se muestra: mejor de más que una sorpresa.
    for (k, v) in obj {
        if used.contains(k.as_str()) || v.is_null() || v == "" {
            continue;
        }
        let text = show(v);
        if text.chars().count() <= 120 {
            lines.push(format!("{k}: {text}"));
        }
    }
    if let Some(v) = &body {
        lines.push(String::new());
        lines.push(show(v).chars().take(2000).collect());
    }
    lines.join("\n")
}

/// Lo que se guarda de cada conversación (sin el estado en vivo).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConversation {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    daily: bool,
    /// Sesión de Claude de un hilo aparte (la Jornada usa una por día, en sesiones.json).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    session_id: Option<String>,
    /// Ya tuvo una respuesta: los mensajes siguientes van con --resume.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    started: Option<bool>,
}

pub struct Assistant {
    dir: PathBuf,
    convs: Mutex<Vec<StoredConversation>>,
    histories: Mutex<HashMap<String, Vec<Value>>>,
    sessions: Mutex<HashMap<String, String>>,
    /// Respuestas en curso: mandar por el canal las corta.
    children: Mutex<HashMap<String, oneshot::Sender<()>>>,
    approvals: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
    claude: Arc<ClaudeRunner>,
    bridge: Arc<Bridge>,
    app: AppHandle,
    model: Box<dyn Fn() -> String + Send + Sync>,
    ticket_server: Box<dyn Fn() -> Option<String> + Send + Sync>,
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Assistant {
    pub fn new(
        dir: PathBuf,
        claude: Arc<ClaudeRunner>,
        bridge: Arc<Bridge>,
        app: AppHandle,
        model: impl Fn() -> String + Send + Sync + 'static,
        ticket_server: impl Fn() -> Option<String> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Assistant {
            dir,
            convs: Mutex::new(vec![]),
            histories: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            claude,
            bridge,
            app,
            model: Box::new(model),
            ticket_server: Box::new(ticket_server),
        })
    }

    fn emit(&self, conv_id: &str, mut event: Value) {
        event["convId"] = json!(conv_id);
        let _ = self.app.emit("chat:event", event);
    }

    fn file(&self, conv_id: &str) -> PathBuf {
        // La Jornada sigue en chat.jsonl (así no se mueve el historial que ya había).
        if conv_id == DAILY_ID {
            self.dir.join("chat.jsonl")
        } else {
            self.dir.join("conversaciones").join(format!("{conv_id}.jsonl"))
        }
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let d = &self.dir;
        std::fs::create_dir_all(d.join("diario")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(d.join("conversaciones")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(d.join(".claude")).map_err(|e| e.to_string())?;
        let _ = std::fs::write(d.join("CLAUDE.md"), INSTRUCTIONS);
        // El MCP de rollerterm va como servidor del proyecto (.mcp.json en la carpeta) y no con
        // --mcp-config: así Claude arranca en ~3 s sin esperar a todos los conectores de la cuenta.
        // Es este mismo binario con --mcp; el puerto y el token del puente llegan por el entorno.
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let mcp = json!({
            "mcpServers": {
                "rollerterm": {
                    "command": exe,
                    "args": ["--mcp"],
                    "env": { "RT_BRIDGE": "${RT_BRIDGE}", "RT_TOKEN": "${RT_TOKEN}", "RT_CONV": "${RT_CONV}" }
                }
            }
        });
        let _ = std::fs::write(d.join(".mcp.json"), serde_json::to_string_pretty(&mcp).unwrap());
        let _ = std::fs::write(
            d.join(".claude").join("settings.local.json"),
            serde_json::to_string_pretty(&json!({ "enabledMcpjsonServers": ["rollerterm"] })).unwrap(),
        );
        if !d.join("memoria.md").exists() {
            let _ = std::fs::write(d.join("memoria.md"), "# Memoria\n\nLo que conviene recordar siempre.\n");
        }
        let mut convs: Vec<StoredConversation> = std::fs::read_to_string(d.join("conversaciones.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        if !convs.iter().any(|c| c.id == DAILY_ID) {
            let now = now_ms();
            convs.insert(0, StoredConversation {
                id: DAILY_ID.into(),
                title: "Jornada".into(),
                created_at: now,
                updated_at: now,
                daily: true,
                session_id: None,
                started: None,
            });
        }
        *self.convs.lock().unwrap() = convs;
        self.save_index();
        *self.sessions.lock().unwrap() = std::fs::read_to_string(d.join("sesiones.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let me = self.clone();
        self.bridge.on("aprobar", move |args, conv| {
            let me = me.clone();
            async move { me.request_approval(args, conv.unwrap_or(DAILY_ID.into())).await }
        });
        Ok(())
    }

    pub fn list(&self) -> Vec<Value> {
        let busy = self.children.lock().unwrap();
        self.convs
            .lock()
            .unwrap()
            .iter()
            .map(|c| {
                json!({
                    "id": c.id, "title": c.title, "createdAt": c.created_at, "updatedAt": c.updated_at,
                    "daily": c.daily, "busy": busy.contains_key(&c.id)
                })
            })
            .collect()
    }

    fn changed(&self) {
        self.emit(DAILY_ID, json!({ "type": "conversations", "list": self.list() }));
    }

    pub fn history(&self, conv_id: &str) -> Vec<Value> {
        if let Some(h) = self.histories.lock().unwrap().get(conv_id) {
            return h.clone();
        }
        let messages: Vec<Value> = std::fs::read_to_string(self.file(conv_id))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let start = messages.len().saturating_sub(HISTORY_LIMIT);
        let messages = messages[start..].to_vec();
        self.histories.lock().unwrap().insert(conv_id.into(), messages.clone());
        messages
    }

    pub fn create(&self) -> Value {
        let now = now_ms();
        let conv = StoredConversation {
            id: uuid(),
            title: "Conversación nueva".into(),
            created_at: now,
            updated_at: now,
            daily: false,
            session_id: Some(uuid()),
            started: None,
        };
        let id = conv.id.clone();
        self.convs.lock().unwrap().push(conv);
        self.histories.lock().unwrap().insert(id.clone(), vec![]);
        self.save_index();
        self.changed();
        self.list().into_iter().find(|c| c["id"] == id.as_str()).unwrap_or(Value::Null)
    }

    pub fn rename(&self, conv_id: &str, title: &str) {
        let title = title.trim();
        if title.is_empty() {
            return;
        }
        if let Some(c) = self.convs.lock().unwrap().iter_mut().find(|c| c.id == conv_id) {
            c.title = title.chars().take(80).collect();
        }
        self.save_index();
        self.changed();
    }

    pub fn remove(&self, conv_id: &str) -> Result<(), String> {
        if conv_id == DAILY_ID {
            return Err("La conversación de la jornada no se borra.".into());
        }
        self.stop(conv_id);
        self.convs.lock().unwrap().retain(|c| c.id != conv_id);
        self.histories.lock().unwrap().remove(conv_id);
        let _ = std::fs::remove_file(self.file(conv_id));
        self.save_index();
        self.changed();
        Ok(())
    }

    /// Un mensaje que no es de la conversación (un recordatorio que sonó, por ejemplo). Va a la Jornada.
    pub fn add_event(&self, text: &str) {
        let message = json!({ "id": uuid(), "role": "event", "text": text, "at": now_ms() });
        self.append(DAILY_ID, &message);
        self.emit(DAILY_ID, json!({ "type": "event", "message": message }));
    }

    pub fn stop(&self, conv_id: &str) {
        if let Some(tx) = self.children.lock().unwrap().remove(conv_id) {
            let _ = tx.send(());
        }
        let mut approvals = self.approvals.lock().unwrap();
        let ids: Vec<String> = approvals.iter().filter(|(_, (c, _))| c == conv_id).map(|(id, _)| id.clone()).collect();
        for id in ids {
            if let Some((_, tx)) = approvals.remove(&id) {
                let _ = tx.send(false);
            }
        }
    }

    pub fn approve(&self, id: &str, approved: bool) {
        let Some((conv, tx)) = self.approvals.lock().unwrap().remove(id) else { return };
        let _ = tx.send(approved);
        self.emit(&conv, json!({ "type": "approval-done", "id": id, "approved": approved }));
    }

    pub async fn send(self: Arc<Self>, conv_id: String, text: String) -> Result<(), String> {
        let conv = self
            .convs
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.id == conv_id)
            .cloned()
            .ok_or("Esa conversación ya no existe.")?;
        if self.children.lock().unwrap().contains_key(&conv_id) {
            return Err("Esperá a que termine la respuesta anterior.".into());
        }
        let user = json!({ "id": uuid(), "role": "user", "text": text, "at": now_ms() });
        self.history(&conv_id);
        self.append(&conv_id, &user);
        {
            let mut convs = self.convs.lock().unwrap();
            if let Some(c) = convs.iter_mut().find(|c| c.id == conv_id) {
                // El primer mensaje le pone nombre a un hilo nuevo.
                if !c.daily && c.title == "Conversación nueva" {
                    c.title = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(48).collect();
                }
                c.updated_at = now_ms();
            }
        }
        self.save_index();

        let (message, _) = if conv.daily {
            let day = day_key(chrono::Local::now());
            let resume = self.sessions.lock().unwrap().get(&day).cloned();
            let mut reply = self.run(&conv_id, &text, resume.clone().unwrap_or_else(uuid), resume.is_some()).await;
            // Si la sesión del día ya no existe (se borró la caché de Claude Code), se empieza otra.
            if reply.1 {
                reply = self.run(&conv_id, &text, uuid(), false).await;
            }
            reply
        } else {
            let session = conv.session_id.clone().unwrap_or_else(uuid);
            let mut reply = self.run(&conv_id, &text, session.clone(), conv.started == Some(true)).await;
            let mut session = session;
            if reply.1 {
                session = uuid();
                reply = self.run(&conv_id, &text, session.clone(), false).await;
            }
            if let Some(c) = self.convs.lock().unwrap().iter_mut().find(|c| c.id == conv_id) {
                c.session_id = Some(session);
                c.started = Some(true);
            }
            self.save_index();
            reply
        };
        self.append(&conv_id, &message);
        self.emit(&conv_id, json!({ "type": "done", "message": message }));
        Ok(())
    }

    /// Una respuesta de Claude, transmitida a la ventana mientras llega.
    /// Devuelve (mensaje, la sesión a retomar ya no existe).
    async fn run(&self, conv_id: &str, text: &str, session_id: String, resume: bool) -> (Value, bool) {
        let message_id = uuid();
        self.emit(conv_id, json!({ "type": "start", "messageId": message_id }));
        let fail = |t: String| (json!({ "id": message_id, "role": "assistant", "text": t, "at": now_ms(), "error": true }), false);

        let Some(cmd) = self.claude.command().await else {
            return fail("No encontré Claude Code (`claude`). Instalalo y logueate (ver README).".into());
        };
        // Solo los servidores que el asistente usa: cargar todos cuesta cientos de miles de tokens.
        let ticket_server = (self.ticket_server)();
        let mut keep: HashSet<String> = KEPT_SERVERS.map(String::from).into_iter().collect();
        if let Some(t) = &ticket_server {
            keep.insert(t.clone());
        }
        let denied: Vec<String> =
            self.claude.server_names().await.into_iter().filter(|s| !keep.contains(s)).map(|s| mcp_prefix(&s)).collect();
        let ticket_tools: Vec<String> = ticket_server
            .map(|t| SAFE_TICKET_TOOLS.iter().map(|x| format!("{}__{x}", mcp_prefix(&t))).collect())
            .unwrap_or_default();

        let now = chrono::Local::now();
        let mut args: Vec<String> = vec!["-p".into(), "--model".into(), (self.model)()];
        args.extend(["--output-format", "stream-json", "--verbose", "--include-partial-messages"].map(String::from));
        if resume {
            args.extend(["--resume".into(), session_id.clone()]);
        } else {
            args.extend(["--session-id".into(), session_id.clone()]);
        }
        args.push("--append-system-prompt".into());
        args.push(format!("Ahora es {} (hora local, {}).", long_date(now), day_key(now)));
        args.extend(
            [
                "--permission-mode", "acceptEdits",
                "--permission-prompt-tool", &format!("{RT}aprobar"),
                "--tools", "Read,Write,Edit,Glob,Grep",
                "--disable-slash-commands",
                "--allowedTools",
            ]
            .map(String::from),
        );
        args.extend(safe_tools());
        args.extend(ticket_tools);
        args.push("--disallowedTools".into());
        args.extend(denied);

        let mut env = cmd.env.clone();
        env.insert("RT_BRIDGE".into(), self.bridge.url.clone());
        env.insert("RT_TOKEN".into(), self.bridge.token.clone());
        env.insert("RT_CONV".into(), conv_id.into());
        let spawned = tokio::process::Command::new(&cmd.bin)
            .args(&args)
            .env_clear()
            .envs(&env)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => return fail(format!("No pude ejecutar Claude Code: {e}")),
        };
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
        self.children.lock().unwrap().insert(conv_id.into(), cancel_tx);
        self.changed();
        // El prompt va por stdin: --allowedTools y --disallowedTools se comerían un argumento suelto.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        let mut stderr_pipe = child.stderr.take().unwrap();
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf).await;
            let s = String::from_utf8_lossy(&buf).into_owned();
            let skip = s.chars().count().saturating_sub(4000);
            s.chars().skip(skip).collect::<String>()
        });
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

        let mut full = String::new();
        let mut needs_break = false;
        let mut tools: Vec<String> = vec![];
        let mut result_text: Option<String> = None;
        let mut is_error = false;
        let deadline = tokio::time::sleep(RESPONSE_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break };
                    let Ok(m) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    match m["type"].as_str() {
                        Some("stream_event") => {
                            let ev = &m["event"];
                            // Un turno nuevo del modelo (después de usar una herramienta): párrafo aparte.
                            if ev["type"] == "message_start" && !full.is_empty() {
                                needs_break = true;
                            }
                            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                                if let Some(t) = ev["delta"]["text"].as_str().filter(|t| !t.is_empty()) {
                                    let delta = format!("{}{t}", if needs_break { "\n\n" } else { "" });
                                    needs_break = false;
                                    full.push_str(&delta);
                                    self.emit(conv_id, json!({ "type": "text", "messageId": message_id, "delta": delta }));
                                }
                            }
                        }
                        Some("assistant") => {
                            for c in m["message"]["content"].as_array().into_iter().flatten() {
                                if let (Some("tool_use"), Some(name)) = (c["type"].as_str(), c["name"].as_str()) {
                                    let label = tool_label(name);
                                    if !tools.contains(&label) {
                                        tools.push(label.clone());
                                    }
                                    self.emit(conv_id, json!({ "type": "tool", "messageId": message_id, "label": label }));
                                }
                            }
                        }
                        Some("result") => {
                            result_text = m["result"].as_str().map(String::from);
                            is_error = m["is_error"] == true;
                        }
                        _ => {}
                    }
                }
                _ = &mut cancel_rx => { let _ = child.kill().await; break; }
                _ = &mut deadline => { let _ = child.kill().await; break; }
            }
        }
        let _ = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        self.children.lock().unwrap().remove(conv_id);
        self.changed();

        let haystack = format!("{stderr}{}", result_text.as_deref().unwrap_or("")).to_lowercase();
        let missing = resume && (haystack.contains("no conversation found") || (haystack.contains("session") && haystack.contains("not found")));
        if missing {
            return (Value::Null, true);
        }
        // La sesión existe desde que Claude arrancó; si no, el próximo --resume cae en "missing" y se rehace.
        let daily = self.convs.lock().unwrap().iter().any(|c| c.id == conv_id && c.daily);
        if daily {
            self.save_session(&day_key(now), &session_id);
        }
        let text_out = if full.trim().is_empty() { result_text.clone().unwrap_or_default() } else { full.clone() };
        let text_out = text_out.trim();
        if text_out.is_empty() {
            let why = if is_error {
                result_text.unwrap_or_default()
            } else {
                let l: Vec<&str> = stderr.trim().lines().collect();
                l[l.len().saturating_sub(3)..].join(" ")
            };
            return fail(if why.is_empty() { "La respuesta se cortó.".into() } else { format!("No pude responder: {why}") });
        }
        let mut message = json!({ "id": message_id, "role": "assistant", "text": text_out, "at": now_ms(), "tools": tools });
        if is_error {
            message["error"] = json!(true);
        }
        (message, false)
    }

    async fn request_approval(&self, args: Value, conv: String) -> Value {
        let tool = args["tool_name"].as_str().unwrap_or("").to_string();
        let input = if args["input"].is_object() { args["input"].clone() } else { json!({}) };
        let summary = describe(&tool, &input);
        let id = uuid();
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().unwrap().insert(id.clone(), (conv.clone(), tx));
        self.emit(&conv, json!({ "type": "approval", "request": { "id": id, "tool": tool, "summary": summary, "input": input } }));
        let approved = rx.await.unwrap_or(false);
        let first = summary.lines().next().unwrap_or("");
        let message = json!({
            "id": uuid(), "role": "event",
            "text": format!("{}: {first}", if approved { "✅ Aprobado" } else { "🚫 Rechazado" }),
            "at": now_ms()
        });
        self.append(&conv, &message);
        self.emit(&conv, json!({ "type": "event", "message": message }));
        if approved {
            json!({ "behavior": "allow", "updatedInput": input })
        } else {
            json!({ "behavior": "deny", "message": "El usuario no lo aprobó. No lo vuelvas a intentar; preguntale qué cambiar." })
        }
    }

    fn save_session(&self, day: &str, id: &str) {
        let sessions = {
            let mut s = self.sessions.lock().unwrap();
            if s.get(day).map(String::as_str) == Some(id) {
                return;
            }
            s.insert(day.into(), id.into());
            s.clone()
        };
        let _ = std::fs::write(self.dir.join("sesiones.json"), serde_json::to_string_pretty(&sessions).unwrap());
    }

    fn append(&self, conv_id: &str, message: &Value) {
        if message["role"] == "assistant" && message["text"].as_str().is_none_or(str::is_empty) {
            return;
        }
        self.history(conv_id);
        {
            let mut h = self.histories.lock().unwrap();
            let list = h.entry(conv_id.into()).or_default();
            list.push(message.clone());
            let excess = list.len().saturating_sub(HISTORY_LIMIT);
            list.drain(..excess);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.file(conv_id)) {
            let _ = writeln!(f, "{message}");
        }
    }

    fn save_index(&self) {
        let convs = self.convs.lock().unwrap().clone();
        let _ = std::fs::write(self.dir.join("conversaciones.json"), serde_json::to_string_pretty(&convs).unwrap());
    }
}
