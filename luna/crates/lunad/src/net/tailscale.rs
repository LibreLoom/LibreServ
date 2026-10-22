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

const VERSION: &str = "1.104.2";

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
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start Tailscale: {e}"))?;
    let _ = std::fs::write(root(data).join("tailscaled.pid"), child.id().to_string());
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

fn status_json(data: &Path, port: u16) -> Value {
    let mut out = json!({"installed": cli().exists() || Command::new(cli()).arg("version").output().is_ok(), "enabled": enabled(data), "identity_saved": state(data).exists(), "state":"off", "private_url":"", "public_url":"", "auth_url":"", "approval_url":"", "error":"", "version":VERSION, "public_supported":true});
    if let Ok(url) = std::fs::read_to_string(root(data).join("approval-url")) {
        out["approval_url"] = json!(url.trim());
    }
    if let Ok(kind) = std::fs::read_to_string(root(data).join("approval-type")) {
        out["approval_type"] = json!(kind.trim());
    }
    if !enabled(data) {
        return out;
    }
    if ensure_daemon(data).is_err() {
        out["state"] = json!("error");
        out["error"] = json!("Tailscale could not start. Try reconnecting.");
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
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
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
    if let Ok(funnel) = command(data, &["funnel", "status", "--json"])
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
    if !enabled(data) {
        return Err("Connect Tailscale first.".into());
    }
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
        command(data, &["funnel", "reset"])?;
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
fn disable_inner(data: &Path, port: u16) -> Result<Value, String> {
    if enabled(data) {
        ensure_daemon(data)?;
        command(data, &["funnel", "reset"])?;
        command(data, &["serve", "reset"])?;
        command(data, &["down"])?;
    }
    let _ = std::fs::remove_file(root(data).join("enabled"));
    let _ = std::fs::remove_file(root(data).join("private-enabled"));
    let _ = std::fs::remove_file(root(data).join("auth-url"));
    let _ = std::fs::remove_file(root(data).join("approval-url"));
    let _ = std::fs::remove_file(root(data).join("approval-type"));
    Ok(status_json(data, port))
}
pub fn forget(data: &Path, port: u16) -> Result<Value, String> {
    let _guard = lifecycle();
    let _ = disable_inner(data, port)?;
    if socket(data).exists() {
        let _ = command(data, &["logout"]);
    }
    if let Ok(pid) = std::fs::read_to_string(root(data).join("tailscaled.pid")) {
        let owned = pid
            .trim()
            .parse::<u32>()
            .ok()
            .is_some_and(|p| managed_daemon_pid(data, p));
        if owned {
            let _ = Command::new("kill").arg(pid.trim()).status();
            let process_id = pid.trim().parse::<u32>().ok();
            let mut stopped = false;
            for _ in 0..40 {
                if process_id.is_none_or(|p| !managed_daemon_pid(data, p)) {
                    stopped = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !stopped {
                return Err("Tailscale did not stop; its saved identity was kept.".into());
            }
        }
    }
    let _ = std::fs::remove_file(state(data));
    let _ = std::fs::remove_file(socket(data));
    let _ = std::fs::remove_file(root(data).join("tailscaled.pid"));
    Ok(status_json(data, port))
}

fn managed_daemon_pid(data: &Path, pid: u32) -> bool {
    let cmdline = format!("/proc/{pid}/cmdline");
    std::fs::read_to_string(cmdline)
        .map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            fields
                .first()
                .is_some_and(|exe| Path::new(exe).file_name() == daemon().file_name())
                && line.contains(&state(data).to_string_lossy().to_string())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn mock_cli_exercises_userspace_connect_and_private_serve() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tailscale-mock");
        let daemon = dir.path().join("tailscaled-mock");
        let ready = dir.path().join("ready");
        let served = dir.path().join("served");
        std::fs::write(&cli, format!("#!/bin/sh\ncase \"$*\" in\n  *'funnel status --json'*) if [ -f '{}' ]; then echo '{{\"Web\":{{\"luna.tail-example.ts.net:443\":{{\"Handlers\":{{\"/\":{{\"Proxy\":\"http://127.0.0.1:8090\"}}}}}}}},\"AllowFunnel\":{{\"luna.tail-example.ts.net:443\":false}}}}'; else echo '{{}}'; fi ;;\n  *'serve --bg'*) touch '{}' ;;\n  *'status --json'*) [ -f '{}' ] || exit 1; echo '{{\"BackendState\":\"Running\",\"Self\":{{\"DNSName\":\"luna.tail-example.ts.net.\"}}}}' ;;\n  *'up '* ) echo '{{\"AuthURL\":\"https://login.tailscale.com/a/test\"}}' ;;\nesac\n", served.display(), served.display(), ready.display())).unwrap();
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
