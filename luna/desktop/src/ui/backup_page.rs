use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::gio;
use gtk::glib;

use luna_desktop::AppState;
use luna_desktop::backup::BackupJob;

use super::adaptive::{configure_form_dialog, make_page_toolbar, touch_icon_button};
use super::folder_browser::FolderBrowser;
use super::spawn_blocking;
use super::toast_error;

pub struct BackupPage {
    root: gtk::Widget,
}

impl BackupPage {
    pub fn new(state: Arc<AppState>, toast: Rc<adw::ToastOverlay>) -> Self {
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);

        let blurb = gtk::Label::new(Some(
            "Copy folders from this computer onto Luna. One-way — changes on Luna do not come back.",
        ));
        blurb.set_wrap(true);
        blurb.set_halign(gtk::Align::Start);
        blurb.add_css_class("body");

        let new_btn = gtk::Button::with_label("New backup");
        new_btn.add_css_class("pill");
        new_btn.add_css_class("suggested-action");

        let toolbar = make_page_toolbar(&outer, &blurb, &new_btn);

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::None);
        list.add_css_class("boxed-list");
        list.set_margin_start(16);
        list.set_margin_end(16);
        list.set_margin_bottom(16);
        // Empty boxed-list still draws a border — looks like a thin divider.
        list.set_visible(false);

        let empty = gtk::Label::new(Some(
            "No backups yet. Create one to copy folders onto Luna.",
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
        let do_refresh = make_refresh(
            state.clone(),
            list.clone(),
            empty.clone(),
            toast.clone(),
            outer.clone(),
            refresh_slot.clone(),
        );
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
                    BackupJob {
                        id: String::new(),
                        name: String::new(),
                        sources: vec![],
                        drive_id: String::new(),
                        remote_path: String::new(),
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

fn make_refresh(
    state: Arc<AppState>,
    list: gtk::ListBox,
    empty: gtk::Label,
    toast: Rc<adw::ToastOverlay>,
    parent: gtk::Box,
    refresh_slot: Rc<RefCell<Option<Rc<dyn Fn()>>>>,
) -> Rc<dyn Fn()> {
    Rc::new(move || {
        let state = state.clone();
        let list = list.clone();
        let empty = empty.clone();
        let toast = toast.clone();
        let parent = parent.clone();
        let refresh_slot = refresh_slot.clone();
        let state_for_ui = state.clone();
        spawn_blocking(
            move || {
                let jobs = luna_desktop::backup::load_jobs();
                let progress = state
                    .backup_progress
                    .lock()
                    .map(|m| m.clone())
                    .unwrap_or_default();
                (jobs, progress)
            },
            move |(jobs, progress)| {
                while let Some(row) = list.row_at_index(0) {
                    list.remove(&row);
                }
                let refresh = refresh_slot
                    .borrow()
                    .clone()
                    .unwrap_or_else(|| Rc::new(|| {}));
                for job in jobs {
                    let p = progress.get(&job.id).cloned().unwrap_or_default();
                    let row = build_job_row(
                        state_for_ui.clone(),
                        toast.clone(),
                        &parent,
                        job,
                        &p,
                        refresh.clone(),
                    );
                    list.append(&row);
                }
                let is_empty = list.row_at_index(0).is_none();
                empty.set_visible(is_empty);
                list.set_visible(!is_empty);
            },
        );
    })
}

fn build_job_row(
    state: Arc<AppState>,
    toast: Rc<adw::ToastOverlay>,
    parent: &gtk::Box,
    job: BackupJob,
    progress: &luna_desktop::backup::BackupProgress,
    refresh: Rc<dyn Fn()>,
) -> adw::ActionRow {
    let title = if job.name.is_empty() {
        "Backup".to_string()
    } else {
        job.name.clone()
    };
    let n = job.sources.len();
    let subtitle = format!("{} folder{}", n, if n == 1 { "" } else { "s" });
    let row = adw::ActionRow::builder()
        .title(&title)
        .subtitle(&subtitle)
        .build();
    row.set_title_lines(1);
    row.set_subtitle_lines(1);

    let (icon_name, tip) = backup_status_icon(job.running || progress.running, progress);
    let icon = gtk::Image::from_icon_name(icon_name);
    icon.set_icon_size(gtk::IconSize::Normal);
    icon.set_tooltip_text(Some(tip.as_str()));
    row.add_prefix(&icon);

    let edit = touch_icon_button("document-edit-symbolic", "Edit");
    edit.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        let parent = parent.clone();
        let job = job.clone();
        move |_| {
            open_editor(
                &parent,
                state.clone(),
                toast.clone(),
                job.clone(),
                refresh.clone(),
            );
        }
    });
    row.add_suffix(&edit);

    let delete = touch_icon_button("user-trash-symbolic", "Delete");
    let id = job.id.clone();
    delete.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        move |_| {
            let state = state.clone();
            let id = id.clone();
            spawn_blocking(move || luna_desktop::delete_backup_job(&state, &id), {
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

fn backup_status_icon(
    active: bool,
    progress: &luna_desktop::backup::BackupProgress,
) -> (&'static str, String) {
    if !progress.error.is_empty() {
        return ("dialog-warning-symbolic", plain_error(&progress.error));
    }
    if progress.running && (!progress.current.is_empty() || progress.bytes > 0) {
        return (
            "emblem-synchronizing-symbolic",
            "Copying files to Luna…".to_string(),
        );
    }
    if active || progress.running {
        return (
            "emblem-ok-symbolic",
            "This folder is being correctly backed up.".to_string(),
        );
    }
    ("content-loading-symbolic", "Waiting to start…".to_string())
}

fn plain_error(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "Something went wrong with this backup. Try editing it and saving again.".into();
    }
    // Prefer already-plain messages from the backend; soften a few raw leftovers.
    if t == "unauthorized" {
        return "Your sign-in expired. Sign out and sign in again.".into();
    }
    if t.contains("connection") || t.contains("timed out") || t.contains("Connection") {
        return "Couldn't reach Luna. Check that it's on and try again.".into();
    }
    t.to_string()
}

fn open_editor(
    parent: &impl IsA<gtk::Widget>,
    state: Arc<AppState>,
    _window_toast: Rc<adw::ToastOverlay>,
    job: BackupJob,
    refresh: Rc<dyn Fn()>,
) {
    let dialog = adw::Dialog::new();
    dialog.set_title(if job.id.is_empty() {
        "New backup"
    } else {
        "Edit backup"
    });
    configure_form_dialog(&dialog, parent, true);

    // ToastOverlay must live inside the dialog so errors appear above it, not behind.
    let toast = Rc::new(adw::ToastOverlay::new());

    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&adw::HeaderBar::new());

    let page = gtk::Box::new(gtk::Orientation::Vertical, 14);
    page.set_margin_top(12);
    page.set_margin_bottom(16);
    page.set_margin_start(16);
    page.set_margin_end(16);

    let name_group = adw::PreferencesGroup::new();
    let name = adw::EntryRow::builder().title("Name").build();
    name.set_text(&job.name);
    name_group.add(&name);
    page.append(&name_group);

    let sources: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(job.sources.clone()));
    let sources_list = gtk::ListBox::new();
    sources_list.add_css_class("boxed-list");
    sources_list.set_selection_mode(gtk::SelectionMode::None);

    let redraw = {
        let sources = sources.clone();
        let sources_list = sources_list.clone();
        Rc::new(move || {
            while let Some(row) = sources_list.row_at_index(0) {
                sources_list.remove(&row);
            }
            let snapshot = sources.borrow().clone();
            sources_list.set_visible(!snapshot.is_empty());
            for (i, s) in snapshot.iter().enumerate() {
                let row = adw::ActionRow::builder().title(s).build();
                row.set_title_lines(1);
                let rm = touch_icon_button("list-remove-symbolic", "Remove");
                rm.connect_clicked({
                    let sources = sources.clone();
                    let redraw_list = sources_list.clone();
                    move |_| {
                        if i < sources.borrow().len() {
                            sources.borrow_mut().remove(i);
                        }
                        while let Some(r) = redraw_list.row_at_index(0) {
                            redraw_list.remove(&r);
                        }
                        let snap = sources.borrow().clone();
                        redraw_list.set_visible(!snap.is_empty());
                        for (j, path) in snap.iter().enumerate() {
                            let r = adw::ActionRow::builder().title(path).build();
                            r.set_title_lines(1);
                            let btn = touch_icon_button("list-remove-symbolic", "Remove");
                            btn.connect_clicked({
                                let sources = sources.clone();
                                let redraw_list = redraw_list.clone();
                                move |_| {
                                    if j < sources.borrow().len() {
                                        sources.borrow_mut().remove(j);
                                    }
                                    while let Some(x) = redraw_list.row_at_index(0) {
                                        redraw_list.remove(&x);
                                    }
                                    let snap2 = sources.borrow().clone();
                                    redraw_list.set_visible(!snap2.is_empty());
                                    for p in snap2.iter() {
                                        let row = adw::ActionRow::builder().title(p).build();
                                        row.set_title_lines(1);
                                        redraw_list.append(&row);
                                    }
                                }
                            });
                            r.add_suffix(&btn);
                            redraw_list.append(&r);
                        }
                    }
                });
                row.add_suffix(&rm);
                sources_list.append(&row);
            }
        })
    };
    redraw();

    let add = gtk::Button::with_label("Add folder…");
    add.add_css_class("pill");
    add.connect_clicked({
        let sources = sources.clone();
        let redraw = redraw.clone();
        let parent_w = parent.clone().upcast::<gtk::Widget>();
        move |_| {
            let dialog = gtk::FileDialog::builder()
                .title("Choose a folder to back up")
                .build();
            let window = parent_w.root().and_downcast::<gtk::Window>();
            let sources = sources.clone();
            let redraw = redraw.clone();
            dialog.select_folder(window.as_ref(), gio::Cancellable::NONE, move |res| {
                if let Ok(file) = res {
                    if let Some(path) = file.path() {
                        let p = path.to_string_lossy().into_owned();
                        let mut s = sources.borrow_mut();
                        if !s.contains(&p) {
                            s.push(p);
                        }
                        drop(s);
                        redraw();
                    }
                }
            });
        }
    });

    let src_label = gtk::Label::new(Some("Folders to back up"));
    src_label.set_halign(gtk::Align::Start);
    src_label.add_css_class("heading");
    page.append(&src_label);
    page.append(&sources_list);
    page.append(&add);

    let dest_label = gtk::Label::new(Some("Select where this backup is stored on Luna"));
    dest_label.set_halign(gtk::Align::Start);
    dest_label.set_wrap(true);
    dest_label.add_css_class("heading");
    page.append(&dest_label);

    let drive_id = Rc::new(RefCell::new(job.drive_id.clone()));
    let remote_path = Rc::new(RefCell::new(job.remote_path.clone()));
    let browser = FolderBrowser::new(
        state.clone(),
        toast.clone(),
        drive_id.clone(),
        remote_path.clone(),
    );
    page.append(browser.root());

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
    toast.set_child(Some(&toolbar));
    dialog.set_child(Some(toast.as_ref()));

    let job_id = job.id.clone();
    save.connect_clicked({
        let state = state.clone();
        let toast = toast.clone();
        let refresh = refresh.clone();
        let dialog = dialog.clone();
        let name = name.clone();
        let sources = sources.clone();
        let drive_id = drive_id.clone();
        let remote_path = remote_path.clone();
        move |_| {
            let draft = BackupJob {
                id: job_id.clone(),
                name: name.text().to_string(),
                sources: sources.borrow().clone(),
                drive_id: drive_id.borrow().clone(),
                remote_path: remote_path.borrow().clone(),
                running: true,
            };
            let state = state.clone();
            spawn_blocking(
                move || {
                    let saved = luna_desktop::save_backup_job(&state, draft)?;
                    luna_desktop::start_backup_job(&state, &saved.id)?;
                    Ok::<_, String>(saved)
                },
                {
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
                },
            );
        }
    });

    dialog.present(Some(parent));
}
