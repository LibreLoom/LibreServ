//! LibreServ Connect client — Luna's one-tap, free-forever remote access.
//!
//! Luna never opens ports or runs a tunnel daemon. When the user turns remote
//! access on, Luna activates a Connect key and asks Connect to provision the
//! `tunnel` service; the edge serves HTTPS at the assigned domain. All state
//! (including the bearer key) lives in a root-only 0600 file.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

const DEFAULT_CONNECT_URL: &str = "https://connect.libreloom.org";

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("Connect couldn't be reached. Check your internet connection and try again.")]
    Unreachable,
    #[error("That Connect key didn't work. Check it and try again.")]
    BadKey,
    #[error("Connect is already in use. Turn it off and try again.")]
    Conflict,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectStatus {
    pub enabled: bool,
    pub base_url: String,
    pub key_masked: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub domain: Option<String>,
    pub tunnel_active: bool,
}

pub struct ConnectService {
    state_path: PathBuf,
    base_url: String,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        Self {
            state_path: data_dir.join("connect.json"),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
        }
    }

    pub fn status(&self) -> ConnectStatus {
        let state = self.load();
        let enabled = state
            .get("connect_key")
            .and_then(|v| v.as_str())
            .is_some_and(|k| !k.is_empty());
        let key = state
            .get("connect_key")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let activation = state.get("activation");
        let tunnel = state.get("tunnel");
        ConnectStatus {
            enabled,
            base_url: self.base_url.clone(),
            key_masked: mask_key(key),
            device_id: activation
                .and_then(|a| a.get("device_id"))
                .and_then(|v| v.as_str())
                .map(String::from),
            device_name: activation
                .and_then(|a| a.get("device_name"))
                .and_then(|v| v.as_str())
                .map(String::from),
            domain: tunnel
                .and_then(|t| t.get("domain"))
                .or_else(|| activation.and_then(|a| a.get("domain")))
                .and_then(|v| v.as_str())
                .map(String::from),
            tunnel_active: tunnel
                .and_then(|t| t.get("active"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }
    }

    /// One-tap activation: ask Connect for a free Luna key (no account, no
    /// checkout), then activate and provision the tunnel in one step.
    pub fn activate_free(&self, device_name: &str) -> Result<Value, ConnectError> {
        let free: Value = self.call_json(
            "POST",
            "/api/v1/luna/free-key",
            None,
            Some(json!({ "device_name": device_name })),
        )?;
        let key = free
            .get("connect_key")
            .and_then(|v| v.as_str())
            .ok_or(ConnectError::Other(
                "Connect did not return a free key.".into(),
            ))?;
        self.activate(key, device_name)
    }

    pub fn activate(&self, key: &str, device_name: &str) -> Result<Value, ConnectError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(ConnectError::BadKey);
        }
        let activation = self.call_json(
            "POST",
            "/api/v1/activate",
            Some(key),
            Some(json!({ "connect_key": key, "device_name": device_name })),
        )?;
        let tunnel = self.call_json(
            "POST",
            "/api/v1/services/provision",
            Some(key),
            Some(json!({ "service": "tunnel" })),
        )?;

        let state = json!({
            "base_url": self.base_url,
            "connect_key": key,
            "device_name": device_name,
            "activation": activation,
            "tunnel": tunnel,
        });
        self.save(&state)?;

        let mut out = state.clone();
        if let Some(obj) = out.as_object_mut() {
            obj.remove("connect_key");
            obj.insert("key_masked".into(), json!(mask_key(key)));
        }
        Ok(out)
    }

    pub fn provision_tunnel(&self) -> Result<Value, ConnectError> {
        let mut state = self.load();
        let key = state
            .get("connect_key")
            .and_then(|v| v.as_str())
            .filter(|k| !k.is_empty())
            .ok_or(ConnectError::BadKey)?;
        let tunnel = self.call_json(
            "POST",
            "/api/v1/services/provision",
            Some(key),
            Some(json!({ "service": "tunnel" })),
        )?;
        state["tunnel"] = tunnel.clone();
        self.save(&state)?;
        Ok(tunnel)
    }

    pub fn deactivate(&self) -> Result<(), ConnectError> {
        let state = self.load();
        if let Some(key) = state.get("connect_key").and_then(|v| v.as_str()) {
            // Best-effort remote deactivation; local state is cleared either way.
            let _ = self.call_json("POST", "/api/v1/deactivate", Some(key), None);
        }
        let _ = std::fs::remove_file(&self.state_path);
        Ok(())
    }

    fn call_json(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, ConnectError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let result = match method {
            "GET" => ureq::get(&url).call(),
            "POST" => {
                let mut req = ureq::post(&url);
                if let Some(key) = key {
                    req = req.header("Authorization", format!("Bearer {key}"));
                }
                match body {
                    Some(body) => req.send_json(body),
                    None => req.send_empty(),
                }
            }
            _ => return Err(ConnectError::Other("unsupported method".into())),
        };
        let mut response = result.map_err(map_transport_error)?;
        response
            .body_mut()
            .read_json::<Value>()
            .map_err(|_| ConnectError::Other("Connect sent a reply Luna couldn't read.".into()))
    }

    fn load(&self) -> Value {
        std::fs::read(&self.state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| json!({ "base_url": self.base_url }))
    }

    fn save(&self, state: &Value) -> Result<(), ConnectError> {
        if let Some(parent) = self.state_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let bytes =
            serde_json::to_vec_pretty(state).map_err(|e| ConnectError::Other(e.to_string()))?;
        std::fs::write(&self.state_path, bytes).map_err(|e| ConnectError::Other(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.state_path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "••••••••".to_string();
    }
    format!("{}••••", &key[..4])
}

fn map_transport_error(err: ureq::Error) -> ConnectError {
    match err {
        ureq::Error::StatusCode(401) | ureq::Error::StatusCode(403) => ConnectError::BadKey,
        ureq::Error::StatusCode(409) => ConnectError::Conflict,
        _ => ConnectError::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;
    use axum::{Json, Router};

    async fn test_server() -> (u16, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(
                "/api/v1/luna/free-key",
                post(|Json(_): Json<Value>| async {
                    Json(json!({ "connect_key": "free-key-123" }))
                }),
            )
            .route(
                "/api/v1/activate",
                post(|Json(_): Json<Value>| async {
                    Json(json!({ "device_id": "dev-luna-1", "device_name": "Luna" }))
                }),
            )
            .route(
                "/api/v1/services/provision",
                post(|Json(_): Json<Value>| async {
                    Json(json!({ "active": true, "domain": "luna.free.servers.libreloom.org" }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (port, handle)
    }

    #[tokio::test]
    async fn activate_free_gets_key_then_provisions() {
        let (port, server) = test_server().await;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(format!("http://127.0.0.1:{port}")));
        let result = tokio::task::spawn_blocking(move || service.activate_free("Luna"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["tunnel"]["active"], true);
        assert!(result.get("key_masked").is_some());
        server.abort();
    }

    #[tokio::test]
    async fn activate_provisions_tunnel_and_hides_key() {
        let (port, server) = test_server().await;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(format!("http://127.0.0.1:{port}")));
        let result =
            tokio::task::spawn_blocking(move || service.activate("free-key-123", "Kitchen Luna"))
                .await
                .unwrap()
                .unwrap();
        assert!(result.get("tunnel").unwrap()["active"].as_bool().unwrap());
        assert!(result.get("key_masked").is_some());
        assert!(result.get("connect_key").is_none());

        let raw = std::fs::read_to_string(dir.path().join("connect.json")).unwrap();
        assert!(
            raw.contains("free-key-123"),
            "key must persist for device auth"
        );
        assert!(raw.contains("Kitchen Luna"));
        server.abort();
    }

    #[cfg(unix)]
    #[test]
    fn state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.save(&json!({ "connect_key": "secret" })).unwrap();
        let mode = std::fs::metadata(service.state_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
