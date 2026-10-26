use super::*;

/// Write a `.luna-<uuid>` marker so the dir behaves like an adopted drive.
fn adopt(root: &Path, id: &str) {
    let prefix = luna_core::marker::pick_prefix(root).unwrap();
    crate::drives::drive_db::create(root, &luna_core::marker::Marker::new(id, "t"), &prefix)
        .unwrap();
}

/// The drive's real trash dir name (`.luna-<uuid>-trash`).
fn trash_dir_name(root: &Path) -> String {
    format!(
        "{}-trash",
        crate::drives::drive_db::prefix_for(root).unwrap()
    )
}

fn setup() -> (tempfile::TempDir, Arc<crate::Db>, String) {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let root = dir.path().join("a");
    std::fs::create_dir_all(&root).unwrap();
    adopt(&root, "a");
    db::upsert_drive(
        &conn,
        "a",
        "A",
        "as_is",
        "ext4",
        "sda",
        root.to_str().unwrap(),
    )
    .unwrap();
    let root2 = dir.path().join("b");
    std::fs::create_dir_all(&root2).unwrap();
    adopt(&root2, "b");
    db::upsert_drive(
        &conn,
        "b",
        "B",
        "as_is",
        "ext4",
        "sdb",
        root2.to_str().unwrap(),
    )
    .unwrap();
    users(&conn);
    (dir, Arc::new(crate::Db::new(conn)), "a".into())
}

/// The run-time capability recheck needs a real user row — give tests an
/// admin so `has_cap` passes the same way it would for a live session.
fn users(conn: &Connection) {
    for id in ["user-1", "sam"] {
        db::insert_user(conn, id, id, id, "hash", "admin").unwrap();
    }
}

/// Drive B on `/dev/shm` (tmpfs) so rename hits EXDEV against drive A on disk.
fn setup_cross_fs() -> Option<(tempfile::TempDir, tempfile::TempDir, Arc<crate::Db>)> {
    use std::os::unix::fs::MetadataExt;
    let shm = PathBuf::from("/dev/shm");
    if std::fs::metadata(&shm).ok()?.dev() == std::fs::metadata(std::env::temp_dir()).ok()?.dev() {
        return None;
    }
    let dir_a = tempfile::tempdir().ok()?;
    let dir_b = tempfile::TempDir::new_in(&shm).ok()?;
    let conn = db::open(&dir_a.path().join("luna.db")).ok()?;
    let root_a = dir_a.path().join("a");
    std::fs::create_dir_all(&root_a).ok()?;
    adopt(&root_a, "a");
    db::upsert_drive(&conn, "a", "A", "as_is", "ext4", "sda", root_a.to_str()?).ok()?;
    let root_b = dir_b.path().join("b");
    std::fs::create_dir_all(&root_b).ok()?;
    adopt(&root_b, "b");
    db::upsert_drive(&conn, "b", "B", "as_is", "ext4", "sdb", root_b.to_str()?).ok()?;
    users(&conn);
    Some((dir_a, dir_b, Arc::new(crate::Db::new(conn))))
}

#[tokio::test]
async fn same_drive_move_renames_without_trash() {
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
        std::fs::write(format!("{root}/note.txt"), b"stay put once").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("move", "a", "note.txt", "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);

    let root = dir.path().join("a");
    assert!(!root.join("note.txt").exists());
    assert_eq!(
        std::fs::read(root.join("inbox/note.txt")).unwrap(),
        b"stay put once"
    );
    let trash = root.join(trash_dir_name(&root));
    assert!(
        !trash.exists() || std::fs::read_dir(&trash).unwrap().next().is_none(),
        "same-drive move must not leave a trash copy"
    );
}

#[tokio::test]
async fn cross_filesystem_move_copies_then_trashes_source() {
    let Some((_dir_a, _dir_b, db)) = setup_cross_fs() else {
        eprintln!("skip: no distinct /dev/shm filesystem for EXDEV test");
        return;
    };
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/ship.txt"), b"cross device").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("move", "a", "ship.txt", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);

    let conn = db.lock().unwrap();
    let root_a = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
    let root_b = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
    assert_eq!(
        std::fs::read(format!("{root_b}/ship.txt")).unwrap(),
        b"cross device"
    );
    assert!(!PathBuf::from(&root_a).join("ship.txt").exists());
    let trash_entries: Vec<_> =
        std::fs::read_dir(PathBuf::from(&root_a).join(trash_dir_name(Path::new(&root_a))))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
    assert_eq!(trash_entries.len(), 1);
}

#[tokio::test]
async fn same_fs_cross_drive_move_still_renames() {
    // Two Luna drives on the same filesystem should rename, not copy+trash.
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/samefs.txt"), b"rename across drives").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("move", "a", "samefs.txt", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert!(!dir.path().join("a/samefs.txt").exists());
    assert_eq!(
        std::fs::read(dir.path().join("b/samefs.txt")).unwrap(),
        b"rename across drives"
    );
    let trash = dir
        .path()
        .join("a")
        .join(trash_dir_name(&dir.path().join("a")));
    assert!(
        !trash.exists() || std::fs::read_dir(&trash).unwrap().next().is_none(),
        "same-filesystem move must not trash the source"
    );
}

#[tokio::test]
async fn same_drive_folder_move_renames_tree() {
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/album/day")).unwrap();
        std::fs::write(format!("{root}/album/day/pic.jpg"), b"jpeg").unwrap();
        std::fs::create_dir_all(format!("{root}/archive")).unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("move", "a", "album", "a", "archive", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    let root = dir.path().join("a");
    assert!(!root.join("album").exists());
    assert_eq!(
        std::fs::read(root.join("archive/album/day/pic.jpg")).unwrap(),
        b"jpeg"
    );
}

#[tokio::test]
async fn move_out_of_trash_lands_under_the_original_name() {
    let (dir, db, _a) = setup();
    let trash_rel = {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
        std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
        files::delete_to_trash(&conn, "a", "note.txt").unwrap()
    };
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("move", "a", &trash_rel, "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);

    let root = dir.path().join("a");
    // The destination name is the original name — the `{nonce}-`
    // storage prefix must not leak out of trash.
    assert_eq!(std::fs::read(root.join("inbox/note.txt")).unwrap(), b"back");
    let conn = db.lock().unwrap();
    assert!(
        files::list_trash(&conn, "a").unwrap().is_empty(),
        "moving out removes the trash entry"
    );
}

#[tokio::test]
async fn copy_out_of_trash_keeps_the_trash_entry() {
    let (dir, db, _a) = setup();
    let trash_rel = {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
        std::fs::write(format!("{root}/note.txt"), b"dup").unwrap();
        files::delete_to_trash(&conn, "a", "note.txt").unwrap()
    };
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        std::fs::read(dir.path().join("a/inbox/note.txt")).unwrap(),
        b"dup"
    );
    let conn = db.lock().unwrap();
    assert_eq!(files::list_trash(&conn, "a").unwrap().len(), 1);
}

#[tokio::test]
async fn moving_into_trash_is_rejected() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/note.txt"), b"stay").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    assert!(
        manager
            .enqueue("move", "a", "note.txt", "a", ".luna-trash", "user-1")
            .await
            .is_err(),
        "dropping onto a trash path is not a move destination"
    );
}

#[tokio::test]
async fn the_trash_root_is_never_a_job_source() {
    // Copying `.luna-trash` wholesale would hand every member's
    // deletions to whoever holds a drive-root grant; moving it would relocate the whole trash
    // store. Both alias and raw `{prefix}-trash` forms refuse at
    // enqueue, while a specific ENTRY still copies out.
    let (dir, db, _a) = setup();
    let (trash_rel, raw_root) = {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
        std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
        let rel = files::delete_to_trash(&conn, "a", "note.txt").unwrap();
        (rel, trash_dir_name(Path::new(&root)))
    };
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    for kind in ["copy", "move"] {
        for src in [".luna-trash", ".luna-trash/", raw_root.as_str()] {
            assert!(
                manager
                    .enqueue(kind, "a", src, "a", "inbox", "user-1")
                    .await
                    .is_err(),
                "{kind} from {src:?} must be refused"
            );
        }
    }

    // The trash root is no job destination either, raw or alias —
    // already covered for the alias by moving_into_trash_is_rejected.
    assert!(
        manager
            .enqueue("copy", "a", "inbox", "a", &raw_root, "user-1")
            .await
            .is_err()
    );

    // A specific entry still lands under its original name.
    let job = manager
        .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        std::fs::read(dir.path().join("a/inbox/note.txt")).unwrap(),
        b"back"
    );
}

#[tokio::test]
async fn copying_a_renamed_trash_item_uses_the_new_name() {
    let (dir, db, _a) = setup();
    let trash_rel = {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
        std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
        let rel = files::delete_to_trash(&conn, "a", "note.txt").unwrap();
        files::rename(&conn, "a", &rel, "renamed.txt").unwrap();
        // Rename keeps the nonce but swaps the leaf on disk — the old
        // path no longer resolves, so re-list for the new entry name.
        let name = files::list_trash(&conn, "a").unwrap()[0].name.clone();
        format!("{}/{}", files::TRASH_API_ALIAS, name)
    };
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);

    // The item was retitled while in trash — the copy lands under the
    // new name, not the original or the `{nonce}-` storage name.
    assert_eq!(
        std::fs::read(dir.path().join("a/inbox/renamed.txt")).unwrap(),
        b"back"
    );
}

fn wait_done(manager: &JobManager, id: &str) {
    crate::testutil::wait_until(std::time::Duration::from_secs(20), || {
        manager.get(id).unwrap().unwrap().state != "running"
    });
}

#[tokio::test]
async fn cross_drive_copy_produces_verified_bytes() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/note.txt"), b"hello cross-drive").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", "note.txt", "b", "", "user-1")
        .await
        .unwrap();
    assert_eq!(job.state, "running");

    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    let conn = db.lock().unwrap();
    let root = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
    assert_eq!(
        std::fs::read(format!("{root}/note.txt")).unwrap(),
        b"hello cross-drive"
    );
}

#[tokio::test]
async fn private_items_stay_private_through_copies_and_moves() {
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        files::mkdir(&conn, "a", "inbox").unwrap();
        files::mkdir_as(&conn, "a", "Vault", Some("user-1")).unwrap();
        files::create(&conn, "a", "Vault/s.txt").unwrap();
        files::mkdir_as(&conn, "a", "Vault/Theirs", Some("sam")).unwrap();
        files::create(&conn, "a", "Vault/Theirs/t.txt").unwrap();
        files::mkdir_as(&conn, "a", "Vault/Mine", Some("user-1")).unwrap();
        files::create(&conn, "a", "Vault/Mine/m.txt").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let (root_a, root_b) = (dir.path().join("a"), dir.path().join("b"));

    // A copy is private to whoever made it, and leaves out what they can't reach.
    let job = manager
        .enqueue("copy", "a", "Vault", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    let copied = crate::private::item_at(&root_b, "Vault").unwrap();
    assert_eq!(copied.owner, "user-1");
    assert_ne!(
        Some(copied.id),
        crate::private::item_at(&root_a, "Vault").map(|i| i.id)
    );
    assert!(crate::private::item_at(&root_b, "Vault/Mine").is_some());
    assert!(crate::private::item_at(&root_b, "Vault/Theirs").is_none());
    {
        let conn = db.lock().unwrap();
        let names: Vec<_> = files::list_dir(&conn, "b", "Vault")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["Mine", "s.txt"]);
    }

    // A move carries private items the mover can't reach — the boundary
    // and its owner travel unchanged.
    let job = manager
        .enqueue("move", "a", "Vault", "a", "inbox", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert!(crate::private::item_at(&root_a, "Vault").is_none());
    let moved = crate::private::item_at(&root_a, "inbox/Vault").unwrap();
    assert_eq!(moved.owner, "user-1");
    // Someone else's private folder inside kept its boundary and owner.
    let theirs = crate::private::item_at(&root_a, "inbox/Vault/Theirs").unwrap();
    assert_eq!(theirs.owner, "sam");
    assert!(
        root_a
            .join(crate::private::disk_rel(
                &root_a,
                "inbox/Vault/Theirs/t.txt"
            ))
            .exists()
    );

    // Moved alone, a private item keeps its owner and follows to the new path.
    let job = manager
        .enqueue("move", "a", "inbox/Vault/Mine", "a", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert!(crate::private::item_at(&root_a, "inbox/Vault/Mine").is_none());
    let moved = crate::private::item_at(&root_a, "Mine").unwrap();
    assert_eq!(moved.owner, "user-1");
    assert_eq!(
        std::fs::read_to_string(root_a.join(crate::private::disk_rel(&root_a, "Mine/m.txt")))
            .unwrap(),
        ""
    );
}

#[tokio::test]
async fn private_folders_keep_their_row_when_moved_between_drives_and_copies_respect_names() {
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        files::mkdir_as(&conn, "a", "Clash", Some("user-1")).unwrap();
        files::mkdir_as(&conn, "a", "Mover", Some("user-1")).unwrap();
        files::create(&conn, "b", "Clash").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let root_b = dir.path().join("b");
    // An ordinary item already has the name: the private copy must not
    // sit beside it under the same name.
    let clash = manager
        .enqueue("copy", "a", "Clash", "b", "", "user-1")
        .await;
    assert!(matches!(clash, Err(JobError::NameTaken { .. })));
    // Both drives sit on one filesystem, so a rename could succeed; the
    // item still has to arrive with its row on the new drive.
    let job = manager
        .enqueue("move", "a", "Mover", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        crate::private::item_at(&root_b, "Mover").map(|i| i.owner),
        Some("user-1".into())
    );
    let conn = db.lock().unwrap();
    assert!(files::stat(&conn, "b", "Mover").unwrap().private);
}

#[test]
fn private_copy_collision_does_not_remove_an_existing_boundary() {
    let (dir, db, _) = setup();
    let prepared = {
        let conn = db.lock().unwrap();
        files::mkdir_as(&conn, "a", "Folder", Some("user-1")).unwrap();
        let prepared = prepare(
            &conn,
            "copy",
            "a",
            "Folder",
            "b",
            "",
            "user-1",
            OnConflict::Fail,
        )
        .unwrap();
        files::mkdir_as(&conn, "b", "Folder", Some("someone-else")).unwrap();
        files::create(&conn, "b", "Folder/keep.txt").unwrap();
        prepared
    };
    let id = prepared.row.id.clone();
    run_job(
        db.clone(),
        GalleryIndexer::start(),
        prepared,
        Arc::new(AtomicBool::new(false)),
    );
    let conn = db.lock().unwrap();
    assert_eq!(db::get_job(&conn, &id).unwrap().unwrap().state, "error");
    let root = dir.path().join("b");
    assert_eq!(
        crate::private::item_at(&root, "Folder").unwrap().owner,
        "someone-else"
    );
    assert!(
        root.join(crate::private::disk_rel(&root, "Folder/keep.txt"))
            .exists()
    );
}

#[tokio::test]
async fn conflict_is_reported_before_starting() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/x.txt"), b"x").unwrap();
        let root2 = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root2}/x.txt"), b"x").unwrap();
    }
    let manager = JobManager::new(db, crate::gallery::gallery_indexer::GalleryIndexer::start());
    assert!(matches!(
        manager
            .enqueue("copy", "a", "x.txt", "b", "", "user-1")
            .await,
        Err(JobError::NameTaken { .. })
    ));
}

#[tokio::test]
async fn jobs_are_scoped_to_the_owner() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/note.txt"), b"hello").unwrap();
    }
    let manager = JobManager::new(db, crate::gallery::gallery_indexer::GalleryIndexer::start());
    let job = manager
        .enqueue("copy", "a", "note.txt", "b", "", "sam")
        .await
        .unwrap();
    let sam = manager.list_for_user("sam", 50).unwrap();
    assert_eq!(sam.len(), 1);
    assert_eq!(sam[0].id, job.id);
    assert!(manager.list_for_user("max", 50).unwrap().is_empty());
    let admin_all = manager.list(50).unwrap();
    assert_eq!(admin_all.len(), 1);
}

/// A non-admin member holding `caps` on `path` on `drive`.
fn member(conn: &Connection, id: &str, drive: &str, path: &str, caps: crate::access::Caps) {
    if db::get_user(conn, id).unwrap().is_none() {
        db::insert_user(conn, id, id, id, "hash", "member").unwrap();
    }
    db::insert_access_member(
        conn,
        &db::AccessMemberRow {
            id: format!("g-{id}-{drive}"),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: drive.into(),
            path: path.into(),
            album_id: String::new(),
            user_id: id.into(),
            caps,
            created_by: "test".into(),
        },
    )
    .unwrap();
}

#[tokio::test]
async fn job_rechecks_capabilities_when_it_runs() {
    // Enqueue checks nothing by itself — the API gate did — so a job
    // must not execute on stale authorization. A member with no grants
    // reaches the executor and is refused there, not silently copied.
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/note.txt"), b"nope").unwrap();
        db::insert_user(&conn, "evie", "evie", "evie", "hash", "member").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", "note.txt", "b", "", "evie")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "error");
    assert_eq!(done.error, "You no longer have permission to do this.");
    assert!(!dir.path().join("b/note.txt").exists());

    // The same job with live grants runs to completion — the member
    // needs the source read on "a" and the write on "b".
    {
        let conn = db.lock().unwrap();
        member(&conn, "mara", "a", "", crate::access::CAP_ALL);
        member(&conn, "mara", "b", "", crate::access::CAP_ALL);
    }
    let job = manager
        .enqueue("copy", "a", "note.txt", "b", "", "mara")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        std::fs::read(dir.path().join("b/note.txt")).unwrap(),
        b"nope"
    );
}

#[tokio::test]
async fn copy_into_own_subtree_is_rejected() {
    // `a` → `a` or `a` → `a/sub` would copy the destination into itself
    // forever. Rejected at enqueue, on the same drive only.
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/docs/sub")).unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    for (kind, to) in [("copy", "docs"), ("copy", "docs/sub"), ("move", "docs/sub")] {
        assert!(
            manager
                .enqueue(kind, "a", "docs", "a", to, "user-1")
                .await
                .is_err(),
            "{kind} docs -> {to} must be refused"
        );
    }
    // The same nested destination on ANOTHER drive is fine — the trees
    // can't overlap across drives.
    let job = manager
        .enqueue("copy", "a", "docs", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
}

#[tokio::test]
async fn copy_skips_luna_internal_entries() {
    // A `.luna-<uuid>-*` name inside user content is bookkeeping, not
    // content: it must neither count toward the total nor be copied.
    let (dir, db, _a) = setup();
    let internal = {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/docs")).unwrap();
        std::fs::write(format!("{root}/docs/real.txt"), b"real").unwrap();
        let prefix = crate::drives::drive_db::prefix_for(Path::new(&root)).unwrap();
        let internal = format!("{prefix}-upload.fake.part");
        std::fs::write(format!("{root}/docs/{internal}"), b"half").unwrap();
        internal
    };
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", "docs", "b", "", "user-1")
        .await
        .unwrap();
    assert_eq!(job.total, 4, "only real.txt counts toward the total");
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        std::fs::read(dir.path().join("b/docs/real.txt")).unwrap(),
        b"real"
    );
    assert!(!dir.path().join("b/docs").join(&internal).exists());
}

#[tokio::test]
async fn copy_takes_the_forms_own_files_folder_along() {
    // Luna-owned names stay behind, except the files folder that belongs
    // to a form being copied — for a folder of forms and a lone form.
    let (dir, db, _a) = setup();
    let (root_a, root_b) = (dir.path().join("a"), dir.path().join("b"));
    let prefix = crate::drives::drive_db::prefix_for(&root_a).unwrap();
    std::fs::create_dir_all(root_a.join("forms")).unwrap();
    for name in ["one.lunaform", "two.lunaform"] {
        let form = root_a.join("forms").join(name);
        std::fs::write(&form, b"{}").unwrap();
        let own = crate::api::forms::files_dir_for(&root_a, &form).unwrap();
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("pic.png"), b"png").unwrap();
    }
    std::fs::create_dir(root_a.join("forms").join(format!("{prefix}-other"))).unwrap();
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", "forms", "b", "", "user-1")
        .await
        .unwrap();
    assert_eq!(job.total, 4 + 2 * 3, "form files count toward the total");
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    for name in ["one.lunaform", "two.lunaform"] {
        let copy = root_b.join("forms").join(name);
        let own = crate::api::forms::files_dir_for(&root_b, &copy).unwrap();
        assert_eq!(std::fs::read(own.join("pic.png")).unwrap(), b"png");
    }
    let names: Vec<_> = std::fs::read_dir(root_b.join("forms"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 4, "{names:?}");
    assert!(!names.iter().any(|n| n.ends_with("-other")));

    // A single form copied on its own brings its folder too.
    let job = manager
        .enqueue("copy", "a", "forms/one.lunaform", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    let copy = root_b.join("one.lunaform");
    let own = crate::api::forms::files_dir_for(&root_b, &copy).unwrap();
    assert_eq!(std::fs::read(own.join("pic.png")).unwrap(), b"png");
}

#[test]
fn recheck_follows_each_nodes_own_path() {
    // The traversal calls the recheck with the NODE's rel, not the job
    // root's: a grant that dies mid-copy refuses a not-yet-copied child
    // even though the job row still names the granted root.
    let (_dir, db, _a) = setup();
    let conn = db.lock().unwrap();
    let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
    std::fs::create_dir_all(format!("{root}/docs")).unwrap();
    std::fs::create_dir_all(format!("{root}/out")).unwrap();
    member(&conn, "mara", "a", "docs", crate::access::CAP_VIEW);
    db::insert_access_member(
        &conn,
        &db::AccessMemberRow {
            id: "g-mara-out".into(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "a".into(),
            path: "out".into(),
            album_id: String::new(),
            user_id: "mara".into(),
            caps: crate::access::CAP_ALL,
            created_by: "test".into(),
        },
    )
    .unwrap();
    db::insert_job(&conn, "j1", "copy", "a", "docs", "a", "out", 10, "mara").unwrap();
    let row = db::get_job(&conn, "j1").unwrap().unwrap();

    assert!(recheck_job_caps_for(&conn, &row, "docs").is_ok());
    assert!(recheck_job_caps_for(&conn, &row, "docs/inner.txt").is_ok());
    db::delete_access_member(&conn, "g-mara-a").unwrap();
    assert!(matches!(
        recheck_job_caps_for(&conn, &row, "docs/inner.txt"),
        Err(JobError::Denied)
    ));
}

#[test]
fn raw_trash_paths_need_edit_not_view() {
    let (_dir, db, _a) = setup();
    let conn = db.lock().unwrap();
    let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
    std::fs::write(format!("{root}/gone.txt"), b"x").unwrap();
    let api_rel = files::delete_to_trash(&conn, "a", "gone.txt").unwrap();

    // The alias already requires edit…
    assert_eq!(
        job_source_cap(&conn, "copy", "a", &api_rel),
        crate::access::CAP_EDIT
    );
    // …and so does the raw on-disk trash path, which the alias mapping
    // inside caps_on_path would otherwise miss.
    let raw = format!("{}/x", trash_dir_name(Path::new(&root)));
    assert_eq!(
        job_source_cap(&conn, "copy", "a", &raw),
        crate::access::CAP_EDIT
    );
    // Plain content stays at the expected level.
    assert_eq!(
        job_source_cap(&conn, "copy", "a", "docs"),
        crate::access::CAP_VIEW
    );
    assert_eq!(
        job_source_cap(&conn, "move", "a", "docs"),
        crate::access::CAP_EDIT
    );
}

#[tokio::test]
async fn job_paths_land_in_the_canonical_form() {
    // The stored row, the capability check and the bytes all see one
    // spelling — `docs//x.txt` is the same source `docs/x.txt` is, and
    // `..` / `\` never reach the executor.
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root_a = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        let root_b = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root_a}/docs")).unwrap();
        std::fs::write(format!("{root_a}/docs/x.txt"), b"x").unwrap();
        std::fs::create_dir_all(format!("{root_b}/inbox")).unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue("copy", "a", "docs//x.txt", "b", ".//inbox", "user-1")
        .await
        .unwrap();
    assert_eq!(job.from_path, "docs/x.txt");
    assert_eq!(job.to_path, "inbox");
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    assert_eq!(
        std::fs::read(dir.path().join("b/inbox/x.txt")).unwrap(),
        b"x"
    );

    for (from, to) in [
        ("docs/../x.txt", ""),
        ("docs\\x.txt", ""),
        ("docs/x.txt", "..\\"),
    ] {
        assert!(
            manager
                .enqueue("copy", "a", from, "b", to, "user-1")
                .await
                .is_err(),
            "{from} -> {to} must be refused"
        );
    }
}

#[tokio::test]
async fn the_job_queue_is_bounded() {
    // A full queue refuses new work instead of piling up unbounded
    // background copies. Rows stuck at "running" count toward the cap,
    // so jobs that never report back can't grow the queue forever.
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/x.txt"), b"x").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    // Rows that wedge mid-run count toward the cap — a stuck job must not
    // be able to grow the queue forever. (Rows already "running" at boot
    // are marked interrupted by `JobManager::new`, so these are inserted
    // after construction.)
    {
        let conn = db.lock().unwrap();
        for i in 0..MAX_QUEUED_PER_USER {
            db::insert_job(
                &conn,
                &format!("held-{i}"),
                "copy",
                "a",
                "x.txt",
                "b",
                "",
                0,
                "user-1",
            )
            .unwrap();
        }
    }

    // One person's queue slot is full.
    assert!(matches!(
        manager
            .enqueue("copy", "a", "x.txt", "b", "", "user-1")
            .await
            .unwrap_err(),
        JobError::QueueFull
    ));
    // Another person still enqueues — one busy queue must not freeze
    // everyone else.
    let job = manager
        .enqueue("copy", "a", "x.txt", "b", "", "sam")
        .await
        .unwrap();
    wait_done(&manager, &job.id);

    // …until the whole queue hits its ceiling.
    {
        let conn = db.lock().unwrap();
        for i in 0..MAX_QUEUED_JOBS {
            db::insert_job(
                &conn,
                &format!("all-{i}"),
                "copy",
                "a",
                "x.txt",
                "b",
                "",
                0,
                "mara",
            )
            .unwrap();
        }
    }
    assert!(matches!(
        manager
            .enqueue("copy", "a", "x.txt", "b", "", "sam")
            .await
            .unwrap_err(),
        JobError::QueueFull
    ));
}

#[tokio::test]
async fn queued_jobs_drain_through_the_worker_cap() {
    // More enqueues than MAX_RUNNING_JOBS must still all run — the queue
    // hands work to workers as they finish instead of spawning one
    // blocked thread per job.
    let (dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root_a = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        let root_b = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root_b}/inbox")).unwrap();
        for i in 0..MAX_QUEUED_PER_USER {
            std::fs::write(format!("{root_a}/x{i}.txt"), b"x").unwrap();
        }
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let mut jobs = Vec::new();
    for i in 0..MAX_QUEUED_PER_USER {
        jobs.push(
            manager
                .enqueue("copy", "a", &format!("x{i}.txt"), "b", "inbox", "user-1")
                .await
                .unwrap(),
        );
    }
    for job in &jobs {
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
    }
    for i in 0..MAX_QUEUED_PER_USER {
        assert_eq!(
            std::fs::read(dir.path().join(format!("b/inbox/x{i}.txt"))).unwrap(),
            b"x"
        );
    }
}

#[tokio::test]
async fn a_restart_marks_stranded_jobs_interrupted() {
    // Rows left "running" by a crash or power cut must not count against
    // the queue ceiling forever — the first JobManager after boot marks
    // them interrupted and the freed slots take work again.
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/x.txt"), b"x").unwrap();
        for i in 0..MAX_QUEUED_PER_USER {
            db::insert_job(
                &conn,
                &format!("stuck-{i}"),
                "copy",
                "a",
                "x.txt",
                "b",
                "",
                0,
                "user-1",
            )
            .unwrap();
        }
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    {
        let conn = db.lock().unwrap();
        for i in 0..MAX_QUEUED_PER_USER {
            let row = db::get_job(&conn, &format!("stuck-{i}")).unwrap().unwrap();
            assert_eq!(row.state, "interrupted");
        }
    }
    let job = manager
        .enqueue("copy", "a", "x.txt", "b", "", "user-1")
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
}

// ---- The web app's job request, replayed against the real router ---------
// The harness mirrors `api/jobs.rs` and `api/files/http_tests.rs`, which keep
// their own copies.

/// Two adopted drives on different filesystems (`a` on disk, `b` on tmpfs)
/// behind the API router, as the web app reaches them.
fn cross_fs_app() -> Option<(
    tempfile::TempDir,
    tempfile::TempDir,
    axum::Router,
    crate::AppState,
)> {
    use std::os::unix::fs::MetadataExt;
    let shm = PathBuf::from("/dev/shm");
    if std::fs::metadata(&shm).ok()?.dev() == std::fs::metadata(std::env::temp_dir()).ok()?.dev() {
        return None;
    }
    let dir_a = tempfile::tempdir().ok()?;
    let dir_b = tempfile::TempDir::new_in(&shm).ok()?;
    let conn = db::open(&dir_a.path().join("luna.db")).ok()?;
    let root_a = dir_a.path().join("a");
    std::fs::create_dir_all(&root_a).ok()?;
    adopt(&root_a, "a");
    db::upsert_drive(&conn, "a", "A", "as_is", "ext4", "sda", root_a.to_str()?).ok()?;
    let root_b = dir_b.path().join("b");
    std::fs::create_dir_all(&root_b).ok()?;
    adopt(&root_b, "b");
    db::upsert_drive(&conn, "b", "B", "as_is", "ext4", "sdb", root_b.to_str()?).ok()?;
    let drive_manager = std::sync::Arc::new(crate::drives::DriveManager::new(
        crate::drives::mount::shared_mock(),
        dir_a.path(),
    ));
    let state = crate::AppState::new(conn, drive_manager, dir_a.path());
    let app = crate::api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state.clone());
    Some((dir_a, dir_b, app, state))
}

fn api_request(
    method: axum::http::Method,
    uri: &str,
    cookie: Option<&str>,
    csrf: Option<&str>,
    body: Option<&str>,
) -> axum::http::Request<axum::body::Body> {
    let mut builder = axum::http::Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(t) = csrf {
        builder = builder.header("x-csrf-token", t);
    }
    let mut req = builder
        .body(axum::body::Body::from(body.unwrap_or("").to_string()))
        .unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            54321,
        ))));
    req
}

async fn api_send(
    app: &axum::Router,
    req: axum::http::Request<axum::body::Body>,
) -> (
    axum::http::StatusCode,
    axum::http::HeaderMap,
    serde_json::Value,
) {
    use tower::ServiceExt;
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, headers, body)
}

/// Registers the first user (an admin) and logs in. Returns the cookie header
/// and the CSRF token.
async fn api_login(app: &axum::Router) -> (String, String) {
    let (status, _, body) = api_send(
        app,
        api_request(
            axum::http::Method::POST,
            "/api/v1/auth/register",
            None,
            None,
            Some(r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#),
        ),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "register: {body}");
    let (status, headers, body) = api_send(
        app,
        api_request(
            axum::http::Method::POST,
            "/api/v1/auth/login",
            None,
            None,
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        ),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "login: {body}");
    let mut session = String::new();
    let mut csrf = String::new();
    for value in headers.get_all(axum::http::header::SET_COOKIE) {
        let part = value.to_str().unwrap().split(';').next().unwrap_or("");
        if part.starts_with("luna_session=") {
            session = part.to_string();
        } else if let Some(token) = part.strip_prefix("luna_csrf=") {
            csrf = token.to_string();
        }
    }
    (format!("{session}; luna_csrf={csrf}"), csrf)
}

#[tokio::test]
async fn a_cross_drive_folder_move_that_fails_mid_copy_leaves_the_source_whole() {
    use std::os::unix::fs::PermissionsExt;
    let Some((dir_a, dir_b, app, state)) = cross_fs_app() else {
        eprintln!("skip: no distinct /dev/shm filesystem for EXDEV test");
        return;
    };
    let root_a = dir_a.path().join("a");
    let root_b = dir_b.path().join("b");
    std::fs::create_dir(root_a.join("project")).unwrap();
    std::fs::write(root_a.join("project/a.txt"), b"first file").unwrap();
    std::fs::write(root_a.join("project/b.txt"), b"second file").unwrap();
    // The copy walks entries in name order, so c.txt is reached after a.txt
    // and b.txt have landed in the destination. Making it unreadable fails the
    // copy at that point, after bytes have already been written.
    let locked = root_a.join("project/c.txt");
    std::fs::write(&locked, b"third file").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&locked).is_ok() {
        // Privileged users read files whatever their mode, so the failure
        // can't be forced here.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        eprintln!("skip: file modes do not bind this user");
        return;
    }

    let (cookie, csrf) = api_login(&app).await;
    let (status, _, body) = api_send(
        &app,
        api_request(
            axum::http::Method::POST,
            "/api/v1/jobs",
            Some(&cookie),
            Some(&csrf),
            Some(
                r#"{"kind":"move","from_drive":"a","from_path":"project","to_drive":"b","to_path":""}"#,
            ),
        ),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    let id = body["id"].as_str().unwrap().to_string();
    wait_done(&state.job_manager, &id);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();

    let done = state.job_manager.get(&id).unwrap().unwrap();
    assert_eq!(done.state, "error", "{}", done.error);
    assert!(!done.error.is_empty());

    // Every source file is still where it was, with its own bytes.
    assert_eq!(
        std::fs::read(root_a.join("project/a.txt")).unwrap(),
        b"first file"
    );
    assert_eq!(
        std::fs::read(root_a.join("project/b.txt")).unwrap(),
        b"second file"
    );
    assert_eq!(std::fs::read(&locked).unwrap(), b"third file");
    // Nothing was trashed from the source.
    let trash = root_a.join(trash_dir_name(&root_a));
    assert!(
        !trash.exists() || std::fs::read_dir(&trash).unwrap().next().is_none(),
        "a failed move must not trash the source"
    );
    // The partial copy is gone from the destination.
    assert!(
        !root_b.join("project").exists(),
        "partial copy left at the destination"
    );
}

#[tokio::test]
async fn keep_both_saves_beside_the_clash() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/x.txt"), b"new").unwrap();
        let root2 = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root2}/x.txt"), b"old").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let job = manager
        .enqueue_on_conflict(
            "copy",
            "a",
            "x.txt",
            "b",
            "",
            "user-1",
            OnConflict::KeepBoth,
        )
        .await
        .unwrap();
    wait_done(&manager, &job.id);
    let done = manager.get(&job.id).unwrap().unwrap();
    assert_eq!(done.state, "done", "{}", done.error);
    let conn = db.lock().unwrap();
    let root2 = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
    assert_eq!(std::fs::read(format!("{root2}/x.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read(format!("{root2}/x (1).txt")).unwrap(), b"new");
}

#[tokio::test]
async fn a_clash_with_a_folder_reports_it_as_a_folder() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/Folder")).unwrap();
        let root2 = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root2}/Folder")).unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let refused = manager
        .enqueue("copy", "a", "Folder", "b", "", "user-1")
        .await;
    assert!(matches!(
        refused,
        Err(JobError::NameTaken { existing_dir: true })
    ));
}

#[tokio::test]
async fn keep_both_is_refused_for_a_private_item() {
    let (_dir, db, _a) = setup();
    {
        let conn = db.lock().unwrap();
        files::mkdir_as(&conn, "a", "Clash", Some("user-1")).unwrap();
        files::create(&conn, "b", "Clash").unwrap();
    }
    let manager = JobManager::new(
        db.clone(),
        crate::gallery::gallery_indexer::GalleryIndexer::start(),
    );
    let refused = manager
        .enqueue_on_conflict(
            "copy",
            "a",
            "Clash",
            "b",
            "",
            "user-1",
            OnConflict::KeepBoth,
        )
        .await;
    assert!(matches!(refused, Err(JobError::KeepBothUnsupported)));
}

#[test]
fn a_failed_copy_keeps_its_progress_and_says_what_it_removed() {
    let (_dir, db, _a) = setup();
    let (root, root2) = {
        let conn = db.lock().unwrap();
        (
            db::get_drive(&conn, "a").unwrap().unwrap().mount_point,
            db::get_drive(&conn, "b").unwrap().unwrap().mount_point,
        )
    };
    // The copy lists a folder when it reaches it, so a file that is already
    // gone is simply not listed. To fail on a file that vanishes mid-copy,
    // the first file is big enough to keep the copy busy while the second
    // one is removed. The signal is the hidden temp file the copy writes into
    // the destination folder: it appears when the first file starts copying,
    // so the removal lands well before the second file is reached. Watching
    // for the finished name instead would leave no window at all, because a
    // copied file is only renamed into place after it is fully written.
    const FIRST: usize = 64 * 1024 * 1024;
    std::fs::create_dir_all(format!("{root}/docs")).unwrap();
    std::fs::write(format!("{root}/docs/a.txt"), vec![7u8; FIRST]).unwrap();
    std::fs::write(format!("{root}/docs/b.txt"), b"abcde").unwrap();
    let prepared = {
        let conn = db.lock().unwrap();
        prepare(
            &conn,
            "copy",
            "a",
            "docs",
            "b",
            "",
            "user-1",
            OnConflict::Fail,
        )
        .unwrap()
    };
    let id = prepared.row.id.clone();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let started = std::time::Instant::now();
            let dest_docs = std::path::Path::new(&root2).join("docs");
            let copying = || {
                std::fs::read_dir(&dest_docs)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false)
            };
            while !copying() {
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(30),
                    "the copy never started"
                );
                std::thread::sleep(std::time::Duration::from_micros(100));
            }
            std::fs::remove_file(format!("{root}/docs/b.txt")).unwrap();
        });
        run_job(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
            prepared,
            Arc::new(AtomicBool::new(false)),
        );
    });
    let conn = db.lock().unwrap();
    let failed = db::get_job(&conn, &id).unwrap().unwrap();
    assert_eq!(failed.state, "error");
    assert_eq!(
        failed.error,
        "A file disappeared while Luna was copying it. Luna removed the partial copy."
    );
    assert_eq!(
        failed.progress, FIRST as u64,
        "a failed job keeps the bytes it moved"
    );
    assert_eq!(failed.total, FIRST as u64 + 5);
    assert!(!std::path::Path::new(&format!("{root2}/docs")).exists());
}
