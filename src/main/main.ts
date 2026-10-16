import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { MenuCommand, Session } from "../shared/types";
import { CalendarSync } from "./calendar";
import { ClaudeRunner } from "./claude-runner";
import { MailSync } from "./mail";
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
const claude = new ClaudeRunner();
const calendar = new CalendarSync(claude, (state) => win?.webContents.send("calendar:state", state));
const mail = new MailSync(
  claude,
  (state) => win?.webContents.send("mail:state", state),
  (threads) => win?.webContents.send("mail:new", threads),
);

ipcMain.handle("settings:get", () => settings.current);
ipcMain.handle("settings:set", (_e, patch) => settings.update(patch));
ipcMain.handle("settings:browsers", () => listBrowsers());
ipcMain.on("settings:test-browser", () => settings.openUrl("https://calendar.google.com"));
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
    backgroundColor: "#1e1e1e",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  win.on("closed", () => {
    win = null;
    ptys.killAll();
  });
}

app.whenReady().then(async () => {
  await settings.load();
  // Sin empaquetar, macOS mostraría el ícono genérico de Electron en el Dock.
  app.dock?.setIcon(join(__dirname, "icon.png"));
  buildMenu();
  createWindow();
  calendar.start();
  void mail.start();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  ptys.killAll();
  app.quit();
});
