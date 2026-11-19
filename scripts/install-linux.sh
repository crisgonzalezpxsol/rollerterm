#!/bin/sh
# Instala el build de Linux (out/linux-unpacked) en ~/.local y lo agrega al menú de aplicaciones.
set -e
SRC="out/linux-unpacked"
DEST="$HOME/.local/opt/rollerterm"
[ -x "$SRC/rollerterm" ] || { echo "Falta $SRC; corré npm run electron:dist:linux"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications"
cp -a "$SRC/." "$DEST/"
ln -sf "$DEST/rollerterm" "$HOME/.local/bin/rollerterm"


cat > "$HOME/.local/share/applications/rollerterm.desktop" <<DESKTOP
[Desktop Entry]
Name=rollerterm
Comment=Terminal con pestañas con nombre, una por ticket o funcionalidad
Exec=$DEST/rollerterm %U
Icon=$DEST/resources/app/dist/icon.png
Terminal=false
Type=Application
Categories=Development;TerminalEmulator;
StartupWMClass=rollerterm
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "rollerterm instalado en $DEST"
# Chromium necesita chrome-sandbox con setuid root (Ubuntu 24.04 bloquea el sandbox sin privilegios).
if [ "$(stat -c %u "$DEST/chrome-sandbox")" != 0 ]; then
  echo "Falta un paso con sudo para el sandbox de Chromium:"
  echo "  sudo chown root:root $DEST/chrome-sandbox && sudo chmod 4755 $DEST/chrome-sandbox"
fi
