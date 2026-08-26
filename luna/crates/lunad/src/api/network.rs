//! Network status for Ethernet-only Luna.
//!
//! Wi-Fi uplink and setup-AP routes were removed. Luna ships with a patch
//! cable; there is no wpa_cli path and no setup hotspot.

use axum::extract::{Extension, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/network/status", get(status))
}

async fn status(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Json<Value> {
    let full = crate::net::read_status(
        std::path::Path::new("/sys/class/net"),
        &std::fs::read_to_string("/proc/net/route").unwrap_or_default(),
    );
    let wizard_open =
        state.auth.count_users().unwrap_or(1) == 0 || crate::auth::setup_wizard_open(&state);
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    if wizard_open || admin {
        return Json(serde_json::to_value(&full).unwrap_or(json!({})));
    }
    // Members only need "are we online?", not interface names or IPs.
    Json(json!({
        "ethernet_connected": full.ethernet_connected,
        "wifi_connected": false,
        "has_default_route": full.has_default_route,
    }))
}
