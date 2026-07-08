use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuEvent},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Runtime, Window, WindowEvent,
};

const TRAY_ID: &str = "mhxy-shikong-control-main";
const TRAY_MENU_SHOW_ID: &str = "mhxy-shikong-control-show";
const TRAY_MENU_EXIT_ID: &str = "mhxy-shikong-control-exit";
const TRAY_TOOLTIP: &str = "时空任务编排器";

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_SHOW_ID, "显示主窗口")
        .separator()
        .text(TRAY_MENU_EXIT_ID, "退出")
        .build()?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(TRAY_TOOLTIP)
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            handle_tray_icon_event(tray.app_handle(), event);
        })
        .build(app)?;

    Ok(())
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }

    api.prevent_close();
    let _ = window.hide();
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        TRAY_MENU_SHOW_ID => show_main_window(app),
        TRAY_MENU_EXIT_ID => app.exit(0),
        _ => {}
    }
}

fn handle_tray_icon_event(app: &AppHandle, event: TrayIconEvent) {
    match event {
        TrayIconEvent::DoubleClick { .. } => show_main_window(app),
        TrayIconEvent::Click {
            button,
            button_state,
            ..
        } if button == MouseButton::Left && button_state == MouseButtonState::Up => {
            show_main_window(app);
        }
        _ => {}
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
