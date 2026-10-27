// Consumo de Claude Code en la barra de título: "✳ $12,30 hoy" y, al hacer clic, el detalle
// (ventana de 5 h en curso, hoy, 7 días, por modelo y por proyecto). El costo es una
// estimación a precio de API: con un plan Max/Pro no se cobra, pero sirve para comparar.
import type { RollertermApi, UsageRow, UsageState, UsageTotals } from "../shared/types";
import { fmtTime } from "./connector";

const usd = (n: number) => `$${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 1234567 → "1,2 M". */
function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("es-AR", { maximumFractionDigits: 1 })} B`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 })} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}

const total = (t: UsageTotals) => t.input + t.output + t.cacheWrite + t.cacheRead;

export function mountUsage(root: HTMLElement, api: RollertermApi): void {
  root.innerHTML = `
    <button class="prod-badge usage-badge" title="Consumo de Claude Code"><span class="usage-icon">✳</span><span class="usage-text">…</span></button>
    <div class="prod-pop usage-pop" hidden>
      <div class="prod-pop-head">
        <strong>Consumo · Claude Code</strong>
        <span class="prod-when"></span>
        <button class="prod-refresh" title="Revisar ahora">↻</button>
      </div>
      <div class="usage-periods"></div>
      <h4>Hoy por modelo</h4>
      <table class="usage-table usage-models"></table>
      <h4>Hoy por proyecto</h4>
      <table class="usage-table usage-projects"></table>
      <p class="usage-note">Costo estimado a precio de API (con un plan Pro/Max no se cobra aparte). Sale de los logs de ~/.claude/projects.</p>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const badge = $<HTMLButtonElement>(".usage-badge");
  const text = $<HTMLSpanElement>(".usage-text");
  const pop = $<HTMLDivElement>(".usage-pop");
  const when = $<HTMLSpanElement>(".prod-when");
  const refresh = $<HTMLButtonElement>(".prod-refresh");
  const periods = $<HTMLDivElement>(".usage-periods");
  const models = $<HTMLTableElement>(".usage-models");
  const projects = $<HTMLTableElement>(".usage-projects");

  let state: UsageState | null = null;

  badge.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    render();
  });
  refresh.addEventListener("click", () => api.refreshUsage());
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !root.contains(e.target as Node)) pop.hidden = true;
  });

  function period(label: string, t: UsageTotals, extra?: string, progress?: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "usage-period";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = usd(t.cost);
    const span = document.createElement("span");
    span.textContent = extra ?? `${tokens(total(t))} tokens`;
    el.append(small, strong, span);
    if (progress !== undefined) {
      const bar = document.createElement("div");
      bar.className = "usage-bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
      bar.append(fill);
      el.append(bar);
    }
    return el;
  }

  function rows(table: HTMLTableElement, list: UsageRow[]) {
    table.replaceChildren();
    if (!list.length) {
      const tr = table.insertRow();
      tr.insertCell().textContent = "Sin uso hoy.";
      return;
    }
    for (const r of list) {
      const tr = table.insertRow();
      tr.insertCell().textContent = r.name;
      tr.insertCell().textContent = tokens(r.tokens);
      tr.insertCell().textContent = usd(r.cost);
    }
  }

  function render() {
    if (!state) return;
    const { today, week, block } = state;
    text.textContent = state.status === "loading" ? "Claude…" : state.status === "error" ? "Claude ?" : `${usd(today.cost)} hoy`;
    badge.title =
      state.status === "error"
        ? "No se pudieron leer los logs de Claude Code."
        : `Claude Code hoy: ${usd(today.cost)} · ${tokens(total(today))} tokens · ${today.messages} respuestas` +
          (block ? ` · ventana de 5 h: ${usd(block.totals.cost)} (se renueva a las ${fmtTime(block.end)})` : "");
    if (pop.hidden) return;

    when.textContent = state.lastCheck ? `revisado ${fmtTime(state.lastCheck)}` : "";
    const now = Date.now();
    periods.replaceChildren(
      block
        ? period("Ventana 5 h", block.totals, `hasta las ${fmtTime(block.end)}`, (now - block.start) / (block.end - block.start))
        : period("Ventana 5 h", { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 }, "sin uso"),
      period("Hoy", today),
      period("7 días", week),
    );
    rows(models, state.models);
    rows(projects, state.projects);
  }

  api.getUsage().then((s) => {
    state = s;
    render();
  });
  api.onUsage((s) => {
    state = s;
    render();
  });
  // La barra de la ventana de 5 h avanza aunque no haya datos nuevos.
  setInterval(render, 60_000);
}
