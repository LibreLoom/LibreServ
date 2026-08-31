use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};

#[derive(Deserialize)]
struct CreateGrant {
    user_id: String,
    drive_id: String,
    path: Option<String>,
    permission: String,
}

#[derive(Deserialize)]
struct UpdateGrant {
    permission: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/grants", get(list).post(create))
        .route("/api/v1/grants/{id}", patch(update).delete(remove))
        .route("/api/v1/me/access", get(my_access))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let grants = if user.role == "admin" {
        crate::db::list_all_grants(&conn)
    } else {
        crate::db::list_grants_for_user(&conn, &user.id)
    }
    .map_err(|e| map_err(AuthError::Db(e)))?;
    let grants = crate::grants::dedupe_identical(&grants);
    Ok(Json(
        grants
            .into_iter()
            .map(|g| {
                json!({
                    "id": g.id,
                    "user_id": g.user_id,
                    "drive_id": g.drive_id,
                    "path": g.path,
                    "permission": g.permission,
                })
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<auth::CurrentUser>,
    Json(body): Json<CreateGrant>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let permission = normalize_permission(&body.permission)?;
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let id = Uuid::new_v4().to_string();
    crate::grants::create_user_grant(
        &conn,
        &id,
        &body.user_id,
        &body.drive_id,
        body.path.as_deref().unwrap_or(""),
        permission,
    )
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "id": id, "ok": true })))
}

async fn update(
    State(state): State<AppState>,
    Extension(admin): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateGrant>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let permission = normalize_permission(&body.permission)?;
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let changed = crate::db::update_grant_permission(&conn, &id, permission)
        .map_err(|e| map_err(AuthError::Db(e)))?;
    if !changed {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That access grant is gone. Refresh and try again.",
        ));
    }
    Ok(Json(json!({ "ok": true, "permission": permission })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(admin): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    crate::db::delete_grant(&conn, &id).map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "ok": true })))
}

async fn my_access(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let grants =
        crate::db::list_grants_for_user(&conn, &user.id).map_err(|e| map_err(AuthError::Db(e)))?;
    let grants = crate::grants::member_access_roots(&grants);
    let drives = crate::db::list_drives(&conn).map_err(|e| map_err(AuthError::Db(e)))?;
    let mut out = Vec::new();
    for grant in grants {
        let label = drives
            .iter()
            .find(|d| d.id == grant.drive_id)
            .map(|d| d.label.clone())
            .unwrap_or_else(|| grant.drive_id.clone());
        out.push(json!({
            "id": grant.id,
            "drive_id": grant.drive_id,
            "drive_label": label,
            "path": grant.path,
            "permission": grant.permission,
        }));
    }
    Ok(Json(out))
}

fn normalize_permission(permission: &str) -> Result<&str, (StatusCode, Json<Value>)> {
    if permission == "read" || permission == "write" {
        Ok(permission)
    } else {
        Err(json_error(
            StatusCode::BAD_REQUEST,
            "Access is either read or read + write.",
        ))
    }
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => json_error(StatusCode::FORBIDDEN, "Only an admin can do that."),
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that. Try again.",
        ),
    }
}

#[cfg(test)]
mod http_tests {
    use crate::api;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq, StatusCode};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 44)),
        54321,
    );

    fn test_app() -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        (dir, app)
    }

    fn json_req(
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

    async fn call(app: &axum::Router, req: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(req).await.unwrap()
    }

    async fn bootstrap_admin(app: &axum::Router) -> (String, String) {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        (cookie_header(&session, &csrf), csrf)
    }

    async fn admin_and_sam(app: &axum::Router) -> (String, String, String) {
        let (admin_cookie, admin_csrf) = bootstrap_admin(app).await;
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let sam_id = v["id"].as_str().unwrap().to_string();
        (admin_cookie, admin_csrf, sam_id)
    }

    #[tokio::test]
    async fn patch_grant_permission_admin_only() {
        let (dir, app) = test_app();
        let (admin_cookie, admin_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g1", &sam_id, "photos", "family", "read").unwrap();
        }

        let res = call(
            &app,
            json_req(
                Method::PATCH,
                "/api/v1/grants/g1",
                r#"{"permission":"write"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            let grants = crate::db::list_all_grants(&conn).unwrap();
            assert_eq!(grants[0].permission, "write");
        }

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"sam","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (sam_session, sam_csrf) = auth_cookies(&res);
        let sam_cookie = cookie_header(&sam_session, &sam_csrf);
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                "/api/v1/grants/g1",
                r#"{"permission":"read"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn patch_missing_grant_is_not_found() {
        let (_dir, app) = test_app();
        let (admin_cookie, admin_csrf) = bootstrap_admin(&app).await;
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                "/api/v1/grants/nope",
                r#"{"permission":"write"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_grant_supersedes_an_equal_row() {
        let (_dir, app) = test_app();
        let (admin_cookie, admin_csrf, sam_id) = admin_and_sam(&app).await;
        let body = format!(
            r#"{{"user_id":"{sam_id}","drive_id":"photos","path":"album/","permission":"read"}}"#
        );
        for _ in 0..2 {
            let res = call(
                &app,
                json_req(
                    Method::POST,
                    "/api/v1/grants",
                    &body,
                    Some(&admin_cookie),
                    Some(&admin_csrf),
                ),
            )
            .await;
            assert_eq!(res.status(), StatusCode::OK);
        }
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/grants",
                "",
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let rows = v.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["path"], "album");
        assert_eq!(rows[0]["permission"], "read");
    }

    #[tokio::test]
    async fn member_access_lists_parent_and_write_exception() {
        let (dir, app) = test_app();
        let (_admin_cookie, _admin_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g-drive", &sam_id, "photos", "", "read").unwrap();
            crate::db::insert_grant(&conn, "g-dcim", &sam_id, "photos", "DCIM", "write").unwrap();
            crate::db::insert_grant(&conn, "g-print", &sam_id, "photos", "DCIM/print", "read")
                .unwrap();
        }
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"sam","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (sam_session, sam_csrf) = auth_cookies(&res);
        let sam_cookie = cookie_header(&sam_session, &sam_csrf);
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/me/access",
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let rows = v.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|g| g["path"] == "" && g["permission"] == "read")
        );
        assert!(
            rows.iter()
                .any(|g| g["path"] == "DCIM" && g["permission"] == "write")
        );
        assert!(!rows.iter().any(|g| g["path"] == "DCIM/print"));
    }
}
