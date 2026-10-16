import { contextBridge, ipcRenderer } from "electron";
import type { MenuCommand, Session, TabtermApi } from "../shared/types";

const api: TabtermApi = {
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
};

contextBridge.exposeInMainWorld("tabterm", api);
