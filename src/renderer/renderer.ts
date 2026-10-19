import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { MenuCommand, Session, RollertermApi, Settings } from "../shared/types";
import { mountAgenda } from "./agenda";
import { mountAssistant } from "./assistant";
import { mountTicketView } from "./ticket-view";
import { mountMail } from "./mail";
import { mountNotes } from "./notes";
import { setMuted } from "./notify";
import { baseName, mountPathPicker } from "./path-picker";
import { mountPomodoro } from "./pomodoro";
import { mountProd } from "./prod";
import { mountSettings } from "./settings";
import { mountTickets } from "./tickets";

declare global {
  interface Window {
    rollerterm: RollertermApi;
  }
}

const api = window.rollerterm;

interface Tab {
  id: string;
  name: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement;
  tabEl: HTMLDivElement;
  labelEl: HTMLSpanElement;
  /** false cuando la shell terminó: la pestaña queda con su nombre y Enter la reabre. */
  alive: boolean;
}

const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const panesEl = document.getElementById("panes") as HTMLDivElement;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;
// Configuración local para lo que se lee a cada rato (sonido del pomodoro); se actualiza
// al arrancar y con cada cambio en la ventana de configuración.
let settings: Settings | null = null;
const muteBtn = document.getElementById("toggle-mute") as HTMLButtonElement;
function applySettings(s: Settings) {
  settings = s;
  setMuted(s.muted);
  muteBtn.textContent = s.muted ? "🔕" : "🔔";
  muteBtn.classList.toggle("on", s.muted);
  muteBtn.title = s.muted ? "Silenciado: sin sonidos ni avisos. Clic para activar (⌘⇧M)" : "Silenciar sonidos y avisos (⌘⇧M)";
}
api.getSettings().then(applySettings);
async function toggleMute() {
  if (settings) applySettings(await api.setSettings({ muted: !settings.muted }));
}
muteBtn.addEventListener("click", () => void toggleMute());
const pomodoro = mountPomodoro(
  document.getElementById("pomodoro") as HTMLDivElement,
  () => settings?.pomodoro ?? { ticking: true, bell: true, volume: 0.6 },
);
mountAgenda(document.getElementById("agenda") as HTMLElement, api);
mountMail(document.getElementById("mail") as HTMLElement, api);
const ticketView = mountTicketView(api, { onClose: () => active?.term.focus() });
mountTickets(document.getElementById("tickets") as HTMLElement, api, (t) => ticketView.open(t));
const notesPanel = mountNotes(api, () => active?.term.focus());
// Un panel lateral a la vez: abrir el chat cierra las notas y al revés.
const assistantPanel = mountAssistant(api, { onOpen: () => notesPanel.close(), onClose: () => active?.term.focus() });
const toggleNotes = () => {
  if (!notesPanel.isOpen) assistantPanel.close();
  notesPanel.toggle();
};
document.getElementById("toggle-notes")!.addEventListener("click", toggleNotes);
document.getElementById("toggle-assistant")!.addEventListener("click", () => assistantPanel.toggle());
const settingsPanel = mountSettings(api, {
  onClose: () => active?.term.focus(),
  onChange: applySettings,
});
document.getElementById("open-settings")!.addEventListener("click", () => void settingsPanel.open());
mountProd(document.getElementById("prod") as HTMLElement, api, () => void settingsPanel.open("railway"));
const pathPicker = mountPathPicker(api, { settings: () => settings, onChange: applySettings });

let tabs: Tab[] = [];
let active: Tab | null = null;
let counter = 0;

// ---------- persistencia ----------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const session: Session = {
      tabs: tabs.map(({ id, name, cwd }) => ({ id, name, cwd })),
      activeId: active?.id ?? null,
    };
    api.saveSession(session).catch((err) => console.error("[saveSession]", err));
  }, 300);
}

// ---------- ciclo de vida de una pestaña ----------

function startShell(tab: Tab) {
  tab.alive = true;
  tab.tabEl.classList.remove("ended");
  return api.createPty(tab.id, tab.cwd, tab.term.cols, tab.term.rows);
}

function createTab(opts: { id?: string; name?: string; cwd?: string } = {}, focus = true): Tab {
  counter += 1;
  const id = opts.id ?? crypto.randomUUID();

  const pane = document.createElement("div");
  pane.className = "pane";
  panesEl.appendChild(pane);

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: {
      background: "#13112b",
      foreground: "#e0def4",
      cursor: "#c4b5ff",
      cursorAccent: "#13112b",
      selectionBackground: "#7c5cff55",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
  term.open(pane);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.draggable = true;
  const labelEl = document.createElement("span");
  labelEl.className = "label";
  // Segunda línea: la carpeta, para distinguir pestañas con nombres parecidos.
  const pathEl = document.createElement("span");
  pathEl.className = "path";
  // Las marcas LRM evitan que "~" y "/" se acomoden al revés por el direction: rtl del CSS.
  pathEl.textContent = `\u200e${shortPath(opts.cwd ?? "") || "~"}\u200e`;
  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.append(labelEl, pathEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Cerrar (⌘W)";
  tabEl.append(textEl, closeBtn);
  tabsEl.appendChild(tabEl);

  const tab: Tab = { id, name: opts.name ?? `Terminal ${counter}`, cwd: opts.cwd ?? "", term, fit, pane, tabEl, labelEl, alive: false };
  setName(tab, tab.name);
  tabs.push(tab);

  term.onData((data) => {
    if (tab.alive) api.write(tab.id, data);
    else if (data === "\r") {
      term.reset();
      startShell(tab).catch((err) => console.error("[startShell]", err));
    }
  });
  term.onResize(({ cols, rows }) => api.resize(tab.id, cols, rows));

  tabEl.addEventListener("mousedown", (e) => {
    if (e.button === 1) closeTab(tab); // clic con la rueda cierra, como en el navegador
    else if (e.target !== closeBtn) activate(tab);
  });
  labelEl.addEventListener("dblclick", () => startRename(tab));
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  wireDrag(tab);

  // La shell se crea después de medir la pestaña, para que arranque con el tamaño real.
  activate(tab, focus);
  startShell(tab).catch((err) => console.error("[startShell]", err));
  scheduleSave();
  return tab;
}

function activate(tab: Tab, focus = true) {
  if (active && active !== tab) {
    active.pane.classList.remove("active");
    active.tabEl.classList.remove("active");
  }
  active = tab;
  tab.pane.classList.add("active");
  tab.tabEl.classList.add("active");
  tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.title = tab.name;
  tab.fit.fit();
  if (focus) tab.term.focus();
  scheduleSave();
}

function closeTab(tab: Tab) {
  const idx = tabs.indexOf(tab);
  api.kill(tab.id);
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    active = null;
    createDefaultTab();
    return;
  }
  if (active === tab) activate(tabs[Math.min(idx, tabs.length - 1)]);
  scheduleSave();
}

/** /Users/fulano/x → ~/x */
function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function setName(tab: Tab, name: string) {
  tab.name = name;
  tab.labelEl.textContent = name;
  tab.tabEl.title = tab.cwd ? `${name}\n${shortPath(tab.cwd)}` : name;
  if (active === tab) document.title = name;
}

/** Pestaña nueva en la carpeta que se elija (rutas guardadas, recientes o el explorador). */
async function newTab() {
  const cwd = await pathPicker.pick();
  if (cwd) createTab({ cwd, name: baseName(cwd) });
  else active?.term.focus();
}

/** Sin preguntar: en la ruta por defecto (la primera guardada) o en el home. */
function createDefaultTab() {
  const cwd = pathPicker.defaultPath;
  createTab(cwd ? { cwd, name: baseName(cwd) } : {});
}

// ---------- agrandar la terminal hacia arriba ----------

const topEl = document.getElementById("top") as HTMLDivElement;
const terminalsEl = document.getElementById("terminals") as HTMLElement;
const splitter = document.getElementById("splitter") as HTMLDivElement;
const maxBtn = document.getElementById("toggle-max") as HTMLButtonElement;
const MIN_TERMINAL = 120;
/** Fracción del alto que ocupan las terminales; 1 = paneles de arriba ocultos. */
let terminalShare = 0.5;
/** El tamaño de antes de agrandar, para restaurarlo. */
let restoreShare = 0.5;
try {
  terminalShare = Number(localStorage.getItem("terminal-share")) || 0.5;
  restoreShare = Number(localStorage.getItem("terminal-restore")) || 0.5;
} catch {
  // sin almacenamiento local: mitad y mitad
}

function applyShare(share: number) {
  terminalShare = Math.min(1, Math.max(0.1, share));
  const max = terminalShare >= 0.98;
  topEl.hidden = max;
  topEl.style.flex = `${1 - terminalShare} 1 0`;
  terminalsEl.style.flex = `${terminalShare} 1 0`;
  maxBtn.textContent = max ? "⤓" : "⤒";
  maxBtn.title = max ? "Restaurar los paneles de arriba (⌘⇧Enter)" : "Agrandar la terminal hacia arriba (⌘⇧Enter)";
  try {
    localStorage.setItem("terminal-share", String(terminalShare));
    localStorage.setItem("terminal-restore", String(restoreShare));
  } catch {
    // no importa si no se puede recordar
  }
}

function toggleMax() {
  if (terminalShare >= 0.98) applyShare(restoreShare >= 0.98 ? 0.5 : restoreShare);
  else {
    restoreShare = terminalShare;
    applyShare(1);
  }
  active?.term.focus();
}

splitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  // Donde empieza la zona de paneles (debajo de la barra de título), aunque estén ocultos.
  const area = document.getElementById("titlebar")!.getBoundingClientRect().bottom;
  const onMove = (ev: PointerEvent) => {
    const total = window.innerHeight - area;
    const height = Math.max(MIN_TERMINAL, window.innerHeight - ev.clientY);
    // Arrastrar casi hasta arriba es agrandar del todo.
    applyShare(ev.clientY - area < 40 ? 1 : height / total);
  };
  const onUp = () => {
    splitter.classList.remove("dragging");
    splitter.removeEventListener("pointermove", onMove);
    splitter.removeEventListener("pointerup", onUp);
    if (terminalShare < 0.98) restoreShare = terminalShare;
    applyShare(terminalShare);
  };
  splitter.addEventListener("pointermove", onMove);
  splitter.addEventListener("pointerup", onUp);
});
splitter.addEventListener("dblclick", toggleMax);
maxBtn.addEventListener("click", toggleMax);
applyShare(terminalShare);

// ---------- ancho de la columna de pestañas ----------

const tabbarEl = document.getElementById("tabbar") as HTMLElement;
const tabbarResizer = document.getElementById("tabbar-resizer") as HTMLDivElement;
const TABBAR_DEFAULT = 230;
function applyTabbarWidth(width: number) {
  const w = Math.round(Math.min(480, Math.max(150, width)));
  tabbarEl.style.width = `${w}px`;
  try {
    localStorage.setItem("tabbar-width", String(w));
  } catch {
    // no importa si no se puede recordar
  }
}
try {
  applyTabbarWidth(Number(localStorage.getItem("tabbar-width")) || TABBAR_DEFAULT);
} catch {
  applyTabbarWidth(TABBAR_DEFAULT);
}
tabbarResizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  tabbarResizer.setPointerCapture(e.pointerId);
  tabbarResizer.classList.add("dragging");
  const left = tabbarEl.getBoundingClientRect().left;
  const onMove = (ev: PointerEvent) => applyTabbarWidth(ev.clientX - left);
  const onUp = () => {
    tabbarResizer.classList.remove("dragging");
    tabbarResizer.removeEventListener("pointermove", onMove);
    tabbarResizer.removeEventListener("pointerup", onUp);
  };
  tabbarResizer.addEventListener("pointermove", onMove);
  tabbarResizer.addEventListener("pointerup", onUp);
});
tabbarResizer.addEventListener("dblclick", () => applyTabbarWidth(TABBAR_DEFAULT));

// ---------- renombrar ----------

function startRename(tab: Tab) {
  if (tab.tabEl.querySelector("input")) return;
  const input = document.createElement("input");
  input.value = tab.name;
  tab.labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(tab.labelEl);
    if (commit && value) {
      setName(tab, value);
      scheduleSave();
    }
    tab.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
}

// ---------- reordenar arrastrando ----------

let dragging: Tab | null = null;
function wireDrag(tab: Tab) {
  const el = tab.tabEl;
  el.addEventListener("dragstart", () => (dragging = tab));
  el.addEventListener("dragend", () => (dragging = null));
  el.addEventListener("dragover", (e) => {
    if (!dragging || dragging === tab) return;
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!dragging || dragging === tab) return;
    tabs.splice(tabs.indexOf(dragging), 1);
    tabs.splice(tabs.indexOf(tab), 0, dragging);
    tabsEl.insertBefore(dragging.tabEl, el);
    scheduleSave();
  });
}

// ---------- eventos globales ----------

api.onData((id, data) => tabs.find((t) => t.id === id)?.term.write(data));

api.onExit((id, code) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.alive = false;
  tab.tabEl.classList.add("ended");
  tab.term.write(`\r\n\x1b[2m[proceso terminado (código ${code}) — Enter para reabrir, ⌘W para cerrar]\x1b[0m\r\n`);
});

api.onMenu((cmd: MenuCommand) => {
  const idx = active ? tabs.indexOf(active) : -1;
  if (cmd === "new-tab") void newTab();
  // Con las notas abiertas, ⌘W las cierra en vez de cerrar la pestaña de la terminal.
  else if (cmd === "close-tab" && notesPanel.isOpen) notesPanel.close();
  else if (cmd === "close-tab" && assistantPanel.isOpen) assistantPanel.close();
  else if (cmd === "toggle-notes") toggleNotes();
  else if (cmd === "toggle-assistant") assistantPanel.toggle();
  else if (cmd === "toggle-mute") void toggleMute();
  else if (cmd === "toggle-terminal-max") toggleMax();
  else if (cmd === "close-tab" && active) closeTab(active);
  else if (cmd === "rename-tab" && active) startRename(active);
  else if (cmd === "next-tab" && tabs.length) activate(tabs[(idx + 1) % tabs.length]);
  else if (cmd === "pomodoro-toggle") pomodoro.toggle();
  else if (cmd === "pomodoro-reset") pomodoro.reset();
  else if (cmd === "open-settings") void settingsPanel.open();
  else if (cmd === "prev-tab" && tabs.length) activate(tabs[(idx - 1 + tabs.length) % tabs.length]);
  else if (cmd.startsWith("goto-tab:")) {
    const n = Number(cmd.split(":")[1]);
    // ⌘9 va a la última, como en el navegador.
    const target = n === 8 ? tabs[tabs.length - 1] : tabs[n];
    if (target) activate(target);
  }
});

newTabBtn.addEventListener("click", () => void newTab());
tabsEl.addEventListener("dblclick", (e) => {
  if (e.target === tabsEl) void newTab(); // doble clic en el hueco de la lista abre una pestaña
});

new ResizeObserver(() => active?.fit.fit()).observe(panesEl);

// ---------- arranque: restaurar la sesión anterior ----------

async function boot() {
  const session = await api.loadSession().catch(() => null);
  // La ruta por defecto sale de la configuración: esperarla antes de la primera pestaña.
  if (!settings) applySettings(await api.getSettings());
  if (!session?.tabs.length) {
    createDefaultTab();
    return;
  }
  for (const t of session.tabs) createTab(t, false);
  const target = tabs.find((t) => t.id === session.activeId) ?? tabs[0];
  activate(target);
}

boot();
