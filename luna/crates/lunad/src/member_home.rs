//! Member home folders: `.luna-<prefix>-members/<username>` on the
//! member-home drive.
//!
//! Every non-admin user gets a private folder no admin can see through Luna.
//! Homes live under one `.luna-<uuid>-members` container per drive — the
//! drive's existing `.luna-<uuid>` namespace, so all hide/reject rules apply
//! for free: members dirs never appear in listings, WebDAV, the index,
//! search, zip archives, or folder totals. Inside the container, each home
//! is named by the member's *username* — paths carry no internal user ids,
//! and extracting the folder yields readable `test/`, `rhea/` directories.
//!
//! Access is decided in `auth::caps_on_path`: the owner holds
//! `CAP_ALL|CAP_SHARE`; everyone else — including admins — sees only what
//! was explicitly shared with them from inside the home, via member rows
//! rooted inside that same home.

use rusqlite::Connection;
use std::path::{Path, PathBuf};

use crate::db::{self, UserRow};
use crate::files::FilesError;

/// The members container name for a drive prefix: `.luna-<uuid>-members`.
pub fn members_dir_name(prefix: &str) -> String {
    format!("{prefix}-members")
}

/// True when a single path segment is a members container
/// `.luna-<uuid>-members` (uuid must be a real UUID — plain `.luna-*`
/// names users made are ordinary files).
fn is_members_dir_name(seg: &str) -> bool {
    seg.ends_with("-members") && luna_core::marker::extract_prefix(seg).is_some()
}

/// True when `rel` is exactly a members container
/// `.luna-<uuid>-members` (a single segment).
pub fn is_members_dir(rel: &str) -> bool {
    !rel.contains('/') && is_members_dir_name(rel)
}

/// True when `rel` addresses inside a member home:
/// `.luna-<uuid>-members/<username>/…` — at least the owner segment.
/// The bare container itself is bookkeeping, not a home.
pub fn is_member_home_path(rel: &str) -> bool {
    let mut segs = rel.split('/');
    segs.next().is_some_and(is_members_dir_name) && segs.next().is_some_and(|s| !s.is_empty())
}

/// The owner *username* of a member-home path — the segment after the
/// members container. Purely lexical; pair with `db::get_user_by_username`
/// to resolve the user.
pub fn owner_username(rel: &str) -> Option<&str> {
    if !is_member_home_path(rel) {
        return None;
    }
    rel.split('/').nth(1)
}

/// True when `rel`'s members container genuinely belongs to `drive_id` —
/// the `<uuid>` in `.luna-<uuid>-members` is this drive's own marker
/// prefix. A container carried in on another Luna's drive (or planted in a
/// drive image) is not this drive's home container: nothing under it maps
/// to a local user's home, so the tree stays sealed for everyone.
pub fn container_matches_drive(conn: &Connection, drive_id: &str, rel: &str) -> bool {
    let Some(first) = rel.split('/').next() else {
        return false;
    };
    if !is_members_dir_name(first) {
        return false;
    }
    let Some(drive) = db::get_drive(conn, drive_id).ok().flatten() else {
        return false;
    };
    if drive.mount_point.trim().is_empty() {
        return false;
    }
    crate::drives::drive_db::prefix_for(Path::new(&drive.mount_point))
        .is_some_and(|prefix| first == members_dir_name(&prefix))
}

/// The owner user-id of a member-home path, resolved through the users
/// table — and only when the container really is `drive_id`'s own (see
/// [`container_matches_drive`]). A home whose username no longer matches a
/// user, or that lives in a foreign container, is nobody's — it stays
/// hidden and unreachable.
pub fn owner_of(conn: &Connection, drive_id: &str, rel: &str) -> Option<String> {
    if !container_matches_drive(conn, drive_id, rel) {
        return None;
    }
    let username = owner_username(rel)?;
    db::get_user_by_username(conn, username)
        .ok()
        .flatten()
        .map(|u| u.id)
}

/// The home-root prefix of a member-home path (`.luna-<uuid>-members/<user>`)
/// — used to confine member-row matching to grants inside the same home.
pub fn home_root_of(rel: &str) -> Option<&str> {
    if !is_member_home_path(rel) {
        return None;
    }
    // End of the second path segment (the username).
    let first_slash = rel.find('/')?;
    let rest = &rel[first_slash + 1..];
    let second_len = rest.find('/').unwrap_or(rest.len());
    Some(&rel[..first_slash + 1 + second_len])
}

/// True when `rel` is exactly a home root (`.luna-<uuid>-members/<user>`).
/// The root cannot be renamed, moved, or deleted through the file API —
/// only migration and user deletion touch it.
pub fn is_home_root(rel: &str) -> bool {
    is_member_home_path(rel) && rel.split('/').count() == 2
}

/// Drive-relative path of `username`'s home on `drive_id`, built from the
/// drive's marker prefix. `None` when the drive is unknown or unmounted —
/// the prefix lives in the marker file, which only exists on a real mount.
pub fn home_rel(conn: &Connection, drive_id: &str, username: &str) -> Option<String> {
    let drive = db::get_drive(conn, drive_id).ok()??;
    if drive.mount_point.is_empty() {
        return None;
    }
    let prefix = crate::drives::drive_db::prefix_for(Path::new(&drive.mount_point))?;
    Some(format!("{}/{username}", members_dir_name(&prefix)))
}

/// A member's resolved home: which drive, which path, whether the folder
/// actually exists on disk right now.
#[derive(Debug, Clone)]
pub struct Home {
    pub drive_id: String,
    /// Empty when the drive can't be read for a prefix right now.
    pub rel: String,
    /// The drive is mounted and the folder exists (or was just created).
    pub ready: bool,
}

/// The drive this member's home effectively lives on: their pinned drive
/// when it is still adopted, the member-home drive otherwise. A merely
/// unmounted drive keeps its claim — homes must not silently split across
/// drives.
fn effective_home_drive(conn: &Connection, user: &UserRow) -> anyhow::Result<Option<String>> {
    if !user.home_drive_id.is_empty()
        && matches!(db::get_drive(conn, &user.home_drive_id), Ok(Some(_)))
    {
        return Ok(Some(user.home_drive_id.clone()));
    }
    db::member_home_drive(conn)
}

/// Resolve the member's home, assigning the member-home drive on first use.
/// Admins have no home (`None`). `None` too when no drive can hold homes.
pub fn resolve(conn: &Connection, user: &UserRow) -> anyhow::Result<Option<Home>> {
    if user.role == "admin" {
        return Ok(None);
    }
    let Some(drive_id) = effective_home_drive(conn, user)? else {
        return Ok(None);
    };
    // A home recorded on a drive Luna no longer knows (unadopted — it can
    // never come back to reclaim the folder) re-pins to the member-home
    // drive.
    if user.home_drive_id != drive_id {
        db::set_user_home_drive(conn, &user.id, &drive_id)?;
    }
    let rel = home_rel(conn, &drive_id, &user.username).unwrap_or_default();
    let ready = !rel.is_empty() && home_dir_exists(conn, &drive_id, &rel);
    Ok(Some(Home {
        drive_id,
        rel,
        ready,
    }))
}

/// Resolve + materialize: creates the home dir on the drive when missing.
/// Used by `/me`, user creation, and `/dav/home` so the member always has
/// somewhere to land when their drive is connected.
pub fn ensure(conn: &Connection, user: &UserRow) -> anyhow::Result<Option<Home>> {
    let Some(mut home) = resolve(conn, user)? else {
        return Ok(None);
    };
    if !home.ready && !home.rel.is_empty() {
        home.ready = ensure_dir(conn, &home.drive_id, &home.rel).unwrap_or(false);
    }
    Ok(Some(home))
}

fn home_dir_exists(conn: &Connection, drive_id: &str, rel: &str) -> bool {
    let Ok(Some(drive)) = db::get_drive(conn, drive_id) else {
        return false;
    };
    if drive.mount_point.is_empty() {
        return false;
    }
    let path = PathBuf::from(&drive.mount_point).join(rel);
    std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// Create the home dir (and the members container when needed) on the
/// drive. Goes through `resolve_for_create_nofollow` so a planted symlink
/// can never steer creation outside the drive.
pub fn ensure_dir(conn: &Connection, drive_id: &str, rel: &str) -> anyhow::Result<bool> {
    let Some(drive) = db::get_drive(conn, drive_id)? else {
        return Ok(false);
    };
    if drive.mount_point.is_empty() {
        return Ok(false);
    }
    let root = Path::new(&drive.mount_point);
    let path =
        luna_core::path::resolve_for_create_nofollow(root, rel).map_err(|e| FilesError::Path(e))?;
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Ok(true),
        Ok(_) => Ok(false), // a file squats on the home name — leave it, report not-ready
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&path)?;
            Ok(true)
        }
        Err(e) => Err(e.into()),
    }
}

/// Is `drive_id` the drive this user's home effectively lives on? Mirrors
/// `resolve`'s effective-drive rule so a member can always see the drive
/// that holds (or will hold) their home.
pub fn home_on_drive(conn: &Connection, user_id: &str, drive_id: &str) -> bool {
    db::get_user(conn, user_id)
        .ok()
        .flatten()
        .and_then(|u| effective_home_drive(conn, &u).ok().flatten())
        .is_some_and(|d| d == drive_id)
}

/// A queued cross-drive home move whose drives are both mounted — handed
/// back for the caller to turn into a move job, then the op row is deleted.
#[derive(Debug)]
pub struct ReadyHomeMove {
    pub op_id: String,
    pub src_drive: String,
    /// The home root rel on the source drive (`<members>/<username>`).
    pub src_rel: String,
    pub dst_drive: String,
    /// The destination members container rel (`<members>`) — the job lands
    /// the home under it, same as the synchronous repin flow.
    pub dst_members: String,
    /// The member the job should repin on completion (`user:` job owner).
    pub user_id: String,
}

/// Work every queued home op whose drives are mounted right now.
///
/// `rename` and `trash` run inline — one fs call plus the subject repath.
/// `move` needs the job manager, so ops with both ends mounted come back
/// for the caller to enqueue (delete the op row once the job exists).
/// Ops whose drive is still away stay queued for the next reconcile.
///
/// Call this with the db lock held, in the same critical section that
/// marks a drive mounted. That ordering is the safety guarantee: no
/// request can resolve or materialize a home path between "drive is up"
/// and "queued renames/trashes applied" — so a deferred trash can never
/// be dodged by a fresh same-name home materializing first.
pub fn reconcile_pending(conn: &Connection) -> anyhow::Result<Vec<ReadyHomeMove>> {
    let mut ready = Vec::new();
    for op in db::list_pending_home_ops(conn)? {
        match op.kind.as_str() {
            "rename" => reconcile_rename(conn, &op),
            "trash" => reconcile_trash(conn, &op),
            "move" => {
                if let Some(m) = ready_move(conn, &op) {
                    ready.push(m);
                }
            }
            _ => {
                let _ = db::delete_pending_home_op(conn, &op.id);
            }
        }
    }
    Ok(ready)
}

fn drive_mounted(conn: &Connection, drive_id: &str) -> Option<db::DriveRow> {
    db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
}

/// `<members>/<old>` → `<members>/<new>` once the drive is back. If the
/// new home somehow materialized first (a request raced the mount hook),
/// fold the old folder in as a `Recovered files` subfolder instead of
/// trashing it — the owner's files stay reachable and stay private.
fn reconcile_rename(conn: &Connection, op: &db::PendingHomeOp) {
    let Some(drive) = db::get_drive(conn, &op.drive_id).ok().flatten() else {
        // Drive unadopted for good — the op can never run.
        let _ = db::delete_pending_home_op(conn, &op.id);
        return;
    };
    if drive.mount_point.is_empty() {
        return; // still away — next reconcile
    }
    let (Some(old_rel), Some(new_rel)) = (
        home_rel(conn, &op.drive_id, &op.username),
        home_rel(conn, &op.drive_id, &op.dst_username),
    ) else {
        return;
    };
    let root = Path::new(&drive.mount_point);
    let from = root.join(&old_rel);
    let to = root.join(&new_rel);
    if !from.exists() {
        // The old folder never materialized — nothing to move, but the
        // subject repath still applies (rows are logical, not fs).
        let _ = crate::access::repath_subjects(conn, &op.drive_id, &old_rel, &new_rel);
        let _ = db::delete_pending_home_op(conn, &op.id);
        return;
    }
    if !to.exists() {
        if std::fs::rename(&from, &to).is_ok() {
            let _ = crate::access::repath_subjects(conn, &op.drive_id, &old_rel, &new_rel);
            let _ = db::delete_pending_home_op(conn, &op.id);
        } else {
            tracing::warn!(drive = %op.drive_id, from = %old_rel, "pending home rename failed; will retry");
        }
        return;
    }
    // Both exist: park the old folder inside the new home.
    let mut leaf = "Recovered files".to_string();
    let mut n = 1u32;
    while to.join(&leaf).exists() {
        n += 1;
        leaf = format!("Recovered files {n}");
    }
    if std::fs::rename(&from, to.join(&leaf)).is_ok() {
        let recovered = format!("{new_rel}/{leaf}");
        let _ = crate::access::repath_subjects(conn, &op.drive_id, &old_rel, &recovered);
        let _ = db::delete_pending_home_op(conn, &op.id);
    } else {
        tracing::warn!(drive = %op.drive_id, from = %old_rel, "pending home rename (recovered) failed; will retry");
    }
}

/// A deleted member's home goes to that drive's trash on remount — same
/// rule as the synchronous delete path, just late. `NotFound` (the home
/// never materialized) counts as done.
fn reconcile_trash(conn: &Connection, op: &db::PendingHomeOp) {
    if db::get_drive(conn, &op.drive_id).ok().flatten().is_none() {
        let _ = db::delete_pending_home_op(conn, &op.id);
        return;
    }
    let Some(rel) = home_rel(conn, &op.drive_id, &op.username) else {
        return; // unmounted still — home_rel needs the marker prefix
    };
    match crate::files::delete_to_trash(conn, &op.drive_id, &rel) {
        Ok(_) => {
            let _ = db::delete_pending_home_op(conn, &op.id);
        }
        Err(FilesError::Path(luna_core::path::PathError::NotFound(_))) => {
            let _ = db::delete_pending_home_op(conn, &op.id);
        }
        Err(e) => {
            tracing::warn!(drive = %op.drive_id, rel = %rel, error = %e, "pending home trash failed; will retry");
        }
    }
}

/// A queued repin is ready when BOTH drives are mounted. Nothing on disk
/// at the source repins the member directly; a real home becomes a move
/// job (which repins `home_drive_id` itself on success). A stale folder
/// at the destination name is parked in that drive's trash first, same as
/// the synchronous repin flow.
fn ready_move(conn: &Connection, op: &db::PendingHomeOp) -> Option<ReadyHomeMove> {
    // Either drive unadopted → the move can never run; drop it (a deletion
    // would have queued a `trash` for anything worth keeping).
    if db::get_drive(conn, &op.drive_id).ok().flatten().is_none()
        || db::get_drive(conn, &op.dst_drive_id)
            .ok()
            .flatten()
            .is_none()
    {
        let _ = db::delete_pending_home_op(conn, &op.id);
        return None;
    }
    if drive_mounted(conn, &op.drive_id).is_none()
        || drive_mounted(conn, &op.dst_drive_id).is_none()
    {
        return None;
    }
    let Some(user) = db::get_user(conn, &op.user_id).ok().flatten() else {
        // Member deleted while the move was queued — the delete already
        // queued a trash op for the source folder.
        let _ = db::delete_pending_home_op(conn, &op.id);
        return None;
    };
    // Use the member's CURRENT username, not the one queued: pending
    // renames run first (queue order), so the folder already bears the
    // new name by the time this move fires.
    let src_rel = home_rel(conn, &op.drive_id, &user.username)?;
    let dst_drive = drive_mounted(conn, &op.dst_drive_id)?;
    let dst_prefix = crate::drives::drive_db::prefix_for(Path::new(&dst_drive.mount_point))?;
    let src_drive = drive_mounted(conn, &op.drive_id)?;
    let src_abs = Path::new(&src_drive.mount_point).join(&src_rel);
    if !src_abs.exists() {
        // No folder ever materialized on the old drive — just repoint.
        let _ = db::set_user_home_drive(conn, &op.user_id, &op.dst_drive_id);
        let _ = db::delete_pending_home_op(conn, &op.id);
        return None;
    }
    if let Some(dst_home) = home_rel(conn, &op.dst_drive_id, &user.username)
        && Path::new(&dst_drive.mount_point).join(&dst_home).exists()
    {
        let _ = crate::files::delete_to_trash(conn, &op.dst_drive_id, &dst_home);
    }
    Some(ReadyHomeMove {
        op_id: op.id.clone(),
        src_drive: op.drive_id.clone(),
        src_rel,
        dst_drive: op.dst_drive_id.clone(),
        dst_members: members_dir_name(&dst_prefix),
        user_id: op.user_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f";

    #[test]
    fn home_path_shapes() {
        let members = members_dir_name(P);
        assert_eq!(members, format!("{P}-members"));
        let home = format!("{members}/test");
        assert!(is_member_home_path(&home));
        assert!(is_member_home_path(&format!("{home}/docs/x.txt")));
        assert!(is_home_root(&home));
        assert!(!is_home_root(&format!("{home}/docs")));
        // The bare container is bookkeeping, not a home.
        assert!(!is_member_home_path(&members));
        assert_eq!(owner_username(&home), Some("test"));
        assert_eq!(home_root_of(&format!("{home}/docs")), Some(home.as_str()));
    }

    #[test]
    fn rejects_non_home_names() {
        for rel in [
            "docs",
            "",
            ".luna-trash/x",
            // Plain .luna-* names users could make are not homes.
            ".luna-members/test",
            ".luna-notes/test",
            // Old-style `.luna-<uid>` homes are dead paths now — a valid uuid
            // with no -members suffix.
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f",
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f/docs",
            ".luna-not-a-uuid-members/test",
        ] {
            assert!(!is_member_home_path(rel), "{rel}");
        }
    }

    /// A data dir + one adopted drive on a tempdir mount. `unmount`/`remount`
    /// flip the drive row's `mount_point` — the same signal the real
    /// reconcile keys on.
    struct Fixture {
        _data: tempfile::TempDir,
        conn: rusqlite::Connection,
        mount: tempfile::TempDir,
        prefix: String,
    }

    fn fixture() -> Fixture {
        let data = tempfile::tempdir().unwrap();
        let conn = db::open(&data.path().join("luna.db")).unwrap();
        let mount = tempfile::tempdir().unwrap();
        let prefix = luna_core::marker::pick_prefix(mount.path()).unwrap();
        crate::drives::drive_db::create(
            mount.path(),
            &luna_core::marker::Marker::new("d1", "Drive"),
            &prefix,
        )
        .unwrap();
        db::upsert_drive(
            &conn,
            "d1",
            "Drive",
            "as_is",
            "ext4",
            "sda",
            mount.path().to_str().unwrap(),
        )
        .unwrap();
        Fixture {
            _data: data,
            conn,
            mount,
            prefix,
        }
    }

    impl Fixture {
        fn unmount(&self) {
            self.conn
                .execute("UPDATE drives SET mount_point = '' WHERE id = 'd1'", [])
                .unwrap();
        }
        fn remount(&self) {
            self.conn
                .execute(
                    "UPDATE drives SET mount_point = ?1 WHERE id = 'd1'",
                    rusqlite::params![self.mount.path().to_str().unwrap()],
                )
                .unwrap();
        }
        fn home_abs(&self, username: &str) -> PathBuf {
            self.mount
                .path()
                .join(members_dir_name(&self.prefix))
                .join(username)
        }
    }

    fn member(conn: &Connection, id: &str, username: &str) {
        db::insert_user(conn, id, username, username, "hash", "member").unwrap();
    }

    #[test]
    fn pending_rename_applies_on_remount() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        assert!(
            ensure(&f.conn, &db::get_user(&f.conn, "u-sam").unwrap().unwrap())
                .unwrap()
                .unwrap()
                .ready
        );
        std::fs::write(f.home_abs("sam").join("note.txt"), b"hi").unwrap();
        // A share rooted inside sam's home follows the rename.
        let shared_rel = format!("{}/sam/docs", members_dir_name(&f.prefix));
        db::insert_access_member(
            &f.conn,
            &db::AccessMemberRow {
                id: "m1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: shared_rel.clone(),
                album_id: String::new(),
                user_id: "u-jo".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "admin".into(),
            },
        )
        .unwrap();
        member(&f.conn, "u-jo", "jo");

        f.unmount();
        db::queue_pending_home_op(&f.conn, "rename", "d1", "sam", "samantha", "", "u-sam").unwrap();
        // While unplugged, reconcile is a no-op.
        assert!(reconcile_pending(&f.conn).unwrap().is_empty());
        assert!(f.home_abs("sam").exists());

        f.remount();
        assert!(reconcile_pending(&f.conn).unwrap().is_empty());
        assert!(!f.home_abs("sam").exists());
        assert!(f.home_abs("samantha").join("note.txt").exists());
        assert!(db::list_pending_home_ops(&f.conn).unwrap().is_empty());
        // The share row repathed to the new home name.
        let rows = db::list_access_members_for_user(&f.conn, "u-jo").unwrap();
        assert!(rows[0].path.contains("samantha"), "{}", rows[0].path);
    }

    #[test]
    fn pending_rename_chains_in_queue_order() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        ensure(&f.conn, &db::get_user(&f.conn, "u-sam").unwrap().unwrap()).unwrap();
        std::fs::write(f.home_abs("sam").join("note.txt"), b"hi").unwrap();

        f.unmount();
        db::queue_pending_home_op(&f.conn, "rename", "d1", "sam", "sally", "", "u-sam").unwrap();
        db::queue_pending_home_op(&f.conn, "rename", "d1", "sally", "sal", "", "u-sam").unwrap();
        f.remount();
        reconcile_pending(&f.conn).unwrap();
        assert!(f.home_abs("sal").join("note.txt").exists());
        assert!(!f.home_abs("sam").exists());
        assert!(!f.home_abs("sally").exists());
        assert!(db::list_pending_home_ops(&f.conn).unwrap().is_empty());
    }

    #[test]
    fn pending_trash_parks_home_on_remount() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        ensure(&f.conn, &db::get_user(&f.conn, "u-sam").unwrap().unwrap()).unwrap();
        std::fs::write(f.home_abs("sam").join("note.txt"), b"hi").unwrap();

        f.unmount();
        db::queue_pending_home_op(&f.conn, "trash", "d1", "sam", "", "", "u-sam").unwrap();
        assert!(reconcile_pending(&f.conn).unwrap().is_empty());
        assert!(f.home_abs("sam").exists());

        f.remount();
        reconcile_pending(&f.conn).unwrap();
        assert!(!f.home_abs("sam").exists());
        let trash = f.mount.path().join(format!("{}-trash", f.prefix));
        let entries: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "the parked home is one trash entry");
        assert!(entries[0].path().join("note.txt").exists());
        assert!(db::list_pending_home_ops(&f.conn).unwrap().is_empty());
    }

    #[test]
    fn pending_move_waits_for_both_drives() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        ensure(&f.conn, &db::get_user(&f.conn, "u-sam").unwrap().unwrap()).unwrap();

        // A second drive, mounted.
        let dst = tempfile::tempdir().unwrap();
        let dst_prefix = luna_core::marker::pick_prefix(dst.path()).unwrap();
        crate::drives::drive_db::create(
            dst.path(),
            &luna_core::marker::Marker::new("d2", "Drive Two"),
            &dst_prefix,
        )
        .unwrap();
        db::upsert_drive(
            &f.conn,
            "d2",
            "Drive Two",
            "as_is",
            "ext4",
            "sdb",
            dst.path().to_str().unwrap(),
        )
        .unwrap();

        f.unmount();
        db::queue_pending_home_op(&f.conn, "move", "d1", "sam", "", "d2", "u-sam").unwrap();
        // Source unplugged → nothing ready.
        assert!(reconcile_pending(&f.conn).unwrap().is_empty());

        f.remount();
        let ready = reconcile_pending(&f.conn).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].src_drive, "d1");
        assert_eq!(ready[0].dst_drive, "d2");
        assert_eq!(ready[0].user_id, "u-sam");
        assert_eq!(ready[0].dst_members, members_dir_name(&dst_prefix));
        // The op row survives until the caller's enqueue succeeds.
        assert_eq!(db::list_pending_home_ops(&f.conn).unwrap().len(), 1);
    }

    #[test]
    fn pending_move_with_no_home_dir_just_repins() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        // No ensure — the home never materialized on d1.
        let dst = tempfile::tempdir().unwrap();
        let dst_prefix = luna_core::marker::pick_prefix(dst.path()).unwrap();
        crate::drives::drive_db::create(
            dst.path(),
            &luna_core::marker::Marker::new("d2", "Drive Two"),
            &dst_prefix,
        )
        .unwrap();
        db::upsert_drive(
            &f.conn,
            "d2",
            "Drive Two",
            "as_is",
            "ext4",
            "sdb",
            dst.path().to_str().unwrap(),
        )
        .unwrap();

        db::queue_pending_home_op(&f.conn, "move", "d1", "sam", "", "d2", "u-sam").unwrap();
        assert!(reconcile_pending(&f.conn).unwrap().is_empty());
        assert_eq!(
            db::get_user(&f.conn, "u-sam")
                .unwrap()
                .unwrap()
                .home_drive_id,
            "d2"
        );
        assert!(db::list_pending_home_ops(&f.conn).unwrap().is_empty());
    }

    #[test]
    fn pending_rename_folds_into_fresh_home() {
        let f = fixture();
        member(&f.conn, "u-sam", "sam");
        ensure(&f.conn, &db::get_user(&f.conn, "u-sam").unwrap().unwrap()).unwrap();
        std::fs::write(f.home_abs("sam").join("note.txt"), b"hi").unwrap();

        f.unmount();
        db::queue_pending_home_op(&f.conn, "rename", "d1", "sam", "samantha", "", "u-sam").unwrap();
        f.remount();
        // The new home materialized before reconcile ran (a request raced
        // the mount hook) — the old folder must fold in, not be trashed.
        std::fs::create_dir_all(f.home_abs("samantha")).unwrap();
        reconcile_pending(&f.conn).unwrap();
        assert!(
            f.home_abs("samantha")
                .join("Recovered files/note.txt")
                .exists()
        );
        assert!(!f.home_abs("sam").exists());
        assert!(db::list_pending_home_ops(&f.conn).unwrap().is_empty());
    }
}
