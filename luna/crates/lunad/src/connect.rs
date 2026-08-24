//! Luna Connect client — setup websocket, then cloudflared after a name is picked.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreloom.org";
const OSS_TTL: Duration = Duration::from_secs(15 * 60);

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
    pub paired: bool,
    pub unclaimed: bool,
    pub setup_code: Option<String>,
    pub backup_sources: Vec<Value>,
}

struct Ephemeral {
    code: String,
    until: Instant,
}

pub struct ConnectService {
    state_path: PathBuf,
    token_path: PathBuf,
    base_url: String,
    child: Arc<Mutex<Option<Child>>>,
    ephemeral: Mutex<Option<Ephemeral>>,
    redeem: Mutex<bool>,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        Self {
            state_path: data_dir.join("connect.json"),
            token_path: data_dir.join("setup-token"),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
            child: Arc::new(Mutex::new(None)),
            ephemeral: Mutex::new(None),
            redeem: Mutex::new(false),
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
            paired: enabled,
            unclaimed: !enabled,
            setup_code: self.display_setup_code(enabled),
            backup_sources: state
                .get("backup_sources")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default(),
        }
    }

    fn display_setup_code(&self, claimed: bool) -> Option<String> {
        if claimed {
            return None;
        }
        self.read_factory_token().or_else(|| {
            self.ephemeral
                .lock()
                .unwrap()
                .as_ref()
                .map(|e| e.code.clone())
        })
    }

    pub fn set_oss_code(&self, code: &str) -> Result<(), ConnectError> {
        let code = code.trim().to_uppercase();
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(ConnectError::Other(
                "That code should be six letters and numbers from the Luna Connect site.".into(),
            ));
        }
        *self.ephemeral.lock().unwrap() = Some(Ephemeral {
            code,
            until: Instant::now() + OSS_TTL,
        });
        Ok(())
    }

    pub fn redeem_booklet(&self) -> Result<(), ConnectError> {
        if self.read_factory_token().is_none() {
            return Err(ConnectError::Other(
                "This Luna has no booklet code on disk. Paste the code from the Luna Connect site instead.".into(),
            ));
        }
        *self.redeem.lock().unwrap() = true;
        Ok(())
    }

    pub fn apply_claimed(&self, claimed: &Value) -> Result<(), ConnectError> {
        let mut state = self.load();
        if let Some(t) = claimed.get("device_token") {
            state["device_token"] = t.clone();
        }
        if let Some(h) = claimed.get("hostname") {
            state["hostname"] = h.clone();
        }
        if let Some(s) = claimed.get("subdomain") {
            state["subdomain"] = s.clone();
        }
        if let Some(t) = claimed.get("tunnel_token") {
            state["tunnel_token"] = t.clone();
        }
        if let Some(s) = claimed.get("setup_secret") {
            state["first_user_secret"] = s.clone();
        }
        self.save(&state)?;
        *self.ephemeral.lock().unwrap() = None;
        *self.redeem.lock().unwrap() = false;
        let _ = self.ensure_tunnel();
        Ok(())
    }

    pub fn first_user_secret(&self) -> Option<String> {
        self.load()
            .get("first_user_secret")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// One-time: drop the public-hostname first-user code after it is used.
    pub fn clear_first_user_secret(&self) -> Result<(), ConnectError> {
        let mut state = self.load();
        let Some(obj) = state.as_object_mut() else {
            return Ok(());
        };
        if obj.remove("first_user_secret").is_none() {
            return Ok(());
        }
        self.save(&state)
    }

    pub fn public_hostname(&self) -> Option<String> {
        self.load()
            .get("hostname")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    fn read_factory_token(&self) -> Option<String> {
        std::fs::read_to_string(&self.token_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn setup_hello_token(&self, setup_completed: bool) -> Option<(String, &'static str)> {
        if self.status().enabled {
            return None;
        }
        if let Some(e) = self.ephemeral.lock().unwrap().as_ref()
            && Instant::now() < e.until
        {
            return Some((e.code.clone(), "anonymous"));
        }
        let factory = self.read_factory_token()?;
        if *self.redeem.lock().unwrap() {
            return Some((factory, "settings"));
        }
        if setup_completed {
            // Official disk that finished local setup: no anonymous hello.
            return None;
        }
        Some((factory, "anonymous"))
    }

    pub fn hello_once(&self, setup_completed: bool) {
        let Some((token, source)) = self.setup_hello_token(setup_completed) else {
            return;
        };
        let ws = http_to_ws(&self.base_url) + "/api/v1/setup/ws";
        let Ok((mut socket, _)) = tungstenite::connect(&ws) else {
            return;
        };
        let hello = json!({
            "type": "hello",
            "token": token,
            "local_port": 8090,
            "source": source,
        });
        if socket
            .send(tungstenite::Message::Text(hello.to_string().into()))
            .is_err()
        {
            return;
        }
        while let Ok(msg) = socket.read() {
            let tungstenite::Message::Text(text) = msg else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("error") => break,
                Some("claimed") => {
                    let _ = self.apply_claimed(&v);
                    break;
                }
                _ => {}
            }
        }
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
                    "Luna couldn't start the protected connection. Try again in a few minutes."
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

fn http_to_ws(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{}", rest.trim_end_matches('/'))
    } else {
        base.trim_end_matches('/').to_string()
    }
}

fn map_transport_error(err: ureq::Error) -> ConnectError {
    match err {
        ureq::Error::StatusCode(409) => ConnectError::Conflict,
        _ => ConnectError::Unreachable,
    }
}

pub fn is_idle(last_io_unix: i64, now_unix: i64) -> bool {
    now_unix.saturating_sub(last_io_unix) >= 30
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_claimed_persists_secret_and_starts_mock_tunnel() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service
            .apply_claimed(&json!({
                "device_token": "tok-1",
                "hostname": "photos.luna.servers.libreloom.org",
                "subdomain": "photos",
                "tunnel_token": "mock-token",
                "setup_secret": "secret-abc"
            }))
            .unwrap();
        let st = service.status();
        assert_eq!(
            st.hostname.as_deref(),
            Some("photos.luna.servers.libreloom.org")
        );
        assert_eq!(service.first_user_secret().as_deref(), Some("secret-abc"));
        assert!(st.enabled);
        assert!(!st.unclaimed);
        service.clear_first_user_secret().unwrap();
        assert!(service.first_user_secret().is_none());
    }

    #[test]
    fn oss_code_is_memory_only() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("a1b2c3").unwrap();
        assert!(!dir.path().join("setup-token").exists());
        assert_eq!(service.status().setup_code.as_deref(), Some("A1B2C3"));
    }

    #[test]
    fn local_complete_stops_anonymous_factory_hello() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("setup-token"), "ABCD-EFGH-IJKM-NPQR-STUV").unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(service.setup_hello_token(false).is_some());
        assert!(service.setup_hello_token(true).is_none());
        service.redeem_booklet().unwrap();
        let (code, source) = service.setup_hello_token(true).unwrap();
        assert_eq!(source, "settings");
        assert!(code.contains("ABCD"));
    }

    #[test]
    fn idle_requires_quiet_window() {
        assert!(!is_idle(100, 110));
        assert!(is_idle(100, 140));
    }
}
