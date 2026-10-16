// Indicador de producción (Railway) en la barra de título: un punto de color con
// "Prod OK/total" y, al hacer clic, el detalle de lo que no está bien.
import type { ProdService, ProdState, RollertermApi, ServiceHealth } from "../shared/types";
import { fmtTime } from "./connector";
import { notify } from "./notify";

const STATUS_LABEL: Record<string, string> = {
  CRASHED: "crasheado",
  FAILED: "falló el deploy",
  BUILDING: "construyendo",
  DEPLOYING: "desplegando",
  INITIALIZING: "iniciando",
  QUEUED: "en cola",
  WAITING: "esperando",
  NEEDS_APPROVAL: "espera aprobación",
};

const HEALTH_LABEL: Record<ServiceHealth, string> = {
  down: "Caído",
  degraded: "Último deploy falló (sigue la versión anterior)",
  deploying: "Desplegando",
  ok: "OK",
};

/** De peor a mejor: el color del indicador es el del peor servicio. */
const ORDER: ServiceHealth[] = ["down", "degraded", "deploying", "ok"];

const PROBLEM_TEXT: Partial<Record<ProdState["status"], string>> = {
  "no-cli": "Instalá el CLI de Railway (npm i -g @railway/cli) y logueate con `railway login`.",
  "logged-out": "La sesión del CLI de Railway expiró: corré `railway login` en una pestaña.",
  error: "No se pudo consultar Railway.",
};

export function mountProd(root: HTMLElement, api: RollertermApi, openSettings: () => void): void {
  root.innerHTML = `
    <button class="prod-badge" title="Producción (Railway)"><span class="prod-dot"></span><span class="prod-text">Prod</span></button>
    <div class="prod-pop" hidden>
      <div class="prod-pop-head">
        <strong>Producción · Railway</strong>
        <span class="prod-when"></span>
        <button class="prod-refresh" title="Revisar ahora">↻</button>
      </div>
      <p class="prod-summary"></p>
      <ol class="prod-list"></ol>
      <button class="prod-config">Elegir proyectos…</button>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const badge = $<HTMLButtonElement>(".prod-badge");
  const dot = $<HTMLSpanElement>(".prod-dot");
  const text = $<HTMLSpanElement>(".prod-text");
  const pop = $<HTMLDivElement>(".prod-pop");
  const when = $<HTMLSpanElement>(".prod-when");
  const refresh = $<HTMLButtonElement>(".prod-refresh");
  const summary = $<HTMLParagraphElement>(".prod-summary");
  const list = $<HTMLOListElement>(".prod-list");

  let state: ProdState | null = null;
  /** Salud anterior de cada servicio, para avisar solo cuando cambia. */
  let prevHealth: Map<string, ServiceHealth> | null = null;

  badge.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    render();
  });
  refresh.addEventListener("click", () => api.refreshProd());
  $<HTMLButtonElement>(".prod-config").addEventListener("click", () => {
    pop.hidden = true;
    openSettings();
  });
  // Clic afuera cierra el detalle.
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !root.contains(e.target as Node)) pop.hidden = true;
  });

  const keyOf = (s: ProdService) => `${s.projectId}/${s.serviceId}`;

  function checkTransitions(s: ProdState) {
    if (s.status !== "ok" || s.checking) return;
    const now = new Map(s.services.map((x) => [keyOf(x), x.health] as const));
    if (!prevHealth) {
      // Al abrir la app: un solo aviso con lo que ya está caído.
      const down = s.services.filter((x) => x.health === "down");
      if (down.length) {
        notify(
          `🔴 Producción: ${down.length} servicio${down.length === 1 ? "" : "s"} caído${down.length === 1 ? "" : "s"}`,
          down.map((x) => `${x.projectName} / ${x.serviceName}`).join(", "),
        );
      }
    } else {
      for (const x of s.services) {
        const before = prevHealth.get(keyOf(x));
        if (x.health === "down" && before !== "down") {
          notify(`🔴 Caído: ${x.projectName} / ${x.serviceName}`, STATUS_LABEL[x.status] ?? x.status, () => window.open(x.url));
        } else if (before === "down" && x.health === "ok") {
          notify(`🟢 Recuperado: ${x.projectName} / ${x.serviceName}`, "Vuelve a estar en línea.");
        }
      }
    }
    prevHealth = now;
  }

  function render() {
    if (!state) return;
    root.hidden = state.status === "disabled";
    const services = state.services;
    const worst = ORDER.find((h) => services.some((x) => x.health === h)) ?? "ok";
    const okCount = services.filter((x) => x.health === "ok").length;
    const problem = state.status !== "ok" && state.status !== "loading";

    const none = state.status === "ok" && services.length === 0;
    dot.dataset.health = problem || none ? "unknown" : state.status === "loading" ? "loading" : worst;
    text.textContent =
      state.status === "loading" ? "Prod…" : problem ? "Prod ?" : none ? "Prod –" : `Prod ${okCount}/${services.length}`;
    badge.title = problem
      ? `Producción: ${state.message ?? ""}`
      : `Producción · ${HEALTH_LABEL[worst]}${state.lastCheck ? ` · revisado ${fmtTime(state.lastCheck)}` : ""}`;
    refresh.disabled = state.checking;
    refresh.classList.toggle("spinning", state.checking);
    if (pop.hidden) return;

    when.textContent = state.lastCheck ? `revisado ${fmtTime(state.lastCheck)}` : "";
    list.innerHTML = "";
    if (problem) {
      summary.textContent = [state.message, PROBLEM_TEXT[state.status]].filter(Boolean).join(" ");
      return;
    }
    const bad = services
      .filter((x) => x.health !== "ok")
      .sort((a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health));
    const projects = new Set(services.map((x) => x.projectId)).size;
    if (none) {
      summary.textContent = "No hay proyectos elegidos para vigilar (o no tienen servicios en production).";
      return;
    }
    summary.textContent = bad.length
      ? `${okCount} de ${services.length} servicios OK en ${projects} proyectos.`
      : `Todo OK: ${services.length} servicios en ${projects} proyectos.`;
    if (state.message) summary.textContent += ` ${state.message}`;
    for (const x of bad) {
      const li = document.createElement("li");
      li.dataset.health = x.health;
      li.title = "Abrir en Railway";
      const name = document.createElement("strong");
      name.textContent = `${x.projectName} / ${x.serviceName}`;
      const detail = document.createElement("span");
      detail.textContent = `${HEALTH_LABEL[x.health]} · ${STATUS_LABEL[x.status] ?? x.status}${x.since ? ` · ${ago(Date.parse(x.since))}` : ""}`;
      li.append(name, detail);
      li.addEventListener("click", () => window.open(x.url));
      list.append(li);
    }
  }

  function onState(next: ProdState) {
    state = next;
    checkTransitions(next);
    render();
  }

  api.getProd().then(onState);
  api.onProd(onState);
  setInterval(render, 60_000);
}

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
