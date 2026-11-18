// Cliente MCP mínimo por stdio: lanza un servidor tal como lo tiene configurado Claude Code
// (~/.claude.json → mcpServers), llama herramientas y lo cierra. Sin pasar por Claude.
// Equivale a src/main/mcp-client.ts.

use crate::shell_env::find_command;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

#[derive(Clone)]
pub struct ServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// Carpeta del proyecto, para los servidores de proyecto: se lanzan parados ahí (sus rutas pueden ser relativas).
    pub cwd: Option<String>,
}

fn stdio_servers(servers: &Value, cwd: Option<&str>) -> Vec<ServerConfig> {
    servers
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, c)| {
            let command = c["command"].as_str()?;
            let t = c["type"].as_str().unwrap_or("stdio");
            (t == "stdio").then(|| ServerConfig {
                name: name.clone(),
                command: command.into(),
                args: c["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect(),
                env: c["env"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                    .collect(),
                cwd: cwd.map(String::from),
            })
        })
        .collect()
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Servidores MCP por stdio configurados en Claude Code: los de cada proyecto (alcance local, en
/// ~/.claude.json, y el .mcp.json del repo) y los de usuario. Con la prioridad de Claude Code
/// (local, proyecto, usuario); si un nombre se repite, queda el primero.
pub fn list_servers() -> Vec<ServerConfig> {
    let home = std::env::var("HOME").unwrap_or_default();
    let Some(parsed) = read_json(std::path::Path::new(&format!("{home}/.claude.json"))) else {
        return vec![];
    };
    let projects: Vec<(&String, &Value)> = parsed["projects"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(dir, _)| std::path::Path::new(dir).is_dir())
        .collect();
    let mut all: Vec<ServerConfig> = projects.iter().flat_map(|(dir, p)| stdio_servers(&p["mcpServers"], Some(dir))).collect();
    for (dir, _) in &projects {
        if let Some(file) = read_json(&std::path::Path::new(dir).join(".mcp.json")) {
            all.extend(stdio_servers(&file["mcpServers"], Some(dir)));
        }
    }
    all.extend(stdio_servers(&parsed["mcpServers"], None));
    let mut seen = std::collections::HashSet::new();
    all.into_iter().filter(|s| seen.insert(s.name.clone())).collect()
}

/// "${VAR}" → valor del entorno, como hace Claude Code al lanzar el servidor.
fn expand(value: &str, env: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find('}') {
            Some(end) => {
                let var = &rest[start + 2..start + 2 + end];
                out.push_str(env.get(var).map(String::as_str).unwrap_or(""));
                rest = &rest[start + 3 + end..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Session {
    name: String,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    next: AtomicU64,
    /// Por qué terminó el servidor, si terminó.
    dead: Arc<Mutex<Option<String>>>,
    _child: Child,
}

impl Session {
    async fn open(cfg: &ServerConfig) -> Result<Arc<Session>, String> {
        // `node` (o lo que sea) se busca con el PATH de la terminal: con nvm no está en el PATH de la app.
        let (bin, base_env) = if cfg.command.starts_with('/') {
            (cfg.command.clone(), std::env::vars().collect::<HashMap<_, _>>())
        } else {
            let found = find_command(&cfg.command)
                .await
                .ok_or_else(|| format!("No se encontró el comando «{}» del servidor MCP {}.", cfg.command, cfg.name))?;
            (found.bin, found.env)
        };
        let mut env = base_env.clone();
        for (k, v) in &cfg.env {
            env.insert(k.clone(), expand(v, &base_env));
        }
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(&cfg.args)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &cfg.cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd.spawn().map_err(|e| format!("No se pudo lanzar el servidor MCP {}: {e}", cfg.name))?;

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let mut stderr = child.stderr.take().unwrap();
        let sb = stderr_buf.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut s = sb.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&chunk[..n]));
                let skip = s.len().saturating_sub(2000);
                if skip > 0 {
                    let cut = (skip..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                    s.drain(..cut);
                }
            }
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(Mutex::new(None));
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let (p, d, name) = (pending.clone(), dead.clone(), cfg.name.clone());
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                // Una línea que no es JSON-RPC se ignora (el protocolo exige que no las haya).
                let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                let Some(id) = msg["id"].as_u64() else { continue };
                let Some(tx) = p.lock().unwrap().remove(&id) else { continue };
                let _ = tx.send(match msg.get("error") {
                    Some(e) if !e.is_null() => Err(e["message"].as_str().unwrap_or("error del servidor MCP").to_string()),
                    _ => Ok(msg["result"].clone()),
                });
            }
            let why = format!("El servidor MCP {name} terminó. {}", stderr_buf.lock().unwrap().trim()).trim().to_string();
            *d.lock().unwrap() = Some(why.clone());
            for (_, tx) in p.lock().unwrap().drain() {
                let _ = tx.send(Err(why.clone()));
            }
        });

        let stdin = child.stdin.take().unwrap();
        Ok(Arc::new(Session {
            name: cfg.name.clone(),
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            next: AtomicU64::new(1),
            dead,
            _child: child,
        }))
    }

    async fn write(&self, msg: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{msg}\n").as_bytes())
            .await
            .map_err(|e| format!("No se pudo hablar con el servidor MCP {}: {e}", self.name))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(why) = self.dead.lock().unwrap().clone() {
            return Err(why);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        rx.await.unwrap_or_else(|_| Err(format!("El servidor MCP {} terminó.", self.name)))
    }

    /// Llama una herramienta. Las que devuelven `{ error }` en su contenido se vuelven errores.
    pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        let res = self.request("tools/call", json!({ "name": name, "arguments": args })).await?;
        let text = res["content"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["type"] == "text")
            .and_then(|c| c["text"].as_str())
            .unwrap_or("null")
            .to_string();
        let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text.clone()));
        let has_error = data.get("error").is_some_and(|e| !e.is_null());
        if res["isError"] == true || has_error {
            return Err(match data.get("error") {
                Some(Value::String(s)) => s.clone(),
                Some(e) if !e.is_null() => e.to_string(),
                _ => text,
            });
        }
        Ok(data)
    }
}

/// Abre una sesión con el servidor, corre `f` y lo cierra.
pub async fn with_mcp<T, F, Fut>(cfg: &ServerConfig, timeout: Duration, f: F) -> Result<T, String>
where
    F: FnOnce(Arc<Session>) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let work = async {
        let session = Session::open(cfg).await?;
        session
            .request(
                "initialize",
                json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "rollerterm", "version": "0.1.0" } }),
            )
            .await?;
        session.write(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        f(session).await
    };
    // Al terminar (o al vencer el tiempo) se suelta la sesión y el servidor se cierra.
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or_else(|_| Err(format!("El servidor MCP {} no respondió a tiempo.", cfg.name)))
}
