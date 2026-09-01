mod adaptive;
mod backup_page;
mod folder_browser;
mod login;
mod settings_page;
mod status_page;
mod sync_page;
mod window;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;

use luna_desktop::AppState;
use luna_desktop::tray::{TrayCmd, TrayHandle, spawn_tray};

use login::LoginView;
use window::ShellView;

fn load_app_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(include_str!("../../resources/style.css"));
    if let Some(display) = gtk::gdk::Display::default() {
        gtk::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }
}

/// Keeps the process alive while the window is hidden (backup/sync continue).
struct KeepAlive {
    _hold: gtk::gio::ApplicationHoldGuard,
    _tray: Option<TrayHandle>,
}

pub fn run() -> glib::ExitCode {
    let mut args: Vec<String> = std::env::args().collect();
    let background = args.iter().any(|a| a == "--background" || a == "-b");
    args.retain(|a| a != "--background" && a != "-b");

    let app = adw::Application::builder()
        .application_id("org.libreloom.LunaDesktop")
        .build();

    let state = Arc::new(AppState::default());
    let window_slot: Rc<RefCell<Option<adw::ApplicationWindow>>> = Rc::new(RefCell::new(None));
    let keep_alive: Rc<RefCell<Option<KeepAlive>>> = Rc::new(RefCell::new(None));

    app.connect_activate({
        let state = state.clone();
        let window_slot = window_slot.clone();
        let keep_alive = keep_alive.clone();
        move |app| {
            load_app_css();
            if let Some(win) = window_slot.borrow().as_ref() {
                win.set_visible(true);
                win.present();
                return;
            }
            let win = build_ui(app, state.clone());
            *window_slot.borrow_mut() = Some(win.clone());

            // Always hide on close so backup/sync keep running.
            win.set_hide_on_close(true);
            win.connect_close_request(|w| {
                w.set_visible(false);
                glib::Propagation::Stop
            });

            if keep_alive.borrow().is_none() {
                let window_slot = window_slot.clone();
                let app_for_tray = app.clone();
                let tray = spawn_tray(move |cmd| match cmd {
                    TrayCmd::Show => {
                        if let Some(w) = window_slot.borrow().as_ref() {
                            w.set_visible(true);
                            w.present();
                        }
                    }
                    TrayCmd::Quit => {
                        app_for_tray.quit();
                    }
                });
                if tray.is_none() {
                    eprintln!(
                        "luna-desktop: no system tray host; window close still hides — reopen Luna from your app launcher or use Settings → Quit {}",
                        luna_desktop::product_name()
                    );
                }
                *keep_alive.borrow_mut() = Some(KeepAlive {
                    _hold: app.hold(),
                    _tray: tray,
                });
            }

            if !background {
                win.present();
            }
        }
    });

    app.run_with_args(&args)
}

fn build_ui(app: &adw::Application, state: Arc<AppState>) -> adw::ApplicationWindow {
    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("Luna")
        .build();
    adaptive::apply_window_defaults(&window);

    let toast = adw::ToastOverlay::new();
    let stack = gtk::Stack::new();
    stack.set_transition_type(gtk::StackTransitionType::Crossfade);
    toast.set_child(Some(&stack));
    window.set_content(Some(&toast));

    let toast_rc = Rc::new(toast);
    let stack_rc = Rc::new(stack);

    let show_shell = {
        let stack = stack_rc.clone();
        let toast = toast_rc.clone();
        let win = window.clone();
        let state = state.clone();
        Rc::new(move |info: luna_desktop::SessionInfo| {
            if let Some(child) = stack.child_by_name("shell") {
                stack.remove(&child);
            }
            let shell = ShellView::new(state.clone(), info.clone(), toast.clone(), {
                let stack = stack.clone();
                Rc::new(move || {
                    stack.set_visible_child_name("login");
                })
            });
            stack.add_named(shell.root(), Some("shell"));
            stack.set_visible_child_name("shell");
            win.set_title(Some(&format!("Luna — {}", shell.username())));
        })
    };

    let login = LoginView::new(state.clone(), toast_rc.clone(), show_shell.clone());
    stack_rc.add_named(login.root(), Some("login"));

    let boot_label = gtk::Label::new(Some("Checking your sign-in…"));
    boot_label.add_css_class("title-2");
    let boot_box = gtk::Box::new(gtk::Orientation::Vertical, 12);
    boot_box.set_valign(gtk::Align::Center);
    boot_box.set_halign(gtk::Align::Center);
    boot_box.append(&boot_label);
    stack_rc.add_named(&boot_box, Some("boot"));
    stack_rc.set_visible_child_name("boot");

    let state_boot = state.clone();
    let stack_boot = stack_rc.clone();
    let show_shell_boot = show_shell.clone();
    let toast_boot = toast_rc.clone();
    spawn_blocking(
        move || luna_desktop::restore_session(&state_boot),
        move |result| match result {
            Ok(Some(info)) => show_shell_boot(info),
            Ok(None) => stack_boot.set_visible_child_name("login"),
            Err(e) => {
                toast_boot.add_toast(adw::Toast::new(&e));
                stack_boot.set_visible_child_name("login");
            }
        },
    );

    window
}

/// Run `work` on a background thread; call `then` on the GTK main thread.
pub fn spawn_blocking<T, F, C>(work: F, then: C)
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
    C: FnOnce(T) + 'static,
{
    glib::spawn_future_local(async move {
        match gtk::gio::spawn_blocking(work).await {
            Ok(value) => then(value),
            Err(_) => {
                eprintln!("luna-desktop: background task panicked");
            }
        }
    });
}

pub fn toast_error(toast: &adw::ToastOverlay, err: impl AsRef<str>) {
    toast.add_toast(adw::Toast::new(err.as_ref()));
}
