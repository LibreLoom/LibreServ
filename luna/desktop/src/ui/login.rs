use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use luna_desktop::AppState;

use super::spawn_blocking;
use super::toast_error;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn auto_login_enabled() -> bool {
    matches!(
        std::env::var("LUNA_DESKTOP_AUTO_LOGIN")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    )
}

pub struct LoginView {
    root: gtk::Widget,
    url_row: adw::EntryRow,
    token_row: adw::PasswordEntryRow,
}

impl LoginView {
    pub fn new(
        state: Arc<AppState>,
        toast: Rc<adw::ToastOverlay>,
        on_signed_in: Rc<dyn Fn(luna_desktop::SessionInfo)>,
    ) -> Self {
        let clamp = adw::Clamp::new();
        clamp.set_maximum_size(420);

        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 18);
        box_.set_valign(gtk::Align::Center);
        box_.set_margin_top(48);
        box_.set_margin_bottom(48);
        box_.set_margin_start(24);
        box_.set_margin_end(24);

        let title = gtk::Label::new(Some("Luna"));
        title.add_css_class("title-1");
        title.set_halign(gtk::Align::Start);

        let subtitle = gtk::Label::new(Some(
            "Sign in with an access token from Luna. Open Luna in a browser → Settings → Apps and access tokens → Create access token, then paste it here.",
        ));
        subtitle.set_wrap(true);
        subtitle.set_halign(gtk::Align::Start);
        subtitle.add_css_class("body");

        let group = adw::PreferencesGroup::new();

        let default_url = env_or("LUNA_DESKTOP_URL", "http://127.0.0.1:8090");
        let default_token = env_or("LUNA_DESKTOP_TOKEN", "");

        let url_row = adw::EntryRow::builder().title("Luna address").build();
        url_row.set_text(&default_url);
        group.add(&url_row);

        let token_row = adw::PasswordEntryRow::builder()
            .title("Access token")
            .build();
        if !default_token.is_empty() {
            token_row.set_text(&default_token);
        }
        group.add(&token_row);

        let sign_in = gtk::Button::builder()
            .label("Sign in")
            .halign(gtk::Align::End)
            .build();
        sign_in.add_css_class("suggested-action");
        sign_in.add_css_class("pill");

        let status = gtk::Label::new(None);
        status.set_wrap(true);
        status.set_halign(gtk::Align::Start);
        status.add_css_class("error");
        status.set_visible(false);

        box_.append(&title);
        box_.append(&subtitle);
        box_.append(&group);
        box_.append(&status);
        box_.append(&sign_in);
        clamp.set_child(Some(&box_));

        let busy = Rc::new(std::cell::Cell::new(false));

        let do_sign_in = {
            let state = state.clone();
            let toast = toast.clone();
            let on_signed_in = on_signed_in.clone();
            let url_row = url_row.clone();
            let token_row = token_row.clone();
            let status = status.clone();
            let sign_in = sign_in.clone();
            let busy = busy.clone();
            Rc::new(move || {
                if busy.get() {
                    return;
                }
                busy.set(true);
                sign_in.set_sensitive(false);
                sign_in.set_label("Signing in…");
                status.set_visible(false);

                let base_url = url_row.text().to_string();
                let access_token = token_row.text().to_string();
                let state = state.clone();
                spawn_blocking(
                    move || -> Result<luna_desktop::SessionInfo, String> {
                        luna_desktop::login(&state, &base_url, &access_token)
                    },
                    {
                        let toast = toast.clone();
                        let on_signed_in = on_signed_in.clone();
                        let status = status.clone();
                        let sign_in = sign_in.clone();
                        let busy = busy.clone();
                        move |result: Result<luna_desktop::SessionInfo, String>| {
                            busy.set(false);
                            sign_in.set_sensitive(true);
                            sign_in.set_label("Sign in");
                            match result {
                                Ok(info) => {
                                    let _ = luna_desktop::autostart::init_default();
                                    on_signed_in(info);
                                }
                                Err(e) => {
                                    status.set_text(&e);
                                    status.set_visible(true);
                                    toast_error(&toast, &e);
                                }
                            }
                        }
                    },
                );
            })
        };

        sign_in.connect_clicked({
            let do_sign_in = do_sign_in.clone();
            move |_| do_sign_in()
        });

        token_row.connect_entry_activated({
            let do_sign_in = do_sign_in.clone();
            move |_| do_sign_in()
        });

        // Dev loop: skip the form when a token was injected.
        if auto_login_enabled() && !default_token.is_empty() {
            do_sign_in();
        }

        Self {
            root: clamp.upcast(),
            url_row,
            token_row,
        }
    }

    /// Prefill Luna address and clear the access token (after auth failure).
    pub fn prepare_reconfigure(&self, base_url: &str) {
        self.url_row.set_text(base_url.trim());
        self.token_row.set_text("");
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}
