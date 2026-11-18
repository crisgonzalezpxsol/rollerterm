// Reemplazo de src/preload/preload.ts para Tauri: implementa la misma `window.rollerterm`
// sobre comandos de Rust, así src/renderer/ corre sin cambios.
//
// Ya portado: terminales, sesión (pestañas y sectores), configuración, selector de carpetas,
// notas y links. El resto (correo, agenda, tickets, asistente, Railway, uso de Claude,
// recordatorios, exportar/importar) responde «no disponible todavía» hasta portarlo.
import type {
  CalendarState,
  Conversation,
  MailState,
  MenuCommand,
  ProdState,
  RollertermApi,
  TicketsState,
  UsageState,
} from "../../src/shared/types";

type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number };

const { invoke, Channel } = (window as any).__TAURI__.core;

// Errores de la ventana a la consola del proceso Rust (en release no hay devtools).
const report = (msg: string) => void invoke("js_log", { message: msg }).catch(noopErr);
function noopErr() {}
window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => report(`promesa rechazada: ${e.reason?.stack ?? e.reason}`));

const PENDING = "Todavía no está disponible en la versión Tauri.";
const notYet = () => Promise.reject(new Error(PENDING));
const noop = () => {};

let dataCb: (id: string, data: string) => void = noop;
let exitCb: (id: string, code: number) => void = noop;
let menuCb: (cmd: MenuCommand) => void = noop;

const calendar: CalendarState = { status: "error", events: [], lastSync: null, message: PENDING, detail: null, syncing: false };
const mail: MailState = {
  status: "error",
  message: PENDING,
  detail: null,
  syncing: false,
  summarizing: false,
  lastSync: null,
  threads: [],
  vip: [],
  blocked: [],
  summary: null,
  summaryError: null,
};
// "disabled" oculta esos indicadores en vez de mostrarlos rotos.
const tickets: TicketsState = { status: "disabled", message: PENDING, checking: false, lastCheck: null, tickets: [], webUrl: null, environment: null };
const prod: ProdState = { status: "disabled", message: PENDING, checking: false, lastCheck: null, services: [] };
const daily: Conversation = { id: "daily", title: "Jornada", createdAt: Date.now(), updatedAt: Date.now(), daily: true, busy: false };
const zero = { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
const usage: UsageState = { status: "error", lastCheck: null, today: zero, week: zero, block: null, models: [], projects: [] };

const api: RollertermApi = {
  // ---------- terminales ----------
  createPty(id, cwd, cols, rows) {
    const channel = new Channel();
    channel.onmessage = (ev: PtyEvent) => (ev.kind === "data" ? dataCb(id, ev.data) : exitCb(id, ev.code));
    return invoke("pty_create", { id, cwd, cols, rows, onEvent: channel });
  },
  write: (id, data) => void invoke("pty_write", { id, data }),
  resize: (id, cols, rows) => void invoke("pty_resize", { id, cols, rows }),
  kill: (id) => void invoke("pty_kill", { id }),
  getCwd: (id) => invoke("pty_cwd", { id }),
  onData: (cb) => void (dataCb = cb),
  onExit: (cb) => void (exitCb = cb),
  onMenu: (cb) => void (menuCb = cb),
  pickFolder: (defaultPath) => invoke("pick_folder", { defaultPath: defaultPath ?? null }),

  // ---------- sesión y configuración ----------
  loadSession: () => invoke("session_load"),
  saveSession: (session) => invoke("session_save", { session }),
  getSettings: () => invoke("settings_get"),
  setSettings: (patch) => invoke("settings_set", { patch }),
  listBrowsers: () => Promise.resolve([]),
  testBrowser: () => void invoke("open_url", { url: "https://calendar.google.com" }),
  exportConfig: notYet,
  importConfig: notYet,

  // ---------- notas ----------
  listNotes: () => invoke("notes_list"),
  saveNote: (note) => invoke("notes_save", { note }),
  deleteNote: (id) => invoke("notes_delete", { id }),
  onNotesChanged: noop,

  // ---------- recordatorios (pendiente) ----------
  listReminders: () => Promise.resolve([]),
  addReminder: notYet,
  removeReminder: () => Promise.resolve(false),
  onRemindersChanged: noop,
  onReminder: noop,

  // ---------- agenda y correo (pendiente) ----------
  getCalendar: () => Promise.resolve(calendar),
  refreshCalendar: noop,
  onCalendar: noop,
  getMail: () => Promise.resolve(mail),
  refreshMail: noop,
  summarizeMail: noop,
  setMailLists: noop,
  onMail: noop,
  onNewMail: noop,

  // ---------- tickets, Railway y uso de Claude (pendiente) ----------
  getTickets: () => Promise.resolve(tickets),
  refreshTickets: noop,
  viewTicket: notYet,
  ticketAction: notYet,
  onTickets: noop,
  listMcpServers: () => Promise.resolve([]),
  getProd: () => Promise.resolve(prod),
  refreshProd: noop,
  onProd: noop,
  listRailwayProjects: () => Promise.resolve([]),
  getUsage: () => Promise.resolve(usage),
  refreshUsage: noop,
  onUsage: noop,

  // ---------- asistente (pendiente) ----------
  // La interfaz espera al menos la «Jornada»: una sola, con el aviso de que falta portarlo.
  chatList: () => Promise.resolve([daily]),
  chatNew: notYet,
  chatRename: notYet,
  chatDelete: notYet,
  chatHistory: () => Promise.resolve([{ id: "pendiente", role: "event", text: `El asistente: ${PENDING}`, at: Date.now() }]),
  chatSend: notYet,
  chatStop: noop,
  chatApprove: noop,
  onChat: noop,
};

window.rollerterm = api;

// WebKitGTK no trae speechSynthesis (la voz del asistente): uno vacío, sin voces,
// para que la interfaz arranque. Se resuelve al portar el asistente.
if (!("speechSynthesis" in window)) {
  const synth = Object.assign(new EventTarget(), {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => [],
    speak: noop,
    cancel: noop,
    pause: noop,
    resume: noop,
  });
  Object.assign(window, {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: class extends EventTarget {
      constructor(public text = "") {
        super();
      }
    },
  });
}

// Los links (terminal, Unirme, correos) se abren en el navegador del sistema, nunca en la app.
window.open = ((url?: string | URL) => {
  if (url) void invoke("open_url", { url: String(url) });
  return null;
}) as typeof window.open;

// ---------- atajos del menú ----------
// En Electron los dispara el menú de la app; acá se escuchan en la ventana, antes que xterm.
// Mismas teclas que la versión Electron en Linux (Ctrl+Shift para no pisar a la shell).
const SHIFT_KEYS: Record<string, MenuCommand> = {
  KeyT: "new-tab",
  KeyW: "close-tab",
  KeyR: "rename-tab",
  BracketRight: "next-tab",
  BracketLeft: "prev-tab",
  Enter: "toggle-terminal-max",
  KeyP: "pomodoro-toggle",
  KeyN: "toggle-notes",
  KeyK: "toggle-assistant",
  KeyM: "toggle-mute",
};

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    let cmd: MenuCommand | undefined;
    if (e.shiftKey) cmd = SHIFT_KEYS[e.code];
    else if (e.code === "Comma") cmd = "open-settings";
    else if (/^Digit[1-9]$/.test(e.code)) cmd = `goto-tab:${Number(e.code.slice(5)) - 1}`;
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    menuCb(cmd);
  },
  true,
);
