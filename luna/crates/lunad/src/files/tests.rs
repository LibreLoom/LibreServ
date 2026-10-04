use super::*;

fn drive_dir() -> (tempfile::TempDir, rusqlite::Connection, String) {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let id = "drive-1";
    let root = dir.path().join("drive");
    std::fs::create_dir_all(&root).unwrap();
    let marker = luna_core::marker::Marker::new(id, "Test");
    let prefix = luna_core::marker::pick_prefix(&root).unwrap();
    crate::drives::drive_db::create(&root, &marker, &prefix).unwrap();
    db::upsert_drive(
        &conn,
        id,
        "Test",
        "as_is",
        "ext4",
        "sdz",
        root.to_str().unwrap(),
    )
    .unwrap();
    (dir, conn, id.into())
}

#[test]
fn private_items_nest_and_follow_moves_and_trash() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    let prefix = crate::drives::drive_db::prefix_for(&root).unwrap();
    let names = |rel: &str| -> Vec<(String, bool)> {
        list_dir(&conn, &id, rel)
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.private))
            .collect()
    };

    mkdir_as(&conn, &id, "Taxes", Some("alice")).unwrap();
    mkdir(&conn, &id, "Taxes/2024").unwrap();
    mkdir_as(&conn, &id, "Taxes/2024/Receipts", Some("alice")).unwrap();
    create(&conn, &id, "Taxes/2024/Receipts/a.pdf").unwrap();
    create(&conn, &id, "Taxes/notes.txt").unwrap();

    // On disk the private items sit under `.luna-<uuid>-<id>` names.
    let top: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!top.contains(&"Taxes".to_string()));
    assert!(
        top.iter()
            .any(|n| n.starts_with(&format!("{prefix}-")) && n.len() == prefix.len() + 27)
    );
    assert!(crate::files::is_internal_temp(&format!(
        "{prefix}-aaaaaaaaaaaaaaaaaaaaaaaaaa"
    )));

    // Listings show real names and flag private entries.
    assert_eq!(names(""), vec![("Taxes".into(), true)]);
    // Ordinary children inherit the folder's protection — the private
    // flag marks a boundary, not an inherited file.
    assert_eq!(
        names("Taxes"),
        vec![("2024".into(), false), ("notes.txt".into(), false)]
    );
    assert_eq!(names("Taxes/2024/Receipts"), vec![("a.pdf".into(), false)]);

    // A name is taken whether the clash is plain or private.
    assert!(mkdir(&conn, &id, "Taxes").is_err());
    assert!(create(&conn, &id, "Taxes/notes.txt").is_err());
    assert!(mkdir_as(&conn, &id, "Taxes/2024", Some("alice")).is_err());

    // Rename and move re-key the item and what is inside it.
    rename(&conn, &id, "Taxes", "Money").unwrap();
    assert_eq!(names(""), vec![("Money".into(), true)]);
    assert_eq!(names("Money/2024/Receipts"), vec![("a.pdf".into(), false)]);
    assert!(list_dir(&conn, &id, "Taxes").is_err());
    mkdir(&conn, &id, "Archive").unwrap();
    move_rel(&conn, &id, "Money/2024", "Archive/2024").unwrap();
    assert_eq!(
        names("Archive/2024/Receipts"),
        vec![("a.pdf".into(), false)]
    );
    assert!(crate::private::item_at(&root, "Archive/2024/Receipts").is_some());

    // Trash keeps the private entry's name and origin; restore brings it back.
    let trashed = delete_to_trash(&conn, &id, "Money").unwrap();
    assert!(list_dir(&conn, &id, "Money").is_err());
    let entry = trashed.strip_prefix(".luna-trash/").unwrap().to_string();
    assert!(entry.ends_with("-Money"), "{entry}");
    assert_eq!(
        trash_original_path(&conn, &id, &trashed)
            .unwrap()
            .as_deref(),
        Some("Money")
    );
    assert_eq!(list_trash(&conn, &id).unwrap()[0].name, entry);
    restore_from_trash(&conn, &id, &trashed, "Money").unwrap();
    assert_eq!(names("Money"), vec![("notes.txt".into(), false)]);

    // Purging from trash drops the rows with the files.
    let trashed = delete_to_trash(&conn, &id, "Money").unwrap();
    purge_trash(&conn, &id, &trashed).unwrap();
    assert!(
        crate::private::under(&root, "")
            .iter()
            .all(|i| i.path.starts_with("Archive"))
    );
}

#[test]
fn private_rows_follow_the_drive_when_it_was_edited_elsewhere() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir(&conn, &id, "a").unwrap();
    mkdir(&conn, &id, "b").unwrap();
    mkdir_as(&conn, &id, "a/Keep", Some("alice")).unwrap();
    mkdir_as(&conn, &id, "a/Gone", Some("alice")).unwrap();
    create(&conn, &id, "a/Keep/x.txt").unwrap();
    let keep = crate::private::disk_leaf(&root, "a/Keep").unwrap();
    let gone = crate::private::disk_leaf(&root, "a/Gone").unwrap();

    // Someone moves one entry and deletes the other with a file manager.
    std::fs::rename(root.join("a").join(&keep), root.join("b").join(&keep)).unwrap();
    std::fs::remove_dir(root.join("a").join(&gone)).unwrap();
    crate::private::forget(&root);

    // On the next read the rows match what is on the drive.
    assert_eq!(
        crate::private::item_at(&root, "b/Keep").map(|i| i.owner),
        Some("alice".into())
    );
    assert!(crate::private::item_at(&root, "a/Keep").is_none());
    assert!(crate::private::item_at(&root, "a/Gone").is_none());
    let names: Vec<_> = list_dir(&conn, &id, "b/Keep")
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec!["x.txt"]);
    // An entry with no row at all is hidden from everyone.
    std::fs::create_dir(root.join(crate::private::disk_name(
        &crate::drives::drive_db::prefix_for(&root).unwrap(),
        "zzzzzzzzzzzzzzzzzzzzzzzzzz",
    )))
    .unwrap();
    assert!(
        list_dir(&conn, &id, "")
            .unwrap()
            .iter()
            .all(|e| e.name == "a" || e.name == "b")
    );
}

#[test]
fn a_form_in_a_private_folder_keeps_its_files_through_rename_trash_and_restore() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir_as(&conn, &id, "Mine", Some("alice")).unwrap();
    create(&conn, &id, "Mine/rsvp.lunaform").unwrap();
    let form = |rel: &str| root.join(crate::private::disk_rel(&root, rel));
    let files = |rel: &str| crate::api::forms::files_dir_for(&root, &form(rel)).unwrap();
    std::fs::create_dir_all(files("Mine/rsvp.lunaform")).unwrap();
    std::fs::write(files("Mine/rsvp.lunaform").join("pic.png"), b"png").unwrap();

    rename(&conn, &id, "Mine/rsvp.lunaform", "party.lunaform").unwrap();
    assert_eq!(
        std::fs::read(files("Mine/party.lunaform").join("pic.png")).unwrap(),
        b"png"
    );

    let trashed = delete_to_trash(&conn, &id, "Mine").unwrap();
    restore_from_trash(&conn, &id, &trashed, "Mine").unwrap();
    assert_eq!(
        std::fs::read(files("Mine/party.lunaform").join("pic.png")).unwrap(),
        b"png"
    );
    assert_eq!(
        crate::private::item_at(&root, "Mine").map(|i| i.owner),
        Some("alice".into())
    );
}

#[test]
fn a_path_spelling_out_the_disk_name_reaches_nothing() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir_as(&conn, &id, "Vault", Some("alice")).unwrap();
    let disk = crate::private::disk_leaf(&root, "Vault").unwrap();
    for path in [disk.clone(), format!("{disk}/x"), format!("a/{disk}")] {
        let b = crate::private::boundary_for(&root, &path).unwrap();
        assert_eq!(b.owner, crate::private::SEALED, "{path}");
    }
    // The real name still reaches its owner's item.
    assert_eq!(
        crate::private::boundary_for(&root, "Vault").unwrap().owner,
        "alice"
    );
}

#[test]
fn a_symlink_cannot_carry_a_request_across_a_private_boundary() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir_as(&conn, &id, "Vault", Some("alice")).unwrap();
    create(&conn, &id, "Vault/secret.txt").unwrap();
    let disk = crate::private::disk_leaf(&root, "Vault").unwrap();
    std::os::unix::fs::symlink(root.join(&disk), root.join("Shortcut")).unwrap();
    assert!(resolve_child(&root, "Vault/secret.txt").is_ok());
    assert!(resolve_child(&root, "Shortcut/secret.txt").is_err());
    assert!(resolve_any(&conn, &id, "Shortcut/secret.txt").is_err());
}

#[test]
fn removing_an_owner_lifts_out_what_belongs_to_others() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir_as(&conn, &id, "Bobs", Some("bob")).unwrap();
    create(&conn, &id, "Bobs/mine.txt").unwrap();
    mkdir_as(&conn, &id, "Bobs/Alices", Some("alice")).unwrap();
    create(&conn, &id, "Bobs/Alices/hers.txt").unwrap();
    crate::private::purge_owner_for_test(&root, "bob");
    // Bob's folder and what was in it are gone; Alice's item is still
    // hers, now beside where his sat.
    assert!(crate::private::item_at(&root, "Bobs").is_none());
    assert_eq!(
        crate::private::item_at(&root, "Alices").map(|i| i.owner),
        Some("alice".into())
    );
    let names: Vec<_> = list_dir(&conn, &id, "")
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec!["Alices"]);
    assert_eq!(list_dir(&conn, &id, "Alices").unwrap()[0].name, "hers.txt");
}

#[test]
fn a_forms_answers_stay_inside_the_private_folder() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    mkdir_as(&conn, &id, "Mine", Some("alice")).unwrap();
    create(&conn, &id, "Mine/rsvp.lunaform").unwrap();
    let form = root.join(crate::private::disk_rel(&root, "Mine/rsvp.lunaform"));
    let answers = crate::api::forms::responses_file_for(&root, &form).unwrap();
    std::fs::write(&answers, b"{}").unwrap();
    // Ordinary form inside a private folder: the answers sibling keeps the
    // ordinary name and sits inside the same private disk directory.
    assert_eq!(answers, form.with_file_name("rsvp.lunaform.responses"));
    assert!(
        files_in(&root.join(crate::private::disk_rel(&root, "Mine")))
            .iter()
            .any(|n| n == "rsvp.lunaform.responses")
    );
}

fn files_in(root: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn list_sorts_dirs_first_and_jails() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("b.txt"), b"b").unwrap();
    std::fs::create_dir(root.join("a")).unwrap();

    let entries = list_dir(&conn, &id, "").unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].name, "a");
    assert_eq!(entries[0].kind, "dir");
    assert_eq!(entries[1].name, "b.txt");

    assert!(matches!(
        list_dir(&conn, &id, "../x"),
        Err(FilesError::Path(_))
    ));
}

#[test]
fn list_hides_upload_temps() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    let temp = format!(
        "{}-upload.1.2",
        crate::drives::drive_db::prefix_for(&root).unwrap()
    );
    std::fs::write(root.join("keep.txt"), b"k").unwrap();
    std::fs::write(root.join(&temp), b"tmp").unwrap();
    let entries = list_dir(&conn, &id, "").unwrap();
    assert!(entries.iter().all(|e| e.name != temp));
    assert!(file_path(&conn, &id, &temp).is_err());
}

#[test]
fn safe_name_rejects_traversal() {
    assert!(safe_name("../x").is_err());
    assert!(safe_name("a/b").is_err());
    assert_eq!(safe_name("photo.jpg").unwrap(), "photo.jpg");
}

#[test]
fn list_sees_write_that_landed_within_dir_mtime_granularity() {
    // Regression: listings trusted a directory mtime compared in whole
    // seconds, so a write that landed in the same second as the index
    // fill stayed invisible until some later change crossed a second
    // boundary. Create and list back-to-back to sit inside one second.
    let (_dir, conn, id) = drive_dir();
    let _ = list_dir(&conn, &id, "").unwrap(); // fills the index
    create(&conn, &id, "Document.docx").unwrap();
    let entries = list_dir(&conn, &id, "").unwrap();
    assert!(
        entries.iter().any(|e| e.name == "Document.docx"),
        "a create that landed on disk must appear in the next listing"
    );
}

#[test]
fn mkdir_creates_and_rejects_escape_and_conflict() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();

    mkdir(&conn, &id, "family").unwrap();
    assert!(root.join("family").is_dir());

    assert!(matches!(
        mkdir(&conn, &id, "family"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::AlreadyExists
    ));
    assert!(matches!(
        mkdir(&conn, &id, "../outside"),
        Err(FilesError::Path(_))
    ));
    assert!(matches!(
        mkdir(&conn, &id, "missing-parent/child"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
    ));

    mkdir(&conn, &id, "family/album").unwrap();
    assert!(root.join("family/album").is_dir());
}

#[test]
fn create_makes_empty_file_and_rejects_escape_and_conflict() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();

    mkdir(&conn, &id, "notes").unwrap();
    create(&conn, &id, "notes/shopping.txt").unwrap();
    assert!(root.join("notes/shopping.txt").is_file());
    assert_eq!(std::fs::read(root.join("notes/shopping.txt")).unwrap(), b"");

    assert!(matches!(
        create(&conn, &id, "notes/shopping.txt"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::AlreadyExists
    ));
    assert!(matches!(
        create(&conn, &id, "../outside.txt"),
        Err(FilesError::Path(_))
    ));
    assert!(matches!(
        create(&conn, &id, "missing-parent/note.txt"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
    ));
    assert!(matches!(
        create(&conn, &id, "notes/a/b.txt"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
    ));
    assert!(create(&conn, &id, "notes/..").is_err());
    assert!(create(&conn, &id, "notes/.").is_err());
    create(&conn, &id, "readme.txt").unwrap();
    assert!(root.join("readme.txt").is_file());
}

#[test]
fn dest_dir_create_makes_missing_folders_inside_the_jail() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();

    // The case that dropped backup/sync subfolders: nested destination
    // that does not exist yet is created.
    let dir = dest_dir_create(&conn, &id, "DesktopBackup/subdir/deep").unwrap();
    assert!(dir.ends_with("DesktopBackup/subdir/deep"));
    assert!(root.join("DesktopBackup/subdir/deep").is_dir());

    // Existing dirs resolve as before, and "" is the root.
    assert_eq!(
        dest_dir_create(&conn, &id, "").unwrap(),
        root.canonicalize().unwrap()
    );
    assert!(
        dest_dir_create(&conn, &id, "DesktopBackup/subdir")
            .unwrap()
            .is_dir()
    );

    // Traversal and the `.luna-*` namespace stay off-limits; a file in the
    // way is NotADirectory, not clobbered.
    assert!(dest_dir_create(&conn, &id, "../outside").is_err());
    assert!(dest_dir_create(&conn, &id, "DesktopBackup/../x").is_err());
    std::fs::write(root.join("file.txt"), b"x").unwrap();
    assert!(matches!(
        dest_dir_create(&conn, &id, "file.txt/inside"),
        Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotADirectory
    ));

    // A symlink mid-path must not steer creation outside the drive root.
    #[cfg(unix)]
    {
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("hole")).unwrap();
        assert!(matches!(
            dest_dir_create(&conn, &id, "hole/pwned"),
            Err(FilesError::Path(_))
        ));
        assert!(!outside.join("pwned").exists());
    }
}

#[test]
fn internal_temps_are_hidden() {
    let p = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f";
    assert!(is_internal_temp(&format!("{p}-upload.12.99.part")));
    assert!(is_internal_temp(&format!("folder/{p}-upload.1.2.part")));
    assert!(is_internal_temp(&format!("{p}.sqlite3")));
    assert!(is_internal_temp(&format!("{p}-thumbs")));
    assert!(is_internal_temp(&format!("{p}-trash/entry")));
    assert!(is_internal_temp(&format!("docs/{p}-trash/entry")));
    assert!(is_internal_temp("notes/.x.part"));
    assert!(!is_internal_temp("photo.jpg"));
    assert!(!is_internal_temp("notes.part"));
    // Fixed legacy names are ordinary files now — users may see them.
    assert!(!is_internal_temp(".luna-trash"));
    assert!(!is_internal_temp(".lunathumbs"));
}

#[test]
fn luna_namespace_is_off_limits_to_user_writes() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    let prefix = crate::drives::drive_db::prefix_for(&root).unwrap();
    let ns = format!("{prefix}-thumbs");
    std::fs::create_dir_all(root.join(&ns)).unwrap();
    std::fs::write(root.join("note.txt"), b"n").unwrap();

    // Nothing inside a `.luna-<uuid>` dir can be listed, created, made,
    // renamed, deleted, or restored into through the file API.
    assert!(list_dir(&conn, &id, &ns).is_err());
    assert!(create(&conn, &id, &format!("{ns}/x.txt")).is_err());
    assert!(mkdir(&conn, &id, &format!("{ns}/sub")).is_err());
    assert!(mkdir(&conn, &id, &ns).is_err());
    assert!(rename(&conn, &id, &ns, "renamed").is_err());
    assert!(rename(&conn, &id, "note.txt", &ns).is_err());
    assert!(delete_to_trash(&conn, &id, &ns).is_err());
    assert!(dest_dir(&conn, &id, &ns).is_err());
    assert!(
        restore_from_trash(&conn, &id, &format!("{prefix}-trash/x"), &format!("{ns}/x")).is_err()
    );
    assert!(root.join(&ns).is_dir());
    assert!(root.join("note.txt").exists());
}

#[test]
fn content_disposition_strips_control_and_quotes() {
    assert_eq!(
        content_disposition_filename("hi\"\r\nX: inject.jpg"),
        "hiX inject.jpg"
    );
    assert_eq!(content_disposition_filename("\n\r"), "download");
    assert_eq!(content_disposition_filename("photo.jpg"), "photo.jpg");
}

#[test]
fn delete_moves_to_trash_and_rename_works() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("keep.txt"), b"keep").unwrap();

    rename(&conn, &id, "keep.txt", "renamed.txt").unwrap();
    assert!(root.join("renamed.txt").exists());
    assert!(!root.join("keep.txt").exists());

    let trash_rel = delete_to_trash(&conn, &id, "renamed.txt").unwrap();
    assert!(
        trash_rel.starts_with(".luna-trash/"),
        "API alias: {trash_rel}"
    );
    assert!(!root.join("renamed.txt").exists());
    let disk_rel = real_rel(&root, &trash_rel).into_owned();
    assert!(root.join(&disk_rel).exists());

    let listed = list_trash(&conn, &id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].original_path, "renamed.txt");

    restore_from_trash(&conn, &id, &trash_rel, "back.txt").unwrap();
    assert!(root.join("back.txt").exists());
    assert!(!root.join(&disk_rel).exists());
    assert_eq!(std::fs::read(root.join("back.txt")).unwrap(), b"keep");
}

#[test]
fn trash_meta_records_nested_original_path() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("family/album")).unwrap();
    std::fs::write(root.join("family/album/photo.jpg"), b"x").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "family/album/photo.jpg").unwrap();
    let listed = list_trash(&conn, &id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].original_path, "family/album/photo.jpg");
    assert_eq!(
        trash_original_path(&conn, &id, &trash_rel).unwrap(),
        Some("family/album/photo.jpg".into())
    );
}

#[test]
fn list_trash_hides_meta_directory() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("note.txt"), b"n").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "note.txt").unwrap();
    // Trash restore paths live in the marker microdb, not a `.meta` folder.
    let real_trash = format!(
        "{}/.meta",
        crate::drives::drive_db::prefix_for(&root).unwrap() + "-trash"
    );
    assert!(!root.join(&real_trash).exists());
    // The on-disk entry lives under the drive's real prefix dir.
    let disk_rel = format!(
        "{}/{}",
        crate::drives::drive_db::prefix_for(&root).unwrap() + "-trash",
        trash_rel.trim_start_matches(".luna-trash/")
    );
    assert!(root.join(&disk_rel).exists());
    let listed = list_trash(&conn, &id).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(!listed.iter().any(|e| e.name == ".meta"));
}

#[test]
fn restore_is_same_drive_and_never_overwrites() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("a.txt"), b"a").unwrap();
    std::fs::write(root.join("taken.txt"), b"taken").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "a.txt").unwrap();
    assert!(restore_from_trash(&conn, &id, &trash_rel, "taken.txt").is_err());
    assert!(root.join(real_rel(&root, &trash_rel).as_ref()).exists());
    assert_eq!(std::fs::read(root.join("taken.txt")).unwrap(), b"taken");
}

/// A form with a files folder and an answers file, ready to be moved.
fn make_form(root: &std::path::Path, dir: &str, name: &str) {
    let form = root.join(dir).join(name);
    std::fs::create_dir_all(form.parent().unwrap()).unwrap();
    std::fs::write(&form, b"{}").unwrap();
    let files = crate::api::forms::files_dir_for(root, &form).unwrap();
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("pic.png"), b"png").unwrap();
    let responses = crate::api::forms::responses_file_for(root, &form).unwrap();
    std::fs::write(responses, b"{}\n").unwrap();
}

fn form_parts_exist(root: &std::path::Path, form: &std::path::Path) -> (bool, bool) {
    (
        crate::api::forms::files_dir_for(root, form)
            .unwrap()
            .join("pic.png")
            .is_file(),
        crate::api::forms::responses_file_for(root, form)
            .unwrap()
            .is_file(),
    )
}

#[test]
fn form_files_follow_rename_and_move() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    make_form(&root, "", "rsvp.lunaform");
    std::fs::create_dir(root.join("archive")).unwrap();

    rename(&conn, &id, "rsvp.lunaform", "party.lunaform").unwrap();
    assert_eq!(
        form_parts_exist(&root, &root.join("party.lunaform")),
        (true, true)
    );
    assert_eq!(
        form_parts_exist(&root, &root.join("rsvp.lunaform")),
        (false, false)
    );

    move_rel(&conn, &id, "party.lunaform", "archive/party.lunaform").unwrap();
    assert_eq!(
        form_parts_exist(&root, &root.join("archive/party.lunaform")),
        (true, true)
    );
    assert_eq!(
        form_parts_exist(&root, &root.join("party.lunaform")),
        (false, false)
    );
}

#[test]
fn form_files_trash_restore_and_purge() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    make_form(&root, "forms", "rsvp.lunaform");
    let trash_dir = crate::drives::layout::Layout::detect(&root)
        .unwrap()
        .trash_dir(&root);

    let trash_rel = delete_to_trash(&conn, &id, "forms/rsvp.lunaform").unwrap();
    assert_eq!(
        form_parts_exist(&root, &root.join("forms/rsvp.lunaform")),
        (false, false)
    );
    // Kept in trash under the entry's name, and never listed as entries.
    let entry = trash_dir.join(trash_rel.trim_start_matches(".luna-trash/"));
    assert_eq!(form_parts_exist(&root, &entry), (true, true));
    assert_eq!(list_trash(&conn, &id).unwrap().len(), 1);

    restore_from_trash(&conn, &id, &trash_rel, "forms/back.lunaform").unwrap();
    assert_eq!(
        form_parts_exist(&root, &root.join("forms/back.lunaform")),
        (true, true)
    );
    assert_eq!(std::fs::read_dir(&trash_dir).unwrap().count(), 0);

    // Emptying the trash leaves nothing behind on the drive.
    let trash_rel = delete_to_trash(&conn, &id, "forms/back.lunaform").unwrap();
    purge_trash(&conn, &id, &trash_rel).unwrap();
    assert_eq!(std::fs::read_dir(&trash_dir).unwrap().count(), 0);
    let left: Vec<_> = std::fs::read_dir(root.join("forms")).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn purge_only_touches_trash() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("keep.txt"), b"keep").unwrap();
    assert!(purge_trash(&conn, &id, "keep.txt").is_err());
    assert!(root.join("keep.txt").exists());

    let trash_rel = delete_to_trash(&conn, &id, "keep.txt").unwrap();
    purge_trash(&conn, &id, &trash_rel).unwrap();
    assert!(!root.join(&trash_rel).exists());
    assert!(list_trash(&conn, &id).unwrap().is_empty());
}

#[test]
fn original_name_from_trash_strips_nonce() {
    assert_eq!(
        original_name_from_trash("1710000000-photo.jpg"),
        "photo.jpg"
    );
    assert_eq!(
        original_name_from_trash("1710000000-2-photo.jpg"),
        "photo.jpg"
    );
    assert_eq!(original_name_from_trash("plain"), "plain");
}

#[test]
fn rename_never_overwrites() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("a.txt"), b"a").unwrap();
    std::fs::write(root.join("b.txt"), b"b").unwrap();
    assert!(rename(&conn, &id, "a.txt", "b.txt").is_err());
}

#[test]
fn rename_in_trash_retitles_the_origin() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/old.txt"), b"x").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "docs/old.txt").unwrap();

    rename(&conn, &id, &trash_rel, "new.txt").unwrap();

    // The on-disk entry keeps its generated `{nonce}-` prefix while the
    // metadata — and therefore what it restores as — retitles.
    let listed = list_trash(&conn, &id).unwrap();
    assert_eq!(listed.len(), 1);
    let entry = &listed[0].name;
    assert!(entry.ends_with("-new.txt"), "nonce-prefixed entry: {entry}");
    assert_eq!(listed[0].original_path, "docs/new.txt");

    let api_rel = format!(".luna-trash/{entry}");
    restore_from_trash(&conn, &id, &api_rel, "docs/new.txt").unwrap();
    assert!(root.join("docs/new.txt").exists());
}

#[test]
fn rename_nested_path_inside_trash() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/sub.txt"), b"x").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "docs").unwrap();

    rename(&conn, &id, &format!("{trash_rel}/sub.txt"), "renamed.txt").unwrap();
    assert!(
        root.join(real_rel(&root, &format!("{trash_rel}/renamed.txt")).as_ref())
            .exists()
    );
    // The entry's origin metadata is untouched — it still restores as docs.
    assert_eq!(
        trash_original_path(&conn, &id, &trash_rel).unwrap(),
        Some("docs".into())
    );
}

#[test]
fn purge_nested_trash_path_keeps_entry_meta() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/gone.txt"), b"x").unwrap();
    std::fs::write(root.join("docs/keep.txt"), b"y").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "docs").unwrap();

    purge_trash(&conn, &id, &format!("{trash_rel}/gone.txt")).unwrap();
    assert!(
        !root
            .join(real_rel(&root, &format!("{trash_rel}/gone.txt")).as_ref())
            .exists()
    );
    assert!(
        root.join(real_rel(&root, &format!("{trash_rel}/keep.txt")).as_ref())
            .exists()
    );
    assert_eq!(
        trash_original_path(&conn, &id, &trash_rel).unwrap(),
        Some("docs".into())
    );
}

#[test]
fn move_rel_pulls_an_item_out_of_trash() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("keep.txt"), b"keep").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "keep.txt").unwrap();

    move_rel(&conn, &id, &trash_rel, "moved/back.txt").unwrap_err();
    std::fs::create_dir_all(root.join("moved")).unwrap();
    move_rel(&conn, &id, &trash_rel, "moved/back.txt").unwrap();
    assert!(root.join("moved/back.txt").exists());
    // Moving out drops the origin metadata — it is no longer trashed.
    assert!(list_trash(&conn, &id).unwrap().is_empty());
    // And moving back into trash through move_rel stays impossible.
    assert!(move_rel(&conn, &id, "moved/back.txt", &trash_rel).is_err());
}

#[test]
fn trash_api_leaf_strips_the_nonce() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("photo.jpg"), b"x").unwrap();
    let trash_rel = delete_to_trash(&conn, &id, "photo.jpg").unwrap();
    assert_eq!(
        trash_api_leaf(&conn, &id, &trash_rel).unwrap(),
        Some("photo.jpg".into())
    );
    assert_eq!(trash_api_leaf(&conn, &id, "photo.jpg").unwrap(), None);
}

#[test]
#[ignore = "benchmark; run with cargo test -- --ignored listing_benchmark"]
fn listing_benchmark_10k_files_from_index() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    for i in 0..10_000 {
        std::fs::write(root.join(format!("file-{i:05}.txt")), b"x").unwrap();
    }
    let _ = list_dir(&conn, &id, "").unwrap(); // populate index

    let start = std::time::Instant::now();
    let entries = list_dir(&conn, &id, "").unwrap();
    let elapsed = start.elapsed();
    assert_eq!(entries.len(), 10_000);
    println!("indexed listing of 10k files: {elapsed:?}");
    assert!(elapsed.as_millis() < 50, "target: <50ms, got {elapsed:?}");
}

#[test]
fn install_temp_is_atomic_and_persists_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let temp = dir
        .path()
        .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
    std::fs::write(&temp, b"hello").unwrap();
    let dest = dir.path().join("file.txt");
    install_temp(&temp, &dest, false).unwrap();
    assert!(!temp.exists());
    assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
}

#[test]
fn install_temp_never_overwrites_without_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    let temp = dir
        .path()
        .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
    let dest = dir.path().join("file.txt");
    std::fs::write(&temp, b"new").unwrap();
    std::fs::write(&dest, b"original").unwrap();

    // No-overwrite install must fail and leave the original intact.
    assert!(install_temp(&temp, &dest, false).is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), b"original");
    assert!(temp.exists(), "temp is preserved so nothing is lost");

    // Overwrite install replaces it.
    install_temp(&temp, &dest, true).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"new");
}

#[test]
fn exclusive_rename_installs_when_hard_links_are_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let temp = dir
        .path()
        .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
    let dest = dir.path().join("clip.webm");
    std::fs::write(&temp, b"webm-bytes").unwrap();
    install_by_exclusive_rename(&temp, &dest).unwrap();
    assert!(!temp.exists());
    assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
}

#[test]
fn exclusive_rename_refuses_to_clobber() {
    let dir = tempfile::tempdir().unwrap();
    let temp = dir
        .path()
        .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
    let dest = dir.path().join("clip.webm");
    std::fs::write(&temp, b"new").unwrap();
    std::fs::write(&dest, b"original").unwrap();
    assert!(install_by_exclusive_rename(&temp, &dest).is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), b"original");
    assert!(temp.exists());
}

#[test]
fn install_temp_puts_a_webm_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let temp = dir
        .path()
        .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
    std::fs::write(&temp, b"webm-bytes").unwrap();
    let dest = dir.path().join("clip.webm");
    install_temp(&temp, &dest, false).unwrap();
    assert!(!temp.exists());
    assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
}

#[test]
fn folder_zip_includes_nested_files_and_skips_internal() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    std::fs::create_dir_all(root.join("album/day")).unwrap();
    std::fs::write(root.join("album/day/beach.jpg"), b"photo").unwrap();
    std::fs::write(root.join("album/note.txt"), b"hi").unwrap();
    let internal = format!(
        "album/{}-trash",
        crate::drives::drive_db::prefix_for(&root).unwrap()
    );
    std::fs::create_dir_all(root.join(&internal)).unwrap();
    std::fs::write(root.join(format!("{internal}/x")), b"no").unwrap();

    let mut buf = std::io::Cursor::new(Vec::new());
    let count = write_folder_zip(&conn, &id, "album", &mut buf, |_| true).unwrap();
    assert_eq!(count, 2);
    let bytes = buf.into_inner();
    assert!(bytes.starts_with(b"PK"));

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    names.sort();
    assert!(names.iter().any(|n| n == "album/"));
    assert!(names.iter().any(|n| n == "album/day/" || n == "album/day"));
    assert!(names.iter().any(|n| n == "album/day/beach.jpg"));
    assert!(names.iter().any(|n| n == "album/note.txt"));
    assert!(!names.iter().any(|n| n.contains(".luna-")));
}

#[cfg(unix)]
#[test]
fn folder_zip_skips_symlinks() {
    use std::os::unix::fs::symlink;
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    let outside = _dir.path().join("outside");
    std::fs::create_dir_all(root.join("album")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("album/keep.txt"), b"keep").unwrap();
    std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
    symlink(&outside, root.join("album/link")).unwrap();

    let mut buf = std::io::Cursor::new(Vec::new());
    let count = write_folder_zip(&conn, &id, "album", &mut buf, |_| true).unwrap();
    assert_eq!(count, 1);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf.into_inner())).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(names.iter().any(|n| n == "album/keep.txt"));
    assert!(
        !names
            .iter()
            .any(|n| n.contains("secret") || n.contains("link"))
    );
}

#[test]
fn stat_reports_kind_times_and_children() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    std::fs::write(root.join("note.txt"), b"hello").unwrap();
    std::fs::create_dir(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/a.txt"), b"a").unwrap();

    let file = stat(&conn, &id, "note.txt").unwrap();
    assert_eq!(file.name, "note.txt");
    assert_eq!(file.kind, "file");
    assert_eq!(file.size, 5);
    assert!(file.modified > 0);
    assert!(file.children.is_none());
    assert!(!file.hidden);

    let dir = stat(&conn, &id, "sub").unwrap();
    assert_eq!(dir.kind, "dir");
    let counts = dir.children.unwrap();
    assert_eq!(counts.files, 1);
    assert_eq!(counts.dirs, 0);

    // Drive root resolves too — empty name, kind dir.
    let root_stat = stat(&conn, &id, "").unwrap();
    assert_eq!(root_stat.kind, "dir");
    assert!(root_stat.children.unwrap().files >= 1);

    assert!(matches!(
        stat(&conn, &id, "../escape"),
        Err(FilesError::Path(_))
    ));
    assert!(matches!(
        stat(&conn, &id, "missing.txt"),
        Err(FilesError::Io(_))
    ));
}

#[test]
fn folder_totals_counts_nested_content_and_respects_the_lens() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::write(root.join("a/one.txt"), b"12345").unwrap();
    std::fs::write(root.join("a/b/two.txt"), b"xy").unwrap();
    std::fs::write(root.join("a/.hidden"), b"h").unwrap();

    let mut all = |_: &str| true;
    let totals = folder_totals(&conn, &id, "a", &mut all).unwrap().unwrap();
    assert_eq!(totals.bytes, 5 + 2 + 1);
    assert_eq!(totals.files, 3);
    assert_eq!(totals.dirs, 1);
    assert_eq!(totals.other, 0);
    assert!(totals.complete);

    // Only "a/b" is readable: "a"'s own files stay out of the total, but
    // the granted folder inside still counts — an unreadable parent must
    // not hide a deeper grant.
    let mut only_b = |p: &str| p == "a/b";
    let scoped = folder_totals(&conn, &id, "a", &mut only_b)
        .unwrap()
        .unwrap();
    assert_eq!(scoped.bytes, 2);
    assert_eq!(scoped.files, 1);
    assert_eq!(scoped.dirs, 0);

    // A bound hit keeps what it counted as a lower bound, never zeroes
    // the answer out.
    let partial = walk_totals(
        &root,
        root.join("a"),
        "a",
        &mut all,
        2,
        std::time::Instant::now() + std::time::Duration::from_secs(60),
    );
    assert!(!partial.complete);
    assert!(partial.files + partial.dirs + partial.other <= 2);

    // Files and missing paths have no totals.
    assert!(
        folder_totals(&conn, &id, "a/one.txt", &mut all)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        folder_totals(&conn, &id, "../escape", &mut all),
        Err(FilesError::Path(_))
    ));
}

#[cfg(unix)]
#[test]
fn folder_totals_counts_a_link_but_never_follows_it() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    let outside = _dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), b"not on the drive").unwrap();
    std::fs::create_dir(root.join("a")).unwrap();
    std::fs::write(root.join("a/real.txt"), b"r").unwrap();
    // A link to a directory outside the drive: counted as "other", and
    // the walk must not descend into it.
    std::os::unix::fs::symlink(&outside, root.join("a/far")).unwrap();

    let mut all = |_: &str| true;
    let totals = folder_totals(&conn, &id, "a", &mut all).unwrap().unwrap();
    assert_eq!(totals.bytes, 1);
    assert_eq!(totals.files, 1);
    assert_eq!(totals.dirs, 0);
    assert_eq!(totals.other, 1);
}

#[cfg(unix)]
#[test]
fn stat_reports_the_link_not_its_target() {
    let (_dir, conn, id) = drive_dir();
    let root = std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
    let outside = _dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("real.txt"), b"r").unwrap();
    std::os::unix::fs::symlink("real.txt", root.join("link.txt")).unwrap();
    // Even a link escaping the drive still reports as a symlink.
    std::os::unix::fs::symlink(&outside, root.join("far.txt")).unwrap();

    let s = stat(&conn, &id, "link.txt").unwrap();
    assert_eq!(s.kind, "symlink");
    assert_eq!(s.link_target.as_deref(), Some("real.txt"));

    let far = stat(&conn, &id, "far.txt").unwrap();
    assert_eq!(far.kind, "symlink");
}

#[test]
fn raw_trash_names_cannot_rename_or_move() {
    // A raw `{prefix}-trash/<entry>` name must never retitle or relocate
    // a trash entry: caps map the `.luna-trash` alias to the entry's
    // origin, while a raw name would act on ANY user's trashed file.
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("gone.txt"), b"x").unwrap();
    let api_rel = delete_to_trash(&conn, &id, "gone.txt").unwrap();
    let entry = &list_trash(&conn, &id).unwrap()[0].name;
    let raw = format!(
        "{}-trash/{entry}",
        crate::drives::drive_db::prefix_for(&root).unwrap()
    );

    assert!(rename(&conn, &id, &raw, "retitled.txt").is_err());
    assert!(move_rel(&conn, &id, &raw, "loot.txt").is_err());
    assert!(
        !root.join("loot.txt").exists() && !root.join("retitled.txt").exists(),
        "raw trash paths move nothing"
    );

    // The alias form still retitles and moves the same entry — that is
    // the dedicated trash flow the caps engine can audit.
    rename(&conn, &id, &api_rel, "back.txt").unwrap();
    std::fs::create_dir_all(root.join("out")).unwrap();
    let entry = &list_trash(&conn, &id).unwrap()[0].name;
    move_rel(&conn, &id, &format!(".luna-trash/{entry}"), "out/back.txt").unwrap();
    assert!(root.join("out/back.txt").exists());
}

#[test]
fn hidden_part_names_are_blocked_everywhere_a_name_is_minted() {
    // `something.part`-style leaves are invisible to listings — every
    // create-style verb must refuse them.
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("a.txt"), b"a").unwrap();

    assert!(rename(&conn, &id, "a.txt", ".x.part").is_err());
    assert!(move_rel(&conn, &id, "a.txt", "docs/.x.part").is_err());
    let trash_rel = delete_to_trash(&conn, &id, "a.txt").unwrap();
    assert!(restore_from_trash(&conn, &id, &trash_rel, "docs/.x.part").is_err());
    assert!(
        !root.join("docs/.x.part").exists(),
        "no invisible file was minted"
    );

    // Ordinary leaf names still work.
    restore_from_trash(&conn, &id, &trash_rel, "docs/a.txt").unwrap();
    assert!(root.join("docs/a.txt").exists());
}

#[test]
fn canonical_rel_gives_every_spelling_one_form() {
    // `//`, `.` and stray slashes are all the same path; `..` and `\` are
    // never accepted.
    for (raw, want) in [
        ("a//b", "a/b"),
        ("a/./b", "a/b"),
        ("a/b/", "a/b"),
        ("//a//b//", "a/b"),
        (" /a/b ", "a/b"),
        ("a///b", "a/b"),
        ("", ""),
        ("/", ""),
        (".", ""),
        ("./", ""),
    ] {
        assert_eq!(canonical_rel(raw).unwrap(), want, "canonical_rel({raw:?})");
    }
    for raw in ["a/../b", "..", "../x", "a/b/../..", "a\\b", "a\\b\\c", "\\"] {
        assert!(
            canonical_rel(raw).is_err(),
            "canonical_rel({raw:?}) must fail"
        );
    }
}

#[test]
fn alternate_spellings_see_the_same_files_and_grants() {
    // The filesystem, the listing index and capability checks must all
    // answer `a//b` and `a/./b` the way `a/b` answers — a spelling that
    // only one layer understands is a hole between them.
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::write(root.join("a/b.txt"), b"b").unwrap();

    for rel in ["a//b.txt", "a/./b.txt", "a/b.txt/"] {
        assert_eq!(
            stat(&conn, &id, rel).unwrap().name,
            "b.txt",
            "{rel} must stat a/b.txt"
        );
    }
    assert_eq!(
        list_dir(&conn, &id, "a//").unwrap().len(),
        list_dir(&conn, &id, "a").unwrap().len(),
        "a// lists a's entries"
    );
    // `..` and `\` are refused, not reinterpreted.
    for rel in ["a/../a/b.txt", "a\\b.txt", "a//../x"] {
        assert!(stat(&conn, &id, rel).is_err(), "{rel} must fail");
        assert!(list_dir(&conn, &id, rel).is_err(), "{rel} must fail");
    }
    // A rename under a doubled-separator spelling lands where the plain
    // spelling would.
    rename(&conn, &id, "a//b.txt", "c.txt").unwrap();
    assert!(root.join("a/c.txt").exists());
    // Moves and mkdirs canonicalize the same way.
    mkdir(&conn, &id, "a//deep").unwrap();
    assert!(root.join("a/deep").is_dir());
    move_rel(&conn, &id, "a/./c.txt", "a/deep/c.txt").unwrap();
    assert!(root.join("a/deep/c.txt").exists());
}

#[test]
fn raw_trash_names_cannot_be_read_listed_statted_or_restored() {
    // `.luna-trash` is the only spelling that reaches trash: the caps
    // engine maps it to each entry's origin. A raw `{prefix}-trash` name
    // would open everyone's deletions to anyone able to resolve it.
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("gone.txt"), b"x").unwrap();
    delete_to_trash(&conn, &id, "gone.txt").unwrap();
    let prefix = crate::drives::drive_db::prefix_for(&root).unwrap();
    let raw_root = format!("{prefix}-trash");
    let entry = list_trash(&conn, &id).unwrap()[0].name.clone();
    let raw_entry = format!("{raw_root}/{entry}");

    assert!(list_dir(&conn, &id, &raw_root).is_err());
    assert!(stat(&conn, &id, &raw_root).is_err());
    assert!(stat(&conn, &id, &raw_entry).is_err());
    assert!(list_dir(&conn, &id, &raw_entry).is_err());
    // Provenance answers through the alias only — a raw name sees nothing.
    assert!(
        trash_original_path(&conn, &id, &raw_entry)
            .unwrap()
            .is_none()
    );
    assert!(restore_from_trash(&conn, &id, &raw_entry, "loot.txt").is_err());
    assert!(purge_trash(&conn, &id, &raw_entry).is_err());
    assert!(
        !root.join("loot.txt").exists(),
        "raw trash paths restore nothing"
    );

    // The alias still reaches the same entry.
    let api_rel = format!(".luna-trash/{entry}");
    assert!(stat(&conn, &id, &api_rel).is_ok());
    restore_from_trash(&conn, &id, &api_rel, "back.txt").unwrap();
    assert!(root.join("back.txt").exists());
}

#[test]
fn zip_and_folder_totals_also_refuse_raw_trash_names() {
    // Folder-level aggregations must not leak the trash dir's real name
    // either — the alias rule applies to every read entry point.
    let (_dir, conn, id) = drive_dir();
    let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
        .to_path_buf();
    std::fs::write(root.join("gone.txt"), b"x").unwrap();
    delete_to_trash(&conn, &id, "gone.txt").unwrap();
    let prefix = crate::drives::drive_db::prefix_for(&root).unwrap();
    let raw = format!("{prefix}-trash");

    assert!(folder_totals(&conn, &id, &raw, &mut |_| true).is_err());
    assert!(zip_plan(&conn, &id, &raw, false).is_err());
}
