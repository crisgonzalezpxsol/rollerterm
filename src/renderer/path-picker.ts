// Selector de carpeta para una pestaña nueva (⌘T o +): rutas guardadas, recientes u otra
// carpeta con el explorador. Sin ninguna guardada ni reciente, va directo al explorador.
import type { RollertermApi, Settings, TerminalSettings } from "../shared/types";

const MAX_RECENT = 10;

export interface PathPicker {
  /** La carpeta elegida, o null si se canceló. */
  pick(): Promise<string | null>;
  /** La ruta por defecto (la primera guardada), o "" para el home. */
  readonly defaultPath: string;
}

export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

export function mountPathPicker(
  api: RollertermApi,
  hooks: { settings: () => Settings | null; onChange: (s: Settings) => void },
): PathPicker {
  const dialog = document.createElement("dialog");
  dialog.id = "path-picker";
  dialog.innerHTML = `
    <input class="pp-filter" placeholder="Abrir terminal en…  (escribí para filtrar)" spellcheck="false" />
    <ul class="pp-list"></ul>
    <p class="pp-help">↑↓ elegir · Enter abrir · ★ guardar ruta · ⌘O otra carpeta · Esc cancelar</p>`;
  document.body.append(dialog);
  const filterEl = dialog.querySelector(".pp-filter") as HTMLInputElement;
  const listEl = dialog.querySelector(".pp-list") as HTMLUListElement;

  let resolve: ((path: string | null) => void) | null = null;
  let items: { path: string | null; el: HTMLLIElement }[] = [];
  let selected = 0;

  const terminal = (): TerminalSettings => hooks.settings()?.terminal ?? { paths: [], recent: [] };

  async function save(next: TerminalSettings) {
    hooks.onChange(await api.setSettings({ terminal: next }));
  }

  async function remember(path: string) {
    const t = terminal();
    await save({ ...t, recent: [path, ...t.recent.filter((p) => p !== path)].slice(0, MAX_RECENT) });
  }

  function finish(path: string | null) {
    const r = resolve;
    resolve = null;
    if (dialog.open) dialog.close();
    if (path) void remember(path);
    r?.(path);
  }

  async function browse() {
    const path = await api.pickFolder(terminal().paths[0] || undefined);
    if (path) finish(path);
    else if (dialog.open) filterEl.focus();
    else finish(null);
  }

  function select(i: number) {
    if (!items.length) return;
    selected = (i + items.length) % items.length;
    items.forEach((it, j) => it.el.classList.toggle("on", j === selected));
    items[selected].el.scrollIntoView({ block: "nearest" });
  }

  function render() {
    const { paths, recent } = terminal();
    const q = filterEl.value.trim().toLowerCase();
    const match = (p: string) => !q || p.toLowerCase().includes(q);
    listEl.replaceChildren();
    items = [];

    const section = (title: string) => {
      const li = document.createElement("li");
      li.className = "pp-section";
      li.textContent = title;
      listEl.append(li);
    };
    const row = (path: string, saved: boolean, isDefault: boolean) => {
      const li = document.createElement("li");
      li.className = "pp-item";
      li.title = path;
      const name = document.createElement("strong");
      name.textContent = baseName(path);
      const full = document.createElement("span");
      full.textContent = path;
      li.append(name, full);
      if (isDefault) {
        const tag = document.createElement("em");
        tag.textContent = "por defecto";
        li.append(tag);
      }
      const btn = (text: string, title: string, fn: () => Promise<void>) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.title = title;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          void fn().then(() => {
            render();
            filterEl.focus();
          });
        });
        li.append(b);
      };
      const t = terminal();
      if (saved && !isDefault) btn("⌂", "Usar por defecto", () => save({ ...t, paths: [path, ...t.paths.filter((p) => p !== path)] }));
      if (saved) btn("★", "Quitar de las rutas guardadas", () => save({ ...t, paths: t.paths.filter((p) => p !== path) }));
      else {
        btn("☆", "Guardar ruta", () => save({ ...t, paths: [...t.paths, path] }));
        btn("×", "Quitar de recientes", () => save({ ...t, recent: t.recent.filter((p) => p !== path) }));
      }
      li.addEventListener("click", () => finish(path));
      const idx = items.length;
      li.addEventListener("mousemove", () => selected !== idx && select(idx));
      listEl.append(li);
      items.push({ path, el: li });
    };

    const savedShown = paths.filter(match);
    if (savedShown.length) section("Rutas guardadas");
    savedShown.forEach((p, i) => row(p, true, i === 0 && p === paths[0]));
    const recentShown = recent.filter((p) => !paths.includes(p) && match(p));
    if (recentShown.length) section("Recientes");
    recentShown.forEach((p) => row(p, false, false));

    const other = document.createElement("li");
    other.className = "pp-item pp-browse";
    other.innerHTML = "<strong>📂 Otra carpeta…</strong><span>Elegila con el explorador</span>";
    other.addEventListener("click", () => void browse());
    const idx = items.length;
    other.addEventListener("mousemove", () => selected !== idx && select(idx));
    listEl.append(other);
    items.push({ path: null, el: other });
    select(0);
  }

  filterEl.addEventListener("input", render);
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") select(selected + 1);
    else if (e.key === "ArrowUp") select(selected - 1);
    else if (e.key === "Enter") {
      const it = items[selected];
      if (it?.path) finish(it.path);
      else void browse();
    } else if (e.key === "o" && e.metaKey) void browse();
    else return;
    e.preventDefault();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) finish(null); // clic en el fondo oscuro
  });
  dialog.addEventListener("close", () => finish(null));

  return {
    get defaultPath() {
      return terminal().paths[0] ?? "";
    },
    pick() {
      if (resolve) return Promise.resolve(null); // ya hay uno abierto
      return new Promise((r) => {
        resolve = r;
        const { paths, recent } = terminal();
        if (!paths.length && !recent.length) {
          void browse();
          return;
        }
        filterEl.value = "";
        render();
        dialog.showModal();
        filterEl.focus();
      });
    },
  };
}
