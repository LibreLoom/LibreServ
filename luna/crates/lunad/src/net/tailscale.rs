//! Product-managed Tailscale lifecycle. The node key lives beside Luna's data,
//! while the local API socket is private to lunad. No auth key is accepted here.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// The managed node is a singleton per lunad process. Serializing lifecycle and
// status commands prevents a poll from unlinking a live socket during startup.
static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
fn lifecycle() -> std::sync::MutexGuard<'static, ()> {
    LIFECYCLE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn cli() -> PathBuf {
    std::env::var_os("LUNA_TAILSCALE_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tailscale"))
}
fn daemon() -> PathBuf {
    std::env::var_os("LUNA_TAILSCALED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tailscaled"))
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

fn command(data: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("timeout")
        .args(["-k", "1", "-s", "TERM", "2"])
        .arg(cli())
        .arg("--socket")
        .arg(socket(data))
        .args(args)
        .output()
        .map_err(|e| format!("Tailscale is not installed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{} {}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .trim()
        .to_string());
    }
    if !out.stderr.is_empty() {
        tracing::warn!(detail = %String::from_utf8_lossy(&out.stderr).trim(), "Tailscale command warning");
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn ensure_daemon(data: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root(data)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root(data), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    clear_access_if_required(data)?;
    if socket(data).exists() && command(data, &["status", "--json"]).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket(data), std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if socket(data).exists() {
        let pid = std::fs::read_to_string(root(data).join("tailscaled.pid")).ok();
        let alive = pid
            .as_deref()
            .and_then(|p| p.trim().parse::<u32>().ok())
            .is_some_and(|p| managed_daemon_pid(data, p));
        if alive {
            return Err("Tailscale is starting but not responding yet.".into());
        }
        std::fs::remove_file(socket(data)).map_err(|e| e.to_string())?;
    }
    let mut child = Command::new(daemon())
        .args(["--state"])
        .arg(state(data))
        .args(["--socket"])
        .arg(socket(data))
        .args(["--tun=userspace-networking"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start Tailscale: {e}"))?;
    if let Err(error) = std::fs::write(root(data).join("tailscaled.pid"), child.id().to_string()) {
        let _ = child.kill();
        let _ = child.wait();
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
        if socket(data).exists() {
            std::fs::set_permissions(socket(data), std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Tailscale did not start.".into());
    }
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
    if port == 0 {
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
            out["error"] =
                json!("Tailscale could not read its connection status. Try reconnecting.");
            return out;
        }
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        out["state"] = json!("error");
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
    if backend == "NeedsMachineAuth" {
        out["auth_url"] = json!("https://login.tailscale.com/admin/machines");
    } else if backend == "NeedsLogin" {
        let current = parsed.get("AuthURL").and_then(Value::as_str).unwrap_or("");
        out["auth_url"] = json!(current);
        if current.is_empty() {
            let _ = std::fs::remove_file(root(data).join("auth-url"));
        } else {
            let _ = std::fs::write(root(data).join("auth-url"), current);
        }
    } else {
        let _ = std::fs::remove_file(root(data).join("auth-url"));
    }
    if let Ok(funnel) = command(data, &["serve", "status", "--json"])
        && let Ok(v) = serde_json::from_str::<Value>(&funnel)
        && let Some((url, is_public)) = configured_urls(&v, &dns, port)
    {
        if backend == "Running" {
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
    let _guard = lifecycle();
    require_proxy(port)?;
    ensure_daemon(data)?;
    std::fs::write(root(data).join("enabled"), b"1").map_err(|e| e.to_string())?;
    let raw = match command(
        data,
        &["up", "--accept-dns=false", "--json", "--timeout=2s"],
    ) {
        Ok(raw) => raw,
        Err(error) if save_auth_url(data, &error) => return Ok(status_json(data, port)),
        Err(error) => return Err(error),
    };
    if let Ok(v) = serde_json::from_str::<Value>(&raw)
        && let Some(url) = v.get("AuthURL").and_then(Value::as_str)
    {
        let _ = std::fs::write(root(data).join("auth-url"), url);
    }
    Ok(status_json(data, port))
}
pub fn reconnect(data: &Path, port: u16) -> Result<Value, String> {
    let _guard = lifecycle();
    if !enabled(data) {
        return Err("Connect Tailscale first.".into());
    }
    require_proxy(port)?;
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    stop_daemon(data)?;
    let _ = std::fs::remove_file(root(data).join("stop-failed"));
    ensure_daemon(data)?;
    let raw = match command(
        data,
        &["up", "--accept-dns=false", "--json", "--timeout=2s"],
    ) {
        Ok(raw) => raw,
        Err(error) if save_auth_url(data, &error) => return Ok(status_json(data, port)),
        Err(error) => return Err(error),
    };
    if let Ok(v) = serde_json::from_str::<Value>(&raw)
        && let Some(url) = v.get("AuthURL").and_then(Value::as_str)
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
    std::fs::write(root(data).join("auth-url"), url).is_ok()
}
pub fn serve(data: &Path, port: u16, public: bool) -> Result<Value, String> {
    let _guard = lifecycle();
    serve_inner(data, port, public)
}

fn serve_inner(data: &Path, port: u16, public: bool) -> Result<Value, String> {
    if !enabled(data) {
        return Err("Connect Tailscale first.".into());
    }
    require_proxy(port)?;
    ensure_daemon(data)?;
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    let _ = command(data, &["up", "--accept-dns=false", "--timeout=2s"])?;
    if public {
        match command(
            data,
            &[
                "funnel",
                "--bg",
                "--https=443",
                &format!("http://127.0.0.1:{port}"),
            ],
        ) {
            Ok(out) => {
                if let Some(url) = extract_url(&out) {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"funnel");
                }
            }
            Err(e) => {
                if let Some(url) = extract_url(&e) {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"funnel");
                    return Ok(status_json(data, port));
                }
                return Err(e);
            }
        }
    } else {
        command(data, &["serve", "reset"])?;
        match command(
            data,
            &[
                "serve",
                "--bg",
                "--https=443",
                &format!("http://127.0.0.1:{port}"),
            ],
        ) {
            Ok(out) => {
                if let Some(url) = extract_url(&out) {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"https");
                }
            }
            Err(e) => {
                if let Some(url) = extract_url(&e) {
                    let _ = std::fs::write(root(data).join("approval-url"), url);
                    let _ = std::fs::write(root(data).join("approval-type"), b"https");
                    return Ok(status_json(data, port));
                }
                return Err(e);
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
fn configured_urls(value: &Value, dns: &str, port: u16) -> Option<(String, bool)> {
    let web = value.get("Web")?.as_object()?;
    let allow = value.get("AllowFunnel").and_then(Value::as_object);
    web.keys().find_map(|listener| {
        let host = listener.strip_suffix(":443").unwrap_or(listener);
        let hostname = host.split(':').next()?;
        if !hostname.to_ascii_lowercase().ends_with(".ts.net") || hostname.contains('/') {
            return None;
        }
        let public = allow
            .and_then(|m| m.get(listener))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let listener_config = web.get(listener)?.as_object()?;
        let handlers = listener_config.get("Handlers")?.as_object()?;
        let expected = format!("http://127.0.0.1:{port}");
        if !handlers
            .values()
            .any(|handler| handler.get("Proxy").and_then(Value::as_str) == Some(expected.as_str()))
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
    command(data, &["serve", "reset"])?;
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
        let message =
            "Tailscale may still be reachable. Restart Luna before removing its saved identity.";
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
        Err(e) => Err(e.to_string()),
    }
}

fn stop_daemon(data: &Path) -> Result<(), String> {
    let pid = std::fs::read_to_string(root(data).join("tailscaled.pid"))
        .ok()
        .and_then(|pid| pid.trim().parse::<u32>().ok());
    let Some(pid) = pid.filter(|p| managed_daemon_pid(data, *p)) else {
        return verify_socket_stopped(data);
    };
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    for _ in 0..40 {
        if !managed_daemon_pid(data, pid) && verify_socket_stopped(data).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("Tailscale did not stop; its saved identity was kept.".into())
}

fn verify_socket_stopped(data: &Path) -> Result<(), String> {
    if !socket(data).exists() {
        return Ok(());
    }
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
    let result = disable_inner(data, port)?;
    if result["residual_exposure"] == true {
        return Err(result["error"]
            .as_str()
            .unwrap_or("Tailscale could not be stopped.")
            .to_string());
    }
    for path in [
        state(data),
        socket(data),
        root(data).join("tailscaled.pid"),
        root(data).join("reset-required"),
        root(data).join("last-error"),
        root(data).join("stop-failed"),
    ] {
        remove_if_present(&path)?;
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
    let _guard = lifecycle();
    let was_enabled = enabled(data);
    let mode = std::fs::read_to_string(root(data).join("serve-mode"))
        .or_else(|_| std::fs::read_to_string(root(data).join("restore-serve")))
        .unwrap_or_default();
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

/// Restore only on startup, never on each status poll. Run off the async main
/// thread so a missing or broken optional daemon cannot delay Luna's web app.
pub fn restore(data: &Path, port: u16) {
    let _guard = lifecycle();
    if !enabled(data) {
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
    fn failed_reset_marker_write_still_clears_enabled_intent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
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
            .prefix("tailscale space ")
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
        let off = disable(dir.path(), 8090).unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(off["residual_exposure"], true);
        assert_eq!(off["state"], "error");
        assert!(forget(dir.path(), 8090).is_err());
        assert!(state(dir.path()).exists());
        drop(listener);
        forget(dir.path(), 8090).unwrap();
        unsafe {
            std::env::remove_var("LUNA_TAILSCALE_CLI");
        }
    }

    #[test]
    fn failed_optional_proxy_is_visible_even_when_tailscale_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let status = status(dir.path(), 0);
        assert_eq!(status["state"], "error");
        assert!(!status["error"].as_str().unwrap().is_empty());
        assert_eq!(status["enabled"], false);
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
    fn mock_cli_exercises_userspace_connect_and_private_serve() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tailscale-mock");
        let daemon = dir.path().join("tailscaled-mock");
        let ready = dir.path().join("ready");
        let served = dir.path().join("served");
        std::fs::write(&cli, format!("#!/bin/sh\ncase \"$*\" in\n  *'serve status --json'*) if [ -f '{}' ]; then echo '{{\"Web\":{{\"luna.tail-example.ts.net:443\":{{\"Handlers\":{{\"/\":{{\"Proxy\":\"http://127.0.0.1:8090\"}}}}}}}},\"AllowFunnel\":{{\"luna.tail-example.ts.net:443\":false}}}}'; else echo '{{}}'; fi ;;\n  *'serve --bg'*) touch '{}' ;;\n  *'status --json'*) [ -f '{}' ] || exit 1; echo '{{\"BackendState\":\"Running\",\"Self\":{{\"DNSName\":\"luna.tail-example.ts.net.\"}}}}' ;;\n  *'up '* ) echo '{{\"AuthURL\":\"https://login.tailscale.com/a/test\"}}' ;;\nesac\n", served.display(), served.display(), ready.display())).unwrap();
        std::fs::write(&daemon, format!("#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --socket ] || [ \"$1\" = --state ]; then touch \"$2\"; fi; shift; done\ntouch '{}'\n", ready.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o700)).unwrap();
        unsafe {
            std::env::set_var("LUNA_TAILSCALE_CLI", &cli);
            std::env::set_var("LUNA_TAILSCALED", &daemon);
        }
        let status = connect(dir.path(), 8090).unwrap();
        assert_eq!(status["state"], "connected");
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
    fn broken_tailscale_can_be_disabled_and_forgotten_without_starting_it() {
        let _env = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(root(dir.path())).unwrap();
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
