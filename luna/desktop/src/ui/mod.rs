mod adaptive;
mod auth_failed;
mod backup_page;
mod folder_browser;
mod login;
mod notices;
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
use luna_desktop::instance::{self, InstanceEvent};
use luna_desktop::tray::{TrayCmd, TrayHandle, spawn_tray};

use auth_failed::AuthFailedView;
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

/// Hand freed heap back to the system. A closed window frees its surface,
/// textures and caches into malloc's free lists, which otherwise stay resident
/// for as long as the app sits in the tray.
fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: glibc's malloc_trim only walks malloc's own free lists.
        unsafe {
            malloc_trim(0);
        }
    }
}

/// Draw with the CPU instead of OpenGL or Vulkan. These screens are forms and
/// lists that redraw rarely, and GDK loads the GPU driver as soon as it opens
/// the display, even with the window closed: on a software (llvmpipe) driver
/// that alone is ~75 MB of the ~140 MB the app held in the tray. Anything the
/// user set themselves wins. Must run before GTK starts and before any thread.
fn prefer_software_rendering() {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let gdk_set = ["GDK_DISABLE", "GDK_DEBUG"]
            .iter()
            .any(|k| std::env::var_os(k).is_some());
        // A renderer the user picked stays; only cairo (CPU) lets GDK skip
        // the GPU driver too, so that one still gets GL turned off.
        let renderer = std::env::var("GSK_RENDERER").ok();
        let wants_gpu = renderer.as_deref().is_some_and(|r| r != "cairo");
        if gdk_set || wants_gpu {
            return;
        }
        // SAFETY: called first thing in `run`, before any thread is spawned.
        unsafe {
            if renderer.is_none() {
                std::env::set_var("GSK_RENDERER", "cairo");
            }
            if gtk::major_version() == 4 && gtk::minor_version() < 16 {
                std::env::set_var("GDK_DEBUG", "gl-disable,vulkan-disable");
            } else {
                std::env::set_var("GDK_DISABLE", "gl,vulkan");
            }
        }
    }
}

/// Keeps the process alive while the window is hidden (backup/sync continue).
struct KeepAlive {
    _hold: gtk::gio::ApplicationHoldGuard,
    _tray: Option<TrayHandle>,
    _instance: Option<instance::Instance>,
}

/// What the window does with the start-up sign-in check once it lands.
type BootWaiter = Box<dyn FnOnce(luna_desktop::RestoreOutcome)>;

/// The saved sign-in check at start-up. It runs once per process, with or
/// without a window, so syncs and backups start even when the app starts in
/// the background and nobody opens it.
#[derive(Default)]
struct Boot {
    /// `None` while Luna is still being asked.
    outcome: RefCell<Option<luna_desktop::RestoreOutcome>>,
    /// The open window's handler, called once the answer arrives.
    waiter: RefCell<Option<BootWaiter>>,
}

impl Boot {
    fn start(self: &Rc<Self>, state: Arc<AppState>) {
        let this = self.clone();
        let state_jobs = state.clone();
        spawn_blocking(
            move || luna_desktop::restore_session(&state),
            move |outcome| {
                luna_desktop::perf_mark("session");
                *this.outcome.borrow_mut() = Some(outcome.clone());
                let waiter = this.waiter.borrow_mut().take();
                if let Some(waiter) = waiter {
                    // The open window shows the result; its shell starts the jobs.
                    waiter(outcome);
                } else if let luna_desktop::RestoreOutcome::Restored(_) = outcome {
                    spawn_blocking(
                        move || {
                            let _ = luna_desktop::autostart::init_default();
                            luna_desktop::start_all_jobs(&state_jobs);
                        },
                        // Start-up parsed themes and fonts into memory it then freed.
                        |_| release_freed_memory(),
                    );
                }
            },
        );
    }
}

pub fn run() -> glib::ExitCode {
    prefer_software_rendering();
    luna_desktop::ensure_runtime_env();

    let mut args: Vec<String> = std::env::args().collect();
    let background = args.iter().any(|a| a == "--background" || a == "-b");
    args.retain(|a| a != "--background" && a != "-b");

    // Single instance: if Luna is already running (even with its window hidden
    // or via start-on-boot), ask it to show its window and exit — two copies
    // would race over the same backups, syncs, and ledgers.
    let (instance_tx, instance_rx) = std::sync::mpsc::channel::<InstanceEvent>();
    let instance = match instance::claim(instance_tx) {
        Ok(i) => i,
        Err(()) => return glib::ExitCode::SUCCESS,
    };

    let app = adw::Application::builder()
        .application_id("org.libreloom.LunaDesktop")
        .build();

    let state = Arc::new(AppState::default());
    let window_slot: Rc<RefCell<Option<adw::ApplicationWindow>>> = Rc::new(RefCell::new(None));
    let keep_alive: Rc<RefCell<Option<KeepAlive>>> = Rc::new(RefCell::new(None));
    let tray_present = Rc::new(std::cell::Cell::new(false));
    // Held for the whole process — dropping it releases the single-instance lock.
    let instance_slot: Rc<RefCell<Option<instance::Instance>>> =
        Rc::new(RefCell::new(Some(instance)));
    let boot = Rc::new(Boot::default());
    let notices: Rc<RefCell<Option<Rc<notices::Notices>>>> = Rc::new(RefCell::new(None));

    app.connect_startup(|_| load_app_css());

    app.connect_activate({
        let state = state.clone();
        let window_slot = window_slot.clone();
        let keep_alive = keep_alive.clone();
        let instance_slot = instance_slot.clone();
        move |app| {
            if let Some(win) = window_slot.borrow().as_ref() {
                win.set_visible(true);
                win.present();
                return;
            }
            let first = keep_alive.borrow().is_none();
            if first {
                // Ensure start on boot is enabled by default unless explicitly disabled.
                if let Err(e) = luna_desktop::autostart::init_default() {
                    eprintln!("luna-desktop: couldn't initialize start on boot default: {e}");
                }
                boot.start(state.clone());
                let n = notices::Notices::new(state.clone());
                n.start();
                *notices.borrow_mut() = Some(n);

                let window_slot = window_slot.clone();
                let app_for_tray = app.clone();
                let tray = spawn_tray(move |cmd| match cmd {
                    TrayCmd::Show => {
                        if let Some(w) = window_slot.borrow().as_ref() {
                            w.set_visible(true);
                            w.present();
                        } else {
                            app_for_tray.activate();
                        }
                    }
                    TrayCmd::Quit => {
                        app_for_tray.quit();
                    }
                });
                tray_present.set(tray.is_some());
                luna_desktop::perf_mark(if tray.is_some() { "tray" } else { "no-tray" });
                if tray.is_none() {
                    eprintln!(
                        "luna-desktop: no system tray host; closing the window minimizes it — use Settings → Quit {} to stop",
                        luna_desktop::product_name()
                    );
                }
                *keep_alive.borrow_mut() = Some(KeepAlive {
                    _hold: app.hold(),
                    _tray: tray,
                    _instance: instance_slot.borrow_mut().take(),
                });
                // Start-on-boot: no window until someone opens one.
                if background {
                    return;
                }
            }

            let Some(notices) = notices.borrow().clone() else {
                return;
            };
            let win = build_ui(app, state.clone(), &boot, &notices);
            *window_slot.borrow_mut() = Some(win.clone());

            // Closing the window keeps backup/sync running. With a tray the
            // window hides and lets go of what it only needs on screen;
            // without one (no tray host — e.g. a broken Linux session)
            // closing must not strand the app, so it minimizes.
            win.set_hide_on_close(true);
            win.connect_close_request({
                let tray_present = tray_present.clone();
                move |w| {
                    if tray_present.get() {
                        w.set_visible(false);
                        // Hidden is not enough: a realized window keeps its
                        // surface, renderer, textures and glyph caches. The
                        // widgets stay, so it reopens exactly as it was.
                        WidgetExt::unrealize(w);
                        glib::timeout_add_seconds_local_once(1, release_freed_memory);
                    } else {
                        w.minimize();
                    }
                    glib::Propagation::Stop
                }
            });

            win.connect_map(|_| {
                luna_desktop::perf_mark("window");
                // Start-up parses themes and fonts into memory it then frees.
                glib::timeout_add_seconds_local_once(5, release_freed_memory);
            });
            win.present();
        }
    });

    // A relaunch of luna-desktop asks the running copy to show its window.
    {
        let window_slot = window_slot.clone();
        let app = app.clone();
        glib::timeout_add_local(std::time::Duration::from_millis(150), move || {
            while let Ok(ev) = instance_rx.try_recv() {
                match ev {
                    InstanceEvent::Show => {
                        if let Some(w) = window_slot.borrow().as_ref() {
                            w.set_visible(true);
                            w.present();
                        } else {
                            app.activate();
                        }
                    }
                }
            }
            glib::ControlFlow::Continue
        });
    }

    app.run_with_args(&args)
}

fn build_ui(
    app: &adw::Application,
    state: Arc<AppState>,
    boot: &Rc<Boot>,
    notices: &Rc<notices::Notices>,
) -> adw::ApplicationWindow {
    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("Luna")
        .build();
    adaptive::apply_window_defaults(&window);

    let toast = adw::ToastOverlay::new();
    let stack = gtk::Stack::new();
    stack.set_transition_type(gtk::StackTransitionType::Crossfade);
    toast.set_child(Some(&stack));
    toast.set_vexpand(true);

    let toast_rc = Rc::new(toast);
    notices.attach(&toast_rc);
    let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
    column.append(notices.root());
    column.append(&*toast_rc);
    window.set_content(Some(&column));
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
            win.set_title(Some(&format!("Luna ({})", shell.username())));
        })
    };

    let login = Rc::new(LoginView::new(
        state.clone(),
        toast_rc.clone(),
        show_shell.clone(),
    ));
    stack_rc.add_named(login.root(), Some("login"));

    let reconfigure_url: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

    let show_login_for_reconfigure = {
        let stack = stack_rc.clone();
        let login = login.clone();
        let reconfigure_url = reconfigure_url.clone();
        Rc::new(move || {
            if let Some(url) = reconfigure_url.borrow_mut().take() {
                login.prepare_reconfigure(&url);
            }
            stack.set_visible_child_name("login");
        })
    };

    let auth_failed = AuthFailedView::new(show_login_for_reconfigure.clone());
    stack_rc.add_named(auth_failed.root(), Some("auth_failed"));

    let boot_label = gtk::Label::new(Some("Checking your sign-in…"));
    boot_label.add_css_class("title-2");
    let boot_box = gtk::Box::new(gtk::Orientation::Vertical, 12);
    boot_box.set_valign(gtk::Align::Center);
    boot_box.set_halign(gtk::Align::Center);
    boot_box.append(&boot_label);
    stack_rc.add_named(&boot_box, Some("boot"));
    stack_rc.set_visible_child_name("boot");

    let show_outcome = {
        let stack = stack_rc.clone();
        let toast = toast_rc.clone();
        move |outcome: luna_desktop::RestoreOutcome| {
            // An injected dev token (auto sign-in) may already have shown the
            // shell before this restore lands — never yank it back to login.
            // Check the screen, not the session: a successful restore fills
            // the session itself, and checking that kept a signed-in app on
            // "Checking your sign-in…" with its syncs and backups never started.
            if stack.visible_child_name().as_deref() != Some("boot") {
                return;
            }
            match outcome {
                luna_desktop::RestoreOutcome::Restored(info) => show_shell(info),
                luna_desktop::RestoreOutcome::NoSession => {
                    stack.set_visible_child_name("login");
                }
                luna_desktop::RestoreOutcome::AuthFailed { base_url } => {
                    *reconfigure_url.borrow_mut() = Some(base_url);
                    stack.set_visible_child_name("auth_failed");
                }
                luna_desktop::RestoreOutcome::Failed(e) => {
                    toast.add_toast(adw::Toast::new(&e));
                    stack.set_visible_child_name("login");
                }
            }
        }
    };

    // Started in the background and opened later: show where things stand
    // now instead of asking Luna again.
    let known = boot.outcome.borrow().clone();
    match known {
        Some(outcome) => show_outcome(outcome),
        None => *boot.waiter.borrow_mut() = Some(Box::new(show_outcome)),
    }

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

/// Run `tick` when `widget` appears and then every `every` while it stays on
/// screen. The timer exists only while the widget is mapped, so a hidden page
/// or a window closed to the tray runs nothing.
pub fn tick_while_mapped(
    widget: &impl IsA<gtk::Widget>,
    every: std::time::Duration,
    tick: Rc<dyn Fn()>,
) {
    let source: Rc<RefCell<Option<glib::SourceId>>> = Rc::new(RefCell::new(None));
    widget.connect_map({
        let source = source.clone();
        move |_| {
            tick();
            let tick = tick.clone();
            let id = glib::timeout_add_local(every, move || {
                tick();
                glib::ControlFlow::Continue
            });
            if let Some(old) = source.borrow_mut().replace(id) {
                old.remove();
            }
        }
    });
    widget.connect_unmap(move |_| {
        if let Some(id) = source.borrow_mut().take() {
            id.remove();
        }
    });
}
