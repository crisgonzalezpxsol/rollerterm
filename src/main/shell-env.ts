// Ejecutar CLIs del usuario (claude, railway) como si se corrieran desde su terminal.
import { execFile } from "node:child_process";

// Variables que Claude Code pone en sus procesos hijos: si la app se lanzó desde una
// sesión de Claude Code, los CLIs creerían que corren anidados.
const INHERITED_CLAUDE_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
];

export interface Command {
  bin: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Busca un comando con el PATH de una shell interactiva: abierta desde el Finder, la app no
 * hereda el PATH de la terminal, y ~/.local/bin o nvm suelen agregarse en ~/.zshrc.
 */
export async function findCommand(name: string): Promise<Command | null> {
  const env = { ...process.env };
  for (const v of INHERITED_CLAUDE_VARS) delete env[v];
  const shell = process.env.SHELL || "/bin/zsh";
  const { stdout } = await exec(shell, ["-ilc", `printf "__RT__%s__RT__%s__RT__" "$PATH" "$(command -v ${name})"`], {
    env,
    timeoutMs: 15_000,
  }).catch(() => ({ stdout: "" }));
  const [, path, bin] = stdout.match(/__RT__(.*)__RT__(.*)__RT__/s) ?? [];
  if (path) env.PATH = path;
  return bin ? { bin, env } : null;
}

export function exec(
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitError: string | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Algunos CLIs salen con código ≠ 0 y aun así escriben el resultado.
        const exitError = err ? (err.killed ? `cortado por timeout (${opts.timeoutMs / 1000} s)` : err.message) : null;
        if (err && !stdout) reject(new Error([exitError, stderr.trim()].filter(Boolean).join(" · ")));
        else resolve({ stdout, stderr, exitError });
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}
