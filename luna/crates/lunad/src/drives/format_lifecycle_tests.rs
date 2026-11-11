use std::sync::Arc;

use crate::drives::luks::{Luks, MockLuks};
use crate::drives::mount::{MockMounter, Mounter};
use crate::drives::{DriveManager, format_lifecycle};

#[test]
fn restart_preserves_a_verified_open_encrypted_drive() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let mounter = Arc::new(MockMounter::default());
    let luks = Arc::new(MockLuks::with_luks("/dev/sdb1"));
    let manager = DriveManager::new(mounter.clone(), dir.path()).with_luks(luks.clone());
    let mount = dir.path().join("mounts/drives/d1");
    mounter
        .mount("/dev/mapper/luna-vault-d1", &mount, false)
        .unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    luna_core::marker::write_marker(
        &mount,
        &luna_core::marker::Marker::new("d1", "Photos"),
        &prefix,
    )
    .unwrap();
    luks.open("/dev/sdb1", "d1", "pw").unwrap();
    crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "").unwrap();
    crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
    crate::db::set_drive_locked(&conn, "d1", true).unwrap();
    format_lifecycle::startup(&conn, &manager).unwrap();
    let row = crate::db::get_drive(&conn, "d1").unwrap().unwrap();
    assert!(!row.locked);
    assert_eq!(row.mount_point, mount.to_string_lossy());
    assert!(luks.is_open("d1"));
}

#[test]
fn restart_keeps_interrupted_destructive_format_gated() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let manager = DriveManager::new(Arc::new(MockMounter::default()), dir.path());
    crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "").unwrap();
    conn.execute("INSERT INTO drive_format_operations (id,plan_id,drive_id,device,label,state,phase,destructive_started,encrypted,filesystem) VALUES ('op','plan','d1','sdb','Photos','running','Formatting',1,0,'ext4')", []).unwrap();
    format_lifecycle::startup(&conn, &manager).unwrap();
    assert!(
        crate::db::get_drive(&conn, "d1")
            .unwrap()
            .unwrap()
            .converting
    );
    let state: String = conn
        .query_row(
            "SELECT state FROM drive_format_operations WHERE id='op'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "interrupted");
}

#[test]
fn restart_gates_an_unverified_mounted_mapper_without_claiming_it_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let mounter = Arc::new(MockMounter::default());
    let luks = Arc::new(MockLuks::with_luks("/dev/sdb1"));
    let manager = DriveManager::new(mounter.clone(), dir.path()).with_luks(luks.clone());
    let mount = dir.path().join("mounts/drives/d1");
    mounter
        .mount("/dev/mapper/luna-vault-d1", &mount, false)
        .unwrap();
    luks.open("/dev/sdb1", "d1", "pw").unwrap();
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Photos",
        "as_is",
        "ext4",
        "sdb",
        &mount.to_string_lossy(),
    )
    .unwrap();
    crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
    format_lifecycle::startup(&conn, &manager).unwrap();
    let row = crate::db::get_drive(&conn, "d1").unwrap().unwrap();
    assert!(row.converting);
    assert!(!row.locked);
    assert!(luks.is_open("d1"));
}

#[test]
fn failed_registration_rolls_back_ready_row_and_unmounts() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_registration BEFORE UPDATE OF encrypted ON drives BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").unwrap();
    let mounter = Arc::new(MockMounter::default());
    let manager = DriveManager::new(mounter.clone(), dir.path());
    let result = manager.register_formatted(
        &conn,
        "sdb",
        "sdb1",
        Some("d1"),
        "Photos",
        crate::drives::format::Filesystem::Ext4,
        false,
        "",
    );
    assert!(result.is_err());
    assert!(crate::db::get_drive(&conn, "d1").unwrap().is_none());
    assert!(!mounter.is_mounted(&dir.path().join("mounts/drives/d1")));
}

#[test]
fn formatting_revokes_content_grants_and_stops_backups_but_keeps_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    conn.execute_batch("INSERT INTO access_members (id,subject_kind,drive_id,path,album_id,user_id,caps,created_at) VALUES
        ('root','path','d1','','','user',1,1), ('sub','path','d1','folder','','user',1,1),
        ('album','album','d1','','album','user',1,1), ('other','path','d2','','','user',1,1);
        INSERT INTO access_links (id,token_hash,subject_kind,drive_id,caps,created_by,created_at)
        VALUES ('link','hash','path','d1',1,'admin',1);
        INSERT INTO protections (id,kind,source_drive,source_path,target_drive,created_by,created_at)
        VALUES ('cloud','cloud','d1','','','admin',1), ('drive','drive','d2','','d1','admin',1);
        INSERT INTO cloud_snapshots (id,protection_id,created_at,key_version,tree_pack_id,record)
        VALUES ('snapshot','cloud',1,1,'pack',x'01');").unwrap();
    format_lifecycle::invalidate_formatted_contents(&conn, "d1").unwrap();
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM access_members ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ids, vec!["other", "root"]);
    let links: i64 = conn
        .query_row("SELECT count(*) FROM access_links", [], |r| r.get(0))
        .unwrap();
    let stopped: i64 = conn
        .query_row(
            "SELECT count(*) FROM protections WHERE state='stopped'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let snapshots: i64 = conn
        .query_row(
            "SELECT count(*) FROM cloud_snapshots WHERE id='snapshot'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((links, stopped, snapshots), (0, 2, 1));
}

#[test]
fn failed_quiesce_preserves_dirty_ram_saves_and_reopens_cache() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let manager = Arc::new(DriveManager::new(
        Arc::new(MockMounter::default()),
        dir.path(),
    ));
    let state = crate::AppState::new(conn, manager, dir.path());
    {
        let conn = state.db.lock().unwrap();
        crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "").unwrap();
    }
    state
        .ram_cache
        .accept_dirty("d1", "note", "note", b"pending".to_vec(), false)
        .unwrap();
    assert!(format_lifecycle::quiesce_for_format(&state, "d1").is_err());
    assert_eq!(
        &state.ram_cache.get_dirty("d1", "note").unwrap().bytes[..],
        b"pending"
    );
    assert!(
        state
            .ram_cache
            .accept_dirty("d1", "next", "next", b"more".to_vec(), false)
            .is_ok()
    );
}
