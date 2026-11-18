// Monitor de sistema en la cabecera (solo en la versión Tauri): CPU y RAM disponible/total,
// con el detalle (swap, carga) al pasar el mouse. Se pone rojo cuando algo aprieta.

interface SysStats {
  cpu: number | null;
  cores: number;
  memTotal: number;
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
  load1: number;
}

const EVERY_MS = 2000;
const gb = (bytes: number) => (bytes / 1024 ** 3).toLocaleString("es-AR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function mountSysmon(invoke: (cmd: string) => Promise<SysStats>) {
  const titlebar = document.getElementById("titlebar");
  if (!titlebar) return;

  const style = document.createElement("style");
  style.textContent = `
    #sysmon { -webkit-app-region: no-drag; flex-shrink: 0; }
    #sysmon .prod-badge { gap: 10px; cursor: default; font-variant-numeric: tabular-nums; }
    #sysmon .sm-item { display: inline-flex; align-items: center; gap: 5px; }
    #sysmon .sm-label { color: var(--text-muted); font-size: 10px; font-weight: 600; letter-spacing: .04em; }
    #sysmon .sm-bar { width: 26px; height: 4px; border-radius: 2px; background: #ffffff1a; overflow: hidden; }
    #sysmon .sm-bar i { display: block; height: 100%; background: #7c5cff; transition: width .4s; }
    #sysmon .warn .sm-bar i { background: #d9a441; }
    #sysmon .hot .sm-bar i { background: #e0675a; }
    #sysmon .hot .sm-value { color: #e98a80; }
  `;
  document.head.append(style);

  const root = document.createElement("div");
  root.id = "sysmon";
  root.innerHTML = `
    <div class="prod-badge">
      <span class="sm-item sm-cpu"><span class="sm-label">CPU</span><span class="sm-bar"><i></i></span><span class="sm-value">…</span></span>
      <span class="sm-item sm-ram"><span class="sm-label">RAM</span><span class="sm-bar"><i></i></span><span class="sm-value">…</span></span>
    </div>`;
  // Antes del pomodoro: al lado de los otros indicadores (Prod, Claude).
  titlebar.insertBefore(root, document.getElementById("pomodoro"));

  const badge = root.querySelector<HTMLElement>(".prod-badge")!;
  const cpuEl = root.querySelector<HTMLElement>(".sm-cpu")!;
  const ramEl = root.querySelector<HTMLElement>(".sm-ram")!;

  function set(el: HTMLElement, pct: number, text: string) {
    el.querySelector<HTMLElement>(".sm-bar i")!.style.width = `${Math.round(Math.min(100, Math.max(0, pct)))}%`;
    el.querySelector<HTMLElement>(".sm-value")!.textContent = text;
    el.classList.toggle("hot", pct >= 90);
    el.classList.toggle("warn", pct >= 75 && pct < 90);
  }

  async function tick() {
    let s: SysStats;
    try {
      s = await invoke("sys_stats");
    } catch {
      return;
    }
    const usedPct = s.memTotal ? (100 * (s.memTotal - s.memAvailable)) / s.memTotal : 0;
    if (s.cpu !== null) set(cpuEl, s.cpu, `${Math.round(s.cpu)}%`);
    set(ramEl, usedPct, `${gb(s.memAvailable)}/${gb(s.memTotal)} GB`);
    const swapUsed = s.swapTotal - s.swapFree;
    badge.title = [
      `CPU: ${s.cpu === null ? "…" : `${Math.round(s.cpu)}%`} de ${s.cores} núcleos · carga ${s.load1.toFixed(2)}`,
      `RAM: ${gb(s.memAvailable)} GB disponibles de ${gb(s.memTotal)} GB (${Math.round(usedPct)}% en uso)`,
      s.swapTotal ? `Swap: ${gb(swapUsed)} GB en uso de ${gb(s.swapTotal)} GB` : "Sin swap",
    ].join("\n");
  }

  void tick();
  // Con la ventana oculta no hace falta medir: se retoma al volver.
  let timer = setInterval(tick, EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    clearInterval(timer);
    if (!document.hidden) {
      void tick();
      timer = setInterval(tick, EVERY_MS);
    }
  });
}
