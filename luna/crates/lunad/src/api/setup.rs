use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::AppState;
use crate::api::response::json_error;

const SETUP_KEY: &str = "setup";

const VALID_STEPS: &[&str] = &["welcome", "network", "account", "name", "done"];

fn default_step() -> String {
    "welcome".into()
}

#[derive(Serialize, Deserialize, Clone)]
struct SetupState {
    name: String,
    setup_completed: bool,
    /// Wizard step to resume after a refresh or browser close.
    #[serde(default = "default_step")]
    current_step: String,
    /// Non-secret flags/drafts for the wizard (e.g. network_connected).
    #[serde(default)]
    step_data: Map<String, Value>,
}

impl Default for SetupState {
    fn default() -> Self {
        Self {
            name: "Luna".into(),
            setup_completed: false,
            current_step: default_step(),
            step_data: Map::new(),
        }
    }
}

#[derive(Deserialize)]
struct SaveBody {
    name: Option<String>,
    setup_completed: Option<bool>,
    current_step: Option<String>,
    step_data: Option<Map<String, Value>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/setup", get(get_setup))
        .route("/api/v1/setup", post(save_setup))
}

async fn get_setup(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    let has_users = state.auth.count_users().unwrap_or(0) > 0;
    if has_users && current.is_none() {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Sign in to Luna first.",
        ));
    }
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
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<SaveBody>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    let has_users = state.auth.count_users().unwrap_or(0) > 0;
    if has_users {
        let Some(Extension(user)) = current else {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "Sign in to Luna first.",
            ));
        };
        if user.role != "admin" {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only an admin can change setup.",
            ));
        }
    }

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
    if let Some(step) = body.current_step {
        if !VALID_STEPS.contains(&step.as_str()) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                format!("That setup step isn't valid: {step}"),
            ));
        }
        setup.current_step = step;
    }
    if let Some(data) = body.step_data {
        setup.step_data = data;
    }
    if let Some(done) = body.setup_completed {
        setup.setup_completed = done;
        if done {
            setup.current_step = "done".into();
            // Keep name; drop mid-wizard drafts once setup is finished.
            setup.step_data.clear();
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
    use super::{SetupState, VALID_STEPS, default_step};
    use serde_json::json;

    #[test]
    fn default_setup_is_plain() {
        let state = SetupState::default();
        assert_eq!(state.name, "Luna");
        assert!(!state.setup_completed);
        assert_eq!(state.current_step, "welcome");
        assert!(state.step_data.is_empty());
    }

    #[test]
    fn legacy_meta_without_progress_fields_deserializes() {
        let raw = r#"{"name":"Kitchen","setup_completed":false}"#;
        let state: SetupState = serde_json::from_str(raw).expect("legacy setup json");
        assert_eq!(state.name, "Kitchen");
        assert_eq!(state.current_step, default_step());
        assert!(state.step_data.is_empty());
    }

    #[test]
    fn progress_round_trips() {
        let mut state = SetupState::default();
        state.current_step = "account".into();
        state
            .step_data
            .insert("network_connected".into(), json!(true));
        let raw = serde_json::to_string(&state).unwrap();
        let back: SetupState = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.current_step, "account");
        assert_eq!(back.step_data.get("network_connected"), Some(&json!(true)));
    }

    #[test]
    fn valid_steps_cover_wizard() {
        for step in ["welcome", "network", "account", "name", "done"] {
            assert!(VALID_STEPS.contains(&step), "missing {step}");
        }
    }
}
