// Ventana de configuración (⚙ en la barra de título o ⌘,). Cada cambio se guarda al instante.
import type { BrowserInfo, RollertermApi, Settings } from "../shared/types";

export interface SettingsPanel {
  open(): void;
}

export function mountSettings(api: RollertermApi, onClose: () => void): SettingsPanel {
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
    </section>`;
  document.body.append(dialog);

  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector(sel) as T;
  const browserSel = $<HTMLSelectElement>(".browser-select");
  const profileRow = $<HTMLLabelElement>(".profile-row");
  const profileSel = $<HTMLSelectElement>(".profile-select");
  const saved = $<HTMLSpanElement>(".settings-saved");

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
  }

  async function save(patch: Partial<Settings>) {
    settings = await api.setSettings(patch);
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
  $<HTMLButtonElement>(".settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", onClose);
  // Clic en el fondo oscuro cierra.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  return {
    async open() {
      // Se vuelve a leer cada vez: pudo instalarse un navegador o crearse un perfil.
      [settings, browsers] = await Promise.all([api.getSettings(), api.listBrowsers()]);
      render();
      if (!dialog.open) dialog.showModal();
    },
  };
}
