// Estado de producción en Railway, consultado con el CLI `railway` (con la sesión del
// usuario) y su API GraphQL de solo lectura. No usa Claude: es rápido y no gasta uso del plan.
//
// Además vigila que Railway efectivamente despliegue: compara la punta de la rama de cada
// servicio en GitHub (con `gh`) contra los deploys que Railway registró. Si pasan más de 3 h
// sin ningún deploy de ese commit — ni siquiera uno salteado por watch paths — es que Railway
// no se enteró del push (pasa en sus incidentes) o lo dejó trabado.
import { powerMonitor } from "electron";
import type { ProdService, ProdState, RailwayProject, RailwaySettings, ServiceHealth, StaleDeploy } from "../shared/types";
import { exec, findCommand, type Command } from "./shell-env";

const CHECK_EVERY_MS = 2 * 60_000;
/** La lista de proyectos cambia poco: se vuelve a pedir cada tanto. */
const PROJECTS_TTL_MS = 30 * 60_000;
const ENVIRONMENT = "production";
const PARALLEL = 4;
/** Cuánto se tolera sin deploy antes de avisar. */
const STALE_AFTER_MS = 3 * 60 * 60_000;
/** La punta de cada rama en GitHub se vuelve a pedir cada tanto, no en cada vuelta. */
const TIP_TTL_MS = 5 * 60_000;

const QUERY = `query($id: String!) {
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
                latestDeployment { status createdAt meta }
                activeDeployments { status }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Los últimos deploys de un entorno, con cualquier estado (también los salteados). */
const DEPLOYS_QUERY = `query($id: String!, $env: String!) {
  deployments(first: 100, input: { projectId: $id, environmentId: $env }) {
    edges { node { serviceId status meta } }
  }
}`;

const DEPLOYING = new Set(["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]);
/** Sin deploy o dado de baja a propósito: no cuenta para la salud. */
const IGNORED = new Set(["REMOVED", "REMOVING", "SKIPPED"]);

interface DeployMeta {
  branch?: string | null;
  commitHash?: string | null;
  repo?: string | null;
}

interface Instance {
  serviceId: string;
  serviceName: string;
  source: { repo: string | null } | null;
  latestDeployment: { status: string; createdAt: string; meta: DeployMeta | null } | null;
  activeDeployments: { status: string }[] | null;
}

/** La punta de una rama en GitHub. */
interface Tip {
  sha: string;
  message: string;
  /** Fecha del commit (ISO). */
  date: string;
}

function healthOf(i: Instance): ServiceHealth | null {
  const status = i.latestDeployment?.status;
  if (!status || IGNORED.has(status)) return null;
  const running = (i.activeDeployments?.length ?? 0) > 0;
  if (status === "SUCCESS" || status === "SLEEPING") return "ok";
  if (status === "CRASHED") return "down";
  if (status === "FAILED") return running ? "degraded" : "down";
  if (DEPLOYING.has(status)) return "deploying";
  return running ? "ok" : "down";
}

export class RailwayMonitor {
  private state: ProdState = { status: "loading", message: null, checking: false, lastCheck: null, services: [] };
  private railway: Command | null = null;
  private projects: { list: RailwayProject[]; at: number } | null = null;
  private gh: Command | null | undefined;
  private tips = new Map<string, { tip: Tip | null; at: number }>();
  /** Cuándo se vio llegar cada punta nueva (más fiel que la fecha del commit, que en un rebase es vieja). */
  private arrived = new Map<string, number>();

  constructor(
    private settings: () => RailwaySettings,
    private onChange: (state: ProdState) => void,
  ) {}

  get current(): ProdState {
    return this.state;
  }

  start(): void {
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
    powerMonitor.on("resume", () => void this.check());
  }

  async listProjects(force = false): Promise<RailwayProject[]> {
    if (!force && this.projects && Date.now() - this.projects.at < PROJECTS_TTL_MS) return this.projects.list;
    this.railway ??= await findCommand("railway");
    if (!this.railway) return [];
    const { stdout } = await exec(this.railway.bin, ["list", "--json"], { env: this.railway.env, timeoutMs: 30_000 });
    const parsed = JSON.parse(stdout) as {
      id: string;
      name: string;
      environments?: { edges: { node: { name: string } }[] };
      services?: { edges: unknown[] };
    }[];
    const list = parsed
      .filter((p) => p.environments?.edges.some((e) => e.node.name === ENVIRONMENT))
      .map((p) => ({ id: p.id, name: p.name, services: p.services?.edges.length ?? 0 }));
    this.projects = { list, at: Date.now() };
    return list;
  }

  async check(): Promise<void> {
    if (this.state.checking) return;
    const cfg = this.settings();
    if (!cfg.enabled) {
      this.update({ status: "disabled", message: null, services: [] });
      return;
    }
    this.update({ checking: true });
    try {
      this.railway ??= await findCommand("railway");
      if (!this.railway) {
        this.update({ status: "no-cli", message: "No se encontró el comando `railway` (Railway CLI)." });
        return;
      }
      let projects: RailwayProject[];
      try {
        projects = await this.listProjects();
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        const loggedOut = /unauthorized|not logged in|login/i.test(text);
        this.update({ status: loggedOut ? "logged-out" : "error", message: text });
        return;
      }
      const watched = cfg.projects ? projects.filter((p) => cfg.projects!.includes(p.id)) : projects;
      const results = await mapLimit(watched, PARALLEL, (p) => this.projectServices(p.id));
      const failed = results.filter((r) => r instanceof Error) as Error[];
      // Si fallan todos, no hay foto de producción; si fallan algunos, se muestra lo que hay.
      if (watched.length && failed.length === watched.length) {
        this.update({ status: "error", message: failed[0].message });
        return;
      }
      const services = results.filter((r): r is ProdService[] => !(r instanceof Error)).flat();
      await this.markStale(services).catch((err) => console.error("[railway] sin deploy:", err));
      const message = failed.length ? `No se pudieron consultar ${failed.length} proyecto(s): ${failed[0].message}` : null;
      this.update({ status: "ok", message, services, lastCheck: Date.now() });
    } catch (err) {
      this.update({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ checking: false });
    }
  }

  /** Marca los servicios en los que Railway lleva más de 3 h sin desplegar. */
  private async markStale(services: ProdService[]): Promise<void> {
    const now = Date.now();
    for (const s of services) {
      // Un deploy trabado en cola o construyendo.
      if (s.health === "deploying" && s.since && now - Date.parse(s.since) > STALE_AFTER_MS) {
        s.stale = { kind: "stuck", repo: s.repo, branch: s.branch, commit: s.commit?.slice(0, 7) ?? null, message: null, since: s.since };
      }
    }
    // Un push que no generó deploy: hace falta `gh` para saber cuál es la punta de la rama.
    this.gh ??= await findCommand("gh");
    if (!this.gh) return;
    const suspects: { s: ProdService; tip: Tip; since: number }[] = [];
    for (const s of services) {
      if (s.stale || !s.repo || !s.branch || !s.commit) continue;
      const tip = await this.tipOf(s.repo, s.branch);
      if (!tip || tip.sha === s.commit) continue;
      const since = this.arrived.get(`${s.repo}@${s.branch}@${tip.sha}`) ?? Date.parse(tip.date);
      if (now - since > STALE_AFTER_MS) suspects.push({ s, tip, since });
    }
    if (!suspects.length) return;
    // ¿Railway registró ALGÚN deploy de ese commit para ese servicio (aunque sea salteado)?
    const byEnv = new Map<string, Promise<Set<string>>>();
    for (const { s, tip, since } of suspects) {
      const key = `${s.projectId}/${s.environmentId}`;
      if (!byEnv.has(key)) byEnv.set(key, this.deployedCommits(s.projectId, s.environmentId));
      const seen = await byEnv.get(key)!;
      if (seen.has(`${s.serviceId}@${tip.sha}`)) continue;
      s.stale = { kind: "missing", repo: s.repo, branch: s.branch, commit: tip.sha.slice(0, 7), message: tip.message, since: new Date(since).toISOString() };
    }
  }

  /** "servicio@commit" de los últimos deploys del entorno, con cualquier estado. */
  private async deployedCommits(projectId: string, environmentId: string): Promise<Set<string>> {
    const { bin, env } = this.railway!;
    const { stdout } = await exec(bin, ["api", "--var", `id=${projectId}`, "--var", `env=${environmentId}`, "-f", "-"], {
      env,
      input: DEPLOYS_QUERY,
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(stdout) as {
      data?: { deployments: DeploymentList };
      deployments?: DeploymentList;
      errors?: { message: string }[];
    };
    if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
    const list = parsed.data?.deployments ?? parsed.deployments;
    // Sin la lista no se puede afirmar que falte un deploy: se toma como que está todo.
    if (!list) throw new Error("Respuesta sin deploys");
    return new Set(list.edges.map(({ node }) => `${node.serviceId}@${node.meta?.commitHash ?? ""}`));
  }

  /** La punta de la rama en GitHub (cacheada unos minutos). null si `gh` no tiene acceso. */
  private async tipOf(repo: string, branch: string): Promise<Tip | null> {
    const key = `${repo}@${branch}`;
    const cached = this.tips.get(key);
    if (cached && Date.now() - cached.at < TIP_TTL_MS) return cached.tip;
    let tip: Tip | null = null;
    try {
      const { stdout } = await exec(
        this.gh!.bin,
        ["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`, "--jq", "{sha: .sha, message: (.commit.message | split(\"\\n\")[0]), date: .commit.committer.date}"],
        { env: this.gh!.env, timeoutMs: 20_000 },
      );
      tip = JSON.parse(stdout) as Tip;
    } catch {
      tip = cached?.tip ?? null; // sin red o sin acceso: lo último que se supo
    }
    // Si la punta cambió mientras la app miraba, la hora de llegada es ahora.
    if (tip && cached?.tip && cached.tip.sha !== tip.sha) this.arrived.set(`${key}@${tip.sha}`, Date.now());
    this.tips.set(key, { tip, at: Date.now() });
    return tip;
  }

  private async projectServices(projectId: string): Promise<ProdService[] | Error> {
    try {
      const { bin, env } = this.railway!;
      const { stdout } = await exec(bin, ["api", "--var", `id=${projectId}`, "-f", "-"], { env, input: QUERY, timeoutMs: 30_000 });
      const parsed = JSON.parse(stdout) as {
        data?: { project: ProjectNode };
        project?: ProjectNode;
        errors?: { message: string }[];
      };
      if (parsed.errors?.length) return new Error(parsed.errors[0].message);
      const project = parsed.data?.project ?? parsed.project;
      if (!project) return new Error("Respuesta sin proyecto");
      const env_ = project.environments.edges.map((e) => e.node).find((e) => e.name === ENVIRONMENT);
      if (!env_) return [];
      return env_.serviceInstances.edges.flatMap(({ node: i }) => {
        const health = healthOf(i);
        if (!health) return [];
        return [
          {
            projectId: project.id,
            projectName: project.name,
            environmentId: env_.id,
            serviceId: i.serviceId,
            serviceName: i.serviceName,
            health,
            status: i.latestDeployment?.status ?? "",
            since: i.latestDeployment?.createdAt ?? null,
            url: `https://railway.com/project/${project.id}/service/${i.serviceId}?environmentId=${env_.id}`,
            repo: i.source?.repo ?? i.latestDeployment?.meta?.repo ?? null,
            branch: i.latestDeployment?.meta?.branch ?? null,
            commit: i.latestDeployment?.meta?.commitHash ?? null,
            stale: null,
          },
        ];
      });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private update(patch: Partial<ProdState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

interface DeploymentList {
  edges: { node: { serviceId: string; status: string; meta: DeployMeta | null } }[];
}

interface ProjectNode {
  id: string;
  name: string;
  environments: { edges: { node: { id: string; name: string; serviceInstances: { edges: { node: Instance }[] } } }[] };
}

/** Como Promise.all, pero con a lo sumo `limit` tareas a la vez. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
