import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as pty from "node-pty";

/** Una shell por pestaña, indexada por el id de la pestaña. */
export class PtyManager {
  private ptys = new Map<string, pty.IPty>();

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, exitCode: number) => void,
  ) {}

  create(id: string, cwd: string, cols: number, rows: number): void {
    this.kill(id);
    const shell = process.env.SHELL || "/bin/zsh";
    const dir = cwd && existsSync(cwd) ? cwd : homedir();
    // Shell de login (-l) para que cargue el PATH y los alias igual que Terminal.app.
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: dir,
      env: { ...process.env, TERM_PROGRAM: "tabterm" } as Record<string, string>,
    });
    proc.onData((data) => this.onData(id, data));
    proc.onExit(({ exitCode }) => {
      // Si ya fue reemplazada por otra shell en la misma pestaña, no avisar.
      if (this.ptys.get(id) === proc) {
        this.ptys.delete(id);
        this.onExit(id, exitCode);
      }
    });
    this.ptys.set(id, proc);
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    const proc = this.ptys.get(id);
    if (!proc) return;
    this.ptys.delete(id);
    proc.kill();
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }

  /** Directorio actual de la shell (macOS no lo expone en /proc, se le pregunta a lsof). */
  getCwd(id: string): Promise<string | null> {
    const proc = this.ptys.get(id);
    if (!proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile("lsof", ["-a", "-p", String(proc.pid), "-d", "cwd", "-Fn"], (err, stdout) => {
        if (err) return resolve(null);
        const line = stdout.split("\n").find((l) => l.startsWith("n"));
        resolve(line ? line.slice(1) : null);
      });
    });
  }
}
