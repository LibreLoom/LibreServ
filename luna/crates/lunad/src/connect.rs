//! Luna Connect client — permanent device code, status pull, then cloudflared.

use serde::Serialize;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreloom.org";

/// Steady-state Connect status pull (boot + every 5 minutes after setup).
pub const STEADY_POLL_SECS: u64 = 300;
/// Fast pull while setup is open and the tunnel is not running yet.
pub const AGGRESSIVE_POLL_SECS: u64 = 10;

/// Permanent Luna Connect device token (`{data_dir}/device-token`).
/// Connect is inactive until this file holds a valid token.
pub const DEVICE_TOKEN_FILE: &str = "device-token";

/// Connect rejected the on-disk token (HTTP 401 / revoked / unknown).
pub const DEVICE_TOKEN_REJECTED_MSG: &str = "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token.";
/// On-disk token file is present but not a valid Crockford device token.
pub const DEVICE_TOKEN_MALFORMED_MSG: &str = "This Luna's device token is not valid. It should look like ****-****-****-****-****. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token.";
/// Connect was unreachable on the last status pull (sticky while token is present).
pub const CONNECT_UNREACHABLE_MSG: &str = "Luna Connect could not be reached. Check this Luna's internet connection. Luna will keep trying.";
/// Connect replied with a Cloudflare (or similar) browser challenge instead of JSON.
pub const CONNECT_CHALLENGED_MSG: &str = "Luna Connect blocked this Luna's connection check with a network challenge (a check meant for web browsers, not devices). The secure tunnel may not start until that challenge is turned off for machine requests. Luna will keep trying.";

const LEGACY_DEVICE_TOKEN_FILE: &str = "setup-token";

/// TODO: We need to add remote access options for non-connect users.

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("Connect couldn't be reached. Check your internet connection and try again.")]
    Unreachable,
    /// HTML/gateway challenge (e.g. Cloudflare managed challenge) — not an authentic unbind.
    #[error("{msg}", msg = CONNECT_CHALLENGED_MSG)]
    GatewayChallenge,
    #[error("That name is already in use. Pick another.")]
    Conflict,
    #[error("{msg}", msg = DEVICE_TOKEN_REJECTED_MSG)]
    InvalidToken,
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
    /// Present when the on-disk token is malformed or Connect rejected it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_token_error: Option<String>,
    /// Sticky when Connect could not be reached while a device token is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_unreachable: Option<String>,
    pub backup_sources: Vec<Value>,
}

pub struct ConnectService {
    state_path: PathBuf,
    token_path: PathBuf,
    legacy_token_path: PathBuf,
    base_url: String,
    device_key: [u8; 32],
    child: Arc<Mutex<Option<Child>>>,
    active_tunnel_token: Arc<Mutex<Option<String>>>,
    /// Sticky until a later poll succeeds or the token is replaced/removed.
    rejected_token: Mutex<bool>,
    /// Sticky user-facing reachability/challenge message while a device token is present.
    connect_unreachable: Mutex<Option<&'static str>>,
    local_port: u16,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        let device_key = crate::secrets::ensure_device_key(data_dir).unwrap_or([0u8; 32]);
        // Legacy opt-out marker — Connect is off by default now; drop the file if present.
        let _ = std::fs::remove_file(data_dir.join("disable-connect"));
        Self {
            state_path: data_dir.join("connect.json"),
            token_path: data_dir.join(DEVICE_TOKEN_FILE),
            legacy_token_path: data_dir.join(LEGACY_DEVICE_TOKEN_FILE),
            base_url: base_url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| DEFAULT_CONNECT_URL.to_string()),
            device_key,
            child: Arc::new(Mutex::new(None)),
            active_tunnel_token: Arc::new(Mutex::new(None)),
            rejected_token: Mutex::new(false),
            connect_unreachable: Mutex::new(None),
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
        let token_error = self.device_token_error();
        let unreachable = self.connect_unreachable_message();
        if token_error.is_some() {
            status.enabled = false;
            status.paired = false;
            status.unclaimed = false;
            status.tunnel_active = false;
            status.hostname = None;
            status.domain = None;
            status.subdomain = None;
            status.setup_code = None;
        }
        status.device_token_error = token_error;
        status.connect_unreachable = unreachable;
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
            device_token_error: None,
            connect_unreachable: None,
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
            device_token_error: None,
            connect_unreachable: None,
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
        self.set_rejected_token(false);
        self.clear_connect_unreachable();
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

    /// True when Connect handed us a tunnel token and cloudflared is running (or mock tunnel).
    pub fn tunnel_ready(&self) -> bool {
        if !self.has_valid_device_code() {
            return false;
        }
        let state = self.load();
        let token = state
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if token.is_empty() {
            return false;
        }
        if token.starts_with("mock-") {
            return true;
        }
        self.tunnel_running()
    }

    /// Seconds until the next status pull. Aggressive while the tunnel connector is not
    /// healthy yet (setup wizard open, or Connect already assigned a hostname/token).
    /// Steady 5 minutes once cloudflared is running (or Connect is inactive).
    pub fn poll_interval_secs(&self, setup_wizard_open: bool) -> u64 {
        if self.tunnel_ready() {
            return STEADY_POLL_SECS;
        }
        if setup_wizard_open || self.expects_tunnel_connector() {
            AGGRESSIVE_POLL_SECS
        } else {
            STEADY_POLL_SECS
        }
    }

    /// True when Connect has bound this Luna and we should be running cloudflared.
    fn expects_tunnel_connector(&self) -> bool {
        if !self.has_valid_device_code() {
            return false;
        }
        let state = self.load();
        let has_token = state
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());
        let has_hostname = state
            .get("hostname")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());
        let paired = state
            .get("paired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || state
                .get("bound")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        has_token || has_hostname || paired
    }

    /// Start cloudflared from on-disk connect.json (e.g. right after lunad boot).
    pub fn restore_tunnel_from_disk(&self) {
        if !self.has_valid_device_code() {
            return;
        }
        let _ = self.ensure_tunnel();
    }

    /// Pull Connect status with the permanent device token. Call on boot and on the poll loop.
    /// Returns true when bound (200). On authentic JSON 403 unbound, clears local claim state but
    /// keeps the token file. Cloudflare/HTML gateway challenges keep the claim and set a sticky error.
    pub fn poll_status(&self) -> bool {
        if !self.has_valid_device_code() {
            return false;
        }
        let Ok(code) = self.device_code() else {
            return false;
        };
        match self.call_device_status(&code) {
            Ok(remote) => {
                self.set_rejected_token(false);
                self.clear_connect_unreachable();
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
                self.set_rejected_token(false);
                self.clear_connect_unreachable();
                self.clear_claim_keep_code();
                false
            }
            Err(ConnectError::InvalidToken) => {
                self.set_rejected_token(true);
                self.clear_connect_unreachable();
                self.stop_tunnel();
                false
            }
            Err(ConnectError::GatewayChallenge) => {
                self.set_connect_unreachable(CONNECT_CHALLENGED_MSG);
                false
            }
            Err(ConnectError::Unreachable) => {
                self.set_connect_unreachable(CONNECT_UNREACHABLE_MSG);
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
        // Domain assignment publishes DNS immediately; start cloudflared now or visitors see 1033.
        let _ = self.ensure_tunnel();
        Ok(changed)
    }

    /// Remove the device token and clear cloud bind state. Stops polling immediately.
    pub fn remove_device_token(&self) -> Result<(), ConnectError> {
        self.stop_tunnel();
        let _ = std::fs::remove_file(&self.state_path);
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.legacy_token_path);
        self.set_rejected_token(false);
        self.clear_connect_unreachable();
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

    /// User-facing error when the on-disk token cannot be used with Connect.
    pub fn device_token_error(&self) -> Option<String> {
        if self.token_file_malformed() {
            return Some(DEVICE_TOKEN_MALFORMED_MSG.to_string());
        }
        if self.rejected_token() {
            return Some(DEVICE_TOKEN_REJECTED_MSG.to_string());
        }
        None
    }

    fn connect_unreachable_message(&self) -> Option<String> {
        if self.device_token_error().is_some() {
            return None;
        }
        if !self.has_valid_device_code() {
            return None;
        }
        self.connect_unreachable_msg().map(str::to_string)
    }

    fn token_file_present(&self) -> bool {
        self.token_path.is_file() || self.legacy_token_path.is_file()
    }

    fn token_file_malformed(&self) -> bool {
        self.token_file_present() && self.read_device_token().is_none()
    }

    fn rejected_token(&self) -> bool {
        *self
            .rejected_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn set_rejected_token(&self, rejected: bool) {
        *self
            .rejected_token
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = rejected;
    }

    fn connect_unreachable_msg(&self) -> Option<&'static str> {
        *self
            .connect_unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn set_connect_unreachable(&self, msg: &'static str) {
        *self
            .connect_unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(msg);
    }

    fn clear_connect_unreachable(&self) {
        *self
            .connect_unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
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
        let state = self.load();
        let token = state
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let hostname = state.get("hostname").and_then(|v| v.as_str()).unwrap_or("");
        if token.is_empty() {
            if !hostname.is_empty() {
                // DNS can already point at a Cloudflare Tunnel while Luna has no token → Error 1033.
                tracing::error!(
                    hostname,
                    "Connect assigned a hostname but no tunnel token is on disk — cloudflared cannot start (no service unit; lunad must spawn it)"
                );
            }
            return Ok(());
        }
        if token.starts_with("mock-") {
            let mut state = self.load();
            state["tunnel_active"] = json!(true);
            return self.save(&state);
        }

        if self.tunnel_running_with_token(&token) {
            return Ok(());
        }
        self.stop_tunnel();

        let bin = Self::cloudflared_bin();
        // Token mode: no config.yml and no OpenRC/systemd unit. Bare `cloudflared` will say
        // "config not found"; lunad must pass --token (and keep the child alive).
        tracing::info!(
            path = %bin.display(),
            port = self.local_port,
            hostname,
            "starting cloudflared tunnel (token mode, managed by lunad)"
        );

        let mut child = Command::new(&bin)
            .args(["tunnel", "--no-autoupdate", "run", "--token", &token])
            .env("TUNNEL_TOKEN", &token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                tracing::error!(path = %bin.display(), error = %e, "cloudflared spawn failed");
                ConnectError::Other(
                    "Luna couldn't start the protected connection. Try again in a few minutes."
                        .into(),
                )
            })?;

        if let Some(stderr) = child.stderr.take() {
            std::thread::Builder::new()
                .name("cloudflared-log".into())
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            tracing::warn!(target: "cloudflared", "{trimmed}");
                        }
                    }
                })
                .ok();
        }

        // cloudflared exits quickly on bad tokens; surface that instead of leaving DNS on 1033.
        std::thread::sleep(std::time::Duration::from_millis(400));
        match child.try_wait() {
            Ok(Some(status)) => {
                tracing::error!(
                    ?status,
                    hostname,
                    "cloudflared exited immediately after start — tunnel will stay on Error 1033 until this is fixed"
                );
                return Err(ConnectError::Other(
                    "Luna couldn't keep the protected connection running. Try again in a few minutes."
                        .into(),
                ));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "could not check cloudflared child status");
            }
        }

        *self.active_tunnel_token.lock().unwrap() = Some(token);
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    fn tunnel_running_with_token(&self, token: &str) -> bool {
        let mut g = self.child.lock().unwrap();
        if let Some(child) = g.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    let active = self.active_tunnel_token.lock().unwrap();
                    return active.as_deref() == Some(token);
                }
                _ => *g = None,
            }
        }
        false
    }

    fn stop_tunnel(&self) {
        *self.active_tunnel_token.lock().unwrap() = None;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Status pull reports Luna's HTTP listen port so Connect can aim the tunnel at the right origin.
    fn call_device_status(&self, code: &str) -> Result<Value, ConnectError> {
        let url = format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            "/api/v1/status"
        );
        // http_status_as_error(false): read body/headers on 4xx so we can distinguish
        // Cloudflare managed challenges from authentic Connect unbound JSON.
        let mut req = ureq::get(&url)
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", format!("Bearer {code}"));
        if self.local_port > 0 {
            req = req.header("X-Luna-Local-Port", self.local_port.to_string());
        }
        let mut response = match req.call() {
            Ok(r) => r,
            Err(e) => return Err(map_transport_error(e)),
        };
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let cf_mitigated = response
            .headers()
            .get("cf-mitigated")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = response.body_mut().read_to_string().unwrap_or_default();
        if status == 401 {
            return Err(ConnectError::InvalidToken);
        }
        if status == 403 {
            return Err(classify_403(
                status,
                &content_type,
                &body,
                cf_mitigated.as_deref(),
            ));
        }
        if !(200..300).contains(&status) {
            return Err(ConnectError::Unreachable);
        }
        serde_json::from_str(&body)
            .map_err(|_| ConnectError::Other("Connect sent a reply Luna couldn't read.".into()))
    }

    /// Resolve cloudflared: Luna OS ships it in /usr/local/bin, but OpenRC service PATH
    /// often omits that directory.
    fn cloudflared_bin() -> PathBuf {
        const CANDIDATES: &[&str] = &[
            "/usr/local/bin/cloudflared",
            "/usr/bin/cloudflared",
            "/sbin/cloudflared",
        ];
        for candidate in CANDIDATES {
            let path = Path::new(candidate);
            if path.is_file() {
                return path.to_path_buf();
            }
        }
        PathBuf::from("cloudflared")
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

    /// Like call_json, but maps authentic Connect JSON 403 to `ConnectError::Other("403 unbound")`
    /// and Cloudflare/HTML challenges to `GatewayChallenge` (keep local claim).
    fn call_json_status(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, ConnectError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let auth = key.map(|k| format!("Bearer {k}"));
        // Allow reading non-2xx bodies (CF challenge HTML vs Connect JSON).
        let result = match (method, body) {
            ("GET", _) => {
                let mut req = ureq::get(&url).config().http_status_as_error(false).build();
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.call()
            }
            ("POST", Some(body)) => {
                let mut req = ureq::post(&url)
                    .config()
                    .http_status_as_error(false)
                    .build();
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.send_json(body)
            }
            ("POST", None) => {
                let mut req = ureq::post(&url)
                    .config()
                    .http_status_as_error(false)
                    .build();
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.send(&[] as &[u8])
            }
            _ => return Err(ConnectError::Other("unsupported method".into())),
        };
        let mut response = match result {
            Ok(r) => r,
            Err(e) => return Err(map_transport_error(e)),
        };
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let cf_mitigated = response
            .headers()
            .get("cf-mitigated")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body_text = response.body_mut().read_to_string().unwrap_or_default();
        if status == 401 {
            return Err(ConnectError::InvalidToken);
        }
        if status == 403 {
            return Err(classify_403(
                status,
                &content_type,
                &body_text,
                cf_mitigated.as_deref(),
            ));
        }
        if !(200..300).contains(&status) {
            return Err(map_transport_error(ureq::Error::StatusCode(status)));
        }
        serde_json::from_str(&body_text)
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
        ureq::Error::StatusCode(401) => ConnectError::InvalidToken,
        ureq::Error::StatusCode(409) => ConnectError::Conflict,
        _ => ConnectError::Unreachable,
    }
}

/// Classify an HTTP 403 from Connect or a fronting gateway.
/// Authentic Connect unbind is JSON. Cloudflare managed challenges are HTML (+ cf-mitigated).
fn classify_403(
    status: u16,
    content_type: &str,
    body: &str,
    cf_mitigated: Option<&str>,
) -> ConnectError {
    if looks_like_cf_challenge(status, content_type, body, cf_mitigated) {
        return ConnectError::GatewayChallenge;
    }
    if is_json_connect_body(content_type, body) {
        return ConnectError::Other("403 unbound".into());
    }
    // Non-JSON gateway block (WAF plain text, empty body, etc.) — keep local claim.
    ConnectError::Unreachable
}

fn is_json_connect_body(content_type: &str, body: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("application/json") || ct.contains("+json") {
        return true;
    }
    body.trim_start().starts_with('{')
}

/// True when an HTTP reply looks like a Cloudflare managed JS challenge (not Connect JSON).
fn looks_like_cf_challenge(
    status: u16,
    content_type: &str,
    body: &str,
    cf_mitigated: Option<&str>,
) -> bool {
    if !(status == 403 || status == 503) {
        return false;
    }
    if cf_mitigated.is_some_and(|v| v.eq_ignore_ascii_case("challenge")) {
        return true;
    }
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("text/html") {
        return true;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("just a moment")
        || lower.contains("challenges.cloudflare.com")
        || lower.contains("cf-browser-verification")
        || lower.contains("cdn-cgi/challenge-platform")
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
    fn cloudflared_bin_prefers_usr_local() {
        if Path::new("/usr/local/bin/cloudflared").is_file() {
            assert_eq!(
                ConnectService::cloudflared_bin(),
                PathBuf::from("/usr/local/bin/cloudflared")
            );
        }
    }

    #[test]
    fn idle_requires_quiet_window() {
        assert!(!is_idle(100, 110));
        assert!(is_idle(100, 140));
    }

    #[test]
    fn tunnel_ready_with_mock_token_without_process() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        service
            .apply_claimed(&json!({
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock-token",
            }))
            .unwrap();
        assert!(service.tunnel_ready());
    }

    #[test]
    fn poll_interval_aggressive_during_setup_without_tunnel() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        assert_eq!(
            service.poll_interval_secs(true),
            AGGRESSIVE_POLL_SECS,
            "setup open without tunnel should poll fast"
        );
        assert_eq!(
            service.poll_interval_secs(false),
            STEADY_POLL_SECS,
            "unbound device with setup closed can use steady interval"
        );
    }

    #[test]
    fn poll_interval_aggressive_after_domain_assigned_setup_closed() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        service
            .save(&json!({
                "hostname": "arst.luna.servers.libreloom.org",
                "subdomain": "arst",
                "paired": true,
                "bound": true,
            }))
            .unwrap();
        assert!(!service.tunnel_ready());
        assert_eq!(
            service.poll_interval_secs(false),
            AGGRESSIVE_POLL_SECS,
            "paired hostname without a live connector must keep polling fast after setup closes"
        );
    }

    #[test]
    fn poll_interval_steady_when_tunnel_ready_during_setup() {
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        service
            .apply_claimed(&json!({
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock-token",
            }))
            .unwrap();
        assert_eq!(
            service.poll_interval_secs(true),
            STEADY_POLL_SECS,
            "tunnel ready during setup should slow polling"
        );
    }

    fn serve_once(status: u16, body: &str) -> String {
        serve_raw(status, "application/json", body, &[])
    }

    fn serve_raw(
        status: u16,
        content_type: &str,
        body: &str,
        extra_headers: &[(&str, &str)],
    ) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_string();
        let content_type = content_type.to_string();
        let extra: Vec<(String, String)> = extra_headers
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let mut resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (k, v) in &extra {
                    resp.push_str(&format!("{k}: {v}\r\n"));
                }
                resp.push_str("\r\n");
                resp.push_str(&body);
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    fn seed_claim(service: &ConnectService) {
        service
            .save(&json!({
                "hostname": "repro.luna.servers.libreloom.org",
                "subdomain": "repro",
                "tunnel_token": "mock-preexisting-tunnel-token",
                "paired": true,
                "bound": true,
            }))
            .unwrap();
        assert!(service.state_path.is_file());
    }

    #[test]
    fn malformed_device_token_sets_status_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DEVICE_TOKEN_FILE), "not-a-code").unwrap();
        let service = ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        let st = service.status();
        assert!(!st.connect_active);
        assert_eq!(
            st.device_token_error.as_deref(),
            Some(DEVICE_TOKEN_MALFORMED_MSG)
        );
        assert!(
            st.device_token_error
                .as_deref()
                .unwrap()
                .contains("Settings → About → Advanced")
        );
    }

    #[test]
    fn poll_401_sets_rejected_token_error() {
        let url = serve_once(
            401,
            "{\"error\":\"This Luna is not signed in to Connect.\"}",
        );
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        assert!(!service.poll_status());
        let st = service.status();
        assert!(st.connect_active);
        assert!(!st.enabled);
        assert_eq!(
            st.device_token_error.as_deref(),
            Some(DEVICE_TOKEN_REJECTED_MSG)
        );
        assert!(st.setup_code.is_none());
    }

    #[test]
    fn poll_403_json_unbound_clears_claim() {
        let url = serve_once(403, "{\"error\":\"unbound\"}");
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        seed_claim(&service);
        assert!(!service.poll_status());
        assert!(
            !service.state_path.is_file(),
            "authentic Connect unbound must clear connect.json"
        );
        assert!(service.status().device_token_error.is_none());
        assert!(service.status().connect_unreachable.is_none());
        assert!(dir.path().join(DEVICE_TOKEN_FILE).is_file());
    }

    #[test]
    fn poll_403_cf_challenge_keeps_claim_and_sets_sticky() {
        let html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head>\
            <body class=\"cf-browser-verification\">Just a moment...\
            <script src=\"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page\"></script>\
            </body></html>";
        let url = serve_raw(
            403,
            "text/html; charset=UTF-8",
            html,
            &[("cf-mitigated", "challenge")],
        );
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        seed_claim(&service);
        assert!(!service.poll_status());
        assert!(
            service.state_path.is_file(),
            "CF challenge must not wipe connect.json"
        );
        let st = service.status();
        assert_eq!(
            st.connect_unreachable.as_deref(),
            Some(CONNECT_CHALLENGED_MSG)
        );
        assert!(st.device_token_error.is_none());
        let state = service.load();
        assert_eq!(
            state.get("tunnel_token").and_then(|v| v.as_str()),
            Some("mock-preexisting-tunnel-token")
        );
    }

    #[test]
    fn poll_403_non_json_gateway_keeps_claim_as_unreachable() {
        let url = serve_raw(403, "text/plain", "blocked by gateway", &[]);
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        seed_claim(&service);
        assert!(!service.poll_status());
        assert!(service.state_path.is_file());
        assert_eq!(
            service.status().connect_unreachable.as_deref(),
            Some(CONNECT_UNREACHABLE_MSG)
        );
    }

    #[test]
    fn poll_200_bound_applies_tunnel_token() {
        let url = serve_once(
            200,
            r#"{"hostname":"repro.luna.servers.libreloom.org","subdomain":"repro","tunnel_token":"mock-repro-tunnel-token","backup_unlocked":false,"paired":true,"bound":true}"#,
        );
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        assert!(service.poll_status());
        let st = service.status();
        assert!(st.enabled);
        assert_eq!(
            st.hostname.as_deref(),
            Some("repro.luna.servers.libreloom.org")
        );
        assert!(st.connect_unreachable.is_none());
        let state = service.load();
        assert_eq!(
            state.get("tunnel_token").and_then(|v| v.as_str()),
            Some("mock-repro-tunnel-token")
        );
        assert!(service.tunnel_ready());
    }

    #[test]
    fn looks_like_cf_challenge_detects_markers() {
        assert!(looks_like_cf_challenge(
            403,
            "text/html",
            "Just a moment...",
            Some("challenge")
        ));
        assert!(looks_like_cf_challenge(
            403,
            "application/octet-stream",
            "cdn-cgi/challenge-platform",
            None
        ));
        assert!(!looks_like_cf_challenge(
            403,
            "application/json",
            "{\"error\":\"unbound\"}",
            None
        ));
        assert!(!looks_like_cf_challenge(
            200,
            "text/html",
            "Just a moment...",
            Some("challenge")
        ));
    }

    #[test]
    fn classify_403_distinguishes_challenge_from_unbound() {
        match classify_403(403, "text/html", "Just a moment...", Some("challenge")) {
            ConnectError::GatewayChallenge => {}
            other => panic!("expected GatewayChallenge, got {other:?}"),
        }
        match classify_403(403, "application/json", "{\"error\":\"unbound\"}", None) {
            ConnectError::Other(msg) => assert!(msg.contains("unbound")),
            other => panic!("expected unbound Other, got {other:?}"),
        }
        match classify_403(403, "text/plain", "nope", None) {
            ConnectError::Unreachable => {}
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }

    #[test]
    fn poll_403_unbound_is_not_a_token_failure() {
        let url = serve_once(403, "{\"error\":\"unbound\"}");
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        assert!(!service.poll_status());
        assert!(service.status().device_token_error.is_none());
    }

    #[test]
    fn replacing_device_token_clears_rejected_error() {
        let url = serve_once(401, "{}");
        let dir = tempfile::tempdir().unwrap();
        let service = ConnectService::new(dir.path(), Some(url));
        service.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        assert!(!service.poll_status());
        assert!(service.status().device_token_error.is_some());
        service.set_oss_code("ZZZZ-YYYY-XXXX-WWWW-VVVV").unwrap();
        assert!(service.status().device_token_error.is_none());
    }
}
