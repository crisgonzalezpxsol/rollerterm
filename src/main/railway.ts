// Estado de producción en Railway, consultado con el CLI `railway` (con la sesión del
// usuario) y su API GraphQL de solo lectura. No usa Claude: es rápido y no gasta uso del plan.
import { powerMonitor } from "electron";
import type { ProdService, ProdState, RailwayProject, RailwaySettings, ServiceHealth } from "../shared/types";
import { exec, findCommand, type Command } from "./shell-env";

const CHECK_EVERY_MS = 2 * 60_000;
/** La lista de proyectos cambia poco: se vuelve a pedir cada tanto. */
const PROJECTS_TTL_MS = 30 * 60_000;
const ENVIRONMENT = "production";
const PARALLEL = 4;

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
                latestDeployment { status createdAt }
                activeDeployments { status }
              }
            }
          }
        }
      }
    }
  }
}`;

const DEPLOYING = new Set(["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]);
/** Sin deploy o dado de baja a propósito: no cuenta para la salud. */
const IGNORED = new Set(["REMOVED", "REMOVING", "SKIPPED"]);

interface Instance {
  serviceId: string;
  serviceName: string;
  latestDeployment: { status: string; createdAt: string } | null;
  activeDeployments: { status: string }[] | null;
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
      const message = failed.length ? `No se pudieron consultar ${failed.length} proyecto(s): ${failed[0].message}` : null;
      this.update({ status: "ok", message, services, lastCheck: Date.now() });
    } catch (err) {
      this.update({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ checking: false });
    }
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
