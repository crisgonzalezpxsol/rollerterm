import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { MenuCommand, Session } from "../shared/types";
import { Assistant } from "./assistant";
import { Bridge } from "./bridge";
import { CalendarSync } from "./calendar";
import { ClaudeRunner } from "./claude-runner";
import { MailSync } from "./mail";
import { NotesStore } from "./notes";
import { listMcpServers } from "./mcp-client";
import { resolveServer } from "./tickets";
import { RailwayMonitor } from "./railway";
import { Reminders } from "./reminders";
import { TicketsMonitor } from "./tickets";
import { listBrowsers, SettingsStore } from "./settings";
import { PtyManager } from "./pty-manager";
import { loadSession, saveSession } from "./session-store";

app.setName("rollerterm");

let win: BrowserWindow | null = null;

const ptys = new PtyManager(
  (id, data) => win?.webContents.send("pty:data", id, data),
  (id, code) => win?.webContents.send("pty:exit", id, code),
);

const settings = new SettingsStore();
const notes = new NotesStore();
const prod = new RailwayMonitor(
  () => settings.current.railway,
  (state) => win?.webContents.send("prod:state", state),
);
const tickets = new TicketsMonitor(
  () => settings.current.tickets,
  (state) => win?.webContents.send("tickets:state", state),
);
const claude = new ClaudeRunner();
const calendar = new CalendarSync(claude, (state) => win?.webContents.send("calendar:state", state));
const mail = new MailSync(
  claude,
  (state) => win?.webContents.send("mail:state", state),
  (threads) => win?.webContents.send("mail:new", threads),
);

ipcMain.handle("settings:get", () => settings.current);
ipcMain.handle("settings:set", async (_e, patch) => {
  const next = await settings.update(patch);
  // Cambiar qué proyectos se vigilan se refleja en el indicador sin esperar al próximo ciclo.
  if (patch.railway) void prod.check();
  if (patch.tickets) void tickets.check();
  return next;
});
ipcMain.handle("notes:list", () => notes.list());
ipcMain.handle("notes:save", (_e, note) => notes.save(note));
ipcMain.handle("notes:delete", (_e, id: string) => notes.delete(id));
ipcMain.handle("tickets:get", () => tickets.current);
ipcMain.on("tickets:refresh", () => void tickets.check());
ipcMain.handle("tickets:servers", async () => (await listMcpServers()).map((s) => s.name));
ipcMain.handle("prod:get", () => prod.current);
ipcMain.on("prod:refresh", () => void prod.check());
// Usa la lista en memoria del monitor (se refresca sola cada 30 min): así Configuración abre al instante.
ipcMain.handle("prod:projects", () => prod.listProjects().catch(() => []));
ipcMain.handle("settings:browsers", () => listBrowsers());
ipcMain.on("settings:test-browser", () => settings.openUrl("https://calendar.google.com"));
// ---------- asistente ----------

const bridge = new Bridge();
const assistant = new Assistant(claude, bridge, {
  model: () => settings.current.assistant.model,
  ticketServer: async () => (await resolveServer(settings.current.tickets))?.name ?? null,
  emit: (event) => win?.webContents.send("chat:event", event),
});
const reminders = new Reminders((r) => {
  win?.webContents.send("reminder:fire", r);
  void assistant.addEvent(`⏰ Recordatorio: ${r.text}`);
});

bridge.on("crear_nota", async ({ texto }) => {
  const now = Date.now();
  const note = { id: crypto.randomUUID(), text: String(texto ?? ""), createdAt: now, updatedAt: now };
  await notes.save(note);
  win?.webContents.send("notes:changed");
  return { ok: true, id: note.id };
});
bridge.on("buscar_notas", async ({ q }) => {
  const needle = String(q ?? "").toLowerCase();
  const all = await notes.list();
  return (needle ? all.filter((n) => n.text.toLowerCase().includes(needle)) : all)
    .slice(0, 30)
    .map((n) => ({ texto: n.text, editada: new Date(n.updatedAt).toISOString() }));
});
bridge.on("crear_recordatorio", async ({ cuando, texto }) => {
  const r = await reminders.add(String(cuando), String(texto ?? ""));
  return { ok: true, id: r.id, cuando: new Date(r.when).toLocaleString("es-AR", { hourCycle: "h23" }) };
});
bridge.on("listar_recordatorios", async () =>
  reminders.pending().map((r) => ({ id: r.id, cuando: new Date(r.when).toLocaleString("es-AR", { hourCycle: "h23" }), texto: r.text })),
);
bridge.on("borrar_recordatorio", async ({ id }) => ({ ok: await reminders.remove(String(id)) }));
bridge.on("contexto_actual", async () => {
  const cal = calendar.current;
  const m = mail.current;
  const t = tickets.current;
  const p = prod.current;
  return {
    agenda: cal.events.map((e) => ({ titulo: e.title, inicio: e.start, fin: e.end, videollamada: Boolean(e.meetUrl), rechazado: e.declined })),
    correo: {
      importantes: m.vip,
      hilos: m.threads.slice(0, 25).map((x) => ({ de: x.fromEmail, asunto: x.subject, fecha: x.date, sinLeer: x.unread, extracto: x.snippet })),
    },
    tickets: {
      entorno: t.environment,
      mios: t.tickets.filter((x) => x.mine).map((x) => ({ numero: x.numero, asunto: x.asunto, estado: x.estado, prioridad: x.prioridad, slaVencido: x.slaVencido })),
      sinDueno: t.tickets.filter((x) => !x.atiende).map((x) => ({ numero: x.numero, asunto: x.asunto, prioridad: x.prioridad })),
    },
    produccion: p.services.filter((x) => x.health !== "ok").map((x) => ({ servicio: `${x.projectName} / ${x.serviceName}`, salud: x.health, estado: x.status })),
  };
});

ipcMain.handle("chat:history", () => assistant.recent());
ipcMain.handle("chat:send", (_e, text: string) => assistant.send(text));
ipcMain.on("chat:stop", () => assistant.stop());
ipcMain.on("chat:approve", (_e, id: string, approved: boolean) => assistant.approve(id, approved));

ipcMain.handle("calendar:get", () => calendar.current);
ipcMain.on("calendar:refresh", () => void calendar.sync());
ipcMain.handle("mail:get", () => mail.current);
ipcMain.on("mail:refresh", () => void mail.sync());
ipcMain.on("mail:summarize", () => void mail.summarize(true));
ipcMain.on("mail:lists", (_e, vip: string[], blocked: string[]) => void mail.setLists(vip, blocked));
ipcMain.handle("pty:create", (_e, id: string, cwd: string, cols: number, rows: number) => ptys.create(id, cwd, cols, rows));
ipcMain.on("pty:write", (_e, id: string, data: string) => ptys.write(id, data));
ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows));
ipcMain.on("pty:kill", (_e, id: string) => ptys.kill(id));
ipcMain.handle("pty:cwd", (_e, id: string) => ptys.getCwd(id));
ipcMain.handle("session:load", () => loadSession());
ipcMain.handle("session:save", (_e, session: Session) => {
  lastSession = session;
  return saveSession(session);
});

let lastSession: Session | null = null;

/** Al cerrar, guarda en qué directorio quedó cada shell para reabrirla ahí. */
async function saveWithCurrentCwds() {
  if (!lastSession) return;
  const tabs = await Promise.all(
    lastSession.tabs.map(async (t) => ({ ...t, cwd: (await ptys.getCwd(t.id)) ?? t.cwd })),
  );
  await saveSession({ ...lastSession, tabs });
}

function send(cmd: MenuCommand) {
  win?.webContents.send("menu", cmd);
}

function buildMenu() {
  const gotoItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Ir a la pestaña ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => send(`goto-tab:${i}`),
  }));

  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Configuración…", accelerator: "CmdOrCtrl+,", click: () => send("open-settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Pestañas",
      submenu: [
        { label: "Nueva pestaña", accelerator: "CmdOrCtrl+T", click: () => send("new-tab") },
        { label: "Renombrar pestaña", accelerator: "CmdOrCtrl+Shift+R", click: () => send("rename-tab") },
        { label: "Cerrar pestaña", accelerator: "CmdOrCtrl+W", click: () => send("close-tab") },
        { type: "separator" },
        { label: "Pestaña siguiente", accelerator: "CmdOrCtrl+Shift+]", click: () => send("next-tab") },
        { label: "Pestaña anterior", accelerator: "CmdOrCtrl+Shift+[", click: () => send("prev-tab") },
        { type: "separator" },
        ...gotoItems,
      ],
    },
    {
      label: "Pomodoro",
      submenu: [
        { label: "Iniciar / pausar", accelerator: "CmdOrCtrl+Shift+P", click: () => send("pomodoro-toggle") },
        { label: "Reiniciar", click: () => send("pomodoro-reset") },
      ],
    },
    {
      label: "Notas",
      submenu: [{ label: "Mostrar / ocultar notas", accelerator: "CmdOrCtrl+Shift+N", click: () => send("toggle-notes") }],
    },
    {
      label: "Asistente",
      submenu: [{ label: "Mostrar / ocultar el chat", accelerator: "CmdOrCtrl+Shift+K", click: () => send("toggle-assistant") }],
    },
    {
      label: "Sonido",
      submenu: [{ label: "Silenciar / activar sonidos y avisos", accelerator: "CmdOrCtrl+Shift+M", click: () => send("toggle-mute") }],
    },
    { role: "editMenu" },
    {
      label: "Ver",
      submenu: [
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: "#13112b",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // El timbre del pomodoro suena al cambiar de fase, sin que haya un clic en ese momento.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(join(__dirname, "index.html"));
  // Todos los links (terminal, Unirme, correos) se abren en el navegador configurado, nunca en la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    settings.openUrl(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  let saved = false;
  win.on("close", (e) => {
    if (saved) return;
    e.preventDefault();
    saveWithCurrentCwds()
      .catch((err) => console.error("[saveWithCurrentCwds]", err))
      .finally(() => {
        saved = true;
        win?.close();
      });
  });
  win.on("focus", () => mail.syncIfStale());
  win.on("closed", () => {
    win = null;
    ptys.killAll();
  });
}

app.whenReady().then(async () => {
  await settings.load();
  await bridge.start();
  await assistant.start();
  await reminders.start();
  // Sin empaquetar, macOS mostraría el ícono genérico de Electron en el Dock.
  app.dock?.setIcon(join(__dirname, "icon.png"));
  buildMenu();
  createWindow();
  calendar.start();
  void mail.start();
  prod.start();
  tickets.start();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  ptys.killAll();
  app.quit();
});
