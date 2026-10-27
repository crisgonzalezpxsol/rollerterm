// Exportar e importar la configuración: un solo .json con los ajustes, las direcciones de
// correo importantes y bloqueadas, las notas, los recordatorios pendientes y las pestañas.
// Importar suma (notas, recordatorios, correos, pestañas) y reemplaza los ajustes.
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { app, dialog, shell, type BrowserWindow } from "electron";
import type { ConfigBundle, ConfigImportResult, Note, Reminder, Session } from "../shared/types";
import type { MailSync } from "./mail";
import type { NotesStore } from "./notes";
import type { Reminders } from "./reminders";
import { loadSession } from "./session-store";
import type { SettingsStore } from "./settings";

interface Stores {
  settings: SettingsStore;
  mail: MailSync;
  notes: NotesStore;
  reminders: Reminders;
}

const today = () => new Date().toISOString().slice(0, 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function exportConfig(win: BrowserWindow, stores: Stores, ui: Record<string, string>): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Exportar configuración",
    defaultPath: join(app.getPath("downloads"), `rollerterm-config-${today()}.json`),
    filters: [{ name: "Configuración de rollerterm", extensions: ["json"] }],
  });
  if (canceled || !filePath) return null;
  const bundle: ConfigBundle = {
    app: "rollerterm",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: stores.settings.current,
    mail: stores.mail.lists,
    notes: await stores.notes.list(),
    reminders: stores.reminders.pending(),
    session: await loadSession(),
    ui,
  };
  await writeFile(filePath, JSON.stringify(bundle, null, 2));
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    message: "Configuración exportada",
    detail:
      `${basename(filePath)}\n\n` +
      [
        plural(bundle.notes.length, "nota", "notas"),
        plural(bundle.reminders.length, "recordatorio", "recordatorios"),
        plural(bundle.mail.vip.length, "correo importante", "correos importantes"),
        plural(bundle.mail.blocked.length, "correo bloqueado", "correos bloqueados"),
        plural(bundle.session?.tabs.length ?? 0, "pestaña", "pestañas"),
      ].join(" · "),
    buttons: ["Listo", "Mostrar en Finder"],
    defaultId: 0,
  });
  if (response === 1) shell.showItemInFolder(filePath);
  return filePath;
}

export async function importConfig(win: BrowserWindow, stores: Stores): Promise<ConfigImportResult | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Importar configuración",
    defaultPath: app.getPath("downloads"),
    filters: [{ name: "Configuración de rollerterm", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return null;

  let bundle: Partial<ConfigBundle>;
  try {
    bundle = JSON.parse(await readFile(filePaths[0], "utf8"));
    if (bundle.app !== "rollerterm") throw new Error("no es un archivo de configuración de rollerterm");
  } catch (err) {
    await dialog.showMessageBox(win, { type: "error", message: "No se pudo importar", detail: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const notes: Note[] = Array.isArray(bundle.notes) ? bundle.notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string") : [];
  const reminders: Reminder[] = Array.isArray(bundle.reminders) ? bundle.reminders.filter((r) => r && typeof r.id === "string" && typeof r.when === "string") : [];
  const vip = Array.isArray(bundle.mail?.vip) ? bundle.mail.vip.map(String) : [];
  const blocked = Array.isArray(bundle.mail?.blocked) ? bundle.mail.blocked.map(String) : [];
  const session: Session | null = bundle.session && Array.isArray(bundle.session.tabs) ? bundle.session : null;

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "¿Importar esta configuración?",
    detail:
      `${basename(filePaths[0])}` +
      (bundle.exportedAt ? ` (exportada el ${new Date(bundle.exportedAt).toLocaleString("es-AR", { hourCycle: "h23" })})` : "") +
      "\n\n" +
      `• Ajustes: se reemplazan por los del archivo.\n` +
      `• Se suman ${plural(notes.length, "nota", "notas")}, ${plural(reminders.length, "recordatorio", "recordatorios")}, ` +
      `${plural(vip.length, "correo importante", "correos importantes")}, ${plural(blocked.length, "correo bloqueado", "correos bloqueados")} ` +
      `y ${plural(session?.tabs.length ?? 0, "pestaña", "pestañas")}.\n\n` +
      `No se borra nada: si una nota ya existe, queda la versión más nueva. Las pestañas que ya están abiertas no se tocan.`,
    buttons: ["Importar", "Cancelar"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;

  const settings = bundle.settings ? await stores.settings.replace(bundle.settings) : stores.settings.current;
  const current = stores.mail.lists;
  await stores.mail.setLists([...current.vip, ...vip], [...current.blocked, ...blocked]);
  await stores.notes.merge(notes);
  await stores.reminders.merge(reminders);
  win.webContents.send("notes:changed");
  return { settings, session, ui: bundle.ui && typeof bundle.ui === "object" ? bundle.ui : {} };
}
