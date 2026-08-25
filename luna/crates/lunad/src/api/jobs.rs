use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::jobs::JobError;

#[derive(Deserialize)]
struct CreateJob {
    kind: String,
    from_drive: String,
    from_path: Option<String>,
    to_drive: String,
    to_path: Option<String>,
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs", post(create).get(list))
        .route("/api/v1/jobs/{id}", get(get_one).delete(cancel))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateJob>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let from_path = body.from_path.as_deref().unwrap_or("");
        let to_path = body.to_path.as_deref().unwrap_or("");
        if !crate::auth::can_access(&user, &conn, &body.from_drive, from_path, false) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to copy from here.",
            ));
        }
        if !crate::auth::can_access(&user, &conn, &body.to_drive, to_path, true) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to save here.",
            ));
        }
    }
    let job = state
        .job_manager
        .enqueue(
            &body.kind,
            &body.from_drive,
            body.from_path.as_deref().unwrap_or(""),
            &body.to_drive,
            body.to_path.as_deref().unwrap_or(""),
            &user.id,
        )
        .await
        .map_err(map_job_err)?;
    Ok(Json(json!({
        "id": job.id,
        "kind": job.kind,
        "state": job.state,
        "progress": job.progress,
        "total": job.total,
    })))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let jobs = if user.role == "admin" {
        state.job_manager.list(limit).map_err(map_job_err)?
    } else {
        state
            .job_manager
            .list_for_user(&user.id, limit)
            .map_err(map_job_err)?
    };
    Ok(Json(jobs.into_iter().map(job_json).collect()))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let job = state
        .job_manager
        .get(&id)
        .map_err(map_job_err)?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."))?;
    if !state.job_manager.owns_or_admin(&job, &user) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this job.",
        ));
    }
    Ok(Json(job_json(job)))
}

async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let job = state
        .job_manager
        .get(&id)
        .map_err(map_job_err)?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."))?;
    if !state.job_manager.owns_or_admin(&job, &user) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this job.",
        ));
    }
    state.job_manager.cancel(&id).map_err(map_job_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn job_json(job: crate::db::JobRow) -> Value {
    json!({
        "id": job.id,
        "kind": job.kind,
        "state": job.state,
        "from_drive": job.from_drive,
        "from_path": job.from_path,
        "to_drive": job.to_drive,
        "to_path": job.to_path,
        "progress": job.progress,
        "total": job.total,
        "error": job.error,
    })
}

fn map_job_err(err: JobError) -> (StatusCode, Json<Value>) {
    match err {
        JobError::UnknownKind => json_error(
            StatusCode::BAD_REQUEST,
            "Luna only knows how to copy or move.",
        ),
        JobError::Conflict => json_error(
            StatusCode::CONFLICT,
            "A file or folder with this name is already there. Choose a different destination.",
        ),
        JobError::Symlink => json_error(StatusCode::BAD_REQUEST, "Luna can't copy links yet."),
        JobError::Files(crate::files::FilesError::UnknownDrive) => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know one of these drives.",
        ),
        JobError::Files(crate::files::FilesError::Path(_)) => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't use that path.")
        }
        JobError::NotFound => json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't start this job. Check the drives and try again.",
        ),
    }
}
