use std::path::PathBuf;

use argon2::password_hash::rand_core::RngCore;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
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
struct CreateShare {
    drive_id: String,
    path: String,
    password: Option<String>,
    expires_in_days: Option<u32>,
}

#[derive(Deserialize)]
struct PublicQuery {
    password: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/shares", get(list).post(create))
        .route("/api/v1/shares/{id}", delete(remove))
        .route("/s/{token}", get(public))
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
    let shares = crate::db::list_shares(&conn).map_err(|e| map_err(AuthError::Db(e)))?;
    let shares = if user.role == "admin" {
        shares
    } else {
        shares
            .into_iter()
            .filter(|s| s.created_by == user.id)
            .collect()
    };
    Ok(Json(
        shares
            .into_iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "drive_id": s.drive_id,
                    "path": s.path,
                    "has_password": !s.password_hash.is_empty(),
                    "expires_at": s.expires_at,
                    "created_by": s.created_by,
                })
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Json(body): Json<CreateShare>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    // A share is a public link to a folder, so the creator needs at least
    // read access to it — otherwise any user could link out other people's
    // drives they have never been granted.
    if !auth::can_access(&user, &conn, &body.drive_id, &body.path, false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to share this folder.",
        ));
    }
    // Validate the path resolves before creating the link.
    crate::files::resolve_any(&conn, &body.drive_id, &body.path).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't find that file or folder.",
        )
    })?;

    let token = generate_token();
    let token_hash = blake3::hash(token.as_bytes()).to_hex().to_string();
    let password_hash = match &body.password {
        Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(map_err)?,
        _ => String::new(),
    };
    let expires_at = body.expires_in_days.map(|days| {
        let secs = days.clamp(1, 3650) as i64 * 24 * 60 * 60;
        crate::db::now_unix() + secs
    });
    let id = Uuid::new_v4().to_string();
    crate::db::insert_share(
        &conn,
        &id,
        &token_hash,
        &body.drive_id,
        &body.path,
        &password_hash,
        expires_at,
        &user.id,
    )
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({
        "id": id,
        "url": format!("/s/{token}"),
        "token": token,
        "expires_at": expires_at,
    })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let share = crate::db::list_shares(&conn)
        .map_err(|e| map_err(AuthError::Db(e)))?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if user.role != "admin" && share.created_by != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the person who made this link can remove it.",
        ));
    }
    crate::db::delete_share(&conn, &id).map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "ok": true })))
}

/// Public share access. `GET /s/{token}` for folders lists entries; for files
/// it streams the content. Optional password via `?password=...`.
async fn public(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<PublicQuery>,
) -> axum::response::Response {
    let result: Result<axum::response::Response, (StatusCode, Json<Value>)> =
        public_inner(state, token, query).await;
    match result {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn public_inner(
    state: AppState,
    token: String,
    query: PublicQuery,
) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    // Keep the SQLite lock scoped to this block: the file-streaming await
    // below must not hold a MutexGuard across an await point.
    let (path, meta, drive_id, path_label, entries) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        let token_hash = blake3::hash(token.as_bytes()).to_hex().to_string();
        let share = crate::db::get_share_by_token_hash(&conn, &token_hash)
            .map_err(|e| map_err(AuthError::Db(e)))?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "This link doesn't exist."))?;

        if let Some(expiry) = share.expires_at
            && crate::db::now_unix() > expiry
        {
            return Err(json_error(StatusCode::GONE, "This link has expired."));
        }
        if !share.password_hash.is_empty() {
            let provided = query.password.unwrap_or_default();
            let parsed =
                argon2::password_hash::PasswordHash::new(&share.password_hash).map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna couldn't open this link.",
                    )
                })?;
            auth::verify_password_hash(&provided, &parsed).map_err(|_| {
                json_error(StatusCode::UNAUTHORIZED, "This link needs its password.")
            })?;
        }

        let (path, meta) =
            crate::files::resolve_any(&conn, &share.drive_id, &share.path).map_err(|_| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "The shared files aren't available right now.",
                )
            })?;
        let entries = if meta.is_dir() {
            crate::files::list_dir(&conn, &share.drive_id, &share.path).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this folder.",
                )
            })?
        } else {
            Vec::new()
        };
        (path, meta, share.drive_id, share.path, entries)
    };

    if meta.is_file() {
        return serve_file(path).await;
    }
    Ok(Json(json!({
        "drive_id": drive_id,
        "path": path_label,
        "entries": entries.into_iter().filter(|e| !e.hidden).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn serve_file(path: PathBuf) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    let file = tokio::fs::File::open(&path).await.map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared file isn't available right now.",
        )
    })?;
    let meta = std::fs::metadata(&path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared file isn't available right now.",
        )
    })?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let disposition = if crate::files::inline_safe(mime.as_ref()) {
        "inline"
    } else {
        "attachment"
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    let builder = axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
        .header(axum::http::header::CONTENT_LENGTH, meta.len().to_string())
        .header(axum::http::header::CACHE_CONTROL, "private, no-store")
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("{disposition}; filename=\"{}\"", name.replace('"', "")),
        );
    let response = builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this link.",
            )
        })?;
    Ok(response)
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
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
