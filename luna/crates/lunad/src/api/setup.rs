use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AppState;
use crate::api::response::json_error;

const SETUP_KEY: &str = "setup";

#[derive(Serialize, Deserialize, Clone)]
struct SetupState {
    name: String,
    setup_completed: bool,
}

impl Default for SetupState {
    fn default() -> Self {
        Self {
            name: "Luna".into(),
            setup_completed: false,
        }
    }
}

#[derive(Deserialize)]
struct SaveBody {
    name: Option<String>,
    setup_completed: Option<bool>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/setup", get(get_setup))
        .route("/api/v1/setup", post(save_setup))
}

async fn get_setup(
    State(state): State<AppState>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let setup = crate::db::get_meta(&conn, SETUP_KEY)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?
        .and_then(|raw| serde_json::from_str::<SetupState>(&raw).ok())
        .unwrap_or_default();
    Ok(Json(setup))
}

async fn save_setup(
    State(state): State<AppState>,
    Json(body): Json<SaveBody>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let mut setup = crate::db::get_meta(&conn, SETUP_KEY)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?
        .and_then(|raw| serde_json::from_str::<SetupState>(&raw).ok())
        .unwrap_or_default();

    if let Some(name) = body.name {
        let name = name.trim().to_string();
        if name.is_empty() || name.len() > 40 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Give your Luna a name between 1 and 40 characters.",
            ));
        }
        setup.name = name;
    }
    if let Some(done) = body.setup_completed {
        let was_completed = setup.setup_completed;
        setup.setup_completed = done;
        // Rotate the BLE setup code the moment setup finishes. The old code was
        // displayed/printed for first-run pairing; once the device is configured
        // a fresh code must be used, so a leaked old code can't keep granting
        // BLE transport access forever.
        if done && !was_completed {
            let fresh = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
            crate::db::set_meta(&conn, "ble_setup_code", &fresh)
                .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?;
        }
    }

    let raw = serde_json::to_string(&setup).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save setup progress.",
        )
    })?;
    crate::db::set_meta(&conn, SETUP_KEY, &raw)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?;
    Ok(Json(setup))
}

#[cfg(test)]
mod tests {
    use super::SetupState;

    #[test]
    fn default_setup_is_plain() {
        let state = SetupState::default();
        assert_eq!(state.name, "Luna");
        assert!(!state.setup_completed);
    }
}
