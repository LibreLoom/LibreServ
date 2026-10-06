use std::rc::Rc;

use adw::prelude::*;

use luna_desktop::autostart;
use luna_desktop::update;

use super::toast_error;

pub struct SettingsPage {
    root: gtk::Widget,
}

impl SettingsPage {
    pub fn new(toast: Rc<adw::ToastOverlay>) -> Self {
        let page = adw::PreferencesPage::new();
        page.set_title("Settings");

        let group = adw::PreferencesGroup::new();
        group.set_title("This computer");
        group.set_description(Some(&format!(
            "Choose whether {} starts when you sign in to this computer. It runs in the background so backup and sync can keep going.",
            luna_desktop::product_name()
        )));

        let row = adw::SwitchRow::builder()
            .title("Start on boot")
            .subtitle("Start in the background after you sign in")
            .build();
        let _ = autostart::init_default();
        row.set_active(autostart::is_enabled());

        row.connect_active_notify({
            let toast = toast.clone();
            let row = row.clone();
            move |r| {
                let enabled = r.is_active();
                if let Err(e) = autostart::set_enabled(enabled) {
                    // Revert toggle on failure.
                    row.set_active(!enabled);
                    toast_error(&toast, e);
                }
            }
        });

        group.add(&row);
        page.add(&group);

        // Linux updates come from the software center; only Windows updates itself.
        if cfg!(windows) {
            page.add(&update_group(&toast));
        }

        // Hint about data location
        let data_group = adw::PreferencesGroup::new();
        data_group.set_title("Saved data");
        let data_row = adw::ActionRow::builder()
            .title("Settings folder")
            .subtitle(luna_desktop::session::data_dir().to_string_lossy().as_ref())
            .build();
        data_group.add(&data_row);
        page.add(&data_group);

        let quit_group = adw::PreferencesGroup::new();
        quit_group.set_title("Quit");
        quit_group.set_description(Some(
            "Closing the window keeps Luna running in the background so backup and sync can continue. Reopen Luna from your app launcher. Use Quit only when you want backup and sync to stop.",
        ));
        let quit_row = adw::ActionRow::builder()
            .title(&format!("Quit {}", luna_desktop::product_name()))
            .activatable(true)
            .build();
        quit_row.connect_activated(|_| {
            if let Some(app) = gtk::gio::Application::default() {
                app.quit();
            }
        });
        quit_group.add(&quit_row);
        page.add(&quit_group);

        let scrolled = gtk::ScrolledWindow::builder()
            .child(&page)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .build();

        Self {
            root: scrolled.upcast(),
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}

/// Which kind of Luna Desktop updates this computer gets.
fn update_group(toast: &Rc<adw::ToastOverlay>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    group.set_title("Updates");
    let row = adw::ComboRow::builder()
        .title("Update channel")
        .subtitle(
            "Beta gets new versions sooner and may have rough edges. Applies at the next check.",
        )
        .model(&gtk::StringList::new(&["Stable", "Beta"]))
        .build();
    row.set_selected(match update::load().channel {
        update::Channel::Stable => 0,
        update::Channel::Beta => 1,
    });
    row.connect_selected_notify({
        let toast = toast.clone();
        move |r| {
            let channel = if r.selected() == 1 {
                update::Channel::Beta
            } else {
                update::Channel::Stable
            };
            if let Err(e) = update::set_channel(channel) {
                toast_error(&toast, format!("Couldn't save the update channel. {e}"));
            }
        }
    });
    group.add(&row);
    group
}
