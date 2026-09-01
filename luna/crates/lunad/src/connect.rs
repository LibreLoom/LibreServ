//! Luna Connect client — permanent device code, status pull, then cloudflared.

use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreloom.org";

/// Permanent Luna Connect device token (`{data_dir}/device-token`).
/// Connect is inactive until this file holds a valid token.
pub const DEVICE_TOKEN_FILE: &str = "device-token";
const LEGACY_DEVICE_TOKEN_FILE: &str = "setup-token";

/// TODO: We need to add remote access options for non-connect users.

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
    /// True when `{data_dir}/device-token` exists and holds a valid device token.
    pub connect_active: bool,
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

pub struct ConnectService {
    data_dir: PathBuf,
    state_path: PathBuf,
    token_path: PathBuf,
    legacy_token_path: PathBuf,
    base_url: String,
    device_key: [u8; 32],
    child: Arc<Mutex<Option<Child>>>,
    local_port: u16,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        let device_key = crate::secrets::ensure_device_key(data_dir).unwrap_or([0u8; 32]);
        // Legacy opt-out marker — Connect is off by default now; drop the file if present.
        let _ = std::fs::remove_file(data_dir.join("disable-connect"));
        Self {
            data_dir: data_dir.to_path_buf(),
            state_path: data_dir.join("connect.json"),
            token_path: data_dir.join(DEVICE_TOKEN_FILE),
            legacy_token_path: data_dir.join(LEGACY_DEVICE_TOKEN_FILE),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
            device_key,
            child: Arc::new(Mutex::new(None)),
            local_port: 8090,
        }
    }

    pub fn with_local_port(mut self, port: u16) -> Self {
        if port > 0 {
            self.local_port = port;
        }
        self
    }

    pub fn status(&self) -> ConnectStatus {
        self.status_for(true)
    }

    /// Pairing codes and backup folder lists are admin-only after setup.
    pub fn status_for(&self, reveal_secrets: bool) -> ConnectStatus {
        let mut status = self.status_inner();
        if !reveal_secrets {
            status.setup_code = None;
            status.backup_sources = Vec::new();
        }
        status
    }

    /// True when `{data_dir}/device-token` exists and holds a valid device token.
    pub fn has_valid_device_code(&self) -> bool {
        self.setup_prefix().is_some()
    }

    /// Alias for API clarity.
    pub fn is_connect_active(&self) -> bool {
        self.has_valid_device_code()
    }

    /// During setup: peel from LUNAASSETS when the on-disk token is missing or invalid.
    pub fn ensure_device_code_from_mag(&self) -> crate::factory_mag::MagFetchOutcome {
        crate::factory_mag::fetch_device_token_from_mag(
            &self.token_path,
            &crate::factory_mag::MagFetchOptions::default(),
        )
    }

    fn inactive_status(&self) -> ConnectStatus {
        ConnectStatus {
            connect_active: false,
            enabled: false,
            base_url: self.base_url.clone(),
            domain: None,
            hostname: None,
            subdomain: None,
            tunnel_active: false,
            backup_unlocked: false,
            paired: false,
            unclaimed: true,
            setup_code: None,
            backup_sources: Vec::new(),
        }
    }

    fn status_inner(&self) -> ConnectStatus {
        if !self.has_valid_device_code() {
            return self.inactive_status();
        }
        let state = self.load();
        let enabled = state
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .is_some_and(|k| !k.is_empty())
            || state
                .get("hostname")
                .and_then(|v| v.as_str())
                .is_some_and(|h| !h.is_empty());
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
            connect_active: true,
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
        self.read_device_token()
    }

    fn connect_inactive_err() -> ConnectError {
        ConnectError::Other(
            "Luna Connect is not set up on this Luna. Add a device token in Settings → About → Advanced.".into(),
        )
    }

    pub fn set_oss_code(&self, code: &str) -> Result<(), ConnectError> {
        let norm = normalize_setup_code(code);
        if !is_device_token_format(&norm) {
            return Err(ConnectError::Other(
                "That code should look like ****-****-****-****-**** from connect.luna.libreloom.org or the card that came with Luna.".into(),
            ));
        }
        let grouped = group_device_token(&norm);
        std::fs::write(&self.token_path, format!("{grouped}\n")).map_err(|_| {
            ConnectError::Other("Could not save the device token on this Luna. Try again.".into())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.token_path, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::remove_file(&self.legacy_token_path);
        Ok(())
    }

    pub fn apply_claimed(&self, claimed: &Value) -> Result<(), ConnectError> {
        if !self.has_valid_device_code() {
            return Err(Self::connect_inactive_err());
        }
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
        self.save(&state)?;
        if let Ok(token) = self.token() {
            let _ = self.call_json("POST", "/api/v1/first-user", Some(&token), None);
        }
        Ok(())
    }

    pub fn public_hostname(&self) -> Option<String> {
        self.load()
            .get("hostname")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    fn read_device_token(&self) -> Option<String> {
        if let Some(raw) = read_trimmed_token_file(&self.token_path) {
            let norm = normalize_setup_code(&raw);
            if is_device_token_format(&norm) {
                return Some(raw);
            }
        }
        if let Some(raw) = read_trimmed_token_file(&self.legacy_token_path) {
            let norm = normalize_setup_code(&raw);
            if is_device_token_format(&norm) {
                let grouped = group_device_token(&norm);
                let _ = std::fs::write(&self.token_path, format!("{grouped}\n"));
                let _ = std::fs::remove_file(&self.legacy_token_path);
                return Some(grouped);
            }
        }
        None
    }

    /// Pull Connect status with the permanent device token. Call on boot and every 5 minutes.
    /// Returns true when bound (200). On 403 unbound, clears local claim state but keeps the token file.
    pub fn poll_status(&self) -> bool {
        if !self.has_valid_device_code() {
            return false;
        }
        let Ok(code) = self.device_code() else {
            return false;
        };
        match self.call_json_status("GET", "/api/v1/status", Some(&code), None) {
            Ok(remote) => {
                let mut state = self.load();
                if let Some(h) = remote.get("hostname") {
                    state["hostname"] = h.clone();
                }
                if let Some(s) = remote.get("subdomain") {
                    state["subdomain"] = s.clone();
                }
                if let Some(t) = remote.get("tunnel_token") {
                    state["tunnel_token"] = t.clone();
                }
                if let Some(s) = remote.get("setup_secret") {
                    state["first_user_secret"] = s.clone();
                }
                state["backup_unlocked"] = json!(
                    remote
                        .get("backup_unlocked")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                );
                state["paired"] = json!(true);
                state["bound"] = json!(true);
                let _ = self.save(&state);
                let _ = self.ensure_tunnel();
                true
            }
            Err(ConnectError::Other(msg)) if msg.contains("403") || msg.contains("unbound") => {
                self.clear_claim_keep_code();
                false
            }
            Err(_) => false,
        }
    }

    fn clear_claim_keep_code(&self) {
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
    }

    pub fn set_domain(&self, subdomain: &str) -> Result<Value, ConnectError> {
        if !self.has_valid_device_code() {
            return Err(Self::connect_inactive_err());
        }
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

    /// Remove the device token and clear cloud bind state. Stops polling immediately.
    pub fn remove_device_token(&self) -> Result<(), ConnectError> {
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.legacy_token_path);
        Ok(())
    }

    pub fn deactivate(&self) -> Result<(), ConnectError> {
        if !self.has_valid_device_code() {
            return Err(Self::connect_inactive_err());
        }
        if let Ok(token) = self.token() {
            let _ = self.call_json("POST", "/api/v1/unregister", Some(&token), None);
        }
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
        // Keep device-token so factory reset / re-join works.
        Ok(())
    }

    pub fn set_backup_sources(&self, sources: Vec<Value>) -> Result<(), ConnectError> {
        if !self.has_valid_device_code() {
            return Err(Self::connect_inactive_err());
        }
        let mut state = self.load();
        state["backup_sources"] = json!(sources);
        self.save(&state)
    }

    pub fn refresh_remote(&self, state: &mut Value) -> Result<(), ConnectError> {
        let token = self.device_code()?;
        let remote = self.call_json("GET", "/api/v1/status", Some(&token), None)?;
        if let Some(h) = remote.get("hostname") {
            state["hostname"] = h.clone();
        }
        if let Some(s) = remote.get("subdomain") {
            state["subdomain"] = s.clone();
        }
        if let Some(t) = remote.get("tunnel_token") {
            state["tunnel_token"] = t.clone();
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
        if !self.has_valid_device_code() {
            return;
        }
        let _ = self.poll_status();
    }

    /// Permanent device token from disk (Bearer for Connect).
    pub fn device_code(&self) -> Result<String, ConnectError> {
        self.read_device_token()
            .ok_or_else(|| ConnectError::Other("This Luna has no device token yet.".into()))
    }

    /// Setup unlock prefix: first eight Crockford characters (XXXX-XXXX).
    /// None when the device-token file is missing or malformed (fail closed for remote setup).
    pub fn setup_prefix(&self) -> Option<String> {
        let code = self.read_device_token()?;
        let norm = normalize_setup_code(&code);
        if !is_device_token_format(&norm) || norm.len() < 8 {
            return None;
        }
        Some(group_device_token(&norm[..8]))
    }

    /// Constant-time-ish compare of a submitted unlock code against the on-disk prefix.
    pub fn matches_setup_prefix(&self, submitted: &str) -> bool {
        let Some(expected) = self.setup_prefix() else {
            return false;
        };
        let got = normalize_setup_code(submitted);
        let exp = normalize_setup_code(&expected);
        if got.len() != 8 || exp.len() != 8 {
            return false;
        }
        got.as_bytes()
            .iter()
            .zip(exp.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }

    pub fn token(&self) -> Result<String, ConnectError> {
        self.device_code()
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
        self.call_json_status(method, path, key, body)
    }

    /// Like call_json, but maps HTTP 403 to `ConnectError::Other("403 unbound")` so callers
    /// can clear local tunnel state after an unbind.
    fn call_json_status(
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
        let mut response = match result {
            Ok(r) => r,
            Err(ureq::Error::StatusCode(403)) => {
                return Err(ConnectError::Other("403 unbound".into()));
            }
            Err(e) => return Err(map_transport_error(e)),
        };
        response
            .body_mut()
            .read_json::<Value>()
            .map_err(|_| ConnectError::Other("Connect sent a reply Luna couldn't read.".into()))
    }

    fn load(&self) -> Value {
        let Some(bytes) = std::fs::read(&self.state_path).ok() else {
            return json!({ "base_url": self.base_url });
        };
        if crate::at_rest::is_encrypted_blob(&bytes)
            && let Ok(text) = std::str::from_utf8(&bytes)
            && let Ok(value) = crate::at_rest::decrypt_json(&self.device_key, text)
        {
            return value;
        }
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "base_url": self.base_url }))
    }

    pub(crate) fn save(&self, state: &Value) -> Result<(), ConnectError> {
        if let Some(parent) = self.state_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let enc = crate::at_rest::encrypt_json(&self.device_key, state)
            .map_err(|e| ConnectError::Other(e.to_string()))?;
        std::fs::write(&self.state_path, enc.as_bytes())
            .map_err(|e| ConnectError::Other(e.to_string()))?;
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

/// Crockford base32 without I, L, O, U (same alphabet as Luna Connect).
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn read_trimmed_token_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn normalize_setup_code(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if matches!(c, '-' | ' ' | '_') {
            continue;
        }
        let c = c.to_ascii_uppercase();
        let c = match c {
            'I' | 'L' => '1',
            'O' => '0',
            _ => c,
        };
        out.push(c);
    }
    out
}

pub(crate) fn is_device_token_format(norm: &str) -> bool {
    let len = norm.len();
    if !(16..=32).contains(&len) {
        return false;
    }
    norm.bytes().all(|b| CROCKFORD.contains(&b))
}

pub(crate) fn group_device_token(norm: &str) -> String {
    let mut parts = Vec::new();
    let bytes = norm.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let end = (i + 4).min(bytes.len());
        parts.push(std::str::from_utf8(&bytes[i..end]).unwrap_or(""));
        i = end;
    }
    parts.join("-")
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
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
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
        assert!(st.connect_active);
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
    fn connect_inactive_without_device_token() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        let st = service.status();
        assert!(!st.connect_active);
        assert!(!st.enabled);
        assert!(service.setup_prefix().is_none());
        assert!(!service.poll_status());
    }

    #[test]
    fn legacy_setup_token_migrates_to_device_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(LEGACY_DEVICE_TOKEN_FILE),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(service.has_valid_device_code());
        assert!(dir.path().join(DEVICE_TOKEN_FILE).is_file());
        assert!(!dir.path().join(LEGACY_DEVICE_TOKEN_FILE).exists());
    }

    #[test]
    fn device_code_persists_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("3097-v4yk-3hyx-2e3p-v4b3").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(DEVICE_TOKEN_FILE))
                .unwrap()
                .trim(),
            "3097-V4YK-3HYX-2E3P-V4B3"
        );
        assert!(service.status().connect_active);
        assert_eq!(
            service.status().setup_code.as_deref(),
            Some("3097-V4YK-3HYX-2E3P-V4B3")
        );
        assert!(
            service.status_for(false).setup_code.is_none(),
            "non-admin must never see a live pairing code"
        );
        assert!(
            service.set_oss_code("a1b2c3").is_err(),
            "short hex must be rejected"
        );
        assert_eq!(service.setup_prefix().as_deref(), Some("3097-V4YK"));
        assert!(service.matches_setup_prefix("3097-V4YK"));
        assert!(service.matches_setup_prefix("3097v4yk"));
        assert!(!service.matches_setup_prefix("3097-XXXX"));
    }

    #[test]
    fn missing_device_code_refuses_prefix_match() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(service.setup_prefix().is_none());
        assert!(!service.matches_setup_prefix("ABCD-EFGH"));
    }

    #[test]
    fn malformed_device_code_refuses_prefix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DEVICE_TOKEN_FILE), "not-a-code").unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(service.setup_prefix().is_none());
        assert!(!service.matches_setup_prefix("ABCD-EFGH"));
    }

    #[test]
    fn poll_skips_without_device_token() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(!service.poll_status());
    }

    #[test]
    fn deactivate_keeps_device_code_file() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        service
            .apply_claimed(&json!({
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock-token",
            }))
            .unwrap();
        service.deactivate().unwrap();
        assert!(
            !dir.path().join("connect.json").exists(),
            "claim state must clear"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(DEVICE_TOKEN_FILE))
                .unwrap()
                .trim(),
            "ABCD-EFGH-JKMN-PQRS-TVWX"
        );
    }

    #[test]
    fn hello_uses_configured_listen_port() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into())).with_local_port(80);
        assert_eq!(service.local_port, 80);
    }

    #[test]
    fn idle_requires_quiet_window() {
        assert!(!is_idle(100, 110));
        assert!(is_idle(100, 140));
    }
}
