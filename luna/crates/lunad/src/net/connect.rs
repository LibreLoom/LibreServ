//! Luna Connect client: device pairing, rolling credentials, status, and cloudflared.

// Extracted on-demand installer (pinned release / HTTPS / ELF). Keep this file from
// growing when the install path is hardened — see cloudflared_install.rs.
#[path = "cloudflared_install.rs"]
mod cloudflared_install;
use cloudflared_install::{MIN_CLOUDFLARED_BYTES, install_cloudflared_to};

#[path = "connect_auth.rs"]
mod auth;
pub use auth::{
    CONNECT_CREDENTIAL_FILE, CREDENTIAL_MALFORMED_MSG, CREDENTIAL_REJECTED_MSG, ConnectError,
    ConnectService, ConnectState, ConnectStatus, DEVICE_TOKEN_FILE, DEVICE_TOKEN_MALFORMED_MSG,
    DISCONNECT_FIRST_MSG, LAN_OVERRIDE_FILE, UNBIND_PENDING_FILE, UNBIND_PENDING_MSG,
};
pub(crate) use auth::{is_device_token_format, normalize_device_token};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub(crate) const DEFAULT_CONNECT_URL: &str = "https://connect.luna.libreloom.org";
pub const STEADY_POLL_SECS: u64 = 300;
pub const AGGRESSIVE_POLL_SECS: u64 = 10;

#[cfg(not(test))]
const CONNECT_HTTP_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const CONNECT_HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const CONNECT_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REPLY_BYTES: u64 = 4 * 1024 * 1024;

#[cfg(not(test))]
pub const UNBIND_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
pub const UNBIND_TIMEOUT: Duration = Duration::from_secs(2);

pub const CONNECT_UNREACHABLE_MSG: &str = "Luna can't reach Luna Connect, or Luna Connect has a problem. Check this Luna's internet connection. Luna will keep trying.";
pub const CONNECT_CHALLENGED_MSG: &str =
    "Luna Connect blocked a request from this Luna. Luna will keep trying.";
pub const TUNNEL_HELPER_MISSING_MSG: &str = "Luna could not download the remote access helper. Check this Luna's internet connection. Luna will keep trying.";
pub const TUNNEL_START_FAILED_MSG: &str =
    "Luna could not start remote access. Luna will keep trying.";
pub const TUNNEL_TOKEN_MISSING_MSG: &str = "A remote address is set, but Luna does not have a connection key from Luna Connect yet. Luna will keep trying.";
pub const TUNNEL_NOT_RUNNING_MSG: &str =
    "Remote access is set up, but it is not running yet. Luna will keep trying.";

pub const CLOUD_BACKUP_NOT_LINKED: &str = "not_linked";
pub const CLOUD_BACKUP_NO_PAYMENT: &str = "no_payment";
pub const CLOUD_BACKUP_READY: &str = "ready";

/// Cuts the Connect poll loop's wait short. A reconnect wake also asks the
/// next cycle to rotate the credential before normal status work.
#[derive(Default)]
pub struct PollWake {
    woken: Mutex<bool>,
    reconnect: AtomicBool,
    cv: std::sync::Condvar,
}

impl PollWake {
    pub fn wake(&self) {
        *self.woken.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    pub fn wake_reconnect(&self) {
        self.reconnect.store(true, Ordering::Release);
        self.wake();
    }

    pub fn take_reconnect(&self) -> bool {
        self.reconnect.swap(false, Ordering::AcqRel)
    }

    pub fn is_set(&self) -> bool {
        *self.woken.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn wait_forever(&self) {
        let guard = self.woken.lock().unwrap_or_else(|e| e.into_inner());
        let mut woken = self
            .cv
            .wait_while(guard, |w| !*w)
            .unwrap_or_else(|e| e.into_inner());
        *woken = false;
    }

    pub fn wait(&self, timeout: Duration) -> bool {
        let guard = self.woken.lock().unwrap_or_else(|e| e.into_inner());
        let (mut woken, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |w| !*w)
            .unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *woken)
    }
}

impl ConnectService {
    /// Streams the body — pass `&[u8]` for small objects or `&File` for files
    /// so multi-MiB backup objects never sit in RAM whole.
    pub fn put_backup_object(
        &self,
        rel: &str,
        body: impl ureq::AsSendBody,
    ) -> Result<(), ConnectError> {
        let token = self.token()?;
        let url = format!(
            "{}/api/v1/backup/objects/{}",
            self.base_url.trim_end_matches('/'),
            encode_object_key(rel.trim_start_matches('/'))
        );
        let mut response = ureq::put(&url)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(CONNECT_HTTP_TIMEOUT))
            .timeout_connect(Some(CONNECT_HTTP_CONNECT_TIMEOUT))
            .build()
            .header("Authorization", format!("Bearer {token}"))
            .send(body)
            .map_err(map_transport_error)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let content_type = header("content-type").unwrap_or_default();
        let cf_mitigated = header("cf-mitigated");
        let body_text = response
            .body_mut()
            .with_config()
            .limit(MAX_REPLY_BYTES)
            .read_to_string()
            .unwrap_or_default();
        let err = classify_backup_reply(status, &content_type, &body_text, cf_mitigated.as_deref());
        self.settle_explicit_auth_failure(&token, &err);
        Err(err)
    }

    /// Registers this Luna's signing public key (64 hex characters) with
    /// Connect (`POST /api/v1/storage/luna-ids/{id}/signing-public`).
    pub fn register_signing_public(
        &self,
        luna_id: &str,
        public_hex: &str,
    ) -> Result<(), ConnectError> {
        let token = self.token()?;
        let url = format!(
            "{}/api/v1/storage/luna-ids/{}/signing-public",
            self.base_url.trim_end_matches('/'),
            luna_id
        );
        let mut response = ureq::post(&url)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(CONNECT_HTTP_TIMEOUT))
            .timeout_connect(Some(CONNECT_HTTP_CONNECT_TIMEOUT))
            .build()
            .header("Authorization", format!("Bearer {token}"))
            .send(public_hex.as_bytes())
            .map_err(map_transport_error)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
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
        let body_text = response
            .body_mut()
            .with_config()
            .limit(MAX_REPLY_BYTES)
            .read_to_string()
            .unwrap_or_default();
        let err = match status {
            401 => ConnectError::InvalidToken,
            403 => classify_403(status, &content_type, &body_text, cf_mitigated.as_deref()),
            _ => map_transport_error(ureq::Error::StatusCode(status)),
        };
        self.settle_explicit_auth_failure(&token, &err);
        Err(err)
    }

    pub fn delete_backup_object(&self, rel: &str) -> Result<(), ConnectError> {
        let token = self.token()?;
        let url = format!(
            "{}/api/v1/backup/objects/{}",
            self.base_url.trim_end_matches('/'),
            encode_object_key(rel.trim_start_matches('/'))
        );
        let mut response = ureq::delete(&url)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(CONNECT_HTTP_TIMEOUT))
            .timeout_connect(Some(CONNECT_HTTP_CONNECT_TIMEOUT))
            .build()
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(map_transport_error)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
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
        let err = classify_backup_reply(status, &content_type, &body, cf_mitigated.as_deref());
        self.settle_explicit_auth_failure(&token, &err);
        Err(err)
    }

    pub fn backup_unlocked(&self) -> bool {
        self.load()
            .get("backup_unlocked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// Record that Luna Connect refused to store a cloud copy for a missing payment card, so
    /// the UI says so before the next status pull confirms it.
    pub fn mark_backup_locked(&self) {
        if let Err(err) = self.update_state(|state| {
            if state.get("backup_unlocked").and_then(|v| v.as_bool()) == Some(false) {
                return;
            }
            state["backup_unlocked"] = json!(false);
        }) {
            tracing::warn!(error = ?err, "could not record that cloud backup needs a payment card");
        }
    }

    fn ensure_tunnel(&self) -> Result<(), ConnectError> {
        // The state check belongs under the same lock as process start/stop.
        // Otherwise a supervisor can pass the check before an unbind, wait for
        // this lock, and start the old account's tunnel after revocation.
        let _guard = self.tunnel_mu.lock().unwrap_or_else(|e| e.into_inner());
        // No tunnel without a currently bound credential, or while an unbind is
        // owed: the old account's address must not come back.
        if !self.is_connect_active() || self.unbind_pending() {
            self.stop_tunnel_unlocked();
            return Err(ConnectError::Other(
                "Luna is still disconnecting from Luna Connect.".into(),
            ));
        }
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
                    "Connect assigned a hostname but no tunnel token is on disk — cloudflared cannot start"
                );
                self.set_tunnel_error(TUNNEL_TOKEN_MISSING_MSG);
            }
            return Ok(());
        }
        if token.starts_with("mock-") {
            self.clear_tunnel_error();
            let mut state = self.load();
            state["tunnel_active"] = json!(true);
            return self.save(&state);
        }

        if self.tunnel_running_with_token(&token) {
            self.clear_tunnel_error();
            return Ok(());
        }
        self.stop_tunnel_unlocked();

        let data_dir = self
            .state_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let local = data_dir.join("bin").join("cloudflared");
        // Reap connectors left behind when a prior lunad lost its Child handle
        // (hard kill / race). Without this, remote access stays up while
        // tunnel_active stays false and HDMI complains.
        reap_stale_cloudflared(&cloudflared_candidate_paths(&local));

        let bin = self.resolve_or_install_cloudflared()?;
        // Installation can take a while. An unbind may have made its marker
        // durable while this start was waiting for the helper.
        if !self.is_connect_active() || self.unbind_pending() {
            self.stop_tunnel_unlocked();
            return Err(ConnectError::Other(
                "Luna is still disconnecting from Luna Connect.".into(),
            ));
        }

        // Token mode: no config.yml and no OpenRC/systemd unit. The token goes
        // only in env — argv is world-readable through /proc/*/cmdline.
        tracing::info!(
            path = %bin.display(),
            port = self.local_port,
            hostname,
            "starting cloudflared tunnel (token mode, managed by lunad)"
        );

        let mut child = Command::new(&bin)
            .args(["tunnel", "--no-autoupdate", "run"])
            .env("TUNNEL_TOKEN", &token)
            .env("CLOUDFLARED_TUNNEL_TOKEN", &token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                tracing::error!(path = %bin.display(), error = %e, "cloudflared spawn failed");
                self.set_tunnel_error(TUNNEL_START_FAILED_MSG);
                ConnectError::Other(TUNNEL_START_FAILED_MSG.into())
            })?;

        if let Some(stderr) = child.stderr.take() {
            std::thread::Builder::new()
                .name("cloudflared-log".into())
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        tracing::warn!(target: "cloudflared", "{trimmed}");
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
                self.set_tunnel_error(TUNNEL_START_FAILED_MSG);
                return Err(ConnectError::Other(TUNNEL_START_FAILED_MSG.into()));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "could not check cloudflared child status");
            }
        }

        // The unbind path writes its durable marker before waiting for this
        // lock. Do not publish a child that has already been revoked; the
        // unbind thread will reap any process still alive after we release.
        if !self.is_connect_active() || self.unbind_pending() {
            let _ = child.kill();
            let _ = child.wait();
            self.stop_tunnel_unlocked();
            return Err(ConnectError::Other(
                "Luna is still disconnecting from Luna Connect.".into(),
            ));
        }

        self.clear_tunnel_error();
        *self.active_tunnel_token.lock().unwrap() = Some(token);
        // Wake the poll loop when this child exits, so it restarts the tunnel
        // without polling the child every few seconds.
        static WATCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = WATCHES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (watch, exited, wake) = (
            self.tunnel_watch.clone(),
            self.tunnel_exited.clone(),
            self.poll_wake.clone(),
        );
        self.tunnel_watch
            .store(id, std::sync::atomic::Ordering::Release);
        let watched = watch_child_exit(child.id(), move || {
            // Still the current child: it died by itself. A child Luna
            // stopped or replaced has a cleared or newer watch number.
            let current = watch
                .compare_exchange(
                    id,
                    0,
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire,
                )
                .is_ok();
            if current {
                exited.store(true, std::sync::atomic::Ordering::Release);
                wake.wake();
            }
        });
        if !watched {
            self.tunnel_watch
                .store(0, std::sync::atomic::Ordering::Release);
        }
        if let Some(mut old) = self.child.lock().unwrap().replace(child) {
            let _ = old.kill();
            let _ = old.wait();
        }
        Ok(())
    }

    /// Resolve a runnable cloudflared.
    ///
    /// On a Luna OS box it is baked into the image at /usr/local/bin, so the
    /// lookup always finds it. The download fallback exists for dev runs on a
    /// normal machine; on the appliance it is refused, because nothing
    /// executable belongs on the data partition.
    fn resolve_or_install_cloudflared(&self) -> Result<PathBuf, ConnectError> {
        let data_dir = self
            .state_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let local = data_dir.join("bin").join("cloudflared");
        for candidate in cloudflared_candidate_paths(&local) {
            if on_luna_os() && candidate == local {
                continue;
            }
            if cloudflared_looks_runnable(&candidate) {
                return Ok(candidate);
            }
        }
        if on_luna_os() {
            tracing::error!("no cloudflared in the OS image: this Luna cannot start a tunnel");
            self.set_tunnel_error(TUNNEL_HELPER_MISSING_MSG);
            return Err(ConnectError::Other(TUNNEL_HELPER_MISSING_MSG.into()));
        }
        if let Err(e) = install_cloudflared_to(&local) {
            tracing::error!(error = %e, path = %local.display(), "cloudflared install failed");
            self.set_tunnel_error(TUNNEL_HELPER_MISSING_MSG);
            return Err(ConnectError::Other(TUNNEL_HELPER_MISSING_MSG.into()));
        }
        if cloudflared_looks_runnable(&local) {
            return Ok(local);
        }
        self.set_tunnel_error(TUNNEL_HELPER_MISSING_MSG);
        Err(ConnectError::Other(TUNNEL_HELPER_MISSING_MSG.into()))
    }

    /// Whether a managed connector or an orphan from an earlier lunad is
    /// alive. Status uses this so HDMI does not report a false failure after a
    /// hard restart; startup/supervision still reaps orphans before replacing
    /// them with a connector whose token this process owns.
    pub(super) fn tunnel_running(&self) -> bool {
        let _guard = self.tunnel_mu.lock().unwrap_or_else(|e| e.into_inner());
        if self.managed_tunnel_running() {
            return true;
        }
        let data_dir = self
            .state_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let local = data_dir.join("bin").join("cloudflared");
        external_cloudflared_running(&cloudflared_candidate_paths(&local))
    }

    fn managed_tunnel_running(&self) -> bool {
        let mut g = self.child.lock().unwrap();
        if let Some(child) = g.as_mut() {
            match child.try_wait() {
                Ok(None) => return true,
                Ok(Some(_)) | Err(_) => *g = None,
            }
        }
        false
    }

    fn tunnel_running_with_token(&self, token: &str) -> bool {
        let mut g = self.child.lock().unwrap();
        if let Some(child) = g.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    let active = self.active_tunnel_token.lock().unwrap();
                    return active.as_deref() == Some(token);
                }
                Ok(Some(_)) | Err(_) => *g = None,
            }
        }
        false
    }

    /// Kill the managed cloudflared child (and reap orphans) — pairing off,
    /// token revoke, and graceful shutdown all land here.
    pub fn stop_tunnel(&self) {
        let _guard = self.tunnel_mu.lock().unwrap_or_else(|e| e.into_inner());
        self.stop_tunnel_unlocked();
    }

    fn stop_tunnel_unlocked(&self) {
        *self.active_tunnel_token.lock().unwrap() = None;
        self.tunnel_watch
            .store(0, std::sync::atomic::Ordering::Release);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let data_dir = self
            .state_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let local = data_dir.join("bin").join("cloudflared");
        // Pairing off / token revoke must also clear orphans, or remote access
        // stays up after Luna thinks Connect is gone.
        reap_stale_cloudflared(&cloudflared_candidate_paths(&local));
    }
}

/// Call `on_exit` from a new thread once process `pid` (a child not yet
/// reaped) exits. The thread sleeps in `poll` on a pidfd: no timer, and
/// reaping by `Child::wait` elsewhere is unaffected. False when the kernel
/// has no pidfd (before Linux 5.3); callers then keep polling.
pub(crate) fn watch_child_exit(pid: u32, on_exit: impl FnOnce() + Send + 'static) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        // SAFETY: pidfd_open takes a pid and flags and returns a new fd or -1.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if fd < 0 {
            return false;
        }
        // SAFETY: a fresh fd we own.
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        std::thread::Builder::new()
            .name("luna-tunnel-watch".into())
            .spawn(move || {
                let mut pfd = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                loop {
                    // SAFETY: one valid pollfd that outlives the call.
                    let n = unsafe { libc::poll(&mut pfd, 1, -1) };
                    if n >= 0
                        || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                    {
                        break;
                    }
                }
                drop(fd);
                on_exit();
            })
            .is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pid, on_exit);
        false
    }
}

fn map_transport_error(err: ureq::Error) -> ConnectError {
    match err {
        ureq::Error::StatusCode(401) => ConnectError::InvalidToken,
        ureq::Error::StatusCode(409) => ConnectError::Conflict,
        _ => ConnectError::Unreachable,
    }
}

/// `LUNA_CONNECT_URL` requests carry the device Bearer token — outside debug
/// builds the base must be https, or http to a host provably on this box or
/// LAN (mock-connect, tests, a dev Connect on the same network). Anything
/// else would ship the token unencrypted, so fall back to the default host.
fn sanitize_base_url(url: String) -> String {
    if cfg!(debug_assertions) || base_url_allowed(&url) {
        return url;
    }
    tracing::warn!(
        url,
        "refusing insecure LUNA_CONNECT_URL; using the default Connect host"
    );
    DEFAULT_CONNECT_URL.to_string()
}

/// The release-build rule for a Connect base URL: https always; http only to
/// loopback, a private/link-local literal, `localhost`, or a `.local` name.
fn base_url_allowed(url: &str) -> bool {
    let trimmed = url.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return true;
    }
    if !lower.starts_with("http://") {
        return false;
    }
    let authority = trimmed["http://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".local") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            v6.is_loopback()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_unspecified()
        }
        Err(_) => false,
    }
}

/// Percent-encode each object-key segment for the URL path — a `?`, `#`, or
/// `%` in a file name must not corrupt the request URI.
fn encode_object_key(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for seg in rel.split('/') {
        if !out.is_empty() {
            out.push('/');
        }
        for &b in seg.as_bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// True when this process booted from a Luna OS A/B slot. The image ships
/// cloudflared, so the appliance never downloads one.
fn on_luna_os() -> bool {
    crate::packs::on_luna_os()
        || std::fs::read_to_string("/proc/cmdline")
            .map(|c| c.split_whitespace().any(|t| t.starts_with("luna.slot=")))
            .unwrap_or(false)
}

fn cloudflared_candidate_paths(data_bin: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/local/bin/cloudflared"),
        PathBuf::from("/usr/bin/cloudflared"),
        PathBuf::from("/sbin/cloudflared"),
        data_bin.to_path_buf(),
    ]
}

/// True when a /proc cmdline belongs to a Luna-managed `cloudflared tunnel run`.
fn stale_cloudflared_cmdline(cmdline: &str, bin_path: &Path) -> bool {
    let flat = cmdline.replace('\0', " ");
    let marker = format!("{} tunnel --no-autoupdate run", bin_path.display());
    flat.contains(&marker)
}

/// PIDs of cloudflared tunnel processes started from one of `bin_paths`.
#[cfg(target_os = "linux")]
fn cloudflared_tunnel_pids(bin_paths: &[PathBuf]) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid_str) = name.to_str() else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<i32>() else {
            continue;
        };
        let cmdline_path = entry.path().join("cmdline");
        let Ok(raw) = std::fs::read(&cmdline_path) else {
            continue;
        };
        let cmdline = String::from_utf8_lossy(&raw);
        if bin_paths
            .iter()
            .any(|bin| stale_cloudflared_cmdline(&cmdline, bin))
        {
            pids.push(pid);
        }
    }
    pids
}

/// macOS/BSD variant: no `/proc`, so read the process table with `ps`.
/// A shebang script's cmdline still contains `<bin> tunnel --no-autoupdate run`
/// because the interpreter keeps the script path in argv.
#[cfg(not(target_os = "linux"))]
fn cloudflared_tunnel_pids(bin_paths: &[PathBuf]) -> Vec<i32> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,args="])
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut pids = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some((pid_str, cmdline)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<i32>() else {
            continue;
        };
        if bin_paths
            .iter()
            .any(|bin| stale_cloudflared_cmdline(cmdline, bin))
        {
            pids.push(pid);
        }
    }
    pids
}

fn external_cloudflared_running(bin_paths: &[PathBuf]) -> bool {
    !cloudflared_tunnel_pids(bin_paths).is_empty()
}

/// Send SIGINT to unmanaged cloudflared processes from our known binary paths.
///
/// A pid can be recycled between the scan and the kill, so each process's
/// start time is noted at scan time and checked again just before the signal.
fn reap_stale_cloudflared(bin_paths: &[PathBuf]) {
    let found: Vec<(i32, Option<u64>)> = cloudflared_tunnel_pids(bin_paths)
        .into_iter()
        .map(|pid| (pid, proc_start_time(pid)))
        .collect();
    for (pid, started) in found {
        if proc_start_time(pid) != started {
            tracing::info!(pid, "skipping cloudflared pid: the process changed");
            continue;
        }
        tracing::info!(pid, "reaping stale cloudflared tunnel process");
        let _ = nix_kill(pid);
    }
}

/// When the process started, in clock ticks since boot (`/proc/<pid>/stat`
/// field 22). `None` where there is no `/proc` or the process is gone.
fn proc_start_time(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat_start_time(&stat)
}

/// The command name in `stat` is parenthesised and may hold spaces or
/// parentheses, so fields are counted from the last `)`.
fn parse_stat_start_time(stat: &str) -> Option<u64> {
    let after_comm = stat.get(stat.rfind(')')? + 1..)?;
    // Fields after `)` start at field 3 (state), so field 22 is index 19.
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

fn nix_kill(pid: i32) -> std::io::Result<()> {
    // Avoid depending on the `nix` crate — libc kill is enough here.
    let rc = unsafe { libc::kill(pid, libc::SIGINT) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// True when `path` exists, is large enough to be a real binary, and `--version` exits 0.
fn cloudflared_looks_runnable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() < MIN_CLOUDFLARED_BYTES {
        return false;
    }
    Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Classify an HTTP 403 from Connect or a fronting gateway.
/// Only Connect's explicit machine codes may change the local binding. Generic
/// JSON errors and gateway blocks leave the existing binding in place.
fn classify_403(
    status: u16,
    content_type: &str,
    body: &str,
    cf_mitigated: Option<&str>,
) -> ConnectError {
    if looks_like_cf_challenge(status, content_type, body, cf_mitigated) {
        return ConnectError::GatewayChallenge;
    }
    if is_json_connect_body(content_type, body)
        && let Some(code) = serde_json::from_str::<Value>(body).ok().and_then(|value| {
            value
                .get("code")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
    {
        match code.as_str() {
            "device_unbound" => return ConnectError::Unbound,
            "device_revoked" => return ConnectError::Revoked,
            _ => {}
        }
    }
    ConnectError::Unreachable
}

/// A backup upload Connect refused. Its own 4xx messages (no payment card,
/// cloud backup full, file too large) are written for users, so they pass
/// through — the cloud backup status shows them as they are.
fn classify_backup_reply(
    status: u16,
    content_type: &str,
    body: &str,
    cf_mitigated: Option<&str>,
) -> ConnectError {
    if status == 401 {
        return ConnectError::InvalidToken;
    }
    if status == 403 {
        let err = classify_403(status, content_type, body, cf_mitigated);
        if !matches!(err, ConnectError::Unreachable) {
            return err;
        }
    }
    if looks_like_cf_challenge(status, content_type, body, cf_mitigated) {
        return ConnectError::GatewayChallenge;
    }
    if (400..500).contains(&status) && is_json_connect_body(content_type, body) {
        let message = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .filter(|m| !m.trim().is_empty());
        if let Some(message) = message {
            return ConnectError::Other(message);
        }
    }
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

#[cfg(test)]
#[path = "connect_tests.rs"]
mod tests;
