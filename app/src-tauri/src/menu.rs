// Menú nativo de macOS, el mismo de la versión Electron (buildMenu en main.ts). Sin él no
// andan Cmd+C / Cmd+V en los campos de texto. Cada opción propia le manda a la ventana
// el comando como evento "menu". En Linux no hay barra de menú: los atajos los escucha
// la ventana (tauri-api.ts).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Prefijo de las opciones propias, para no confundirlas con las del sistema.
const PREFIX: &str = "rt:";

fn item(app: &AppHandle, cmd: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, format!("{PREFIX}{cmd}"), label, true, accel)
}

fn submenu(app: &AppHandle, label: &str, items: &[(&str, &str, Option<&str>)]) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut b = SubmenuBuilder::new(app, label);
    for (cmd, text, accel) in items {
        b = if cmd.is_empty() { b.separator() } else { b.item(&item(app, cmd, text, *accel)?) };
    }
    b.build()
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "rollerterm")
        .item(&PredefinedMenuItem::about(app, Some("Acerca de rollerterm"), None)?)
        .separator()
        .item(&item(app, "open-settings", "Configuración…", Some("CmdOrCtrl+,"))?)
        .item(&item(app, "export-config", "Exportar configuración…", None)?)
        .item(&item(app, "import-config", "Importar configuración…", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Salir propio (no el del sistema) para guardar las carpetas de las pestañas antes.
        .item(&MenuItem::with_id(app, "quit", "Salir de rollerterm", true, Some("CmdOrCtrl+Q"))?)
        .build()?;

    let mut tabs: Vec<(String, String, Option<String>)> = vec![
        ("new-tab".into(), "Nueva pestaña…".into(), Some("CmdOrCtrl+T".into())),
        ("rename-tab".into(), "Renombrar pestaña".into(), Some("CmdOrCtrl+Shift+R".into())),
        ("close-tab".into(), "Cerrar pestaña".into(), Some("CmdOrCtrl+W".into())),
        (String::new(), String::new(), None),
        ("next-tab".into(), "Pestaña siguiente".into(), Some("CmdOrCtrl+Shift+]".into())),
        ("prev-tab".into(), "Pestaña anterior".into(), Some("CmdOrCtrl+Shift+[".into())),
        (String::new(), String::new(), None),
        ("toggle-terminal-max".into(), "Agrandar / restaurar la terminal".into(), Some("CmdOrCtrl+Shift+Enter".into())),
        (String::new(), String::new(), None),
    ];
    for i in 1..=9 {
        tabs.push((format!("goto-tab:{}", i - 1), format!("Ir a la pestaña {i}"), Some(format!("CmdOrCtrl+{i}"))));
    }
    let tabs: Vec<(&str, &str, Option<&str>)> = tabs.iter().map(|(c, t, a)| (c.as_str(), t.as_str(), a.as_deref())).collect();

    let edit = SubmenuBuilder::new(app, "Edición")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "Ver").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Ventana").minimize().maximize().separator().close_window().build()?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &submenu(app, "Pestañas", &tabs)?,
            &submenu(
                app,
                "Pomodoro",
                &[("pomodoro-toggle", "Iniciar / pausar", Some("CmdOrCtrl+Shift+P")), ("pomodoro-reset", "Reiniciar", None)],
            )?,
            &submenu(app, "Notas", &[("toggle-notes", "Mostrar / ocultar notas", Some("CmdOrCtrl+Shift+N"))])?,
            &submenu(app, "Asistente", &[("toggle-assistant", "Mostrar / ocultar el chat", Some("CmdOrCtrl+Shift+K"))])?,
            &submenu(app, "Sonido", &[("toggle-mute", "Silenciar / activar sonidos y avisos", Some("CmdOrCtrl+Shift+M"))])?,
            &edit,
            &view,
            &window,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == "quit" {
            crate::quit_saving(app.app_handle());
        } else if let Some(cmd) = id.strip_prefix(PREFIX) {
            let _ = app.emit("menu", cmd);
        }
    });
    Ok(())
}
