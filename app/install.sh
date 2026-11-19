#!/bin/sh
# Instala la versión Tauri según el sistema. Se corre desde la raíz del repo: npm run install-app
case "$(uname -s)" in
  Darwin) exec sh app/install-macos.sh ;;
  Linux) exec sh app/install-linux.sh ;;
  *) echo "Sistema no soportado: $(uname -s)"; exit 1 ;;
esac
