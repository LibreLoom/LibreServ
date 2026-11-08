//! Reviewed, one-use plans for formatting a whole physical drive.
use crate::api::response::json_error;
use crate::drives::format::{Filesystem, Target};
use crate::{AppState, auth::CurrentUser};
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path as FsPath;
use zeroize::Zeroize;

const REVIEW_SECONDS: i64 = 30;
const PLAN_SECONDS: i64 = 900;
type ApiError = (StatusCode, Json<serde_json::Value>);
type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    name: String,
    kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Partition {
    device: String,
    label: String,
    fs_type: String,
    size_bytes: u64,
    readable: bool,
    entries: Vec<Entry>,
    files: u64,
    folders: u64,
    used_bytes: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Plan {
    id: String,
    drive_id: Option<String>,
    device: String,
    model: String,
    label: String,
    size_bytes: u64,
    filesystem: String,
    encrypted: bool,
    scope: String,
    partitions: Vec<Partition>,
    consequences: Vec<String>,
    expires_at: i64,
    review_seconds: i64,
    review_ready_at: Option<i64>,
}
#[derive(Deserialize)]
struct PlanRequest {
    drive_id: Option<String>,
    device: Option<String>,
    label: String,
    filesystem: String,
    encrypted: bool,
    scope: String,
}
#[derive(Deserialize)]
struct StartRequest {
    password: Option<String>,
}
impl Drop for StartRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
#[derive(Deserialize)]
struct OperationQuery {
    drive_id: Option<String>,
    device: Option<String>,
}
#[derive(Clone, Serialize)]
struct Operation {
    id: String,
    plan_id: String,
    drive_id: Option<String>,
    device: String,
    label: String,
    state: String,
    phase: String,
    error: Option<String>,
    destructive_started: bool,
    encrypted: bool,
    filesystem: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drive-format/capabilities", get(capabilities))
        .route("/api/v1/drive-format/plans", post(create_plan))
        .route("/api/v1/drive-format/plans/{id}/review", post(review))
        .route("/api/v1/drive-format/plans/{id}/start", post(start))
        .route("/api/v1/drive-format/operations", get(operations))
        .route("/api/v1/drive-format/operations/{id}", get(operation))
}
fn admin(user: &CurrentUser) -> Result<(), ApiError> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage drives.",
        ))
    }
}
fn internal() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't prepare this drive. Try again.",
    )
}
fn bad(message: &str) -> ApiError {
    json_error(StatusCode::BAD_REQUEST, message)
}
fn conflict(message: &str) -> ApiError {
    json_error(StatusCode::CONFLICT, message)
}
fn now() -> i64 {
    crate::db::now_unix()
}

async fn capabilities(Extension(user): Extension<CurrentUser>) -> ApiResult<serde_json::Value> {
    admin(&user)?;
    let simulated = crate::dev_mock::only();
    let exfat = simulated || check_tools(Filesystem::Exfat, false).is_ok();
    let ext4 = simulated || check_tools(Filesystem::Ext4, false).is_ok();
    let encryption = !simulated && check_tools(Filesystem::Ext4, true).is_ok();
    let reason = "Luna is missing a program it needs to format this drive.";
    Ok(Json(serde_json::json!({"filesystems": [
        {"id":"exfat", "label":"exFAT", "description":"Works with most computers.", "encryption_supported":false, "encryption_available":false, "available":exfat, "unavailable_reason": if exfat { "" } else { reason }},
        {"id":"ext4", "label":"ext4", "description":"A Linux filesystem.", "encryption_supported":true, "encryption_available":encryption, "available":ext4, "unavailable_reason": if ext4 { "" } else { reason }}
    ], "scopes":["drive"], "review_seconds":REVIEW_SECONDS})))
}

fn check_tools(fs: Filesystem, encrypted: bool) -> anyhow::Result<()> {
    let filesystem_tool = match fs {
        Filesystem::Exfat => "mkfs.exfat",
        Filesystem::Ext4 => "mkfs.ext4",
    };
    for tool in ["wipefs", "sfdisk", "mount", "umount", filesystem_tool] {
        if crate::sandbox::which(tool).is_none() {
            anyhow::bail!("Luna is missing a program it needs to format this drive.");
        }
    }
    if encrypted && crate::sandbox::which("cryptsetup").is_none() {
        anyhow::bail!("Luna is missing a program it needs to encrypt this drive.");
    }
    Ok(())
}

fn detected(device: &str) -> anyhow::Result<crate::drives::detect::DetectedDrive> {
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    crate::drives::detect::scan_with_dev_mocks(FsPath::new("/sys/block"), &mounts)
        .into_iter()
        .find(|d| d.name == device && d.is_storage_candidate())
        .ok_or_else(|| anyhow::anyhow!("Luna can't see this drive."))
}

/// Directory mock drives are only accepted when the scanner reports an exact,
/// non-symlink child of the configured mock root.
fn mock_root(device: &str) -> Option<std::path::PathBuf> {
    if !crate::dev_mock::enabled() {
        return None;
    }
    let disk = detected(device).ok()?;
    let path = std::path::PathBuf::from(disk.mount_point?);
    if std::fs::symlink_metadata(&path)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let parent = std::fs::canonicalize(crate::dev_mock::mock_drives_path()).ok()?;
    let path = std::fs::canonicalize(path).ok()?;
    (path.parent() == Some(parent.as_path())).then_some(path)
}

/// Include kernel identity, presence and the entire partition geometry. A
/// missing disk sequence is not enough evidence to authorize destruction.
fn fingerprint(device: &str) -> anyhow::Result<String> {
    let disk = detected(device)?;
    if let Some(path) = mock_root(device) {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&path)?;
        return Ok(format!(
            "mock|{}|{}|{}|{}:{}",
            path.display(),
            meta.dev(),
            meta.ino(),
            meta.mtime(),
            meta.mtime_nsec()
        ));
    }
    let seq = disk.diskseq.ok_or_else(|| {
        anyhow::anyhow!("Luna can't identify this drive safely. Unplug it and try again.")
    })?;
    let base = FsPath::new("/sys/block").join(device);
    let canonical = std::fs::canonicalize(&base)?;
    let dev = std::fs::read_to_string(base.join("dev"))?;
    let mut parts = Vec::new();
    for e in std::fs::read_dir(&base)?.flatten() {
        let p = e.path();
        if !p.join("partition").exists() {
            continue;
        }
        parts.push(format!(
            "{}:{}:{}:{}",
            e.file_name().to_string_lossy(),
            std::fs::read_to_string(p.join("dev"))?.trim(),
            std::fs::read_to_string(p.join("start"))?.trim(),
            std::fs::read_to_string(p.join("size"))?.trim()
        ));
    }
    parts.sort();
    Ok(fingerprint_value(
        &canonical,
        dev.trim(),
        seq,
        disk.size_bytes,
        &parts,
    ))
}

fn fingerprint_value(
    canonical: &FsPath,
    dev: &str,
    seq: u64,
    size: u64,
    parts: &[String],
) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        canonical.display(),
        dev,
        seq,
        size,
        parts.join(",")
    )
}

fn same_attachment(device: &str, expected: &str) -> anyhow::Result<()> {
    let actual = fingerprint(device)?;
    let original = expected.rsplit_once('|').map(|(identity, _)| identity);
    let current = actual.rsplit_once('|').map(|(identity, _)| identity);
    if original.is_none() || original != current {
        anyhow::bail!("This drive changed while Luna was formatting it.");
    }
    if mock_root(device).is_none() && !crate::drives::mounted_points_for_disk(device).is_empty() {
        anyhow::bail!("Something mounted this drive while Luna was formatting it.");
    }
    Ok(())
}

/// An open device-mapper or other block stack can still be using the disk
/// even when none of its direct partitions is mounted.
fn ensure_no_holders(device: &str) -> anyhow::Result<()> {
    ensure_allowed_holders(device, None)
}

fn ensure_allowed_holders(device: &str, drive_id: Option<&str>) -> anyhow::Result<()> {
    let base = FsPath::new("/sys/block").join(device);
    let allowed = drive_id
        .and_then(|id| std::fs::canonicalize(crate::drives::luks::mapper_path(id)).ok())
        .and_then(|path| path.file_name().map(|name| name.to_owned()));
    let mut nodes = vec![base.clone()];
    for entry in std::fs::read_dir(&base)? {
        let path = entry?.path();
        if path.join("partition").exists() {
            nodes.push(path);
        }
    }
    for node in nodes {
        for entry in std::fs::read_dir(node.join("holders"))? {
            if allowed.as_ref() != Some(&entry?.file_name()) {
                anyhow::bail!("Something is still using this drive. Close it and try again.");
            }
        }
    }
    Ok(())
}

fn ensure_safe_disk(state: &AppState, device: &str, drive_id: Option<&str>) -> anyhow::Result<()> {
    if mock_root(device).is_some() {
        return Ok(());
    }
    let data_dir = std::fs::canonicalize(&state.data_dir)
        .map_err(|_| anyhow::anyhow!("Luna can't check the drive used for its settings."))?;
    for path in crate::drives::mounted_points_for_disk(device) {
        let mount = std::fs::canonicalize(&path)
            .map_err(|_| anyhow::anyhow!("Luna can't check where this drive is mounted."))?;
        if state.drive_manager.is_system_mount(&path) || data_dir.starts_with(&mount) {
            anyhow::bail!("Luna can't format a drive used by this system.");
        }
    }
    ensure_allowed_holders(device, drive_id)
}

struct PreviewMount<'a> {
    mounter: &'a dyn crate::drives::mount::Mounter,
    target: std::path::PathBuf,
}
impl Drop for PreviewMount<'_> {
    fn drop(&mut self) {
        let _ = self.mounter.unmount(&self.target);
        let _ = std::fs::remove_dir(&self.target);
    }
}

fn inspect_partitions(state: &AppState, disk: &str) -> anyhow::Result<Vec<Partition>> {
    if let Some(root) = mock_root(disk) {
        let summary = luna_core::scan::scan_top_level(&root);
        let found = detected(disk).ok();
        return Ok(vec![Partition {
            device: disk.to_string(),
            label: String::new(),
            fs_type: found
                .as_ref()
                .and_then(|d| d.fs_type.clone())
                .unwrap_or_default(),
            size_bytes: found.map_or(0, |d| d.size_bytes),
            readable: summary.unreadable == 0,
            entries: summary
                .entries
                .into_iter()
                .map(|e| Entry {
                    name: e.name,
                    kind: e.kind,
                })
                .collect(),
            files: summary.files,
            folders: summary.folders,
            used_bytes: None,
        }]);
    }
    let infos = state.drive_manager.probe().probe_disk(disk);
    let has_parts = infos.iter().any(|p| p.name != disk);
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    infos
        .into_iter()
        .filter(|p| !has_parts || p.name != disk)
        .map(|p| -> anyhow::Result<Partition> {
            let dev = format!("/dev/{}", p.name);
            let mut point = mounts.lines().find_map(|line| {
                let mut fields = line.split_whitespace();
                (fields.next()? == dev)
                    .then(|| fields.next().map(|s| s.replace("\\040", " ")))
                    .flatten()
            });
            if point.is_none() && crate::drives::fsprobe::is_luks_type(&p.fs_type) {
                let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
                if let Ok(rows) = crate::db::list_drives(&db)
                    && let Some(row) = rows
                        .into_iter()
                        .find(|row| row.device == disk && row.encrypted && !row.locked)
                    && state.drive_manager.luks().is_open(&row.id)
                {
                    point = Some(row.mount_point);
                }
            }
            let mut result = Partition {
                device: p.name,
                label: p.label,
                fs_type: p.fs_type,
                size_bytes: p.size_bytes,
                readable: false,
                entries: Vec::new(),
                files: 0,
                folders: 0,
                used_bytes: None,
            };
            let mut temporary = None;
            if point.is_none()
                && (crate::drives::fsprobe::is_writable_type(&result.fs_type)
                    || crate::drives::fsprobe::is_intrinsically_read_only(&result.fs_type))
                // An unmounted NTFS volume may need journal recovery. Leave
                // its contents unknown instead of risking writes on review.
                && !matches!(result.fs_type.to_ascii_lowercase().as_str(), "ntfs" | "ntfs3" | "fuseblk")
            {
                let target = state
                    .data_dir
                    .join("mounts/format-preview")
                    .join(uuid::Uuid::new_v4().to_string());
                let guard = PreviewMount {
                    mounter: state.drive_manager.mounter(),
                    target,
                };
                if guard
                    .mounter
                    .mount_typed(&dev, &guard.target, true, Some(&result.fs_type))
                    .is_ok()
                    && guard.mounter.is_mounted(&guard.target)
                {
                    point = Some(guard.target.to_string_lossy().into_owned());
                }
                temporary = Some(guard);
            }
            if let Some(path) = point {
                let path = FsPath::new(&path);
                if state.drive_manager.mounter().is_mounted(path) {
                    let contents = crate::drives::wipe::inspect(path, true);
                    result.readable = contents.readable && contents.summary.unreadable == 0;
                    result.files = contents.summary.files;
                    result.folders = contents.summary.folders;
                    result.used_bytes = contents.used_bytes;
                    result.entries = contents
                        .summary
                        .entries
                        .into_iter()
                        .map(|e| Entry {
                            name: e.name,
                            kind: e.kind,
                        })
                        .collect();
                }
            }
            if let Some(guard) = temporary {
                guard.mounter.unmount(&guard.target).map_err(|_| {
                    anyhow::anyhow!("Luna couldn't finish checking this drive. Try again.")
                })?;
                if guard.mounter.is_mounted(&guard.target) {
                    anyhow::bail!("Luna couldn't finish checking this drive. Try again.");
                }
            }
            Ok(result)
        })
        .collect()
}

async fn create_plan(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PlanRequest>,
) -> ApiResult<Plan> {
    admin(&user)?;
    if body.scope != "drive" {
        return Err(bad("Choose the whole drive."));
    }
    let filesystem =
        Filesystem::parse(&body.filesystem).ok_or_else(|| bad("Choose a supported filesystem."))?;
    if body.encrypted && filesystem != Filesystem::Ext4 {
        return Err(bad("Choose ext4 to encrypt this drive."));
    }
    let label = body.label.trim().to_string();
    if label.is_empty() || label.len() > 80 {
        return Err(bad("Give this drive a name between 1 and 80 characters."));
    }
    if body.drive_id.is_some() == body.device.is_some() {
        return Err(bad("Choose one drive."));
    }
    let drive_id = body.drive_id;
    let device = if let Some(ref id) = drive_id {
        let db = state.db.lock().map_err(|_| internal())?;
        crate::db::get_drive(&db, id)
            .map_err(|_| internal())?
            .ok_or_else(|| bad("Luna doesn't know this drive."))?
            .device
    } else {
        body.device.unwrap_or_default()
    };
    if device.is_empty() || device.contains('/') {
        return Err(bad("Choose a physical drive."));
    }
    let _disk_guard = state
        .db
        .drive_lock(&format!("format-device:{device}"))
        .lock_owned()
        .await;
    {
        let db = state.db.lock().map_err(|_| internal())?;
        let busy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE device=?1 AND state IN ('queued','running'))", [&device], |r| r.get(0)).map_err(|_| internal())?;
        if busy {
            return Err(conflict("Luna is already formatting this drive."));
        }
        if let Some(id) = &drive_id {
            let current = crate::db::get_drive(&db, id)
                .map_err(|_| internal())?
                .ok_or_else(|| bad("Luna doesn't know this drive."))?;
            if current.device != device {
                return Err(conflict(
                    "This drive changed. Review it again before formatting.",
                ));
            }
        }
    }
    if drive_id.is_none() {
        let db = state.db.lock().map_err(|_| internal())?;
        if crate::db::list_drives(&db)
            .map_err(|_| internal())?
            .iter()
            .any(|row| row.device == device)
        {
            return Err(conflict(
                "This drive is already added to Luna. Choose it from your drives.",
            ));
        }
    }
    let state2 = state.clone();
    let device2 = device.clone();
    let drive_id2 = drive_id.clone();
    let encrypted = body.encrypted;
    let (disk, fingerprint, partitions) = tokio::task::spawn_blocking(move || {
        let disk = detected(&device2)?;
        if mock_root(&device2).is_none() {
            check_tools(filesystem, encrypted)?;
        }
        ensure_safe_disk(&state2, &device2, drive_id2.as_deref())?;
        let before = fingerprint(&device2)?;
        let parts = inspect_partitions(&state2, &device2)?;
        if fingerprint(&device2)? != before {
            anyhow::bail!("This drive changed. Review it again before formatting.");
        }
        Ok::<_, anyhow::Error>((disk, before, parts))
    })
    .await
    .map_err(|_| internal())?
    .map_err(|e| bad(&e.to_string()))?;
    if body.encrypted && mock_root(&device).is_some() {
        return Err(bad("Encryption isn't available for a simulated drive."));
    }
    let plan = Plan { id: uuid::Uuid::new_v4().to_string(), drive_id, device, model: disk.model, label, size_bytes: disk.size_bytes, filesystem: filesystem.as_str().into(), encrypted: body.encrypted, scope: "drive".into(), partitions,
        consequences: vec!["Everything on every part of this drive will be erased.".into(), "Links and access to its files will be removed, and backups for its folders will be paused.".into()], expires_at: now() + PLAN_SECONDS, review_seconds: REVIEW_SECONDS, review_ready_at: None };
    let db = state.db.lock().map_err(|_| internal())?;
    db.execute("INSERT INTO drive_format_plans (id,owner,body,fingerprint,expires_at) VALUES (?1,?2,?3,?4,?5)", params![plan.id, user.id, serde_json::to_string(&plan).map_err(|_| internal())?, fingerprint, plan.expires_at]).map_err(|_| internal())?;
    Ok(Json(plan))
}
type StoredPlan = (String, String, i64, Option<i64>, Option<String>);

fn load_plan(
    db: &rusqlite::Connection,
    id: &str,
    owner: &str,
) -> Result<(Plan, String, Option<String>), ApiError> {
    let row: Option<StoredPlan> = db.query_row("SELECT body,fingerprint,expires_at,review_ready_at,operation_id FROM drive_format_plans WHERE id=?1 AND owner=?2", params![id,owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional().map_err(|_| internal())?;
    let (body, fp, expires_at, ready, operation_id) =
        row.ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna can't find this format plan."))?;
    let mut plan: Plan = serde_json::from_str(&body).map_err(|_| internal())?;
    plan.expires_at = expires_at;
    plan.review_ready_at = ready;
    Ok((plan, fp, operation_id))
}
async fn review(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Plan> {
    admin(&user)?;
    let db = state.db.lock().map_err(|_| internal())?;
    let (mut plan, _, used) = load_plan(&db, &id, &user.id)?;
    if plan.expires_at <= now() || used.is_some() {
        return Err(conflict(
            "This format plan has expired. Review the drive again.",
        ));
    }
    db.execute(
        "UPDATE drive_format_plans SET review_ready_at=COALESCE(review_ready_at,?1) WHERE id=?2",
        // `now()` is rounded down to whole seconds; the extra second makes
        // this at least 30 elapsed seconds even at the end of a clock tick.
        params![now() + REVIEW_SECONDS + 1, id],
    )
    .map_err(|_| internal())?;
    plan.review_ready_at = db
        .query_row(
            "SELECT review_ready_at FROM drive_format_plans WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|_| internal())?;
    Ok(Json(plan))
}
fn row_operation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Operation> {
    Ok(Operation {
        id: r.get(0)?,
        plan_id: r.get(1)?,
        drive_id: r.get(2)?,
        device: r.get(3)?,
        label: r.get(4)?,
        state: r.get(5)?,
        phase: r.get(6)?,
        error: r.get(7)?,
        destructive_started: r.get(8)?,
        encrypted: r.get(9)?,
        filesystem: r.get(10)?,
    })
}
const OP_COLUMNS: &str =
    "id,plan_id,drive_id,device,label,state,phase,error,destructive_started,encrypted,filesystem";
fn get_operation(db: &rusqlite::Connection, id: &str) -> Result<Operation, ApiError> {
    db.query_row(
        &format!("SELECT {OP_COLUMNS} FROM drive_format_operations WHERE id=?1"),
        [id],
        row_operation,
    )
    .optional()
    .map_err(|_| internal())?
    .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna can't find this format."))
}
async fn operation(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Operation> {
    admin(&user)?;
    let db = state.db.lock().map_err(|_| internal())?;
    Ok(Json(get_operation(&db, &id)?))
}
async fn operations(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<OperationQuery>,
) -> ApiResult<serde_json::Value> {
    admin(&user)?;
    if q.drive_id.is_some() == q.device.is_some() {
        return Err(bad("Choose one drive."));
    }
    let db = state.db.lock().map_err(|_| internal())?;
    let mut stmt = db.prepare(&format!("SELECT {OP_COLUMNS} FROM drive_format_operations WHERE (?1 IS NOT NULL AND drive_id=?1) OR (?2 IS NOT NULL AND device=?2) ORDER BY rowid DESC")).map_err(|_| internal())?;
    let rows = stmt
        .query_map(params![q.drive_id, q.device], row_operation)
        .map_err(|_| internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| internal())?;
    Ok(Json(serde_json::json!({"operations":rows})))
}

async fn start(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<StartRequest>,
) -> ApiResult<Operation> {
    admin(&user)?;
    let (plan, expected, existing) = {
        let db = state.db.lock().map_err(|_| internal())?;
        load_plan(&db, &id, &user.id)?
    };
    if let Some(op) = existing {
        let db = state.db.lock().map_err(|_| internal())?;
        return Ok(Json(get_operation(&db, &op)?));
    }
    if plan.expires_at <= now() {
        return Err(conflict(
            "This format plan has expired. Review the drive again.",
        ));
    }
    if plan.review_ready_at.is_none_or(|ready| ready > now()) {
        return Err(conflict(
            "Wait until the review is complete before formatting this drive.",
        ));
    }
    if plan.encrypted && body.password.as_deref().is_none_or(str::is_empty) {
        return Err(bad("Enter a password for this drive."));
    }
    let _disk_guard = state
        .db
        .drive_lock(&format!("format-device:{}", plan.device))
        .lock_owned()
        .await;
    let disk = plan.device.clone();
    let actual = tokio::task::spawn_blocking(move || fingerprint(&disk))
        .await
        .map_err(|_| internal())?
        .map_err(|_| conflict("This drive changed. Review it again before formatting."))?;
    if actual != expected {
        return Err(conflict(
            "This drive changed. Review it again before formatting.",
        ));
    }
    let op_id = uuid::Uuid::new_v4().to_string();
    let result_drive_id = plan
        .drive_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    {
        let mut db = state.db.lock().map_err(|_| internal())?;
        let tx = db.transaction().map_err(|_| internal())?;
        let (current, _, existing) = load_plan(&tx, &id, &user.id)?;
        if let Some(existing) = existing {
            let op = get_operation(&tx, &existing)?;
            return Ok(Json(op));
        }
        if current.expires_at <= now() || current.review_ready_at.is_none_or(|ready| ready > now())
        {
            return Err(conflict(
                "This format plan has expired. Review the drive again.",
            ));
        }
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE device=?1 AND state IN ('queued','running'))", [&plan.device], |r| r.get(0)).map_err(|_| internal())?;
        if busy {
            return Err(conflict("Luna is already formatting this drive."));
        }
        tx.execute("INSERT INTO drive_format_operations (id,plan_id,drive_id,device,label,state,phase,destructive_started,encrypted,filesystem) VALUES (?1,?2,?3,?4,?5,'queued','Waiting',0,?6,?7)", params![op_id,id,result_drive_id,plan.device,plan.label,plan.encrypted,plan.filesystem]).map_err(|_| internal())?;
        tx.execute(
            "UPDATE drive_format_plans SET operation_id=?1 WHERE id=?2",
            params![op_id, id],
        )
        .map_err(|_| internal())?;
        // A second preview of the same physical drive cannot authorize a
        // later wipe after this one changes its contents.
        tx.execute("UPDATE drive_format_plans SET expires_at=0 WHERE id<>?1 AND operation_id IS NULL AND json_extract(body,'$.device')=?2", params![id,plan.device]).map_err(|_| internal())?;
        tx.commit().map_err(|_| internal())?;
    }
    let worker_state = state.clone();
    let worker_id = op_id.clone();
    tokio::spawn(async move {
        // Every plan for a physical disk shares a lock, including plans made
        // before and after that disk is registered in Luna.
        let _disk_guard = worker_state
            .db
            .drive_lock(&format!("format-device:{}", plan.device))
            .lock_owned()
            .await;
        let _drive_guard = if let Some(id) = &plan.drive_id {
            Some(worker_state.db.drive_lock(id).lock_owned().await)
        } else {
            None
        };
        let _closing = plan
            .drive_id
            .as_ref()
            .map(|id| worker_state.drive_manager.begin_closing(id));
        let blocking_state = worker_state.clone();
        let blocking_id = worker_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            run_worker(
                &blocking_state,
                &blocking_id,
                &plan,
                &expected,
                &result_drive_id,
                body.password.as_deref().unwrap_or(""),
            )
        })
        .await;
        if result.is_err() {
            record_failure(
                &worker_state,
                &worker_id,
                "Luna couldn't finish formatting this drive.",
            );
        }
    });
    let db = state.db.lock().map_err(|_| internal())?;
    Ok(Json(get_operation(&db, &op_id)?))
}

fn update_operation(
    state: &AppState,
    id: &str,
    status: &str,
    phase: &str,
    error: Option<&str>,
    destructive: Option<bool>,
) -> anyhow::Result<()> {
    let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
    db.execute("UPDATE drive_format_operations SET state=?1,phase=?2,error=?3,destructive_started=COALESCE(?4,destructive_started) WHERE id=?5", params![status,phase,error,destructive,id])?;
    Ok(())
}
fn run_worker(
    state: &AppState,
    id: &str,
    plan: &Plan,
    expected: &str,
    result_drive_id: &str,
    password: &str,
) {
    let result = run_worker_inner(state, id, plan, expected, result_drive_id, password);
    if let Err(e) = result {
        tracing::warn!(operation = id, error = %e, "format failed");
        record_failure(state, id, &e.to_string());
    }
}

fn record_failure(state: &AppState, id: &str, error: &str) {
    let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let destructive: bool = db
        .query_row(
            "SELECT destructive_started FROM drive_format_operations WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(true);
    let drive_id: Option<String> = db
        .query_row(
            "SELECT drive_id FROM drive_format_operations WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    if let Some(drive_id) = &drive_id
        && destructive
    {
        let _ = crate::db::set_drive_converting(&db, drive_id, true);
    }
    let _ = db.execute(
        "UPDATE drive_format_operations SET state='failed',error=?1 WHERE id=?2",
        params![error, id],
    );
    drop(db);
    if let Some(drive_id) = &drive_id {
        let finished =
            crate::drives::format_lifecycle::finish_format(state, drive_id, false).is_ok();
        if !destructive && finished {
            let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
            let _ = crate::db::set_drive_converting(&db, drive_id, false);
        }
    }
}

fn mark_destructive(state: &AppState, id: &str, plan: &Plan) -> anyhow::Result<()> {
    update_operation(state, id, "running", "Formatting drive", None, Some(true))?;
    if let Some(drive_id) = &plan.drive_id {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        crate::drives::format_lifecycle::invalidate_formatted_contents(&db, drive_id)?;
    }
    Ok(())
}

fn format_mock(
    root: &FsPath,
    plan: &Plan,
    expected: &str,
    fs: Filesystem,
) -> anyhow::Result<crate::drives::format::Formatted> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::OpenOptionsExt;
    // Keep every removal relative to the directory we opened, even if its
    // path is replaced concurrently. Child symlinks are unlinked, not followed.
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)?;
    let metadata = directory.metadata()?;
    let expected_identity = format!(
        "mock|{}|{}|{}",
        root.display(),
        metadata.dev(),
        metadata.ino()
    );
    if expected.rsplit_once('|').map(|(identity, _)| identity) != Some(expected_identity.as_str()) {
        anyhow::bail!("This drive changed while Luna was formatting it.");
    }
    let anchored = std::path::PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    let config_path = anchored.join(".drive.json");
    let mut config = if config_path.exists() {
        if std::fs::symlink_metadata(&config_path)?
            .file_type()
            .is_symlink()
        {
            anyhow::bail!("Luna can't safely format this simulated drive.");
        }
        serde_json::from_slice::<crate::dev_mock::MockDriveConfig>(&std::fs::read(&config_path)?)?
    } else {
        crate::dev_mock::MockDriveConfig::default()
    };
    for entry in std::fs::read_dir(&anchored)? {
        same_attachment(&plan.device, expected)?;
        let entry = entry?;
        if entry.file_name() == ".drive.json" {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    same_attachment(&plan.device, expected)?;
    config.fs_type = Some(fs.as_str().to_string());
    let temporary = anchored.join(format!(".format-config-{}", uuid::Uuid::new_v4()));
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(&config)?)?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, config_path)?;
    same_attachment(&plan.device, expected)?;
    Ok(crate::drives::format::Formatted {
        partition: plan.device.clone(),
        filesystem: fs,
        encrypted: false,
    })
}

fn run_worker_inner(
    state: &AppState,
    id: &str,
    plan: &Plan,
    expected: &str,
    result_drive_id: &str,
    password: &str,
) -> anyhow::Result<()> {
    update_operation(state, id, "running", "Preparing drive", None, None)?;
    if fingerprint(&plan.device)? != expected {
        anyhow::bail!("This drive changed. Review it again before formatting.");
    }
    ensure_safe_disk(state, &plan.device, plan.drive_id.as_deref())?;
    let fs = Filesystem::parse(&plan.filesystem)
        .ok_or_else(|| anyhow::anyhow!("This filesystem is not supported."))?;
    if mock_root(&plan.device).is_none() {
        check_tools(fs, plan.encrypted)?;
    }
    if let Some(drive_id) = &plan.drive_id {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = crate::db::get_drive(&db, drive_id)?
            .ok_or_else(|| anyhow::anyhow!("Luna no longer knows this drive."))?;
        if row.device != plan.device {
            anyhow::bail!("This drive changed. Review it again before formatting.");
        }
        crate::db::set_drive_converting(&db, drive_id, true)?;
    }
    let quiesced = match &plan.drive_id {
        Some(drive_id) => Some(crate::drives::format_lifecycle::quiesce_for_format(
            state, drive_id,
        )?),
        None => None,
    };
    let target = Target {
        filesystem: fs,
        label: plan.label.clone(),
        encrypt: plan.encrypted,
    };
    let made =
        if let Some(root) = mock_root(&plan.device) {
            if plan.encrypted {
                anyhow::bail!("Encryption isn't available for a simulated drive.");
            }
            if fingerprint(&plan.device)? != expected {
                anyhow::bail!("This drive changed. Review it again before formatting.");
            }
            mark_destructive(state, id, plan)?;
            format_mock(&root, plan, expected, fs)
                .map_err(|e| crate::drives::format::FormatError::Other(e.to_string()))
        } else {
            crate::drives::format::run_checked(
                state.drive_manager.probe(),
                state.drive_manager.luks(),
                state.drive_manager.mkfs(),
                &plan.device,
                &target,
                password,
                |path| state.drive_manager.mounter().unmount(path),
                || {
                    if let Some(drive_id) = &plan.drive_id
                        && state.drive_manager.luks().is_open(drive_id)
                    {
                        state.drive_manager.luks().close(drive_id).map_err(|e| {
                            crate::drives::format::FormatError::Other(e.to_string())
                        })?;
                    }
                    if fingerprint(&plan.device)
                        .map_err(|e| crate::drives::format::FormatError::Other(e.to_string()))?
                        != expected
                    {
                        return Err(crate::drives::format::FormatError::Other(
                            "This drive changed. Review it again before formatting.".into(),
                        ));
                    }
                    ensure_no_holders(&plan.device)
                        .map_err(|e| crate::drives::format::FormatError::Other(e.to_string()))?;
                    if !crate::drives::mounted_points_for_disk(&plan.device).is_empty() {
                        return Err(crate::drives::format::FormatError::Busy);
                    }
                    check_tools(fs, plan.encrypted)
                        .map_err(|e| crate::drives::format::FormatError::Other(e.to_string()))?;
                    mark_destructive(state, id, plan)
                        .map_err(|e| crate::drives::format::FormatError::Other(e.to_string()))?;
                    Ok(())
                },
                || same_attachment(&plan.device, expected),
            )
        };
    let result = match made {
        Ok(made) => {
            same_attachment(&plan.device, expected)?;
            update_operation(state, id, "running", "Opening drive", None, None)?;
            let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
            state.drive_manager.register_formatted(
                &db,
                &plan.device,
                &made.partition,
                Some(result_drive_id),
                &plan.label,
                made.filesystem,
                made.encrypted,
                password,
            )
        }
        Err(e) => Err(anyhow::anyhow!(e.to_string())),
    };
    let row = result?;
    crate::drives::format_lifecycle::finish_format(state, &row.id, true)?;
    {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let tx = db.unchecked_transaction()?;
        crate::db::set_drive_converting(&tx, &row.id, false)?;
        tx.execute("UPDATE drive_format_operations SET state='succeeded', phase='Ready', error=NULL WHERE id=?1", [id])?;
        tx.commit()?;
    }
    drop(quiesced);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn fixture() -> (tempfile::TempDir, AppState, CurrentUser, Plan) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let manager = Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = AppState::new(conn, manager, dir.path());
        let user = CurrentUser {
            id: "admin-1".into(),
            username: "admin".into(),
            role: "admin".into(),
        };
        let plan = Plan {
            id: "plan-1".into(),
            drive_id: None,
            device: "sdz".into(),
            model: "Test".into(),
            label: "Files".into(),
            size_bytes: 1024,
            filesystem: "ext4".into(),
            encrypted: false,
            scope: "drive".into(),
            partitions: vec![],
            consequences: vec![],
            expires_at: now() + 900,
            review_seconds: REVIEW_SECONDS,
            review_ready_at: None,
        };
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO drive_format_plans (id,owner,body,fingerprint,expires_at) VALUES (?1,?2,?3,?4,?5)", params![plan.id,user.id,serde_json::to_string(&plan).unwrap(),"test-fingerprint",plan.expires_at]).unwrap();
        }
        (dir, state, user, plan)
    }
    fn user(id: &str) -> CurrentUser {
        CurrentUser {
            id: id.into(),
            username: id.into(),
            role: "admin".into(),
        }
    }

    #[tokio::test]
    async fn review_begins_once_and_start_refuses_before_timer() {
        let (_dir, state, owner, plan) = fixture();
        let before = now();
        let Json(first) = review(
            State(state.clone()),
            Extension(owner),
            Path(plan.id.clone()),
        )
        .await
        .unwrap();
        assert!(first.review_ready_at.unwrap() >= before + REVIEW_SECONDS);
        let Json(second) = review(
            State(state.clone()),
            Extension(user("admin-1")),
            Path(plan.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(first.review_ready_at, second.review_ready_at);
        let result = start(
            State(state),
            Extension(user("admin-1")),
            Path(plan.id),
            Json(StartRequest { password: None }),
        )
        .await;
        assert!(matches!(result, Err((StatusCode::CONFLICT, _))));
    }

    #[tokio::test]
    async fn plans_are_bound_to_the_admin_and_repeated_start_returns_same_operation() {
        let (_dir, state, _owner, plan) = fixture();
        let denied = review(
            State(state.clone()),
            Extension(user("other-admin")),
            Path(plan.id.clone()),
        )
        .await;
        assert!(matches!(denied, Err((StatusCode::NOT_FOUND, _))));
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO drive_format_operations (id,plan_id,drive_id,device,label,state,phase,destructive_started,encrypted,filesystem) VALUES ('op-1',?1,NULL,'sdz','Files','succeeded','Ready',1,0,'ext4')", [&plan.id]).unwrap();
            db.execute(
                "UPDATE drive_format_plans SET operation_id='op-1', expires_at=0 WHERE id=?1",
                [&plan.id],
            )
            .unwrap();
        }
        let Json(op) = start(
            State(state),
            Extension(user("admin-1")),
            Path(plan.id),
            Json(StartRequest { password: None }),
        )
        .await
        .unwrap();
        assert_eq!(op.id, "op-1");
        assert_eq!(op.state, "succeeded");
    }

    #[test]
    fn invalidated_plan_reads_expiry_from_database() {
        let (_dir, state, _user, plan) = fixture();
        let db = state.db.lock().unwrap();
        db.execute(
            "UPDATE drive_format_plans SET expires_at=0 WHERE id=?1",
            [&plan.id],
        )
        .unwrap();
        assert_eq!(load_plan(&db, &plan.id, "admin-1").unwrap().0.expires_at, 0);
    }

    #[test]
    fn fingerprint_changes_for_replug_and_partition_geometry() {
        let path = FsPath::new("/sys/devices/usb/disk");
        let original = fingerprint_value(path, "8:16", 7, 1000, &["sdb1:8:17:1:999".into()]);
        assert_ne!(
            original,
            fingerprint_value(path, "8:16", 8, 1000, &["sdb1:8:17:1:999".into()])
        );
        assert_ne!(
            original,
            fingerprint_value(path, "8:16", 7, 1000, &["sdb1:8:17:2:998".into()])
        );
    }

    #[test]
    fn preview_mount_releases_even_when_inspection_stops_early() {
        use crate::drives::mount::Mounter;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("preview");
        let mounter = crate::drives::mount::shared_mock();
        mounter.mount("/dev/sdz1", &target, true).unwrap();
        {
            let _guard = PreviewMount {
                mounter: mounter.as_ref(),
                target: target.clone(),
            };
            assert!(mounter.is_mounted(&target));
        }
        assert!(!mounter.is_mounted(&target));
        assert_eq!(mounter.unmounts.lock().unwrap().len(), 1);
    }
}
