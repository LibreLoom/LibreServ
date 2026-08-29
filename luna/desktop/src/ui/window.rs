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

/// Adwaita navigation-sidebar row: symbolic icon + title.
fn nav_row(title: &str, icon_name: &str) -> adw::ActionRow {
    let row = adw::ActionRow::builder()
        .title(title)
        .activatable(true)
        .build();
    let icon = gtk::Image::from_icon_name(icon_name);
    icon.set_icon_size(gtk::IconSize::Normal);
    row.add_prefix(&icon);
    row
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
        sidebar_header.set_title_widget(Some(&adw::WindowTitle::new("Luna", "")));
        sidebar_header.add_css_class("flat");

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        list.set_css_classes(&["navigation-sidebar"]);
        list.set_vexpand(true);

        let row_backup = nav_row("Backup", "folder-download-symbolic");
        let row_sync = nav_row("Sync", "emblem-synchronizing-symbolic");
        let row_settings = nav_row("Settings", "preferences-system-symbolic");
        list.append(&row_backup);
        list.append(&row_sync);
        list.append(&row_settings);
        list.select_row(Some(&row_backup));

        let list_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .vexpand(true)
            .child(&list)
            .build();

        let footer = gtk::Box::new(gtk::Orientation::Vertical, 6);
        footer.set_margin_top(6);
        footer.set_margin_bottom(12);
        footer.set_margin_start(12);
        footer.set_margin_end(12);

        let user_lbl = gtk::Label::new(Some(&username));
        user_lbl.set_halign(gtk::Align::Start);
        user_lbl.set_ellipsize(gtk::pango::EllipsizeMode::End);
        user_lbl.add_css_class("heading");

        let sign_out_content = adw::ButtonContent::builder()
            .icon_name("system-log-out-symbolic")
            .label("Sign out")
            .build();
        let sign_out = gtk::Button::new();
        sign_out.set_child(Some(&sign_out_content));
        sign_out.add_css_class("flat");
        sign_out.set_halign(gtk::Align::Start);

        footer.append(&user_lbl);
        footer.append(&sign_out);

        let sidebar_inner = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sidebar_inner.set_vexpand(true);
        sidebar_inner.append(&list_scroll);
        sidebar_inner.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        sidebar_inner.append(&footer);

        let sidebar_toolbar = adw::ToolbarView::new();
        sidebar_toolbar.add_top_bar(&sidebar_header);
        // Sidebar windows should stay Flat — no persistent under-header line.
        sidebar_toolbar.set_top_bar_style(adw::ToolbarStyle::Flat);
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
        content_header.add_css_class("flat");
        let window_title = adw::WindowTitle::new("Backup", "");
        content_header.set_title_widget(Some(&window_title));

        let content_toolbar = adw::ToolbarView::new();
        content_toolbar.add_top_bar(&content_header);
        // Flat: no persistent raised separator under the header above page content.
        content_toolbar.set_top_bar_style(adw::ToolbarStyle::Flat);
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
            let window_title = window_title.clone();
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
                window_title.set_title(label);
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
