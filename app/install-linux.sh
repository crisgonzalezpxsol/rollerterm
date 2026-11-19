#!/bin/sh
# Instala la versión Tauri en ~/.local y la agrega al menú de aplicaciones como
# «rollerterm (Tauri)», al lado de la versión Electron (no la reemplaza).
# Se corre desde la raíz del repo: npm run install-app
set -e
BIN="app/src-tauri/target/release/rollerterm-tauri"
DEST="$HOME/.local/opt/rollerterm-tauri"
[ -x "$BIN" ] || { echo "Falta $BIN; corré npm run spike:tauri:build"; exit 1; }

mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications"
# Copiar a un temporal y renombrar: así se puede reinstalar con la app abierta.
cp "$BIN" "$DEST/rollerterm-tauri.new" && mv -f "$DEST/rollerterm-tauri.new" "$DEST/rollerterm-tauri"
cp assets/icon.png "$DEST/icon.png"
ln -sf "$DEST/rollerterm-tauri" "$HOME/.local/bin/rollerterm-tauri"

cat > "$HOME/.local/share/applications/rollerterm-tauri.desktop" <<DESKTOP
[Desktop Entry]
Name=rollerterm (Tauri)
Comment=rollerterm sobre Tauri: la versión liviana, en prueba
Exec=$DEST/rollerterm-tauri
Icon=$DEST/icon.png
Terminal=false
Type=Application
Categories=Development;TerminalEmulator;
StartupWMClass=rollerterm-tauri
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "rollerterm (Tauri) instalado en $DEST"
