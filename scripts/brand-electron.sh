#!/bin/sh
# Sin empaquetar, macOS muestra el nombre y el ícono del Electron.app que trae npm
# ("Electron" en la barra de menú, en ⌘Tab y en Notificaciones). Este script lo
# renombra a rollerterm y le pone nuestro ícono. Corre solo en el postinstall.
set -e
[ "$(uname)" = "Darwin" ] || exit 0

APP="node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0

plutil -replace CFBundleName -string rollerterm "$PLIST"
plutil -replace CFBundleDisplayName -string rollerterm "$PLIST"
# Identificador propio: las notificaciones aparecen como "rollerterm" en Configuración del Sistema.
plutil -replace CFBundleIdentifier -string com.pxsol.rollerterm "$PLIST"
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"

# Cambiar el Info.plist invalida la firma ad-hoc de Electron; en Apple Silicon una app sin
# firma válida no abre, así que se vuelve a firmar (ad-hoc, local).
codesign --force --deep --sign - "$APP" 2>/dev/null
# Que el Finder y el Dock tomen el nombre y el ícono nuevos.
touch "$APP"
echo "Electron.app renombrado a rollerterm"
