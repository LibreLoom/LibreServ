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
    assert!(matches!(clash, Err(JobError::Conflict)));
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
        let prepared = prepare(&conn, "copy", "a", "Folder", "b", "", "user-1").unwrap();
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
        Err(JobError::Conflict)
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
