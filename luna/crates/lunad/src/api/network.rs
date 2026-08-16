use axum::extract::State;
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
) -> Result<Json<crate::wifi::WifiStatus>, (StatusCode, Json<Value>)> {
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
) -> Result<Json<Vec<WifiNetwork>>, (StatusCode, Json<Value>)> {
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

async fn connect(
    State(state): State<AppState>,
    Json(body): Json<ConnectBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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
    let provider = state.wifi.clone();
    let ssid_out = ssid.clone();
    tokio::task::spawn_blocking(move || provider.connect(&ssid, &password))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't connect to Wi-Fi.",
            )
        })?
        .map_err(map_wifi_err)?;
    Ok(Json(json!({ "connected": true, "ssid": ssid_out })))
}

async fn forget(State(state): State<AppState>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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
