//! Cloud backup operations (plan §5): create, run, delete, and what a person sees.
//! The shape follows `backup::drive_backup`, but the copies live in Luna Connect
//! instead of on a drive.

use anyhow::bail;
use rusqlite::{Connection, params};

use crate::backup::access_list::{self, AccessList};
use crate::backup::cloud::check;
use crate::backup::cloud::identity;
use crate::backup::cloud::keys;
use crate::backup::cloud::private::snapshot_record_ref;
use crate::backup::cloud::private_check;
use crate::backup::cloud::private_run;
use crate::backup::cloud::retention;
use crate::backup::cloud::run::{self, CloudOutcome};
use crate::backup::cloud::store::{CloudStore, StoreError};
use crate::backup::drive_backup::{self, Refused};
use crate::backup::status::{self, BackupState, Record};
use crate::db::{self, ProtectionRow};
use crate::net::connect::ConnectService;

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
    db: &crate::Db,
    connect: &ConnectService,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    source_path: &str,
) -> Result<ProtectionRow, Refused> {
    // A new backup means the account may now have a card, so an earlier refusal stops counting.
    if let Err(err) = clear_card_marker(db) {
        tracing::warn!(error = %err, "could not clear the card marker");
    }
    let norm = crate::access::normalize_subject_path(source_path);

    let existing = {
        let conn = lock(db);
        check_new_backup(&conn, user, source_drive, &norm)?
    };
    if let Some(existing) = existing {
        return Ok(existing);
    }

    // Connect and the drives are reached with no DB lock held.
    identity::load_or_create_connected(db, connect, db::now_unix()).map_err(|err| {
        tracing::error!(error = %err, "could not set up the cloud backup identity");
        Refused(IDENTITY_REFUSAL.to_string())
    })?;

    let conn = lock(db);
    // Another request may have started this backup while the lock was free.
    if let Some(existing) =
        db::find_protection(&conn, db::PROTECTION_CLOUD, source_drive, &norm, "")
            .map_err(|_| save_refused())?
    {
        return Ok(existing);
    }
    let private_owner = private_owner_for(&conn, user, source_drive, &norm)?;
    let access = if private_owner.is_empty() {
        access_list::for_source(&conn, source_drive, &norm).map_err(|_| save_refused())?
    } else {
        // Same as `access_list::for_row` for a private cloud backup: the owner only.
        AccessList {
            users: vec![private_owner.clone()],
            admins: false,
        }
    };
    let access_json = serde_json::to_string(&access).map_err(|_| save_refused())?;
    let id = uuid::Uuid::new_v4().to_string();
    db::insert_protection(
        &conn,
        &db::NewProtection {
            id: &id,
            kind: db::PROTECTION_CLOUD,
            source_drive,
            source_path: &norm,
            target_drive: "",
            private_owner: &private_owner,
            created_by: &user.id,
            created_at: db::now_unix(),
        },
    )
    .map_err(|_| save_refused())?;
    db::set_protection_access(&conn, &id, &access_json).map_err(|_| save_refused())?;
    db::get_protection(&conn, &id)
        .ok()
        .flatten()
        .ok_or_else(save_refused)
}

/// The owner a new backup of `norm` belongs to: the item's owner for a private item, "" for a
/// shared folder. A private item is backed up by its owner only, and a folder inside one is not
/// a backup source on its own (same rules as `drive_backup`).
fn private_owner_for(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    norm: &str,
) -> Result<String, Refused> {
    match access_list::private_source(conn, source_drive, norm) {
        access_list::PrivateSource::Shared => Ok(String::new()),
        access_list::PrivateSource::OwnItem { owner } if owner == user.id => Ok(owner),
        access_list::PrivateSource::OwnItem { .. } => Err(Refused(
            "Only the owner of this private item can back it up.".into(),
        )),
        access_list::PrivateSource::Inside => Err(Refused(
            "Back up the private item itself, not a folder inside it.".into(),
        )),
    }
}

pub const IDENTITY_REFUSAL: &str =
    "Luna could not set up its backup identity. Try again, or contact your Admin.";

fn save_refused() -> Refused {
    Refused("Luna couldn't save this backup. Try again.".to_string())
}

/// The checks before a new cloud backup of `norm` is made. Returns the backup of this folder
/// that already exists, if any, so it is never made twice.
fn check_new_backup(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    norm: &str,
) -> Result<Option<ProtectionRow>, Refused> {
    use crate::access::CAP_VIEW;

    if norm.is_empty() && user.role != "admin" {
        return Err(Refused("Only an Admin can back up a whole drive.".into()));
    }
    if !crate::auth::has_cap(user, conn, source_drive, norm, CAP_VIEW) {
        return Err(Refused(
            "You need Read access to this folder to back it up.".into(),
        ));
    }
    private_owner_for(conn, user, source_drive, norm)?;
    if crate::files::drive_root(conn, source_drive).is_err() {
        return Err(Refused(
            "Luna can't reach this drive. Check that it is connected.".into(),
        ));
    }
    match crate::files::resolve_any(conn, source_drive, norm) {
        Ok((_, meta)) if meta.is_dir() => {}
        Ok(_) => {
            return Err(Refused(
                "Only folders and whole drives can be backed up.".into(),
            ));
        }
        Err(_) => return Err(Refused("Luna can't find this folder.".into())),
    }

    if let Some(existing) = db::find_protection(conn, db::PROTECTION_CLOUD, source_drive, norm, "")
        .map_err(|_| save_refused())?
    {
        return Ok(Some(existing));
    }

    // The creator's own key copy is what lets them see this backup later, so they need a phrase.
    if db::get_user_keys(conn, &user.id)
        .map_err(|_| save_refused())?
        .is_none()
    {
        return Err(Refused(
            "Set up your recovery phrase before you back up to the cloud.".into(),
        ));
    }
    Ok(None)
}

/// Run one cloud backup now, then tidy its old copies. Records the result on
/// the row and returns what happened. A run already in progress is refused.
/// `started_by` is the user who asked for the run, or empty for a scheduled one.
/// `accept_missing` is passed to the run; see `run::run_once`.
pub fn run(
    db: &crate::Db,
    id: &str,
    store: &dyn CloudStore,
    connect: &ConnectService,
    started_by: &str,
    accept_missing: bool,
    now: i64,
) -> CloudOutcome {
    let Some(_slot) = drive_backup::try_hold(id) else {
        return problem_outcome("This backup is copying right now. Try again in a minute.");
    };
    // Send the current recovery keys first. A failure does not stop the copy; it is reported here.
    let users_problem = match publish_users(db, store, connect, now) {
        Ok(()) => None,
        Err(err) => {
            tracing::warn!(error = %err, id, "could not publish the cloud user list");
            Some(USER_LIST_FAILED)
        }
    };
    let private = {
        let conn = lock(db);
        db::get_protection(&conn, id)
            .ok()
            .flatten()
            .is_some_and(|row| !row.private_owner.is_empty())
    };
    let ran = if private {
        // A private item's copy is sealed to its owner's keys, so it has its own run.
        private_run::run_once(db, id, store, accept_missing, now)
    } else {
        run::run_once(db, id, store, started_by, accept_missing, now)
    };
    let mut outcome = match ran {
        Ok(out) if out.problem.is_none() => match tidy(db, id, store, now) {
            Ok(()) => out,
            Err(err) => {
                tracing::warn!(error = %err, id, "could not tidy old cloud copies");
                problem_outcome(
                    "Luna couldn't remove old copies. It will try again on the next run.",
                )
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
        Some(message) if message.contains(CARD_REQUIRED_PREFIX) => {
            db::set_meta(&conn, CARD_MARKER, "1")
        }
        Some(_) => Ok(()),
        None => db::set_meta(&conn, CARD_MARKER, ""),
    }
}

/// Forget an earlier card refusal, so the next run asks Luna Connect again.
fn clear_card_marker(db: &crate::Db) -> anyhow::Result<()> {
    let conn = lock(db);
    db::set_meta(&conn, CARD_MARKER, "")
}

/// True while Luna Connect says this account has no payment card for cloud backups.
pub fn card_on_file(db: &crate::Db) -> bool {
    let conn = lock(db);
    !matches!(db::get_meta(&conn, CARD_MARKER), Ok(Some(v)) if v == "1")
}

/// Send the signed user list and each user's self-sealed key copy to `store`, so Connect can
/// hand them to a browser that needs to check them. Connect keeps the last copy, so a failure
/// here only delays the update until the next run.
pub fn publish_users(
    db: &crate::Db,
    store: &dyn CloudStore,
    connect: &ConnectService,
    now: i64,
) -> anyhow::Result<()> {
    // Connect and the drives are reached with no DB lock held.
    let identity = identity::load_or_create_connected(db, connect, now)?;
    let users = db::list_user_keys(&lock(db))?;
    let listed = users
        .iter()
        .map(|user| {
            let seal_public: super::crypto::SealPublic =
                user.seal_public.as_slice().try_into().map_err(|_| {
                    anyhow::anyhow!("The recovery key for user {} is damaged.", user.user_id)
                })?;
            let auth: super::crypto::SigPublic =
                user.auth_public.as_slice().try_into().map_err(|_| {
                    anyhow::anyhow!("The recovery key for user {} is damaged.", user.user_id)
                })?;
            Ok((
                user.user_id.clone(),
                seal_public,
                auth,
                user.self_sealed.clone(),
            ))
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
pub fn run_all(
    db: &crate::Db,
    store: Option<&dyn CloudStore>,
    connect: &ConnectService,
    now: i64,
) -> bool {
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
                run(db, id, store, connect, "", false, now);
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
    if let Err(err) = retention::retire_old_phrases(db, store, now) {
        tracing::warn!(error = %err, "could not remove old-phrase private backups");
    }
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

/// How many old-phrase private copies `owner` still holds, and when the first of them is due
/// to be removed. `None` when there are none.
pub fn old_phrase_copies(conn: &Connection, owner: &str) -> Option<(usize, i64)> {
    let scopes = db::list_private_scopes(conn, Some(owner)).ok()?;
    let mut count = 0usize;
    let mut earliest: Option<i64> = None;
    for scope in scopes.iter().filter(|s| s.state == "old_phrase") {
        let n = db::private_snapshot_ids(conn, &scope.scope).ok()?.len();
        if n == 0 {
            continue;
        }
        count += n;
        earliest = Some(earliest.map_or(scope.retire_after, |e| e.min(scope.retire_after)));
    }
    if count == 0 {
        return None;
    }
    earliest.map(|at| (count, at))
}

/// Lets `owner`'s old-phrase private copies be removed by the next sweep, rather than
/// waiting out the 30 days.
pub fn retire_old_phrase_now(conn: &Connection, owner: &str, now: i64) -> anyhow::Result<()> {
    for scope in db::list_private_scopes(conn, Some(owner))? {
        if scope.state == "old_phrase" {
            db::set_private_scope_state(conn, &scope.scope, "old_phrase", now)?;
        }
    }
    Ok(())
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
pub(crate) fn record(
    db: &crate::Db,
    id: &str,
    now: i64,
    outcome: &CloudOutcome,
) -> anyhow::Result<()> {
    let conn = lock(db);
    let Some(row) = db::get_protection(&conn, id)? else {
        return Ok(());
    };
    match &outcome.problem {
        None => {
            let access = access_list::for_row(&conn, &row)?;
            db::record_protection_ok(&conn, id, now, &serde_json::to_string(&access)?)?;
        }
        Some(message) => db::record_protection_error(&conn, id, message, false, now)?,
    }
    db::set_meta(
        &conn,
        &source_held_key(id),
        if outcome.source_missing { "1" } else { "" },
    )?;
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
        let (kind, name) = {
            let conn = lock(db);
            snapshot_record_ref(&conn, &snap.id)?
        };
        remote_delete(store, kind, &name)?;
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
    // With no cloud backup left, no run can be refused for a card, so the marker goes too.
    if !db::list_protections(&conn)?
        .iter()
        .any(|p| p.kind == db::PROTECTION_CLOUD)
    {
        db::set_meta(&conn, CARD_MARKER, "")?;
    }
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
        r.kind == db::PROTECTION_CLOUD
            && r.state == db::PROTECTION_ACTIVE
            && r.source_drive == drive_id
            && r.private_owner.is_empty()
    }) {
        if let Err(err) = refresh_access(conn, row) {
            tracing::warn!(error = %err, id = %row.id, "could not update a cloud backup's access");
        }
    }
}

fn refresh_access(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    let access = access_list::for_row(conn, row)?;
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

/// Meta key: "1" while the last run was held because the source looks missing.
fn source_held_key(id: &str) -> String {
    format!("cloud_source_held:{id}")
}

/// True when the last run was held because most of the source looks gone, so the
/// "Back up anyway" choice should be offered again after a reload.
pub fn last_run_source_missing(conn: &Connection, id: &str) -> bool {
    matches!(db::get_meta(conn, &source_held_key(id)), Ok(Some(v)) if v == "1")
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
    let private = {
        let conn = lock(db);
        db::get_protection(&conn, id)?.is_some_and(|row| !row.private_owner.is_empty())
    };
    let report = if private {
        private_check::check(db, id, store, sample, now)?
    } else {
        check::check(db, id, store, sample, now)?
    };
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
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::private::{OLD_PHRASE_GRACE, PSCOPES_KIND, PSNAPSHOTS_KIND};
    use crate::backup::cloud::store::{MemoryStore, Usage};
    use luna_core::marker::{Marker, pick_prefix};
    use std::fs;
    use std::path::PathBuf;

    const NOW: i64 = 1_800_000_000;

    struct Setup {
        _dir: tempfile::TempDir,
        db: crate::Db,
        admin: CurrentUser,
        src: String,
        /// Connect with no device token, so no lookup reaches the network.
        connect: ConnectService,
    }

    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_user(&conn, "admin", "admin", "Admin", "", "admin").unwrap();
        crate::db::set_user_keys(
            &conn,
            &crate::db::UserKeys {
                user_id: "admin".into(),
                seal_public: real_seal_public(5),
                auth_public: real_auth_public(6),
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
            crate::drives::drive_db::create(
                &root,
                &Marker::new(src.to_string(), "Photos"),
                &prefix,
            )
            .unwrap(),
        );
        db::upsert_drive(
            &conn,
            &src,
            "Photos",
            "as_is",
            "ext4",
            &src,
            root.to_str().unwrap(),
        )
        .unwrap();
        fs::write(root.join("Docs").join("a.txt"), "hello").unwrap();
        let connect = ConnectService::new(&dir.path().join("connect"), None);
        Setup {
            connect,
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
        create(&s.db, &s.connect, &s.admin, &s.src, "Docs")
            .unwrap()
            .id
    }

    #[test]
    fn whole_drive_is_admin_only() {
        let s = setup();
        let member = CurrentUser {
            id: "member".into(),
            username: "member".into(),
            role: "member".into(),
        };
        let err = create(&s.db, &s.connect, &member, &s.src, "").unwrap_err();
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
        crate::db::delete_user_keys(&lock(&s.db), "admin").unwrap();
        let err = create(&s.db, &s.connect, &s.admin, &s.src, "Docs")
            .err()
            .unwrap();
        assert_eq!(
            err.0,
            "Set up your recovery phrase before you back up to the cloud."
        );
        crate::db::set_user_keys(
            &lock(&s.db),
            &crate::db::UserKeys {
                user_id: "admin".into(),
                seal_public: real_seal_public(5),
                auth_public: real_auth_public(6),
                self_sealed: vec![3; 48],
                phrase_set_at: 2,
                last_checked_at: 0,
            },
        )
        .unwrap();
        assert!(create(&s.db, &s.connect, &s.admin, &s.src, "Docs").is_ok());
    }

    #[test]
    fn without_connect_each_backup_says_so() {
        let s = setup();
        let id = make_backup(&s);
        run_all(&s.db, None, &s.connect, NOW);
        let conn = lock(&s.db);
        let row = db::get_protection(&conn, &id).unwrap().unwrap();
        assert_eq!(row.last_error, NOT_SET_UP);
    }

    #[test]
    fn a_held_run_is_remembered_until_a_later_run_clears_it() {
        let s = setup();
        let id = make_backup(&s);
        let held = CloudOutcome {
            problem: Some("The source looks missing or unplugged.".into()),
            source_missing: true,
            ..CloudOutcome::default()
        };
        record(&s.db, &id, NOW, &held).unwrap();
        assert!(last_run_source_missing(&lock(&s.db), &id));

        // A different failure is not the source hold, so the choice goes away.
        let other = CloudOutcome {
            problem: Some(NOT_SET_UP.into()),
            ..CloudOutcome::default()
        };
        record(&s.db, &id, NOW + 1, &other).unwrap();
        assert!(!last_run_source_missing(&lock(&s.db), &id));

        record(&s.db, &id, NOW + 2, &held).unwrap();
        record(&s.db, &id, NOW + 3, &CloudOutcome::default()).unwrap();
        assert!(!last_run_source_missing(&lock(&s.db), &id));
    }

    /// A store whose user-list writes are refused, to check that the copy still runs.
    struct ListRefused(MemoryStore);

    impl CloudStore for ListRefused {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
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
                return Err(StoreError::Unavailable(
                    "Could not reach Luna Connect.".into(),
                ));
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
                seal_public: real_seal_public(1),
                auth_public: real_auth_public(2),
                self_sealed: b"sealed copy".to_vec(),
                phrase_set_at: NOW,
                last_checked_at: 0,
            },
        )
        .unwrap();
        drop(conn);
        let store = MemoryStore::new();

        publish_users(&s.db, &store, &s.connect, NOW).unwrap();

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

        let outcome = run(&s.db, &id, &store, &s.connect, "", false, NOW);
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert_eq!(store.0.list_records("snapshots").unwrap().len(), 1);
    }

    /// A store that refuses every copy the way Luna Connect does for an account with no card.
    struct NoCard(MemoryStore);

    const NO_CARD_MSG: &str = "Add a payment card at connect.luna.libreloom.org so we can store your cloud backup. It costs $8 per terabyte each month.";

    impl CloudStore for NoCard {
        fn put_pack(
            &self,
            _id: &[u8; 32],
            _scope: Option<&str>,
            _bytes: &[u8],
        ) -> Result<(), StoreError> {
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

        let refused = run(
            &s.db,
            &id,
            &NoCard(MemoryStore::new()),
            &s.connect,
            "",
            false,
            NOW,
        );
        assert!(
            refused
                .problem
                .as_deref()
                .unwrap_or("")
                .contains(CARD_REQUIRED_PREFIX),
            "{refused:?}"
        );
        assert!(!card_on_file(&s.db));

        let ok = run(&s.db, &id, &MemoryStore::new(), &s.connect, "", false, NOW);
        assert_eq!(ok.problem, None);
        assert!(card_on_file(&s.db));
    }

    #[test]
    fn creating_a_backup_clears_an_old_card_refusal() {
        let s = setup();
        db::set_meta(&lock(&s.db), CARD_MARKER, "1").unwrap();
        assert!(!card_on_file(&s.db));
        make_backup(&s);
        assert!(card_on_file(&s.db));
    }

    #[test]
    fn deleting_the_last_cloud_backup_clears_the_card_refusal() {
        let s = setup();
        let id = make_backup(&s);
        db::set_meta(&lock(&s.db), CARD_MARKER, "1").unwrap();
        delete(&s.db, &id, &MemoryStore::new(), NOW).unwrap();
        assert!(card_on_file(&s.db));
    }

    #[test]
    fn deleting_one_of_two_cloud_backups_keeps_the_card_refusal() {
        let s = setup();
        let first = make_backup(&s);
        fs::create_dir_all(s._dir.path().join(&s.src).join("Pics")).unwrap();
        create(&s.db, &s.connect, &s.admin, &s.src, "Pics").unwrap();
        db::set_meta(&lock(&s.db), CARD_MARKER, "1").unwrap();
        delete(&s.db, &first, &MemoryStore::new(), NOW).unwrap();
        assert!(!card_on_file(&s.db));
    }

    #[test]
    fn other_refusals_leave_the_card_marker_alone() {
        let s = setup();
        let id = make_backup(&s);
        run(
            &s.db,
            &id,
            &NoCard(MemoryStore::new()),
            &s.connect,
            "",
            false,
            NOW,
        );
        assert!(!card_on_file(&s.db));

        let outcome = run(
            &s.db,
            &id,
            &ListRefused(MemoryStore::new()),
            &s.connect,
            "",
            false,
            NOW,
        );
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert!(!card_on_file(&s.db));
    }

    #[test]
    fn run_then_delete_removes_remote_copies() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();

        let outcome = run(&s.db, &id, &store, &s.connect, "", false, NOW);
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

    const DAY: i64 = 24 * 60 * 60;

    /// An owner and an Admin, both with recovery-phrase keys, and a drive with a Luna marker.
    /// The private-item disk layout is installed, as it is on a running drive.
    struct PrivateSetup {
        _dir: tempfile::TempDir,
        db: crate::Db,
        owner: CurrentUser,
        admin: CurrentUser,
        root: PathBuf,
        connect: ConnectService,
    }

    /// A real sealing public key (X25519 and ML-KEM), which the run code checks before sealing to it.
    fn real_seal_public(seed: u8) -> Vec<u8> {
        crypto::derive(&[seed; 16], "luna-test")
            .seal_public
            .to_vec()
    }

    /// A real signing public key (Ed25519 and ML-DSA) for a recovery phrase made of `seed` bytes.
    fn real_auth_public(seed: u8) -> Vec<u8> {
        crypto::derive(&[seed; 16], "luna-test")
            .auth_public
            .to_vec()
    }

    fn owner_keys(seed: u8) -> db::UserKeys {
        let keys = crypto::derive(&[seed; 16], "luna-test");
        db::UserKeys {
            user_id: "owner".into(),
            seal_public: keys.seal_public.to_vec(),
            auth_public: keys.auth_public.to_vec(),
            self_sealed: vec![3; 48],
            phrase_set_at: 1,
            last_checked_at: 0,
        }
    }

    fn private_setup() -> PrivateSetup {
        crate::private::install();
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "member").unwrap();
        db::insert_user(&conn, "admin", "admin", "Admin", "x", "admin").unwrap();
        identity::load_or_create(&conn, 1).unwrap();
        db::set_user_keys(&conn, &owner_keys(7)).unwrap();
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: "admin".into(),
                seal_public: real_seal_public(5),
                auth_public: real_auth_public(6),
                self_sealed: vec![3; 48],
                phrase_set_at: 1,
                last_checked_at: 0,
            },
        )
        .unwrap();
        let root = dir.path().join("drive-src");
        fs::create_dir_all(&root).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(
                &root,
                &Marker::new("drive-src".to_string(), "Photos"),
                &prefix,
            )
            .unwrap(),
        );
        db::upsert_drive(
            &conn,
            "drive-src",
            "Photos",
            "as_is",
            "ext4",
            "drive-src",
            root.to_str().unwrap(),
        )
        .unwrap();
        let connect = ConnectService::new(&dir.path().join("connect"), None);
        PrivateSetup {
            _dir: dir,
            db: crate::Db::new(conn),
            owner: CurrentUser {
                id: "owner".into(),
                username: "owner".into(),
                role: "member".into(),
            },
            admin: CurrentUser {
                id: "admin".into(),
                username: "admin".into(),
                role: "admin".into(),
            },
            root,
            connect,
        }
    }

    /// Make `path` (a folder in the drive root) a private item of the owner, holding one file.
    /// The folder moves to its disk name, as a private item lives on disk; its disk path is returned.
    fn private_item(s: &PrivateSetup, path: &str) -> PathBuf {
        let shown = s.root.join(path);
        fs::create_dir_all(&shown).unwrap();
        fs::write(shown.join("a.txt"), "hello").unwrap();
        crate::private::create(&s.root, path, "owner").unwrap();
        let disk = s.root.join(crate::private::disk_rel(&s.root, path));
        fs::rename(&shown, &disk).unwrap();
        disk
    }

    fn private_backup(s: &PrivateSetup, path: &str) -> String {
        create(&s.db, &s.connect, &s.owner, "drive-src", path)
            .unwrap()
            .id
    }

    fn active_scope(db: &crate::Db) -> String {
        db::active_private_scope(&lock(db), "owner")
            .unwrap()
            .unwrap()
            .scope
    }

    fn snapshot_count(db: &crate::Db, scope: &str) -> usize {
        db::private_snapshot_ids(&lock(db), scope).unwrap().len()
    }

    fn rotate_owner_keys(s: &PrivateSetup) {
        db::set_user_keys(&lock(&s.db), &owner_keys(8)).unwrap();
    }

    #[test]
    fn owner_creates_a_private_cloud_backup() {
        let s = private_setup();
        private_item(&s, "Docs");
        let row = create(&s.db, &s.connect, &s.owner, "drive-src", "Docs").unwrap();
        assert_eq!(row.private_owner, "owner");
        assert_eq!(row.kind, db::PROTECTION_CLOUD);
        let stored = db::get_protection(&lock(&s.db), &row.id).unwrap().unwrap();
        assert_eq!(stored.private_owner, "owner");
    }

    #[test]
    fn admin_is_refused_on_someone_elses_private_item() {
        let s = private_setup();
        private_item(&s, "Docs");
        // The Admin has no Read access to a private item, so the Read check refuses first;
        // the owner-only message is not reached for an Admin.
        let err = create(&s.db, &s.connect, &s.admin, "drive-src", "Docs")
            .err()
            .unwrap();
        assert_eq!(err.0, "You need Read access to this folder to back it up.");
    }

    #[test]
    fn inside_is_refused() {
        let s = private_setup();
        let disk = private_item(&s, "Docs");
        fs::create_dir_all(disk.join("Inner")).unwrap();
        let err = create(&s.db, &s.connect, &s.owner, "drive-src", "Docs/Inner")
            .err()
            .unwrap();
        assert_eq!(
            err.0,
            "Back up the private item itself, not a folder inside it."
        );
    }

    #[test]
    fn private_run_goes_through_private_run() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        let out = run(&s.db, &id, &store, &s.connect, "owner", false, NOW);
        assert_eq!(out.problem, None);
        assert!(store.list_records("snapshots").unwrap().is_empty());
        assert_eq!(store.list_records(PSNAPSHOTS_KIND).unwrap().len(), 1);
        assert_eq!(store.list_records(PSCOPES_KIND).unwrap().len(), 1);
    }

    #[test]
    fn two_private_items_share_a_scope_and_deleting_one_keeps_the_other() {
        let s = private_setup();
        private_item(&s, "Docs");
        private_item(&s, "Notes");
        let docs = private_backup(&s, "Docs");
        let notes = private_backup(&s, "Notes");
        let store = MemoryStore::new();
        assert_eq!(
            run(&s.db, &docs, &store, &s.connect, "owner", false, NOW).problem,
            None
        );
        assert_eq!(
            run(&s.db, &notes, &store, &s.connect, "owner", false, NOW + 1).problem,
            None
        );
        let scope = active_scope(&s.db);
        assert_eq!(snapshot_count(&s.db, &scope), 2);

        delete(&s.db, &docs, &store, NOW + 2).unwrap();
        sweep(&s.db, &store, NOW + 2 + 2 * DAY);
        sweep(&s.db, &store, NOW + 2 + 3 * DAY);
        assert_eq!(snapshot_count(&s.db, &scope), 1);

        let report = check(&s.db, &notes, &store, check::Sample::All, NOW + 3 * DAY).unwrap();
        assert_eq!(report.problem, None);
        assert!(
            report.missing_packs.is_empty(),
            "{:?}",
            report.missing_packs
        );
    }

    #[test]
    fn old_phrase_versions_wait_30_days() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, NOW).problem,
            None
        );
        let old = active_scope(&s.db);

        rotate_owner_keys(&s);
        let t2 = NOW + DAY;
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, t2).problem,
            None
        );
        assert_ne!(active_scope(&s.db), old);

        let retire_at = t2 + OLD_PHRASE_GRACE;
        sweep(&s.db, &store, retire_at - 1);
        assert_eq!(
            snapshot_count(&s.db, &old),
            1,
            "old copies must stay until 30 days"
        );

        sweep(&s.db, &store, retire_at);
        assert_eq!(snapshot_count(&s.db, &old), 0);
        let left: Vec<String> = store
            .list_records(PSNAPSHOTS_KIND)
            .unwrap()
            .into_iter()
            .filter(|name| name.starts_with(&format!("{old}.")))
            .collect();
        assert!(left.is_empty(), "{left:?}");

        // Their packs wait the normal 24 hours, then the scope's own record goes.
        sweep(&s.db, &store, retire_at + DAY + 1);
        assert!(store.get_record(PSCOPES_KIND, &old).unwrap().is_none());
    }

    #[test]
    fn retire_old_phrase_now_lets_the_next_sweep_remove_them() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, NOW).problem,
            None
        );
        let old = active_scope(&s.db);
        rotate_owner_keys(&s);
        let t2 = NOW + DAY;
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, t2).problem,
            None
        );
        assert_eq!(snapshot_count(&s.db, &old), 1);

        assert_eq!(
            old_phrase_copies(&lock(&s.db), "owner"),
            Some((1, t2 + OLD_PHRASE_GRACE))
        );
        retire_old_phrase_now(&lock(&s.db), "owner", t2).unwrap();
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), Some((1, t2)));
        sweep(&s.db, &store, t2 + 1);
        assert_eq!(snapshot_count(&s.db, &old), 0);
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);
    }

    #[test]
    fn old_phrase_copies_counts_copies_and_the_earliest_wait() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, NOW).problem,
            None
        );
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);

        rotate_owner_keys(&s);
        let t2 = NOW + DAY;
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, "owner", false, t2).problem,
            None
        );
        assert_eq!(
            old_phrase_copies(&lock(&s.db), "owner"),
            Some((1, t2 + OLD_PHRASE_GRACE))
        );
        assert_eq!(old_phrase_copies(&lock(&s.db), "admin"), None);

        sweep(&s.db, &store, t2 + OLD_PHRASE_GRACE);
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);
    }

    #[test]
    fn on_grants_changed_leaves_private_rows_alone() {
        let s = private_setup();
        fs::create_dir_all(s.root.join("Shared")).unwrap();
        fs::write(s.root.join("Shared").join("a.txt"), "hello").unwrap();
        let shared = create(&s.db, &s.connect, &s.admin, "drive-src", "Shared")
            .unwrap()
            .id;
        private_item(&s, "Docs");
        let private = private_backup(&s, "Docs");
        {
            let conn = lock(&s.db);
            db::set_protection_access(&conn, &shared, "stale").unwrap();
            db::set_protection_access(&conn, &private, "keep-me").unwrap();
        }
        on_grants_changed(&lock(&s.db), "drive-src");
        let conn = lock(&s.db);
        assert_ne!(
            db::get_protection(&conn, &shared)
                .unwrap()
                .unwrap()
                .access_json,
            "stale"
        );
        assert_eq!(
            db::get_protection(&conn, &private)
                .unwrap()
                .unwrap()
                .access_json,
            "keep-me"
        );
    }
}
