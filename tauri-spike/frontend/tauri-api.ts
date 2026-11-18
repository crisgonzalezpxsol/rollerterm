// Reemplazo de src/preload/preload.ts para Tauri: implementa la misma `window.rollerterm`
// sobre comandos de Rust, así src/renderer/ corre sin cambios.
//
// Todo src/main/ de Electron está portado a Rust (src-tauri/src/). Lo único distinto en
// Linux: los links se abren siempre con el navegador predeterminado (xdg-open).
import type { MenuCommand, RollertermApi } from "../../src/shared/types";

type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number };

const { invoke, Channel } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;
/** Eventos que manda Rust (estado de la agenda, del correo…). */
const on = <T>(name: string, cb: (payload: T) => void) => void listen(name, (e: { payload: T }) => cb(e.payload));
/**
 * Igual que `on`, para los estados que Rust va publicando (agenda, correo, tickets…). Registrar
 * el listener es asíncrono: si Rust publicó justo antes, ese aviso se perdería. Por eso, ya
 * registrado, se pide el estado actual una vez más (en Electron el registro es inmediato).
 */
const onState = <T>(name: string, getter: string, cb: (payload: T) => void) =>
  void listen(name, (e: { payload: T }) => cb(e.payload)).then(() => invoke(getter).then(cb));

// Errores de la ventana a la consola del proceso Rust (en release no hay devtools).
const report = (msg: string) => void invoke("js_log", { message: msg }).catch(noopErr);
function noopErr() {}
window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => report(`promesa rechazada: ${e.reason?.stack ?? e.reason}`));

const noop = () => {};

let dataCb: (id: string, data: string) => void = noop;
let exitCb: (id: string, code: number) => void = noop;
let menuCb: (cmd: MenuCommand) => void = noop;


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
  listBrowsers: () => invoke("list_browsers"),
  testBrowser: () => void invoke("open_url", { url: "https://calendar.google.com" }),
  exportConfig: (ui) => invoke("config_export", { ui }),
  importConfig: () => invoke("config_import"),

  // ---------- notas ----------
  listNotes: () => invoke("notes_list"),
  saveNote: (note) => invoke("notes_save", { note }),
  deleteNote: (id) => invoke("notes_delete", { id }),
  onNotesChanged: (cb) => on("notes:changed", () => cb()),

  // ---------- recordatorios ----------
  listReminders: () => invoke("reminders_list"),
  addReminder: (when, text, noteId) => invoke("reminders_add", { when, text, noteId: noteId ?? null }),
  removeReminder: (id) => invoke("reminders_remove", { id }),
  onRemindersChanged: (cb) => on("reminders:changed", () => cb()),
  onReminder: (cb) => on("reminder:fire", cb),

  // ---------- agenda y correo ----------
  getCalendar: () => invoke("calendar_get"),
  refreshCalendar: () => void invoke("calendar_refresh"),
  onCalendar: (cb) => onState("calendar:state", "calendar_get", cb),
  getMail: () => invoke("mail_get"),
  refreshMail: () => void invoke("mail_refresh"),
  summarizeMail: () => void invoke("mail_summarize"),
  setMailLists: (vip, blocked) => void invoke("mail_lists", { vip, blocked }),
  onMail: (cb) => onState("mail:state", "mail_get", cb),
  onNewMail: (cb) => on("mail:new", cb),

  // ---------- tickets, Railway y uso de Claude ----------
  getTickets: () => invoke("tickets_get"),
  refreshTickets: () => void invoke("tickets_refresh"),
  viewTicket: (numero) => invoke("tickets_view", { numero, action: null }),
  ticketAction: (numero, action) => invoke("tickets_view", { numero, action }),
  onTickets: (cb) => onState("tickets:state", "tickets_get", cb),
  listMcpServers: () => invoke("tickets_servers"),
  getProd: () => invoke("prod_get"),
  refreshProd: () => void invoke("prod_refresh"),
  onProd: (cb) => onState("prod:state", "prod_get", cb),
  listRailwayProjects: () => invoke("prod_projects"),
  getUsage: () => invoke("usage_get"),
  refreshUsage: () => void invoke("usage_refresh"),
  onUsage: (cb) => onState("usage:state", "usage_get", cb),

  // ---------- asistente ----------
  chatList: () => invoke("chat_list"),
  chatNew: () => invoke("chat_new"),
  chatRename: (convId, title) => invoke("chat_rename", { convId, title }),
  chatDelete: (convId) => invoke("chat_delete", { convId }),
  chatHistory: (convId) => invoke("chat_history", { convId }),
  chatSend: (convId, text) => invoke("chat_send", { convId, text }),
  chatStop: (convId) => void invoke("chat_stop", { convId }),
  chatApprove: (id, approved) => void invoke("chat_approve", { id, approved }),
  onChat: (cb) => on("chat:event", cb),
};

window.rollerterm = api;

// Notificaciones nativas: WebKitGTK no muestra las de la página. Mismo uso que la API web
// (new Notification(título, { body }) y onclick), pero las muestra Rust.
const pending = new Map<number, { onclick: (() => void) | null }>();
let nextNotification = 1;
class NativeNotification {
  static permission = "granted";
  static requestPermission = () => Promise.resolve("granted");
  onclick: (() => void) | null = null;
  constructor(title: string, opts?: { body?: string }) {
    const id = nextNotification++;
    pending.set(id, this);
    void invoke("notify", { id, title, body: opts?.body ?? "" });
  }
  close() {}
}
on<number>("notify:click", (id) => {
  pending.get(id)?.onclick?.();
  pending.delete(id);
});
Object.assign(window, { Notification: NativeNotification });

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
