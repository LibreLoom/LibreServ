use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::auth::user_json;
use crate::api::response::json_error;
use crate::auth::AuthError;

#[derive(Deserialize)]
struct CreateUser {
    username: String,
    display_name: Option<String>,
    password: String,
    role: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/users", get(list).post(create))
        .route("/api/v1/users/directory", get(directory))
        .route("/api/v1/users/{id}", delete(remove))
}

/// Household people picker for Members (album invites, etc.).
/// Returns only non-sensitive identity fields — not an Admin user-management API.
async fn directory(
    State(state): State<AppState>,
    Extension(_user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let users = state.auth.list_users().map_err(map_err)?;
    Ok(Json(
        users
            .iter()
            .map(|u| {
                json!({
                    "id": u.id,
                    "username": u.username,
                    "display_name": u.display_name,
                })
            })
            .collect(),
    ))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    let users = state.auth.list_users().map_err(map_err)?;
    Ok(Json(users.iter().map(user_json).collect()))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    let role = body.role.as_deref().unwrap_or("user");
    let user = state
        .auth
        .register(
            &body.username,
            body.display_name.as_deref().unwrap_or(&body.username),
            &body.password,
            role,
        )
        .map_err(map_err)?;
    Ok(Json(user_json(&user)))
}

async fn remove(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    if admin.id == id {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "You can't remove your own account.",
        ));
    }
    state.auth.delete_user(&id).map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "Only an Admin can manage users.")
        }
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        AuthError::PasswordPolicy(msg) => json_error(StatusCode::BAD_REQUEST, &msg),
        AuthError::Taken => json_error(StatusCode::CONFLICT, "That username is already taken."),
        AuthError::BadUsername => json_error(
            StatusCode::BAD_REQUEST,
            "Usernames are 3-32 letters, numbers, dots, dashes, or underscores.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update users. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use crate::{AppState, db};
    use tower::ServiceExt;

    fn app_with_admin_and_member() -> (tempfile::TempDir, AppState, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let admin_token = auth.issue(&admin).unwrap();
        let member_token = auth.issue(&member).unwrap();
        (dir, state, admin_token, member_token)
    }

    #[tokio::test]
    async fn directory_is_available_to_members() {
        let (_dir, state, _admin_token, member_token) = app_with_admin_and_member();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/users/directory")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.as_array().unwrap().len() >= 2);
        assert!(v[0].get("password_hash").is_none());
        assert!(v[0].get("role").is_none());
        assert!(v[0].get("id").is_some());
        assert!(v[0].get("username").is_some());
    }

    #[tokio::test]
    async fn list_users_rejects_members() {
        let (_dir, state, _admin_token, member_token) = app_with_admin_and_member();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/users")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
