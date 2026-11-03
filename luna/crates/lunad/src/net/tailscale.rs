//! Product-managed Tailscale lifecycle. The node key lives beside Luna's data,
//! while the local API socket is private to lunad. No auth key is accepted here.
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// The managed node is a singleton per lunad process. Serializing lifecycle and
// status commands prevents a poll from unlinking a live socket during startup.
static LIFECYCLE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static OWNED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
fn owned() -> std::sync::MutexGuard<'static, HashSet<PathBuf>> {
    OWNED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
fn lifecycle() -> std::sync::MutexGuard<'static, HashSet<PathBuf>> {
    LIFECYCLE
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn cli() -> PathBuf {
    std::env::var_os("LUNA_TAILSCALE_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/local/bin/tailscale"))
}
fn daemon() -> PathBuf {
    std::env::var_os("LUNA_TAILSCALED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/local/bin/tailscaled"))
}

fn retire_failed_child(data: &Path, child: &mut std::process::Child) {
    let _ = child.kill();
    if child.wait().is_ok() && verify_socket_stopped(data).is_ok() {
        let _ = retire_launch(data);
    }
}
fn root(data: &Path) -> PathBuf {
    data.join("tailscale")
}
fn socket(data: &Path) -> PathBuf {
    root(data).join("tailscaled.sock")
}
fn state(data: &Path) -> PathBuf {
    root(data).join("tailscaled.state")
}
fn enabled(data: &Path) -> bool {
    root(data).join("enabled").exists()
}

fn process_start(pid: u32) -> Result<String, String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?;
    stat.rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .map(str::to_owned)
        .ok_or_else(|| "Could not read Tailscale process identity.".into())
}

fn boot_id() -> Result<String, String> {
    let value =
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|e| e.to_string())?;
    let value = value.trim();
    if value.len() != 36 || !value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Could not verify the current boot.".into());
    }
    Ok(value.to_owned())
}

fn valid_stop_proof(data: &Path) -> bool {
    std::fs::read_to_string(root(data).join("stop-verified"))
        .ok()
        .is_some_and(|value| {
            value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        })
}

fn retire_launch(data: &Path) -> Result<(), String> {
    if root(data).exists() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(root(data)).map_err(|e| e.to_string())?;
        file.write_all(boot_id()?.as_bytes())
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(root(data).join("stop-verified"))
            .map_err(|e| e.to_string())?;
        std::fs::File::open(root(data))
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    remove_if_present(&root(data).join("tailscaled.pid"))?;
    remove_if_present(&root(data).join("launch-intent"))?;
    if root(data).exists() {
        std::fs::File::open(root(data))
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    owned().remove(data);
    Ok(())
}

fn write_launch_identity(data: &Path, value: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(root(data)).map_err(|e| e.to_string())?;
    file.write_all(value.as_bytes())
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(root(data).join("launch-intent"))
        .map_err(|e| e.to_string())?;
    std::fs::File::open(root(data))
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

fn begin_launch(data: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root(data).join("launch-intent"))
        .map_err(|_| "A previous Tailscale start could not be verified.".to_string())?;
    file.write_all(format!("pending {}", boot_id()?).as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::File::open(root(data))
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

fn persist_reset_intent(data: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(root(data)).map_err(|e| e.to_string())?;
    file.write_all(b"1").map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(root(data).join("reset-required"))
        .map_err(|e| e.to_string())?;
    std::fs::File::open(root(data))
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

fn valid_authority_port(authority: &axum::http::uri::Authority) -> bool {
    let raw = authority.as_str();
    let has_port = if raw.starts_with('[') {
        raw.split_once(']').is_none_or(|(_, rest)| !rest.is_empty())
    } else {
        raw.contains(':')
    };
    !has_port || authority.port_u16().is_some_and(|port| port != 0)
}

// A blank value selects Tailscale's official control server. Headscale must
// use an HTTPS origin because it supplies both identity and login links.
fn normalize_control_server(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let uri: axum::http::Uri = raw
        .parse()
        .map_err(|_| "Enter a valid HTTPS Headscale server address.".to_string())?;
    let authority = uri
        .authority()
        .ok_or("Enter a valid HTTPS Headscale server address.")?;
    if uri.scheme_str() != Some("https")
        || authority.host().is_empty()
        || authority.as_str().contains('@')
        || !valid_authority_port(authority)
        || uri.query().is_some()
        || !matches!(uri.path(), "" | "/")
    {
        return Err("Enter an HTTPS server address without a path.".into());
    }
    let authority = authority.as_str().to_ascii_lowercase();
    let authority = authority.strip_suffix(":443").unwrap_or(&authority);
    Ok(format!("https://{authority}"))
}

fn control_server(data: &Path) -> Result<String, String> {
    match std::fs::read_to_string(root(data).join("control-server")) {
        Ok(raw) => normalize_control_server(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn up(data: &Path, json: bool) -> Result<String, String> {
    let server = control_server(data)?;
    let flag = format!("--login-server={server}");
    let mut args = vec!["up", "--accept-dns=false", "--timeout=2s"];
    if json {
        args.push("--json");
    }
    if !server.is_empty() {
        args.push(&flag);
    }
    command(data, &args)
}

fn allowed_auth_url(raw: &str, server: &str) -> bool {
    let Ok(uri) = raw.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    if uri.scheme_str() != Some("https")
        || authority.as_str().contains('@')
        || !valid_authority_port(authority)
    {
        return false;
    }
    if server.is_empty() {
        return authority.host().eq_ignore_ascii_case("login.tailscale.com")
            && matches!(authority.port_u16(), None | Some(443));
    }
    server
        .parse::<axum::http::Uri>()
        .ok()
        .and_then(|u| {
            u.authority()
                .map(|a| (a.host().to_owned(), a.port_u16().unwrap_or(443)))
        })
        .is_some_and(|(host, port)| {
            host.eq_ignore_ascii_case(authority.host())
                && port == authority.port_u16().unwrap_or(443)
        })
}

fn command(data: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(cli())
        .arg("--socket")
        .arg(socket(data))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Tailscale is not installed: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut pipes_ready = false;
    let mut owns_child = true;
    let deadline = Instant::now() + Duration::from_secs(2);
    let result = (|| -> Result<(), String> {
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            // Pipes must not keep this call alive when a child inherits them.
            if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } == -1 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        pipes_ready = true;
        loop {
            drain_command_pipe(&mut stdout, &mut out)?;
            drain_command_pipe(&mut stderr, &mut err)?;
            // Observe exit without reaping: retaining our child reserves its
            // PID, so the process group below cannot belong to a reused PID.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } == -1
            {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ECHILD) {
                    owns_child = false;
                }
                return Err(error.to_string());
            }
            if info.si_signo != 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Tailscale command timed out.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    // We created this group and have not reaped its leader. Stop descendants
    // too, including a helper holding stdout open after the CLI exits.
    if owns_child {
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    }
    let reap_deadline = Instant::now() + Duration::from_millis(500);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Err(_) => break None,
            Ok(None) if Instant::now() < reap_deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                break None;
            }
        }
    };
    if pipes_ready {
        let _ = drain_command_pipe(&mut stdout, &mut out);
        let _ = drain_command_pipe(&mut stderr, &mut err);
    }
    if result.is_err() || !status.is_some_and(|status| status.success()) {
        return Err(format!(
            "{} {} {}",
            String::from_utf8_lossy(&out).trim(),
            String::from_utf8_lossy(&err).trim(),
            result.err().unwrap_or_default()
        )
        .trim()
        .to_string());
    }
    if !err.is_empty() {
        tracing::warn!(detail = %String::from_utf8_lossy(&err).trim(), "Tailscale command warning");
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn drain_command_pipe(pipe: &mut impl Read, output: &mut Vec<u8>) -> Result<(), String> {
    let mut buf = [0; 8192];
    // Bound both stored output and work per poll, even for a noisy helper.
    for _ in 0..8 {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let keep = n.min((1024 * 1024usize).saturating_sub(output.len()));
                output.extend_from_slice(&buf[..keep]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn ensure_daemon(data: &Path) -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // Do not start a node if this kernel or sandbox cannot safely identify it
    // later when its numeric PID may have been reused.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, std::process::id(), 0) } as i32;
    if fd < 0 {
        return Err(format!(
            "Tailscale is unavailable: process identity protection is not supported: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: pidfd_open returned a new owned file descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let checked = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            0,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if checked < 0 {
        return Err(format!(
            "Tailscale is unavailable: process identity protection is not permitted: {}",
            std::io::Error::last_os_error()
        ));
    }
    std::fs::create_dir_all(root(data)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root(data), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    clear_access_if_required(data)?;
    // A durable record from an earlier process is recovered by the startup
    // reconciliation path before this function can start a new daemon.
    if !owned().contains(data) && root(data).join("launch-intent").exists() {
        return Err("A previous Tailscale start needs verification.".into());
    }
    if socket(data).exists() && !owned().contains(data) {
        verify_socket_stopped(data)?;
        std::fs::remove_file(socket(data)).map_err(|e| e.to_string())?;
    }
    if socket(data).exists() && command(data, &["status", "--json"]).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket(data), std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let pid = std::fs::read_to_string(root(data).join("tailscaled.pid")).ok();
    if pid
        .as_deref()
        .and_then(|p| p.trim().parse::<u32>().ok())
        .is_some_and(|p| managed_daemon_pid(data, p))
    {
        return Err("Tailscale is starting but not responding yet.".into());
    }
    verify_socket_stopped(data)?;
    if socket(data).exists() {
        std::fs::remove_file(socket(data)).map_err(|e| e.to_string())?;
    }
    begin_launch(data)?;
    remove_if_present(&root(data).join("stop-verified"))?;
    let mut child = match Command::new(daemon())
        .args(["--state"])
        .arg(state(data))
        .args(["--socket"])
        .arg(socket(data))
        .args(["--tun=userspace-networking"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            retire_launch(data)?;
            return Err(format!("Could not start Tailscale: {error}"));
        }
    };
    let identity = match process_start(child.id())
        .and_then(|start| Ok(format!("{} {start} {}", child.id(), boot_id()?)))
    {
        Ok(identity) => identity,
        Err(error) => {
            retire_failed_child(data, &mut child);
            return Err(error);
        }
    };
    if let Err(error) = write_launch_identity(data, &identity) {
        retire_failed_child(data, &mut child);
        return Err(error);
    }
    if let Err(error) = std::fs::write(root(data).join("tailscaled.pid"), child.id().to_string()) {
        retire_failed_child(data, &mut child);
        return Err(error.to_string());
    }
    let mut ready = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if command(data, &["status", "--json"]).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if socket(data).exists()
            && let Err(error) =
                std::fs::set_permissions(socket(data), std::fs::Permissions::from_mode(0o600))
        {
            retire_failed_child(data, &mut child);
            return Err(error.to_string());
        }
    }
    if !ready {
        retire_failed_child(data, &mut child);
        return Err("Tailscale did not start.".into());
    }
    owned().insert(data.to_path_buf());
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn command_exists(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let executable = |p: &Path| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if path.components().count() > 1 {
        return executable(path);
    }
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| executable(&dir.join(path))))
}

fn clear_access_if_required(data: &Path) -> Result<(), String> {
    if !root(data).join("reset-required").exists() {
        return Ok(());
    }
    stop_daemon(data)?;
    clear_saved_serve(data).map_err(|error| {
        tracing::warn!(%error, "Could not clear saved Tailscale access");
        "Tailscale is off. Remove its saved identity before connecting again.".to_string()
    })?;
    // A pending reset invalidates any saved exposure intent as well as the
    // daemon's Serve state. Never restore an older public mode after a crash.
    remove_if_present(&root(data).join("serve-mode"))?;
    remove_if_present(&root(data).join("restore-serve"))?;
    std::fs::remove_file(root(data).join("reset-required")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(root(data).join("last-error"));
    let _ = std::fs::remove_file(root(data).join("stop-failed"));
    Ok(())
}

// Pinned 1.104.2's FileStore is a JSON object. ipn/serve.go stores Serve under
// _serve/<profile>. With the daemon stopped, remove only those entries and
// preserve the node identity. The local API cannot reset Serve before login.
fn clear_saved_serve(data: &Path) -> Result<(), String> {
    use std::io::Write;
    let raw = match std::fs::read(state(data)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let mut store: serde_json::Map<String, Value> =
        serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if store.len() == 3
        && ["key", "nonce", "data"]
            .iter()
            .all(|key| store.contains_key(*key))
    {
        return Err("Tailscale's encrypted state cannot be cleared offline".into());
    }
    let count = store.len();
    store.retain(|key, _| !key.starts_with("_serve/"));
    if count == store.len() {
        return Ok(());
    }
    let mut tmp = tempfile::NamedTempFile::new_in(root(data)).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut tmp, &store).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(state(data)).map_err(|e| e.to_string())?;
    Ok(())
}

fn status_json(data: &Path, port: u16) -> Value {
    let mut out = json!({"installed": command_exists(&cli()) && command_exists(&daemon()), "enabled": enabled(data), "identity_saved": state(data).exists(), "state":"off", "private_url":"", "public_url":"", "auth_url":"", "approval_url":"", "error":""});
    let server = match control_server(data) {
        Ok(server) => server,
        Err(_) => {
            out["state"] = json!("error");
            out["error"] = json!("Luna could not read the remote access server.");
            if root(data).join("stop-failed").exists() {
                out["residual_exposure"] = json!(true);
            }
            return out;
        }
    };
    out["control_server"] = json!(server);
    if !owned().contains(data) && root(data).join("launch-intent").exists() {
        out["state"] = json!("error");
        out["error"] = json!("Luna could not verify that Tailscale stopped.");
        out["residual_exposure"] = json!(true);
        return out;
    }
    if let Ok(url) = std::fs::read_to_string(root(data).join("approval-url")) {
        out["approval_url"] = json!(url.trim());
    }
    if let Ok(kind) = std::fs::read_to_string(root(data).join("approval-type")) {
        out["approval_type"] = json!(kind.trim());
    }
    if let Ok(warning) = std::fs::read_to_string(root(data).join("last-error")) {
        out["error"] = json!(warning.trim());
    }
    if root(data).join("stop-failed").exists() {
        out["state"] = json!("error");
        out["residual_exposure"] = json!(true);
        return out;
    }
    if port == 0 && (enabled(data) || state(data).exists()) {
        out["state"] = json!("error");
        out["error"] =
            json!("Tailscale access is unavailable. Restart Luna and try connecting again.");
        return out;
    }
    if !enabled(data) {
        return out;
    }
    let raw = match command(data, &["status", "--json"]) {
        Ok(v) => v,
        Err(_) => {
            out["state"] = json!("error");
            out["residual_exposure"] = json!(true);
            out["error"] =
                json!("Tailscale could not read its connection status. Try reconnecting.");
            return out;
        }
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        out["state"] = json!("error");
        out["residual_exposure"] = json!(true);
        out["error"] = json!("Tailscale returned an unreadable status.");
        return out;
    };
    let backend = parsed
        .get("BackendState")
        .and_then(Value::as_str)
        .unwrap_or("Unknown");
    out["state"] = json!(match backend {
        "Running" => "connected",
        "NeedsLogin" | "NeedsMachineAuth" => "pending",
        _ => "disconnected",
    });
    let dns = parsed
        .get("Self")
        .and_then(|self_node| self_node.get("DNSName"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| format!("https://{}", s.trim_end_matches('.')))
        .unwrap_or_default();
    if backend == "NeedsMachineAuth" && !server.is_empty() {
        out["error"] = json!("Ask your Headscale administrator to approve this device.");
    } else if backend == "NeedsMachineAuth" {
        out["auth_url"] = json!("https://login.tailscale.com/admin/machines");
    } else if backend == "NeedsLogin" {
        let current = parsed
            .get("AuthURL")
            .and_then(Value::as_str)
            .filter(|url| allowed_auth_url(url, &server))
            .unwrap_or("");
        out["auth_url"] = json!(current);
        if current.is_empty() {
            let _ = std::fs::remove_file(root(data).join("auth-url"));
        } else {
            let _ = std::fs::write(root(data).join("auth-url"), current);
        }
    } else {
        let _ = std::fs::remove_file(root(data).join("auth-url"));
    }
    let serve_status = command(data, &["serve", "status", "--json"])
        .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()));
    if !serve_status
        .as_ref()
        .is_ok_and(|v| v.is_object() || v.is_null())
    {
        out["state"] = json!("error");
        out["error"] = json!("Luna could not check whether public access is on.");
        out["residual_exposure"] = json!(true);
        return out;
    }
    if let Ok(v) = serve_status
        && let Some(target) = super::tailscale_socket::target(data)
        && let Some((url, is_public)) =
            configured_urls_for_target(&v, &dns, &target, !server.is_empty())
    {
        if backend == "Running" {
            super::tailscale_socket::set_authority(data, url.strip_prefix("https://"));
            if is_public {
                out["public_url"] = json!(url);
            } else {
                out["private_url"] = json!(dns);
            }
        }
        let approval_type = out["approval_type"].as_str().unwrap_or_default();
        if backend == "Running"
            && ((approval_type == "funnel" && is_public)
                || (approval_type == "https" && !is_public))
        {
            let _ = std::fs::remove_file(root(data).join("approval-url"));
            let _ = std::fs::remove_file(root(data).join("approval-type"));
            out["approval_url"] = json!("");
            out["approval_type"] = json!("");
        }
    }
    out
}

pub fn status(data: &Path, port: u16) -> Value {
    let _guard = lifecycle();
    status_json(data, port)
}
pub fn connect(data: &Path, port: u16) -> Result<Value, String> {
    connect_with_control(data, port, "")
}

pub fn connect_with_control(data: &Path, port: u16, selected: &str) -> Result<Value, String> {
    let selected = normalize_control_server(selected)?;
    let guard = lifecycle();
    if guard.contains(data) {
        return Err("Luna is shutting down.".into());
    }
    require_proxy(port)?;
    let current = control_server(data)?;
    if (state(data).exists()
        || enabled(data)
        || socket(data).exists()
        || root(data).join("launch-intent").exists()
        || root(data).join("stop-failed").exists())
        && !current.eq_ignore_ascii_case(&selected)
    {
        return Err("Sign out of Tailscale before changing the server.".into());
    }
    if !current.eq_ignore_ascii_case(&selected) {
        stop_daemon(data)?;
    }
    std::fs::create_dir_all(root(data)).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root(data), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let mut tmp = tempfile::NamedTempFile::new_in(root(data)).map_err(|e| e.to_string())?;
        tmp.write_all(selected.as_bytes())
            .map_err(|e| e.to_string())?;
        tmp.as_file().sync_all().map_err(|e| e.to_string())?;
        tmp.persist(root(data).join("control-server"))
            .map_err(|e| e.to_string())?;
        std::fs::File::open(root(data))
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    ensure_daemon(data)?;
    std::fs::write(root(data).join("enabled"), b"1").map_err(|e| e.to_string())?;
    let raw = match up(data, true) {
        Ok(raw) => raw,
        Err(error) if save_auth_url(data, &error) => {
            let _ = std::fs::remove_file(root(data).join("last-error"));
            return Ok(status_json(data, port));
        }
        Err(error) => return Err(error),
    };
    let _ = std::fs::remove_file(root(data).join("last-error"));
    if let Ok(v) = serde_json::from_str::<Value>(&raw)
        && let Some(url) = v
            .get("AuthURL")
            .and_then(Value::as_str)
            .filter(|url| control_server(data).is_ok_and(|server| allowed_auth_url(url, &server)))
    {
        let _ = std::fs::write(root(data).join("auth-url"), url);
    }
    Ok(status_json(data, port))
}
pub fn reconnect(data: &Path, port: u16) -> Result<Value, String> {
    let guard = lifecycle();
    if guard.contains(data) {
        return Err("Luna is shutting down.".into());
    }
    if !enabled(data) {
        return Err("Connect Tailscale first.".into());
    }
    require_proxy(port)?;
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    stop_daemon(data)?;
    let _ = std::fs::remove_file(root(data).join("stop-failed"));
    ensure_daemon(data)?;
    let raw = match up(data, true) {
        Ok(raw) => raw,
        Err(error) if save_auth_url(data, &error) => {
            let _ = std::fs::remove_file(root(data).join("last-error"));
            return Ok(status_json(data, port));
        }
        Err(error) => return Err(error),
    };
    let _ = std::fs::remove_file(root(data).join("last-error"));
    if let Ok(v) = serde_json::from_str::<Value>(&raw)
        && let Some(url) = v
            .get("AuthURL")
            .and_then(Value::as_str)
            .filter(|url| control_server(data).is_ok_and(|server| allowed_auth_url(url, &server)))
    {
        let _ = std::fs::write(root(data).join("auth-url"), url);
    }
    Ok(status_json(data, port))
}
fn save_auth_url(data: &Path, raw: &str) -> bool {
    let start = raw.find('{').unwrap_or(0);
    let end = raw.rfind('}').map(|i| i + 1).unwrap_or(raw.len());
    let Ok(value) = serde_json::from_str::<Value>(&raw[start..end]) else {
        return false;
    };
    let Some(url) = value.get("AuthURL").and_then(Value::as_str) else {
        return false;
    };
    let Ok(server) = control_server(data) else {
        return false;
    };
    if !allowed_auth_url(url, &server) {
        return false;
    }
    std::fs::write(root(data).join("auth-url"), url).is_ok()
}
pub fn serve(data: &Path, port: u16, public: bool) -> Result<Value, String> {
    let guard = lifecycle();
    if guard.contains(data) {
        return Err("Luna is shutting down.".into());
    }
    let status = serve_inner(data, port, public)?;
    if !public
        && !control_server(data)?.is_empty()
        && status["private_url"].as_str().unwrap_or("").is_empty()
    {
        return Err("Headscale has not reported a private HTTPS address. Check its connection and certificate settings.".into());
    }
    Ok(status)
}

fn serve_inner(data: &Path, port: u16, public: bool) -> Result<Value, String> {
    if !enabled(data) {
        return Err("Connect Tailscale first.".into());
    }
    require_proxy(port)?;
    let target = super::tailscale_socket::target(data)
        .ok_or("Tailscale's private listener is unavailable.")?;
    let headscale = !control_server(data)?.is_empty();
    if public && headscale {
        return Err("Public access is not available with Headscale.".into());
    }
    if !public {
        // Write the fail-closed intent before touching a possibly public
        // listener. ensure_daemon clears saved Serve while stopped; a crash or
        // failed private setup must never resurrect the earlier Funnel.
        persist_reset_intent(data)?;
    }
    ensure_daemon(data)?;
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    let _ = up(data, false)?;
    if public {
        match command(data, &["funnel", "--bg", "--https=443", &target]) {
            Ok(out) => {
                if let Some(url) = (!headscale).then(|| extract_url(&out)).flatten() {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"funnel");
                }
            }
            Err(e) => {
                if let Some(url) = (!headscale).then(|| extract_url(&e)).flatten() {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"funnel");
                    return Ok(status_json(data, port));
                }
                return Err(e);
            }
        }
    } else {
        command(data, &["serve", "reset"])?;
        match command(data, &["serve", "--bg", "--https=443", &target]) {
            Ok(out) => {
                if let Some(url) = (!headscale).then(|| extract_url(&out)).flatten() {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"https");
                }
            }
            Err(e) => {
                if let Some(url) = (!headscale).then(|| extract_url(&e)).flatten() {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"https");
                    return Ok(status_json(data, port));
                }
                return Err(if headscale {
                    "Luna could not turn on private access. Check your Headscale connection and HTTPS certificate settings.".into()
                } else {
                    e
                });
            }
        }
    }
    let _ = std::fs::remove_file(root(data).join("private-enabled"));
    std::fs::write(
        root(data).join("serve-mode"),
        if public { "public" } else { "private" },
    )
    .map_err(|e| e.to_string())?;
    Ok(status_json(data, port))
}
fn extract_url(text: &str) -> Option<&str> {
    text.split_whitespace()
        .map(|s| s.trim_matches(|c: char| c == '.' || c == ',' || c == ')' || c == ']'))
        .find(|s| {
            let Some(host) = s.strip_prefix("https://").and_then(|v| v.split('/').next()) else {
                return false;
            };
            let host = host.split(':').next().unwrap_or_default();
            host == "tailscale.com" || host.ends_with(".tailscale.com")
        })
}
#[cfg(test)]
fn configured_urls(value: &Value, dns: &str, port: u16) -> Option<(String, bool)> {
    configured_urls_for_control(value, dns, port, false)
}

#[cfg(test)]
fn configured_urls_for_control(
    value: &Value,
    dns: &str,
    port: u16,
    headscale: bool,
) -> Option<(String, bool)> {
    configured_urls_for_target(value, dns, &format!("http://127.0.0.1:{port}"), headscale)
}

fn configured_urls_for_target(
    value: &Value,
    dns: &str,
    expected: &str,
    headscale: bool,
) -> Option<(String, bool)> {
    let web = value.get("Web")?.as_object()?;
    let allow = value.get("AllowFunnel").and_then(Value::as_object);
    web.keys().find_map(|listener| {
        let hostname = listener.strip_suffix(":443")?;
        if hostname.is_empty()
            || !hostname
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            || (!headscale && !hostname.to_ascii_lowercase().ends_with(".ts.net"))
        {
            return None;
        }
        let public = allow
            .and_then(|m| m.get(listener))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if headscale && public {
            return None;
        }
        let listener_config = web.get(listener)?.as_object()?;
        let handlers = listener_config.get("Handlers")?.as_object()?;
        if !handlers
            .values()
            .any(|handler| handler.get("Proxy").and_then(Value::as_str) == Some(expected))
        {
            return None;
        }
        let expected_host = dns.strip_prefix("https://")?.trim_end_matches('.');
        if !hostname.eq_ignore_ascii_case(expected_host) {
            return None;
        }
        Some((format!("https://{hostname}"), public))
    })
}

pub fn disable(data: &Path, port: u16) -> Result<Value, String> {
    let _guard = lifecycle();
    disable_inner(data, port)
}

pub fn stop_serve(data: &Path, port: u16) -> Result<Value, String> {
    let _guard = lifecycle();
    if let Err(error) = command(data, &["serve", "reset"]) {
        tracing::warn!(%error, "Could not reset Tailscale web access; stopping the managed daemon");
        return disable_inner(data, port);
    }
    let _ = std::fs::remove_file(root(data).join("serve-mode"));
    let _ = std::fs::remove_file(root(data).join("restore-serve"));
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    Ok(status_json(data, port))
}
fn disable_inner(data: &Path, port: u16) -> Result<Value, String> {
    if !root(data).exists() {
        return Ok(status_json(data, port));
    }
    // Always attempt both operations. A failed reset-marker write must not
    // preserve the positive opt-in marker and restore a public node on reboot.
    let reset_intent =
        std::fs::write(root(data).join("reset-required"), b"1").map_err(|e| e.to_string());
    let disabled_intent = remove_if_present(&root(data).join("enabled"));
    let persisted = reset_intent.and(disabled_intent);
    if socket(data).exists()
        && let Err(error) = command(data, &["down"])
    {
        tracing::warn!(%error, "Could not disconnect Tailscale through its local API; stopping the managed daemon");
    }
    if let Err(error) = stop_daemon(data) {
        tracing::error!(%error, "Could not verify Tailscale stopped");
        let message = "Tailscale may still be reachable. Luna could not verify that its remote connection stopped.";
        let _ = std::fs::write(root(data).join("last-error"), message);
        let _ = std::fs::write(root(data).join("stop-failed"), "1");
        let mut out = status_json(data, port);
        out["state"] = json!("error");
        out["error"] = json!(message);
        out["residual_exposure"] = json!(true);
        return Ok(out);
    }
    persisted?;
    for name in [
        "private-enabled",
        "auth-url",
        "approval-url",
        "approval-type",
        "serve-mode",
        "restore-serve",
    ] {
        let _ = std::fs::remove_file(root(data).join(name));
    }
    if let Err(error) = clear_access_if_required(data) {
        tracing::warn!(%error, "Tailscale is stopped but its saved access could not be cleared");
        let _ = std::fs::write(
            root(data).join("last-error"),
            "Tailscale is off. Remove its saved identity before connecting again.",
        );
    }
    Ok(status_json(data, port))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::IsADirectory => {
            std::fs::remove_dir(path).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn stop_daemon(data: &Path) -> Result<(), String> {
    super::tailscale_socket::set_authority(data, None);
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let intent = match std::fs::read_to_string(root(data).join("launch-intent")) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let saved = if let Some(value) = intent.as_deref() {
        let fields: Vec<_> = value.split_whitespace().collect();
        match fields.as_slice() {
            ["pending", boot] => {
                if *boot != boot_id()? {
                    return retire_launch(data);
                }
                return Err("A previous Tailscale start could not be verified.".into());
            }
            [pid, start, boot] => {
                if *boot != boot_id()? {
                    return retire_launch(data);
                }
                Some((pid.parse::<u32>().map_err(|e| e.to_string())?, *start))
            }
            _ => return Err("A previous Tailscale start could not be verified.".into()),
        }
    } else {
        None
    };
    if saved.is_none() && valid_stop_proof(data) {
        return verify_socket_stopped(data);
    }
    let pid = saved.map(|v| v.0).or_else(|| {
        std::fs::read_to_string(root(data).join("tailscaled.pid"))
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok())
    });
    if intent.is_none() && pid.is_some() {
        return Err("An older Tailscale process cannot be safely identified.".into());
    }
    let Some(pid) = pid.filter(|p| *p > 1) else {
        if !valid_stop_proof(data)
            && (state(data).exists() || enabled(data) || socket(data).exists())
        {
            return Err("An older Tailscale process could not be verified.".into());
        }
        return verify_socket_stopped(data);
    };
    // Pin identity before inspecting /proc; a recycled numeric PID must never
    // cause us to signal an unrelated replacement process.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            verify_socket_stopped(data)?;
            return retire_launch(data);
        }
        return Err(format!("Could not pin Tailscale process identity: {error}"));
    }
    // SAFETY: pidfd_open returned a new owned file descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    if let Some((_, start)) = saved {
        let current = process_start(pid)?;
        if current != start {
            verify_socket_stopped(data)?;
            return retire_launch(data);
        }
    }
    if !managed_daemon_pid(data, pid) {
        return Err("Tailscale's process ownership could not be verified.".into());
    }
    let sent = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if sent < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(format!("Could not stop Tailscale: {error}"));
        }
    }
    for _ in 0..40 {
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let exited = unsafe { libc::poll(&mut poll, 1, 0) } > 0 && poll.revents & libc::POLLIN != 0;
        if exited && verify_socket_stopped(data).is_ok() {
            return retire_launch(data);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("Tailscale did not stop; its saved identity was kept.".into())
}

fn verify_socket_stopped(data: &Path) -> Result<(), String> {
    let sockets = std::fs::read_to_string("/proc/net/unix")
        .map_err(|e| format!("Could not verify Tailscale's socket stopped: {e}"))?;
    for line in sockets.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() >= 8
            && line.ends_with(&format!(" {}", socket(data).display()))
            && fields[3] == "00010000"
        {
            return Err(
                "Tailscale's socket is held by a process whose ownership could not be verified."
                    .into(),
            );
        }
    }
    Ok(())
}

pub fn forget(data: &Path, port: u16) -> Result<Value, String> {
    let _guard = lifecycle();
    let result = disable_inner(data, port);
    if let Ok(result) = &result
        && result["residual_exposure"] == true
    {
        return Err(result["error"]
            .as_str()
            .unwrap_or("Tailscale could not be stopped.")
            .to_string());
    }
    // Even failed marker writes can be recovered from once stop is verified.
    // Reset only clears the database, so an uncertain live identity must stay.
    stop_daemon(data)?;
    if let Err(error) = result {
        tracing::warn!(%error, "Could not persist Tailscale shutdown intent; removing identity after verified stop");
    }
    // A damaged selection cannot be repaired while it prevents status and
    // reconnect. After verified stop it is safe to discard only invalid data.
    let control_path = root(data).join("control-server");
    match std::fs::read_to_string(&control_path) {
        Ok(raw) if normalize_control_server(&raw).is_err() => remove_if_present(&control_path)?,
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    for path in [state(data), root(data).join("enabled")] {
        remove_if_present(&path)?;
    }
    for path in [
        socket(data),
        root(data).join("tailscaled.pid"),
        root(data).join("reset-required"),
        root(data).join("last-error"),
        root(data).join("stop-failed"),
        root(data).join("serve-mode"),
        root(data).join("restore-serve"),
        root(data).join("auth-url"),
        root(data).join("approval-url"),
        root(data).join("approval-type"),
    ] {
        if let Err(error) = remove_if_present(&path) {
            tracing::warn!(%error, ?path, "Could not remove old Tailscale metadata after verified stop and identity removal");
        }
    }
    Ok(status_json(data, port))
}

fn require_proxy(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err(
            "Tailscale access is unavailable. Restart Luna and try connecting again.".into(),
        );
    }
    Ok(())
}

/// Stop the old target before moving its loopback port. Restore only the
/// exposure mode the Admin already selected, after the new listener is ready.
pub fn prepare_proxy_move(data: &Path) -> Result<(), String> {
    let guard = lifecycle();
    if guard.contains(data) {
        return Err("Luna is shutting down.".into());
    }
    let was_enabled = enabled(data);
    let mode = if root(data).join("reset-required").exists() {
        String::new()
    } else {
        std::fs::read_to_string(root(data).join("serve-mode"))
            .or_else(|_| std::fs::read_to_string(root(data).join("restore-serve")))
            .unwrap_or_default()
    };
    let stopped = disable_inner(data, 0)?;
    if stopped["residual_exposure"] == true {
        return Err("Tailscale could not be stopped before moving its local web address.".into());
    }
    if was_enabled && !root(data).join("reset-required").exists() {
        if matches!(mode.as_str(), "private" | "public") {
            std::fs::write(root(data).join("restore-serve"), mode).map_err(|e| e.to_string())?;
        }
        std::fs::write(root(data).join("enabled"), "1").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Verify the managed daemon is stopped without changing saved configuration.
pub fn verify_stopped_for_startup(data: &Path) -> Result<(), String> {
    let _guard = lifecycle();
    stop_daemon(data)
}

/// Stop the verified managed daemon while keeping the selected mode and node
/// identity for the next boot. The lifecycle lock also rejects queued starts.
pub fn stop_for_shutdown(data: &Path) -> Result<(), String> {
    let mut guard = lifecycle();
    guard.insert(data.to_path_buf());
    let result = stop_daemon(data);
    if result.is_err() {
        let _ = std::fs::write(root(data).join("stop-failed"), "unverified");
    }
    result
}

/// Restore only on startup, never on each status poll. Run off the async main
/// thread so a missing or broken optional daemon cannot delay Luna's web app.
pub fn restore(data: &Path, port: u16) {
    let guard = lifecycle();
    if guard.contains(data) {
        return;
    }
    if !enabled(data) {
        if root(data).join("reset-required").exists()
            && let Err(error) = clear_access_if_required(data)
        {
            tracing::warn!(%error, "Could not complete Tailscale shutdown cleanup");
            let _ = std::fs::write(root(data).join("last-error"), error);
        }
        return;
    }
    if port == 0 {
        let _ = disable_inner(data, port);
        return;
    }
    if let Err(error) = ensure_daemon(data) {
        tracing::warn!(%error, "Could not restore Tailscale");
        return;
    }
    if let Ok(mode) = std::fs::read_to_string(root(data).join("restore-serve")) {
        if matches!(mode.as_str(), "private" | "public")
            && let Err(error) = serve_inner(data, port, mode == "public")
        {
            tracing::warn!(%error, "Could not restore Tailscale's web target after moving its proxy port");
            let _ = disable_inner(data, port);
            let _ = std::fs::write(
                root(data).join("last-error"),
                "Tailscale is off because its web address could not be restored. Try connecting again.",
            );
        }
        let _ = std::fs::remove_file(root(data).join("restore-serve"));
    }
}

fn managed_daemon_pid(data: &Path, pid: u32) -> bool {
    if pid <= 1 {
        return false;
    }
    let cmdline = format!("/proc/{pid}/cmdline");
    std::fs::read_to_string(cmdline)
        .map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            let executable_matches = fields
                .first()
                .is_some_and(|exe| Path::new(exe).file_name() == daemon().file_name());
            executable_matches
                && fields.iter().enumerate().any(|(index, field)| {
                    *field == format!("--state={}", state(data).display())
                        || (*field == "--state"
                            && fields
                                .get(index + 1)
                                .is_some_and(|value| *value == state(data).to_string_lossy()))
                })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    static TEST_ENV: Mutex<()> = Mutex::new(());

    #[test]
    fn headscale_server_and_login_urls_are_restricted() {
        assert_eq!(
            normalize_control_server("https://control.example:8443/").unwrap(),
            "https://control.example:8443"
        );
        for bad in [
            "http://control.example",
            "https://user:pass@control.example",
            "https://control.example/path",
            "https://control.example/?x=1",
            "javascript:alert(1)",
        ] {
            assert!(normalize_control_server(bad).is_err(), "accepted {bad}");
        }
        assert!(allowed_auth_url(
            "https://control.example:8443/register/node",
            "https://control.example:8443"
        ));
        assert!(!allowed_auth_url(
            "https://other.example/register/node",
            "https://control.example:8443"
        ));
        assert!(!allowed_auth_url(
            "https://login.tailscale.com.evil.example/x",
            ""
        ));
        assert!(allowed_auth_url("https://login.tailscale.com/a/demo", ""));
    }

    #[test]
    fn headscale_https_listener_is_exact_and_never_public() {
        let proxy = json!({"Proxy":"http://127.0.0.1:8090"});
        let mut status = json!({"Web":{"luna.example.net:443":{"Handlers":{"/":proxy}}},"AllowFunnel":{"luna.example.net:443":false}});
        assert_eq!(
            configured_urls_for_control(&status, "https://luna.example.net", 8090, true),
            Some(("https://luna.example.net".into(), false))
        );
        assert_eq!(
            configured_urls_for_control(&status, "https://other.example.net", 8090, true),
            None
        );
        assert_eq!(
            configured_urls_for_control(&status, "https://luna.example.net", 8091, true),
            None
        );
        assert_eq!(
            configured_urls(&status, "https://luna.example.net", 8090),
            None
        );
        status["AllowFunnel"]["luna.example.net:443"] = json!(true);
        assert_eq!(
            configured_urls_for_control(&status, "https://luna.example.net", 8090, true),
            None
        );
    }

    #[test]
    fn saved_identity_cannot_be_switched_to_another_control_server() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        assert!(
            connect_with_control(dir.path(), 8090, "https://headscale.example")
                .unwrap_err()
                .contains("Sign out")
        );
        assert_eq!(std::fs::read_to_string(state(dir.path())).unwrap(), "{}");
        assert!(!root(dir.path()).join("control-server").exists());
    }

    #[test]
    fn selected_headscale_server_is_persisted_before_start() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALED", dir.path().join("missing-daemon"));
            std::env::set_var("LUNA_TAILSCALE_CLI", dir.path().join("missing-cli"));
        }
        let result = connect_with_control(dir.path(), 8090, "https://headscale.example/");
        unsafe {
            std::env::remove_var("LUNA_TAILSCALED");
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
        assert!(result.is_err());
        assert_eq!(
            control_server(dir.path()).unwrap(),
            "https://headscale.example"
        );
        assert!(!enabled(dir.path()));
    }

    #[test]
    fn headscale_up_uses_saved_control_server_and_rejects_funnel() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(
            root(dir.path()).join("control-server"),
            "https://headscale.example",
        )
        .unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        let cli = dir.path().join("cli");
        let args = dir.path().join("args");
        std::fs::write(
            &cli,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", args.display()),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
        }
        let result = up(dir.path(), true);
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
        result.unwrap();
        assert!(
            std::fs::read_to_string(args)
                .unwrap()
                .contains("--login-server=https://headscale.example")
        );
        super::super::tailscale_socket::register(dir.path(), &dir.path().join("proxy.sock"));
        assert!(
            serve(dir.path(), 8090, true)
                .unwrap_err()
                .contains("not available")
        );
    }

    #[test]
    fn failed_private_switch_cannot_restore_old_public_mode_after_port_move() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        struct ResetEnvironment;
        impl Drop for ResetEnvironment {
            fn drop(&mut self) {
                unsafe {
                    std::env::remove_var("LUNA_TAILSCALE_CLI");
                    std::env::remove_var("LUNA_TAILSCALED");
                }
            }
        }
        let _reset = ResetEnvironment;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(
            state(dir.path()),
            r#"{"_machinekey":"a2V5","_serve/profile":"e30="}"#,
        )
        .unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(root(dir.path()).join("serve-mode"), "public").unwrap();
        std::fs::write(socket(dir.path()), "").unwrap();
        let cli = dir.path().join("cli");
        let daemon = dir.path().join("daemon");
        let up_reached = dir.path().join("up-reached");
        std::fs::write(&cli, format!("#!/bin/sh\ncase \"$*\" in *'status --json'*) echo '{{\"BackendState\":\"Running\"}}';; *'up '*) touch '{}'; exit 1;; esac\n", up_reached.display())).unwrap();
        // This stub exits by itself and never opens a network socket.
        std::fs::write(&daemon, "#!/bin/sh\nsleep 1\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
            std::env::set_var("LUNA_TAILSCALED", &daemon);
        }
        super::super::tailscale_socket::register(dir.path(), &dir.path().join("proxy.sock"));
        let result = serve(dir.path(), 8090, false);
        assert!(result.is_err());
        assert!(
            up_reached.exists(),
            "private switch did not reach mocked up failure"
        );
        assert!(!root(dir.path()).join("serve-mode").exists());
        assert!(
            !std::fs::read_to_string(state(dir.path()))
                .unwrap()
                .contains("_serve/")
        );
        let pid = std::fs::read_to_string(root(dir.path()).join("tailscaled.pid")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Path::new(&format!("/proc/{}", pid.trim())).exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        prepare_proxy_move(dir.path()).unwrap();
        assert!(!root(dir.path()).join("restore-serve").exists());
        assert!(enabled(dir.path()));
    }

    #[test]
    fn shutdown_stops_verified_daemon_preserves_identity_and_rejects_starts() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        let saved = r#"{"_machinekey":"a2V5","_serve/profile":"e30="}"#;
        std::fs::write(state(dir.path()), saved).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(root(dir.path()).join("serve-mode"), "public").unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALED", "/bin/sh");
        }
        // A disposable owned process with the exact managed state argument.
        // read blocks on our pipe and creates no descendant process.
        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf ready; read value", "--state"])
            .arg(state(dir.path()))
            .stdout(Stdio::piped())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = [0; 5];
        std::io::Read::read_exact(child.stdout.as_mut().unwrap(), &mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        std::fs::write(
            root(dir.path()).join("tailscaled.pid"),
            child.id().to_string(),
        )
        .unwrap();
        assert!(managed_daemon_pid(dir.path(), child.id()));
        write_launch_identity(
            dir.path(),
            &format!(
                "{} {} {}",
                child.id(),
                process_start(child.id()).unwrap(),
                boot_id().unwrap()
            ),
        )
        .unwrap();
        stop_for_shutdown(dir.path()).unwrap();
        assert!(!child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(state(dir.path())).unwrap(), saved);
        assert!(enabled(dir.path()));
        assert_eq!(
            std::fs::read_to_string(root(dir.path()).join("serve-mode")).unwrap(),
            "public"
        );
        assert!(
            connect(dir.path(), 8090)
                .unwrap_err()
                .contains("shutting down")
        );
        assert!(
            reconnect(dir.path(), 8090)
                .unwrap_err()
                .contains("shutting down")
        );
        assert!(
            serve(dir.path(), 8090, true)
                .unwrap_err()
                .contains("shutting down")
        );
        restore(dir.path(), 8090);
        assert!(!managed_daemon_pid(dir.path(), child.id()));
        unsafe {
            std::env::remove_var("LUNA_TAILSCALED");
        }
    }

    #[test]
    fn native_command_deadline_and_inherited_pipes_are_bounded() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("cli");
        std::fs::write(
            &cli,
            "#!/bin/sh\nprintf 'partial approval'\nexec sleep 10\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
        }
        let started = Instant::now();
        let error = command(dir.path(), &["up"]).unwrap_err();
        assert!(error.contains("partial approval"));
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(4));
        // The CLI exits but its child keeps both output pipes open. Waiting
        // for pipe EOF or joining a blocking reader would hang for ten seconds.
        std::fs::write(&cli, "#!/bin/sh\nsleep 10 &\nprintf 'finished'\nexit 0\n").unwrap();
        let started = Instant::now();
        assert_eq!(command(dir.path(), &["status"]).unwrap(), "finished");
        assert!(started.elapsed() < Duration::from_secs(2));
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
    }

    #[test]
    fn forget_recovers_from_a_failed_intent_write_after_verified_stop() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        std::fs::create_dir(root(dir.path()).join("reset-required")).unwrap();
        let forgotten = forget(dir.path(), 8090).unwrap();
        assert_eq!(forgotten["identity_saved"], false);
        assert!(!enabled(dir.path()));
        assert!(!root(dir.path()).join("reset-required").exists());
    }

    #[test]
    fn forget_repairs_invalid_control_server_after_verified_stop() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(
            root(dir.path()).join("control-server"),
            "http://invalid.example",
        )
        .unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        forget(dir.path(), 8090).unwrap();
        assert_eq!(control_server(dir.path()).unwrap(), "");
        assert!(!state(dir.path()).exists());
    }

    #[test]
    fn incomplete_launch_never_counts_as_stopped_or_forgettable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("launch-intent"), "pending").unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        assert!(stop_daemon(dir.path()).is_err());
        assert!(forget(dir.path(), 0).is_err());
        assert!(state(dir.path()).exists());
        assert!(root(dir.path()).join("launch-intent").exists());
    }

    #[test]
    fn verified_stop_proof_survives_reboot_and_missing_daemon() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        std::fs::write(
            root(dir.path()).join("stop-verified"),
            "00000000-0000-0000-0000-000000000000",
        )
        .unwrap();
        assert!(stop_daemon(dir.path()).is_ok());
        unsafe {
            std::env::set_var("LUNA_TAILSCALED", dir.path().join("missing"));
        }
        assert!(ensure_daemon(dir.path()).is_err());
        assert!(valid_stop_proof(dir.path()));
        assert!(!root(dir.path()).join("launch-intent").exists());
        assert!(forget(dir.path(), 0).is_ok());
        unsafe {
            std::env::remove_var("LUNA_TAILSCALED");
        }
    }

    #[test]
    fn pending_launch_from_prior_boot_is_retired() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(
            root(dir.path()).join("launch-intent"),
            "pending 00000000-0000-0000-0000-000000000000",
        )
        .unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        stop_daemon(dir.path()).unwrap();
        assert!(!root(dir.path()).join("launch-intent").exists());
        assert_eq!(
            std::fs::read_to_string(root(dir.path()).join("stop-verified")).unwrap(),
            boot_id().unwrap()
        );
    }

    #[test]
    fn status_accepts_only_current_unix_generation() {
        let value = json!({
            "Web": {"luna.tail-example.ts.net:443": {"Handlers": {"/": {"Proxy": "unix:/private/old/s"}}}},
            "AllowFunnel": {"luna.tail-example.ts.net:443": true}
        });
        assert!(
            configured_urls_for_target(
                &value,
                "https://luna.tail-example.ts.net",
                "unix:/private/new/s",
                false
            )
            .is_none()
        );
        assert!(
            configured_urls_for_target(
                &value,
                "https://luna.tail-example.ts.net",
                "unix:/private/old/s",
                false
            )
            .is_some()
        );
    }

    #[test]
    fn pidfd_stop_targets_verified_live_process() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALED", "/bin/sh");
        }
        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf ready; read value", "--state"])
            .arg(state(dir.path()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = [0; 5];
        std::io::Read::read_exact(child.stdout.as_mut().unwrap(), &mut ready).unwrap();
        let identity = format!(
            "{} {} {}",
            child.id(),
            process_start(child.id()).unwrap(),
            boot_id().unwrap()
        );
        write_launch_identity(dir.path(), &identity).unwrap();
        stop_daemon(dir.path()).unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(!root(dir.path()).join("launch-intent").exists());
        unsafe {
            std::env::remove_var("LUNA_TAILSCALED");
        }
    }

    #[test]
    fn failed_reset_marker_write_still_clears_enabled_intent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(
            state(dir.path()),
            r#"{"_machinekey":"a2V5","_serve/old":"e30="}"#,
        )
        .unwrap();
        // A directory at this file path makes just this write fail, while
        // removal of the independent opt-in marker remains possible.
        std::fs::create_dir(root(dir.path()).join("reset-required")).unwrap();
        assert!(disable(dir.path(), 8090).is_err());
        assert!(!enabled(dir.path()));
        assert!(state(dir.path()).exists());
        restore(dir.path(), 8090);
        assert!(!root(dir.path()).join("tailscaled.pid").exists());
    }

    #[test]
    fn teardown_does_not_kill_unverified_socket_owner() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::Builder::new()
            .prefix("tailscale café \u{005c}040 ")
            .tempdir()
            .unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(socket(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        std::fs::write(
            root(dir.path()).join("tailscaled.pid"),
            std::process::id().to_string(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", dir.path().join("missing-cli"));
        }
        assert!(ensure_daemon(dir.path()).is_err());
        assert!(socket(dir.path()).exists());
        let off = disable(dir.path(), 8090).unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(off["residual_exposure"], true);
        assert_eq!(off["state"], "error");
        assert!(forget(dir.path(), 8090).is_err());
        assert!(state(dir.path()).exists());
        std::fs::remove_file(socket(dir.path())).unwrap();
        assert!(forget(dir.path(), 8090).is_err());
        assert!(state(dir.path()).exists());
        drop(listener);
        assert!(forget(dir.path(), 8090).is_err());
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
    }

    #[test]
    fn unavailable_proxy_is_only_an_error_for_an_existing_connection() {
        let dir = tempfile::tempdir().unwrap();
        let unused = status(dir.path(), 0);
        assert_eq!(unused["state"], "off");
        assert_eq!(unused["error"], "");
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(state(dir.path()), "{}").unwrap();
        let saved = status(dir.path(), 0);
        assert_eq!(saved["state"], "error");
        assert!(!saved["error"].as_str().unwrap().is_empty());
        assert_eq!(saved["enabled"], false);
    }

    #[test]
    fn offline_cleanup_preserves_identity_and_rejects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        let fixture = json!({"_machinekey":"a2V5", "profile-a":"cHJlZnM=", "_serve/a":"e30=", "_serve/b":"e30=", "future":{"value":42}});
        std::fs::write(state(dir.path()), fixture.to_string()).unwrap();
        clear_saved_serve(dir.path()).unwrap();
        let result: Value =
            serde_json::from_slice(&std::fs::read(state(dir.path())).unwrap()).unwrap();
        assert_eq!(
            result,
            json!({"_machinekey":"a2V5", "profile-a":"cHJlZnM=", "future":{"value":42}})
        );
        assert_eq!(
            std::fs::metadata(state(dir.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for corrupt in ["broken", "null", "[]"] {
            std::fs::write(state(dir.path()), corrupt).unwrap();
            assert!(clear_saved_serve(dir.path()).is_err());
            assert_eq!(std::fs::read_to_string(state(dir.path())).unwrap(), corrupt);
        }
    }

    #[test]
    fn proxy_move_clears_old_targets_before_restoring_selected_mode() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(
            state(dir.path()),
            r#"{"_machinekey":"a2V5","_serve/old":"e30="}"#,
        )
        .unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(root(dir.path()).join("serve-mode"), "private").unwrap();
        prepare_proxy_move(dir.path()).unwrap();
        assert!(enabled(dir.path()));
        assert_eq!(
            std::fs::read_to_string(root(dir.path()).join("restore-serve")).unwrap(),
            "private"
        );
        assert!(
            !std::fs::read_to_string(state(dir.path()))
                .unwrap()
                .contains("_serve/")
        );
    }

    #[test]
    fn approval_recovery_clears_old_errors_for_connect_and_reconnect() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("cli");
        let daemon = dir.path().join("daemon");
        struct MockEnvironment;
        impl Drop for MockEnvironment {
            fn drop(&mut self) {
                unsafe {
                    std::env::remove_var("LUNA_TAILSCALE_CLI");
                    std::env::remove_var("LUNA_TAILSCALED");
                }
            }
        }
        let _cleanup = MockEnvironment;
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(&cli, "#!/bin/sh\ncase \"$*\" in\n *'status --json'*) echo '{\"BackendState\":\"NeedsLogin\",\"AuthURL\":\"https://login.tailscale.com/a/test\"}' ;;\n *'up '*) echo '{\"AuthURL\":\"https://login.tailscale.com/a/test\"}'; exit 1 ;;\nesac\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        // A short-lived disposable stub, never the real daemon from PATH.
        std::fs::write(&daemon, "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --socket ] || [ \"$1\" = --state ]; then touch \"$2\"; fi; shift; done\n").unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
            std::env::set_var("LUNA_TAILSCALED", &daemon);
        }
        for operation in [connect, reconnect] {
            std::fs::write(root(dir.path()).join("last-error"), "old restore failure").unwrap();
            let result = operation(dir.path(), 8090).unwrap();
            assert_eq!(result["error"], "");
            assert_eq!(result["auth_url"], "https://login.tailscale.com/a/test");
            let pid = std::fs::read_to_string(root(dir.path()).join("tailscaled.pid")).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let process = format!("/proc/{}", pid.trim());
            while Path::new(&process).exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(!Path::new(&process).exists(), "mock daemon did not exit");
        }
    }

    #[test]
    fn unreadable_serve_status_reports_unknown_exposure() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tailscale-mock");
        let response = dir.path().join("serve-status");
        let backend = dir.path().join("backend-status");
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(&cli, format!("#!/bin/sh\ncase \"$*\" in\n *'serve status --json'*) cat '{}' ;;\n *'status --json'*) cat '{}' ;;\nesac\n", response.display(), backend.display())).unwrap();
        std::fs::write(&backend, r#"{"BackendState":"Running"}"#).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
        }
        for value in ["invalid", ""] {
            std::fs::write(&response, value).unwrap();
            let result = status_json(dir.path(), 1);
            assert_eq!(result["state"], "error");
            assert_eq!(result["residual_exposure"], true);
        }
        std::fs::remove_file(&response).unwrap();
        assert_eq!(status_json(dir.path(), 1)["residual_exposure"], true);
        std::fs::write(&response, "{}").unwrap();
        let result = status_json(dir.path(), 1);
        assert_eq!(result["state"], "connected");
        assert_ne!(result["residual_exposure"], true);
        std::fs::write(&response, "null").unwrap();
        assert_eq!(status_json(dir.path(), 1)["state"], "connected");
        std::fs::write(
            &backend,
            r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/test"}"#,
        )
        .unwrap();
        let pending = status_json(dir.path(), 1);
        assert_eq!(pending["state"], "pending");
        assert_eq!(pending["auth_url"], "https://login.tailscale.com/a/test");
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
    }

    #[test]
    fn mock_cli_exercises_userspace_connect_and_private_serve() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tailscale-mock");
        let daemon = dir.path().join("tailscaled-mock");
        let ready = dir.path().join("ready");
        let served = dir.path().join("served");
        std::fs::write(&cli, format!("#!/bin/sh\ncase \"$*\" in\n  *'serve status --json'*) if [ -f '{}' ]; then echo '{{\"Web\":{{\"luna.tail-example.ts.net:443\":{{\"Handlers\":{{\"/\":{{\"Proxy\":\"unix:{}/proxy.sock\"}}}}}}}},\"AllowFunnel\":{{\"luna.tail-example.ts.net:443\":false}}}}'; else echo '{{}}'; fi ;;\n  *'serve --bg'*) touch '{}' ;;\n  *'status --json'*) [ -f '{}' ] || exit 1; echo '{{\"BackendState\":\"Running\",\"Self\":{{\"DNSName\":\"luna.tail-example.ts.net.\"}}}}' ;;\n  *'up '* ) echo '{{\"AuthURL\":\"https://login.tailscale.com/a/test\"}}' ;;\nesac\n", served.display(), dir.path().display(), served.display(), ready.display())).unwrap();
        std::fs::write(&daemon, format!("#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --socket ] || [ \"$1\" = --state ]; then touch \"$2\"; fi; shift; done\ntouch '{}'\n", ready.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
            std::env::set_var("LUNA_TAILSCALED", &daemon);
        }
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("last-error"), "old restore failure").unwrap();
        super::super::tailscale_socket::register(dir.path(), &dir.path().join("proxy.sock"));
        let status = connect(dir.path(), 8090).unwrap();
        assert_eq!(status["state"], "connected");
        assert_eq!(status["error"], "");
        assert!(!root(dir.path()).join("last-error").exists());
        std::fs::write(root(dir.path()).join("last-error"), "old reconnect failure").unwrap();
        let reconnected = reconnect(dir.path(), 8090).unwrap();
        assert_eq!(reconnected["error"], "");
        assert!(status["identity_saved"].as_bool().unwrap());
        assert_eq!(status["private_url"], "");
        assert_eq!(
            serve(dir.path(), 8090, false).unwrap()["private_url"],
            "https://luna.tail-example.ts.net"
        );
        let _ = std::fs::remove_file(root(dir.path()).join("tailscaled.pid"));
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
            std::env::remove_var("LUNA_TAILSCALED");
        }
    }

    #[test]
    fn restore_finishes_interrupted_disable_without_restarting() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(root(dir.path()).join("reset-required"), "1").unwrap();
        std::fs::write(
            state(dir.path()),
            r#"{"_serve/old":"e30=","identity":"keep"}"#,
        )
        .unwrap();
        restore(dir.path(), 0);
        let saved: Value =
            serde_json::from_slice(&std::fs::read(state(dir.path())).unwrap()).unwrap();
        assert!(saved.get("_serve/old").is_none());
        assert_eq!(saved["identity"], "keep");
        assert!(!root(dir.path()).join("reset-required").exists());
        assert!(!enabled(dir.path()));
    }

    #[test]
    fn public_off_stops_daemon_when_cli_is_unavailable() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(
            state(dir.path()),
            r#"{"_serve/old":"e30=","identity":"keep"}"#,
        )
        .unwrap();
        let previous = std::env::var_os("LUNA_TAILSCALE_CLI");
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", dir.path().join("missing"));
        }
        let result = stop_serve(dir.path(), 0);
        unsafe {
            if let Some(value) = previous {
                std::env::set_var("LUNA_TAILSCALE_CLI", value);
            } else {
                std::env::remove_var("LUNA_TAILSCALE_CLI");
            }
        }
        let status = result.unwrap();
        assert_eq!(status["enabled"], false);
        assert!(!status["residual_exposure"].as_bool().unwrap_or(false));
        let saved: Value =
            serde_json::from_slice(&std::fs::read(state(dir.path())).unwrap()).unwrap();
        assert!(saved.get("_serve/old").is_none());
    }

    #[test]
    fn broken_tailscale_can_be_disabled_and_forgotten_without_starting_it() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
        std::fs::write(root(dir.path()).join("stop-verified"), boot_id().unwrap()).unwrap();
        for name in [
            "enabled",
            "tailscaled.state",
            "tailscaled.sock",
            "approval-url",
            "approval-type",
        ] {
            std::fs::write(root(dir.path()).join(name), "saved").unwrap();
        }
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", dir.path().join("missing-cli"));
            std::env::set_var("LUNA_TAILSCALED", dir.path().join("missing-daemon"));
        }
        let failed = status(dir.path(), 8090);
        assert_eq!(failed["state"], "error");
        assert!(!root(dir.path()).join("tailscaled.pid").exists());
        let off = disable(dir.path(), 8090).unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(off["identity_saved"], true);
        assert!(root(dir.path()).join("reset-required").exists());
        let forgotten = forget(dir.path(), 8090).unwrap();
        assert_eq!(forgotten["identity_saved"], false);
        std::fs::write(root(dir.path()).join("enabled"), "1").unwrap();
        std::fs::write(root(dir.path()).join("approval-url"), "stale").unwrap();
        std::fs::write(root(dir.path()).join("approval-type"), "funnel").unwrap();
        assert!(reconnect(dir.path(), 8090).is_err());
        assert!(!root(dir.path()).join("approval-url").exists());
        assert!(!root(dir.path()).join("approval-type").exists());
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
            std::env::remove_var("LUNA_TAILSCALED");
        }
    }

    #[test]
    fn funnel_urls_require_listener_and_allow_funnel_true_for_public() {
        let handler = json!({"Proxy":"http://127.0.0.1:8090"});
        let v = json!({"Web":{"luna.tail-example.ts.net:443":{"Handlers":{"/":handler.clone()}}},"AllowFunnel":{"luna.tail-example.ts.net:443":false},"Note":"https://bad.ts.net"});
        assert_eq!(
            configured_urls(&v, "https://luna.tail-example.ts.net", 8090),
            Some(("https://luna.tail-example.ts.net".into(), false))
        );
        let public = json!({"Web":{"luna.tail-example.ts.net:443":{"Handlers":{"/":handler}}},"AllowFunnel":{"luna.tail-example.ts.net:443":true}});
        assert_eq!(
            configured_urls(&public, "https://luna.tail-example.ts.net", 8090),
            Some(("https://luna.tail-example.ts.net".into(), true))
        );
        assert_eq!(
            configured_urls(
                &json!({"Note":"https://bad.ts.net"}),
                "https://luna.tail-example.ts.net",
                8090
            ),
            None
        );
    }
}
