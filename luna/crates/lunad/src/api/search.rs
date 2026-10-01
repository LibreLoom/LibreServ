use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::files::search::{KindFilter, indexable_drives, search_all};
use crate::files::search_rank::{Query as NameQuery, Tier};

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    /// `dir` or `file` to show only folders or only files.
    kind: Option<String>,
    limit: Option<usize>,
}

const DEFAULT_LIMIT: usize = 60;
const MAX_LIMIT: usize = 200;

#[derive(Deserialize, Default)]
struct FactoryResetBody {
    #[serde(default)]
    confirm: bool,
    #[serde(default)]
    password: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/search", get(search))
        .route("/api/v1/system/reindex", post(reindex))
        .route("/api/v1/system/scrub", get(scrub_status).post(start_scrub))
        .route("/api/v1/system/factory-reset", post(factory_reset))
}

/// Search file and folder names across every drive the caller can open.
///
/// Results are ranked before access is checked and trimmed to `limit` after,
/// so the limit counts only what the caller can see. `scan` says whether
/// drives are still being read; the page asks again while it is, and results
/// that were already searchable stay put.
async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let raw = query.q.trim().to_string();
    if raw.chars().count() < 2 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type at least 2 letters to search.",
        ));
    }
    let kind = KindFilter::parse(query.kind.as_deref());
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let busy = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    };

    let work_state = state.clone();
    let work_user = user.clone();
    let hits = tokio::task::spawn_blocking(move || {
        let parsed = NameQuery::new(&raw);
        if parsed.is_empty() {
            return Ok(Vec::new());
        }
        let drives = {
            let conn = work_state.db.lock().map_err(|_| ())?;
            indexable_drives(&conn, false)
        };
        let candidates = search_all(&drives, &parsed, kind);
        let conn = work_state.db.lock().map_err(|_| ())?;
        let mut out = Vec::new();
        for candidate in candidates {
            if out.len() >= limit {
                break;
            }
            let hit = candidate.hit;
            let full = if hit.parent.is_empty() {
                hit.name.clone()
            } else {
                format!("{}/{}", hit.parent, hit.name)
            };
            // Anything inside a hidden folder is hidden too.
            if full.split('/').any(|part| part.starts_with('.'))
                || crate::files::is_internal_temp(&full)
                || crate::backup::protect::is_protected_store(&full)
            {
                continue;
            }
            if !crate::auth::has_cap(
                &work_user,
                &conn,
                &hit.drive_id,
                &full,
                crate::access::CAP_VIEW,
            ) {
                continue;
            }
            out.push(json!({
                "drive_id": hit.drive_id,
                "path": full,
                "parent": hit.parent,
                "name": hit.name,
                "kind": hit.kind,
                "size": hit.size,
                "modified": hit.modified,
                "match": match_label(candidate.rank.tier),
            }));
        }
        Ok::<_, ()>(out)
    })
    .await
    .map_err(|_| busy())?
    .map_err(|_| busy())?;

    let close_only = !hits.is_empty() && hits.iter().all(|h| h["match"] == "close");
    let status = state.search_index.status();
    let admin = user.role == "admin";
    Ok(Json(json!({
        "hits": hits,
        "close_only": close_only,
        "scan": {
            "scanning": status.scanning,
            "drives_total": status.drives_total,
            "drives_done": status.drives_done,
            // Folder counts across every drive are for Admins.
            "dirs_indexed": if admin { Some(status.dirs_indexed) } else { None },
        },
    })))
}

/// How a hit matched, for the page: the name, the folder it sits in, or a
/// near miss (a typo away).
fn match_label(tier: Tier) -> &'static str {
    match tier {
        Tier::Path => "path",
        Tier::Close => "close",
        _ => "name",
    }
}

/// Admin: read every drive again from scratch, ignoring folder timestamps.
async fn reindex(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage search.",
        ));
    }
    let drives = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        indexable_drives(&conn, true)
    };
    state
        .search_index
        .rescan(drives.into_iter().map(|d| (d.id, d.mount)).collect(), true);
    Ok(Json(
        json!({ "started": true, "message": "Luna is reading your drives in the background." }),
    ))
}

async fn scrub_status(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage search.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let report = crate::db::get_meta(&conn, "last_scrub_report")
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read scrub status.",
            )
        })?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(json!({ "files_hashed": 0, "files_checked": 0, "mismatches": 0 }));
    Ok(Json(report))
}

async fn start_scrub(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage search.",
        ));
    }
    if state
        .scrub_running
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Luna is already checking files. Try again later.",
        ));
    }
    let db = state.db.clone();
    let flag = state.scrub_running.clone();
    tokio::task::spawn_blocking(move || {
        let _ = crate::drives::scrub::scrub_all_drives_unlocked(&db);
        flag.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is checking your files in the background." }),
    ))
}

/// Wipe all accounts, shares, and settings and return the box to first-run,
/// leaving the actual files on the drives untouched. Also turns off Luna
/// Connect and stops cloud backup so a reset box is not still paired.
async fn factory_reset(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<FactoryResetBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage search.",
        ));
    }
    if !body.confirm {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Confirm that you want to reset this Luna. Everyone will need to sign in again, and remote access will turn off. Files on your drives stay where they are.",
        ));
    }
    if body.password.trim().is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type your current password to confirm this reset.",
        ));
    }
    state
        .auth
        .verify_password_for_user(&user.id, &body.password)
        .map_err(|_| {
            json_error(
                StatusCode::UNAUTHORIZED,
                "That password is wrong. Reset was not started.",
            )
        })?;
    let connect = state.connect.clone();
    let _ = tokio::task::spawn_blocking(move || connect.deactivate()).await;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // Un-adopt every drive (remove this Luna's `.luna-*` marker and unmount
    // Luna-owned mounts) so the data is left intact but no longer owned by
    // Luna.
    let drives = crate::db::list_drives(&conn).unwrap_or_default();
    for drive in drives {
        crate::files::dav::drop_cached_handler(&state, &drive.id);
        if !drive.mount_point.is_empty() {
            let _ = luna_core::marker::remove_marker(
                std::path::Path::new(&drive.mount_point),
                &drive.id,
            );
            let _ = state.drive_manager.eject(&conn, &drive.id);
        }
    }
    crate::db::factory_reset(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the reset. Try again.",
        )
    })?;
    drop(conn);
    let new_secret = crate::secrets::rotate_jwt_secret(&state.data_dir).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the reset. Try again.",
        )
    })?;
    state.auth.reload_secret(new_secret);
    Ok(Json(
        json!({ "ok": true, "message": "Luna has been reset. Set it up again from the start." }),
    ))
}

#[cfg(test)]
mod tests {
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    fn test_app(dir: &std::path::Path) -> axum::Router {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir));
        let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
            dir,
            Some("http://127.0.0.1:1".into()),
        ));
        let state = crate::AppState::new(conn, drive_manager, dir).with_connect(connect);
        api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state)
    }

    fn req(
        method: Method,
        uri: &str,
        body: &str,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        if let Some(t) = csrf {
            builder = builder.header("x-csrf-token", t);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn auth_cookies(res: &axum::response::Response) -> (String, String) {
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (session, csrf)
    }

    fn cookie_header(session: &str, csrf: &str) -> String {
        format!("{session}; luna_csrf={csrf}")
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    #[tokio::test]
    async fn factory_reset_requires_confirm_and_tears_down_connect() {
        let dir = tempfile::tempdir().unwrap();
        let connect =
            crate::net::connect::ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        connect.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        connect
            .apply_claimed(&serde_json::json!({
                "device_token": "tok",
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock"
            }))
            .unwrap();
        assert!(dir.path().join("connect.json").exists());
        let app = test_app(dir.path());

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let cookie = cookie_header(&session, &csrf);

        let denied = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":false}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(denied.status(), 400);
        assert!(dir.path().join("connect.json").exists());

        let ok = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(ok.status(), 200, "reset failed");
        assert!(
            !dir.path().join("connect.json").exists(),
            "Connect state must be removed on factory reset"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("device-token"))
                .unwrap()
                .trim(),
            "ABCD-EFGH-JKMN-PQRS-TVWX",
            "device token must survive factory reset"
        );
    }
}
