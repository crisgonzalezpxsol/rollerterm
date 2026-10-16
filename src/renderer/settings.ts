// Ventana de configuración (⚙ en la barra de título o ⌘,). Cada cambio se guarda al instante.
import type { BrowserInfo, PomodoroSound, RailwayProject, RollertermApi, Settings } from "../shared/types";
import { bell, tick } from "./sound";

export type SettingsSection = "railway" | "tickets";

export interface SettingsPanel {
  /** Con `section`, abre directo en esa sección y la resalta. */
  open(section?: SettingsSection): void;
}

export function mountSettings(
  api: RollertermApi,
  hooks: { onClose: () => void; onChange: (settings: Settings) => void },
): SettingsPanel {
  const dialog = document.createElement("dialog");
  dialog.id = "settings";
  dialog.innerHTML = `
    <header>
      <h2>Configuración</h2>
      <button class="settings-close" title="Cerrar (Esc)">×</button>
    </header>
    <section>
      <h3>Navegador</h3>
      <p class="settings-help">Con cuál se abren «Unirme», los correos y los links de la terminal.</p>
      <label>Navegador <select class="browser-select" autofocus></select></label>
      <label class="profile-row" hidden>Perfil <select class="profile-select"></select></label>
      <div class="settings-actions">
        <button class="browser-test">Probar</button>
        <span class="settings-saved" hidden>Guardado</span>
      </div>
    </section>
    <section>
      <h3>Pomodoro</h3>
      <label class="check"><input type="checkbox" class="pomo-ticking" /> Tictac de reloj mientras corre</label>
      <label class="check"><input type="checkbox" class="pomo-bell" /> Timbre al cambiar de fase</label>
      <label>Volumen <input type="range" class="pomo-volume" min="0" max="1" step="0.05" /></label>
      <div class="settings-actions">
        <button class="pomo-test">Probar sonido</button>
      </div>
    </section>
    <section data-section="tickets">
      <h3>Tickets (Pxsol Agencias)</h3>
      <p class="settings-help">Tabla debajo de la agenda. Usa el MCP de tickets que tengas configurado en Claude Code, solo para leer.</p>
      <label class="check"><input type="checkbox" class="tk-enabled" /> Mostrar el panel de tickets</label>
      <label class="tk-server-row">Servidor MCP <select class="tk-server"></select></label>
    </section>
    <section data-section="railway">
      <h3>Producción (Railway)</h3>
      <p class="settings-help">Indicador en la barra de título con la salud del entorno «production». Usa el CLI de Railway con tu sesión.</p>
      <label class="check"><input type="checkbox" class="rw-enabled" /> Mostrar el indicador de producción</label>
      <div class="rw-bulk">
        <span>Proyectos a vigilar</span>
        <button class="rw-all">Todos</button>
        <button class="rw-none">Ninguno</button>
      </div>
      <div class="rw-projects"></div>
    </section>`;
  document.body.append(dialog);

  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector(sel) as T;
  const browserSel = $<HTMLSelectElement>(".browser-select");
  const profileRow = $<HTMLLabelElement>(".profile-row");
  const profileSel = $<HTMLSelectElement>(".profile-select");
  const saved = $<HTMLSpanElement>(".settings-saved");
  const tickingBox = $<HTMLInputElement>(".pomo-ticking");
  const bellBox = $<HTMLInputElement>(".pomo-bell");
  const volumeRange = $<HTMLInputElement>(".pomo-volume");
  const rwEnabled = $<HTMLInputElement>(".rw-enabled");
  const rwProjects = $<HTMLDivElement>(".rw-projects");
  let railwayProjects: RailwayProject[] = [];
  let mcpServers: string[] = [];
  const tkEnabled = $<HTMLInputElement>(".tk-enabled");
  const tkServer = $<HTMLSelectElement>(".tk-server");
  /** false hasta la primera respuesta: lista vacía no significa "no hay proyectos" todavía. */
  let projectsLoaded = false;

  let browsers: BrowserInfo[] = [];
  let settings: Settings | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  function option(value: string, label: string): HTMLOptionElement {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function render() {
    if (!settings) return;
    const { appPath, profile } = settings.browser;
    browserSel.replaceChildren(
      option("", "Predeterminado del sistema"),
      ...browsers.map((b) => option(b.appPath, b.name)),
    );
    // Si el navegador guardado ya no está instalado, se muestra igual para no perder la elección.
    if (appPath && !browsers.some((b) => b.appPath === appPath)) browserSel.append(option(appPath, `${appPath} (no encontrado)`));
    browserSel.value = appPath ?? "";

    const profiles = browsers.find((b) => b.appPath === appPath)?.profiles ?? [];
    profileRow.hidden = profiles.length === 0;
    profileSel.replaceChildren(option("", "El último que usaste"), ...profiles.map((p) => option(p.dir, p.label)));
    profileSel.value = profiles.some((p) => p.dir === profile) ? (profile as string) : "";

    tickingBox.checked = settings.pomodoro.ticking;
    bellBox.checked = settings.pomodoro.bell;
    volumeRange.value = String(settings.pomodoro.volume);

    tkEnabled.checked = settings.tickets.enabled;
    $<HTMLLabelElement>(".tk-server-row").hidden = !settings.tickets.enabled;
    tkServer.replaceChildren(option("", "Automático (el primero de tickets)"), ...mcpServers.map((n) => option(n, n)));
    if (settings.tickets.server && !mcpServers.includes(settings.tickets.server)) {
      tkServer.append(option(settings.tickets.server, `${settings.tickets.server} (no encontrado)`));
    }
    tkServer.value = settings.tickets.server ?? "";

    rwEnabled.checked = settings.railway.enabled;
    rwProjects.hidden = !settings.railway.enabled;
    $<HTMLDivElement>(".rw-bulk").hidden = !settings.railway.enabled || !railwayProjects.length;
    rwProjects.replaceChildren();
    if (!railwayProjects.length) {
      const empty = document.createElement("p");
      empty.className = "settings-help";
      empty.textContent = projectsLoaded
        ? "No se encontraron proyectos (¿está instalado y logueado el CLI de Railway?)."
        : "Cargando proyectos…";
      rwProjects.append(empty);
    }
    const watched = settings.railway.projects;
    for (const p of railwayProjects) {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !watched || watched.includes(p.id);
      box.addEventListener("change", () => {
        const ids = [...rwProjects.querySelectorAll<HTMLInputElement>("input")].flatMap((b, i) => (b.checked ? [railwayProjects[i].id] : []));
        // Todos tildados = null: así un proyecto nuevo también se vigila.
        void save({ railway: { enabled: true, projects: ids.length === railwayProjects.length ? null : ids } });
      });
      const count = document.createElement("small");
      count.textContent = `${p.services} servicio${p.services === 1 ? "" : "s"}`;
      label.append(box, document.createTextNode(` ${p.name} `), count);
      rwProjects.append(label);
    }
  }

  async function save(patch: Partial<Settings>) {
    settings = await api.setSettings(patch);
    hooks.onChange(settings);
    render();
    saved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.hidden = true), 1500);
  }

  browserSel.addEventListener("change", () => {
    // Cambiar de navegador descarta el perfil: los perfiles son de cada navegador.
    void save({ browser: { appPath: browserSel.value || null, profile: null } });
  });
  profileSel.addEventListener("change", () => {
    void save({ browser: { appPath: settings!.browser.appPath, profile: profileSel.value || null } });
  });
  $<HTMLButtonElement>(".browser-test").addEventListener("click", () => api.testBrowser());

  const pomodoro = (): PomodoroSound => ({
    ticking: tickingBox.checked,
    bell: bellBox.checked,
    volume: Number(volumeRange.value),
  });
  tickingBox.addEventListener("change", () => void save({ pomodoro: pomodoro() }));
  bellBox.addEventListener("change", () => void save({ pomodoro: pomodoro() }));
  volumeRange.addEventListener("change", () => void save({ pomodoro: pomodoro() }));
  $<HTMLButtonElement>(".pomo-test").addEventListener("click", () => {
    // Prueba con el volumen del control, aunque el tictac o el timbre estén apagados.
    const volume = Number(volumeRange.value);
    tick("tic", volume);
    setTimeout(() => tick("tac", volume), 1000);
    setTimeout(() => bell(volume, 2), 2000);
  });

  $<HTMLButtonElement>(".rw-all").addEventListener("click", () => void save({ railway: { enabled: true, projects: null } }));
  $<HTMLButtonElement>(".rw-none").addEventListener("click", () => void save({ railway: { enabled: true, projects: [] } }));
  tkEnabled.addEventListener("change", () => void save({ tickets: { enabled: tkEnabled.checked, server: settings!.tickets.server } }));
  tkServer.addEventListener("change", () => void save({ tickets: { enabled: true, server: tkServer.value || null } }));
  rwEnabled.addEventListener("change", () => {
    void save({ railway: { enabled: rwEnabled.checked, projects: settings!.railway.projects } });
  });

  $<HTMLButtonElement>(".settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", hooks.onClose);
  // Clic en el fondo oscuro cierra.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  return {
    async open(section) {
      // Se abre ya con lo que se sabía y se completa cuando llegan los datos frescos: pudo
      // instalarse un navegador, crearse un perfil o un proyecto de Railway.
      settings ??= await api.getSettings();
      render();
      if (!dialog.open) dialog.showModal();
      if (section) {
        const el = dialog.querySelector<HTMLElement>(`[data-section="${section}"]`)!;
        el.scrollIntoView({ block: "start" });
        el.classList.remove("flash");
        void el.offsetWidth; // reinicia la animación si ya estaba
        el.classList.add("flash");
      }
      [settings, browsers, railwayProjects, mcpServers] = await Promise.all([
        api.getSettings(),
        api.listBrowsers(),
        api.listRailwayProjects(),
        api.listMcpServers(),
      ]);
      projectsLoaded = true;
      render();
    },
  };
}
