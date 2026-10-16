import { contextBridge, ipcRenderer } from "electron";
import type { CalendarState, MailState, MailThread, MenuCommand, Session, RollertermApi } from "../shared/types";

const api: RollertermApi = {
  createPty: (id, cwd, cols, rows) => ipcRenderer.invoke("pty:create", id, cwd, cols, rows),
  write: (id, data) => ipcRenderer.send("pty:write", id, data),
  resize: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
  kill: (id) => ipcRenderer.send("pty:kill", id),
  getCwd: (id) => ipcRenderer.invoke("pty:cwd", id),
  loadSession: () => ipcRenderer.invoke("session:load"),
  saveSession: (session: Session) => ipcRenderer.invoke("session:save", session),
  onData: (cb) => ipcRenderer.on("pty:data", (_e, id: string, data: string) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on("pty:exit", (_e, id: string, code: number) => cb(id, code)),
  onMenu: (cb) => ipcRenderer.on("menu", (_e, cmd: MenuCommand) => cb(cmd)),
  getCalendar: () => ipcRenderer.invoke("calendar:get"),
  refreshCalendar: () => ipcRenderer.send("calendar:refresh"),
  onCalendar: (cb) => ipcRenderer.on("calendar:state", (_e, state: CalendarState) => cb(state)),
  getMail: () => ipcRenderer.invoke("mail:get"),
  refreshMail: () => ipcRenderer.send("mail:refresh"),
  summarizeMail: () => ipcRenderer.send("mail:summarize"),
  setMailLists: (vip, blocked) => ipcRenderer.send("mail:lists", vip, blocked),
  onMail: (cb) => ipcRenderer.on("mail:state", (_e, state: MailState) => cb(state)),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  listBrowsers: () => ipcRenderer.invoke("settings:browsers"),
  testBrowser: () => ipcRenderer.send("settings:test-browser"),
  onNewMail: (cb) => ipcRenderer.on("mail:new", (_e, threads: MailThread[]) => cb(threads)),
};

contextBridge.exposeInMainWorld("rollerterm", api);
