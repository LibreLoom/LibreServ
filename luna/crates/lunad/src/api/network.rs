use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::wifi::{WifiError, WifiNetwork};

#[derive(Deserialize)]
struct ConnectBody {
    ssid: String,
    password: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/network/status", get(status))
        .route("/api/v1/network/wifi", get(wifi_status))
        .route("/api/v1/network/wifi/scan", get(scan))
        .route("/api/v1/network/wifi/connect", post(connect))
        .route("/api/v1/network/wifi/forget", post(forget))
        .route("/api/v1/network/hotspot", get(hotspot_status))
        .route("/api/v1/network/hotspot/start", post(hotspot_start))
        .route("/api/v1/network/hotspot/stop", post(hotspot_stop))
}

async fn status() -> Json<crate::net::NetworkStatus> {
    let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    Json(crate::net::read_status(
        std::path::Path::new("/sys/class/net"),
        &proc_route,
    ))
}

async fn wifi_status(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<crate::wifi::WifiStatus>, (StatusCode, Json<Value>)> {
    if !network_setup_or_admin(&state, current.as_ref()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can see the Wi-Fi settings.",
        ));
    }
    let provider = state.wifi.clone();
    let status = tokio::task::spawn_blocking(move || provider.status())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check Wi-Fi.",
            )
        })?;
    Ok(Json(status.map_err(map_wifi_err)?))
}

async fn scan(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<Vec<WifiNetwork>>, (StatusCode, Json<Value>)> {
    if !network_setup_or_admin(&state, current.as_ref()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can scan for Wi-Fi networks.",
        ));
    }
    if let Some(hotspot) = state.hotspot.lock().unwrap().as_ref()
        && hotspot.status().running
    {
        return Ok(Json(hotspot.cached_scan()));
    }
    let provider = state.wifi.clone();
    let networks = tokio::task::spawn_blocking(move || provider.scan())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't look for Wi-Fi networks.",
            )
        })?;
    Ok(Json(networks.map_err(map_wifi_err)?))
}

/// Network endpoints are public only during first-run setup (no users yet);
/// once accounts exist they are admin-only.
fn network_setup_or_admin(
    state: &AppState,
    current: Option<&Extension<crate::auth::CurrentUser>>,
) -> bool {
    let has_users = state.auth.count_users().unwrap_or(1) > 0;
    if !has_users {
        return true;
    }
    current.map(|u| u.role == "admin").unwrap_or(false)
}

async fn connect(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<ConnectBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Changing which network Luna is on is an admin action. The one exception
    // is first-run setup: the guard lets these through while the user table is
    // empty so the wizard can join the home network before any account exists.
    if let Some(Extension(user)) = current
        && user.role != "admin"
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can change the Wi-Fi network.",
        ));
    }
    let ssid = body.ssid.trim().to_string();
    if ssid.is_empty() || ssid.len() > 64 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a Wi-Fi network first.",
        ));
    }
    let password = body.password.unwrap_or_default();
    if password.len() > 128 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That Wi-Fi password is too long to be right.",
        ));
    }
    let paused_hotspot = state.hotspot.lock().unwrap().take();
    if let Some(ref hotspot) = paused_hotspot {
        let _ = hotspot.stop();
    }
    let provider = state.wifi.clone();
    let ssid_out = ssid.clone();
    let connect_result = tokio::task::spawn_blocking(move || provider.connect(&ssid, &password))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't connect to Wi-Fi.",
            )
        })?;
    if let Err(err) = connect_result.map_err(map_wifi_err) {
        if let Some(hotspot) = paused_hotspot {
            let _ = hotspot.start();
            state.set_hotspot(hotspot);
        }
        return Err(err);
    }
    Ok(Json(json!({ "connected": true, "ssid": ssid_out })))
}

async fn forget(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Some(Extension(user)) = current
        && user.role != "admin"
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can change the Wi-Fi network.",
        ));
    }
    let provider = state.wifi.clone();
    tokio::task::spawn_blocking(move || provider.forget())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't forget this Wi-Fi network.",
            )
        })?
        .map_err(map_wifi_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn hotspot_status(State(state): State<AppState>) -> Json<crate::hotspot::HotspotStatus> {
    if let Some(hotspot) = state.hotspot.lock().unwrap().as_ref() {
        Json(hotspot.status())
    } else {
        Json(crate::hotspot::HotspotStatus {
            available: false,
            running: false,
            interface: None,
            ssid: String::new(),
        })
    }
}

async fn hotspot_start(
    State(_state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    Err(json_error(
        StatusCode::GONE,
        "Luna uses the included cable. There is no setup Wi-Fi network to start.",
    ))
}

async fn hotspot_stop(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    if let Some(hotspot) = state.hotspot.lock().unwrap().take() {
        hotspot
            .stop()
            .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(json!({ "ok": true })))
}

fn map_wifi_err(err: WifiError) -> (StatusCode, Json<Value>) {
    match err {
        WifiError::Unavailable => json_error(
            StatusCode::CONFLICT,
            "Wi-Fi isn't available on this device.",
        ),
        WifiError::Auth => json_error(
            StatusCode::UNAUTHORIZED,
            "That password didn't work. Check the sticker on your internet box and try again.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the Wi-Fi request. Try again.",
        ),
    }
}
