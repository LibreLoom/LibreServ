use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

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

async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let q = query.q.trim();
    if q.len() < 2 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type at least 2 letters to search.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let rows = crate::index::search(&conn, q).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let mut out = Vec::new();
    for (drive_id, parent, name) in rows {
        let full = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        if full == ".luna-trash" || full.starts_with(".luna-trash/") {
            continue;
        }
        if crate::auth::can_access(&user, &conn, &drive_id, &full, false) {
            out.push(json!({ "drive_id": drive_id, "path": full, "name": name }));
        }
    }
    Ok(Json(out))
}

async fn reindex(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let drives = crate::db::list_drives(&conn).unwrap_or_default();
        let mut dirs = 0u64;
        for drive in drives {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            if let Ok(n) =
                crate::index::scan_drive(&conn, &drive.id, std::path::Path::new(&drive.mount_point))
            {
                dirs += n;
            }
        }
        dirs
    });
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
            "Only an admin can do that.",
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
            "Only an admin can do that.",
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
        let conn = db.lock().unwrap();
        let _ = crate::scrub::scrub_all_drives(&conn);
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
            "Only an admin can do that.",
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
    // Un-adopt every drive (remove the `.luna` marker and unmount Luna-owned
    // mounts) so the data is left intact but no longer owned by Luna.
    let drives = crate::db::list_drives(&conn).unwrap_or_default();
    for drive in drives {
        crate::dav::drop_cached_handler(&state, &drive.id);
        if !drive.mount_point.is_empty() {
            let _ = std::fs::remove_file(std::path::Path::new(&drive.mount_point).join(".luna"));
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
    let new_secret =
        crate::secrets::rotate_jwt_secret(&state.data_dir).map_err(|_| {
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
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 9)),
        54321,
    );

    fn test_app(dir: &std::path::Path) -> axum::Router {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir));
        let connect = std::sync::Arc::new(crate::connect::ConnectService::new(
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

    fn req(method: Method, uri: &str, body: &str, cookie: Option<&str>, csrf: Option<&str>) -> HttpReq<Body> {
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
            crate::connect::ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
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
    }
}
