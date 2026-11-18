// Empaqueta el frontend del prototipo con el esbuild y el xterm.js que ya usa
// la versión Electron (se corre desde la raíz del repo: node tauri-spike/build-frontend.mjs).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const out = "tauri-spike/dist";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["tauri-spike/frontend/main.ts"],
  outfile: `${out}/main.js`,
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  logLevel: "info",
});
await copyFile("tauri-spike/frontend/index.html", `${out}/index.html`);
await copyFile("node_modules/@xterm/xterm/css/xterm.css", `${out}/xterm.css`);
