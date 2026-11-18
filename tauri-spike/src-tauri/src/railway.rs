// Estado de producción en Railway, consultado con el CLI `railway` (con la sesión del
// usuario) y su API GraphQL de solo lectura. No usa Claude. Equivale a src/main/railway.ts.
//
// Además vigila que Railway efectivamente despliegue: compara la punta de la rama de cada
// servicio en GitHub (con `gh`) contra los deploys que Railway registró. Si pasan más de 3 h
// sin ningún deploy de ese commit, Railway no se enteró del push o lo dejó trabado.

use crate::shell_env::{exec, find_command, Command};
use crate::util::{every, now_ms, parse_iso_ms};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CHECK_EVERY: Duration = Duration::from_secs(2 * 60);
/// La lista de proyectos cambia poco: se vuelve a pedir cada tanto.
const PROJECTS_TTL_MS: i64 = 30 * 60_000;
const ENVIRONMENT: &str = "production";
const PARALLEL: usize = 4;
/// Cuánto se tolera sin deploy antes de avisar.
const STALE_AFTER_MS: i64 = 3 * 60 * 60_000;
/// La punta de cada rama en GitHub se vuelve a pedir cada tanto, no en cada vuelta.
const TIP_TTL_MS: i64 = 5 * 60_000;
const TIMEOUT: Duration = Duration::from_secs(30);

const QUERY: &str = r#"query($id: String!) {
  project(id: $id) {
    id
    name
    environments {
      edges {
        node {
          id
          name
          serviceInstances {
            edges {
              node {
                serviceId
                serviceName
                source { repo }
                latestDeployment { status createdAt meta creator { name } }
                activeDeployments { status }
              }
            }
          }
        }
      }
    }
  }
}"#;

/// Los últimos deploys de un entorno, con cualquier estado (también los salteados).
const DEPLOYS_QUERY: &str = r#"query($id: String!, $env: String!) {
  deployments(first: 100, input: { projectId: $id, environmentId: $env }) {
    edges { node { serviceId status meta } }
  }
}"#;

const DEPLOYING: [&str; 6] = ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"];
/// Sin deploy o dado de baja a propósito: no cuenta para la salud.
const IGNORED: [&str; 3] = ["REMOVED", "REMOVING", "SKIPPED"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdState {
    pub status: String,
    pub message: Option<String>,
    pub checking: bool,
    pub last_check: Option<i64>,
    pub services: Vec<Value>,
}

#[derive(Clone)]
struct Tip {
    sha: String,
    message: String,
    date: String,
}

fn health_of(i: &Value) -> Option<&'static str> {
    let status = i["latestDeployment"]["status"].as_str()?;
    if IGNORED.contains(&status) {
        return None;
    }
    let running = i["activeDeployments"].as_array().is_some_and(|a| !a.is_empty());
    Some(match status {
        "SUCCESS" | "SLEEPING" => "ok",
        "CRASHED" => "down",
        "FAILED" if running => "degraded",
        "FAILED" => "down",
        s if DEPLOYING.contains(&s) => "deploying",
        _ if running => "ok",
        _ => "down",
    })
}

fn str_or_null(v: &Value) -> Value {
    match v.as_str() {
        Some(s) if !s.is_empty() => json!(s),
        _ => Value::Null,
    }
}

pub struct RailwayMonitor {
    state: Mutex<ProdState>,
    railway: tokio::sync::Mutex<Option<Command>>,
    gh: tokio::sync::Mutex<Option<Option<Command>>>,
    projects: Mutex<Option<(Vec<Value>, i64)>>,
    tips: Mutex<HashMap<String, (Option<Tip>, i64)>>,
    /// Cuándo se vio llegar cada punta nueva (más fiel que la fecha del commit, que en un rebase es vieja).
    arrived: Mutex<HashMap<String, i64>>,
    settings: Box<dyn Fn() -> Value + Send + Sync>,
    app: AppHandle,
}

impl RailwayMonitor {
    pub fn new(settings: impl Fn() -> Value + Send + Sync + 'static, app: AppHandle) -> Arc<Self> {
        Arc::new(RailwayMonitor {
            state: Mutex::new(ProdState { status: "loading".into(), message: None, checking: false, last_check: None, services: vec![] }),
            railway: tokio::sync::Mutex::new(None),
            gh: tokio::sync::Mutex::new(None),
            projects: Mutex::new(None),
            tips: Mutex::new(HashMap::new()),
            arrived: Mutex::new(HashMap::new()),
            settings: Box::new(settings),
            app,
        })
    }

    pub fn current(&self) -> ProdState {
        self.state.lock().unwrap().clone()
    }

    pub fn start(self: &Arc<Self>) {
        self.spawn_check();
        let (a, b) = (self.clone(), self.clone());
        every(CHECK_EVERY, move || a.spawn_check(), move || b.spawn_check());
    }

    pub fn spawn_check(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.check().await });
    }

    async fn railway(&self) -> Option<Command> {
        let mut r = self.railway.lock().await;
        if r.is_none() {
            *r = find_command("railway").await;
        }
        r.clone()
    }

    async fn gh(&self) -> Option<Command> {
        let mut g = self.gh.lock().await;
        if g.is_none() {
            *g = Some(find_command("gh").await);
        }
        g.clone().flatten()
    }

    /// Proyectos con entorno "production" (se cachea media hora).
    pub async fn list_projects(&self) -> Result<Vec<Value>, String> {
        if let Some((list, at)) = self.projects.lock().unwrap().clone() {
            if now_ms() - at < PROJECTS_TTL_MS {
                return Ok(list);
            }
        }
        let Some(cmd) = self.railway().await else { return Ok(vec![]) };
        let out = exec(&cmd.bin, &["list".into(), "--json".into()], &cmd.env, None, "", TIMEOUT).await?;
        let parsed: Value = serde_json::from_str(&out.stdout).map_err(|e| format!("respuesta inválida de railway: {e}"))?;
        let list: Vec<Value> = parsed
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["environments"]["edges"].as_array().into_iter().flatten().any(|e| e["node"]["name"] == ENVIRONMENT)
            })
            .map(|p| {
                json!({
                    "id": p["id"], "name": p["name"],
                    "services": p["services"]["edges"].as_array().map(|a| a.len()).unwrap_or(0)
                })
            })
            .collect();
        *self.projects.lock().unwrap() = Some((list.clone(), now_ms()));
        Ok(list)
    }

    async fn check(self: Arc<Self>) {
        if self.current().checking {
            return;
        }
        let cfg = (self.settings)();
        if cfg["enabled"] == false {
            self.update(|s| {
                s.status = "disabled".into();
                s.message = None;
                s.services = vec![];
            });
            return;
        }
        self.update(|s| s.checking = true);
        let (status, message, services) = self.clone().gather(&cfg).await;
        self.update(|s| {
            s.status = status.into();
            s.message = message;
            if let Some(list) = services {
                s.services = list;
                s.last_check = Some(now_ms());
            }
            s.checking = false;
        });
    }

    async fn gather(self: Arc<Self>, cfg: &Value) -> (&'static str, Option<String>, Option<Vec<Value>>) {
        if self.railway().await.is_none() {
            return ("no-cli", Some("No se encontró el comando `railway` (Railway CLI).".into()), None);
        }
        let projects = match self.list_projects().await {
            Ok(p) => p,
            Err(text) => {
                let l = text.to_lowercase();
                let logged_out = l.contains("unauthorized") || l.contains("not logged in") || l.contains("login");
                return (if logged_out { "logged-out" } else { "error" }, Some(text), None);
            }
        };
        let watched: Vec<String> = projects
            .iter()
            .filter(|p| match cfg["projects"].as_array() {
                Some(ids) => ids.contains(&p["id"]),
                None => true,
            })
            .filter_map(|p| p["id"].as_str().map(String::from))
            .collect();
        // De a PARALLEL proyectos a la vez.
        let mut results: Vec<Result<Vec<Value>, String>> = vec![];
        for chunk in watched.chunks(PARALLEL) {
            let handles: Vec<_> = chunk
                .iter()
                .map(|id| {
                    let (me, id) = (self.clone(), id.clone());
                    tokio::spawn(async move { me.project_services(&id).await })
                })
                .collect();
            for h in handles {
                results.push(h.await.unwrap_or_else(|e| Err(e.to_string())));
            }
        }
        let failed: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
        // Si fallan todos, no hay foto de producción; si fallan algunos, se muestra lo que hay.
        if !watched.is_empty() && failed.len() == watched.len() {
            return ("error", Some(failed[0].clone()), None);
        }
        let message = (!failed.is_empty()).then(|| format!("No se pudieron consultar {} proyecto(s): {}", failed.len(), failed[0]));
        let mut services: Vec<Value> = results.into_iter().filter_map(Result::ok).flatten().collect();
        self.mark_stale(&mut services).await;
        ("ok", message, Some(services))
    }

    /// Marca los servicios en los que Railway lleva más de 3 h sin desplegar.
    async fn mark_stale(&self, services: &mut [Value]) {
        let now = now_ms();
        for s in services.iter_mut() {
            // Un deploy trabado en cola o construyendo.
            let since = s["since"].as_str().and_then(parse_iso_ms);
            if s["health"] == "deploying" && since.is_some_and(|t| now - t > STALE_AFTER_MS) {
                s["stale"] = json!({
                    "kind": "stuck", "repo": s["repo"], "branch": s["branch"],
                    "commit": s["commit"].as_str().map(|c| c.chars().take(7).collect::<String>()),
                    "message": null, "since": s["since"]
                });
            }
        }
        // Un push que no generó deploy: hace falta `gh` para saber cuál es la punta de la rama.
        let Some(gh) = self.gh().await else { return };
        let mut suspects: Vec<(usize, Tip, i64)> = vec![];
        for (i, s) in services.iter().enumerate() {
            let (Some(repo), Some(branch), Some(commit)) = (s["repo"].as_str(), s["branch"].as_str(), s["commit"].as_str()) else {
                continue;
            };
            if !s["stale"].is_null() {
                continue;
            }
            let Some(tip) = self.tip_of(&gh, repo, branch).await else { continue };
            if tip.sha == commit {
                continue;
            }
            let arrived = self.arrived.lock().unwrap().get(&format!("{repo}@{branch}@{}", tip.sha)).copied();
            let since = arrived.or_else(|| parse_iso_ms(&tip.date)).unwrap_or(now);
            if now - since > STALE_AFTER_MS {
                suspects.push((i, tip, since));
            }
        }
        if suspects.is_empty() {
            return;
        }
        // ¿Railway registró ALGÚN deploy de ese commit para ese servicio (aunque sea salteado)?
        let mut by_env: HashMap<String, Option<HashSet<String>>> = HashMap::new();
        for (i, tip, since) in suspects {
            let s = &services[i];
            let (project, env) = (s["projectId"].as_str().unwrap_or("").to_string(), s["environmentId"].as_str().unwrap_or("").to_string());
            let key = format!("{project}/{env}");
            if !by_env.contains_key(&key) {
                by_env.insert(key.clone(), self.deployed_commits(&project, &env).await.ok());
            }
            // Sin la lista no se puede afirmar que falte un deploy: se toma como que está todo.
            let Some(seen) = by_env[&key].as_ref() else { continue };
            if seen.contains(&format!("{}@{}", s["serviceId"].as_str().unwrap_or(""), tip.sha)) {
                continue;
            }
            let since_iso = chrono::DateTime::from_timestamp_millis(since).map(|d| d.to_rfc3339()).unwrap_or_default();
            let stale = json!({
                "kind": "missing", "repo": s["repo"], "branch": s["branch"],
                "commit": tip.sha.chars().take(7).collect::<String>(), "message": tip.message, "since": since_iso
            });
            services[i]["stale"] = stale;
        }
    }

    async fn railway_api(&self, vars: &[(&str, &str)], query: &str) -> Result<Value, String> {
        let cmd = self.railway().await.ok_or("No se encontró `railway`.")?;
        let mut args = vec!["api".to_string()];
        for (k, v) in vars {
            args.push("--var".into());
            args.push(format!("{k}={v}"));
        }
        args.extend(["-f".into(), "-".into()]);
        let out = exec(&cmd.bin, &args, &cmd.env, None, query, TIMEOUT).await?;
        let parsed: Value = serde_json::from_str(&out.stdout).map_err(|e| format!("respuesta inválida de railway: {e}"))?;
        if let Some(msg) = parsed["errors"].as_array().and_then(|e| e.first()).and_then(|e| e["message"].as_str()) {
            return Err(msg.into());
        }
        Ok(if parsed["data"].is_object() { parsed["data"].clone() } else { parsed })
    }

    /// "servicio@commit" de los últimos deploys del entorno, con cualquier estado.
    async fn deployed_commits(&self, project: &str, env: &str) -> Result<HashSet<String>, String> {
        let data = self.railway_api(&[("id", project), ("env", env)], DEPLOYS_QUERY).await?;
        let edges = data["deployments"]["edges"].as_array().ok_or("Respuesta sin deploys")?;
        Ok(edges
            .iter()
            .map(|e| format!("{}@{}", e["node"]["serviceId"].as_str().unwrap_or(""), e["node"]["meta"]["commitHash"].as_str().unwrap_or("")))
            .collect())
    }

    /// La punta de la rama en GitHub (cacheada unos minutos). None si `gh` no tiene acceso.
    async fn tip_of(&self, gh: &Command, repo: &str, branch: &str) -> Option<Tip> {
        let key = format!("{repo}@{branch}");
        let cached = self.tips.lock().unwrap().get(&key).cloned();
        if let Some((tip, at)) = &cached {
            if now_ms() - at < TIP_TTL_MS {
                return tip.clone();
            }
        }
        let branch_enc: String = branch
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect();
        let args = [
            "api".to_string(),
            format!("repos/{repo}/commits/{branch_enc}"),
            "--jq".into(),
            r#"{sha: .sha, message: (.commit.message | split("\n")[0]), date: .commit.committer.date}"#.into(),
        ];
        let fetched = exec(&gh.bin, &args, &gh.env, None, "", Duration::from_secs(20))
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Value>(&o.stdout).ok())
            .and_then(|v| Some(Tip { sha: v["sha"].as_str()?.into(), message: v["message"].as_str()?.into(), date: v["date"].as_str()?.into() }));
        // Sin red o sin acceso: lo último que se supo.
        let prev = cached.and_then(|(t, _)| t);
        let tip = fetched.or_else(|| prev.clone());
        // Si la punta cambió mientras la app miraba, la hora de llegada es ahora.
        if let (Some(t), Some(p)) = (&tip, &prev) {
            if t.sha != p.sha {
                self.arrived.lock().unwrap().insert(format!("{key}@{}", t.sha), now_ms());
            }
        }
        self.tips.lock().unwrap().insert(key, (tip.clone(), now_ms()));
        tip
    }

    async fn project_services(&self, project_id: &str) -> Result<Vec<Value>, String> {
        let data = self.railway_api(&[("id", project_id)], QUERY).await?;
        let project = data.get("project").filter(|p| p.is_object()).ok_or("Respuesta sin proyecto")?;
        let Some(env) = project["environments"]["edges"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| &e["node"])
            .find(|e| e["name"] == ENVIRONMENT)
        else {
            return Ok(vec![]);
        };
        let (pid, eid) = (project["id"].as_str().unwrap_or(""), env["id"].as_str().unwrap_or(""));
        Ok(env["serviceInstances"]["edges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let i = &e["node"];
                let health = health_of(i)?;
                let d = &i["latestDeployment"];
                let meta = &d["meta"];
                let sid = i["serviceId"].as_str().unwrap_or("");
                let repo = if i["source"]["repo"].is_string() { i["source"]["repo"].clone() } else { str_or_null(&meta["repo"]) };
                let author = match d["creator"]["name"].as_str() {
                    Some(n) if !n.is_empty() => json!(n),
                    _ => str_or_null(&meta["commitAuthor"]),
                };
                Some(json!({
                    "projectId": pid,
                    "projectName": project["name"],
                    "environmentId": eid,
                    "serviceId": sid,
                    "serviceName": i["serviceName"],
                    "health": health,
                    "status": d["status"].as_str().unwrap_or(""),
                    "since": str_or_null(&d["createdAt"]),
                    "url": format!("https://railway.com/project/{pid}/service/{sid}?environmentId={eid}"),
                    "repo": repo,
                    "branch": str_or_null(&meta["branch"]),
                    "commit": str_or_null(&meta["commitHash"]),
                    "commitMessage": meta["commitMessage"].as_str().and_then(|m| m.lines().next()),
                    "author": author,
                    "stale": null
                }))
            })
            .collect())
    }

    fn update(&self, f: impl FnOnce(&mut ProdState)) {
        let state = {
            let mut s = self.state.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.app.emit("prod:state", state);
    }
}
