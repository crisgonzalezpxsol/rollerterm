import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { MenuCommand, Session, RollertermApi, Settings, TabSector, TabStatus, Ticket } from "../shared/types";
import { mountAgenda } from "./agenda";
import { mountAssistant } from "./assistant";
import { showContextMenu, type MenuItem } from "./context-menu";
import { mountTicketView } from "./ticket-view";
import { mountMail } from "./mail";
import { mountNotes } from "./notes";
import { setMuted } from "./notify";
import { setVoicePrefs } from "./speech";
import { baseName, mountPathPicker } from "./path-picker";
import { mountPomodoro } from "./pomodoro";
import { mountProd } from "./prod";
import { mountSettings } from "./settings";
import { mountTickets } from "./tickets";
import { mountUsage } from "./usage";

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
  /** Sector de la columna lateral; null = suelta. */
  sectorId: string | null;
  status: TabStatus | null;
  statusEl: HTMLSpanElement;
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
  setVoicePrefs(s.assistant.voice, s.assistant.rate);
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
mountTickets(document.getElementById("tickets") as HTMLElement, api, {
  open: (t) => ticketView.open(t),
  openInTerminal: (t) => void openTicketTerminal(t),
});
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
  onExport: () => exportConfig(),
  onImport: () => importConfig(),
});
document.getElementById("open-settings")!.addEventListener("click", () => void settingsPanel.open());
mountProd(document.getElementById("prod") as HTMLElement, api, () => void settingsPanel.open("railway"));
mountUsage(document.getElementById("usage") as HTMLElement, api);
const pathPicker = mountPathPicker(api, { settings: () => settings, onChange: applySettings });

let tabs: Tab[] = [];
let active: Tab | null = null;
let sectors: TabSector[] = [];
let counter = 0;

// ---------- persistencia ----------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const session: Session = {
      tabs: tabs.map(({ id, name, cwd, sectorId, status }) => ({ id, name, cwd, sectorId, status })),
      activeId: active?.id ?? null,
      sectors,
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

function createTab(opts: { id?: string; name?: string; cwd?: string; sectorId?: string | null; status?: TabStatus | null } = {}, focus = true): Tab {
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
  // Etiqueta de estado (en proceso, deployando…): un clic la cambia.
  const statusEl = document.createElement("span");
  statusEl.className = "tab-status";
  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.append(labelEl, statusEl, pathEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Cerrar (⌘W)";
  tabEl.append(textEl, closeBtn);

  // Un sector que ya no existe (se borró en otra sesión) deja la pestaña suelta.
  const sectorId = sectors.some((x) => x.id === opts.sectorId) ? opts.sectorId! : null;
  const tab: Tab = { id, name: opts.name ?? `Terminal ${counter}`, cwd: opts.cwd ?? "", term, fit, pane, tabEl, labelEl, sectorId, status: null, statusEl, alive: false };
  setName(tab, tab.name);
  setStatus(tab, opts.status && opts.status in TAB_STATUS ? opts.status : null, false);
  tabs.push(tab);
  renderTabList();

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
  tabEl.addEventListener("contextmenu", (e) => showContextMenu(e, tabMenu(tab)));
  statusEl.addEventListener("mousedown", (e) => e.stopPropagation());
  statusEl.addEventListener("click", (e) => showContextMenu(e, statusItems(tab)));
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
  const sector = sectors.find((x) => x.id === tab.sectorId);
  if (sector?.collapsed) {
    sector.collapsed = false;
    renderTabList();
  }
  tab.pane.classList.add("active");
  tab.tabEl.classList.add("active");
  tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.title = tab.name;
  tab.fit.fit();
  if (focus) tab.term.focus();
  scheduleSave();
}

function closeTab(tab: Tab) {
  const order = visualOrder();
  const idx = order.indexOf(tab);
  api.kill(tab.id);
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  renderTabList();
  if (tabs.length === 0) {
    active = null;
    createDefaultTab();
    return;
  }
  // La que queda al lado en la columna (no la que sigue en el orden de creación).
  order.splice(idx, 1);
  if (active === tab) activate(order[Math.min(idx, order.length - 1)]);
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

/** Pestaña para trabajar un ticket: se llama "#381 Asunto" y va al sector de tickets si lo hay. */
async function openTicketTerminal(t: Pick<Ticket, "numero" | "asunto">) {
  const existing = tabs.find((x) => new RegExp(`^#?${t.numero}\\b`).test(x.name));
  if (existing) return activate(existing);
  const cwd = await pathPicker.pick();
  if (!cwd) return active?.term.focus();
  const sector = sectors.find((x) => /ticket/i.test(x.name));
  createTab({ cwd, name: `#${t.numero} ${t.asunto}`.trim(), sectorId: sector?.id ?? null });
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

// ---------- sectores (grupos de pestañas) ----------

const DEFAULT_SECTORS = ["Tickets", "En espera", "Leer luego"];

/** Las pestañas en el orden en que se ven: primero las sueltas, después cada sector. */
function visualOrder(): Tab[] {
  return [null, ...sectors.map((x) => x.id)].flatMap((id) => tabs.filter((t) => t.sectorId === id));
}

/** Rearma la columna con los nodos de siempre (moverlos no reinicia nada). */
function renderTabList() {
  const loose = document.createElement("div");
  loose.className = "tab-group loose";
  wireDropZone(loose, null);
  loose.append(...tabs.filter((t) => t.sectorId === null).map((t) => t.tabEl));

  const blocks = sectors.map((sector) => {
    const block = document.createElement("section");
    block.className = "sector";
    block.classList.toggle("collapsed", sector.collapsed);
    const members = tabs.filter((t) => t.sectorId === sector.id);
    const head = document.createElement("div");
    head.className = "sector-head";
    head.title = "Clic: plegar / desplegar · doble clic: renombrar · clic derecho: más opciones";
    const chevron = document.createElement("span");
    chevron.className = "sector-chevron";
    chevron.textContent = "›";
    const name = document.createElement("span");
    name.className = "sector-name";
    name.textContent = sector.name;
    const count = document.createElement("span");
    count.className = "sector-count";
    count.textContent = members.length ? String(members.length) : "";
    head.append(chevron, name, count);
    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      sector.collapsed = !sector.collapsed;
      renderTabList();
      scheduleSave();
    });
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renameSector(sector, name);
    });
    head.addEventListener("contextmenu", (e) => showContextMenu(e, sectorMenu(sector, name)));
    wireDropZone(head, sector.id);
    const list = document.createElement("div");
    list.className = "tab-group";
    wireDropZone(list, sector.id);
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "sector-empty";
      empty.textContent = "Arrastrá pestañas acá";
      list.append(empty);
    }
    list.append(...members.map((t) => t.tabEl));
    block.append(head, list);
    return { block, name, sector };
  });

  const add = document.createElement("button");
  add.className = "sector-add";
  add.textContent = "+ Nuevo sector";
  add.title = "Un grupo para apartar pestañas: tickets, en espera, para leer luego…";
  add.addEventListener("click", () => newSector());
  tabsEl.replaceChildren(loose, ...blocks.map((b) => b.block), add);
  return blocks;
}

function moveToSector(tab: Tab, sectorId: string | null) {
  if (tab.sectorId === sectorId) return;
  tab.sectorId = sectorId;
  // Al final del sector nuevo.
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.push(tab);
  renderTabList();
  scheduleSave();
}

/** Crea un sector y deja el nombre listo para escribir; si viene una pestaña, la mueve ahí. */
function newSector(tab?: Tab) {
  const sector: TabSector = { id: crypto.randomUUID(), name: "Sector nuevo", collapsed: false };
  sectors.push(sector);
  if (tab) tab.sectorId = sector.id;
  const block = renderTabList().find((b) => b.sector === sector);
  scheduleSave();
  if (block) renameSector(sector, block.name);
}

function renameSector(sector: TabSector, nameEl: HTMLElement) {
  const input = document.createElement("input");
  input.value = sector.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value) sector.name = value;
    renderTabList();
    scheduleSave();
    active?.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function deleteSector(sector: TabSector) {
  const members = tabs.filter((t) => t.sectorId === sector.id);
  if (members.length && !confirm(`¿Borrar el sector «${sector.name}»? Sus ${members.length} pestañas quedan sueltas, no se cierran.`)) return;
  for (const t of members) t.sectorId = null;
  sectors = sectors.filter((x) => x !== sector);
  renderTabList();
  scheduleSave();
}

function moveSector(sector: TabSector, delta: number) {
  const i = sectors.indexOf(sector);
  const j = i + delta;
  if (j < 0 || j >= sectors.length) return;
  sectors.splice(i, 1);
  sectors.splice(j, 0, sector);
  renderTabList();
  scheduleSave();
}

function sectorMenu(sector: TabSector, nameEl: HTMLElement): MenuItem[] {
  const i = sectors.indexOf(sector);
  return [
    { label: "Renombrar", action: () => renameSector(sector, nameEl) },
    { label: sector.collapsed ? "Desplegar" : "Plegar", action: () => ((sector.collapsed = !sector.collapsed), renderTabList(), scheduleSave()) },
    { label: "Subir", action: () => moveSector(sector, -1), disabled: i === 0 },
    { label: "Bajar", action: () => moveSector(sector, 1), disabled: i === sectors.length - 1 },
    "-",
    { label: "Nuevo sector", action: () => newSector() },
    { label: "Borrar sector", action: () => deleteSector(sector), danger: true },
  ];
}

// ---------- etiquetas de estado ----------

const TAB_STATUS: Record<TabStatus, { label: string; menu: string }> = {
  working: { label: "En proceso", menu: "🔵 En proceso" },
  "deploy-testing": { label: "Deploy testing", menu: "🟡 Deployando a testing" },
  "deploy-prod": { label: "Deploy producción", menu: "🔴 Deployando a producción" },
};

function setStatus(tab: Tab, status: TabStatus | null, save = true) {
  tab.status = status;
  if (status) tab.tabEl.dataset.status = status;
  else delete tab.tabEl.dataset.status;
  tab.statusEl.textContent = status ? TAB_STATUS[status].label : "";
  tab.statusEl.title = status ? "Cambiar la etiqueta" : "";
  if (save) scheduleSave();
}

function statusItems(tab: Tab): MenuItem[] {
  return [
    { header: "Etiqueta" },
    ...(Object.keys(TAB_STATUS) as TabStatus[]).map((s): MenuItem => ({ label: TAB_STATUS[s].menu, action: () => setStatus(tab, s), checked: tab.status === s })),
    { label: "Sin etiqueta", action: () => setStatus(tab, null), checked: tab.status === null },
  ];
}

function tabMenu(tab: Tab): MenuItem[] {
  return [
    { label: "Renombrar", action: () => startRename(tab) },
    "-",
    ...statusItems(tab),
    "-",
    { header: "Mover a" },
    { label: "Sin sector", action: () => moveToSector(tab, null), checked: tab.sectorId === null },
    ...sectors.map((x): MenuItem => ({ label: x.name, action: () => moveToSector(tab, x.id), checked: tab.sectorId === x.id })),
    { label: "Sector nuevo…", action: () => newSector(tab) },
    "-",
    { label: "Cerrar", action: () => closeTab(tab), danger: true },
  ];
}

// ---------- reordenar arrastrando ----------

let dragging: Tab | null = null;
function wireDrag(tab: Tab) {
  const el = tab.tabEl;
  el.addEventListener("dragstart", () => {
    dragging = tab;
    tabsEl.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    tabsEl.classList.remove("dragging");
  });
  el.addEventListener("dragover", (e) => {
    if (!dragging || dragging === tab) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drag-over");
    if (!dragging || dragging === tab) return;
    // Queda arriba de la pestaña donde se soltó, en su mismo sector.
    dragging.sectorId = tab.sectorId;
    tabs.splice(tabs.indexOf(dragging), 1);
    tabs.splice(tabs.indexOf(tab), 0, dragging);
    renderTabList();
    scheduleSave();
  });
}

/** Soltar en un sector (encabezado o hueco) o en la zona de sueltas manda la pestaña al final. */
function wireDropZone(el: HTMLElement, sectorId: string | null) {
  el.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-target");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop-target");
    if (!dragging) return;
    const tab = dragging;
    tab.sectorId = sectorId;
    tabs.splice(tabs.indexOf(tab), 1);
    tabs.push(tab);
    renderTabList();
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
  const order = visualOrder();
  const idx = active ? order.indexOf(active) : -1;
  // Con el foco en el chat, ⌘T abre una conversación nueva y no una terminal.
  if (cmd === "new-tab" && assistantPanel.hasFocus) assistantPanel.newConversation();
  else if (cmd === "new-tab") void newTab();
  // Con las notas abiertas, ⌘W las cierra en vez de cerrar la pestaña de la terminal.
  else if (cmd === "close-tab" && notesPanel.isOpen) notesPanel.close();
  else if (cmd === "close-tab" && assistantPanel.isOpen) assistantPanel.close();
  else if (cmd === "toggle-notes") toggleNotes();
  else if (cmd === "toggle-assistant") assistantPanel.toggle();
  else if (cmd === "toggle-mute") void toggleMute();
  else if (cmd === "toggle-terminal-max") toggleMax();
  else if (cmd === "close-tab" && active) closeTab(active);
  else if (cmd === "rename-tab" && active) startRename(active);
  else if (cmd === "next-tab" && order.length) activate(order[(idx + 1) % order.length]);
  else if (cmd === "pomodoro-toggle") pomodoro.toggle();
  else if (cmd === "pomodoro-reset") pomodoro.reset();
  else if (cmd === "open-settings") void settingsPanel.open();
  else if (cmd === "export-config") void exportConfig();
  else if (cmd === "import-config") void importConfig();
  else if (cmd === "prev-tab" && order.length) activate(order[(idx - 1 + order.length) % order.length]);
  else if (cmd.startsWith("goto-tab:")) {
    const n = Number(cmd.split(":")[1]);
    // ⌘9 va a la última, como en el navegador.
    const target = n === 8 ? order[order.length - 1] : order[n];
    if (target) activate(target);
  }
});

newTabBtn.addEventListener("click", () => void newTab());
tabsEl.addEventListener("dblclick", (e) => {
  const el = e.target as HTMLElement;
  if (el === tabsEl || el.classList.contains("loose")) void newTab(); // doble clic en el hueco de la lista abre una pestaña
});

new ResizeObserver(() => active?.fit.fit()).observe(panesEl);

// ---------- exportar / importar la configuración ----------

/** Todo lo que la ventana guarda en localStorage (anchos de paneles, solapa de tickets…). */
function uiPrefs(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      out[key] = localStorage.getItem(key) ?? "";
    }
  } catch {
    // sin localStorage no hay preferencias de ventana que llevar
  }
  return out;
}

async function exportConfig(): Promise<boolean> {
  // Que el archivo lleve las pestañas tal como están ahora.
  clearTimeout(saveTimer);
  await api.saveSession({ tabs: tabs.map(({ id, name, cwd, sectorId, status }) => ({ id, name, cwd, sectorId, status })), activeId: active?.id ?? null, sectors });
  return (await api.exportConfig(uiPrefs())) !== null;
}

/** Aplica lo importado sin reiniciar: ajustes, preferencias y las pestañas que falten. */
async function importConfig(): Promise<boolean> {
  const result = await api.importConfig();
  if (!result) return false;
  applySettings(result.settings);
  try {
    for (const [key, value] of Object.entries(result.ui)) localStorage.setItem(key, String(value));
  } catch {
    // las preferencias de ventana son lo de menos
  }
  const s = result.session;
  if (s) {
    for (const sector of s.sectors ?? []) if (!sectors.some((x) => x.id === sector.id)) sectors.push(sector);
    // Las pestañas nuevas arrancan sin robarle el foco a la actual.
    for (const t of s.tabs) if (!tabs.some((x) => x.id === t.id)) createTab(t, false);
    if (active) activate(active);
    renderTabList();
    scheduleSave();
  }
  return true;
}

// ---------- arranque: restaurar la sesión anterior ----------

async function boot() {
  const session = await api.loadSession().catch(() => null);
  // La ruta por defecto sale de la configuración: esperarla antes de la primera pestaña.
  if (!settings) applySettings(await api.getSettings());
  sectors = session?.sectors ?? DEFAULT_SECTORS.map((name) => ({ id: crypto.randomUUID(), name, collapsed: false }));
  renderTabList();
  if (!session?.tabs.length) {
    createDefaultTab();
    return;
  }
  for (const t of session.tabs) createTab(t, false);
  const target = tabs.find((t) => t.id === session.activeId) ?? tabs[0];
  activate(target);
}

boot();
