// Pomodoro en la barra de pestañas: foco → descanso → gracia → foco…
// La gracia es un minuto para acomodarse antes de volver a trabajar.

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

export function mountPomodoro(root: HTMLElement): Pomodoro {
  const display = document.createElement("button");
  display.className = "pomo-display";
  const resetBtn = document.createElement("button");
  resetBtn.className = "pomo-reset";
  resetBtn.textContent = "↺";
  resetBtn.title = "Reiniciar pomodoro";
  root.append(display, resetBtn);

  let phase: Phase | null = null; // null = sin arrancar
  // El tiempo se calcula contra un instante fijo (endsAt) para no acumular desfase del setInterval.
  let endsAt = 0;
  let remaining = 0; // ms que quedaban al pausar
  let ticker: ReturnType<typeof setInterval> | undefined;

  const running = () => ticker !== undefined;

  function render() {
    root.dataset.phase = phase ?? "idle";
    root.classList.toggle("paused", phase !== null && !running());
    resetBtn.hidden = phase === null;
    if (phase === null) {
      display.textContent = "🍅 Pomodoro";
      display.title = "Iniciar 25 minutos de foco (⌘⇧P)";
      return;
    }
    const ms = running() ? Math.max(0, endsAt - Date.now()) : remaining;
    const secs = Math.ceil(ms / 1000);
    const mmss = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    display.textContent = `${running() ? "" : "⏸ "}${PHASES[phase].label} ${mmss}`;
    display.title = running() ? "Pausar (⌘⇧P)" : "Continuar (⌘⇧P)";
  }

  function tick() {
    if (phase && Date.now() >= endsAt) {
      const done = phase;
      phase = PHASES[done].next;
      endsAt += PHASES[phase].ms;
      // Si la app estuvo dormida y se saltearon fases, se alinea al presente.
      if (endsAt <= Date.now()) endsAt = Date.now() + PHASES[phase].ms;
      notify(PHASES[done].notice);
    }
    render();
  }

  function start(ms: number) {
    endsAt = Date.now() + ms;
    ticker = setInterval(tick, 250);
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

  display.addEventListener("click", () => api.toggle());
  resetBtn.addEventListener("click", () => api.reset());
  render();
  return api;
}

function notify(body: string) {
  try {
    new Notification("rollerterm · Pomodoro", { body });
  } catch (err) {
    console.error("[pomodoro notify]", err);
  }
}
