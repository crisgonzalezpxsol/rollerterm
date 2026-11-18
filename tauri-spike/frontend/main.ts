// Prototipo mínimo: pestañas con nombre + xterm.js hablando con el PTY en Rust.
// Usa la API global de Tauri (withGlobalTauri) para no sumar dependencias npm.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number };

const { invoke, Channel } = (window as any).__TAURI__.core;

interface Tab {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement;
  tabEl: HTMLDivElement;
  label: HTMLSpanElement;
}

const tabsEl = document.getElementById("tabs")!;
const newBtn = document.getElementById("new")!;
const panesEl = document.getElementById("panes")!;
const tabs: Tab[] = [];
let active: Tab | null = null;
let counter = 0;

async function createTab(name?: string) {
  const id = `t${Date.now()}-${counter++}`;
  const pane = document.createElement("div");
  pane.className = "pane";
  panesEl.appendChild(pane);

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
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
  const label = document.createElement("span");
  label.textContent = name ?? `terminal ${counter}`;
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  tabEl.append(label, close);
  tabsEl.insertBefore(tabEl, newBtn);

  const tab: Tab = { id, name: label.textContent, term, fit, pane, tabEl, label };
  tabs.push(tab);

  tabEl.addEventListener("mousedown", (e) => {
    if (e.target !== close) activate(tab);
  });
  close.addEventListener("click", () => closeTab(tab));
  label.addEventListener("dblclick", () => rename(tab));

  activate(tab);

  const channel = new Channel();
  channel.onmessage = (ev: PtyEvent) => {
    if (ev.kind === "data") term.write(ev.data);
    else term.write(`\r\n\x1b[2m[proceso terminado: ${ev.code}]\x1b[0m\r\n`);
  };
  term.onData((data) => invoke("pty_write", { id, data }));
  term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }));

  await invoke("pty_create", { id, cwd: null, cols: term.cols, rows: term.rows, onEvent: channel });
}

function activate(tab: Tab) {
  active = tab;
  for (const t of tabs) {
    const on = t === tab;
    t.pane.classList.toggle("active", on);
    t.tabEl.classList.toggle("active", on);
  }
  requestAnimationFrame(() => {
    tab.fit.fit();
    tab.term.focus();
  });
}

function closeTab(tab: Tab) {
  invoke("pty_kill", { id: tab.id });
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (tabs.length === 0) return void invoke("quit");
  if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
}

function rename(tab: Tab) {
  const input = document.createElement("input");
  input.value = tab.name;
  tab.label.replaceWith(input);
  input.focus();
  input.select();
  const done = (save: boolean) => {
    if (save && input.value.trim()) tab.name = input.value.trim();
    tab.label.textContent = tab.name;
    input.replaceWith(tab.label);
    tab.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true), { once: true });
}

newBtn.addEventListener("click", () => createTab());

// Mismos atajos que la versión Electron en Linux.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "t") createTab();
    else if (k === "w" && active) closeTab(active);
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

new ResizeObserver(() => active?.fit.fit()).observe(panesEl);

// Tiempo hasta la primera pestaña lista, para comparar el arranque con Electron.
const t0 = performance.now();
createTab("terminal 1").then(() => {
  document.getElementById("stats")!.textContent = `listo en ${Math.round(performance.now() - t0)} ms (desde el JS)`;
});
