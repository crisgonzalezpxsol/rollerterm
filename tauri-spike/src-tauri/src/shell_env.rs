// Ejecutar CLIs del usuario (claude, railway) como si se corrieran desde su terminal.
// Equivale a src/main/shell-env.ts.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// Variables que Claude Code pone en sus procesos hijos: si la app se lanzó desde una
// sesión de Claude Code, los CLIs creerían que corren anidados.
const INHERITED_CLAUDE_VARS: [&str; 9] = [
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
];

#[derive(Clone)]
pub struct Command {
    pub bin: String,
    pub env: HashMap<String, String>,
}

pub struct ExecOut {
    pub stdout: String,
    pub stderr: String,
    /// Error del proceso (timeout, código de salida), si hubo.
    pub exit_error: Option<String>,
}

/// Busca un comando con el PATH de una shell interactiva: abierta desde el menú de
/// aplicaciones, la app no hereda el PATH de la terminal (~/.local/bin, nvm…).
pub async fn find_command(name: &str) -> Option<Command> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for v in INHERITED_CLAUDE_VARS {
        env.remove(v);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let script = format!(r#"printf "__RT__%s__RT__%s__RT__" "$PATH" "$(command -v {name})""#);
    let out = exec(&shell, &["-ilc".into(), script], &env, None, "", Duration::from_secs(15))
        .await
        .ok()?;
    let mut parts = out.stdout.split("__RT__");
    let (_, path, bin) = (parts.next()?, parts.next()?, parts.next()?);
    if !path.is_empty() {
        env.insert("PATH".into(), path.into());
    }
    (!bin.is_empty()).then(|| Command { bin: bin.into(), env })
}

pub async fn exec(
    bin: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: Option<&Path>,
    input: &str,
    timeout: Duration,
) -> Result<ExecOut, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo ejecutar {bin}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
    }
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => return Err(format!("cortado por timeout ({} s)", timeout.as_secs())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_error = (!output.status.success()).then(|| format!("salió con {}", output.status));
    // Algunos CLIs salen con código ≠ 0 y aun así escriben el resultado.
    if exit_error.is_some() && stdout.is_empty() {
        let parts: Vec<&str> = [exit_error.as_deref().unwrap_or(""), stderr.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
        return Err(parts.join(" · "));
    }
    Ok(ExecOut { stdout, stderr, exit_error })
}
