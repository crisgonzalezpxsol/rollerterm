import { app } from "electron";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../shared/types";

const file = () => join(app.getPath("userData"), "session.json");

export async function loadSession(): Promise<Session | null> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Session;
    return Array.isArray(parsed.tabs) && parsed.tabs.length > 0 ? parsed : null;
  } catch {
    // Primera vez o archivo corrupto: se arranca con una pestaña nueva.
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  // Escritura atómica: un cierre a mitad de camino no deja el JSON roto.
  const tmp = `${file()}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2));
  await rename(tmp, file());
}
