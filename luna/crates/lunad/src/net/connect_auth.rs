//! Device identity, pairing, and the rolling Luna Connect credential.
//!
//! The public Device ID and reusable Verification code are pairing material,
//! never bearer credentials. Only `connect-credential` authenticates requests
//! after a device is bound.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    AGGRESSIVE_POLL_SECS, CONNECT_HTTP_CONNECT_TIMEOUT, CONNECT_HTTP_TIMEOUT, MAX_REPLY_BYTES,
    PollWake, STEADY_POLL_SECS, UNBIND_TIMEOUT, classify_403, map_transport_error,
    sanitize_base_url,
};

pub const DEVICE_UID_FILE: &str = "device-uid";
pub const PAIRING_CODE_FILE: &str = "pairing-code";
pub const CONNECT_CREDENTIAL_FILE: &str = "connect-credential";
pub const UNBIND_PENDING_FILE: &str = "connect-unbind-pending";
pub const LAN_OVERRIDE_FILE: &str = "lan-override";

pub const DEVICE_UID_MALFORMED_MSG: &str = "This Luna's Device ID is not valid. Enter the Device ID and Verification code from the quick-start guide.";
pub const PAIRING_CODE_MALFORMED_MSG: &str = "This Luna's Verification code is not valid. Enter the Device ID and Verification code from the quick-start guide.";
pub const CREDENTIAL_MALFORMED_MSG: &str =
    "This Luna's Luna Connect connection is damaged. Reconnect this Luna from Luna Connect.";
pub const CREDENTIAL_REJECTED_MSG: &str = "Luna Connect no longer accepts this Luna's connection. Open Luna Connect to reconnect this Luna.";
pub const UNBIND_PENDING_MSG: &str = "Luna is still disconnecting from Luna Connect. Remote access and pairing are stopped until it finishes.";
pub const CONNECT_UNREACHABLE_MSG: &str = "Luna can't reach Luna Connect, or Luna Connect has a problem. Check this Luna's internet connection. Luna will keep trying.";
pub const CONNECT_CHALLENGED_MSG: &str =
    "Luna Connect blocked a request from this Luna. Luna will keep trying.";
pub const SETUP_GRANT_REJECTED_MSG: &str =
    "That setup link is no longer valid. Create a new one in Luna Connect and try again.";

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error(
        "Luna couldn't reach Luna Connect, or Luna Connect had a problem. Check your internet connection, then try again."
    )]
    Unreachable,
    #[error("{msg}", msg = CONNECT_CHALLENGED_MSG)]
    GatewayChallenge,
    #[error("That name is already in use. Pick another.")]
    Conflict,
    /// Connect returned 401 for an invalid or unknown credential.
    #[error("{msg}", msg = CREDENTIAL_REJECTED_MSG)]
    InvalidToken,
    /// Connect returned the explicit `device_revoked` machine code.
    #[error("{msg}", msg = CREDENTIAL_REJECTED_MSG)]
    Revoked,
    /// Connect returned the explicit `device_unbound` machine code.
    #[error("This Luna isn't linked to a Luna Connect account right now.")]
    Unbound,
    #[error("No pairing is waiting for this Luna right now.")]
    NoPairing,
    #[error("Luna Connect did not accept that Device ID and Verification code.")]
    PairingRejected,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectState {
    Unbound,
    Pairing,
    Bound,
    Revoked,
}

#[derive(Clone, Copy)]
enum RefreshMode {
    /// Normal bound-device refresh. Authentication failures settle locally.
    Normal,
    /// Reconcile a credential left beside stale unbound/revoked state.
    Recover,
    /// Recover a rotated credential while an unbind remains owed. A failed
    /// recovery must retain both the credential and the pending marker.
    Unbind,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectStatus {
    /// True only while a bound device has a usable rolling credential.
    pub connect_active: bool,
    pub lan_override: bool,
    pub enabled: bool,
    pub base_url: String,
    pub hostname: Option<String>,
    pub domain: Option<String>,
    pub subdomain: Option<String>,
    pub tunnel_active: bool,
    pub backup_unlocked: bool,
    pub cloud_backup: &'static str,
    pub paired: bool,
    pub unclaimed: bool,
    pub state: ConnectState,
    pub unbind_pending: bool,
    /// Grouped public identifier. It is not a credential.
    pub device_uid: Option<String>,
    /// Revealed only to setup or an Admin; never the rolling credential.
    pub verification_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_unreachable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_error: Option<String>,
    pub backup_sources: Vec<Value>,
}

struct ConnectAuth {
    device_uid_path: PathBuf,
    pairing_code_path: PathBuf,
    credential_path: PathBuf,
    unbind_pending_path: PathBuf,
    /// Serializes pairing, polling, refresh, and unbind. In particular, a
    /// refresh may not race an unbind and put a deleted credential back.
    operation_mu: Mutex<()>,
    refresh_mu: Mutex<()>,
    state_mu: Mutex<()>,
    rejected: Mutex<bool>,
    unreachable: Mutex<Option<&'static str>>,
    pairing_error: Mutex<Option<String>>,
    last_refresh: Mutex<Option<Instant>>,
    refresh_after: Mutex<Duration>,
}

pub struct ConnectService {
    pub(super) state_path: PathBuf,
    pub(super) base_url: String,
    pub(super) child: Arc<Mutex<Option<Child>>>,
    pub(super) active_tunnel_token: Arc<Mutex<Option<String>>>,
    pub(super) tunnel_mu: Mutex<()>,
    pub(super) tunnel_error: Mutex<Option<String>>,
    pub(super) cached_wan_ip: Mutex<Option<std::net::IpAddr>>,
    pub(super) poll_wake: Arc<PollWake>,
    pub(super) tunnel_watch: Arc<std::sync::atomic::AtomicU64>,
    pub(super) tunnel_exited: Arc<std::sync::atomic::AtomicBool>,
    pub(super) local_port: u16,
    auth: ConnectAuth,
}

impl ConnectService {
    pub fn new(data_dir: &Path, base_url: Option<String>) -> Self {
        // Connect has no opt-out marker: absence of pairing material is the
        // empty, successful opt-out state.
        let _ = std::fs::remove_file(data_dir.join("disable-connect"));
        let state_path = data_dir.join("connect.json");
        let cached_wan_ip = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|val| {
                val.get("wan_ip")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
            });
        let base_url = base_url
            .filter(|u| !u.is_empty())
            .map(sanitize_base_url)
            .unwrap_or_else(|| super::DEFAULT_CONNECT_URL.to_string());
        Self {
            state_path,
            base_url,
            child: Arc::new(Mutex::new(None)),
            active_tunnel_token: Arc::new(Mutex::new(None)),
            tunnel_mu: Mutex::new(()),
            tunnel_error: Mutex::new(None),
            cached_wan_ip: Mutex::new(cached_wan_ip),
            poll_wake: Arc::new(PollWake::default()),
            tunnel_watch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            tunnel_exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            local_port: 8090,
            auth: ConnectAuth {
                device_uid_path: data_dir.join(DEVICE_UID_FILE),
                pairing_code_path: data_dir.join(PAIRING_CODE_FILE),
                credential_path: data_dir.join(CONNECT_CREDENTIAL_FILE),
                unbind_pending_path: data_dir.join(UNBIND_PENDING_FILE),
                operation_mu: Mutex::new(()),
                refresh_mu: Mutex::new(()),
                state_mu: Mutex::new(()),
                rejected: Mutex::new(false),
                unreachable: Mutex::new(None),
                pairing_error: Mutex::new(None),
                last_refresh: Mutex::new(None),
                refresh_after: Mutex::new(Duration::from_secs(STEADY_POLL_SECS)),
            },
        }
    }

    pub fn with_local_port(mut self, port: u16) -> Self {
        if port > 0 {
            self.local_port = port;
        }
        self
    }

    #[cfg(test)]
    pub(super) fn state_mu_for_test(&self) -> &Mutex<()> {
        &self.auth.state_mu
    }

    pub fn status(&self) -> ConnectStatus {
        self.status_for(true)
    }

    /// Pairing codes are setup/Admin-only after setup. The rolling credential
    /// is never part of this struct or returned by any API.
    pub fn status_for(&self, reveal_secrets: bool) -> ConnectStatus {
        let state = self.load();
        let pending = self.unbind_pending();
        let uid = self.device_uid().ok();
        let uid_malformed = self.auth.device_uid_path.is_file() && uid.is_none();
        let code = self.verification_code().ok();
        let code_malformed = self.auth.pairing_code_path.is_file() && code.is_none();
        let credential = self.auth_token().ok();
        let credential_present = self.auth.credential_path.is_file();
        let rejected = self.rejected();
        let mut connect_state = self.connect_state(&state, credential.is_some());
        if rejected || (connect_state == ConnectState::Bound && credential.is_none()) {
            connect_state = ConnectState::Revoked;
        }
        let active = connect_state == ConnectState::Bound
            && credential.is_some()
            && !pending
            && !rejected
            && uid.is_some();
        let hostname = active
            .then(|| {
                state
                    .get("hostname")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .flatten();
        let tunnel_token = state
            .get("tunnel_token")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tunnel_active = active
            && (self.tunnel_running()
                || (tunnel_token.starts_with("mock-")
                    && state
                        .get("tunnel_active")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)));
        let enabled =
            active && (!hostname.as_deref().unwrap_or("").is_empty() || !tunnel_token.is_empty());
        let backup_unlocked = state
            .get("backup_unlocked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let cloud_backup = if !active {
            super::CLOUD_BACKUP_NOT_LINKED
        } else if !backup_unlocked {
            super::CLOUD_BACKUP_NO_PAYMENT
        } else {
            super::CLOUD_BACKUP_READY
        };
        let connect_error = if pending {
            Some(UNBIND_PENDING_MSG.to_string())
        } else if uid_malformed || (connect_state == ConnectState::Bound && uid.is_none()) {
            Some(DEVICE_UID_MALFORMED_MSG.to_string())
        } else if credential_present && credential.is_none() {
            Some(CREDENTIAL_MALFORMED_MSG.to_string())
        } else if connect_state == ConnectState::Revoked {
            Some(CREDENTIAL_REJECTED_MSG.to_string())
        } else if code_malformed && connect_state != ConnectState::Bound {
            Some(PAIRING_CODE_MALFORMED_MSG.to_string())
        } else {
            self.pairing_error()
        };
        let unreachable = if connect_error.is_some() || pending {
            None
        } else {
            self.unreachable_message()
        };
        let mut tunnel_err = self.tunnel_error_message();
        if tunnel_err.is_none()
            && active
            && enabled
            && hostname.is_some()
            && !tunnel_active
            && connect_error.is_none()
        {
            tunnel_err = Some(super::TUNNEL_NOT_RUNNING_MSG.to_string());
        }
        ConnectStatus {
            connect_active: active,
            lan_override: self.lan_override(),
            enabled,
            base_url: self.base_url.clone(),
            domain: hostname.clone(),
            hostname,
            subdomain: active
                .then(|| {
                    state
                        .get("subdomain")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .flatten(),
            tunnel_active,
            backup_unlocked: backup_unlocked && active,
            cloud_backup,
            paired: active,
            unclaimed: matches!(connect_state, ConnectState::Unbound | ConnectState::Pairing),
            state: connect_state,
            unbind_pending: pending,
            device_uid: uid.map(|uid| group_device_uid(&uid)),
            verification_code: reveal_secrets.then_some(code).flatten(),
            connect_error,
            connect_unreachable: unreachable.map(str::to_string),
            tunnel_error: tunnel_err,
            backup_sources: if reveal_secrets && active {
                state
                    .get("backup_sources")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
            } else {
                Vec::new()
            },
        }
    }

    pub fn tunnel_watched(&self) -> bool {
        self.tunnel_watch.load(std::sync::atomic::Ordering::Acquire) != 0
    }

    pub fn take_tunnel_exit(&self) -> bool {
        self.tunnel_exited
            .swap(false, std::sync::atomic::Ordering::AcqRel)
    }

    pub fn poll_wake(&self) -> Arc<PollWake> {
        self.poll_wake.clone()
    }

    pub fn has_device_uid(&self) -> bool {
        self.device_uid().is_ok()
    }

    pub fn has_pairing_material(&self) -> bool {
        self.device_uid().is_ok() && self.verification_code().is_ok()
    }

    /// LAN lockdown and normal Connect work depend on a bound rolling
    /// credential, never on the presence of human-facing pairing material.
    pub fn is_connect_active(&self) -> bool {
        if self.unbind_pending() || self.rejected() {
            return false;
        }
        let credential_valid = self.auth_token().is_ok();
        if self.connect_state(&self.load(), credential_valid) != ConnectState::Bound
            || !credential_valid
        {
            return false;
        }
        self.device_uid().is_ok()
    }

    pub fn poll_needed(&self) -> bool {
        if self.unbind_pending() {
            return true;
        }
        let credential = self.auth_token().ok();
        let state = self.load();
        match self.connect_state(&state, credential.is_some()) {
            ConnectState::Bound => !self.rejected() || credential.is_some(),
            // A credential beside stale unbound/revoked state is recovered
            // through Connect, never sent to the pairing-claim loop.
            ConnectState::Unbound | ConnectState::Pairing | ConnectState::Revoked => {
                credential.is_some() || self.has_pairing_material()
            }
        }
    }

    pub fn can_unbind(&self) -> bool {
        // Even a credential left beside stale state may still own a remote
        // binding. Let the unbind route ask Connect instead of trusting the
        // local label blindly. A pairing attempt with no credential can also be
        // cancelled using the saved UID and Verification code.
        self.unbind_pending()
            || self.auth_token().is_ok()
            || (self.connect_state(&self.load(), false) == ConnectState::Pairing
                && self.has_pairing_material())
    }

    pub fn lan_override(&self) -> bool {
        self.auth
            .device_uid_path
            .parent()
            .is_some_and(|data_dir| data_dir.join(LAN_OVERRIDE_FILE).exists())
    }

    pub fn wan_ip(&self) -> Option<std::net::IpAddr> {
        *self.cached_wan_ip.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_cached_wan_ip(&self, ip: std::net::IpAddr) {
        *self.cached_wan_ip.lock().unwrap_or_else(|e| e.into_inner()) = Some(ip);
    }

    pub fn ensure_pairing_material_from_mag(&self) -> crate::system::factory_mag::MagFetchOutcome {
        self.ensure_pairing_material_from_mag_with_options(
            crate::system::factory_mag::MagFetchOptions::default(),
        )
    }

    pub(super) fn ensure_pairing_material_from_mag_with_options(
        &self,
        options: crate::system::factory_mag::MagFetchOptions,
    ) -> crate::system::factory_mag::MagFetchOutcome {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Pairing writes and claim polling take this same lock. Recheck after
        // acquiring it so a queued magazine read cannot cross an unbind.
        if self.unbind_pending() {
            return crate::system::factory_mag::MagFetchOutcome::Incomplete;
        }
        let outcome = crate::system::factory_mag::fetch_pairing_material_from_mag(
            &self.auth.device_uid_path,
            &self.auth.pairing_code_path,
            &options,
        );
        if matches!(
            outcome,
            crate::system::factory_mag::MagFetchOutcome::Fetched { .. }
        ) {
            self.poll_wake.wake();
        }
        outcome
    }

    pub fn device_uid(&self) -> Result<String, ConnectError> {
        read_trimmed(&self.auth.device_uid_path)
            .map(|raw| normalize_device_uid(&raw))
            .filter(|uid| is_device_uid_format(uid))
            .ok_or_else(|| ConnectError::Other(DEVICE_UID_MALFORMED_MSG.into()))
    }

    pub fn verification_code(&self) -> Result<String, ConnectError> {
        read_trimmed(&self.auth.pairing_code_path)
            .map(|raw| normalize_verification_code(&raw))
            .filter(|code| is_verification_code_format(code))
            .ok_or_else(|| ConnectError::Other(PAIRING_CODE_MALFORMED_MSG.into()))
    }

    /// Store the two pairing values separately. The UID is immutable once it
    /// exists, and a saved Verification code cannot be replaced under it:
    /// Connect keeps the matching code for this device.
    pub fn set_pairing_material(
        &self,
        device_uid: &str,
        verification_code: &str,
    ) -> Result<(), ConnectError> {
        let uid = normalize_device_uid(device_uid);
        if !is_device_uid_format(&uid) {
            return Err(ConnectError::Other(
                "That Device ID is not valid. Copy it from the quick-start guide or Luna Connect."
                    .into(),
            ));
        }
        let code = normalize_verification_code(verification_code);
        if !is_verification_code_format(&code) {
            return Err(ConnectError::Other(
                "That Verification code is not valid. Enter the six characters from the quick-start guide or Luna Connect."
                    .into(),
            ));
        }
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.unbind_pending() {
            return Err(ConnectError::Other(UNBIND_PENDING_MSG.into()));
        }
        if let Ok(existing) = self.device_uid()
            && existing != uid
        {
            return Err(ConnectError::Other(
                "This Luna already has a different Device ID. Restore the original Device ID."
                    .into(),
            ));
        }
        if self.device_uid().is_err()
            && self.connect_state(&self.load(), self.auth_token().is_ok()) != ConnectState::Unbound
        {
            return Err(ConnectError::Other(
                "This Luna's Device ID is missing. Restore the original Device ID before reconnecting."
                    .into(),
            ));
        }
        if let Ok(existing) = self.verification_code()
            && existing != code
        {
            return Err(ConnectError::Other(
                "That Verification code does not match the one already saved on this Luna. Restore the saved code instead."
                    .into(),
            ));
        }
        write_private_file(&self.auth.pairing_code_path, format!("{code}\n").as_bytes())?;
        write_private_file(&self.auth.device_uid_path, format!("{uid}\n").as_bytes())?;
        *self.auth.rejected.lock().unwrap_or_else(|e| e.into_inner()) = false;
        *self
            .auth
            .pairing_error
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.clear_unreachable();
        self.poll_wake.wake();
        Ok(())
    }

    /// Local-only: no Connect request and no change to the credential,
    /// binding, address, or tunnel.
    pub fn remove_pairing_code(&self) -> Result<(), ConnectError> {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match std::fs::remove_file(&self.auth.pairing_code_path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(ConnectError::Other(
                    "Luna couldn't remove the Verification code. Try again.".into(),
                ));
            }
        }
        *self
            .auth
            .pairing_error
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        crate::system::console::request_refresh();
        Ok(())
    }

    pub fn public_hostname(&self) -> Option<String> {
        if !self.is_connect_active() {
            return None;
        }
        self.load()
            .get("hostname")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    pub fn tunnel_ready(&self) -> bool {
        if !self.is_connect_active() || self.unbind_pending() {
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

    pub fn poll_interval_secs(&self, setup_wizard_open: bool) -> u64 {
        if self.unbind_pending() {
            return AGGRESSIVE_POLL_SECS;
        }
        let state = self.load();
        match self.connect_state(&state, self.auth_token().is_ok()) {
            ConnectState::Unbound | ConnectState::Pairing => {
                if self.has_pairing_material() {
                    AGGRESSIVE_POLL_SECS
                } else {
                    STEADY_POLL_SECS
                }
            }
            ConnectState::Revoked => {
                if self.unreachable_message().is_some() {
                    AGGRESSIVE_POLL_SECS
                } else {
                    STEADY_POLL_SECS
                }
            }
            ConnectState::Bound => {
                if self.tunnel_ready() && self.unreachable_message().is_none() {
                    STEADY_POLL_SECS
                } else if setup_wizard_open
                    || self.expects_tunnel_connector()
                    || self.unreachable_message().is_some()
                {
                    AGGRESSIVE_POLL_SECS
                } else {
                    STEADY_POLL_SECS
                }
            }
        }
    }

    pub fn expects_tunnel(&self) -> bool {
        self.expects_tunnel_connector()
    }

    pub(super) fn expects_tunnel_connector(&self) -> bool {
        if !self.is_connect_active() || self.unbind_pending() {
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
        has_token || has_hostname
    }

    pub fn restore_tunnel_from_disk(&self) {
        if self.is_connect_active() && !self.unbind_pending() {
            let _ = self.ensure_tunnel();
        }
    }

    pub fn ensure_tunnel_if_needed(&self) {
        if self.expects_tunnel_connector() && !self.tunnel_ready() {
            tracing::info!(
                "ensuring cloudflared despite Connect poll failure (local tunnel credentials present)"
            );
            let _ = self.ensure_tunnel();
        }
    }

    /// One poll cycle: settle an owed unbind first; otherwise refresh a bound
    /// credential when due and pull status, or claim pairing while unbound.
    pub fn poll_status(&self) -> bool {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let reconnect = self.poll_wake.take_reconnect();
        if self.unbind_pending() {
            match self.pending_resolution() {
                Some(ConnectState::Unbound) => {
                    if let Err(err) = self.clear_to_unbound_inner() {
                        tracing::info!(error = %err, "Luna Connect unbind cleanup still pending; will retry");
                        return false;
                    }
                }
                Some(ConnectState::Revoked) => {
                    if let Err(err) = self.mark_revoked_inner() {
                        tracing::info!(error = %err, "Luna Connect revocation cleanup still pending; will retry");
                        return false;
                    }
                    return false;
                }
                None => {
                    if let Err(err) = self.unbind_now_inner() {
                        tracing::info!(error = %err, "Luna Connect unbind still pending; will retry");
                        self.stop_tunnel();
                        return false;
                    }
                }
                Some(ConnectState::Pairing | ConnectState::Bound) => {}
            }
        }
        let credential = self.auth_token().ok();
        let state = self.load();
        let state = self.connect_state(&state, credential.is_some());
        if credential.is_some() && (self.rejected() || state != ConnectState::Bound) {
            if !self.reconcile_credential_inner() {
                return false;
            }
            return self.poll_bound(false);
        }
        match state {
            ConnectState::Bound => self.poll_bound(reconnect),
            ConnectState::Unbound | ConnectState::Pairing | ConnectState::Revoked => {
                self.poll_pairing()
            }
        }
    }

    fn poll_bound(&self, reconnect: bool) -> bool {
        if self.rejected() {
            return false;
        }
        let Ok(mut token) = self.auth_token() else {
            let _ = self.mark_revoked_inner();
            return false;
        };
        if self.refresh_due(reconnect) {
            match self.refresh_credential_inner(true) {
                Ok(()) => match self.auth_token() {
                    Ok(next) => token = next,
                    Err(_) => {
                        let _ = self.mark_revoked_inner();
                        return false;
                    }
                },
                Err(ConnectError::InvalidToken | ConnectError::Revoked | ConnectError::Unbound) => {
                    return false;
                }
                Err(err) => {
                    self.note_unreachable(&err);
                    // The current credential does not expire with time. A
                    // failed refresh must not tear down an otherwise working
                    // tunnel; status can still use it.
                }
            }
        }
        match self.call_device_status(&token) {
            Ok(remote) => self.apply_status_reply(&remote),
            Err(ConnectError::Unbound) => {
                let _ = self.clear_to_unbound_inner();
                false
            }
            Err(ConnectError::Revoked) => {
                let _ = self.mark_revoked_inner();
                false
            }
            Err(ConnectError::InvalidToken) => {
                // A normal route rejects the previous token immediately after
                // rotation. The refresh route accepts it for 60 seconds, so
                // recover a lost refresh response before declaring revocation.
                match self.refresh_credential_inner(true) {
                    Ok(()) => match self.auth_token() {
                        Ok(next) => match self.call_device_status(&next) {
                            Ok(remote) => self.apply_status_reply(&remote),
                            Err(ConnectError::Unbound) => {
                                let _ = self.clear_to_unbound_inner();
                                false
                            }
                            Err(ConnectError::Revoked) => {
                                let _ = self.mark_revoked_inner();
                                false
                            }
                            Err(ConnectError::InvalidToken) => {
                                let _ = self.mark_revoked_inner();
                                false
                            }
                            Err(err) => {
                                self.note_unreachable(&err);
                                if self.expects_tunnel_connector() {
                                    let _ = self.ensure_tunnel();
                                }
                                false
                            }
                        },
                        Err(_) => {
                            let _ = self.mark_revoked_inner();
                            false
                        }
                    },
                    Err(ConnectError::InvalidToken | ConnectError::Revoked) => {
                        let _ = self.mark_revoked_inner();
                        false
                    }
                    Err(ConnectError::Unbound) => false,
                    Err(err) => {
                        self.note_unreachable(&err);
                        if self.expects_tunnel_connector() {
                            let _ = self.ensure_tunnel();
                        }
                        false
                    }
                }
            }
            Err(err) => {
                self.note_unreachable(&err);
                if self.expects_tunnel_connector() {
                    let _ = self.ensure_tunnel();
                }
                false
            }
        }
    }

    fn apply_status_reply(&self, remote: &Value) -> bool {
        let remote_ip = remote
            .get("wan_ip")
            .and_then(|v| v.as_str())
            .and_then(|ip| ip.trim().parse::<std::net::IpAddr>().ok());
        let fallback_ip = if remote_ip.is_none()
            && self
                .cached_wan_ip
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none()
        {
            detect_public_ip_fallback()
        } else {
            None
        };
        let saved = self.update_state(|state| {
            apply_remote_status(state, remote);
            if let Some(ip) = remote_ip.or(fallback_ip) {
                state["wan_ip"] = json!(ip.to_string());
            }
            state["state"] = json!("bound");
            state["bound"] = json!(true);
            state["paired"] = json!(true);
        });
        if let Err(err) = saved {
            self.note_unreachable(&err);
            return false;
        }
        if let Some(ip) = remote_ip.or(fallback_ip) {
            *self.cached_wan_ip.lock().unwrap_or_else(|e| e.into_inner()) = Some(ip);
        }
        self.set_rejected(false);
        self.clear_unreachable();
        *self
            .auth
            .pairing_error
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        let _ = self.ensure_tunnel();
        true
    }

    fn cancel_pairing_claim(&self) -> Result<(), ConnectError> {
        let uid = self.device_uid()?;
        let code = self.verification_code()?;
        self.call_json_status_within(
            "POST",
            "/api/v1/devices/pair/cancel",
            None,
            Some(json!({
                "device_uid": group_device_uid(&uid),
                "verification_code": code,
            })),
            CONNECT_HTTP_TIMEOUT,
        )?;
        Ok(())
    }

    fn poll_pairing(&self) -> bool {
        if self.unbind_pending() {
            return false;
        }
        let (Ok(uid), Ok(code)) = (self.device_uid(), self.verification_code()) else {
            return false;
        };
        match self.call_json_status_within(
            "POST",
            "/api/v1/devices/pair/claim",
            None,
            Some(json!({
                "device_uid": group_device_uid(&uid),
                "verification_code": code,
            })),
            CONNECT_HTTP_TIMEOUT,
        ) {
            Ok(claimed) => {
                let Some(token) = claimed
                    .get("auth_token")
                    .and_then(|v| v.as_str())
                    .filter(|token| is_auth_token_format(token))
                else {
                    self.note_unreachable(&ConnectError::Other(
                        "Luna Connect answered, but Luna could not use the reply.".into(),
                    ));
                    return false;
                };
                let Some(device_id) = claimed
                    .get("device_id")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                else {
                    self.note_unreachable(&ConnectError::Other(
                        "Luna Connect answered, but Luna could not use the reply.".into(),
                    ));
                    return false;
                };
                if let Err(err) =
                    write_private_file(&self.auth.credential_path, format!("{token}\n").as_bytes())
                {
                    self.note_unreachable(&err);
                    return false;
                }
                // Connect has already bound the device. If the state save
                // fails (or power is lost now), retain the issued credential:
                // the next poll reconciles it instead of claiming forever.
                let device_id = device_id.to_string();
                if let Err(err) = self.update_state(|state| {
                    clear_bound_fields(state);
                    state["state"] = json!("bound");
                    state["bound"] = json!(true);
                    state["paired"] = json!(true);
                    state["device_id"] = json!(device_id);
                    state["backup_unlocked"] = json!(false);
                }) {
                    self.note_unreachable(&err);
                    return false;
                }
                let seconds = claimed
                    .get("refresh_after_seconds")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(STEADY_POLL_SECS)
                    .clamp(5, STEADY_POLL_SECS);
                *self
                    .auth
                    .refresh_after
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Duration::from_secs(seconds);
                *self
                    .auth
                    .last_refresh
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                self.set_rejected(false);
                self.clear_unreachable();
                *self
                    .auth
                    .pairing_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                self.poll_wake.wake();
                true
            }
            Err(ConnectError::NoPairing) => {
                self.clear_unreachable();
                *self
                    .auth
                    .pairing_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                false
            }
            Err(ConnectError::PairingRejected) => {
                self.clear_unreachable();
                *self.auth.pairing_error.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some("Luna Connect did not accept that Device ID and Verification code. Check both and try again.".into());
                false
            }
            Err(err) => {
                self.note_unreachable(&err);
                false
            }
        }
    }

    /// Rotate the credential. A lost response leaves the old credential in
    /// place; Connect accepts it on this endpoint for 60 seconds, so the next
    /// attempt can recover the new credential.
    pub fn refresh_credential(&self, force: bool) -> Result<(), ConnectError> {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.refresh_credential_inner(force)
    }

    fn refresh_credential_inner(&self, force: bool) -> Result<(), ConnectError> {
        self.refresh_credential_inner_mode(force, RefreshMode::Normal)
    }

    fn refresh_credential_inner_mode(
        &self,
        force: bool,
        mode: RefreshMode,
    ) -> Result<(), ConnectError> {
        match mode {
            RefreshMode::Normal => {
                if self.unbind_pending() || self.rejected() {
                    return Err(ConnectError::InvalidToken);
                }
                if self.connect_state(&self.load(), true) != ConnectState::Bound {
                    return Err(ConnectError::Unbound);
                }
            }
            RefreshMode::Recover => {
                if self.unbind_pending() {
                    return Err(ConnectError::InvalidToken);
                }
            }
            RefreshMode::Unbind => {
                if !self.unbind_pending() {
                    return Err(ConnectError::Unbound);
                }
            }
        }
        let _refresh = self
            .auth
            .refresh_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !force && !self.refresh_due(false) {
            return Ok(());
        }
        let old = self.auth_token()?;
        let reply = self.call_json_status_within(
            "POST",
            "/api/v1/token/refresh",
            Some(&old),
            None,
            CONNECT_HTTP_TIMEOUT,
        );
        let reply = match reply {
            Ok(reply) => reply,
            Err(
                err @ (ConnectError::InvalidToken | ConnectError::Revoked | ConnectError::Unbound),
            ) => {
                if matches!(mode, RefreshMode::Normal) {
                    match &err {
                        ConnectError::InvalidToken | ConnectError::Revoked => {
                            let _ = self.mark_revoked_inner();
                        }
                        ConnectError::Unbound => {
                            let _ = self.clear_to_unbound_inner();
                        }
                        _ => {}
                    }
                }
                return Err(err);
            }
            Err(err) => {
                self.note_unreachable(&err);
                return Err(err);
            }
        };
        let Some(next) = reply
            .get("auth_token")
            .and_then(|v| v.as_str())
            .filter(|token| is_auth_token_format(token))
        else {
            return Err(ConnectError::Other(
                "Luna Connect answered, but Luna could not use the reply.".into(),
            ));
        };
        write_private_file(&self.auth.credential_path, format!("{next}\n").as_bytes())?;
        if let Some(seconds) = reply.get("refresh_after_seconds").and_then(|v| v.as_u64()) {
            *self
                .auth
                .refresh_after
                .lock()
                .unwrap_or_else(|e| e.into_inner()) =
                Duration::from_secs(seconds.clamp(5, STEADY_POLL_SECS));
        }
        *self
            .auth
            .last_refresh
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        self.clear_unreachable();
        Ok(())
    }

    /// Settle a credential that survived a crash beside an unbound/revoked
    /// label. Refresh is the only route allowed to use the rotation overlap, so
    /// it can distinguish a stale local label from a lost claim/state write.
    fn reconcile_credential_inner(&self) -> bool {
        match self.refresh_credential_inner_mode(true, RefreshMode::Recover) {
            Ok(()) => {}
            Err(ConnectError::Unbound) => {
                let _ = self.clear_to_unbound_inner();
                return false;
            }
            Err(ConnectError::Revoked | ConnectError::InvalidToken) => {
                let _ = self.mark_revoked_inner();
                return false;
            }
            Err(err) => {
                self.note_unreachable(&err);
                return false;
            }
        }
        if let Err(err) = self.update_state(|state| {
            clear_bound_fields(state);
            state["state"] = json!("bound");
            state["bound"] = json!(true);
            state["paired"] = json!(true);
            state["backup_unlocked"] = json!(false);
        }) {
            // The refreshed credential is still useful. Keep it and the stale
            // state so the next boot/poll retries this reconciliation.
            self.set_rejected(true);
            self.note_unreachable(&err);
            return false;
        }
        self.set_rejected(false);
        self.clear_unreachable();
        true
    }

    fn refresh_due(&self, reconnect: bool) -> bool {
        if reconnect {
            return true;
        }
        let last = self
            .auth
            .last_refresh
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let after = self
            .auth
            .refresh_after
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        last.is_none_or(|at| at.elapsed() >= *after)
    }

    /// Verify and consume a one-time remote first-Admin grant before Luna
    /// creates the account. UID, code, and rolling credential are not proof.
    pub fn consume_setup_grant(&self, setup_grant: &str) -> Result<(), ConnectError> {
        let grant = setup_grant.trim();
        if grant.is_empty() {
            return Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()));
        }
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.unbind_pending() || !self.is_connect_active() {
            return Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()));
        }
        let mut token = self.auth_token()?;
        let body = Some(json!({ "setup_grant": grant }));
        let mut reply = self.call_json_status_within(
            "POST",
            "/api/v1/devices/setup-grant/consume",
            Some(&token),
            body.clone(),
            CONNECT_HTTP_TIMEOUT,
        );
        if matches!(&reply, Err(ConnectError::InvalidToken)) {
            match self.refresh_credential_inner(true) {
                Ok(()) => {
                    token = self.auth_token()?;
                    reply = self.call_json_status_within(
                        "POST",
                        "/api/v1/devices/setup-grant/consume",
                        Some(&token),
                        body,
                        CONNECT_HTTP_TIMEOUT,
                    );
                }
                Err(_) => return Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into())),
            }
        }
        match reply {
            Ok(_) => Ok(()),
            Err(ConnectError::InvalidToken) => {
                Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()))
            }
            Err(ConnectError::Revoked) => {
                let _ = self.mark_revoked_inner();
                Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()))
            }
            Err(ConnectError::Unbound) => {
                let _ = self.clear_to_unbound_inner();
                Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()))
            }
            Err(ConnectError::Unreachable | ConnectError::GatewayChallenge) => {
                Err(ConnectError::Unreachable)
            }
            Err(other) => Err(other),
        }
    }

    /// Revoke first, then forget the credential. Every failure path retains
    /// enough to retry and blocks both remote access and pairing.
    pub fn unbind_now(&self) -> Result<(), ConnectError> {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.unbind_now_inner()
    }

    fn unbind_now_inner(&self) -> Result<(), ConnectError> {
        if !self.can_unbind() {
            return Err(ConnectError::Other(
                "This Luna isn't linked to Luna Connect.".into(),
            ));
        }
        // A completed remote transition may have crashed before local cleanup.
        // Its marker records the answer, so no second network request is needed.
        match self.pending_resolution() {
            Some(ConnectState::Unbound) => return self.clear_to_unbound_inner(),
            Some(ConnectState::Revoked) => return self.mark_revoked_inner(),
            _ => {}
        }
        let mut token = match self.auth_token() {
            Ok(token) => token,
            Err(_)
                if self.connect_state(&self.load(), false) == ConnectState::Pairing
                    && self.has_pairing_material() =>
            {
                self.stop_tunnel();
                self.cancel_pairing_claim()?;
                return self.finish_local_auth_state(ConnectState::Unbound);
            }
            Err(err) => return Err(err),
        };
        if !self.unbind_pending() {
            self.mark_unbind_pending_inner(&token)?;
        }
        // The marker is durable before the tunnel stops and before any network
        // call. A crash can therefore never leave an unmarked old connector.
        self.stop_tunnel();
        match self.call_json_status_within(
            "POST",
            "/api/v1/unregister",
            Some(&token),
            None,
            UNBIND_TIMEOUT,
        ) {
            Ok(_) | Err(ConnectError::Unbound) => self.clear_to_unbound_inner(),
            Err(ConnectError::Revoked) => {
                self.mark_revoked_inner()?;
                Err(ConnectError::Revoked)
            }
            Err(ConnectError::InvalidToken) => {
                // A normal route rejects the previous credential immediately
                // after rotation. Refresh is the sole overlap route; recover
                // once and retry, but never call a generic 401 an unbind.
                match self.refresh_credential_inner_mode(true, RefreshMode::Unbind) {
                    Ok(()) => {
                        token = self.auth_token()?;
                        self.mark_unbind_pending_inner(&token)?;
                        match self.call_json_status_within(
                            "POST",
                            "/api/v1/unregister",
                            Some(&token),
                            None,
                            UNBIND_TIMEOUT,
                        ) {
                            Ok(_) | Err(ConnectError::Unbound) => self.clear_to_unbound_inner(),
                            Err(ConnectError::Revoked) => {
                                self.mark_revoked_inner()?;
                                Err(ConnectError::Revoked)
                            }
                            Err(err @ ConnectError::InvalidToken) => {
                                self.note_unreachable(&err);
                                Err(err)
                            }
                            Err(err) => {
                                self.note_unreachable(&err);
                                Err(err)
                            }
                        }
                    }
                    Err(ConnectError::Unbound) => self.clear_to_unbound_inner(),
                    Err(ConnectError::Revoked) => {
                        self.mark_revoked_inner()?;
                        Err(ConnectError::Revoked)
                    }
                    Err(err) => {
                        // Unknown/invalid refresh leaves the credential and
                        // marker intact. Remote access and pairing stay blocked.
                        self.note_unreachable(&err);
                        Err(err)
                    }
                }
            }
            Err(err) => {
                self.note_unreachable(&err);
                Err(err)
            }
        }
    }

    pub fn mark_unbind_pending(&self) -> Result<(), ConnectError> {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let token = self.auth_token()?;
        self.mark_unbind_pending_inner(&token)
    }

    fn mark_unbind_pending_inner(&self, token: &str) -> Result<(), ConnectError> {
        self.write_pending_marker(Some(token), None)
    }

    fn write_pending_marker(
        &self,
        token: Option<&str>,
        resolution: Option<ConnectState>,
    ) -> Result<(), ConnectError> {
        if self.unbind_pending() && self.pending_resolution() == resolution {
            return Ok(());
        }
        let mut marker = json!({
            "device_uid": self.device_uid().ok(),
            "credential_fingerprint": token.map(credential_fingerprint),
        });
        if let Some(resolution) = resolution {
            marker["resolution"] = json!(match resolution {
                ConnectState::Unbound => "unbound",
                ConnectState::Revoked => "revoked",
                ConnectState::Bound | ConnectState::Pairing => unreachable!(),
            });
        }
        let bytes = serde_json::to_vec(&marker).map_err(|_| {
            ConnectError::Other(
                "Luna couldn't save that Luna Connect still needs disconnecting. Try again.".into(),
            )
        })?;
        write_private_file(&self.auth.unbind_pending_path, &bytes)?;
        self.stop_tunnel();
        Ok(())
    }

    fn pending_resolution(&self) -> Option<ConnectState> {
        let raw = std::fs::read(&self.auth.unbind_pending_path).ok()?;
        let marker: Value = serde_json::from_slice(&raw).ok()?;
        match marker.get("resolution").and_then(|v| v.as_str())? {
            "unbound" => Some(ConnectState::Unbound),
            "revoked" => Some(ConnectState::Revoked),
            _ => None,
        }
    }

    pub fn unbind_pending(&self) -> bool {
        self.auth.unbind_pending_path.exists()
    }

    /// Factory reset's explicit Connect choice. Keep leaves the credential and
    /// bound configuration untouched. Disconnect succeeds only after Connect
    /// has confirmed the answer and the credential/pending marker are gone.
    pub fn prepare_factory_reset(&self, disconnect: bool) -> Result<(), ConnectError> {
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !disconnect {
            if self.unbind_pending() {
                return Err(ConnectError::Other(UNBIND_PENDING_MSG.into()));
            }
            return Ok(());
        }
        let result = if self.can_unbind() {
            self.unbind_now_inner()
        } else if self.auth_state_settled() {
            Ok(())
        } else {
            Err(ConnectError::Other(
                "Luna couldn't confirm whether this Luna is still linked to Luna Connect. Try disconnecting again.".into(),
            ))
        };
        if self.auth_state_settled() {
            Ok(())
        } else {
            result.map_err(|err| {
                if self.unbind_pending() {
                    ConnectError::Other(UNBIND_PENDING_MSG.into())
                } else {
                    err
                }
            })
        }
    }

    fn auth_state_settled(&self) -> bool {
        !self.unbind_pending()
            && !self.auth.credential_path.exists()
            && matches!(
                self.connect_state(&self.load(), false),
                ConnectState::Unbound | ConnectState::Revoked
            )
    }

    fn clear_to_unbound_inner(&self) -> Result<(), ConnectError> {
        if self.auth.credential_path.exists() {
            let token = self.auth_token().ok();
            self.write_pending_marker(token.as_deref(), Some(ConnectState::Unbound))?;
        }
        self.finish_local_auth_state(ConnectState::Unbound)
    }

    fn mark_revoked_inner(&self) -> Result<(), ConnectError> {
        self.set_rejected(true);
        if self.auth.credential_path.exists() {
            let token = self.auth_token().ok();
            self.write_pending_marker(token.as_deref(), Some(ConnectState::Revoked))?;
        }
        self.finish_local_auth_state(ConnectState::Revoked)
    }

    /// Persist the non-bound answer before touching either secret. The pending
    /// marker is removed first: a crash can then leave a harmless credential
    /// beside stale state (which startup reconciles), never pending-without-
    /// credential or stale-bound-without-credential.
    fn finish_local_auth_state(&self, state: ConnectState) -> Result<(), ConnectError> {
        self.stop_tunnel();
        self.update_state(|saved| {
            clear_bound_fields(saved);
            match state {
                ConnectState::Unbound => {
                    saved["state"] = json!("unbound");
                    saved["bound"] = json!(false);
                    saved["paired"] = json!(false);
                }
                ConnectState::Revoked => {
                    saved["state"] = json!("revoked");
                    saved["bound"] = json!(false);
                    saved["paired"] = json!(false);
                }
                ConnectState::Bound | ConnectState::Pairing => unreachable!(),
            }
        })?;
        remove_file_durable(&self.auth.unbind_pending_path)?;
        remove_file_durable(&self.auth.credential_path)?;
        *self.cached_wan_ip.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.set_rejected(state == ConnectState::Revoked);
        self.clear_unreachable();
        *self
            .auth
            .pairing_error
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .auth
            .last_refresh
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.clear_tunnel_error();
        Ok(())
    }

    pub fn sync_status_from_cloud(&self) {
        let _ = self.poll_status();
    }

    /// Settle an explicit binding response from a request outside the poll
    /// operation. A stale reply for a rotated credential must not undo a newer
    /// pairing, so the credential is checked again under the operation lock.
    pub(crate) fn settle_explicit_auth_failure(&self, token: &str, err: &ConnectError) {
        if !matches!(err, ConnectError::Unbound | ConnectError::Revoked) {
            return;
        }
        let _operation = self
            .auth
            .operation_mu
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.auth_token().ok().as_deref() != Some(token) {
            return;
        }
        let settled = match err {
            ConnectError::Unbound => self.clear_to_unbound_inner(),
            ConnectError::Revoked => self.mark_revoked_inner(),
            _ => return,
        };
        if let Err(error) = settled {
            tracing::warn!(error = ?error, "could not persist Luna Connect's authentication answer");
        }
    }

    /// The rolling bearer credential. It is never returned by an HTTP API.
    /// Pending, revoked, and unbound states cannot authorize normal work.
    pub fn token(&self) -> Result<String, ConnectError> {
        if self.unbind_pending() {
            return Err(ConnectError::InvalidToken);
        }
        if !self.is_connect_active() {
            return Err(ConnectError::Unbound);
        }
        self.auth_token()
    }

    fn auth_token(&self) -> Result<String, ConnectError> {
        read_trimmed(&self.auth.credential_path)
            .filter(|token| is_auth_token_format(token))
            .ok_or_else(|| ConnectError::Other(CREDENTIAL_MALFORMED_MSG.into()))
    }

    fn connect_state(&self, state: &Value, credential_valid: bool) -> ConnectState {
        // The credential is issued only after Connect has bound the device. It
        // wins over stale saved state because claim writes it before the state
        // file; unbind deletes it only after saving unbound/revoked. A stale
        // credential beside a settled state is reconciled with Connect rather
        // than looping pairing or trusting the old state.
        if credential_valid {
            return ConnectState::Bound;
        }
        match state.get("state").and_then(|v| v.as_str()) {
            Some("unbound") => ConnectState::Unbound,
            Some("pairing") => ConnectState::Pairing,
            Some("revoked") => ConnectState::Revoked,
            Some("bound") => ConnectState::Bound,
            _ if state.get("bound").and_then(|v| v.as_bool()) == Some(true) => ConnectState::Bound,
            _ => ConnectState::Unbound,
        }
    }

    fn rejected(&self) -> bool {
        *self.auth.rejected.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_rejected(&self, rejected: bool) {
        *self.auth.rejected.lock().unwrap_or_else(|e| e.into_inner()) = rejected;
    }

    fn unreachable_message(&self) -> Option<&'static str> {
        if !self.poll_needed() {
            return None;
        }
        *self
            .auth
            .unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn clear_unreachable(&self) {
        *self
            .auth
            .unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn note_unreachable(&self, err: &ConnectError) {
        let message = match err {
            ConnectError::GatewayChallenge => CONNECT_CHALLENGED_MSG,
            ConnectError::NoPairing
            | ConnectError::PairingRejected
            | ConnectError::InvalidToken
            | ConnectError::Revoked
            | ConnectError::Unbound => return,
            _ => CONNECT_UNREACHABLE_MSG,
        };
        *self
            .auth
            .unreachable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(message);
    }

    fn pairing_error(&self) -> Option<String> {
        self.auth
            .pairing_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn tunnel_error_message(&self) -> Option<String> {
        if !self.is_connect_active() || self.unbind_pending() {
            return None;
        }
        self.tunnel_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub(super) fn set_tunnel_error(&self, message: &'static str) {
        *self.tunnel_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message.to_string());
    }

    pub(super) fn clear_tunnel_error(&self) {
        *self.tunnel_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn call_device_status(&self, token: &str) -> Result<Value, ConnectError> {
        self.call_json_status_within(
            "GET",
            "/api/v1/status",
            Some(token),
            None,
            CONNECT_HTTP_TIMEOUT,
        )
    }

    fn call_json_status_within(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, ConnectError> {
        let connect_timeout = timeout.min(CONNECT_HTTP_CONNECT_TIMEOUT);
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let auth = key.map(|k| format!("Bearer {k}"));
        let result = match (method, body) {
            ("GET", _) => {
                let mut req = ureq::get(&url)
                    .config()
                    .http_status_as_error(false)
                    .timeout_global(Some(timeout))
                    .timeout_connect(Some(connect_timeout))
                    .build();
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                if path == "/api/v1/status" && self.local_port > 0 {
                    req = req.header("X-Luna-Local-Port", self.local_port.to_string());
                }
                req.call()
            }
            ("POST", Some(body)) => {
                let mut req = ureq::post(&url)
                    .config()
                    .http_status_as_error(false)
                    .timeout_global(Some(timeout))
                    .timeout_connect(Some(connect_timeout))
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
                    .timeout_global(Some(timeout))
                    .timeout_connect(Some(connect_timeout))
                    .build();
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                req.send(&[] as &[u8])
            }
            _ => return Err(ConnectError::Other("unsupported method".into())),
        };
        let mut response = match result {
            Ok(response) => response,
            Err(err) => return Err(map_transport_error(err)),
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
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_REPLY_BYTES)
            .read_to_string()
            .unwrap_or_default();
        if path == "/api/v1/devices/setup-grant/consume" && matches!(status, 400 | 404) {
            return Err(ConnectError::Other(SETUP_GRANT_REJECTED_MSG.into()));
        }
        if path == "/api/v1/devices/pair/claim" {
            if matches!(status, 404 | 409) {
                return Err(ConnectError::NoPairing);
            }
            if matches!(status, 400 | 401 | 403 | 429) {
                if super::looks_like_cf_challenge(
                    status,
                    &content_type,
                    &body,
                    cf_mitigated.as_deref(),
                ) {
                    return Err(ConnectError::GatewayChallenge);
                }
                return Err(ConnectError::PairingRejected);
            }
        }
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
            return Err(map_transport_error(ureq::Error::StatusCode(status)));
        }
        if body.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&body).map_err(|_| {
            ConnectError::Other(
                "Luna Connect answered, but Luna could not use the reply. Luna will try again."
                    .into(),
            )
        })
    }

    pub(super) fn load(&self) -> Value {
        let _state = self.auth.state_mu.lock().unwrap_or_else(|e| e.into_inner());
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Value {
        let Ok(bytes) = std::fs::read(&self.state_path) else {
            return json!({ "base_url": self.base_url });
        };
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            return json!({ "base_url": self.base_url });
        };
        if !value.is_object() {
            return json!({ "base_url": self.base_url });
        }
        if let Some(object) = value.as_object_mut() {
            // Hard cut: no permanent-token or first-user-secret state is read
            // or carried forward, even if an old file is still present.
            object.remove("device_token");
            object.remove("setup_secret");
            object.remove("first_user_secret");
        }
        value
    }

    pub(crate) fn save(&self, state: &Value) -> Result<(), ConnectError> {
        let _state = self.auth.state_mu.lock().unwrap_or_else(|e| e.into_inner());
        self.save_unlocked(state)
    }

    fn save_unlocked(&self, state: &Value) -> Result<(), ConnectError> {
        let mut clean = state.clone();
        if let Some(object) = clean.as_object_mut() {
            object.remove("device_token");
            object.remove("setup_secret");
            object.remove("first_user_secret");
        }
        let bytes = serde_json::to_vec(&clean).map_err(|_| {
            ConnectError::Other("Luna couldn't save its Luna Connect settings. Try again.".into())
        })?;
        write_private_file(&self.state_path, &bytes)
    }

    /// One read-modify-write under the Connect state lock. Status, backup
    /// payment state, pairing, and revocation all use this so a slower writer
    /// cannot restore a field that a newer transition removed.
    pub(super) fn update_state(&self, update: impl FnOnce(&mut Value)) -> Result<(), ConnectError> {
        let _state = self.auth.state_mu.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = self.load_unlocked();
        update(&mut state);
        self.save_unlocked(&state)
    }
}

fn apply_remote_status(state: &mut Value, remote: &Value) {
    for key in ["hostname", "subdomain", "tunnel_token", "backup_sources"] {
        if let Some(value) = remote.get(key) {
            state[key] = value.clone();
        }
    }
    state["backup_unlocked"] = json!(
        remote
            .get("backup_unlocked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    );
    if let Some(ip) = remote.get("wan_ip").and_then(|v| v.as_str()) {
        state["wan_ip"] = json!(ip.trim());
    }
}

fn clear_bound_fields(state: &mut Value) {
    for key in [
        "hostname",
        "domain",
        "subdomain",
        "tunnel_token",
        "tunnel_active",
        "device_id",
        "wan_ip",
        "backup_unlocked",
        "backup_sources",
        "first_user_secret",
        "setup_secret",
        "device_token",
    ] {
        state.as_object_mut().map(|object| object.remove(key));
    }
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), ConnectError> {
    let write = || -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
            crate::datadir::sync_parent_directory(path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    };
    write().map_err(|_| {
        ConnectError::Other("Luna couldn't save its Luna Connect settings. Try again.".into())
    })
}

fn remove_file_durable(path: &Path) -> Result<(), ConnectError> {
    let remove = || -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        }
        crate::datadir::sync_parent_directory(path)
    };
    remove().map_err(|_| {
        ConnectError::Other(
            "Luna couldn't finish saving its Luna Connect settings. Try again.".into(),
        )
    })
}

fn credential_fingerprint(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

/// Crockford base32 without I, L, O, U.
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub(crate) fn normalize_device_uid(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if matches!(c, '-' | ' ' | '_') {
            continue;
        }
        let c = c.to_ascii_uppercase();
        out.push(match c {
            'I' | 'L' => '1',
            'O' => '0',
            _ => c,
        });
    }
    out
}

pub(crate) fn is_device_uid_format(uid: &str) -> bool {
    uid.len() == 20 && uid.bytes().all(|b| CROCKFORD.contains(&b))
}

pub(crate) fn group_device_uid(uid: &str) -> String {
    uid.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

pub(crate) fn normalize_verification_code(raw: &str) -> String {
    raw.trim().to_ascii_uppercase()
}

pub(crate) fn is_verification_code_format(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn is_auth_token_format(token: &str) -> bool {
    if token.is_empty() || token.contains('=') {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(token)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == token)
}

#[cfg(test)]
pub fn is_idle(last_io_unix: i64, now_unix: i64) -> bool {
    now_unix.saturating_sub(last_io_unix) >= 30
}

pub fn detect_public_ip_fallback() -> Option<std::net::IpAddr> {
    if cfg!(test) {
        return None;
    }
    const URLS: &[&str] = &["https://api64.ipify.org", "https://icanhazip.com"];
    for url in URLS {
        let resp = ureq::get(*url)
            .config()
            .timeout_global(Some(Duration::from_secs(3)))
            .timeout_connect(Some(Duration::from_secs(2)))
            .build()
            .call();
        if let Ok(mut response) = resp
            && let Ok(text) = response
                .body_mut()
                .with_config()
                .limit(MAX_REPLY_BYTES)
                .read_to_string()
            && let Ok(ip) = text.trim().parse::<std::net::IpAddr>()
        {
            return Some(ip);
        }
    }
    None
}
