//! Public EuroOffice content + callback endpoints (Document Server facing).

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::office_save_url::{allowed_office_save_url, download_office_save};
use crate::api::response::json_error;
use crate::files::{self, FilesError};

#[derive(Debug, Deserialize)]
pub(crate) struct TokenQuery {
    pub token: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CallbackBody {
    status: i32,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

pub(crate) async fn public_content(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let claims = state.auth.verify_office_token(&query.token).map_err(|_| {
        json_error(
            StatusCode::UNAUTHORIZED,
            "This EuroOffice link expired. Close the file and open it again.",
        )
    })?;

    let (path, meta) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        files::file_path(&conn, &claims.drive_id, &claims.path).map_err(map_files_err)?
    };

    let file = tokio::fs::File::open(&path).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read that file for EuroOffice.",
        )
    })?;
    let stream = ReaderStream::new(file);
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                files::content_disposition_filename(name)
            ),
        )
        .body(Body::from_stream(stream))
        .unwrap())
}

pub(crate) async fn public_callback(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<CallbackBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = headers;
    let claims = state.auth.verify_office_token(&query.token).map_err(|_| {
        json_error(
            StatusCode::UNAUTHORIZED,
            "This EuroOffice link expired. Close the file and open it again.",
        )
    })?;

    // ONLYOFFICE / EuroOffice: 2 = ready to save, 6 = force-save.
    if matches!(body.status, 2 | 6) {
        if !claims.write {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "This EuroOffice session is view-only, so Luna can't save changes.",
            ));
        }
        let Some(raw_url) = body.url.as_deref().filter(|u| !u.is_empty()) else {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "EuroOffice did not send a download link for the saved file.",
            ));
        };
        if allowed_office_save_url(raw_url).is_err() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "EuroOffice sent a save link Luna will not fetch. Close the file and open it again.",
            ));
        }
        let raw_url = raw_url.to_string();
        let bytes = tokio::task::spawn_blocking(move || download_office_save(&raw_url))
            .await
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't finish saving this file.",
                )
            })?
            .map_err(|e| {
                tracing::warn!(error = %e, key = ?body.key, "eurooffice callback download failed");
                json_error(
                    StatusCode::BAD_GATEWAY,
                    "Luna couldn't download the saved file from EuroOffice. Try saving again.",
                )
            })?;

        let drive_id = claims.drive_id.clone();
        let rel = claims.path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), (StatusCode, Json<Value>)> {
            let (dest, _meta) = {
                let conn = state.db.lock().map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna's index is busy. Try again.",
                    )
                })?;
                files::file_path(&conn, &drive_id, &rel).map_err(map_files_err)?
            };
            let parent = dest.parent().ok_or_else(|| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't find where to save this file.",
                )
            })?;
            let temp = files::temp_path(parent);
            std::fs::write(&temp, &bytes).map_err(|_| {
                let _ = std::fs::remove_file(&temp);
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't write the saved file. Check that the drive still has space.",
                )
            })?;
            if let Err(e) = files::install_temp(&temp, &dest, true) {
                let _ = std::fs::remove_file(&temp);
                tracing::warn!(error = %e, "eurooffice save install failed");
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't replace the file with the EuroOffice save.",
                ));
            }
            state.gallery.upsert(&drive_id, &rel);
            state.touch_io_activity();
            let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            state.ram_cache.invalidate_listing(&drive_id, parent_rel);
            state.ram_cache.invalidate_listing_tree(&drive_id, &rel);
            state.ram_cache.invalidate_thumb(&drive_id, &rel);
            Ok(())
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish saving this file.",
            )
        })??;
    }

    Ok(Json(json!({ "error": 0 })))
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive. Make sure it is plugged in.",
        ),
        FilesError::Path(_) => json_error(StatusCode::NOT_FOUND, "Luna can't find that file."),
        FilesError::Io(_) | FilesError::Db(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that file. Try again.",
        ),
    }
}
