use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::gio;
use gtk::glib;

use luna_desktop::AppState;
use luna_desktop::sync::SyncPair;

use super::folder_browser::FolderBrowser;
use super::spawn_blocking;
use super::toast_error;

pub struct SyncPage {
    root: gtk::Widget,
}

impl SyncPage {
    pub fn new(state: Arc<AppState>, toast: Rc<adw::ToastOverlay>) -> Self {
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);

        let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        toolbar.set_margin_top(12);
        toolbar.set_margin_bottom(8);
        toolbar.set_margin_start(16);
        toolbar.set_margin_end(16);

        let blurb = gtk::Label::new(Some(
            "Keep a Luna folder and a folder on this computer up to date with each other. Changes go both ways.",
        ));
        blurb.set_wrap(true);
        blurb.set_halign(gtk::Align::Start);
        blurb.set_hexpand(true);
        blurb.add_css_class("body");

        let new_btn = gtk::Button::with_label("New sync");
        new_btn.add_css_class("pill");
        new_btn.add_css_class("suggested-action");
        toolbar.append(&blurb);
        toolbar.append(&new_btn);

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::None);
        list.add_css_class("boxed-list");
        list.set_margin_start(16);
        list.set_margin_end(16);
        list.set_margin_bottom(16);
        // Empty boxed-list still draws a border — looks like a thin divider.
        list.set_visible(false);

        let empty = gtk::Label::new(Some(
            "No syncs yet. Choose a Luna folder and a place for it on this computer.",
        ));
        empty.add_css_class("dim-label");
        empty.set_margin_top(24);

        let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
        content.append(&list);
        content.append(&empty);

        let scrolled = gtk::ScrolledWindow::builder()
            .child(&content)
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .build();
        outer.append(&toolbar);
        outer.append(&scrolled);

        let refresh_slot: Rc<RefCell<Option<Rc<dyn Fn()>>>> = Rc::new(RefCell::new(None));
        let do_refresh = {
            let state = state.clone();
            let list = list.clone();
            let empty = empty.clone();
            let toast = toast.clone();
            let refresh_slot = refresh_slot.clone();
            Rc::new(move || {
                let state = state.clone();
                let list = list.clone();
                let empty = empty.clone();
                let toast = toast.clone();
                let refresh_slot = refresh_slot.clone();
                let state_for_ui = state.clone();
                spawn_blocking(
                    move || {
                        let pairs = luna_desktop::sync::load_pairs();
                        let progress = state
                            .sync_progress
                            .lock()
                            .map(|m| m.clone())
                            .unwrap_or_default();
                        (pairs, progress)
                    },
                    move |(pairs, progress)| {
                        while let Some(row) = list.row_at_index(0) {
                            list.remove(&row);
                        }
                        let is_empty = pairs.is_empty();
                        empty.set_visible(is_empty);
                        list.set_visible(!is_empty);
                        let refresh = refresh_slot
                            .borrow()
                            .clone()
                            .unwrap_or_else(|| Rc::new(|| {}));
                        for pair in pairs {
                            let p = progress.get(&pair.id).cloned().unwrap_or_default();
                            list.append(&build_row(
                                state_for_ui.clone(),
                                toast.clone(),
                                pair,
                                &p,
                                refresh.clone(),
                            ));
                        }
                    },
                );
            }) as Rc<dyn Fn()>
        };
        *refresh_slot.borrow_mut() = Some(do_refresh.clone());
        do_refresh();

        glib::timeout_add_local(std::time::Duration::from_secs(2), {
            let do_refresh = do_refresh.clone();
            move || {
                do_refresh();
                glib::ControlFlow::Continue
            }
        });

        new_btn.connect_clicked({
            let state = state.clone();
            let toast = toast.clone();
            let refresh = do_refresh.clone();
            let outer = outer.clone();
            move |_| {
                open_editor(
                    &outer,
                    state.clone(),
                    toast.clone(),
                    SyncPair {
                        id: String::new(),
                        drive_id: String::new(),
                        remote_path: String::new(),
                        local_parent: String::new(),
                        local_path: String::new(),
                        running: false,
                    },
                    refresh.clone(),
                );
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

fn build_row(
    state: Arc<AppState>,
    toast: Rc<adw::ToastOverlay>,
    pair: SyncPair,
    progress: &luna_desktop::sync::SyncProgress,
    refresh: Rc<dyn Fn()>,
) -> adw::ActionRow {
    let title = if pair.remote_path.is_empty() {
        "Sync".to_string()
    } else {
        pair.remote_path.clone()
    };
    let subtitle = format!(
        "Luna {}/{}\nThis computer: {}",
        pair.drive_id, pair.remote_path, pair.local_path
    );
    let row = adw::ActionRow::builder()
        .title(&title)
        .subtitle(&subtitle)
        .build();

    let mut status = if pair.running || progress.running {
        if progress.phase.is_empty() {
            "Running".to_string()
        } else {
            progress.phase.clone()
        }
    } else {
        "Paused".to_string()
    };
    if progress.uploaded > 0 {
        status.push_str(&format!(" · {} uploaded", progress.uploaded));
    }
    if progress.downloaded > 0 {
        status.push_str(&format!(" · {} downloaded", progress.downloaded));
    }
    if progress.conflicts > 0 {
        status.push_str(&format!(" · {} conflicts", progress.conflicts));
    }
    if !progress.error.is_empty() {
        status.push_str(&format!(" · {}", progress.error));
    }
    let status_lbl = gtk::Label::new(Some(&status));
    status_lbl.add_css_class("caption");
    row.add_suffix(&status_lbl);

    let toggle = gtk::Button::with_label(if pair.running { "Pause" } else { "Start" });
    toggle.add_css_class("flat");
    let id = pair.id.clone();
    let running = pair.running;
    toggle.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        move |_| {
            let state = state.clone();
            let id = id.clone();
            spawn_blocking(
                move || {
                    if running {
                        luna_desktop::stop_sync_pair(&state, &id)
                    } else {
                        luna_desktop::start_sync_pair(&state, &id)
                    }
                },
                {
                    let toast = toast.clone();
                    let refresh = refresh.clone();
                    move |r| {
                        if let Err(e) = r {
                            toast_error(&toast, e);
                        }
                        refresh();
                    }
                },
            );
        }
    });
    row.add_suffix(&toggle);

    let delete = gtk::Button::from_icon_name("user-trash-symbolic");
    delete.add_css_class("flat");
    let id = pair.id.clone();
    delete.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        move |_| {
            let state = state.clone();
            let id = id.clone();
            spawn_blocking(move || luna_desktop::delete_sync_pair(&state, &id), {
                let toast = toast.clone();
                let refresh = refresh.clone();
                move |r| {
                    if let Err(e) = r {
                        toast_error(&toast, e);
                    }
                    refresh();
                }
            });
        }
    });
    row.add_suffix(&delete);
    row
}

fn open_editor(
    parent: &impl IsA<gtk::Widget>,
    state: Arc<AppState>,
    toast: Rc<adw::ToastOverlay>,
    pair: SyncPair,
    refresh: Rc<dyn Fn()>,
) {
    let dialog = adw::Dialog::new();
    dialog.set_title(if pair.id.is_empty() {
        "New sync"
    } else {
        "Edit sync"
    });
    dialog.set_content_width(520);
    dialog.set_content_height(560);

    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&adw::HeaderBar::new());

    let page = gtk::Box::new(gtk::Orientation::Vertical, 14);
    page.set_margin_top(12);
    page.set_margin_bottom(16);
    page.set_margin_start(16);
    page.set_margin_end(16);

    let dest_label = gtk::Label::new(Some("Select where this sync is stored on Luna"));
    dest_label.set_halign(gtk::Align::Start);
    dest_label.set_wrap(true);
    dest_label.add_css_class("heading");
    page.append(&dest_label);

    let drive_id = Rc::new(RefCell::new(pair.drive_id.clone()));
    let remote_path = Rc::new(RefCell::new(pair.remote_path.clone()));
    let browser = FolderBrowser::new(
        state.clone(),
        toast.clone(),
        drive_id.clone(),
        remote_path.clone(),
    );
    page.append(browser.root());

    let parent_label = gtk::Label::new(Some(
        "Folder on this computer (the synced folder will be created inside it)",
    ));
    parent_label.set_wrap(true);
    parent_label.set_halign(gtk::Align::Start);
    parent_label.add_css_class("heading");
    page.append(&parent_label);

    let local_parent = Rc::new(RefCell::new(pair.local_parent.clone()));
    let parent_row = adw::ActionRow::builder()
        .title("Parent folder")
        .subtitle(if pair.local_parent.is_empty() {
            "Not chosen yet"
        } else {
            &pair.local_parent
        })
        .build();
    let browse = gtk::Button::with_label("Browse…");
    browse.add_css_class("flat");
    browse.connect_clicked({
        let local_parent = local_parent.clone();
        let parent_row = parent_row.clone();
        let parent_w = parent.clone().upcast::<gtk::Widget>();
        move |_| {
            let dialog = gtk::FileDialog::builder()
                .title("Choose where the synced folder should live")
                .build();
            let window = parent_w.root().and_downcast::<gtk::Window>();
            let local_parent = local_parent.clone();
            let parent_row = parent_row.clone();
            dialog.select_folder(window.as_ref(), gio::Cancellable::NONE, move |res| {
                if let Ok(file) = res {
                    if let Some(path) = file.path() {
                        let p = path.to_string_lossy().into_owned();
                        *local_parent.borrow_mut() = p.clone();
                        parent_row.set_subtitle(&p);
                    }
                }
            });
        }
    });
    parent_row.add_suffix(&browse);
    let parent_list = gtk::ListBox::new();
    parent_list.add_css_class("boxed-list");
    parent_list.append(&parent_row);
    page.append(&parent_list);

    let save = gtk::Button::with_label("Save");
    save.add_css_class("suggested-action");
    save.add_css_class("pill");
    save.set_halign(gtk::Align::End);
    page.append(&save);

    let scrolled = gtk::ScrolledWindow::builder()
        .child(&page)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .build();
    toolbar.set_content(Some(&scrolled));
    dialog.set_child(Some(&toolbar));

    let pair_id = pair.id.clone();
    save.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        let dialog = dialog.clone();
        let drive_id = drive_id.clone();
        let remote_path = remote_path.clone();
        let local_parent = local_parent.clone();
        move |_| {
            let draft = SyncPair {
                id: pair_id.clone(),
                drive_id: drive_id.borrow().clone(),
                remote_path: remote_path.borrow().clone(),
                local_parent: local_parent.borrow().clone(),
                local_path: String::new(),
                running: false,
            };
            let state = state.clone();
            spawn_blocking(move || luna_desktop::save_sync_pair(&state, draft), {
                let toast = toast.clone();
                let refresh = refresh.clone();
                let dialog = dialog.clone();
                move |r| match r {
                    Ok(_) => {
                        dialog.close();
                        refresh();
                    }
                    Err(e) => toast_error(&toast, e),
                }
            });
        }
    });

    dialog.present(Some(parent));
}
