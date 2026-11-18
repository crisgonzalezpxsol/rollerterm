#!/bin/sh
# Suma la memoria PSS (la compartida se reparte entre procesos, así no se cuenta
# dos veces) de un proceso y todos sus hijos, excluyendo las shells de las pestañas.
#   sh tauri-spike/measure.sh rollerterm-tauri
#   sh tauri-spike/measure.sh rollerterm        # la versión Electron, para comparar
name="${1:?uso: measure.sh <nombre-del-proceso>}"
root=$(pgrep -xo "$name") || { echo "no está corriendo: $name"; exit 1; }

tree() {
  echo "$1"
  for c in $(pgrep -P "$1"); do
    comm=$(cat /proc/"$c"/comm 2>/dev/null)
    case "$comm" in bash|zsh|sh|fish) continue ;; esac
    tree "$c"
  done
}

total=0
for pid in $(tree "$root"); do
  kb=$(awk '/^Pss:/ {print $2}' /proc/"$pid"/smaps_rollup 2>/dev/null)
  note=""
  if [ -z "$kb" ]; then
    # Procesos sandboxeados (p. ej. el renderer de Chromium) no dejan leer smaps:
    # se usa RSS, que sobreestima un poco porque cuenta lo compartido entero.
    kb=$(awk '/^VmRSS:/ {print $2}' /proc/"$pid"/status 2>/dev/null)
    [ -n "$kb" ] || continue
    note="  (RSS, sin acceso a PSS)"
  fi
  printf '%8d KB  %s%s\n' "$kb" "$(cat /proc/"$pid"/comm)" "$note"
  total=$((total + kb))
done
echo "--------"
echo "$((total / 1024)) MB PSS total ($name)"
