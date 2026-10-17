//! Cloud backup operations (plan §5): create, run, delete, and what a person sees.
//! The shape follows `backup::drive_backup`, but the copies live in Luna Connect
//! instead of on a drive.

use anyhow::bail;
use rusqlite::{params, Connection};

use crate::backup::access_list::{self, AccessList};
use crate::backup::cloud::check;
use crate::backup::cloud::identity;
use crate::backup::cloud::keys;
use crate::backup::cloud::retention;
use crate::backup::cloud::run::{self, CloudOutcome};
use crate::backup::cloud::store::{CloudStore, StoreError};
use crate::backup::drive_backup::{self, Refused};
use crate::backup::status::{self, BackupState, Record};
use crate::db::{self, ProtectionRow};

/// Shown on every cloud backup while Luna Connect is not set up for this Luna.
pub const NOT_SET_UP: &str =
    "Connect this Luna to Luna Connect to use cloud backups. Settings → Luna Connect.";

const UNREACHABLE: &str = "Could not reach Luna Connect. Check your connection, then try again.";

/// Record kinds in the store (private in `keys`, so mirrored here).
const KEYS_RECORD_KIND: &str = "keys";
const RECIPIENTS_RECORD_KIND: &str = "recipients";
/// Record kind for each user's self-sealed signing key copy (one record per user).
const USER_RECORD_KIND: &str = "self";
const USER_LIST_FAILED: &str =
    "Luna couldn't send your recovery keys to Luna Connect. It will try again on the next backup.";
/// Start of the message Luna Connect sends with a 402 when the account has no payment card.
/// `StoreError::Rejected` keeps only the message, so the status code is matched through it.
const CARD_REQUIRED_PREFIX: &str = "Add a payment card at connect.luna.libreloom.org";
/// Account-wide meta key: "1" while the last cloud run was refused for a missing card, "" otherwise.
const CARD_MARKER: &str = "cloud_payment_required";

fn lock(db: &crate::Db) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

fn deleted_key(id: &str) -> String {
    format!("deleted_backup:{id}")
}

fn problem_outcome(message: &str) -> CloudOutcome {
    CloudOutcome {
        problem: Some(message.to_string()),
        ..CloudOutcome::default()
    }
}

/// Start a cloud backup of `source_path` on `source_drive` for `user`. Same
/// rules as a drive backup for who may start one (plan §2): Read on the
/// source, Admin for a whole drive, never a source inside a private item.
/// One cloud backup per folder: an existing one is returned as is.
pub fn create(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    source_path: &str,
) -> Result<ProtectionRow, Refused> {
    use crate::access::CAP_VIEW;

    let db_refused = || Refused("Luna couldn't save this backup. Try again.".to_string());
    let norm = crate::access::normalize_subject_path(source_path);

    if norm.is_empty() && user.role != "admin" {
        return Err(Refused("Only an Admin can back up a whole drive.".into()));
    }
    if !crate::auth::has_cap(user, conn, source_drive, &norm, CAP_VIEW) {
        return Err(Refused(
            "You need Read access to this folder to back it up.".into(),
        ));
    }
    if crate::auth::inside_private(conn, source_drive, &norm) {
        return Err(Refused(
            "Private items can't be backed up to the cloud.".into(),
        ));
    }
    if crate::files::drive_root(conn, source_drive).is_err() {
        return Err(Refused(
            "Luna can't reach this drive. Check that it is connected.".into(),
        ));
    }
    match crate::files::resolve_any(conn, source_drive, &norm) {
        Ok((_, meta)) if meta.is_dir() => {}
        Ok(_) => {
            return Err(Refused(
                "Only folders and whole drives can be backed up.".into(),
            ))
        }
        Err(_) => return Err(Refused("Luna can't find this folder.".into())),
    }

    if let Some(existing) =
        db::find_protection(conn, db::PROTECTION_CLOUD, source_drive, &norm, "")
            .map_err(|_| db_refused())?
    {
        return Ok(existing);
    }

    // The creator's own key copy is what lets them see this backup later, so they need a phrase.
    if db::get_user_keys(conn, &user.id).map_err(|_| db_refused())?.is_none() {
        return Err(Refused(
            "Set up your recovery phrase before you back up to the cloud.".into(),
        ));
    }
    identity::load_or_create(conn, db::now_unix()).map_err(|_| db_refused())?;
    let access = access_list::for_source(conn, source_drive, &norm).map_err(|_| db_refused())?;
    let access_json = serde_json::to_string(&access).map_err(|_| db_refused())?;
    let id = uuid::Uuid::new_v4().to_string();
    db::insert_protection(
        conn,
        &db::NewProtection {
            id: &id,
            kind: db::PROTECTION_CLOUD,
            source_drive,
            source_path: &norm,
            target_drive: "",
            private_owner: "",
            created_by: &user.id,
            created_at: db::now_unix(),
        },
    )
    .map_err(|_| db_refused())?;
    db::set_protection_access(conn, &id, &access_json).map_err(|_| db_refused())?;
    db::get_protection(conn, &id)
        .ok()
        .flatten()
        .ok_or_else(db_refused)
}

/// Run one cloud backup now, then tidy its old copies. Records the result on
/// the row and returns what happened. A run already in progress is refused.
/// `started_by` is the user who asked for the run, or empty for a scheduled one.
pub fn run(db: &crate::Db, id: &str, store: &dyn CloudStore, started_by: &str, now: i64) -> CloudOutcome {
    let Some(_slot) = drive_backup::try_hold(id) else {
        return problem_outcome("This backup is copying right now. Try again in a minute.");
    };
    // Send the current recovery keys first. A failure does not stop the copy; it is reported here.
    let users_problem = match publish_users(db, store, now) {
        Ok(()) => None,
        Err(err) => {
            tracing::warn!(error = %err, id, "could not publish the cloud user list");
            Some(USER_LIST_FAILED)
        }
    };
    let mut outcome = match run::run_once(db, id, store, started_by, now) {
        Ok(out) if out.problem.is_none() => match tidy(db, id, store, now) {
            Ok(()) => out,
            Err(err) => {
                tracing::warn!(error = %err, id, "could not tidy old cloud copies");
                problem_outcome("Luna couldn't remove old copies. It will try again on the next run.")
            }
        },
        Ok(out) => out,
        Err(err) => problem_outcome(&err.to_string()),
    };
    if let Some(users_problem) = users_problem {
        outcome.problem = Some(match outcome.problem.take() {
            Some(problem) => format!("{problem} {users_problem}"),
            None => users_problem.to_string(),
        });
    }
    if let Err(err) = note_card_marker(db, outcome.problem.as_deref()) {
        tracing::warn!(error = %err, "could not record the payment card state");
    }
    if let Err(err) = record(db, id, now, &outcome) {
        tracing::warn!(error = %err, id, "could not record a cloud backup run");
    }
    outcome
}

/// Set the card marker when Luna Connect refused a run for a missing card, and clear it on a
/// clean run. A run that failed for another reason leaves it as it was.
fn note_card_marker(db: &crate::Db, problem: Option<&str>) -> anyhow::Result<()> {
    let conn = lock(db);
    match problem {
        Some(message) if message.contains(CARD_REQUIRED_PREFIX) => db::set_meta(&conn, CARD_MARKER, "1"),
        Some(_) => Ok(()),
        None => db::set_meta(&conn, CARD_MARKER, ""),
    }
}

/// True while Luna Connect says this account has no payment card for cloud backups.
pub fn card_on_file(db: &crate::Db) -> bool {
    let conn = lock(db);
    !matches!(db::get_meta(&conn, CARD_MARKER), Ok(Some(v)) if v == "1")
}

/// Send the signed user list and each user's self-sealed key copy to `store`, so Connect can
/// hand them to a browser that needs to check them. Connect keeps the last copy, so a failure
/// here only delays the update until the next run.
pub fn publish_users(db: &crate::Db, store: &dyn CloudStore, now: i64) -> anyhow::Result<()> {
    let (identity, users) = {
        let conn = lock(db);
        (identity::load_or_create(&conn, now)?, db::list_user_keys(&conn)?)
    };
    let listed = users
        .iter()
        .map(|user| {
            let x25519: [u8; 32] = user.x25519_public.as_slice().try_into().map_err(|_| {
                anyhow::anyhow!("The recovery key for user {} is damaged.", user.user_id)
            })?;
            let auth: [u8; 32] = user.auth_public.as_slice().try_into().map_err(|_| {
                anyhow::anyhow!("The recovery key for user {} is damaged.", user.user_id)
            })?;
            Ok((user.user_id.clone(), x25519, auth, user.self_sealed.clone()))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    keys::publish_user_list(store, identity.signer(), identity.luna_id(), &listed)?;
    for user in &users {
        store.put_record(
            USER_RECORD_KIND,
            &keys::user_record_part(&user.user_id),
            &user.self_sealed,
        )?;
    }
    Ok(())
}

/// Run every active cloud backup, then tidy every pack scope. `store` is `None`
/// when Luna Connect is not set up: each backup records that problem instead.
/// True when any backup's state changed (so the health cache must be refreshed).
pub fn run_all(db: &crate::Db, store: Option<&dyn CloudStore>, now: i64) -> bool {
    let before = active_states(db, now);
    match store {
        None => {
            for (id, _) in &before {
                if let Err(err) = record(db, id, now, &problem_outcome(NOT_SET_UP)) {
                    tracing::warn!(error = %err, id, "could not record a cloud backup problem");
                }
            }
        }
        Some(store) => {
            for (id, _) in &before {
                // Scheduled runs have no user who started them.
                run(db, id, store, "", now);
            }
            sweep(db, store, now);
        }
    }
    active_states(db, now) != before
}

/// Drop the copies this backup's retention rules no longer keep, then delete
/// packs in each of its scopes that nothing uses.
fn tidy(db: &crate::Db, id: &str, store: &dyn CloudStore, now: i64) -> anyhow::Result<()> {
    let scopes = {
        let conn = lock(db);
        scopes_of(&conn, Some(id))?
    };
    for scope in scopes {
        retention::thin(db, id, &scope, store, now)?;
    }
    Ok(())
}

/// Packs nothing uses any more in any scope are marked and later deleted. This
/// also finishes the pack clean-up of backups deleted earlier.
fn sweep(db: &crate::Db, store: &dyn CloudStore, now: i64) {
    let scopes = {
        let conn = lock(db);
        scopes_of(&conn, None)
    };
    match scopes {
        Ok(scopes) => {
            for scope in scopes {
                if let Err(err) = retention::thin(db, "", &scope, store, now) {
                    tracing::warn!(error = %err, "could not tidy cloud packs");
                }
            }
        }
        Err(err) => tracing::warn!(error = %err, "could not list cloud pack scopes"),
    }
}

/// Every pack scope a backup (or all backups, when `None`) has written to.
fn scopes_of(conn: &Connection, protection_id: Option<&str>) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT scope FROM cloud_runs
         WHERE ?1 IS NULL OR protection_id = ?1 ORDER BY scope",
    )?;
    let scopes = stmt
        .query_map(params![protection_id], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(scopes)
}

fn active_states(db: &crate::Db, now: i64) -> Vec<(String, BackupState)> {
    let conn = lock(db);
    db::list_protections(&conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.kind == db::PROTECTION_CLOUD && r.state == db::PROTECTION_ACTIVE)
        .map(|r| (r.id.clone(), state(&r, now)))
        .collect()
}

/// Save a run's result on the row: a success refreshes the access list too.
fn record(db: &crate::Db, id: &str, now: i64, outcome: &CloudOutcome) -> anyhow::Result<()> {
    let conn = lock(db);
    let Some(row) = db::get_protection(&conn, id)? else {
        return Ok(());
    };
    match &outcome.problem {
        None => {
            let access = access_list::for_source(&conn, &row.source_drive, &row.source_path)?;
            db::record_protection_ok(&conn, id, now, &serde_json::to_string(&access)?)?;
        }
        Some(message) => db::record_protection_error(&conn, id, message, false, now)?,
    }
    Ok(())
}

/// Delete a cloud backup and its copies in Luna Connect. The copies go first:
/// if Luna Connect can't be reached, nothing local is removed and the person
/// can try again. Refuses while a run is copying.
pub fn delete(db: &crate::Db, id: &str, store: &dyn CloudStore, now: i64) -> anyhow::Result<()> {
    let Some(_slot) = drive_backup::try_hold(id) else {
        bail!("This backup is copying right now. Try again in a minute.");
    };
    let scopes = {
        let conn = lock(db);
        if db::get_protection(&conn, id)?.is_none() {
            bail!("This backup no longer exists.");
        }
        scopes_of(&conn, Some(id))?
    };

    let snapshots = {
        let conn = lock(db);
        db::list_cloud_snapshots(&conn, id)?
    };
    for snap in snapshots {
        remote_delete(store, "snapshots", &snap.id)?;
        let conn = lock(db);
        db::delete_cloud_snapshot(&conn, &snap.id)?;
    }

    // Key and recipient records are named "<backup id>.…". The kinds match
    // `keys::KEYS_KIND` and `keys::RECIPIENTS_KIND`.
    let prefix = format!("{id}.");
    for kind in [KEYS_RECORD_KIND, RECIPIENTS_RECORD_KIND] {
        let names = store.list_records(kind).map_err(unreachable)?;
        for name in names.iter().filter(|n| n.starts_with(&prefix)) {
            remote_delete(store, kind, name)?;
        }
    }

    // Packs in each scope: unused ones start their wait, old ones are deleted.
    for scope in &scopes {
        retention::thin(db, id, scope, store, now)?;
    }

    let conn = lock(db);
    db::delete_protection(&conn, id)?;
    db::set_meta(&conn, &deleted_key(id), &now.to_string())?;
    conn.execute(
        "DELETE FROM backup_keys WHERE protection_id = ?1",
        params![id],
    )?;
    Ok(())
}

fn remote_delete(store: &dyn CloudStore, kind: &str, name: &str) -> anyhow::Result<()> {
    match store.delete_record(kind, name) {
        Ok(()) | Err(StoreError::NotFound) => Ok(()),
        Err(_) => bail!(UNREACHABLE),
    }
}

fn unreachable(_: StoreError) -> anyhow::Error {
    anyhow::anyhow!(UNREACHABLE)
}

/// What a person sees for a cloud backup now. Stopped and source-gone backups
/// are final, not failures, so they never show as Stale.
pub fn state(row: &ProtectionRow, now: i64) -> BackupState {
    let rec = Record {
        last_ok_at: row.last_ok_at,
        failing_since: row.failing_since,
        last_error: &row.last_error,
        hard: row.hard,
        since: row.created_at,
    };
    match status::state(rec, now) {
        BackupState::Stale if row.state == "stopped" || row.state == "source_gone" => {
            BackupState::Ok
        }
        other => other,
    }
}

/// Whether `user` may see this backup: the members the access list names,
/// and admins when it allows them.
pub fn visible_to(row: &ProtectionRow, user: &crate::auth::CurrentUser) -> bool {
    let access: AccessList = if row.access_json.trim().is_empty() {
        AccessList::default()
    } else {
        serde_json::from_str(&row.access_json).unwrap_or_default()
    };
    access.allows(&user.id, user.role == "admin")
}

/// Access to a folder changed. Re-saves the access list of every active cloud
/// backup of that drive's folders, when it actually changed. Key versions
/// change on the next run (`keys::ensure_key`).
pub fn on_grants_changed(conn: &Connection, drive_id: &str) {
    let rows = match db::list_protections(conn) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(error = %err, "could not list cloud backups after an access change");
            return;
        }
    };
    for row in rows.iter().filter(|r| {
        r.kind == db::PROTECTION_CLOUD && r.state == db::PROTECTION_ACTIVE && r.source_drive == drive_id
    }) {
        if let Err(err) = refresh_access(conn, row) {
            tracing::warn!(error = %err, id = %row.id, "could not update a cloud backup's access");
        }
    }
}

fn refresh_access(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    let access = access_list::for_source(conn, &row.source_drive, &row.source_path)?;
    let json = serde_json::to_string(&access)?;
    if json != row.access_json {
        db::set_protection_access(conn, &row.id, &json)?;
    }
    Ok(())
}

/// Meta key for the last check's problem, empty when the check found nothing.
fn check_key(id: &str) -> String {
    format!("cloud_check:{id}")
}

/// Bytes stored in the cloud for this backup: the live packs of every scope it
/// writes to. Packs are shared inside a scope, so this can count bytes that
/// another backup of the same folder also uses.
pub fn size(conn: &Connection, id: &str) -> u64 {
    let scopes = scopes_of(conn, Some(id)).unwrap_or_default();
    let mut total: i64 = 0;
    for scope in scopes {
        total += conn
            .query_row(
                "SELECT COALESCE(SUM(size), 0) FROM cloud_packs
                 WHERE scope = ?1 AND state = 'live'",
                params![scope],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);
    }
    total.max(0) as u64
}

/// The problem the last check found, if it found one.
pub fn last_check_problem(conn: &Connection, id: &str) -> Option<String> {
    db::get_meta(conn, &check_key(id))
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// Check one cloud backup against the store and save the result on the row.
pub fn check(
    db: &crate::Db,
    id: &str,
    store: &dyn CloudStore,
    sample: check::Sample,
    now: i64,
) -> anyhow::Result<check::CheckReport> {
    let report = check::check(db, id, store, sample, now)?;
    let conn = lock(db);
    db::record_protection_checked(&conn, id, now)?;
    db::set_meta(
        &conn,
        &check_key(id),
        report.problem.as_deref().unwrap_or(""),
    )?;
    Ok(report)
}

/// Check every active cloud backup once (a few random packs each). Logs and
/// moves on when one check cannot finish, so one bad backup never stops the rest.
pub fn check_all(db: &crate::Db, store: &dyn CloudStore, now: i64) {
    let ids: Vec<String> = {
        let conn = lock(db);
        db::list_protections(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.kind == db::PROTECTION_CLOUD && r.state == db::PROTECTION_ACTIVE)
            .map(|r| r.id)
            .collect()
    };
    for id in ids {
        if let Err(err) = check(db, &id, store, check::Sample::Random(4), now) {
            tracing::warn!(error = %err, id, "could not check a cloud backup");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::CurrentUser;
    use crate::backup::cloud::store::{MemoryStore, Usage};
    use luna_core::marker::{pick_prefix, Marker};
    use std::fs;
    use std::path::PathBuf;

    const NOW: i64 = 1_800_000_000;

    struct Setup {
        _dir: tempfile::TempDir,
        db: crate::Db,
        admin: CurrentUser,
        src: String,
    }

    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_user(&conn, "admin", "admin", "Admin", "", "admin").unwrap();
        crate::db::set_user_keys(
            &conn,
            &crate::db::UserKeys {
                user_id: "admin".into(),
                x25519_public: vec![5; 32],
                auth_public: vec![6; 32],
                self_sealed: vec![3; 48],
                phrase_set_at: 1,
                last_checked_at: 0,
            },
        )
        .unwrap();
        let src = "drive-src".to_string();
        let root: PathBuf = dir.path().join(&src);
        fs::create_dir_all(root.join("Docs")).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(&root, &Marker::new(src.to_string(), "Photos"), &prefix)
                .unwrap(),
        );
        db::upsert_drive(&conn, &src, "Photos", "as_is", "ext4", &src, root.to_str().unwrap())
            .unwrap();
        fs::write(root.join("Docs").join("a.txt"), "hello").unwrap();
        Setup {
            _dir: dir,
            db: crate::Db::new(conn),
            admin: CurrentUser {
                id: "admin".into(),
                username: "admin".into(),
                role: "admin".into(),
            },
            src,
        }
    }

    fn make_backup(s: &Setup) -> String {
        let conn = lock(&s.db);
        create(&conn, &s.admin, &s.src, "Docs").unwrap().id
    }

    #[test]
    fn whole_drive_is_admin_only() {
        let s = setup();
        let member = CurrentUser {
            id: "member".into(),
            username: "member".into(),
            role: "member".into(),
        };
        let conn = lock(&s.db);
        let err = create(&conn, &member, &s.src, "").unwrap_err();
        assert!(err.0.contains("Only an Admin"), "{}", err.0);
    }

    #[test]
    fn create_returns_existing_backup_for_same_folder() {
        let s = setup();
        let first = make_backup(&s);
        assert_eq!(make_backup(&s), first);
    }

    #[test]
    fn create_needs_the_creators_recovery_phrase() {
        let s = setup();
        let conn = lock(&s.db);
        crate::db::delete_user_keys(&conn, "admin").unwrap();
        let err = create(&conn, &s.admin, &s.src, "Docs").err().unwrap();
        assert_eq!(err.0, "Set up your recovery phrase before you back up to the cloud.");
        crate::db::set_user_keys(
            &conn,
            &crate::db::UserKeys {
                user_id: "admin".into(),
                x25519_public: vec![5; 32],
                auth_public: vec![6; 32],
                self_sealed: vec![3; 48],
                phrase_set_at: 2,
                last_checked_at: 0,
            },
        )
        .unwrap();
        assert!(create(&conn, &s.admin, &s.src, "Docs").is_ok());
    }

    #[test]
    fn without_connect_each_backup_says_so() {
        let s = setup();
        let id = make_backup(&s);
        run_all(&s.db, None, NOW);
        let conn = lock(&s.db);
        let row = db::get_protection(&conn, &id).unwrap().unwrap();
        assert_eq!(row.last_error, NOT_SET_UP);
    }

    /// A store whose user-list writes are refused, to check that the copy still runs.
    struct ListRefused(MemoryStore);

    impl CloudStore for ListRefused {
        fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
            self.0.put_pack(id, scope, bytes)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.0.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.0.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            if kind == "users" || kind == USER_RECORD_KIND {
                return Err(StoreError::Unavailable("Could not reach Luna Connect.".into()));
            }
            self.0.put_record(kind, name, bytes)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.0.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.0.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.0.list_records(kind)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.0.usage()
        }
    }

    #[test]
    fn publish_users_sends_the_signed_list_and_each_self_copy() {
        let s = setup();
        let conn = lock(&s.db);
        let signer = identity::load_or_create(&conn, NOW).unwrap();
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: "admin".into(),
                x25519_public: vec![1; 32],
                auth_public: vec![2; 32],
                self_sealed: b"sealed copy".to_vec(),
                phrase_set_at: NOW,
                last_checked_at: 0,
            },
        )
        .unwrap();
        drop(conn);
        let store = MemoryStore::new();

        publish_users(&s.db, &store, NOW).unwrap();

        let list = store.get_record("users", "list").unwrap().unwrap();
        assert!(keys::verify_user_list(&list, &signer.public(), signer.luna_id()).is_some());
        let copy = store
            .get_record(USER_RECORD_KIND, &keys::user_record_part("admin"))
            .unwrap();
        assert_eq!(copy.as_deref(), Some(&b"sealed copy"[..]));
    }

    #[test]
    fn a_refused_user_list_is_reported_but_the_copy_still_runs() {
        let s = setup();
        let id = make_backup(&s);
        let store = ListRefused(MemoryStore::new());

        let outcome = run(&s.db, &id, &store, "", NOW);
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert_eq!(store.0.list_records("snapshots").unwrap().len(), 1);
    }

    /// A store that refuses every copy the way Luna Connect does for an account with no card.
    struct NoCard(MemoryStore);

    const NO_CARD_MSG: &str = "Add a payment card at connect.luna.libreloom.org so we can store your cloud backup. It costs $8 per terabyte each month.";

    impl CloudStore for NoCard {
        fn put_pack(&self, _id: &[u8; 32], _scope: Option<&str>, _bytes: &[u8]) -> Result<(), StoreError> {
            Err(StoreError::Rejected(NO_CARD_MSG.into()))
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.0.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.0.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            self.0.put_record(kind, name, bytes)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.0.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.0.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.0.list_records(kind)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.0.usage()
        }
    }

    #[test]
    fn a_missing_card_clears_card_on_file_and_a_clean_run_sets_it_back() {
        let s = setup();
        let id = make_backup(&s);
        assert!(card_on_file(&s.db), "no run yet: nothing refused");

        let refused = run(&s.db, &id, &NoCard(MemoryStore::new()), "", NOW);
        assert!(refused.problem.as_deref().unwrap_or("").contains(CARD_REQUIRED_PREFIX), "{refused:?}");
        assert!(!card_on_file(&s.db));

        let ok = run(&s.db, &id, &MemoryStore::new(), "", NOW);
        assert_eq!(ok.problem, None);
        assert!(card_on_file(&s.db));
    }

    #[test]
    fn other_refusals_leave_the_card_marker_alone() {
        let s = setup();
        let id = make_backup(&s);
        run(&s.db, &id, &NoCard(MemoryStore::new()), "", NOW);
        assert!(!card_on_file(&s.db));

        let outcome = run(&s.db, &id, &ListRefused(MemoryStore::new()), "", NOW);
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert!(!card_on_file(&s.db));
    }

    #[test]
    fn run_then_delete_removes_remote_copies() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();

        let outcome = run(&s.db, &id, &store, "", NOW);
        assert_eq!(outcome.problem, None);
        assert_eq!(store.list_records("snapshots").unwrap().len(), 1);
        {
            let conn = lock(&s.db);
            let row = db::get_protection(&conn, &id).unwrap().unwrap();
            assert_eq!(row.last_ok_at, NOW);
        }

        delete(&s.db, &id, &store, NOW).unwrap();
        assert!(store.list_records("snapshots").unwrap().is_empty());
        assert!(store.list_records(KEYS_RECORD_KIND).unwrap().is_empty());
        let conn = lock(&s.db);
        assert!(db::get_protection(&conn, &id).unwrap().is_none());
        assert!(db::get_meta(&conn, &deleted_key(&id)).unwrap().is_some());
    }

    #[test]
    fn delete_refuses_while_copying() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        let _hold = drive_backup::try_hold(&id).unwrap();
        let err = delete(&s.db, &id, &store, NOW).unwrap_err();
        assert!(err.to_string().contains("copying right now"), "{err}");
    }

    #[test]
    fn visible_only_to_listed_members_and_admins() {
        let row = ProtectionRow {
            id: "p".into(),
            kind: db::PROTECTION_CLOUD.into(),
            source_drive: "d".into(),
            source_path: String::new(),
            target_drive: String::new(),
            private_owner: String::new(),
            created_by: "admin".into(),
            created_at: NOW,
            state: db::PROTECTION_ACTIVE.into(),
            stop_reason: String::new(),
            access_json: r#"{"users":["alice"],"admins":true}"#.into(),
            last_ok_at: 0,
            last_error: String::new(),
            hard: false,
            failing_since: 0,
            last_checked_at: 0,
            first_done: false,
            notes: String::new(),
        };
        let alice = CurrentUser {
            id: "alice".into(),
            username: "alice".into(),
            role: "member".into(),
        };
        let bob = CurrentUser {
            id: "bob".into(),
            username: "bob".into(),
            role: "member".into(),
        };
        assert!(visible_to(&row, &alice));
        assert!(!visible_to(&row, &bob));
    }
}
