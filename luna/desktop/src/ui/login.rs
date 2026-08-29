use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use luna_desktop::AppState;

use super::spawn_blocking;
use super::toast_error;

pub struct LoginView {
    root: gtk::Widget,
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
            "Sign in to back up folders to Luna and keep folders in sync.",
        ));
        subtitle.set_wrap(true);
        subtitle.set_halign(gtk::Align::Start);
        subtitle.add_css_class("body");

        let group = adw::PreferencesGroup::new();

        let url_row = adw::EntryRow::builder().title("Luna address").build();
        url_row.set_text("http://127.0.0.1:8090");
        group.add(&url_row);

        let user_row = adw::EntryRow::builder().title("Username").build();
        group.add(&user_row);

        let pass_row = adw::PasswordEntryRow::builder().title("Password").build();
        group.add(&pass_row);

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
        sign_in.connect_clicked({
            let state = state.clone();
            let toast = toast.clone();
            let on_signed_in = on_signed_in.clone();
            let url_row = url_row.clone();
            let user_row = user_row.clone();
            let pass_row = pass_row.clone();
            let status = status.clone();
            let sign_in = sign_in.clone();
            let busy = busy.clone();
            move |_| {
                if busy.get() {
                    return;
                }
                busy.set(true);
                sign_in.set_sensitive(false);
                sign_in.set_label("Signing in…");
                status.set_visible(false);

                let base_url = url_row.text().to_string();
                let username = user_row.text().to_string();
                let password = pass_row.text().to_string();
                let state = state.clone();
                spawn_blocking(
                    move || -> Result<luna_desktop::SessionInfo, String> {
                        luna_desktop::login(&state, &base_url, &username, &password)
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
                                Ok(info) => on_signed_in(info),
                                Err(e) => {
                                    status.set_text(&e);
                                    status.set_visible(true);
                                    toast_error(&toast, &e);
                                }
                            }
                        }
                    },
                );
            }
        });

        // Enter in password submits.
        pass_row.connect_entry_activated({
            let sign_in = sign_in.clone();
            move |_| {
                sign_in.emit_clicked();
            }
        });

        Self {
            root: clamp.upcast(),
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}
