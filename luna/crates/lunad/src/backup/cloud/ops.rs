//! Cloud backup operations (plan §5): create, run, delete, and what a person sees.
//! The shape follows `backup::drive_backup`, but the copies live in Luna Connect
//! instead of on a drive.

use anyhow::bail;
use rusqlite::{Connection, params};

use crate::backup::access_list::{self, AccessList};
use crate::backup::cloud::check;
use crate::backup::cloud::identity;
use crate::backup::cloud::keys;
use crate::backup::cloud::private::{self, snapshot_record_ref};
use crate::backup::cloud::private_check;
use crate::backup::cloud::private_run;
use crate::backup::cloud::retention;
use crate::backup::cloud::run::{self, CloudOutcome};
use crate::backup::cloud::source;
use crate::backup::cloud::store::{CloudStore, StoreError};
use crate::backup::drive_backup::{self, Refused};
use crate::backup::status::{self, BackupState, Record};
use crate::db::{self, ProtectionRow};
use crate::net::connect::ConnectService;

/// Shown on every cloud backup while Luna Connect is not set up for this Luna.
pub const NOT_SET_UP: &str =
    "Connect this Luna to Luna Connect in Settings → About → Advanced to use cloud backups.";

const REMOTE_DELETE_FAILED: &str =
    "Luna could not delete the cloud copies in Luna Connect. Try again.";

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
/// Why a new cloud backup is refused while Luna Connect has no active payment card.
pub const NO_PAYMENT_REFUSAL: &str =
    "Add a payment card at Luna Connect (connect.luna.libreloom.org), then start the cloud backup.";

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

/// Why a stopped backup is not run, in the person's own words when it has them.
fn stopped_message(row: &ProtectionRow) -> String {
    let reason = row.stop_reason.trim();
    if reason.is_empty() {
        "This backup is stopped.".to_string()
    } else {
        reason.to_string()
    }
}

/// Why a private cloud backup must not run now, if it must not. Its folder has to still be the
/// owner's private item, and the owner has to still be allowed to change it: a restore writes
/// this row from what a browser sent, so the row alone is not proof.
fn private_source_problem(conn: &Connection, row: &ProtectionRow) -> Option<String> {
    if row.private_owner.is_empty() {
        return None;
    }
    if let Some(reason) = access_list::private_stop_reason(conn, row) {
        return Some(reason.to_string());
    }
    // An unplugged drive gives no answer here; the run itself reports the missing source.
    let mounted = db::get_drive(conn, &row.source_drive)
        .ok()
        .flatten()
        .is_some_and(|d| !d.mount_point.is_empty());
    if !mounted {
        return None;
    }
    // A deleted owner is already said in words by the run itself.
    let owner = db::get_user(conn, &row.private_owner).ok().flatten()?;
    let owner = crate::auth::CurrentUser {
        id: owner.id,
        username: owner.username,
        role: owner.role,
    };
    if crate::auth::has_cap(
        &owner,
        conn,
        &row.source_drive,
        &row.source_path,
        crate::access::CAP_EDIT,
    ) {
        None
    } else {
        Some(
            "This backup's folder is no longer yours to back up. Delete the backup and start it again."
                .to_string(),
        )
    }
}

/// Start a cloud backup of `source_path` on `source_drive` for `user`. Same
/// rules as a drive backup for who may start one (plan §2): Read on the
/// source, Admin for a whole drive, and a private item or a folder inside one
/// is the owner's to back up.
/// One cloud backup per folder: an existing one is returned as is.
pub fn create(
    db: &crate::Db,
    connect: &ConnectService,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    source_path: &str,
) -> Result<ProtectionRow, Refused> {
    // Luna Connect would refuse every copy, so don't start a backup that can only sit paused.
    if connect.is_connect_active() && !connect.backup_unlocked() {
        return Err(Refused(NO_PAYMENT_REFUSAL.to_string()));
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

/// The owner a new backup of `norm` belongs to: the item's owner for a private item or a folder
/// inside one, "" for a shared folder. Only the owner may back it up (same rules as `drive_backup`).
fn private_owner_for(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    norm: &str,
) -> Result<String, Refused> {
    match access_list::private_source(conn, source_drive, norm) {
        access_list::PrivateSource::Shared => Ok(String::new()),
        access_list::PrivateSource::PrivateTrash => {
            Err(Refused("Items in the trash can't be backed up.".into()))
        }
        other => match other.owner() {
            Some(owner) if owner == user.id => Ok(owner.to_string()),
            _ => Err(Refused(
                "Only the owner of this private item can back it up.".into(),
            )),
        },
    }
}

pub const IDENTITY_REFUSAL: &str =
    "Luna couldn't set up cloud backup. Try again, or contact your Admin.";

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
    let owner = private_owner_for(conn, user, source_drive, norm)?;
    match crate::files::drive_root(conn, source_drive) {
        Ok(_) => {}
        Err(crate::files::FilesError::Erasing) => {
            return Err(Refused(crate::files::DRIVE_ERASING_MSG.into()));
        }
        Err(_) => {
            return Err(Refused(
                "Luna can't reach this drive. Check that it is connected.".into(),
            ));
        }
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

    // A backup of a parent folder already holds this folder.
    let probe = db::ProtectionRow::probe(db::PROTECTION_CLOUD, source_drive, norm, "", &owner);
    if let Some((_, message)) = drive_backup::covered_by(conn, &probe) {
        return Err(Refused(message));
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
/// `manual` is true for "Back up now", which always makes a snapshot. A scheduled run passes false
/// and makes none when nothing changed.
pub fn run(
    db: &crate::Db,
    id: &str,
    store: &dyn CloudStore,
    connect: &ConnectService,
    manual: bool,
    now: i64,
) -> CloudOutcome {
    // D7 budgets the nothing-changed run; `uploaded_bytes` tells which one this was.
    let mut perf = crate::perf::Timer::new("D7", "backup.cloud");
    let out = run_untimed(db, id, store, connect, manual, now);
    if perf.active() {
        perf.field("files", out.files);
        perf.field("uploaded_bytes", out.uploaded_bytes);
        perf.field("reused_chunks", out.reused_chunks);
        perf.field("busy", out.busy);
        perf.field("problem", out.problem.is_some());
    }
    out
}

fn run_untimed(
    db: &crate::Db,
    id: &str,
    store: &dyn CloudStore,
    connect: &ConnectService,
    manual: bool,
    now: i64,
) -> CloudOutcome {
    let Some(_slot) = drive_backup::try_hold(db, id) else {
        return CloudOutcome {
            busy: true,
            ..problem_outcome("This backup is busy right now. Try again in a minute.")
        };
    };
    // A stopped backup is final until someone starts it again, and a private backup's folder
    // must still be the owner's own: a restore writes that row from what a browser sent, so the
    // row on its own is not proof.
    let (row, root) = {
        let conn = lock(db);
        let Some(row) = db::get_protection(&conn, id).ok().flatten() else {
            return problem_outcome("This backup no longer exists.");
        };
        if !matches!(
            row.state.as_str(),
            db::PROTECTION_ACTIVE | db::PROTECTION_SOURCE_GONE
        ) {
            return problem_outcome(&stopped_message(&row));
        }
        let root = source::resolve(&conn, &row);
        (row, root)
    };
    let root = match root {
        Ok(root) => root,
        Err(unavailable) => {
            let outcome = unavailable
                .record(db, id)
                .unwrap_or_else(|err| problem_outcome(&err.to_string()));
            if let Err(err) = record(db, id, now, &outcome) {
                tracing::warn!(error = %err, id, "could not record a cloud backup problem");
            }
            return outcome;
        }
    };
    let source_problem = private_source_problem(&lock(db), &row);
    if let Some(problem) = source_problem {
        return problem_outcome(&problem);
    }
    // A backup of a parent folder already holds these files. Nothing is recorded, so this
    // backup starts again on its own if that parent backup stops or goes away.
    {
        let conn = lock(db);
        if let Some(row) = db::get_protection(&conn, id).ok().flatten()
            && let Some((_, message)) = drive_backup::covered_by(&conn, &row)
        {
            return problem_outcome(&message);
        }
    }
    // Confirm the signing key once before either kind of backup uploads anything.
    if let Err(err) = run_identity(db, connect, now) {
        let outcome = problem_outcome(&err.to_string());
        if let Err(err) = record(db, id, now, &outcome) {
            tracing::warn!(error = %err, id, "could not record a cloud backup problem");
        }
        return outcome;
    }
    // Send the current recovery keys first. A failure does not stop the copy; it is reported here.
    let users_problem = match publish_users(db, store) {
        Ok(()) => None,
        Err(err) => {
            tracing::warn!(error = %err, id, "could not publish the recovery key copies");
            Some(USER_LIST_FAILED)
        }
    };
    let ran = if !row.private_owner.is_empty() {
        // A private item's copy is sealed to its owner's keys, so it has its own run.
        private_run::run_from_folder(db, id, root, store, manual, now)
    } else {
        run::run_from_folder(db, id, root, store, manual, now)
    };
    // A move or re-seal holds the backup's lock: skip quietly. Nothing is recorded, so the
    // backup is not shown as failing, and the next run tries again.
    if matches!(&ran, Ok(out) if out.busy) {
        return ran.unwrap_or_default();
    }
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
    // Luna Connect refused for a missing card: say so now instead of at the next status pull.
    if outcome
        .problem
        .as_deref()
        .is_some_and(|p| p.contains(CARD_REQUIRED_PREFIX))
    {
        connect.mark_backup_locked();
    }
    if let Err(err) = record(db, id, now, &outcome) {
        tracing::warn!(error = %err, id, "could not record a cloud backup run");
    }
    outcome
}

fn run_identity(
    db: &crate::Db,
    connect: &ConnectService,
    now: i64,
) -> anyhow::Result<identity::Identity> {
    let identity = identity::load_or_create(&lock(db), now)?;
    if connect.is_connect_active()
        && let Err(err) = identity::acknowledge_registration(db, connect, &identity)
    {
        tracing::warn!(error = %err, "could not confirm this Luna's signing key with Luna Connect");
        bail!("Luna Connect could not confirm this Luna's signing key. Try again.");
    }
    Ok(identity)
}

/// Send each user's self-sealed key copy to `store`, so Connect can hand it to that user's browser.
/// Connect keeps the last copy, so a failure here only delays the update until the next run.
pub fn publish_users(db: &crate::Db, store: &dyn CloudStore) -> anyhow::Result<()> {
    let users = db::list_user_keys(&lock(db))?;
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
            for (id, _, _) in &before {
                let source = {
                    let conn = lock(db);
                    db::get_protection(&conn, id)
                        .ok()
                        .flatten()
                        .map(|row| source::resolve(&conn, &row))
                };
                let outcome = match source {
                    Some(Err(unavailable)) => unavailable
                        .record(db, id)
                        .unwrap_or_else(|err| problem_outcome(&err.to_string())),
                    _ => problem_outcome(NOT_SET_UP),
                };
                if let Err(err) = record(db, id, now, &outcome) {
                    tracing::warn!(error = %err, id, "could not record a cloud backup problem");
                }
            }
        }
        Some(store) => {
            for (id, _, _) in &before {
                // Scheduled runs have no user who started them.
                run(db, id, store, connect, false, now);
            }
            sweep(db, store, now);
        }
    }
    active_states(db, now) != before
}

/// Turns off the share links of each person whose revocation Luna Connect has not confirmed yet.
/// A call that fails stays pending, so the next sweep tries it again.
pub fn revoke_pending_share_links(db: &crate::Db, store: &dyn CloudStore) {
    let pending = match db::pending_share_revokes(&lock(db)) {
        Ok(pending) => pending,
        Err(err) => {
            tracing::warn!(error = %err, "could not list share links to turn off");
            return;
        }
    };
    for user_id in pending {
        let part = keys::user_record_part(&user_id);
        let before = db::share_revoke_cutoff(&lock(db), &user_id).unwrap_or(0);
        match store.revoke_user_share_links(&part, before) {
            Ok(()) => {
                if let Err(err) = db::clear_share_revoke(&lock(db), &user_id) {
                    tracing::warn!(error = %err, "could not clear a share-link revocation");
                }
            }
            Err(err) => tracing::warn!(error = %err, "could not turn off share links; will retry"),
        }
    }
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
pub(super) fn sweep(db: &crate::Db, store: &dyn CloudStore, now: i64) {
    // Snapshot records committed locally but not yet in the cloud go first: their packs must not be
    // cleaned up before the cloud has the record that uses them.
    if let Err(err) = run::publish_outbox(db, store) {
        tracing::warn!(error = %err, "could not publish an earlier cloud snapshot; it will be retried");
    }
    let scopes = {
        let conn = lock(db);
        scopes_of(&conn, None)
    };
    revoke_pending_share_links(db, store);
    if let Err(err) = retention::retire_old_phrases(db, store, now) {
        tracing::warn!(error = %err, "could not remove old-phrase private backups");
    }
    publish_pending_scopes(db, store);
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

/// Finishes every pending re-seal of cloud backup keys, trying again while a backup is copying
/// (a re-seal waits for it) or the store fails. Gives up after `attempts` tries, `pause` apart; the
/// next run retries too. Returns true once nothing is pending.
pub fn reseal_until_done(
    db: &crate::Db,
    store: &dyn CloudStore,
    attempts: u32,
    pause: std::time::Duration,
) -> bool {
    for attempt in 0..attempts {
        let mut all_done = true;
        for result in keys::reseal_pending(db, store) {
            match result {
                Ok(report) if report.done => {}
                Ok(report) => {
                    all_done = false;
                    tracing::warn!(
                        user = %report.user_id,
                        busy = report.busy.len(),
                        missing = report.missing.len(),
                        "a cloud re-seal is waiting; it will be tried again"
                    );
                }
                Err(err) => {
                    all_done = false;
                    tracing::warn!(error = %err, "could not re-seal cloud backup keys to the new phrase");
                }
            }
        }
        if all_done {
            return true;
        }
        if attempt + 1 < attempts {
            std::thread::sleep(pause);
        }
    }
    false
}

/// Starts a run for each backup affected by an access or phrase change.
/// Backups held by another operation are retried a few times.
pub fn run_marked(
    db: &crate::Db,
    store: &dyn CloudStore,
    connect: &ConnectService,
    backups: &[String],
    now: i64,
) {
    let left = run_marked_retrying(
        db,
        store,
        connect,
        backups,
        now,
        MARKED_RUN_TRIES,
        MARKED_RUN_DELAY,
    );
    for backup in left {
        tracing::warn!(backup = %backup, "backup stayed busy; its access or phrase change waits for the next run");
    }
}

const MARKED_RUN_TRIES: u32 = 6;
const MARKED_RUN_DELAY: std::time::Duration = std::time::Duration::from_secs(10);

/// Runs each backup, trying again (up to `tries` passes, `delay` apart) for those that were busy.
/// Returns the backups that were still busy after the last pass.
fn run_marked_retrying(
    db: &crate::Db,
    store: &dyn CloudStore,
    connect: &ConnectService,
    backups: &[String],
    now: i64,
    tries: u32,
    delay: std::time::Duration,
) -> Vec<String> {
    let mut pending: Vec<String> = backups.to_vec();
    for attempt in 0..tries.max(1) {
        if attempt > 0 {
            std::thread::sleep(delay);
        }
        let mut busy = Vec::new();
        for backup in &pending {
            let outcome = run(db, backup, store, connect, false, now);
            if outcome.busy {
                busy.push(backup.clone());
            } else if let Some(problem) = outcome.problem {
                tracing::warn!(backup = %backup, problem, "backup run after an access or phrase change failed");
            }
        }
        pending = busy;
        if pending.is_empty() {
            break;
        }
    }
    pending
}

const SCOPE_PUBLISH_PREFIX: &str = "pscope_publish";

/// Remembers that these scopes' `pscopes/<scope>` records must be sent again (after a phrase
/// change re-sealed them). Any state counts: active, history and old-phrase scopes alike. The mark
/// is kept until the record is in the cloud, so a failed send is retried by the next sweep.
pub fn queue_scope_publish(conn: &Connection, scopes: &[String]) -> anyhow::Result<()> {
    for scope in scopes {
        // The value counts the requests, so a send that was already in flight can tell that the
        // scope was queued again while it ran and must leave the new mark in place.
        let key = format!("{SCOPE_PUBLISH_PREFIX}:{scope}");
        let next = db::get_meta(conn, &key)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
            .wrapping_add(1);
        db::set_meta(conn, &key, &next.to_string())?;
    }
    Ok(())
}

/// What one pass over the pending scope records did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScopePublishReport {
    pub published: usize,
    /// Records that could not be sent; they stay pending.
    pub failed: usize,
}

/// Sends every pending scope record, signed under the owner's current keys. One failing scope
/// never stops the others. A scope that no longer exists, or whose owner has no phrase, has
/// nothing to send and is dropped from the list.
pub fn publish_pending_scopes(db: &crate::Db, store: &dyn CloudStore) -> ScopePublishReport {
    let mut report = ScopePublishReport::default();
    let pending: Vec<(String, String)> = {
        let conn = lock(db);
        let listed = (|| -> anyhow::Result<Vec<(String, String)>> {
            let mut stmt =
                conn.prepare("SELECT key, value FROM meta WHERE key GLOB ?1 ORDER BY key")?;
            let keys = stmt
                .query_map([format!("{SCOPE_PUBLISH_PREFIX}:*")], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(keys)
        })();
        match listed {
            Ok(keys) => keys,
            Err(err) => {
                tracing::warn!(error = %err, "could not list the private backup records to send");
                report.failed += 1;
                return report;
            }
        }
    };
    if pending.is_empty() {
        return report;
    }
    let identity = match identity::load(&lock(db)) {
        Ok(Some(identity)) => identity,
        other => {
            if let Err(err) = other {
                tracing::warn!(error = %err, "could not load Luna's cloud identity");
            }
            report.failed = pending.len();
            return report;
        }
    };
    for (key, mark) in pending {
        let scope_name = key[SCOPE_PUBLISH_PREFIX.len() + 1..].to_string();
        // Only the mark that was read before sending is removed. If the scope was queued again
        // meanwhile (a second phrase change), the new mark stays and the next sweep sends it.
        let clear = || {
            let conn = lock(db);
            let _ = conn.execute(
                "DELETE FROM meta WHERE key = ?1 AND value = ?2",
                [&key, &mark],
            );
        };
        let loaded = {
            let conn = lock(db);
            db::get_private_scope(&conn, &scope_name).and_then(|row| match row {
                None => Ok(None),
                Some(row) => Ok(db::get_user_keys(&conn, &row.owner)?.map(|k| (row, k))),
            })
        };
        let (row, user_keys) = match loaded {
            Ok(Some(found)) => found,
            Ok(None) => {
                clear();
                continue;
            }
            Err(err) => {
                tracing::warn!(error = %err, scope = %scope_name, "could not read a private backup to send");
                report.failed += 1;
                continue;
            }
        };
        let Ok(auth_public) =
            <super::crypto::SigPublic>::try_from(user_keys.auth_public.as_slice())
        else {
            tracing::warn!(scope = %scope_name, "a person's saved sign-in key is damaged");
            report.failed += 1;
            continue;
        };
        match private::publish_scope(
            store,
            identity.signer(),
            identity.luna_id(),
            &row,
            &auth_public,
        ) {
            Ok(()) => {
                clear();
                report.published += 1;
            }
            Err(err) => {
                tracing::warn!(error = %err, scope = %scope_name, "could not send a private backup record to Luna Connect");
                report.failed += 1;
            }
        }
    }
    report
}

/// Retries [`publish_pending_scopes`] up to `attempts` times, `pause` apart, until nothing is
/// pending. Returns true once every record is sent; the next sweep retries otherwise.
pub fn publish_scopes_until_done(
    db: &crate::Db,
    store: &dyn CloudStore,
    attempts: u32,
    pause: std::time::Duration,
) -> bool {
    for attempt in 0..attempts {
        if publish_pending_scopes(db, store).failed == 0 {
            return true;
        }
        if attempt + 1 < attempts {
            std::thread::sleep(pause);
        }
    }
    false
}

/// Lets `owner`'s older private versions (kept after a phrase change) be removed by the next sweep,
/// at once and without the 30-day grace. Only the owner's `history` scopes are affected.
pub fn retire_older_versions_now(conn: &Connection, owner: &str, now: i64) -> anyhow::Result<()> {
    for scope in db::list_private_scopes(conn, Some(owner))? {
        if scope.state == "history" {
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

fn active_states(db: &crate::Db, now: i64) -> Vec<(String, BackupState, String)> {
    let conn = lock(db);
    db::list_protections(&conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| {
            r.kind == db::PROTECTION_CLOUD
                && matches!(
                    r.state.as_str(),
                    db::PROTECTION_ACTIVE | db::PROTECTION_SOURCE_GONE
                )
        })
        .map(|r| (r.id.clone(), state(&r, now), r.state))
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
    Ok(())
}

/// Delete a cloud backup and its copies in Luna Connect. The copies go first:
/// if Luna Connect can't be reached, nothing local is removed and the person
/// can try again. Refuses while a run is copying.
pub fn delete(db: &crate::Db, id: &str, store: &dyn CloudStore, now: i64) -> anyhow::Result<()> {
    let Some(_slot) = drive_backup::try_hold(db, id) else {
        bail!("This backup is busy right now. Try again in a minute.");
    };
    // Also the cloud lock, so no key move or re-seal can write records for it while it is removed.
    let Some(_cloud_slot) = super::run::RunSlot::take(db, id) else {
        bail!("This backup is busy right now. Try again in a minute.");
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
    // Its reader lists and any pending rotation go too; left behind, a re-seal would look for key
    // rows that no longer exist and never finish.
    conn.execute(
        "DELETE FROM meta WHERE key GLOB ?1 OR key = ?2",
        params![
            format!("cloud_recipients:{}:*", glob_escape(id)),
            format!("cloud_rotate:{id}")
        ],
    )?;
    Ok(())
}

/// Escape glob metacharacters so a backup id matches only itself.
fn glob_escape(id: &str) -> String {
    id.chars()
        .flat_map(|c| match c {
            '*' | '?' | '[' => vec!['[', c, ']'],
            c => vec![c],
        })
        .collect()
}

fn remote_delete(store: &dyn CloudStore, kind: &str, name: &str) -> anyhow::Result<()> {
    match store.delete_record(kind, name) {
        Ok(()) | Err(StoreError::NotFound) => Ok(()),
        Err(_) => bail!(REMOTE_DELETE_FAILED),
    }
}

fn unreachable(_: StoreError) -> anyhow::Error {
    anyhow::anyhow!(REMOTE_DELETE_FAILED)
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

/// Refreshes access for active shared cloud backups with an available source.
/// Returns the backups whose readers changed so they can run again.
pub fn on_grants_changed(conn: &Connection, drive_id: &str) -> Vec<String> {
    let rows = match db::list_protections(conn) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(error = %err, "could not list cloud backups after an access change");
            return Vec::new();
        }
    };
    let Ok(drive) = crate::files::drive_root(conn, drive_id) else {
        return Vec::new();
    };
    let mount = std::path::Path::new(&drive.mount_point);
    if crate::drives::layout::Layout::detect(mount).is_none() {
        return Vec::new();
    }
    let mut changed = Vec::new();
    for row in rows.into_iter().filter(|r| {
        r.kind == db::PROTECTION_CLOUD
            && r.state == db::PROTECTION_ACTIVE
            && r.source_drive == drive_id
            && r.private_owner.is_empty()
    }) {
        let Ok((path, meta)) = crate::files::resolve_any_at(&drive, &row.source_path, false) else {
            continue;
        };
        if !meta.is_dir() || std::fs::read_dir(path).is_err() {
            continue;
        }
        match refresh_access(conn, &row) {
            Ok(true) => changed.push(row.id),
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(error = %err, id = %row.id, "could not update a cloud backup's access");
            }
        }
    }
    changed
}

fn refresh_access(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<bool> {
    let access = access_list::for_row(conn, row)?;
    let json = serde_json::to_string(&access)?;
    if json == row.access_json {
        return Ok(false);
    }
    db::set_protection_access(conn, &row.id, &json)?;
    Ok(true)
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
        /// Connect with no bound credential, so no lookup reaches the network.
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
                phrase_words: 0,
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
    fn a_pending_share_revocation_waits_out_an_outage_then_clears() {
        let s = setup();
        let store = MemoryStore::default();
        store.set_share_revoke_down(true);
        db::queue_share_revoke(&lock(&s.db), "gone-user").unwrap();

        sweep(&s.db, &store, db::now_unix());
        assert!(store.share_revokes().is_empty());
        assert_eq!(
            db::pending_share_revokes(&lock(&s.db)).unwrap(),
            vec!["gone-user".to_string()]
        );

        store.set_share_revoke_down(false);
        sweep(&s.db, &store, db::now_unix());
        assert_eq!(
            store.share_revokes(),
            vec![keys::user_record_part("gone-user")]
        );
        assert!(db::pending_share_revokes(&lock(&s.db)).unwrap().is_empty());
    }

    #[test]
    fn after_a_delete_a_reader_can_still_be_re_sealed() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, false, NOW).problem,
            None
        );
        assert!(!keys::reader_versions_for_test(&lock(&s.db), "admin").is_empty());
        delete(&s.db, &id, &store, NOW).unwrap();
        {
            let conn = lock(&s.db);
            let left: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM meta WHERE key LIKE 'cloud_recipients:%' OR key LIKE 'cloud_rotate:%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(left, 0);
            keys::queue_reseal(&conn, "admin").unwrap();
        }
        let report = keys::reseal_user(&s.db, &store, "admin").unwrap();
        assert!(report.done, "{report:?}");
        assert!(report.missing.is_empty());
        assert!(!keys::resealing_pending(&lock(&s.db), "admin").unwrap());
    }

    #[test]
    fn a_reader_list_left_by_a_deleted_backup_does_not_block_a_re_seal() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        assert_eq!(
            run(&s.db, &id, &store, &s.connect, false, NOW).problem,
            None
        );
        delete(&s.db, &id, &store, NOW).unwrap();
        // An older build, or a crash, left the reader list behind.
        lock(&s.db)
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![
                    format!("cloud_recipients:{id}:1"),
                    r#"[{"user_id":"admin"}]"#
                ],
            )
            .unwrap();
        keys::queue_reseal(&lock(&s.db), "admin").unwrap();
        let report = keys::reseal_user(&s.db, &store, "admin").unwrap();
        assert!(report.done, "{report:?}");
    }

    #[test]
    fn a_run_that_finds_a_move_or_re_seal_holding_the_backup_skips_quietly() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        let before = db::get_protection(&lock(&s.db), &id).unwrap().unwrap();
        let slot = run::RunSlot::take(&s.db, &id).unwrap();
        let outcome = run(&s.db, &id, &store, &s.connect, false, NOW);
        assert!(outcome.busy);
        drop(slot);
        // Nothing was recorded: no error on the backup, and no card marker.
        let after = db::get_protection(&lock(&s.db), &id).unwrap().unwrap();
        assert_eq!(after.last_error, before.last_error);
        assert_eq!(after.failing_since, before.failing_since);
        // Once the lock is free the run goes through.
        let outcome = run(&s.db, &id, &store, &s.connect, false, NOW);
        assert!(!outcome.busy);
        assert_eq!(outcome.problem, None);
    }

    #[test]
    fn a_marked_run_that_finds_the_backup_busy_tries_again() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        let slot = run::RunSlot::take(&s.db, &id).unwrap();
        let ids = vec![id.clone()];
        let delay = std::time::Duration::from_millis(20);
        // Still held after every try: reported as left over.
        let left = run_marked_retrying(&s.db, &store, &s.connect, &ids, NOW, 2, delay);
        assert_eq!(left, ids);
        // Released while the retries wait: a later try goes through.
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            drop(slot);
        });
        let left = run_marked_retrying(
            &s.db,
            &store,
            &s.connect,
            &ids,
            NOW,
            50,
            std::time::Duration::from_millis(20),
        );
        release.join().unwrap();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn delete_waits_out_a_move_and_a_move_waits_out_a_run() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();
        {
            let _slot = run::RunSlot::take(&s.db, &id).unwrap();
            let err = delete(&s.db, &id, &store, NOW).unwrap_err();
            assert!(err.to_string().contains("busy right now"));
            assert!(db::get_protection(&lock(&s.db), &id).unwrap().is_some());
        }
    }

    #[test]
    fn the_not_set_up_message_points_to_about_advanced() {
        assert!(NOT_SET_UP.contains("Settings → About → Advanced"));
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
    fn create_refuses_a_folder_a_parent_cloud_backup_already_holds() {
        let s = setup();
        fs::create_dir_all(s._dir.path().join(&s.src).join("Docs/Sub/Deeper")).unwrap();
        let parent = make_backup(&s);
        // Until the parent finishes its first copy, the folder can have its own backup.
        let child = create(&s.db, &s.connect, &s.admin, &s.src, "Docs/Sub").unwrap();
        db::record_protection_ok(&lock(&s.db), &parent, NOW, "{}").unwrap();
        let err = create(&s.db, &s.connect, &s.admin, &s.src, "Docs/Sub/Deeper").unwrap_err();
        assert_eq!(err.0, "Included in the backup of \"Docs\".");
        // The child that already exists stops while the parent runs, and nothing is recorded.
        let outcome = run(
            &s.db,
            &child.id,
            &MemoryStore::new(),
            &s.connect,
            false,
            NOW,
        );
        assert_eq!(
            outcome.problem.as_deref(),
            Some("Included in the backup of \"Docs\".")
        );
        assert_eq!(
            db::get_protection(&lock(&s.db), &child.id)
                .unwrap()
                .unwrap()
                .last_error,
            ""
        );
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
                phrase_words: 0,
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

    /// A store whose key copy writes are refused, to check that the backup still runs.
    struct KeyCopyRefused(MemoryStore);

    impl CloudStore for KeyCopyRefused {
        fn device_binding(&self) -> Option<String> {
            Some("memory".into())
        }
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
            if kind == USER_RECORD_KIND {
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
        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::backup::cloud::store::RecordPage, StoreError> {
            self.0.list_record_page(kind, after, limit)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.0.usage()
        }
    }

    #[test]
    fn publish_users_sends_each_self_copy() {
        let s = setup();
        let conn = lock(&s.db);
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: "admin".into(),
                seal_public: real_seal_public(1),
                auth_public: real_auth_public(2),
                self_sealed: b"sealed copy".to_vec(),
                phrase_set_at: NOW,
                last_checked_at: 0,
                phrase_words: 0,
            },
        )
        .unwrap();
        drop(conn);
        let store = MemoryStore::new();

        publish_users(&s.db, &store).unwrap();

        let copy = store
            .get_record(USER_RECORD_KIND, &keys::user_record_part("admin"))
            .unwrap();
        assert_eq!(copy.as_deref(), Some(&b"sealed copy"[..]));
    }

    #[test]
    fn a_refused_key_copy_is_reported_but_the_backup_still_runs() {
        let s = setup();
        let id = make_backup(&s);
        let store = KeyCopyRefused(MemoryStore::new());

        let outcome = run(&s.db, &id, &store, &s.connect, false, NOW);
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert_eq!(store.0.list_records("snapshots").unwrap().len(), 1);
    }

    /// A store that refuses every copy the way Luna Connect does for an account with no card.
    struct NoCard(MemoryStore);

    const NO_CARD_MSG: &str =
        "Add a payment card at connect.luna.libreloom.org to store your cloud backup.";

    impl CloudStore for NoCard {
        fn device_binding(&self) -> Option<String> {
            Some("memory".into())
        }
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
        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::backup::cloud::store::RecordPage, StoreError> {
            self.0.list_record_page(kind, after, limit)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.0.usage()
        }
    }

    /// Pretend Luna Connect last said cloud backup is (or isn't) paid for.
    fn set_unlocked(connect: &ConnectService, unlocked: bool) {
        connect
            .save(&serde_json::json!({ "backup_unlocked": unlocked }))
            .unwrap();
    }

    #[test]
    fn a_card_refusal_marks_cloud_backup_unpaid() {
        let s = setup();
        let id = make_backup(&s);
        set_unlocked(&s.connect, true);

        let refused = run(
            &s.db,
            &id,
            &NoCard(MemoryStore::new()),
            &s.connect,
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
        assert!(!s.connect.backup_unlocked());
    }

    #[test]
    fn other_refusals_leave_cloud_backup_paid() {
        let s = setup();
        let id = make_backup(&s);
        set_unlocked(&s.connect, true);

        let outcome = run(
            &s.db,
            &id,
            &KeyCopyRefused(MemoryStore::new()),
            &s.connect,
            false,
            NOW,
        );
        assert_eq!(outcome.problem.as_deref(), Some(USER_LIST_FAILED));
        assert!(s.connect.backup_unlocked());
    }

    #[test]
    fn a_linked_luna_without_payment_cannot_start_a_cloud_backup() {
        let s = setup();
        set_unlocked(&s.connect, false);
        fs::write(
            s._dir
                .path()
                .join("connect")
                .join(crate::net::connect::DEVICE_UID_FILE),
            "7K4M2Q9XR8N36T5W1PZH",
        )
        .unwrap();
        fs::write(
            s._dir
                .path()
                .join("connect")
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .unwrap();
        assert!(s.connect.is_connect_active());

        let refused = create(&s.db, &s.connect, &s.admin, &s.src, "Docs").unwrap_err();
        assert_eq!(refused.0, NO_PAYMENT_REFUSAL);
        let conn = lock(&s.db);
        assert!(db::list_protections(&conn).unwrap().is_empty());
    }

    #[test]
    fn run_then_delete_removes_remote_copies() {
        let s = setup();
        let id = make_backup(&s);
        let store = MemoryStore::new();

        let outcome = run(&s.db, &id, &store, &s.connect, false, NOW);
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
        let _hold = drive_backup::try_hold(&s.db, &id).unwrap();
        let err = delete(&s.db, &id, &store, NOW).unwrap_err();
        assert!(err.to_string().contains("busy right now"), "{err}");
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
            phrase_words: 0,
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
                phrase_words: 0,
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

    /// Replaces the owner's phrase the way a lost-phrase save does: the new keys are set and the
    /// active scope keeps its 30 days.
    fn rotate_owner_keys(s: &PrivateSetup, now: i64) {
        let conn = lock(&s.db);
        db::set_user_keys(&conn, &owner_keys(8)).unwrap();
        private::retire_scopes_without_key(&conn, "owner", false, now).unwrap();
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
    fn inside_is_allowed_for_the_owner_as_a_private_backup() {
        let s = private_setup();
        let disk = private_item(&s, "Docs");
        fs::create_dir_all(disk.join("Inner")).unwrap();
        let row = create(&s.db, &s.connect, &s.owner, "drive-src", "Docs/Inner").unwrap();
        assert_eq!(row.private_owner, s.owner.id);
        let list: access_list::AccessList = serde_json::from_str(&row.access_json).unwrap();
        assert_eq!(list.users, vec![s.owner.id.clone()]);
        assert!(!list.admins);
    }

    #[test]
    fn private_run_goes_through_private_run() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        let out = run(&s.db, &id, &store, &s.connect, true, NOW);
        assert_eq!(out.problem, None);
        assert!(store.list_records("snapshots").unwrap().is_empty());
        assert_eq!(store.list_records(PSNAPSHOTS_KIND).unwrap().len(), 1);
        assert_eq!(store.list_records(PSCOPES_KIND).unwrap().len(), 1);
    }

    #[test]
    fn a_stopped_backup_does_not_run() {
        let s = private_setup();
        private_item(&s, "Docs");
        let id = private_backup(&s, "Docs");
        let store = MemoryStore::new();
        {
            let conn = lock(&s.db);
            db::set_protection_state(
                &conn,
                &id,
                db::PROTECTION_STOPPED,
                "You stopped this backup.",
            )
            .unwrap();
        }

        let out = run(&s.db, &id, &store, &s.connect, true, NOW);

        assert_eq!(out.problem.as_deref(), Some("You stopped this backup."));
        assert_eq!(out.snapshot_id, None);
        assert!(store.list_records(PSNAPSHOTS_KIND).unwrap().is_empty());
        assert!(store.list_records(PSCOPES_KIND).unwrap().is_empty());
    }

    #[test]
    fn a_private_backup_whose_folder_is_not_the_owners_does_not_run() {
        let s = private_setup();
        fs::create_dir_all(s.root.join("Shared")).unwrap();
        fs::write(s.root.join("Shared").join("a.txt"), "hello").unwrap();
        private_item(&s, "Docs");
        {
            let conn = lock(&s.db);
            db::insert_protection(
                &conn,
                &db::NewProtection {
                    id: "forged",
                    kind: db::PROTECTION_CLOUD,
                    source_drive: "drive-src",
                    source_path: "Shared",
                    target_drive: "",
                    private_owner: "owner",
                    created_by: "owner",
                    created_at: 1,
                },
            )
            .unwrap();
        }
        let store = MemoryStore::new();

        let out = run(&s.db, "forged", &store, &s.connect, true, NOW);

        assert_eq!(
            out.problem.as_deref(),
            Some("This folder is no longer a private item.")
        );
        assert_eq!(out.snapshot_id, None);
        assert!(store.list_records(PSNAPSHOTS_KIND).unwrap().is_empty());
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
            run(&s.db, &docs, &store, &s.connect, true, NOW).problem,
            None
        );
        assert_eq!(
            run(&s.db, &notes, &store, &s.connect, true, NOW + 1).problem,
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
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, NOW).problem, None);
        let old = active_scope(&s.db);

        let t2 = NOW + DAY;
        rotate_owner_keys(&s, t2);
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, t2).problem, None);
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
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, NOW).problem, None);
        let old = active_scope(&s.db);
        let t2 = NOW + DAY;
        rotate_owner_keys(&s, t2);
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, t2).problem, None);
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
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, NOW).problem, None);
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);

        let t2 = NOW + DAY;
        rotate_owner_keys(&s, t2);
        assert_eq!(run(&s.db, &id, &store, &s.connect, true, t2).problem, None);
        assert_eq!(
            old_phrase_copies(&lock(&s.db), "owner"),
            Some((1, t2 + OLD_PHRASE_GRACE))
        );
        assert_eq!(old_phrase_copies(&lock(&s.db), "admin"), None);

        sweep(&s.db, &store, t2 + OLD_PHRASE_GRACE);
        assert_eq!(old_phrase_copies(&lock(&s.db), "owner"), None);
    }

    #[test]
    fn on_grants_changed_refreshes_only_shared_rows_with_a_source() {
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
        assert_eq!(
            on_grants_changed(&lock(&s.db), "drive-src"),
            std::slice::from_ref(&shared)
        );
        assert!(on_grants_changed(&lock(&s.db), "drive-src").is_empty());
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

        fs::rename(s.root.join("Shared"), s.root.join("Moved")).unwrap();
        db::set_protection_access(&conn, &shared, "frozen").unwrap();
        assert!(on_grants_changed(&conn, "drive-src").is_empty());
        assert_eq!(
            db::get_protection(&conn, &shared)
                .unwrap()
                .unwrap()
                .access_json,
            "frozen"
        );
    }
    /// Fails `put_record` for scope names listed in `fail`, while `allow` is false.
    struct ScopeFlaky {
        inner: MemoryStore,
        fail: Vec<String>,
        allow: std::sync::atomic::AtomicBool,
    }

    impl CloudStore for ScopeFlaky {
        fn device_binding(&self) -> Option<String> {
            Some("memory".into())
        }
        fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, b: &[u8]) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, b)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, b: &[u8]) -> Result<(), StoreError> {
            if !self.allow.load(std::sync::atomic::Ordering::SeqCst)
                && kind == PSCOPES_KIND
                && self.fail.iter().any(|f| f == name)
            {
                return Err(StoreError::Unavailable(
                    "Could not reach Luna Connect.".into(),
                ));
            }
            self.inner.put_record(kind, name, b)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }
        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::backup::cloud::store::RecordPage, StoreError> {
            self.inner.list_record_page(kind, after, limit)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    fn scope_row(name: &str, state: &str) -> db::PrivateScope {
        let (_, scope_public) = crypto::new_scope_keys();
        db::PrivateScope {
            scope: name.to_string(),
            owner: "owner".into(),
            seal_public: owner_keys(7).seal_public,
            scope_public: scope_public.to_vec(),
            sealed_scope_secret: vec![9; 40],
            dedup_key: vec![1; 32],
            state: state.to_string(),
            retire_after: 0,
            created_at: 5,
        }
    }

    #[test]
    fn pending_scope_records_continue_past_a_failure_and_retry_later() {
        let p = private_setup();
        {
            let conn = lock(&p.db);
            for (name, state) in [
                ("s-bad", "active"),
                ("s-hist", "history"),
                ("s-old", "old_phrase"),
            ] {
                db::insert_private_scope(&conn, &scope_row(name, state)).unwrap();
            }
            queue_scope_publish(
                &conn,
                &[
                    "s-bad".to_string(),
                    "s-hist".to_string(),
                    "s-old".to_string(),
                ],
            )
            .unwrap();
        }
        let store = ScopeFlaky {
            inner: MemoryStore::new(),
            fail: vec!["s-bad".into()],
            allow: std::sync::atomic::AtomicBool::new(false),
        };
        // The first scope fails; the history and old-phrase ones are still sent.
        let report = publish_pending_scopes(&p.db, &store);
        assert_eq!(
            report,
            ScopePublishReport {
                published: 2,
                failed: 1
            }
        );
        assert!(
            store
                .inner
                .get_record(PSCOPES_KIND, "s-hist")
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .inner
                .get_record(PSCOPES_KIND, "s-old")
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .inner
                .get_record(PSCOPES_KIND, "s-bad")
                .unwrap()
                .is_none()
        );
        // Only the failed one stays pending, and a later pass finishes it.
        assert!(!publish_scopes_until_done(
            &p.db,
            &store,
            2,
            std::time::Duration::from_millis(1)
        ));
        store.allow.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(publish_scopes_until_done(
            &p.db,
            &store,
            2,
            std::time::Duration::from_millis(1)
        ));
        assert!(
            store
                .inner
                .get_record(PSCOPES_KIND, "s-bad")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            publish_pending_scopes(&p.db, &store),
            ScopePublishReport::default()
        );
    }

    /// Queues `scope` again while its first record is being sent, like a second phrase change.
    struct RequeueDuringSend<'a> {
        inner: MemoryStore,
        db: &'a crate::Db,
        scope: String,
        done: std::sync::atomic::AtomicBool,
    }

    impl CloudStore for RequeueDuringSend<'_> {
        fn device_binding(&self) -> Option<String> {
            Some("memory".into())
        }
        fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, b: &[u8]) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, b)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, b: &[u8]) -> Result<(), StoreError> {
            if kind == PSCOPES_KIND && !self.done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                queue_scope_publish(&lock(self.db), std::slice::from_ref(&self.scope)).unwrap();
            }
            self.inner.put_record(kind, name, b)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }
        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::backup::cloud::store::RecordPage, StoreError> {
            self.inner.list_record_page(kind, after, limit)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    #[test]
    fn a_scope_queued_again_during_a_send_is_sent_again() {
        let p = private_setup();
        {
            let conn = lock(&p.db);
            db::insert_private_scope(&conn, &scope_row("s-1", "active")).unwrap();
            queue_scope_publish(&conn, &["s-1".to_string()]).unwrap();
        }
        let store = RequeueDuringSend {
            inner: MemoryStore::new(),
            db: &p.db,
            scope: "s-1".into(),
            done: std::sync::atomic::AtomicBool::new(false),
        };
        let report = publish_pending_scopes(&p.db, &store);
        assert_eq!(report.published, 1);
        // The new request survived the first send, so the next sweep sends the newer record.
        assert!(
            db::get_meta(&lock(&p.db), "pscope_publish:s-1")
                .unwrap()
                .is_some()
        );
        let report = publish_pending_scopes(&p.db, &store);
        assert_eq!(report.published, 1);
        assert!(
            db::get_meta(&lock(&p.db), "pscope_publish:s-1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pending_scope_record_for_a_missing_scope_is_dropped() {
        let p = private_setup();
        queue_scope_publish(&lock(&p.db), &["gone".to_string()]).unwrap();
        let store = MemoryStore::new();
        let report = publish_pending_scopes(&p.db, &store);
        assert_eq!(report, ScopePublishReport::default());
        assert!(store.get_record(PSCOPES_KIND, "gone").unwrap().is_none());
        assert!(
            db::get_meta(&lock(&p.db), "pscope_publish:gone")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pending_scope_records_wait_when_the_identity_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        queue_scope_publish(&conn, &["s-1".to_string()]).unwrap();
        let db = crate::Db::new(conn);
        let report = publish_pending_scopes(&db, &MemoryStore::new());
        assert_eq!(
            report,
            ScopePublishReport {
                published: 0,
                failed: 1
            }
        );
        assert!(
            db::get_meta(&lock(&db), "pscope_publish:s-1")
                .unwrap()
                .is_some()
        );
    }
}
