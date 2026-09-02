use axum::extract::{ConnectInfo, Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::api::response::json_error;

const SETUP_KEY: &str = "setup";

const VALID_STEPS: &[&str] = &["welcome", "preflight", "network", "account", "name", "done"];

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
    /// Computed on read/write — not persisted in meta.
    #[serde(default, skip_deserializing, skip_serializing)]
    connect_active: bool,
    #[serde(default, skip_deserializing, skip_serializing)]
    setup_origin: String,
}

impl Default for SetupState {
    fn default() -> Self {
        Self {
            name: "Luna".into(),
            setup_completed: false,
            current_step: default_step(),
            step_data: Map::new(),
            connect_active: false,
            setup_origin: "lan".into(),
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

#[derive(Deserialize)]
struct ValidateCodeBody {
    code: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/setup/preflight", get(preflight))
        .route("/api/v1/setup/validate-code", post(validate_code))
        .route("/api/v1/setup/fetch-mag", post(fetch_mag))
        .route("/api/v1/setup", get(get_setup).post(save_setup))
}

async fn preflight(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if !crate::auth::setup_wizard_open(&state) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Setup is already finished.",
        ));
    }
    crate::setup_access::check(&state, &addr, &headers)?;
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    let resp = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        crate::system_health::run_preflight(&data_dir, &conn)
    })
    .await
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't run the system check. Try again.",
        )
    })?;
    let status = if resp.healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    Ok((
        status,
        Json(serde_json::to_value(resp).unwrap_or(json!({}))),
    ))
}

async fn validate_code(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ValidateCodeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if crate::setup_access::is_lan_request(&addr, &headers) {
        return Ok(Json(json!({ "ok": true })));
    }
    let ip = addr.ip().to_string();
    if !state.login_limiter.allow(&format!("setup-code:{ip}")) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    if state.connect.setup_prefix().is_none() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Finish setup from a device on the same home network as Luna (same Wi‑Fi or ethernet). Luna works fully without Luna Connect.",
        ));
    }
    if !state.connect.matches_setup_prefix(&body.code) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That setup code doesn't match. Check the first eight characters (****-****) on your device card or Luna Connect page.",
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn fetch_mag(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !crate::auth::setup_wizard_open(&state) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Setup is already finished.",
        ));
    }
    crate::setup_access::check(&state, &addr, &headers)?;
    let connect = state.connect.clone();
    let outcome = tokio::task::spawn_blocking(move || connect.ensure_device_code_from_mag())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read the device token from the installer USB.",
            )
        })?;
    Ok(Json(mag_outcome_json(&outcome)))
}

fn mag_outcome_json(outcome: &crate::factory_mag::MagFetchOutcome) -> Value {
    match outcome {
        crate::factory_mag::MagFetchOutcome::AlreadyValid => {
            json!({ "ok": true, "source": "existing" })
        }
        crate::factory_mag::MagFetchOutcome::NoMagazine => {
            json!({ "ok": false, "source": "none", "attempts": 0 })
        }
        crate::factory_mag::MagFetchOutcome::Fetched { attempts } => {
            json!({ "ok": true, "source": "mag", "attempts": attempts })
        }
        crate::factory_mag::MagFetchOutcome::ExhaustedRetries { attempts } => {
            json!({ "ok": false, "source": "mag", "attempts": attempts })
        }
    }
}

fn maybe_fetch_mag(state: &AppState) {
    if state.connect.has_valid_device_code() {
        return;
    }
    let _ = state.connect.ensure_device_code_from_mag();
}

fn enrich_setup(
    setup: &mut SetupState,
    state: &AppState,
    addr: &std::net::SocketAddr,
    headers: &HeaderMap,
) {
    setup.connect_active = state.connect.is_connect_active();
    setup.setup_origin = crate::setup_access::setup_origin(addr, headers).into();
}

async fn get_setup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    crate::setup_access::check(&state, &addr, &headers)?;
    maybe_fetch_mag(&state);
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
    let mut setup = crate::db::get_meta(&conn, SETUP_KEY)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?
        .and_then(|raw| serde_json::from_str::<SetupState>(&raw).ok())
        .unwrap_or_default();
    enrich_setup(&mut setup, &state, &addr, &headers);
    Ok(Json(setup))
}

async fn save_setup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<SaveBody>,
) -> Result<Json<SetupState>, (StatusCode, Json<Value>)> {
    crate::setup_access::check(&state, &addr, &headers)?;
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
    enrich_setup(&mut setup, &state, &addr, &headers);
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
        let mut state = SetupState {
            current_step: "account".into(),
            ..Default::default()
        };
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
