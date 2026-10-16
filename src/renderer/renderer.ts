import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { MenuCommand, Session, RollertermApi } from "../shared/types";
import { mountAgenda } from "./agenda";
import { mountPomodoro } from "./pomodoro";

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
const pomodoro = mountPomodoro(document.getElementById("pomodoro") as HTMLDivElement);
mountAgenda(document.getElementById("agenda") as HTMLElement, api);

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
    theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
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
  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Cerrar (⌘W)";
  tabEl.append(labelEl, closeBtn);
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
    createTab();
    return;
  }
  if (active === tab) activate(tabs[Math.min(idx, tabs.length - 1)]);
  scheduleSave();
}

function setName(tab: Tab, name: string) {
  tab.name = name;
  tab.labelEl.textContent = name;
  tab.tabEl.title = name;
  if (active === tab) document.title = name;
}

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
  if (cmd === "new-tab") createTab();
  else if (cmd === "close-tab" && active) closeTab(active);
  else if (cmd === "rename-tab" && active) startRename(active);
  else if (cmd === "next-tab" && tabs.length) activate(tabs[(idx + 1) % tabs.length]);
  else if (cmd === "pomodoro-toggle") pomodoro.toggle();
  else if (cmd === "pomodoro-reset") pomodoro.reset();
  else if (cmd === "prev-tab" && tabs.length) activate(tabs[(idx - 1 + tabs.length) % tabs.length]);
  else if (cmd.startsWith("goto-tab:")) {
    const n = Number(cmd.split(":")[1]);
    // ⌘9 va a la última, como en el navegador.
    const target = n === 8 ? tabs[tabs.length - 1] : tabs[n];
    if (target) activate(target);
  }
});

newTabBtn.addEventListener("click", () => createTab());
tabsEl.addEventListener("dblclick", (e) => {
  if (e.target === tabsEl) createTab(); // doble clic en el hueco de la barra abre una pestaña
});

new ResizeObserver(() => active?.fit.fit()).observe(panesEl);

// ---------- arranque: restaurar la sesión anterior ----------

async function boot() {
  const session = await api.loadSession().catch(() => null);
  if (!session) {
    createTab();
    return;
  }
  for (const t of session.tabs) createTab(t, false);
  const target = tabs.find((t) => t.id === session.activeId) ?? tabs[0];
  activate(target);
}

boot();
