// Genera assets/icon.png (1024×1024) a partir de assets/logo.svg usando el propio Electron.
// Uso: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const svg = readFileSync(join(root, "assets/logo.svg"), "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="1024" height="1024" ')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(join(root, "assets/icon.png"), img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log("assets/icon.png generado");
  app.exit(0);
});
