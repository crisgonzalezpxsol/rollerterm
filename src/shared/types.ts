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
  | "pomodoro-toggle"
  | "pomodoro-reset"
  | `goto-tab:${number}`;

/** API que el preload expone a la ventana como `window.rollerterm`. */
export interface RollertermApi {
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
  getCalendar(): Promise<CalendarState>;
  refreshCalendar(): void;
  onCalendar(cb: (state: CalendarState) => void): void;
  getMail(): Promise<MailState>;
  refreshMail(): void;
  summarizeMail(): void;
  setMailLists(vip: string[], blocked: string[]): void;
  onMail(cb: (state: MailState) => void): void;
  /** Hilos que llegaron desde la última sincronización (para notificar). */
  onNewMail(cb: (threads: MailThread[]) => void): void;
}

/** Un evento de Google Calendar tal como lo devuelve Claude Code. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 con offset. */
  start: string;
  end: string;
  /** Link de videollamada (Meet/Zoom/Teams) o null. */
  meetUrl: string | null;
  declined: boolean;
}

/** Estado de un conector de claude.ai (Google Calendar, Gmail) visto a través de Claude Code. */
export type ConnectorStatus =
  | "loading" //        primera sincronización en curso
  | "connected" //      el conector respondió
  | "disconnected" //   el conector existe pero pide autenticación o falló
  | "not-configured" // la cuenta de Claude no tiene el conector
  | "no-claude" //      no se encontró el CLI de Claude Code
  | "error"; //         cualquier otra falla (sin login, sin red, timeout…)

export interface CalendarState {
  status: ConnectorStatus;
  /** Últimos eventos conocidos: se conservan si una sincronización falla. */
  events: CalendarEvent[];
  lastSync: number | null;
  message: string | null;
  /** Detalle técnico del último fallo, para copiar. */
  detail: string | null;
  syncing: boolean;
}

/** Un hilo de Gmail no leído, con los datos de su mensaje más reciente. */
export interface MailThread {
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  /** ISO 8601. */
  date: string;
  /** Link para abrir el hilo en Gmail. */
  viewUrl: string;
}

export interface MailSummaryItem {
  threadId: string;
  from: string;
  subject: string;
  /** De qué se trata, en una o dos oraciones. */
  gist: string;
  /** true si piden algo o esperan una respuesta. */
  needsAction: boolean;
  viewUrl: string;
}

export interface MailSummary {
  createdAt: number;
  /** Desde cuándo se miraron los correos. */
  since: number;
  overview: string;
  items: MailSummaryItem[];
}

export interface MailState {
  status: ConnectorStatus;
  message: string | null;
  /** Detalle técnico del último fallo (de la sincronización o del resumen), para copiar. */
  detail: string | null;
  syncing: boolean;
  summarizing: boolean;
  lastSync: number | null;
  threads: MailThread[];
  /** Direcciones o dominios importantes: se destacan y se resumen. */
  vip: string[];
  /** Direcciones o dominios bloqueados: se excluyen de todo. */
  blocked: string[];
  summary: MailSummary | null;
  summaryError: string | null;
}
