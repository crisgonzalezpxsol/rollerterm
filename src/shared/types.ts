/** Una pestaña tal como se guarda entre sesiones. */
export interface SavedTab {
  id: string;
  name: string;
  /** Directorio en el que estaba la shell al cerrar la app ("" = home). */
  cwd: string;
}

export interface Session {
  tabs: SavedTab[];
  activeId: string | null;
}

/** Comandos que el menú (proceso main) le manda a la ventana. */
export type MenuCommand =
  | "new-tab"
  | "close-tab"
  | "rename-tab"
  | "next-tab"
  | "prev-tab"
  | `goto-tab:${number}`;

/** API que el preload expone a la ventana como `window.tabterm`. */
export interface TabtermApi {
  createPty(id: string, cwd: string, cols: number, rows: number): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  getCwd(id: string): Promise<string | null>;
  loadSession(): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  onData(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string, exitCode: number) => void): void;
  onMenu(cb: (cmd: MenuCommand) => void): void;
}
