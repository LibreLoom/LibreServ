use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::gio;
use gtk::glib;

use luna_desktop::AppState;
use luna_desktop::backup::BackupJob;

use super::folder_browser::FolderBrowser;
use super::spawn_blocking;
use super::toast_error;

pub struct BackupPage {
    root: gtk::Widget,
}

impl BackupPage {
    pub fn new(state: Arc<AppState>, toast: Rc<adw::ToastOverlay>) -> Self {
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);

        let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        toolbar.set_margin_top(12);
        toolbar.set_margin_bottom(8);
        toolbar.set_margin_start(16);
        toolbar.set_margin_end(16);

        let blurb = gtk::Label::new(Some(
            "Copy folders from this computer onto Luna. One-way — changes on Luna do not come back.",
        ));
        blurb.set_wrap(true);
        blurb.set_halign(gtk::Align::Start);
        blurb.set_hexpand(true);
        blurb.add_css_class("body");

        let new_btn = gtk::Button::with_label("New backup");
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
                let is_empty = jobs.is_empty();
                empty.set_visible(is_empty);
                list.set_visible(!is_empty);
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
    let subtitle = format!(
        "{} folder{} → {}{}",
        job.sources.len(),
        if job.sources.len() == 1 { "" } else { "s" },
        job.drive_id,
        if job.remote_path.is_empty() {
            String::new()
        } else {
            format!(" / {}", job.remote_path)
        }
    );
    let row = adw::ActionRow::builder()
        .title(&title)
        .subtitle(&subtitle)
        .build();

    let mut status = if job.running || progress.running {
        "Running".to_string()
    } else {
        "Paused".to_string()
    };
    if progress.uploaded > 0 {
        status.push_str(&format!(" · {} files", progress.uploaded));
    }
    if !progress.current.is_empty() {
        status.push_str(&format!(" · {}", progress.current));
    }
    if !progress.error.is_empty() {
        status.push_str(&format!(" · {}", progress.error));
    }
    let status_lbl = gtk::Label::new(Some(&status));
    status_lbl.add_css_class("caption");
    row.add_suffix(&status_lbl);

    let toggle = gtk::Button::with_label(if job.running { "Pause" } else { "Start" });
    toggle.add_css_class("flat");
    let id = job.id.clone();
    let running = job.running;
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
                        luna_desktop::stop_backup_job(&state, &id)
                    } else {
                        luna_desktop::start_backup_job(&state, &id)
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

    let edit = gtk::Button::from_icon_name("document-edit-symbolic");
    edit.add_css_class("flat");
    edit.set_tooltip_text(Some("Edit"));
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

    let delete = gtk::Button::from_icon_name("user-trash-symbolic");
    delete.add_css_class("flat");
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

fn open_editor(
    parent: &impl IsA<gtk::Widget>,
    state: Arc<AppState>,
    toast: Rc<adw::ToastOverlay>,
    job: BackupJob,
    refresh: Rc<dyn Fn()>,
) {
    let dialog = adw::Dialog::new();
    dialog.set_title(if job.id.is_empty() {
        "New backup"
    } else {
        "Edit backup"
    });
    dialog.set_content_width(520);
    dialog.set_content_height(580);

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
            for (i, s) in snapshot.iter().enumerate() {
                let row = adw::ActionRow::builder().title(s).build();
                let rm = gtk::Button::from_icon_name("list-remove-symbolic");
                rm.add_css_class("flat");
                rm.connect_clicked({
                    let sources = sources.clone();
                    let sources_list = sources_list.clone();
                    move |_| {
                        if i < sources.borrow().len() {
                            sources.borrow_mut().remove(i);
                        }
                        // rebuild
                        while let Some(r) = sources_list.row_at_index(0) {
                            sources_list.remove(&r);
                        }
                        for (j, path) in sources.borrow().iter().enumerate() {
                            let r = adw::ActionRow::builder().title(path).build();
                            let btn = gtk::Button::from_icon_name("list-remove-symbolic");
                            btn.add_css_class("flat");
                            btn.connect_clicked({
                                let sources = sources.clone();
                                let sources_list = sources_list.clone();
                                move |_| {
                                    if j < sources.borrow().len() {
                                        sources.borrow_mut().remove(j);
                                    }
                                    while let Some(x) = sources_list.row_at_index(0) {
                                        sources_list.remove(&x);
                                    }
                                    for p in sources.borrow().iter() {
                                        sources_list
                                            .append(&adw::ActionRow::builder().title(p).build());
                                    }
                                }
                            });
                            r.add_suffix(&btn);
                            sources_list.append(&r);
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
    dialog.set_child(Some(&toolbar));

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
                running: false,
            };
            let state = state.clone();
            spawn_blocking(move || luna_desktop::save_backup_job(&state, draft), {
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
