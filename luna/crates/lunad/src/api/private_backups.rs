//! Private items: the owner-facing and admin-facing backup listings and actions.
use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::access;
use crate::api::cloud_backups::connect_store;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser};
use crate::backup::access_list::{self, PrivateSource};
use crate::backup::cloud::ops;
use crate::backup::drive_backup;
use crate::backup::status::BackupState;
use crate::db::{self, ProtectionRow};
use crate::private::{self, OwnerState};

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/private-backups/item", get(item))
        .route("/api/v1/private-backups/mine", get(mine))
        .route("/api/v1/private-backups/summary", get(summary))
        .route(
            "/api/v1/private-backups/owners/{owner}",
            delete(remove_owner),
        )
        .route(
            "/api/v1/private-backups/old-copies",
            delete(remove_old_copies),
        )
}

#[derive(Deserialize)]
struct ItemQuery {
    drive: String,
    path: String,
}

/// What a folder is, for the person looking at it. Needs Read on the folder;
/// otherwise it looks like the folder doesn't exist.
async fn item(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<ItemQuery>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let path = access::normalize_subject_path(&query.path);
    if !auth::has_cap(&user, &conn, &query.drive, &path, access::CAP_VIEW) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find this folder.",
        ));
    }
    let (private, inside, owner) = match access_list::private_source(&conn, &query.drive, &path) {
        PrivateSource::OwnItem { owner } => (true, false, owner),
        PrivateSource::Inside => (false, true, String::new()),
        PrivateSource::Shared => (false, false, String::new()),
    };
    Ok(Json(json!({
        "private": private,
        "inside_private": inside,
        "mine": private && owner == user.id,
        "owner_name": if private { display_name(&conn, &owner) } else { String::new() },
    })))
}

/// The private folders the signed-in person owns, on every drive Luna can read.
async fn mine(State(state): State<AppState>, Extension(user): Extension<CurrentUser>) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let rows = db::list_protections(&conn)
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, LOAD_FAILED))?;
    let mut items = Vec::new();
    for drive in db::list_drives(&conn).unwrap_or_default() {
        if drive.mount_point.is_empty() || !(drive.state == "as_is" || drive.state == "readonly") {
            continue;
        }
        let root = PathBuf::from(&drive.mount_point);
        for item in private::under(&root, "") {
            if item.owner != user.id {
                continue;
            }
            if !root.join(private::disk_rel(&root, &item.path)).is_dir() {
                continue;
            }
            let mine: Vec<&ProtectionRow> = rows
                .iter()
                .filter(|r| {
                    r.private_owner == user.id
                        && r.source_drive == drive.id
                        && r.state == db::PROTECTION_ACTIVE
                        && access::normalize_subject_path(&r.source_path) == item.path
                })
                .collect();
            items.push(json!({
                "drive_id": drive.id,
                "path": format!("/{}", item.path),
                "name": item.name(),
                "drive_backups": mine.iter().filter(|r| r.kind == db::PROTECTION_DRIVE).count(),
                "cloud_backup": mine.iter().any(|r| r.kind == db::PROTECTION_CLOUD),
            }));
        }
    }
    Ok(Json(json!({ "items": items })))
}

/// One line per owner of private backups: an Admin sees every owner, anyone
/// else only themselves. Never paths, item names or sizes.
async fn summary(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let now = db::now_unix();
    let rows = db::list_protections(&conn)
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, LOAD_FAILED))?;
    let mut by_owner: BTreeMap<String, Vec<&ProtectionRow>> = BTreeMap::new();
    for row in rows.iter().filter(|r| !r.private_owner.is_empty()) {
        if user.role != "admin" && row.private_owner != user.id {
            continue;
        }
        by_owner
            .entry(row.private_owner.clone())
            .or_default()
            .push(row);
    }
    let owners: Vec<Value> = by_owner
        .iter()
        .map(|(owner, list)| {
            let deleted = private::owner_state(&conn, owner) != OwnerState::Active;
            json!({
                "owner_id": owner,
                "name": if deleted { String::new() } else { display_name(&conn, owner) },
                "deleted": deleted,
                "backups": list.len(),
                "needs_look": list.iter().any(|r| needs_look(&conn, r, now)),
            })
        })
        .collect();
    Ok(Json(json!({ "owners": owners })))
}

/// Removes every backup of a private item whose owner has been deleted from
/// this Luna. Admin only. Cloud copies go through Connect first.
async fn remove_owner(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(owner): Path<String>,
) -> ApiResult {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can remove these backups.",
        ));
    }
    let rows: Vec<ProtectionRow> = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        if private::owner_state(&conn, &owner) == OwnerState::Active {
            return Err(json_error(
                StatusCode::CONFLICT,
                "This person still has an account. Only they can remove their private backups.",
            ));
        }
        db::list_protections(&conn)
            .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, LOAD_FAILED))?
            .into_iter()
            .filter(|r| r.private_owner == owner)
            .collect()
    };
    // A copy in progress would write into the backup while it is removed.
    if rows.iter().any(|r| drive_backup::is_running(&r.id)) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Luna is copying one of these backups right now. Remove them when the copy finishes.",
        ));
    }
    let (cloud, local): (Vec<ProtectionRow>, Vec<ProtectionRow>) = rows
        .into_iter()
        .partition(|r| r.kind == db::PROTECTION_CLOUD);
    let mut removed = 0usize;

    if !cloud.is_empty() {
        let ids: Vec<String> = cloud.into_iter().map(|r| r.id).collect();
        let connect = state.connect.clone();
        let db = state.db.clone();
        let job = tokio::task::spawn_blocking(move || -> Result<Option<usize>, String> {
            // Their copies in the cloud can only be removed through Connect.
            let Some(store) = connect_store(&connect, &db) else {
                return Ok(None);
            };
            for id in &ids {
                ops::delete(&db, id, &store, db::now_unix()).map_err(|e| e.to_string())?;
            }
            Ok(Some(ids.len()))
        })
        .await;
        match job {
            Ok(Ok(Some(n))) => removed += n,
            Ok(Ok(None)) => {
                return Err(json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Connect this Luna to Luna Connect before deleting a cloud backup. Its copies in the cloud can't be removed until then. Settings → Luna Connect.",
                ));
            }
            Ok(Err(text)) => return Err(json_error(StatusCode::SERVICE_UNAVAILABLE, text)),
            Err(_) => {
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't remove these backups. Try again.",
                ));
            }
        }
    }

    for row in &local {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        drive_backup::delete(&conn, row).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't delete this backup. Try again.",
            )
        })?;
        removed += 1;
    }
    Ok(Json(json!({ "removed": removed })))
}

/// Ends the grace period of the signed-in person's old-phrase copies now, so the
/// next sweep removes them. Only their own copies are touched.
async fn remove_old_copies(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    ops::retire_old_phrase_now(&conn, &user.id, db::now_unix()).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove your old copies. Try again.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

const LOAD_FAILED: &str = "Luna couldn't load your private backups. Try again.";

/// The owner's name as shown to others, or "" when they have no account here.
fn display_name(conn: &Connection, id: &str) -> String {
    match db::get_user(conn, id) {
        Ok(Some(u)) if !u.display_name.trim().is_empty() => u.display_name,
        Ok(Some(u)) => u.username,
        _ => String::new(),
    }
}

/// Whether a backup needs someone to look at it: not active, failing, or
/// (cloud) its last check found a problem.
fn needs_look(conn: &Connection, row: &ProtectionRow, now: i64) -> bool {
    if row.state != db::PROTECTION_ACTIVE {
        return true;
    }
    if row.kind == db::PROTECTION_CLOUD {
        ops::state(row, now) != BackupState::Ok || ops::last_check_problem(conn, &row.id).is_some()
    } else {
        drive_backup::state(row, now) != BackupState::Ok
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::private;
    use crate::{AppState, db};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_token: String,
        owner_token: String,
        stranger_token: String,
        owner_id: String,
        stranger_id: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let owner = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let stranger = auth
            .register("Sam", "Sam", "hunter22hunter1", "user")
            .unwrap();
        {
            let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
            mounted(dir.path(), &conn);
        }
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Fixture {
            admin_token: auth.issue(&admin).unwrap(),
            owner_token: auth.issue(&owner).unwrap(),
            stranger_token: auth.issue(&stranger).unwrap(),
            owner_id: owner.id.clone(),
            stranger_id: stranger.id.clone(),
            _dir: dir,
            state,
            router,
        }
    }

    /// A mounted drive "drive-a" with a Luna marker, registered in the db.
    fn mounted(dir: &Path, conn: &rusqlite::Connection) {
        let mount = dir.join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
        crate::drives::drive_db::create(
            &mount,
            &luna_core::marker::Marker::new("drive-a", "A"),
            &prefix,
        )
        .unwrap();
        db::upsert_drive(
            conn,
            "drive-a",
            "A",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        db::set_drive_state(conn, "drive-a", "as_is").unwrap();
    }

    /// A private folder "Private" on drive-a owned by `owner`, with its drive backup.
    fn make_private(state: &AppState, dir: &Path, name: &str, owner: &str, backup_id: &str) {
        let root = dir.join("drive-a");
        let item = private::create(&root, name, owner).unwrap();
        std::fs::create_dir_all(root.join(private::disk_rel(&root, &item.path))).unwrap();
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        seed(&conn, backup_id, db::PROTECTION_DRIVE, name, owner);
    }

    fn seed(conn: &rusqlite::Connection, id: &str, kind: &str, source_path: &str, owner: &str) {
        db::insert_protection(
            conn,
            &db::NewProtection {
                id,
                kind,
                source_drive: "drive-a",
                source_path,
                target_drive: "drive-a",
                private_owner: owner,
                created_by: owner,
                created_at: 0,
            },
        )
        .unwrap();
    }

    async fn send(router: &Router, method: &str, uri: &str, token: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn item_says_mine_for_owner_and_404_for_stranger() {
        let f = fixture();
        let dir = f._dir.path().to_path_buf();
        make_private(&f.state, &dir, "Private", &f.owner_id, "b-private");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/private-backups/item?drive=drive-a&path=Private",
            &f.owner_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["private"], true);
        assert_eq!(body["inside_private"], false);
        assert_eq!(body["mine"], true);
        assert_eq!(body["owner_name"], "Jamie");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/private-backups/item?drive=drive-a&path=Private",
            &f.stranger_token,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"], "Luna can't find this folder.");
    }

    #[tokio::test]
    async fn mine_lists_only_own_private_folders() {
        let f = fixture();
        let dir = f._dir.path().to_path_buf();
        make_private(&f.state, &dir, "Private", &f.owner_id, "b-private");
        make_private(&f.state, &dir, "Theirs", &f.stranger_id, "b-theirs");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/private-backups/mine",
            &f.owner_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{body}");
        assert_eq!(items[0]["drive_id"], "drive-a");
        assert_eq!(items[0]["path"], "/Private");
        assert_eq!(items[0]["name"], "Private");
        assert_eq!(items[0]["drive_backups"], 1);
        assert_eq!(items[0]["cloud_backup"], false);
    }

    #[tokio::test]
    async fn summary_admin_sees_every_owner_member_sees_self() {
        let f = fixture();
        let dir = f._dir.path().to_path_buf();
        make_private(&f.state, &dir, "Private", &f.owner_id, "b-private");
        make_private(&f.state, &dir, "Theirs", &f.stranger_id, "b-theirs");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/private-backups/summary",
            &f.admin_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["owners"].as_array().unwrap().len(), 2, "{body}");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/private-backups/summary",
            &f.owner_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let owners = body["owners"].as_array().unwrap();
        assert_eq!(owners.len(), 1, "{body}");
        assert_eq!(owners[0]["owner_id"], f.owner_id.as_str());
        assert_eq!(owners[0]["deleted"], false);
        assert_eq!(owners[0]["backups"], 1);

        let text = body.to_string();
        assert!(!text.contains("\"path\""), "{text}");
        assert!(!text.contains("source_path"), "{text}");
        assert!(!text.contains("Private"), "{text}");
    }

    #[tokio::test]
    async fn remove_owner_needs_admin_and_deleted_owner() {
        let f = fixture();
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute(
                "INSERT INTO deleted_users (id, username, display_name, deleted_at) VALUES ('gone-user', '', '', 0)",
                [],
            )
            .unwrap();
            seed(&conn, "b-gone", db::PROTECTION_DRIVE, "Old", "gone-user");
        }
        let live = format!("/api/v1/private-backups/owners/{}", f.owner_id);
        let gone = "/api/v1/private-backups/owners/gone-user";

        let (status, body) = send(&f.router, "DELETE", gone, &f.owner_token).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "Only an Admin can remove these backups.");

        let (status, body) = send(&f.router, "DELETE", &live, &f.admin_token).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");

        let (status, body) = send(&f.router, "DELETE", gone, &f.admin_token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["removed"], 1);
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(db::get_protection(&conn, "b-gone").unwrap().is_none());
    }

    #[tokio::test]
    async fn old_copies_sets_retire_after_now() {
        let f = fixture();
        let scope = |name: &str, owner: &str| db::PrivateScope {
            scope: name.to_string(),
            owner: owner.to_string(),
            seal_public: vec![1; 32],
            dedup_key: vec![2; 32],
            state: "old_phrase".to_string(),
            retire_after: 12_345,
            created_at: 0,
        };
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_private_scope(&conn, &scope("owner-old", &f.owner_id)).unwrap();
            db::insert_private_scope(&conn, &scope("stranger-old", &f.stranger_id)).unwrap();
        }

        let before = db::now_unix();
        let (status, body) = send(
            &f.router,
            "DELETE",
            "/api/v1/private-backups/old-copies",
            &f.owner_token,
        )
        .await;
        let after = db::now_unix();
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, serde_json::json!({ "ok": true }));

        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        let owner_scope = db::list_private_scopes(&conn, Some(&f.owner_id)).unwrap();
        assert_eq!(owner_scope.len(), 1);
        assert_eq!(owner_scope[0].state, "old_phrase");
        assert!(
            (before..=after).contains(&owner_scope[0].retire_after),
            "retire_after {} not within {before}..={after}",
            owner_scope[0].retire_after
        );

        let stranger_scope = db::list_private_scopes(&conn, Some(&f.stranger_id)).unwrap();
        assert_eq!(stranger_scope.len(), 1);
        assert_eq!(stranger_scope[0].retire_after, 12_345);
    }
}
