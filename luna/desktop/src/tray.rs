//! System tray (StatusNotifierItem) so Luna can keep running without a visible window.

use std::sync::{Arc, Mutex};

use gtk::glib;
use ksni::blocking::TrayMethods;

/// Commands the tray sends to the GTK main thread.
#[derive(Clone, Copy, Debug)]
pub enum TrayCmd {
    Show,
    Quit,
}

struct LunaTray {
    tx: std::sync::mpsc::Sender<TrayCmd>,
    icon_name: String,
    icon_theme_path: String,
}

impl ksni::Tray for LunaTray {
    fn id(&self) -> String {
        "org.libreloom.LunaDesktop".into()
    }

    fn title(&self) -> String {
        "Luna Desktop".into()
    }

    fn icon_name(&self) -> String {
        self.icon_name.clone()
    }

    fn icon_theme_path(&self) -> String {
        self.icon_theme_path.clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "Luna Desktop".into(),
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

/// Keeps the StatusNotifierItem service alive for the process lifetime.
pub struct TrayHandle {
    _handle: ksni::blocking::Handle<LunaTray>,
}

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

/// Spawn the tray service. Polls commands on the GTK main loop.
pub fn spawn_tray(on_cmd: impl Fn(TrayCmd) + 'static) -> Option<TrayHandle> {
    let (tx, rx) = std::sync::mpsc::channel::<TrayCmd>();
    let (icon_name, icon_theme_path) = resolve_icon();
    let tray = LunaTray {
        tx,
        icon_name,
        icon_theme_path,
    };

    let handle = match tray.assume_sni_available(true).spawn() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("luna-desktop: system tray unavailable ({e}); close the window to quit");
            return None;
        }
    };

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

    Some(TrayHandle { _handle: handle })
}
