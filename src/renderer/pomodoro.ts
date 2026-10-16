// Pomodoro en la barra de título: foco → descanso → gracia → foco…
// La gracia es un minuto para acomodarse antes de volver a trabajar. Un clic abre un menú
// para pausar, saltar directo a una fase o reiniciar; ⌘⇧P pausa/continúa sin abrirlo.
import type { PomodoroSound } from "../shared/types";
import { isMuted, notify } from "./notify";
import { bell, tick as tickSound } from "./sound";

type Phase = "focus" | "break" | "grace";

const MINUTE = 60_000;
const PHASES: Record<Phase, { label: string; ms: number; next: Phase; notice: string }> = {
  focus: { label: "Foco", ms: 25 * MINUTE, next: "break", notice: "Terminó el foco: 5 minutos de descanso." },
  break: { label: "Descanso", ms: 5 * MINUTE, next: "grace", notice: "Terminó el descanso: 1 minuto para acomodarte." },
  grace: { label: "Gracia", ms: 1 * MINUTE, next: "focus", notice: "A trabajar: 25 minutos de foco." },
};

export interface Pomodoro {
  toggle(): void;
  reset(): void;
}

/** Timbre al entrar en cada fase: descanso "ding", gracia "ding" suave, trabajo "ding-ding". */
const BELLS: Record<Phase, { times: number; soft: boolean }> = {
  focus: { times: 2, soft: false },
  break: { times: 1, soft: false },
  grace: { times: 1, soft: true },
};

const ORDER: Phase[] = ["focus", "break", "grace"];
const minutes = (p: Phase) => PHASES[p].ms / MINUTE;

export function mountPomodoro(root: HTMLElement, sound: () => PomodoroSound): Pomodoro {
  const display = document.createElement("button");
  display.className = "pomo-display";
  display.title = "Pomodoro (⌘⇧P pausa o continúa)";
  const menu = document.createElement("div");
  menu.className = "pomo-menu";
  menu.hidden = true;
  root.append(display, menu);

  let phase: Phase | null = null; // null = sin arrancar
  // El tiempo se calcula contra un instante fijo (endsAt) para no acumular desfase del setInterval.
  let endsAt = 0;
  let remaining = 0; // ms que quedaban al pausar
  let ticker: ReturnType<typeof setInterval> | undefined;

  const running = () => ticker !== undefined;
  /** Último segundo mostrado: el tictac suena una vez por segundo, al cambiar el reloj. */
  let lastSecs = -1;

  function render() {
    root.dataset.phase = phase ?? "idle";
    root.classList.toggle("paused", phase !== null && !running());
    if (phase === null) {
      display.textContent = "🍅 Pomodoro";
      return;
    }
    const ms = running() ? Math.max(0, endsAt - Date.now()) : remaining;
    const secs = Math.ceil(ms / 1000);
    if (running() && secs !== lastSecs) {
      lastSecs = secs;
      const { ticking, volume } = sound();
      if (ticking && !isMuted()) tickSound(secs % 2 === 0 ? "tic" : "tac", volume);
    }
    const mmss = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    display.textContent = `${running() ? "" : "⏸ "}${PHASES[phase].label} ${mmss}`;
  }

  // ---------- menú ----------

  function item(label: string, hint: string, action: () => void, current = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "pomo-item";
    b.classList.toggle("current", current);
    const l = document.createElement("span");
    l.textContent = label;
    const h = document.createElement("small");
    h.textContent = hint;
    b.append(l, h);
    b.addEventListener("click", () => {
      action();
      closeMenu();
    });
    return b;
  }

  function renderMenu() {
    const sep = () => Object.assign(document.createElement("hr"), { className: "pomo-sep" });
    const items: HTMLElement[] = [];
    if (phase === null) items.push(item("▶ Iniciar foco", `${minutes("focus")} min`, () => api.toggle()));
    else items.push(item(running() ? "⏸ Pausar" : "▶ Continuar", "⌘⇧P", () => api.toggle()));
    items.push(sep());
    for (const p of ORDER) {
      items.push(item(`Ir a ${PHASES[p].label.toLowerCase()}`, p === phase ? "en curso" : `${minutes(p)} min`, () => goTo(p), p === phase));
    }
    if (phase !== null) {
      items.push(item("⏭ Siguiente fase", PHASES[PHASES[phase].next].label, () => goTo(PHASES[phase!].next)));
      items.push(sep());
      items.push(item("↺ Reiniciar", "detener", () => api.reset()));
    }
    menu.replaceChildren(...items);
  }

  function openMenu() {
    renderMenu();
    menu.hidden = false;
  }
  function closeMenu() {
    menu.hidden = true;
  }

  display.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  // Clic afuera o Esc cierran el menú.
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !root.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeMenu();
  });

  function tick() {
    if (phase && Date.now() >= endsAt) {
      const done = phase;
      phase = PHASES[done].next;
      endsAt += PHASES[phase].ms;
      // Si la app estuvo dormida y se saltearon fases, se alinea al presente.
      if (endsAt <= Date.now()) endsAt = Date.now() + PHASES[phase].ms;
      notify("rollerterm · Pomodoro", PHASES[done].notice);
      const { bell: ring, volume } = sound();
      if (ring && !isMuted()) bell(volume, BELLS[phase].times, BELLS[phase].soft);
    }
    render();
  }

  function start(ms: number) {
    endsAt = Date.now() + ms;
    ticker = setInterval(tick, 250);
  }

  /** Arranca una fase de cero, aunque esté corriendo otra o en pausa. */
  function goTo(p: Phase) {
    clearInterval(ticker);
    ticker = undefined;
    phase = p;
    lastSecs = -1;
    start(PHASES[p].ms);
    render();
  }

  function pause() {
    remaining = Math.max(0, endsAt - Date.now());
    clearInterval(ticker);
    ticker = undefined;
  }

  const api: Pomodoro = {
    toggle() {
      if (phase === null) {
        phase = "focus";
        start(PHASES.focus.ms);
      } else if (running()) pause();
      else start(remaining);
      render();
    },
    reset() {
      clearInterval(ticker);
      ticker = undefined;
      phase = null;
      render();
    },
  };

  render();
  return api;
}
