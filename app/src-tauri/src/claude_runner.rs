// Ejecuta Claude Code en modo -p para leer conectores de claude.ai (Google Calendar,
// Gmail) con la cuenta logueada. No hay credenciales de Google en la app.
// Equivale a src/main/claude-runner.ts.
//
// Para que cada consulta sea barata se usa Haiku, sin herramientas propias de Claude
// Code, y se bloquean todos los demás servidores MCP: si no, al usar una herramienta
// MCP se cargan las definiciones de todos los conectores (cientos de miles de tokens).

use crate::shell_env::{exec, find_command, Command};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex;

/// Pausas entre reintentos cuando el conector no respondió (lo típico: estaba "pending").
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(8), Duration::from_secs(20)];
const LOG_MAX_BYTES: u64 = 1_000_000;

pub struct QueryOptions<'a> {
    /// Servidor MCP a usar, tal como lo nombra Claude Code ("claude.ai Gmail").
    pub server: &'a str,
    /// Herramientas permitidas; al menos una tiene que responder para que la consulta valga.
    pub allow: Vec<String>,
    /// Herramientas de ese mismo servidor que se prohíben explícitamente (las que escriben).
    pub deny: Vec<String>,
    pub prompt: String,
    pub schema: Value,
    pub timeout: Duration,
}

pub struct QueryResult {
    /// Un ConnectorStatus: "connected", "disconnected", "not-configured", "no-claude", "error".
    pub status: &'static str,
    pub message: Option<String>,
    /// Detalle técnico para copiar y diagnosticar, cuando algo falló.
    pub detail: Option<String>,
    /// Solo presente si status == "connected".
    pub output: Option<Value>,
}

impl QueryResult {
    fn fail(status: &'static str, message: impl Into<String>, detail: String) -> Self {
        QueryResult { status, message: Some(message.into()), detail: Some(detail), output: None }
    }
}

struct RunOutput {
    messages: Vec<Value>,
    stderr: String,
    exit_error: Option<String>,
}

pub struct ClaudeRunner {
    dir: PathBuf,
    claude: Mutex<Option<Command>>,
    /// Nombres de todos los servidores MCP de la cuenta, para bloquear los que no se usan.
    servers: std::sync::Mutex<Option<Vec<String>>>,
    probing: Mutex<()>,
    /// Las consultas de fondo van en fila, una por vez (ver `query`).
    queue: Mutex<()>,
}

impl ClaudeRunner {
    pub fn new(dir: PathBuf) -> Self {
        ClaudeRunner {
            dir,
            claude: Mutex::new(None),
            servers: std::sync::Mutex::new(None),
            probing: Mutex::new(()),
            queue: Mutex::new(()),
        }
    }

    /// El comando `claude` (con el PATH de la terminal), o None si no está instalado.
    pub async fn command(&self) -> Option<Command> {
        let mut c = self.claude.lock().await;
        if c.is_none() {
            *c = find_command("claude").await;
        }
        c.clone()
    }

    /// Nombres de todos los servidores MCP de la cuenta (se averiguan una vez).
    pub async fn server_names(&self) -> Vec<String> {
        if self.command().await.is_none() {
            return vec![];
        }
        self.ensure_servers().await;
        self.servers.lock().unwrap().clone().unwrap_or_default()
    }

    async fn ensure_servers(&self) {
        let _probing = self.probing.lock().await;
        if self.servers.lock().unwrap().is_none() {
            // Consulta mínima (sin herramientas) solo para conocer los servidores MCP.
            let _ = self.run("Respondé ok.", Duration::from_secs(60), &["--max-turns".into(), "1".into()]).await;
        }
    }

    /// Consulta de fondo (agenda, correo, resúmenes). Van de a una: varias instancias de Claude
    /// Code a la vez hacen que los conectores tarden más en conectar y queden "pending".
    pub async fn query(&self, opts: QueryOptions<'_>) -> QueryResult {
        let _turn = self.queue.lock().await;
        if self.command().await.is_none() {
            return QueryResult {
                status: "no-claude",
                message: Some("No se encontró el comando `claude` (Claude Code).".into()),
                detail: None,
                output: None,
            };
        }
        self.ensure_servers().await;

        let mut res = self.attempt(&opts).await;
        // Un conector que tropieza unos segundos no se marca como desconectado: se reintenta.
        for delay in RETRY_DELAYS {
            if res.status != "disconnected" && res.status != "error" {
                break;
            }
            tokio::time::sleep(delay).await;
            res = self.attempt(&opts).await;
        }
        if let Some(d) = &res.detail {
            self.log(d);
        }
        res
    }

    async fn attempt(&self, opts: &QueryOptions<'_>) -> QueryResult {
        let label = opts.server.trim_start_matches("claude.ai ");
        let denied: Vec<String> = self
            .servers
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default()
            .iter()
            .filter(|s| s.as_str() != opts.server)
            .map(|s| mcp_prefix(s))
            .collect();
        let mut extra = vec!["--allowedTools".to_string()];
        extra.extend(opts.allow.iter().cloned());
        extra.push("--disallowedTools".into());
        extra.extend(opts.deny.iter().cloned());
        extra.extend(denied);
        extra.push("--json-schema".into());
        extra.push(opts.schema.to_string());

        let out = match self.run(&opts.prompt, opts.timeout, &extra).await {
            Ok(o) => o,
            Err(message) => {
                let detail = self.describe(opts, None, &message).await;
                return QueryResult::fail("error", message, detail);
            }
        };
        let msgs = &out.messages;
        let init = msgs.iter().find(|m| m["type"] == "system" && m["subtype"] == "init");
        let result = msgs.iter().find(|m| m["type"] == "result");
        let init_servers = init.and_then(|i| i["mcp_servers"].as_array());
        let server = init_servers.and_then(|ss| ss.iter().find(|s| s["name"] == opts.server));
        let server_status = server.and_then(|s| s["status"].as_str()).unwrap_or("");

        // Un resultado vacío solo vale si de verdad se llamó al conector y respondió sin error.
        let content: Vec<&Value> = msgs
            .iter()
            .filter_map(|m| m["message"]["content"].as_array())
            .flatten()
            .collect();
        let call_ids: HashSet<&str> = content
            .iter()
            .filter(|c| c["type"] == "tool_use" && opts.allow.iter().any(|a| c["name"] == a.as_str()))
            .filter_map(|c| c["id"].as_str())
            .collect();
        let is_call_result = |c: &&&Value| {
            c["type"] == "tool_result" && c["tool_use_id"].as_str().is_some_and(|id| call_ids.contains(id))
        };
        let answered = content.iter().filter(is_call_result).any(|c| c["is_error"] != true);
        let result_error = result.is_some_and(|r| r["is_error"] == true);

        if let Some(output) = result.map(|r| &r["structured_output"]).filter(|o| !o.is_null()) {
            if answered && !result_error {
                return QueryResult { status: "connected", message: None, detail: None, output: Some(output.clone()) };
            }
        }
        let (status, message): (&'static str, String) = if init.is_some() && init_servers.is_none_or(|s| s.is_empty()) {
            // Un init sin ningún servidor MCP no prueba que falte el conector: no llegaron a cargar.
            ("error", "Claude Code arrancó sin cargar los conectores de claude.ai.".into())
        } else if init.is_some() && server.is_none() {
            ("not-configured", format!("Tu cuenta de Claude no tiene el conector de {label}."))
        } else if server.is_some() && server_status != "connected" && server_status != "pending" {
            ("disconnected", format!("El conector de {label} está en estado \"{server_status}\"."))
        } else if init.is_none() {
            ("error", "Claude Code no arrancó la sesión (ver detalle).".into())
        } else if result_error {
            let r = result.and_then(|r| r["result"].as_str()).filter(|s| !s.is_empty());
            ("error", r.unwrap_or("Claude Code devolvió un error.").to_string())
        } else if let Some(err) = content.iter().filter(is_call_result).find(|c| c["is_error"] == true) {
            ("disconnected", format!("El conector de {label} devolvió un error: {}", short(&err["content"], 200)))
        } else if call_ids.is_empty() {
            ("disconnected", format!("Claude no llegó a usar el conector de {label} (estado al arrancar: \"{server_status}\")."))
        } else {
            ("disconnected", format!("El conector de {label} no respondió."))
        };
        let detail = self.describe(opts, Some(&out), &message).await;
        QueryResult::fail(status, message, detail)
    }

    /// Texto técnico de una consulta fallida, para copiar y pegar al diagnosticar.
    async fn describe(&self, opts: &QueryOptions<'_>, out: Option<&RunOutput>, message: &str) -> String {
        let bin = self.claude.lock().await.as_ref().map(|c| c.bin.clone()).unwrap_or("?".into());
        let mut lines = vec![
            format!("rollerterm · {} · {}", chrono::Utc::now().to_rfc3339(), opts.server),
            format!("motivo: {message}"),
            format!("claude: {bin}"),
            format!("permitidas: {}", opts.allow.join(", ")),
        ];
        if let Some(out) = out {
            let init = out.messages.iter().find(|m| m["type"] == "system" && m["subtype"] == "init");
            let get = |k: &str| init.and_then(|i| i[k].as_str()).unwrap_or("?").to_string();
            let status = init
                .and_then(|i| i["mcp_servers"].as_array())
                .and_then(|ss| ss.iter().find(|s| s["name"] == opts.server))
                .and_then(|s| s["status"].as_str())
                .unwrap_or("(no figura)");
            let tools: Vec<&str> = init.and_then(|i| i["tools"].as_array()).into_iter().flatten().filter_map(Value::as_str).collect();
            let available: Vec<&str> = opts.allow.iter().map(String::as_str).filter(|t| tools.contains(t)).collect();
            lines.push(format!("versión: {} · modelo: {}", get("claude_code_version"), get("model")));
            lines.push(format!("estado del conector al arrancar: {status}"));
            lines.push(format!(
                "herramientas permitidas disponibles: {}",
                if available.is_empty() { "(ninguna)".into() } else { available.join(", ") }
            ));
            for m in &out.messages {
                for c in m["message"]["content"].as_array().into_iter().flatten() {
                    match c["type"].as_str() {
                        Some("tool_use") => lines.push(format!("→ llamó {}", c["name"].as_str().unwrap_or("?"))),
                        Some("tool_result") => lines.push(format!(
                            "← respuesta{}: {}",
                            if c["is_error"] == true { " (ERROR)" } else { "" },
                            short(&c["content"], 400)
                        )),
                        Some("text") if m["type"] == "assistant" => lines.push(format!("texto: {}", short(&c["text"], 300))),
                        _ => {}
                    }
                }
            }
            let result = out.messages.iter().find(|m| m["type"] == "result");
            lines.push(match result {
                Some(r) => format!(
                    "resultado: {} · is_error={} · {}",
                    r["subtype"].as_str().unwrap_or("?"),
                    r["is_error"],
                    short(&r["result"], 400)
                ),
                None => "resultado: (sin resultado)".into(),
            });
            lines.push(format!("permisos denegados: {}", short(result.map(|r| &r["permission_denials"]).unwrap_or(&Value::Null), 300)));
            if let Some(e) = &out.exit_error {
                lines.push(format!("proceso: {e}"));
            }
            if !out.stderr.trim().is_empty() {
                lines.push(format!("stderr: {}", short(&Value::String(out.stderr.trim().into()), 800)));
            }
        }
        lines.join("\n")
    }

    async fn run(&self, prompt: &str, timeout: Duration, extra: &[String]) -> Result<RunOutput, String> {
        let Command { bin, env } = self.command().await.ok_or("No se encontró `claude`.")?;
        let mut args: Vec<String> = [
            "-p",
            "--model",
            "haiku",
            "--tools",
            "",
            "--disable-slash-commands",
            "--system-prompt",
            "Sos un lector de datos. Seguí las instrucciones al pie de la letra.",
            "--output-format",
            "stream-json",
            "--verbose",
        ]
        .map(String::from)
        .to_vec();
        args.extend(extra.iter().cloned());
        // Desde Claude Code 2.1.x los conectores de claude.ai arrancan "fully async": con esto
        // apagado, el arranque los espera y figuran en el init.
        let mut env = env;
        env.insert("MCP_CONNECTION_NONBLOCKING".into(), "0".into());
        // El prompt va por stdin: --allowedTools y --disallowedTools se comerían un argumento suelto.
        let out = exec(&bin, &args, &env, Some(&self.dir), prompt, timeout).await?;
        let messages: Vec<Value> = out.stdout.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        if let Some(servers) = messages
            .iter()
            .find(|m| m["type"] == "system" && m["subtype"] == "init")
            .and_then(|i| i["mcp_servers"].as_array())
        {
            let names = servers.iter().filter_map(|s| s["name"].as_str().map(String::from)).collect();
            *self.servers.lock().unwrap() = Some(names);
        }
        Ok(RunOutput { messages, stderr: out.stderr, exit_error: out.exit_error })
    }

    /// Guarda los fallos en claude.log, en la carpeta de datos (rota al pasar 1 MB).
    fn log(&self, detail: &str) {
        use std::io::Write;
        let file = self.dir.join("claude.log");
        if std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0) > LOG_MAX_BYTES {
            let _ = std::fs::rename(&file, self.dir.join("claude.log.1"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = write!(f, "{detail}\n\n");
        }
    }
}

/// Nombre de servidor MCP → prefijo de sus herramientas ("claude.ai Gmail" → "mcp__claude_ai_Gmail").
pub fn mcp_prefix(server: &str) -> String {
    let clean: String = server
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    format!("mcp__{clean}")
}

/// Hora local sin offset ("2026-10-15T09:30:00"), como la piden las herramientas de Google.
pub fn local_iso(d: chrono::DateTime<chrono::Local>) -> String {
    d.format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn short(value: &Value, max: usize) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    if text.chars().count() > max {
        format!("{}…", text.chars().take(max).collect::<String>())
    } else {
        text
    }
}
