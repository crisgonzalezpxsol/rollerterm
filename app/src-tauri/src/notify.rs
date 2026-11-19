// Notificaciones nativas. WebKitGTK no muestra las `new Notification` de la página, así que
// el reemplazo del frontend las manda acá; el clic vuelve a la ventana como "notify:click".

use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn notify(app: AppHandle, id: u32, title: String, body: String) {
    std::thread::spawn(move || {
        // En macOS la notificación sale a nombre de una app instalada (si no, figura como Finder).
        #[cfg(target_os = "macos")]
        {
            static APP: std::sync::Once = std::sync::Once::new();
            APP.call_once(|| {
                let _ = notify_rust::set_application(&app.config().identifier);
            });
        }
        let shown = notify_rust::Notification::new()
            .appname("rollerterm")
            .summary(&title)
            .body(&body)
            .action("default", "Abrir")
            .show();
        let Ok(handle) = shown else { return };
        // En macOS el clic en la notificación ya trae la app al frente; no hay acción que esperar.
        #[cfg(target_os = "macos")]
        let _ = (handle, &app, id);
        // Espera el clic (o que se cierre) en este hilo, sin trabar nada más.
        #[cfg(not(target_os = "macos"))]
        handle.wait_for_action(|action| {
            if action == "default" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                let _ = app.emit("notify:click", id);
            }
        });
    });
}
