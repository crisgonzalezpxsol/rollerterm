// Configuración de la app (settings.json) y apertura de links con el navegador elegido.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import type { BrowserInfo, Settings } from "../shared/types";

const DEFAULTS: Settings = {
  browser: { appPath: null, profile: null },
  pomodoro: { ticking: true, bell: true, volume: 0.6 },
};

/**
 * Navegadores conocidos. `profilesDir` es la carpeta de datos de los basados en Chromium,
 * donde "Local State" lista los perfiles.
 */
const KNOWN_BROWSERS: { name: string; bundle: string; profilesDir?: string }[] = [
  { name: "Safari", bundle: "Safari.app" },
  { name: "Google Chrome", bundle: "Google Chrome.app", profilesDir: "Google/Chrome" },
  { name: "Google Chrome Canary", bundle: "Google Chrome Canary.app", profilesDir: "Google/Chrome Canary" },
  { name: "Chromium", bundle: "Chromium.app", profilesDir: "Chromium" },
  { name: "Brave", bundle: "Brave Browser.app", profilesDir: "BraveSoftware/Brave-Browser" },
  { name: "Microsoft Edge", bundle: "Microsoft Edge.app", profilesDir: "Microsoft Edge" },
  { name: "Vivaldi", bundle: "Vivaldi.app", profilesDir: "Vivaldi" },
  { name: "Opera", bundle: "Opera.app" },
  { name: "Arc", bundle: "Arc.app" },
  { name: "Dia", bundle: "Dia.app" },
  { name: "Firefox", bundle: "Firefox.app" },
  { name: "Firefox Developer Edition", bundle: "Firefox Developer Edition.app" },
  { name: "Zen", bundle: "Zen.app" },
  { name: "Orion", bundle: "Orion.app" },
];

const file = () => join(app.getPath("userData"), "settings.json");

export class SettingsStore {
  private settings: Settings = DEFAULTS;

  get current(): Settings {
    return this.settings;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(file(), "utf8")) as Partial<Settings>;
      this.settings = {
        browser: { ...DEFAULTS.browser, ...saved.browser },
        pomodoro: { ...DEFAULTS.pomodoro, ...saved.pomodoro },
      };
    } catch {
      // Primera vez o archivo corrupto: valores por defecto.
    }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    // Escritura atómica: un cierre a mitad de camino no deja el JSON roto.
    await writeFile(`${file()}.tmp`, JSON.stringify(this.settings, null, 2));
    await rename(`${file()}.tmp`, file());
    return this.settings;
  }

  /** Abre un link http(s) con el navegador (y perfil) configurado; si falla, con el del sistema. */
  openUrl(url: string): void {
    if (!/^https?:\/\//i.test(url)) return;
    const { appPath, profile } = this.settings.browser;
    if (!appPath || !existsSync(appPath)) {
      void shell.openExternal(url);
      return;
    }
    // Con perfil, `open -n` lanza el navegador con --profile-directory; si ya está abierto,
    // le pasa el link a esa ventana del perfil.
    const args = profile ? ["-na", appPath, "--args", `--profile-directory=${profile}`, url] : ["-a", appPath, url];
    execFile("open", args, (err) => {
      if (err) {
        console.error("[openUrl]", err);
        void shell.openExternal(url);
      }
    });
  }
}

/** Navegadores instalados en /Applications o ~/Applications, con sus perfiles si se pueden leer. */
export async function listBrowsers(): Promise<BrowserInfo[]> {
  const dirs = ["/Applications", join(homedir(), "Applications")];
  const found: BrowserInfo[] = [];
  for (const b of KNOWN_BROWSERS) {
    const appPath = dirs.map((d) => join(d, b.bundle)).find((p) => existsSync(p));
    if (appPath) found.push({ name: b.name, appPath, profiles: b.profilesDir ? await readProfiles(b.profilesDir) : [] });
  }
  return found;
}

async function readProfiles(profilesDir: string): Promise<BrowserInfo["profiles"]> {
  try {
    const localState = join(homedir(), "Library/Application Support", profilesDir, "Local State");
    const parsed = JSON.parse(await readFile(localState, "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
    };
    return Object.entries(parsed.profile?.info_cache ?? {}).map(([dir, info]) => ({
      dir,
      label: info.user_name && info.user_name !== info.name ? `${info.name} (${info.user_name})` : (info.name ?? dir),
    }));
  } catch {
    return [];
  }
}
