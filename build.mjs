// Empaqueta los tres mundos de Electron por separado: main (Node), preload
// (puente aislado) y renderer (navegador). node-pty es nativo y no se bundlea.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", external: ["electron", "node-pty"] }),
  build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/renderer.ts"], outfile: "dist/renderer.js", platform: "browser", format: "iife" }),
]);

await copyFile("src/renderer/index.html", "dist/index.html");
await copyFile("assets/logo.svg", "dist/logo.svg");
await copyFile("assets/icon.png", "dist/icon.png");
