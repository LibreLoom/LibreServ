//! System tray / menu-bar extra so Luna can keep running without a visible window.
//! Linux/BSD use a StatusNotifierItem (ksni), macOS uses a native menu-bar
//! status item (tray-icon), Windows uses Shell_NotifyIcon (tray_win).
//! Platforms with none get a no-op — the app still works, just without a
//! persistent tray icon.

use std::sync::{Arc, Mutex};

use gtk::glib;

#[cfg(windows)]
use crate::tray_win;
#[cfg(all(unix, not(target_os = "macos")))]
use ksni::blocking::TrayMethods;
#[cfg(target_os = "macos")]
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
#[cfg(target_os = "macos")]
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

/// Commands the tray sends to the GTK main thread.
#[derive(Clone, Copy, Debug)]
pub enum TrayCmd {
    Show,
    Quit,
}

#[cfg(all(unix, not(target_os = "macos")))]
struct LunaTray {
    tx: std::sync::mpsc::Sender<TrayCmd>,
    icon_name: String,
    icon_theme_path: String,
}

#[cfg(all(unix, not(target_os = "macos")))]
impl ksni::Tray for LunaTray {
    fn id(&self) -> String {
        "org.libreloom.LunaDesktop".into()
    }

    fn title(&self) -> String {
        crate::product_name().into()
    }

    fn icon_name(&self) -> String {
        self.icon_name.clone()
    }

    fn icon_theme_path(&self) -> String {
        self.icon_theme_path.clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: crate::product_name().into(),
            icon_name: self.icon_name.clone(),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::*;
        vec![
            StandardItem {
                label: "Open Luna".into(),
                activate: Box::new(|tray: &mut LunaTray| {
                    let _ = tray.tx.send(TrayCmd::Show);
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit Luna".into(),
                activate: Box::new(|tray: &mut LunaTray| {
                    let _ = tray.tx.send(TrayCmd::Quit);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        let _ = self.tx.send(TrayCmd::Show);
    }
}

/// Keeps the tray backend alive for the process lifetime.
pub struct TrayHandle {
    #[cfg(all(unix, not(target_os = "macos")))]
    _handle: ksni::blocking::Handle<LunaTray>,
    #[cfg(windows)]
    _win: tray_win::WinTray,
    #[cfg(target_os = "macos")]
    _mac: TrayIcon,
}

#[cfg(all(unix, not(target_os = "macos")))]
fn resolve_icon() -> (String, String) {
    let theme_path = nearby_icon_theme_path();
    let name = "org.libreloom.LunaDesktop";
    if let Some(display) = gtk::gdk::Display::default() {
        let theme = gtk::IconTheme::for_display(&display);
        if !theme_path.is_empty() {
            theme.add_search_path(std::path::Path::new(&theme_path));
        }
        if theme.has_icon(name) {
            return (name.into(), theme_path);
        }
    }
    ("folder".into(), theme_path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn nearby_icon_theme_path() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return String::new();
    };
    let Some(bin_dir) = exe.parent() else {
        return String::new();
    };
    for rel in ["../share/icons", "share/icons"] {
        let candidate = bin_dir.join(rel);
        if candidate.is_dir() {
            return candidate
                .canonicalize()
                .unwrap_or(candidate)
                .to_string_lossy()
                .into_owned();
        }
    }
    String::new()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_backend(tx: std::sync::mpsc::Sender<TrayCmd>) -> Option<TrayHandle> {
    let (icon_name, icon_theme_path) = resolve_icon();
    let tray = LunaTray {
        tx,
        icon_name,
        icon_theme_path,
    };
    match tray.assume_sni_available(true).spawn() {
        Ok(h) => Some(TrayHandle { _handle: h }),
        Err(e) => {
            eprintln!(
                "luna-desktop: system tray unavailable ({e}); window close hides — use Settings → Quit {} to stop",
                crate::product_name()
            );
            None
        }
    }
}

#[cfg(windows)]
fn spawn_backend(tx: std::sync::mpsc::Sender<TrayCmd>) -> Option<TrayHandle> {
    tray_win::spawn(tx).map(|_win| TrayHandle { _win: _win })
}

#[cfg(target_os = "macos")]
fn macos_icon() -> Option<Icon> {
    let img = image::load_from_memory_with_format(
        include_bytes!("../resources/icon.png"),
        image::ImageFormat::Png,
    )
    .ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Icon::from_rgba(rgba.into_raw(), w, h).ok()
}

/// macOS menu-bar status item. Left click shows the menu (macOS convention),
/// which carries Open Luna / Quit Luna.
#[cfg(target_os = "macos")]
fn spawn_backend(tx: std::sync::mpsc::Sender<TrayCmd>) -> Option<TrayHandle> {
    let menu = Menu::new();
    let open = MenuItem::new("Open Luna", true, None);
    let quit = MenuItem::new(format!("Quit {}", crate::product_name()), true, None);
    if menu.append_items(&[&open, &quit]).is_err() {
        return None;
    }
    let open_id = open.id().clone();
    let quit_id = quit.id().clone();

    let tray = match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(crate::product_name())
        .with_icon(macos_icon()?)
        .build()
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("luna-desktop: menu-bar icon unavailable ({e})");
            return None;
        }
    };

    // Menu events arrive on a global channel — bridge them into the tray's
    // command channel so the GTK main loop handles them like every platform.
    std::thread::spawn(move || {
        while let Ok(event) = MenuEvent::receiver().recv() {
            let cmd = if event.id == open_id {
                TrayCmd::Show
            } else if event.id == quit_id {
                TrayCmd::Quit
            } else {
                continue;
            };
            let _ = tx.send(cmd);
        }
    });

    Some(TrayHandle { _mac: tray })
}

#[cfg(not(any(unix, windows)))]
fn spawn_backend(_tx: std::sync::mpsc::Sender<TrayCmd>) -> Option<TrayHandle> {
    None
}

/// Spawn the tray. Polls commands on the GTK main loop.
pub fn spawn_tray(on_cmd: impl Fn(TrayCmd) + 'static) -> Option<TrayHandle> {
    let (tx, rx) = std::sync::mpsc::channel::<TrayCmd>();
    let handle = spawn_backend(tx)?;

    let rx = Arc::new(Mutex::new(rx));
    let on_cmd = std::rc::Rc::new(on_cmd);
    glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        let mut batch = Vec::new();
        if let Ok(guard) = rx.lock() {
            while let Ok(cmd) = guard.try_recv() {
                batch.push(cmd);
            }
        }
        for cmd in batch {
            on_cmd(cmd);
        }
        glib::ControlFlow::Continue
    });

    Some(handle)
}
