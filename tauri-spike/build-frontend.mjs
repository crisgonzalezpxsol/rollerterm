// Empaqueta la interfaz de rollerterm (src/renderer/) para Tauri, con el reemplazo de
// window.rollerterm delante. Se corre desde la raíz del repo: node tauri-spike/build-frontend.mjs
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const out = "tauri-spike/dist";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["tauri-spike/frontend/main.ts"],
  // Mismos nombres que en Electron: index.html pide renderer.js y renderer.css.
  outfile: `${out}/renderer.js`,
  bundle: true,
  minify: false,
  platform: "browser",
  format: "iife",
  logLevel: "info",
});

// La CSP de Electron no deja hablar con el IPC de Tauri: se le suma su origen.
const html = (await readFile("src/renderer/index.html", "utf8")).replace(
  "default-src 'self';",
  "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost;",
);
if (!html.includes("ipc.localhost")) throw new Error("no se encontró la CSP en index.html");
await writeFile(`${out}/index.html`, html);
await copyFile("assets/logo.svg", `${out}/logo.svg`);
await copyFile("assets/icon.png", `${out}/icon.png`);
