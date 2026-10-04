//! Revocable access tokens for apps, desktop, WebDAV, and helper scripts.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    /// Optional expiry in days from now (not required).
    expires_in_days: Option<u32>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/device-tokens", get(list).post(create))
        .route("/api/v1/device-tokens/{id}", delete(remove))
        .route("/api/v1/device-tokens/{id}/usage", get(usage))
}

fn token_row_json(dt: &crate::db::DeviceTokenRow) -> Value {
    json!({
        "id": dt.id,
        "name": dt.name,
        "created_at": dt.created_at,
        "last_used_at": dt.last_used_at,
        "expires_at": dt.expires_at,
        "revoked": dt.revoked_at.is_some(),
    })
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage access tokens.",
        ),
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update access tokens. Try again.",
        ),
    }
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
    let tokens = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(Json(
        tokens
            .iter()
            .filter(|t| t.revoked_at.is_none())
            .map(token_row_json)
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Give this device a name between 1 and 80 characters.",
        ));
    }

    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't generate a token. Try again.",
            )
        })?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let id = Uuid::new_v4().to_string();
    let expires_at = body.expires_in_days.map(|days| {
        let secs = days.clamp(1, 3650) as i64 * 24 * 60 * 60;
        crate::db::now_unix() + secs
    });

    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    crate::db::insert_device_token(
        &conn,
        &id,
        &user.id,
        name,
        &auth::hash_device_token(&token),
        expires_at,
    )
    .map_err(AuthError::Db)
    .map_err(map_err)?;
    drop(conn);

    Ok(Json(json!({
        "id": id,
        "name": name,
        "created_at": crate::db::now_unix(),
        "last_used_at": 0,
        "expires_at": expires_at,
        "revoked": false,
        "token": token,
    })))
}

async fn usage(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let owned = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?
        .into_iter()
        .any(|t| t.id == id);
    if !owned {
        return Err(json_error(StatusCode::NOT_FOUND, "No such device token."));
    }
    let rows = crate::db::list_device_token_usage(&conn, &id, 50)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "action": r.action,
                    "detail": r.detail,
                    "client": r.client,
                    "origin": r.origin,
                    "used_at": r.used_at,
                })
            })
            .collect(),
    ))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let owned = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?
        .into_iter()
        .any(|t| t.id == id);
    if !owned {
        return Err(json_error(StatusCode::NOT_FOUND, "No such device token."));
    }
    crate::db::revoke_device_token(&conn, &id)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    struct Harness {
        _dir: tempfile::TempDir,
        state: AppState,
        router: axum::Router,
        max: String,
        jamie: String,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let max = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let jamie = state
            .auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let (max, jamie) = (
            state.auth.issue(&max).unwrap(),
            state.auth.issue(&jamie).unwrap(),
        );
        // device-tokens plus one route that any signed-in caller can use, so a
        // minted token can be tried for real.
        let router = axum::Router::new()
            .merge(super::router())
            .merge(crate::api::users::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Harness {
            _dir: dir,
            state,
            router,
            max,
            jamie,
        }
    }

    async fn send(
        h: &Harness,
        method: Method,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let res = h
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn mint(h: &Harness, owner_token: &str, name: &str) -> Value {
        let (status, body) = send(
            h,
            Method::POST,
            "/api/v1/device-tokens",
            owner_token,
            Some(json!({ "name": name })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    #[tokio::test]
    async fn a_new_token_is_shown_once_and_then_works_as_credentials() {
        let h = harness();
        let created = mint(&h, &h.jamie, "Kitchen Mac").await;
        let token = created["token"].as_str().unwrap().to_string();
        assert!(token.len() >= 40, "token should be long and random");

        // The list never repeats the secret.
        let (status, list) = send(&h, Method::GET, "/api/v1/device-tokens", &h.jamie, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "Kitchen Mac");
        assert!(list[0].get("token").is_none());
        assert!(!db_holds_plain_token(&h, &token), "only a hash is stored");

        // And the token itself signs in, as Jamie.
        let (status, _) = send(&h, Method::GET, "/api/v1/users/directory", &token, None).await;
        assert_eq!(status, StatusCode::OK);
        // A made-up one does not.
        let (status, _) = send(
            &h,
            Method::GET,
            "/api/v1/users/directory",
            "not-a-token",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    fn db_holds_plain_token(h: &Harness, token: &str) -> bool {
        let conn = h.state.db.lock().unwrap();
        conn.prepare("SELECT 1 FROM device_tokens WHERE token_hash = ?1")
            .unwrap()
            .exists([token])
            .unwrap()
    }

    #[tokio::test]
    async fn names_are_required_and_bounded() {
        let h = harness();
        for name in ["", "   ", &"x".repeat(81)] {
            let (status, body) = send(
                &h,
                Method::POST,
                "/api/v1/device-tokens",
                &h.jamie,
                Some(json!({ "name": name })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}");
            assert_eq!(
                body["error"],
                "Give this device a name between 1 and 80 characters."
            );
        }
    }

    #[tokio::test]
    async fn expiry_is_clamped_and_an_expired_token_stops_working() {
        let h = harness();
        let now = db::now_unix();
        let (_, one_day) = send(
            &h,
            Method::POST,
            "/api/v1/device-tokens",
            &h.max,
            Some(json!({ "name": "short", "expires_in_days": 0 })),
        )
        .await;
        let secs = one_day["expires_at"].as_i64().unwrap() - now;
        assert!(
            (86_390..=86_410).contains(&secs),
            "0 days becomes 1 day, got {secs}s"
        );
        let (_, long) = send(
            &h,
            Method::POST,
            "/api/v1/device-tokens",
            &h.max,
            Some(json!({ "name": "forever", "expires_in_days": 100000 })),
        )
        .await;
        let days = (long["expires_at"].as_i64().unwrap() - now) / 86_400;
        assert_eq!(days, 3650);

        // A token whose expiry already passed is refused.
        let token = "expired-token-value";
        {
            let conn = h.state.db.lock().unwrap();
            let user = db::get_user_by_username(&conn, "max").unwrap().unwrap();
            db::insert_device_token(
                &conn,
                "expired",
                &user.id,
                "old",
                &crate::auth::hash_device_token(token),
                Some(now - 60),
            )
            .unwrap();
        }
        let (status, _) = send(&h, Method::GET, "/api/v1/users", token, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revoking_stops_the_token_and_hides_it() {
        let h = harness();
        let created = mint(&h, &h.jamie, "Phone").await;
        let (id, token) = (
            created["id"].as_str().unwrap(),
            created["token"].as_str().unwrap(),
        );

        let (status, _) = send(
            &h,
            Method::DELETE,
            &format!("/api/v1/device-tokens/{id}"),
            &h.jamie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&h, Method::GET, "/api/v1/users/directory", token, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (_, list) = send(&h, Method::GET, "/api/v1/device-tokens", &h.jamie, None).await;
        assert_eq!(list, json!([]));
    }

    #[tokio::test]
    async fn nobody_can_see_use_or_revoke_someone_elses_token() {
        let h = harness();
        let created = mint(&h, &h.jamie, "Jamie's phone").await;
        let (id, token) = (
            created["id"].as_str().unwrap(),
            created["token"].as_str().unwrap(),
        );

        // Not even an Admin: tokens belong to the person who made them.
        let (_, max_list) = send(&h, Method::GET, "/api/v1/device-tokens", &h.max, None).await;
        assert_eq!(max_list, json!([]));
        let (status, _) = send(
            &h,
            Method::DELETE,
            &format!("/api/v1/device-tokens/{id}"),
            &h.max,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(
            &h,
            Method::GET,
            &format!("/api/v1/device-tokens/{id}/usage"),
            &h.max,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // The token is untouched.
        let (status, _) = send(&h, Method::GET, "/api/v1/users/directory", token, None).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn usage_log_belongs_to_the_owner_and_records_use() {
        let h = harness();
        let created = mint(&h, &h.jamie, "Desktop").await;
        let (id, token) = (
            created["id"].as_str().unwrap(),
            created["token"].as_str().unwrap(),
        );
        send(&h, Method::GET, "/api/v1/users/directory", token, None).await;
        let (status, usage) = send(
            &h,
            Method::GET,
            &format!("/api/v1/device-tokens/{id}/usage"),
            &h.jamie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(usage.is_array());
        let (status, _) = send(
            &h,
            Method::GET,
            "/api/v1/device-tokens/nope/usage",
            &h.jamie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn changing_a_password_revokes_every_token() {
        let h = harness();
        let created = mint(&h, &h.jamie, "Laptop").await;
        let token = created["token"].as_str().unwrap().to_string();
        let jamie_id = {
            let conn = h.state.db.lock().unwrap();
            db::get_user_by_username(&conn, "jamie")
                .unwrap()
                .unwrap()
                .id
        };
        h.state.auth.revoke_all_device_tokens(&jamie_id).unwrap();
        let (status, _) = send(&h, Method::GET, "/api/v1/users/directory", &token, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
