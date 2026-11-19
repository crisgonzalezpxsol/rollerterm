// Consumo de Claude Code en la barra de título: lee los logs que Claude Code deja en
// ~/.claude/projects/**/*.jsonl (cada respuesta trae su `usage`) y suma tokens y un costo
// estimado a precio de API. Solo lee archivos, y de a pedazos (lo nuevo).
// Equivale a src/main/claude-usage.ts.

use crate::util::{every, now_ms, parse_iso_ms};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CHECK_EVERY: Duration = Duration::from_secs(60);
/// Se mira una semana; un día de margen para que el corte "7 días" no pierda nada.
const KEEP_MS: i64 = 8 * 24 * 60 * 60_000;
/// Las ventanas de uso del plan duran 5 h desde el primer mensaje (redondeado a la hora).
const BLOCK_MS: i64 = 5 * 60 * 60_000;

/// USD por millón de tokens: (input, output, lectura de caché). Escritura de caché: 1,25× (5 min) o 2× (1 h) del input.
/// El orden importa: gana el primer patrón que coincide (los más específicos arriba).
const PRICES: [(&[&str], (f64, f64, f64)); 9] = [
    (&["fable", "mythos"], (10.0, 50.0, 0.25)),
    (&["opus-5-5"], (4.0, 20.0, 0.2)),
    (&["opus-4-1", "opus-4-0", "opus-4-2025", "claude-3-opus"], (15.0, 75.0, 1.5)),
    (&["opus"], (5.0, 25.0, 0.5)),
    (&["sonnet-5"], (2.0, 10.0, 0.2)),
    (&["sonnet"], (3.0, 15.0, 0.3)),
    (&["haiku-5"], (0.1, 0.5, 0.01)),
    (&["haiku-3-5"], (0.8, 4.0, 0.08)),
    (&["haiku"], (1.0, 5.0, 0.1)),
];

fn cost_of(model: &str, u: &Value) -> f64 {
    let Some((_, (input, output, cache_read))) = PRICES.iter().find(|(pats, _)| pats.iter().any(|p| model.contains(p))) else {
        return 0.0;
    };
    let n = |v: &Value| v.as_f64().unwrap_or(0.0);
    let write = n(&u["cache_creation_input_tokens"]);
    let cc = &u["cache_creation"];
    let write1h = n(&cc["ephemeral_1h_input_tokens"]);
    let write5m = if cc.is_object() { n(&cc["ephemeral_5m_input_tokens"]) } else { write };
    let usd = (n(&u["input_tokens"]) * input
        + n(&u["output_tokens"]) * output
        + write5m * input * 1.25
        + write1h * input * 2.0
        + n(&u["cache_read_input_tokens"]) * cache_read)
        / 1e6;
    // El modo rápido cuesta el doble.
    if u["speed"] == "fast" { usd * 2.0 } else { usd }
}

/// "claude-opus-5-5" → "Opus 5.5".
fn model_label(model: &str) -> String {
    let Some(rest) = model.find("claude-").map(|i| &model[i + 7..]) else { return model.into() };
    let name: String = rest.chars().take_while(|c| c.is_ascii_lowercase()).collect();
    let rest = &rest[name.len()..];
    let Some(rest) = rest.strip_prefix('-') else { return model.into() };
    let major: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if name.is_empty() || major.is_empty() {
        return model.into();
    }
    let rest = &rest[major.len()..];
    let minor = rest
        .strip_prefix('-')
        .map(|r| r.chars().take_while(char::is_ascii_digit).collect::<String>())
        .filter(|m| (1..=2).contains(&m.len()) && {
            let after = &rest[1 + m.len()..];
            after.is_empty() || after.starts_with('-')
        });
    let mut chars = name.chars();
    let cap: String = chars.next().map(|c| c.to_ascii_uppercase()).into_iter().chain(chars).collect();
    match minor {
        Some(m) => format!("{cap} {major}.{m}"),
        None => format!("{cap} {major}"),
    }
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    cost: f64,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    messages: u64,
}

#[derive(Clone)]
struct Entry {
    ts: i64,
    model: String,
    project: String,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    cost: f64,
}

impl Totals {
    fn add(&mut self, e: &Entry) {
        self.cost += e.cost;
        self.input += e.input;
        self.output += e.output;
        self.cache_write += e.cache_write;
        self.cache_read += e.cache_read;
        self.messages += 1;
    }
}

#[derive(Clone, Serialize)]
pub struct Block {
    start: i64,
    end: i64,
    totals: Totals,
}

#[derive(Clone, Serialize)]
pub struct Row {
    name: String,
    cost: f64,
    tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageState {
    status: String,
    last_check: Option<i64>,
    today: Totals,
    week: Totals,
    block: Option<Block>,
    models: Vec<Row>,
    projects: Vec<Row>,
}

struct Inner {
    /// Hasta dónde se leyó cada archivo (bytes).
    offsets: HashMap<PathBuf, u64>,
    /// Una entrada por respuesta: Claude Code repite la misma respuesta en varias líneas.
    entries: HashMap<String, Entry>,
}

pub struct ClaudeUsage {
    state: Mutex<UsageState>,
    inner: Mutex<Inner>,
    app: AppHandle,
}

impl ClaudeUsage {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(ClaudeUsage {
            state: Mutex::new(UsageState {
                status: "loading".into(),
                last_check: None,
                today: Totals::default(),
                week: Totals::default(),
                block: None,
                models: vec![],
                projects: vec![],
            }),
            inner: Mutex::new(Inner { offsets: HashMap::new(), entries: HashMap::new() }),
            app,
        })
    }

    pub fn current(&self) -> UsageState {
        self.state.lock().unwrap().clone()
    }

    pub fn start(self: &Arc<Self>) {
        self.spawn_check();
        let (a, b) = (self.clone(), self.clone());
        every(CHECK_EVERY, move || a.spawn_check(), move || b.spawn_check());
    }

    pub fn spawn_check(self: &Arc<Self>) {
        let me = self.clone();
        // Leer archivos es bloqueante: fuera de los hilos de tokio que atienden la ventana.
        tauri::async_runtime::spawn_blocking(move || me.check());
    }

    fn check(&self) {
        let Ok(mut inner) = self.inner.try_lock() else { return }; // ya hay una vuelta en curso
        let since = now_ms() - KEEP_MS;
        let root = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude").join("projects");
        let mut files = vec![];
        recent_files(&root, 0, since, &mut files);
        for (path, size) in files {
            read_new(&mut inner, &path, size);
        }
        inner.entries.retain(|_, e| e.ts >= since);
        let state = summarize(&inner.entries);
        drop(inner);
        *self.state.lock().unwrap() = state.clone();
        let _ = self.app.emit("usage:state", state);
    }
}

/// Los .jsonl tocados en la última semana (incluye los de subagentes, en subcarpetas).
fn recent_files(dir: &Path, depth: u32, since: i64, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for it in items.flatten() {
        let path = it.path();
        let Ok(meta) = it.metadata() else { continue };
        if meta.is_dir() {
            if depth < 3 && it.file_name() != "memory" {
                recent_files(&path, depth + 1, since, out);
            }
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mtime >= since {
                out.push((path, meta.len()));
            }
        }
    }
}

/// Lee solo lo agregado desde la última vez (los logs crecen al final).
fn read_new(inner: &mut Inner, path: &Path, size: u64) {
    let mut from = inner.offsets.get(path).copied().unwrap_or(0);
    if size < from {
        from = 0; // se reescribió
    }
    if size == from {
        return;
    }
    let Ok(mut f) = std::fs::File::open(path) else { return };
    if f.seek(SeekFrom::Start(from)).is_err() {
        return;
    }
    let mut buf = Vec::with_capacity((size - from) as usize);
    if f.take(size - from).read_to_end(&mut buf).is_err() {
        return;
    }
    let mut consumed = from;
    let mut start = 0;
    while start < buf.len() {
        let end = buf[start..].iter().position(|&b| b == b'\n').map(|p| start + p);
        let line = &buf[start..end.unwrap_or(buf.len())];
        let complete = end.is_some() || serde_json::from_slice::<Value>(line).is_ok();
        // Una línea a medio escribir se vuelve a leer en la próxima vuelta.
        if !complete {
            break;
        }
        if line.windows(7).any(|w| w == b"\"usage\"") {
            parse(inner, line);
        }
        consumed += (line.len() + if end.is_some() { 1 } else { 0 }) as u64;
        start = end.map(|e| e + 1).unwrap_or(buf.len());
    }
    inner.offsets.insert(path.to_path_buf(), consumed.min(size));
}

fn parse(inner: &mut Inner, line: &[u8]) {
    let Ok(d) = serde_json::from_slice::<Value>(line) else { return };
    let msg = &d["message"];
    let model = msg["model"].as_str().unwrap_or("");
    if d["type"] != "assistant" || !msg["usage"].is_object() || model.is_empty() || model.starts_with('<') {
        return;
    }
    let Some(ts) = d["timestamp"].as_str().and_then(parse_iso_ms) else { return };
    let u = &msg["usage"];
    let key = format!(
        "{}:{}",
        msg["id"].as_str().unwrap_or(""),
        d["requestId"].as_str().map(String::from).unwrap_or_else(|| ts.to_string())
    );
    let cwd = d["cwd"].as_str().unwrap_or("");
    // El asistente de la app corre Claude Code desde su carpeta de datos.
    let project = if cwd.is_empty() {
        "?".into()
    } else if cwd.contains("/rollerterm-tauri/asistente") || cwd.contains("/rollerterm/asistente") || cwd.contains("Application Support/rollerterm") {
        "asistente de rollerterm".into()
    } else {
        Path::new(cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(cwd.into())
    };
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    inner.entries.insert(key, Entry {
        ts,
        model: model.into(),
        project,
        input: n(&u["input_tokens"]),
        output: n(&u["output_tokens"]),
        cache_write: n(&u["cache_creation_input_tokens"]),
        cache_read: n(&u["cache_read_input_tokens"]),
        cost: cost_of(model, u),
    });
}

fn summarize(entries: &HashMap<String, Entry>) -> UsageState {
    use chrono::{Local, TimeZone, Timelike};
    let now = now_ms();
    let midnight = Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|n| Local.from_local_datetime(&n).single())
        .map(|d| d.timestamp_millis())
        .unwrap_or(now);
    let week_ago = now - 7 * 24 * 60 * 60_000;
    let mut today = Totals::default();
    let mut week = Totals::default();
    let mut models: HashMap<String, Row> = HashMap::new();
    let mut projects: HashMap<String, Row> = HashMap::new();
    let mut sorted: Vec<&Entry> = entries.values().collect();
    sorted.sort_by_key(|e| e.ts);

    // Ventana de 5 h como las del plan: arranca a la hora en punto del primer mensaje y,
    // pasadas las 5 h, la próxima arranca con el siguiente mensaje.
    let mut block: Option<Block> = None;
    for e in sorted {
        if e.ts >= week_ago {
            week.add(e);
        }
        if e.ts >= now - 2 * BLOCK_MS {
            if block.as_ref().is_none_or(|b| e.ts >= b.end) {
                let start = Local
                    .timestamp_millis_opt(e.ts)
                    .single()
                    .and_then(|d| d.with_minute(0)?.with_second(0)?.with_nanosecond(0))
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(e.ts);
                block = Some(Block { start, end: start + BLOCK_MS, totals: Totals::default() });
            }
            if let Some(b) = block.as_mut() {
                b.totals.add(e);
            }
        }
        if e.ts < midnight {
            continue;
        }
        today.add(e);
        let tokens = e.input + e.output + e.cache_write + e.cache_read;
        let label = model_label(&e.model);
        let m = models.entry(label.clone()).or_insert(Row { name: label, cost: 0.0, tokens: 0 });
        m.cost += e.cost;
        m.tokens += tokens;
        let p = projects.entry(e.project.clone()).or_insert(Row { name: e.project.clone(), cost: 0.0, tokens: 0 });
        p.cost += e.cost;
        p.tokens += tokens;
    }
    let by_cost = |a: &Row, b: &Row| b.cost.total_cmp(&a.cost);
    let mut models: Vec<Row> = models.into_values().collect();
    models.sort_by(by_cost);
    let mut projects: Vec<Row> = projects.into_values().collect();
    projects.sort_by(by_cost);
    projects.truncate(6);
    UsageState {
        status: "ok".into(),
        last_check: Some(now),
        today,
        week,
        block: block.filter(|b| b.end > now),
        models,
        projects,
    }
}
