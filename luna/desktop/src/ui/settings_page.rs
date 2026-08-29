use std::rc::Rc;

use adw::prelude::*;

use luna_desktop::autostart;

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
        group.set_description(Some(
            "Choose whether Luna Desktop starts when you sign in to this computer. It runs in the background so backup and sync can keep going.",
        ));

        let row = adw::SwitchRow::builder()
            .title("Start on boot")
            .subtitle("Start in the background after you sign in")
            .build();
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

        // Hint about data location
        let data_group = adw::PreferencesGroup::new();
        data_group.set_title("Saved data");
        let data_row = adw::ActionRow::builder()
            .title("Settings folder")
            .subtitle(luna_desktop::session::data_dir().to_string_lossy().as_ref())
            .build();
        data_group.add(&data_row);
        page.add(&data_group);

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
