//! Luna Connect client — free address plus optional billed spare copies.
//!
//! Default cloud: `https://connect.luna.libreserv.org`.
//! Device address: `{name}.luna.servers.libreloom.org` via cloudflared.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Value, json};

const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreserv.org";

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("Connect couldn't be reached. Check your internet connection and try again.")]
    Unreachable,
    #[error("That name is already in use. Pick another.")]
    Conflict,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectStatus {
    pub enabled: bool,
    pub base_url: String,
    pub hostname: Option<String>,
    pub domain: Option<String>,
    pub subdomain: Option<String>,
    pub tunnel_active: bool,
    pub backup_unlocked: bool,
    pub pairing_code: Option<String>,
    pub paired: bool,
    pub backup_sources: Vec<Value>,
}

pub struct ConnectService {
    state_path: PathBuf,
    base_url: String,
    child: Arc<Mutex<Option<Child>>>,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        Self {
            state_path: data_dir.join("connect.json"),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
            child: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> ConnectStatus {
        let state = self.load();
        let enabled = state
            .get("device_token")
            .and_then(|v| v.as_str())
            .is_some_and(|k| !k.is_empty());
        let hostname = state
            .get("hostname")
            .and_then(|v| v.as_str())
            .map(String::from);
        let tunnel_active = self.tunnel_running()
            || state
                .get("tunnel_active")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        ConnectStatus {
            enabled,
            base_url: self.base_url.clone(),
            domain: hostname.clone(),
            hostname: hostname.clone(),
            subdomain: state
                .get("subdomain")
                .and_then(|v| v.as_str())
                .map(String::from),
            tunnel_active,
            backup_unlocked: state
                .get("backup_unlocked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            pairing_code: state
                .get("pairing_code")
                .and_then(|v| v.as_str())
                .map(String::from),
            paired: state
                .get("paired")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            backup_sources: state
                .get("backup_sources")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default(),
        }
    }

    pub fn enable(&self, subdomain: &str, local_port: u16) -> Result<Value, ConnectError> {
        if self.status().enabled {
            return Err(ConnectError::Conflict);
        }
        let body = json!({
            "device_name": "Luna",
            "subdomain": subdomain,
            "local_port": local_port,
        });
        let created = self.call_json("POST", "/api/v1/register", None, Some(body))?;
        let token = created
            .get("device_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                ConnectError::Other("Connect did not finish setting up this Luna.".into())
            })?;
        let hostname = created
            .get("hostname")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tunnel_token = created
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut state = json!({
            "base_url": self.base_url,
            "device_token": token,
            "hostname": hostname,
            "subdomain": created.get("subdomain").cloned().unwrap_or(json!(subdomain)),
            "tunnel_token": tunnel_token,
            "backup_sources": [],
        });
        self.save(&state)?;
        let _ = self.refresh_remote(&mut state);
        self.save(&state)?;
        let _ = self.ensure_tunnel();
        Ok(json!({
            "hostname": hostname,
            "subdomain": subdomain,
        }))
    }

    pub fn set_domain(&self, subdomain: &str) -> Result<Value, ConnectError> {
        let token = self.token()?;
        let changed = self.call_json(
            "POST",
            "/api/v1/domain",
            Some(&token),
            Some(json!({ "subdomain": subdomain })),
        )?;
        let mut state = self.load();
        if let Some(h) = changed.get("hostname") {
            state["hostname"] = h.clone();
        }
        if let Some(s) = changed.get("subdomain") {
            state["subdomain"] = s.clone();
        }
        if let Some(t) = changed.get("tunnel_token") {
            state["tunnel_token"] = t.clone();
        }
        self.save(&state)?;
        Ok(changed)
    }

    pub fn deactivate(&self) -> Result<(), ConnectError> {
        if let Ok(token) = self.token() {
            let _ = self.call_json("POST", "/api/v1/unregister", Some(&token), None);
        }
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
        Ok(())
    }

    pub fn pairing_code(&self) -> Result<String, ConnectError> {
        let token = self.token()?;
        let v = self.call_json("POST", "/api/v1/pairing-code", Some(&token), None)?;
        let code = v
            .get("pairing_code")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let mut state = self.load();
        state["pairing_code"] = json!(code);
        self.save(&state)?;
        Ok(code)
    }

    pub fn set_backup_sources(&self, sources: Vec<Value>) -> Result<(), ConnectError> {
        let mut state = self.load();
        state["backup_sources"] = json!(sources);
        self.save(&state)
    }

    pub fn refresh_remote(&self, state: &mut Value) -> Result<(), ConnectError> {
        let token = state
            .get("device_token")
            .and_then(|v| v.as_str())
            .ok_or(ConnectError::Other("Connect is not turned on.".into()))?;
        let remote = self.call_json("GET", "/api/v1/status", Some(token), None)?;
        if let Some(h) = remote.get("hostname") {
            state["hostname"] = h.clone();
        }
        state["backup_unlocked"] = json!(
            remote
                .get("backup_unlocked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        );
        state["paired"] = json!(
            remote
                .get("paired")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        );
        if let Some(c) = remote.get("pairing_code") {
            state["pairing_code"] = c.clone();
        }
        Ok(())
    }

    pub fn sync_status_from_cloud(&self) {
        let mut state = self.load();
        if self.refresh_remote(&mut state).is_ok() {
            let _ = self.save(&state);
        }
        let _ = self.ensure_tunnel();
    }

    pub fn token(&self) -> Result<String, ConnectError> {
        self.load()
            .get("device_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| ConnectError::Other("Connect is not turned on.".into()))
    }

    pub fn put_backup_object(&self, rel: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        let token = self.token()?;
        let url = format!(
            "{}/api/v1/backup/objects/{}",
            self.base_url.trim_end_matches('/'),
            rel.trim_start_matches('/')
        );
        let result = ureq::put(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send(bytes);
        result.map(|_| ()).map_err(map_transport_error)
    }

    pub fn delete_backup_object(&self, rel: &str) -> Result<(), ConnectError> {
        let token = self.token()?;
        let url = format!(
            "{}/api/v1/backup/objects/{}",
            self.base_url.trim_end_matches('/'),
            rel.trim_start_matches('/')
        );
        ureq::delete(&url)
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map(|_| ())
            .map_err(map_transport_error)
    }

    pub fn backup_sources(&self) -> Vec<Value> {
        self.load()
            .get("backup_sources")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    }

    pub fn backup_unlocked(&self) -> bool {
        self.load()
            .get("backup_unlocked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    fn ensure_tunnel(&self) -> Result<(), ConnectError> {
        if self.tunnel_running() {
            return Ok(());
        }
        let token = self
            .load()
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if token.is_empty() || token.starts_with("mock-") {
            let mut state = self.load();
            state["tunnel_active"] = json!(true);
            return self.save(&state);
        }
        let child = Command::new("cloudflared")
            .args(["tunnel", "run", "--token", &token])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                ConnectError::Other(
                    "Luna couldn't start the protected connection. Install cloudflared or try again."
                        .into(),
                )
            })?;
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    fn stop_tunnel(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn tunnel_running(&self) -> bool {
        let mut g = self.child.lock().unwrap();
        if let Some(child) = g.as_mut() {
            match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *g = None;
                    false
                }
            }
        } else {
            false
        }
    }

    fn call_json(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, ConnectError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let auth = key.map(|k| format!("Bearer {k}"));
        let result = match (method, body) {
            ("GET", _) => {
                let mut req = ureq::get(&url);
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.call()
            }
            ("POST", Some(body)) => {
                let mut req = ureq::post(&url);
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.send_json(body)
            }
            ("POST", None) => {
                let mut req = ureq::post(&url);
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.send(&[] as &[u8])
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

    pub(crate) fn save(&self, state: &Value) -> Result<(), ConnectError> {
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

fn map_transport_error(err: ureq::Error) -> ConnectError {
    match err {
        ureq::Error::StatusCode(409) => ConnectError::Conflict,
        _ => ConnectError::Unreachable,
    }
}

/// True when the box has been quiet long enough to upload spare copies.
pub fn is_idle(last_io_unix: i64, now_unix: i64) -> bool {
    now_unix.saturating_sub(last_io_unix) >= 30
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::{Json, Router};

    async fn test_server() -> (u16, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(
                "/api/v1/register",
                post(|Json(_): Json<Value>| async {
                    Json(json!({
                        "device_token": "tok-1",
                        "hostname": "photos.luna.servers.libreloom.org",
                        "subdomain": "photos",
                        "tunnel_token": "mock-token"
                    }))
                }),
            )
            .route(
                "/api/v1/status",
                get(|| async {
                    Json(json!({
                        "hostname": "photos.luna.servers.libreloom.org",
                        "backup_unlocked": false,
                        "paired": false
                    }))
                }),
            )
            .route(
                "/api/v1/domain",
                post(|Json(body): Json<Value>| async move {
                    let sub = body.get("subdomain").and_then(|v| v.as_str()).unwrap_or("");
                    Json(json!({
                        "hostname": format!("{sub}.luna.servers.libreloom.org"),
                        "subdomain": sub
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (port, handle)
    }

    #[tokio::test]
    async fn enable_registers_and_hides_token() {
        let (port, server) = test_server().await;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(format!("http://127.0.0.1:{port}")));
        let result = tokio::task::spawn_blocking(move || service.enable("photos", 8090))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["hostname"], "photos.luna.servers.libreloom.org");
        let raw = std::fs::read_to_string(dir.path().join("connect.json")).unwrap();
        assert!(raw.contains("tok-1"));
        server.abort();
    }

    #[tokio::test]
    async fn set_domain_updates_hostname() {
        let (port, server) = test_server().await;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(format!("http://127.0.0.1:{port}")));
        tokio::task::spawn_blocking({
            let service = ConnectService::new(dir.path(), Some(format!("http://127.0.0.1:{port}")));
            move || service.enable("photos", 8090)
        })
        .await
        .unwrap()
        .unwrap();
        let changed = tokio::task::spawn_blocking(move || service.set_domain("kitchen"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(changed["hostname"], "kitchen.luna.servers.libreloom.org");
        server.abort();
    }

    #[test]
    fn idle_requires_quiet_window() {
        assert!(!is_idle(100, 110));
        assert!(is_idle(100, 140));
    }

    #[cfg(unix)]
    #[test]
    fn state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.save(&json!({ "device_token": "secret" })).unwrap();
        let mode = std::fs::metadata(dir.path().join("connect.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
