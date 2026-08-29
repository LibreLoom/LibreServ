use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;

use luna_desktop::{AppState, SessionInfo};

use super::backup_page::BackupPage;
use super::settings_page::SettingsPage;
use super::spawn_blocking;
use super::sync_page::SyncPage;
use super::toast_error;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Backup,
    Sync,
    Settings,
}

pub struct ShellView {
    root: gtk::Widget,
    username: String,
}

impl ShellView {
    pub fn new(
        state: Arc<AppState>,
        info: SessionInfo,
        toast: Rc<adw::ToastOverlay>,
        on_signed_out: Rc<dyn Fn()>,
    ) -> Self {
        let username = info.username.clone();

        let split = adw::NavigationSplitView::new();
        split.set_min_sidebar_width(200.0);
        split.set_max_sidebar_width(280.0);

        // --- Sidebar ---
        let sidebar_header = adw::HeaderBar::new();
        sidebar_header.set_title_widget(Some(&gtk::Label::new(Some("Luna"))));
        sidebar_header.add_css_class("flat");

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        list.add_css_class("navigation-sidebar");

        let row_backup = adw::ActionRow::builder()
            .title("Backup")
            .activatable(true)
            .build();
        let row_sync = adw::ActionRow::builder()
            .title("Sync")
            .activatable(true)
            .build();
        let row_settings = adw::ActionRow::builder()
            .title("Settings")
            .activatable(true)
            .build();
        list.append(&row_backup);
        list.append(&row_sync);
        list.append(&row_settings);
        list.select_row(Some(&row_backup));

        let footer = gtk::Box::new(gtk::Orientation::Vertical, 6);
        footer.set_margin_top(12);
        footer.set_margin_bottom(12);
        footer.set_margin_start(12);
        footer.set_margin_end(12);
        let user_lbl = gtk::Label::new(Some(&username));
        user_lbl.set_halign(gtk::Align::Start);
        user_lbl.add_css_class("caption");
        let sign_out = gtk::Button::with_label("Sign out");
        sign_out.add_css_class("flat");
        sign_out.set_halign(gtk::Align::Start);
        footer.append(&user_lbl);
        footer.append(&sign_out);

        let sidebar_inner = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sidebar_inner.set_vexpand(true);
        sidebar_inner.append(&list);
        let spacer = gtk::Box::new(gtk::Orientation::Vertical, 0);
        spacer.set_vexpand(true);
        sidebar_inner.append(&spacer);
        sidebar_inner.append(&footer);

        let sidebar_toolbar = adw::ToolbarView::new();
        sidebar_toolbar.add_top_bar(&sidebar_header);
        sidebar_toolbar.set_content(Some(&sidebar_inner));

        let sidebar_page = adw::NavigationPage::builder()
            .title("Luna")
            .child(&sidebar_toolbar)
            .build();

        // --- Content stack ---
        let content_stack = gtk::Stack::new();
        content_stack.set_transition_type(gtk::StackTransitionType::Crossfade);

        let backup = BackupPage::new(state.clone(), toast.clone());
        let sync = SyncPage::new(state.clone(), toast.clone());
        let settings = SettingsPage::new(toast.clone());

        content_stack.add_named(backup.root(), Some("backup"));
        content_stack.add_named(sync.root(), Some("sync"));
        content_stack.add_named(settings.root(), Some("settings"));
        content_stack.set_visible_child_name("backup");

        let content_header = adw::HeaderBar::new();
        let title = Rc::new(RefCell::new({
            let l = gtk::Label::new(Some("Backup"));
            l.add_css_class("title");
            l
        }));
        content_header.set_title_widget(Some(&*title.borrow()));

        let content_toolbar = adw::ToolbarView::new();
        content_toolbar.add_top_bar(&content_header);
        content_toolbar.set_content(Some(&content_stack));

        let content_page = adw::NavigationPage::builder()
            .title("Backup")
            .child(&content_toolbar)
            .build();

        split.set_sidebar(Some(&sidebar_page));
        split.set_content(Some(&content_page));

        let page_state = Rc::new(RefCell::new(Page::Backup));
        list.connect_row_activated({
            let content_stack = content_stack.clone();
            let content_page = content_page.clone();
            let title = title.clone();
            let page_state = page_state.clone();
            let row_backup = row_backup.clone();
            let row_sync = row_sync.clone();
            let row_settings = row_settings.clone();
            move |_, row| {
                let (name, label, page) = if row == row_backup.upcast_ref::<gtk::ListBoxRow>() {
                    ("backup", "Backup", Page::Backup)
                } else if row == row_sync.upcast_ref::<gtk::ListBoxRow>() {
                    ("sync", "Sync", Page::Sync)
                } else if row == row_settings.upcast_ref::<gtk::ListBoxRow>() {
                    ("settings", "Settings", Page::Settings)
                } else {
                    return;
                };
                *page_state.borrow_mut() = page;
                content_stack.set_visible_child_name(name);
                title.borrow().set_text(label);
                content_page.set_title(label);
            }
        });

        sign_out.connect_clicked({
            let state = state.clone();
            let toast = toast.clone();
            let on_signed_out = on_signed_out.clone();
            move |_| {
                let state = state.clone();
                let toast = toast.clone();
                let on_signed_out = on_signed_out.clone();
                spawn_blocking(
                    move || luna_desktop::logout(&state),
                    move |result| {
                        if let Err(e) = result {
                            toast_error(&toast, e);
                        }
                        on_signed_out();
                    },
                );
            }
        });

        Self {
            root: split.upcast(),
            username,
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }

    pub fn username(&self) -> &str {
        &self.username
    }
}
