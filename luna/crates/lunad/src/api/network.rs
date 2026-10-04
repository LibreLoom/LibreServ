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
    State(_state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Json<Value> {
    let full = crate::net::read_status(
        std::path::Path::new("/sys/class/net"),
        &std::fs::read_to_string("/proc/net/route").unwrap_or_default(),
    );
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    if admin {
        return Json(serde_json::to_value(&full).unwrap_or(json!({})));
    }
    // Everyone else — members, and the anonymous callers the setup window
    // lets in — only needs "are we online?", not interface names or IPs.
    Json(json!({
        "ethernet_connected": full.ethernet_connected,
        "wifi_connected": false,
        "has_default_route": full.has_default_route,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::AppState;
    use crate::auth::CurrentUser;

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = AppState::new(conn, drive_manager, dir.path());
        (dir, state)
    }

    async fn get_status(state: &AppState, user: Option<CurrentUser>) -> Value {
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let mut http = axum::http::Request::builder()
            .uri("/api/v1/network/status")
            .body(axum::body::Body::empty())
            .unwrap();
        if let Some(u) = user {
            // Same shape the guard attaches: a bare CurrentUser extension.
            http.extensions_mut().insert(u);
        }
        let res = router.oneshot(http).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn only_admins_see_interface_names_and_ips() {
        let (_dir, state) = state();
        // Anonymous (the setup window lets them in) and members get the same
        // "are we online?" shape — never names or addresses.
        for body in [
            get_status(&state, None).await,
            get_status(
                &state,
                Some(CurrentUser {
                    id: "m".into(),
                    username: "sam".into(),
                    role: "user".into(),
                }),
            )
            .await,
        ] {
            assert!(body.get("interfaces").is_none(), "{body}");
            assert!(body.get("ipv4").is_none(), "{body}");
            assert!(body.get("has_default_route").is_some(), "{body}");
        }
        let admin = get_status(
            &state,
            Some(CurrentUser {
                id: "a".into(),
                username: "max".into(),
                role: "admin".into(),
            }),
        )
        .await;
        assert!(admin.get("interfaces").is_some());
        assert!(admin.get("ipv4").is_some());
    }
}
