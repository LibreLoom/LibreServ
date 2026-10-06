//! Window-wide notices above every page: "this app and your Luna don't match"
//! and (Windows) "a Luna Desktop update is ready to install".
//!
//! Both are state, not events, so they are banners that stay until they stop
//! being true — never toasts.

#![cfg_attr(not(windows), allow(dead_code))]

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;

use luna_desktop::AppState;
use luna_desktop::update::{self, Available};

use super::{spawn_blocking, toast_error};

/// How often the signed-in Luna is asked again while all is well, and while it
/// is not (so jobs resume soon after the person updates Luna or the app).
const RECHECK_OK_SECS: u32 = 10 * 60;
const RECHECK_BAD_SECS: u32 = 30;

/// A downloaded, verified installer waiting for the person to say go.
struct Ready {
    avail: Available,
    installer: PathBuf,
}

pub struct Notices {
    root: gtk::Box,
    state: Arc<AppState>,
    toast: Rc<adw::ToastOverlay>,
    compat_banner: adw::Banner,
    update_banner: adw::Banner,
    ready: RefCell<Option<Ready>>,
    /// Version being downloaded or already downloaded, so a later check
    /// doesn't fetch the same installer again.
    handled_version: RefCell<Option<String>>,
}

impl Notices {
    pub fn new(state: Arc<AppState>, toast: Rc<adw::ToastOverlay>) -> Rc<Self> {
        let compat_banner = adw::Banner::new("");
        let update_banner = adw::Banner::new("");
        update_banner.set_button_label(Some("Install"));
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.append(&compat_banner);
        root.append(&update_banner);

        let this = Rc::new(Self {
            root,
            state,
            toast,
            compat_banner,
            update_banner,
            ready: RefCell::new(None),
            handled_version: RefCell::new(None),
        });
        this.update_banner.connect_button_clicked({
            let this = this.clone();
            move |_| this.ask_to_install()
        });
        this
    }

    pub fn root(&self) -> &gtk::Box {
        &self.root
    }

    /// Start the timers. Call once, after the window exists.
    pub fn start(self: &Rc<Self>) {
        // Show or hide the mismatch banner from the shared state.
        glib::timeout_add_seconds_local(2, {
            let this = self.clone();
            move || {
                this.show_compat();
                glib::ControlFlow::Continue
            }
        });

        // Ask the signed-in Luna again from time to time.
        let waited = Rc::new(std::cell::Cell::new(0u32));
        glib::timeout_add_seconds_local(RECHECK_BAD_SECS, {
            let this = self.clone();
            move || {
                let ok = luna_desktop::current_compat(&this.state)
                    == Some(luna_desktop::compat::Compat::Ok);
                waited.set(waited.get() + RECHECK_BAD_SECS);
                if !ok || waited.get() >= RECHECK_OK_SECS {
                    waited.set(0);
                    let state = this.state.clone();
                    spawn_blocking(move || luna_desktop::refresh_compat(&state), |_| {});
                }
                glib::ControlFlow::Continue
            }
        });

        #[cfg(windows)]
        {
            // Not at the very start: let the window and sign-in settle first.
            glib::timeout_add_seconds_local_once(15, {
                let this = self.clone();
                move || this.check_for_update()
            });
            glib::timeout_add_seconds_local(update::CHECK_EVERY.as_secs() as u32, {
                let this = self.clone();
                move || {
                    this.check_for_update();
                    glib::ControlFlow::Continue
                }
            });
        }
    }

    fn show_compat(&self) {
        let signed_in = self
            .state
            .session
            .lock()
            .map(|s| s.is_some())
            .unwrap_or(false);
        let message = if signed_in {
            luna_desktop::current_compat(&self.state).and_then(luna_desktop::compat::message)
        } else {
            None
        };
        match message {
            Some(text) => {
                self.compat_banner.set_title(text);
                self.compat_banner.set_revealed(true);
            }
            None => self.compat_banner.set_revealed(false),
        }
    }

    /// Check the feed in the background; on something newer, download it and
    /// only then say it is ready. Quiet when there is nothing to report: a
    /// failed background check is not worth interrupting anyone for.
    fn check_for_update(self: &Rc<Self>) {
        let this = self.clone();
        spawn_blocking(
            || -> Result<Option<(Available, PathBuf)>, String> {
                let Some(avail) = update::check_latest()? else {
                    return Ok(None);
                };
                Ok(Some((avail.clone(), update::download(&avail)?)))
            },
            move |result| match result {
                Ok(Some((avail, installer))) => this.offer(avail, installer),
                Ok(None) => {}
                Err(e) => eprintln!("luna-desktop: update check: {e}"),
            },
        );
    }

    fn offer(&self, avail: Available, installer: PathBuf) {
        if self.handled_version.borrow().as_deref() == Some(avail.version.as_str()) {
            return;
        }
        *self.handled_version.borrow_mut() = Some(avail.version.clone());
        self.update_banner.set_title(&format!(
            "Luna Desktop {} is ready to install.",
            avail.version
        ));
        self.update_banner.set_revealed(true);
        *self.ready.borrow_mut() = Some(Ready { avail, installer });
    }

    fn ask_to_install(self: &Rc<Self>) {
        let Some((version, notes)) = self
            .ready
            .borrow()
            .as_ref()
            .map(|r| (r.avail.version.clone(), r.avail.notes.trim().to_string()))
        else {
            return;
        };
        let closing = "Luna Desktop closes while it installs, then opens again. Backup and sync pause for a moment.";
        let body = if notes.is_empty() {
            closing.to_string()
        } else {
            format!("{notes}\n\n{closing}")
        };
        let dialog = adw::AlertDialog::new(
            Some(&format!("Install Luna Desktop {version}?")),
            Some(&body),
        );
        dialog.add_responses(&[("later", "Not now"), ("install", "Install")]);
        dialog.set_response_appearance("install", adw::ResponseAppearance::Suggested);
        dialog.set_default_response(Some("install"));
        dialog.set_close_response("later");
        dialog.connect_response(None, {
            let this = self.clone();
            move |_, response| {
                if response == "install" {
                    this.install();
                }
            }
        });
        dialog.present(Some(&self.root));
    }

    fn install(&self) {
        let Some(installer) = self.ready.borrow().as_ref().map(|r| r.installer.clone()) else {
            return;
        };
        luna_desktop::stop_all_jobs(&self.state);
        match update::run_installer(&installer) {
            Ok(()) => {
                if let Some(app) = gtk::gio::Application::default() {
                    app.quit();
                }
            }
            Err(e) => {
                toast_error(&self.toast, &e);
                // Backup and sync were paused for the install; bring them back.
                let state = self.state.clone();
                spawn_blocking(move || luna_desktop::start_all_jobs(&state), |_| {});
            }
        }
    }
}
