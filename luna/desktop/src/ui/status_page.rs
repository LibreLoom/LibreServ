//! Status page: files still being copied or synced, with progress.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;

use luna_desktop::AppState;

use super::spawn_blocking;

pub struct StatusPage {
    root: gtk::Widget,
}

impl StatusPage {
    pub fn new(state: Arc<AppState>) -> Self {
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);

        let blurb = gtk::Label::new(Some(
            "Files still being copied between this computer and Luna.",
        ));
        blurb.set_wrap(true);
        blurb.set_halign(gtk::Align::Start);
        blurb.set_margin_top(12);
        blurb.set_margin_bottom(8);
        blurb.set_margin_start(16);
        blurb.set_margin_end(16);
        blurb.add_css_class("body");

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::None);
        list.add_css_class("boxed-list");
        list.set_margin_start(16);
        list.set_margin_end(16);
        list.set_margin_bottom(16);
        list.set_visible(false);

        let empty = adw::StatusPage::builder()
            .icon_name("emblem-ok-symbolic")
            .title("Everything is up to date.")
            .description("Nothing is waiting to copy right now.")
            .build();
        empty.set_vexpand(true);

        let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
        content.append(&list);
        content.append(&empty);

        let scrolled = gtk::ScrolledWindow::builder()
            .child(&content)
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .build();
        outer.append(&blurb);
        outer.append(&scrolled);

        let do_refresh = {
            let state = state.clone();
            let list = list.clone();
            let empty = empty.clone();
            Rc::new(move || {
                let state = state.clone();
                let list = list.clone();
                let empty = empty.clone();
                spawn_blocking(
                    move || {
                        let backups = state
                            .backup_progress
                            .lock()
                            .map(|m| m.clone())
                            .unwrap_or_default();
                        let syncs = state
                            .sync_progress
                            .lock()
                            .map(|m| m.clone())
                            .unwrap_or_default();
                        let jobs = luna_desktop::backup::load_jobs();
                        let pairs = luna_desktop::sync::load_pairs();
                        (backups, syncs, jobs, pairs)
                    },
                    move |(backups, syncs, jobs, pairs)| {
                        while let Some(row) = list.row_at_index(0) {
                            list.remove(&row);
                        }
                        let mut any = false;

                        for job in &jobs {
                            let Some(p) = backups.get(&job.id) else {
                                continue;
                            };
                            // In progress: running and (current file or bytes moving).
                            if !p.running || (p.current.is_empty() && p.bytes == 0) {
                                continue;
                            }
                            any = true;
                            let name = if job.name.is_empty() {
                                "Backup"
                            } else {
                                job.name.as_str()
                            };
                            let file = if p.current.is_empty() {
                                "Copying files…".to_string()
                            } else {
                                short_name(&p.current)
                            };
                            let row = adw::ActionRow::builder()
                                .title(name)
                                .subtitle(&file)
                                .build();
                            row.set_title_lines(1);
                            row.set_subtitle_lines(1);
                            let bar = gtk::ProgressBar::new();
                            bar.set_valign(gtk::Align::Center);
                            bar.set_width_request(120);
                            bar.pulse();
                            bar.set_tooltip_text(Some("Copying files to Luna…"));
                            row.add_suffix(&bar);
                            let icon = gtk::Image::from_icon_name("emblem-synchronizing-symbolic");
                            icon.set_icon_size(gtk::IconSize::Normal);
                            row.add_prefix(&icon);
                            list.append(&row);
                        }

                        for pair in &pairs {
                            let Some(p) = syncs.get(&pair.id) else {
                                continue;
                            };
                            if !p.running || p.current.is_empty() {
                                continue;
                            }
                            any = true;
                            let name = leaf(&pair.remote_path);
                            let row = adw::ActionRow::builder()
                                .title(name)
                                .subtitle(&short_name(&p.current))
                                .build();
                            row.set_title_lines(1);
                            row.set_subtitle_lines(1);
                            let bar = gtk::ProgressBar::new();
                            bar.set_valign(gtk::Align::Center);
                            bar.set_width_request(120);
                            bar.pulse();
                            bar.set_tooltip_text(Some("Updating files…"));
                            row.add_suffix(&bar);
                            let icon = gtk::Image::from_icon_name("emblem-synchronizing-symbolic");
                            icon.set_icon_size(gtk::IconSize::Normal);
                            row.add_prefix(&icon);
                            list.append(&row);
                        }

                        empty.set_visible(!any);
                        list.set_visible(any);
                    },
                );
            })
        };
        do_refresh();

        glib::timeout_add_local(std::time::Duration::from_secs(1), {
            let do_refresh = do_refresh.clone();
            move || {
                do_refresh();
                glib::ControlFlow::Continue
            }
        });

        Self {
            root: outer.upcast(),
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}

fn leaf(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("Sync")
}

fn short_name(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if name.len() > 48 {
        format!("{}…", &name[..45])
    } else {
        name.to_string()
    }
}
