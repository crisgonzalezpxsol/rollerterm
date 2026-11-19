#!/bin/sh
# Instala la versión Tauri en /Applications como «rollerterm Tauri.app», al lado de la
# versión Electron (rollerterm.app, no la toca). Arma el .app a mano: binario, ícono e
# Info.plist, con la misma firma ad-hoc que usa `npm run electron:install`.
# Se corre desde la raíz del repo: npm run install-app
set -e
BIN="app/src-tauri/target/release/rollerterm-tauri"
[ -x "$BIN" ] || { echo "Falta $BIN; corré npm run build"; exit 1; }
VERSION=$(node -p 'require("./package.json").version')
APP="$(mktemp -d)/rollerterm Tauri.app"
DEST="/Applications/rollerterm Tauri.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/rollerterm-tauri"
cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>rollerterm Tauri</string>
  <key>CFBundleDisplayName</key><string>rollerterm Tauri</string>
  <key>CFBundleExecutable</key><string>rollerterm-tauri</string>
  <key>CFBundleIdentifier</key><string>com.pxsol.rollerterm.spike</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$APP"

rm -rf "$DEST"
ditto "$APP" "$DEST"
rm -rf "$(dirname "$APP")"
echo "rollerterm Tauri instalado en $DEST"
