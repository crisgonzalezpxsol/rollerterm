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
  | "open-settings"
  | "toggle-notes"
  | "toggle-mute"
  | "toggle-assistant"
  | "toggle-terminal-max"
  | `goto-tab:${number}`;

/** API que el preload expone a la ventana como `window.rollerterm`. */
export interface RollertermApi {
  createPty(id: string, cwd: string, cols: number, rows: number): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  getCwd(id: string): Promise<string | null>;
  /** Selector nativo de carpetas; null si se cancela. */
  pickFolder(defaultPath?: string): Promise<string | null>;
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
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  listBrowsers(): Promise<BrowserInfo[]>;
  /** Abre una página de prueba con el navegador configurado. */
  testBrowser(): void;
  getProd(): Promise<ProdState>;
  refreshProd(): void;
  onProd(cb: (state: ProdState) => void): void;
  listRailwayProjects(): Promise<RailwayProject[]>;
  getTickets(): Promise<TicketsState>;
  refreshTickets(): void;
  /** El hilo completo de un ticket. */
  viewTicket(numero: number): Promise<TicketView>;
  /** Comenta, cambia el estado o el dueño; devuelve el ticket ya actualizado. */
  ticketAction(numero: number, action: TicketAction): Promise<TicketView>;
  onTickets(cb: (state: TicketsState) => void): void;
  /** Servidores MCP por stdio configurados en Claude Code (para elegir el de tickets). */
  listMcpServers(): Promise<string[]>;
  listNotes(): Promise<Note[]>;
  saveNote(note: Note): Promise<void>;
  deleteNote(id: string): Promise<void>;
  chatHistory(): Promise<ChatMessage[]>;
  chatSend(text: string): Promise<void>;
  chatStop(): void;
  chatApprove(id: string, approved: boolean): void;
  onChat(cb: (event: ChatStreamEvent) => void): void;
  /** Avisa que las notas cambiaron desde afuera del panel (por ejemplo, las creó el asistente). */
  onNotesChanged(cb: () => void): void;
  /** Un recordatorio que acaba de sonar. */
  onReminder(cb: (reminder: Reminder) => void): void;
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

/** Un hilo de la bandeja de entrada, con los datos de su mensaje más reciente. */
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
  /** true si tiene algún mensaje sin leer. */
  unread: boolean;
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

/** Con qué navegador se abren los links (Unirme, correos, links de la terminal). */
export interface BrowserChoice {
  /** Ruta del .app; null = el navegador predeterminado del sistema. */
  appPath: string | null;
  /** Carpeta del perfil en navegadores basados en Chromium ("Default", "Profile 1"); null = el último usado. */
  profile: string | null;
}

export interface PomodoroSound {
  /** Tictac de reloj mientras corre. */
  ticking: boolean;
  /** Timbre al cambiar de fase. */
  bell: boolean;
  /** 0 a 1. */
  volume: number;
}

export interface RailwaySettings {
  enabled: boolean;
  /** IDs de proyectos a vigilar; null = todos los que tengan entorno "production". */
  projects: string[] | null;
}

export interface Settings {
  browser: BrowserChoice;
  pomodoro: PomodoroSound;
  railway: RailwaySettings;
  tickets: TicketsSettings;
  /** Silencio: sin sonidos ni notificaciones (todo lo demás sigue igual). */
  muted: boolean;
  /** El asistente lee sus respuestas en voz alta. */
  speak: boolean;
  assistant: AssistantSettings;
  terminal: TerminalSettings;
}

/** Carpetas para abrir pestañas nuevas. */
export interface TerminalSettings {
  /** Rutas guardadas; la primera es la de por defecto. */
  paths: string[];
  /** Últimas carpetas elegidas, la más nueva primero. */
  recent: string[];
}

export interface BrowserInfo {
  name: string;
  appPath: string;
  /** Solo para navegadores con perfiles detectables (Chrome, Brave, Edge…). */
  profiles: { dir: string; label: string }[];
}

/** Salud de un servicio de producción en Railway. */
export type ServiceHealth =
  | "ok" //       corriendo (o durmiendo, en servicios serverless)
  | "deploying" // construyendo o desplegando
  | "degraded" //  el último deploy falló, pero sigue corriendo una versión anterior
  | "down"; //     crasheado, o sin ninguna versión corriendo

export interface ProdService {
  projectId: string;
  projectName: string;
  environmentId: string;
  serviceId: string;
  serviceName: string;
  health: ServiceHealth;
  /** Estado crudo de Railway del último deploy (SUCCESS, FAILED, CRASHED, BUILDING…). */
  status: string;
  /** Cuándo se creó el último deploy (ISO). */
  since: string | null;
  url: string;
}

export interface ProdState {
  /** "loading" | "ok": se pudo consultar; los demás explican por qué no. */
  status: "loading" | "ok" | "disabled" | "no-cli" | "logged-out" | "error";
  message: string | null;
  checking: boolean;
  lastCheck: number | null;
  services: ProdService[];
}

export interface RailwayProject {
  id: string;
  name: string;
  /** Cantidad de servicios del proyecto. */
  services: number;
}

export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING" | "CLOSED";
export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/** Un ticket de soporte de Pxsol Agencias, tal como lo lista su MCP. */
export interface Ticket {
  numero: number;
  numeroEnNexus: number | null;
  asunto: string;
  estado: TicketStatus;
  prioridad: TicketPriority;
  agencia: string | null;
  atiende: string | null;
  comentarios: number;
  /** ISO. */
  creadoEl: string;
  slaVencido: boolean;
  /** true si está asignado a quien usa la app. */
  mine: boolean;
}

export interface TicketsState {
  status: "loading" | "ok" | "disabled" | "not-configured" | "error";
  message: string | null;
  checking: boolean;
  lastCheck: number | null;
  /** Tickets sin cerrar. */
  tickets: Ticket[];
  /** Base de la web de Agencias, para abrir cada ticket ("https://testing.pxsolagencias.com"). */
  webUrl: string | null;
  /** "producción" o el subdominio ("testing"), para que se note contra qué entorno se mira. */
  environment: string | null;
}

/** El hilo completo de un ticket (`ver_ticket`). */
export interface TicketDetail {
  numero: number;
  numeroEnNexus: number | null;
  asunto: string;
  descripcion: string | null;
  estado: TicketStatus;
  prioridad: TicketPriority;
  categoria: string | null;
  tipo: string | null;
  agencia: string | null;
  abiertoPor: string | null;
  atiende: string | null;
  atiendeEmail: string | null;
  /** ISO. */
  creadoEl: string;
  venceEl: string | null;
  slaVencido: boolean;
  comentarios: { rol: string; autor: string; cuando: string; texto: string }[];
  /** La forma exacta depende del servidor: se muestra lo que traiga (nombre y link). */
  adjuntos: Record<string, unknown>[];
  diagnostico: { pantalla?: string; erroresDeConsola?: unknown[]; llamadasFallidas?: unknown[] } | null;
}

/** Lo que el panel de detalle necesita además del ticket: tu correo y la web. */
export interface TicketView {
  ticket: TicketDetail;
  me: string | null;
  webUrl: string | null;
}

export type TicketAction =
  | { type: "comment"; texto: string }
  | { type: "status"; estado: TicketStatus }
  | { type: "assign"; email: string | null };

export interface TicketsSettings {
  enabled: boolean;
  /** Nombre del servidor MCP en ~/.claude.json; null = el primero que parezca de tickets. */
  server: string | null;
}

/** Una nota del panel lateral. El título es su primera línea. */
export interface Note {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

// ---------- asistente (chat con Claude Code) ----------

/** Un mensaje del historial del chat. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  at: number;
  /** Herramientas que usó Claude para responder (solo en role "assistant"). */
  tools?: string[];
  /** Si la respuesta terminó con error (cortada, sin sesión, etc.). */
  error?: boolean;
}

/** Algo que Claude quiere hacer y que necesita el OK del usuario. */
export interface ApprovalRequest {
  id: string;
  tool: string;
  /** Descripción en castellano de lo que va a pasar. */
  summary: string;
  input: Record<string, unknown>;
}

/** Eventos de una respuesta en curso, para pintarla mientras llega. */
export type ChatStreamEvent =
  | { type: "start"; messageId: string }
  | { type: "text"; messageId: string; delta: string }
  | { type: "tool"; messageId: string; label: string }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-done"; id: string; approved: boolean }
  | { type: "done"; message: ChatMessage }
  | { type: "event"; message: ChatMessage };

export interface Reminder {
  id: string;
  /** ISO. */
  when: string;
  text: string;
  done: boolean;
}

export interface AssistantSettings {
  /** Alias de modelo de Claude Code: "sonnet", "opus", "haiku". */
  model: string;
}
