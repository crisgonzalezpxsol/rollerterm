# tabterm

Terminal de escritorio (macOS) con pestañas con nombre: una pestaña por ticket o
por funcionalidad. Las pestañas, sus nombres y el directorio donde quedó cada una
se recuerdan al cerrar y se restauran al abrir.

## Uso

```bash
npm install     # instala y compila node-pty contra la versión de Electron
npm start       # compila y abre la app
```

| Acción | Cómo |
| --- | --- |
| Nueva pestaña | `⌘T` · botón `+` · doble clic en el hueco de la barra |
| Renombrar | doble clic en el nombre · `⌘⇧R` (Enter guarda, Esc cancela) |
| Cerrar | `⌘W` · `×` · clic con la rueda |
| Cambiar de pestaña | `⌘1`…`⌘8`, `⌘9` = la última · `⌘⇧]` / `⌘⇧[` |
| Reordenar | arrastrar la pestaña |
| Reabrir una shell que terminó | Enter dentro de la pestaña (conserva el nombre) |

La sesión se guarda en `~/Library/Application Support/tabterm/session.json`.

## Arquitectura

Electron + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty)
(la misma base que la terminal integrada de VS Code), todo en TypeScript y empaquetado con esbuild.

```
src/main/       proceso principal: ventana, menú/atajos, una shell (pty) por pestaña, sesión
src/preload/    puente aislado: expone window.tabterm a la ventana (sin Node en el renderer)
src/renderer/   la ventana: barra de pestañas y una terminal xterm por pestaña
src/shared/     tipos compartidos (Session, MenuCommand, TabtermApi)
```

## Tropiezos conocidos

- **`posix_spawnp failed`** al abrir una pestaña: npm instala el `spawn-helper` de node-pty sin
  permiso de ejecución en macOS. El `postinstall` le hace `chmod +x`; si aparece, correr
  `npm run postinstall`.
- Al subir de versión Electron, hay que recompilar node-pty: `npm run postinstall`.
