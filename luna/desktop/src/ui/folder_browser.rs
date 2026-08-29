use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;

use luna_desktop::AppState;

use super::spawn_blocking;
use super::toast_error;

/// Browse Luna drives/folders and keep `drive_id` / `remote_path` in sync.
pub struct FolderBrowser {
    root: gtk::Widget,
}

impl FolderBrowser {
    pub fn new(
        state: Arc<AppState>,
        toast: Rc<adw::ToastOverlay>,
        drive_id: Rc<RefCell<String>>,
        remote_path: Rc<RefCell<String>>,
    ) -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 8);

        let drive_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let path_bar = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let folder_list = gtk::ListBox::new();
        folder_list.set_selection_mode(gtk::SelectionMode::None);
        folder_list.add_css_class("boxed-list");

        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let create_btn = gtk::Button::with_label("Create folder");
        create_btn.add_css_class("pill");
        let use_btn = gtk::Button::with_label("Use this folder");
        use_btn.add_css_class("pill");
        use_btn.add_css_class("suggested-action");
        actions.append(&create_btn);
        actions.append(&use_btn);

        let selected_lbl = gtk::Label::new(None);
        selected_lbl.add_css_class("caption");
        selected_lbl.set_halign(gtk::Align::Start);

        root.append(&drive_box);
        root.append(&path_bar);
        root.append(&folder_list);
        root.append(&actions);
        root.append(&selected_lbl);

        let browse_path = Rc::new(RefCell::new(remote_path.borrow().clone()));

        let refresh_use_btn = {
            let use_btn = use_btn.clone();
            let browse_path = browse_path.clone();
            let remote_path = remote_path.clone();
            Rc::new(move || {
                let using = *browse_path.borrow() == *remote_path.borrow();
                if using {
                    use_btn.set_label("Using this folder");
                    use_btn.remove_css_class("suggested-action");
                    use_btn.set_sensitive(false);
                } else {
                    use_btn.set_label("Use this folder");
                    use_btn.add_css_class("suggested-action");
                    use_btn.set_sensitive(true);
                }
            })
        };

        let update_selected = {
            let drive_id = drive_id.clone();
            let remote_path = remote_path.clone();
            let selected_lbl = selected_lbl.clone();
            let refresh_use_btn = refresh_use_btn.clone();
            Rc::new(move || {
                let d = drive_id.borrow().clone();
                let p = remote_path.borrow().clone();
                if d.is_empty() {
                    selected_lbl.set_text("Select a drive and folder.");
                } else if p.is_empty() {
                    selected_lbl.set_text("Selected: drive root");
                } else {
                    let leaf = p.rsplit('/').next().unwrap_or(p.as_str());
                    selected_lbl.set_text(&format!("Selected: {leaf}"));
                }
                refresh_use_btn();
            })
        };
        update_selected();

        let reload_folders: Rc<RefCell<Option<Rc<dyn Fn()>>>> = Rc::new(RefCell::new(None));

        let do_reload = {
            let state = state.clone();
            let toast = toast.clone();
            let drive_id = drive_id.clone();
            let browse_path = browse_path.clone();
            let folder_list = folder_list.clone();
            let path_bar = path_bar.clone();
            let update_selected = update_selected.clone();
            let reload_folders = reload_folders.clone();
            let refresh_use_btn = refresh_use_btn.clone();
            Rc::new(move || {
                refresh_use_btn();
                let d = drive_id.borrow().clone();
                if d.is_empty() {
                    while let Some(row) = folder_list.row_at_index(0) {
                        folder_list.remove(&row);
                    }
                    while let Some(c) = path_bar.first_child() {
                        path_bar.remove(&c);
                    }
                    return;
                }
                let path = browse_path.borrow().clone();
                while let Some(c) = path_bar.first_child() {
                    path_bar.remove(&c);
                }
                let root_btn = gtk::Button::with_label("Drive root");
                root_btn.add_css_class("flat");
                root_btn.connect_clicked({
                    let browse_path = browse_path.clone();
                    let reload = reload_folders.clone();
                    let refresh_use_btn = refresh_use_btn.clone();
                    move |_| {
                        *browse_path.borrow_mut() = String::new();
                        refresh_use_btn();
                        if let Some(f) = reload.borrow().as_ref() {
                            f();
                        }
                    }
                });
                path_bar.append(&root_btn);
                let crumbs: Vec<String> = path
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect();
                for (i, c) in crumbs.iter().enumerate() {
                    path_bar.append(&gtk::Label::new(Some("/")));
                    let btn = gtk::Button::with_label(c);
                    btn.add_css_class("flat");
                    let next = crumbs[..=i].join("/");
                    btn.connect_clicked({
                        let browse_path = browse_path.clone();
                        let reload = reload_folders.clone();
                        let refresh_use_btn = refresh_use_btn.clone();
                        move |_| {
                            *browse_path.borrow_mut() = next.clone();
                            refresh_use_btn();
                            if let Some(f) = reload.borrow().as_ref() {
                                f();
                            }
                        }
                    });
                    path_bar.append(&btn);
                }

                let state = state.clone();
                let toast = toast.clone();
                let folder_list = folder_list.clone();
                let browse_path = browse_path.clone();
                let update_selected = update_selected.clone();
                let reload_folders = reload_folders.clone();
                let drive = d.clone();
                spawn_blocking(
                    move || luna_desktop::list_files(&state, &drive, &path),
                    move |result| {
                        while let Some(row) = folder_list.row_at_index(0) {
                            folder_list.remove(&row);
                        }
                        match result {
                            Ok(entries) => {
                                let dirs: Vec<_> =
                                    entries.into_iter().filter(|e| e.kind == "dir").collect();
                                if dirs.is_empty() {
                                    folder_list.set_visible(false);
                                } else {
                                    folder_list.set_visible(true);
                                    for e in dirs {
                                        let full = {
                                            let bp = browse_path.borrow();
                                            if bp.is_empty() {
                                                e.name.clone()
                                            } else {
                                                format!("{bp}/{}", e.name)
                                            }
                                        };
                                        let row = adw::ActionRow::builder()
                                            .title(&format!("{}/", e.name))
                                            .activatable(true)
                                            .build();
                                        row.connect_activated({
                                            let browse_path = browse_path.clone();
                                            let update_selected = update_selected.clone();
                                            let reload = reload_folders.clone();
                                            let full = full.clone();
                                            move |_| {
                                                *browse_path.borrow_mut() = full.clone();
                                                update_selected();
                                                if let Some(f) = reload.borrow().as_ref() {
                                                    f();
                                                }
                                            }
                                        });
                                        folder_list.append(&row);
                                    }
                                }
                            }
                            Err(e) => toast_error(&toast, e),
                        }
                    },
                );
            })
        };
        *reload_folders.borrow_mut() = Some(do_reload.clone());

        {
            let state = state.clone();
            let toast = toast.clone();
            let drive_box = drive_box.clone();
            let drive_id = drive_id.clone();
            let do_reload = do_reload.clone();
            let update_selected = update_selected.clone();
            spawn_blocking(
                move || luna_desktop::list_drives(&state),
                move |result| match result {
                    Ok(drives) => {
                        for d in drives {
                            let btn = gtk::ToggleButton::with_label(&d.label);
                            btn.add_css_class("pill");
                            if *drive_id.borrow() == d.id {
                                btn.set_active(true);
                            }
                            btn.connect_toggled({
                                let drive_id = drive_id.clone();
                                let id = d.id.clone();
                                let do_reload = do_reload.clone();
                                let update_selected = update_selected.clone();
                                let drive_box = drive_box.clone();
                                move |b| {
                                    if !b.is_active() {
                                        return;
                                    }
                                    let mut child = drive_box.first_child();
                                    while let Some(c) = child {
                                        if let Ok(tb) = c.clone().downcast::<gtk::ToggleButton>() {
                                            if tb != *b {
                                                tb.set_active(false);
                                            }
                                        }
                                        child = c.next_sibling();
                                    }
                                    *drive_id.borrow_mut() = id.clone();
                                    update_selected();
                                    do_reload();
                                }
                            });
                            drive_box.append(&btn);
                        }
                        if drive_id.borrow().is_empty() {
                            if let Some(first) = drive_box.first_child() {
                                if let Ok(tb) = first.downcast::<gtk::ToggleButton>() {
                                    tb.set_active(true);
                                }
                            }
                        } else {
                            do_reload();
                        }
                    }
                    Err(e) => toast_error(&toast, e),
                },
            );
        }

        use_btn.connect_clicked({
            let browse_path = browse_path.clone();
            let remote_path = remote_path.clone();
            let update_selected = update_selected.clone();
            move |_| {
                *remote_path.borrow_mut() = browse_path.borrow().clone();
                update_selected();
            }
        });

        create_btn.connect_clicked({
            let state = state.clone();
            let toast = toast.clone();
            let drive_id = drive_id.clone();
            let browse_path = browse_path.clone();
            let remote_path = remote_path.clone();
            let do_reload = do_reload.clone();
            let update_selected = update_selected.clone();
            let root = root.clone();
            move |btn| {
                let d = drive_id.borrow().clone();
                if d.is_empty() {
                    toast_error(&toast, "Choose a drive first.");
                    return;
                }

                let dialog = adw::Dialog::new();
                dialog.set_title("Create folder");
                dialog.set_content_width(360);

                let dialog_toast = Rc::new(adw::ToastOverlay::new());

                let toolbar = adw::ToolbarView::new();
                toolbar.add_top_bar(&adw::HeaderBar::new());

                let page = gtk::Box::new(gtk::Orientation::Vertical, 12);
                page.set_margin_top(12);
                page.set_margin_bottom(16);
                page.set_margin_start(16);
                page.set_margin_end(16);

                let group = adw::PreferencesGroup::new();
                let name_row = adw::EntryRow::builder().title("Folder name").build();
                group.add(&name_row);
                page.append(&group);

                let create = gtk::Button::with_label("Create");
                create.add_css_class("suggested-action");
                create.add_css_class("pill");
                create.set_halign(gtk::Align::End);
                page.append(&create);

                toolbar.set_content(Some(&page));
                dialog_toast.set_child(Some(&toolbar));
                dialog.set_child(Some(dialog_toast.as_ref()));

                let parent = btn
                    .root()
                    .and_then(|r| r.downcast::<gtk::Window>().ok())
                    .map(|w| w.upcast::<gtk::Widget>())
                    .unwrap_or_else(|| root.clone().upcast());

                create.connect_clicked({
                    let state = state.clone();
                    let toast = dialog_toast.clone();
                    let drive_id = drive_id.clone();
                    let browse_path = browse_path.clone();
                    let remote_path = remote_path.clone();
                    let do_reload = do_reload.clone();
                    let update_selected = update_selected.clone();
                    let name_row = name_row.clone();
                    let dialog = dialog.clone();
                    move |_| {
                        let name = name_row.text().trim().to_string();
                        if name.is_empty() {
                            toast_error(&toast, "Enter a folder name.");
                            return;
                        }
                        if name.contains('/') || name.contains('\\') {
                            toast_error(&toast, "Folder names can’t include /.");
                            return;
                        }
                        let d = drive_id.borrow().clone();
                        if d.is_empty() {
                            toast_error(&toast, "Choose a drive first.");
                            return;
                        }
                        let full = {
                            let bp = browse_path.borrow();
                            if bp.is_empty() {
                                name.clone()
                            } else {
                                format!("{bp}/{name}")
                            }
                        };
                        let state = state.clone();
                        let full2 = full.clone();
                        spawn_blocking(move || luna_desktop::mkdir(&state, &d, &full2), {
                            let toast = toast.clone();
                            let browse_path = browse_path.clone();
                            let remote_path = remote_path.clone();
                            let do_reload = do_reload.clone();
                            let update_selected = update_selected.clone();
                            let dialog = dialog.clone();
                            move |r| match r {
                                Ok(()) => {
                                    *browse_path.borrow_mut() = full.clone();
                                    *remote_path.borrow_mut() = full;
                                    update_selected();
                                    do_reload();
                                    dialog.close();
                                }
                                Err(e) => toast_error(&toast, e),
                            }
                        });
                    }
                });

                dialog.present(Some(&parent));
            }
        });

        Self {
            root: root.upcast(),
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}
