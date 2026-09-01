//! Luna Connect client — permanent device code, status pull, then cloudflared.

use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreloom.org";

/// Marker file in the Luna data dir (`/var/lib/luna/disable-connect` on device).
/// Created by an admin on the filesystem — not settable from the web UI.
/// When present, Luna Connect is fully disabled and setup skips device-code gates.
///
/// TODO: We need to add remote access options for non-connect users.
pub const DISABLE_CONNECT_FILE: &str = "disable-connect";

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
    /// True when `{data_dir}/disable-connect` exists on disk.
    pub connect_disabled: bool,
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
    state_path: PathBuf,
    token_path: PathBuf,
    disable_connect_path: PathBuf,
    base_url: String,
    device_key: [u8; 32],
    child: Arc<Mutex<Option<Child>>>,
    redeem: Mutex<bool>,
    local_port: u16,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        let device_key = crate::secrets::ensure_device_key(data_dir).unwrap_or([0u8; 32]);
        Self {
            state_path: data_dir.join("connect.json"),
            token_path: data_dir.join("setup-token"),
            disable_connect_path: data_dir.join(DISABLE_CONNECT_FILE),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
            device_key,
            child: Arc::new(Mutex::new(None)),
            redeem: Mutex::new(false),
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

    /// True when an admin placed `{data_dir}/disable-connect` on the device.
    pub fn is_connect_disabled(&self) -> bool {
        self.disable_connect_path.is_file()
    }

    /// True when `{data_dir}/setup-token` exists and holds a valid booklet code.
    pub fn has_valid_device_code(&self) -> bool {
        self.setup_prefix().is_some()
    }

    /// During setup: peel from LUNAASSETS when the on-disk code is missing or invalid.
    pub fn ensure_device_code_from_mag(&self) -> crate::factory_mag::MagFetchOutcome {
        crate::factory_mag::fetch_setup_token_from_mag(
            &self.token_path,
            &self.disable_connect_path,
            &crate::factory_mag::MagFetchOptions::default(),
        )
    }

    /// Create `{data_dir}/disable-connect` to opt out of Luna Connect (setup only).
    pub fn create_disable_connect_file(&self) -> Result<(), ConnectError> {
        if self.disable_connect_path.is_file() {
            return Ok(());
        }
        std::fs::write(&self.disable_connect_path, b"").map_err(|_| {
            ConnectError::Other(
                "Luna couldn't save your choice to skip Luna Connect. Try again.".into(),
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &self.disable_connect_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
        Ok(())
    }

    fn disabled_status(&self) -> ConnectStatus {
        ConnectStatus {
            connect_disabled: true,
            enabled: false,
            base_url: self.base_url.clone(),
            domain: None,
            hostname: None,
            subdomain: None,
            tunnel_active: false,
            backup_unlocked: false,
            paired: false,
            unclaimed: false,
            setup_code: None,
            backup_sources: Vec::new(),
        }
    }

    fn status_inner(&self) -> ConnectStatus {
        if self.is_connect_disabled() {
            return self.disabled_status();
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
            connect_disabled: false,
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
        self.read_factory_token()
    }

    fn connect_disabled_err() -> ConnectError {
        ConnectError::Other("Luna Connect is turned off on this Luna.".into())
    }

    pub fn set_oss_code(&self, code: &str) -> Result<(), ConnectError> {
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
        }
        let norm = normalize_setup_code(code);
        if !is_booklet_code(&norm) {
            return Err(ConnectError::Other(
                "That code should look like ****-****-****-****-**** from the Luna Connect site (or the printed booklet).".into(),
            ));
        }
        let grouped = group_booklet(&norm);
        std::fs::write(&self.token_path, format!("{grouped}\n")).map_err(|_| {
            ConnectError::Other("Could not save the device code on this Luna. Try again.".into())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.token_path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn redeem_booklet(&self) -> Result<(), ConnectError> {
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
        }
        if self.read_factory_token().is_none() {
            return Err(ConnectError::Other(
                "This Luna has no code preconfigured. If you bought it from LibreLoom, contact support. Otherwise, follow the process at https://connect.luna.libreloom.org/onboarding to get a code, then add it in Settings → About → Advanced.".into(),
            ));
        }
        *self.redeem.lock().unwrap() = true;
        Ok(())
    }

    pub fn apply_claimed(&self, claimed: &Value) -> Result<(), ConnectError> {
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
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

    fn read_factory_token(&self) -> Option<String> {
        std::fs::read_to_string(&self.token_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Pull Connect status with the permanent device code. Call on boot and every 5 minutes.
    /// Returns true when bound (200). On 403 unbound, clears local claim state but keeps the code file.
    pub fn poll_status(&self) -> bool {
        if self.is_connect_disabled() {
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
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
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

    pub fn deactivate(&self) -> Result<(), ConnectError> {
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
        }
        if let Ok(token) = self.token() {
            let _ = self.call_json("POST", "/api/v1/unregister", Some(&token), None);
        }
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
        // Keep setup-token (permanent device code) so factory reset / re-join works.
        Ok(())
    }

    pub fn set_backup_sources(&self, sources: Vec<Value>) -> Result<(), ConnectError> {
        if self.is_connect_disabled() {
            return Err(Self::connect_disabled_err());
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
        if self.is_connect_disabled() {
            return;
        }
        let _ = self.poll_status();
    }

    /// Permanent device code from disk (Bearer for Connect).
    pub fn device_code(&self) -> Result<String, ConnectError> {
        self.read_factory_token()
            .ok_or_else(|| ConnectError::Other("This Luna has no device code yet.".into()))
    }

    /// Setup unlock prefix: first eight Crockford characters (XXXX-XXXX).
    /// None when the device-code file is missing or malformed (fail closed for remote setup).
    pub fn setup_prefix(&self) -> Option<String> {
        let code = self.read_factory_token()?;
        let norm = normalize_setup_code(&code);
        if !is_booklet_code(&norm) || norm.len() < 8 {
            return None;
        }
        Some(group_booklet(&norm[..8]))
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

pub(crate) fn is_booklet_code(norm: &str) -> bool {
    let len = norm.len();
    if !(16..=32).contains(&len) {
        return false;
    }
    norm.bytes().all(|b| CROCKFORD.contains(&b))
}

pub(crate) fn group_booklet(norm: &str) -> String {
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
    fn create_disable_connect_file_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.create_disable_connect_file().unwrap();
        service.create_disable_connect_file().unwrap();
        assert!(dir.path().join(DISABLE_CONNECT_FILE).is_file());
        assert!(service.is_connect_disabled());
    }

    #[test]
    fn disable_connect_file_turns_off_connect() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DISABLE_CONNECT_FILE), b"").unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap_err();
        let st = service.status();
        assert!(st.connect_disabled);
        assert!(!st.enabled);
        assert!(service.setup_prefix().is_none());
        assert!(!service.poll_status());
    }

    #[test]
    fn device_code_persists_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("3097-v4yk-3hyx-2e3p-v4b3").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("setup-token"))
                .unwrap()
                .trim(),
            "3097-V4YK-3HYX-2E3P-V4B3"
        );
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
        std::fs::write(dir.path().join("setup-token"), "not-a-code").unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        assert!(service.setup_prefix().is_none());
        assert!(!service.matches_setup_prefix("ABCD-EFGH"));
    }

    #[test]
    fn redeem_without_factory_token_explains_next_step() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        let err = service.redeem_booklet().unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("This Luna has no code preconfigured"), "{msg}");
        assert!(
            msg.contains("https://connect.luna.libreloom.org/onboarding"),
            "{msg}"
        );
        assert!(msg.contains("Settings → About → Advanced"), "{msg}");
        assert!(!msg.to_lowercase().contains("booklet"), "{msg}");
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
            std::fs::read_to_string(dir.path().join("setup-token"))
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
