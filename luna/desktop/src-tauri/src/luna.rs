//! Luna HTTP client shared by the desktop commands.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Drive {
    pub id: String,
    pub label: String,
}

pub fn login(base_url: &str, username: &str, password: &str) -> anyhow::Result<String> {
    let cookie = session_login_cookie(base_url, username, password)?;
    // Mint a long-lived device token and keep that — never store the
    // household password or the browser session JWT.
    let token = create_device_token(base_url, &cookie, "Luna Desktop")?;
    let _ = drop_session_cookie(base_url, &cookie);
    Ok(token)
}

fn session_login_cookie(base_url: &str, username: &str, password: &str) -> anyhow::Result<String> {
    let body = serde_json::json!({ "username": username, "password": password });
    let resp = ureq::post(&format!(
        "{}/api/v1/auth/login",
        base_url.trim_end_matches('/')
    ))
    .send_json(body)?;
    let set_cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok());
    luna_session_cookie(set_cookie)
        .ok_or_else(|| anyhow::anyhow!("Luna did not set a session cookie"))
}

fn luna_session_cookie(set_cookie: Option<&str>) -> Option<String> {
    let pair = set_cookie?.split(';').next()?.trim();
    pair.starts_with("luna_session=")
        .then(|| pair.to_string())
}

pub fn create_device_token(base_url: &str, cookie: &str, name: &str) -> anyhow::Result<String> {
    let body = serde_json::json!({ "name": name });
    let value: serde_json::Value = ureq::post(&format!(
        "{}/api/v1/device-tokens",
        base_url.trim_end_matches('/')
    ))
    .header("Cookie", cookie)
    .send_json(body)?
    .body_mut()
    .read_json()?;
    value
        .get("token")
        .and_then(|t| t.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("Luna did not return an access token"))
}

fn drop_session_cookie(base_url: &str, cookie: &str) -> anyhow::Result<()> {
    ureq::post(&format!(
        "{}/api/v1/auth/logout",
        base_url.trim_end_matches('/')
    ))
    .header("Cookie", cookie)
    .send_empty()?;
    Ok(())
}

pub fn list_drives(base_url: &str, token: &str) -> anyhow::Result<Vec<Drive>> {
    let values: Vec<serde_json::Value> =
        ureq::get(&format!("{}/api/v1/drives", base_url.trim_end_matches('/')))
            .header("Authorization", &format!("Bearer {token}"))
            .call()?
            .body_mut()
            .read_json()?;
    Ok(values
        .into_iter()
        .filter_map(|v| {
            Some(Drive {
                id: v.get("id")?.as_str()?.to_string(),
                label: v.get("label")?.as_str()?.to_string(),
            })
        })
        .collect())
}

/// One-click mount instructions per OS. On Linux this tries `gio mount`
/// first; on Windows/macOS it returns the native command for the user.
///
/// Finder/Explorer must use the access token as the password — never the
/// household password. Only an admin can mount a drive as a folder.
fn dav_mount_url(base_url: &str, drive_id: &str) -> Result<String, String> {
    if drive_id.is_empty()
        || !drive_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("That drive name is not valid.".to_string());
    }
    let parsed = url::Url::parse(base_url).map_err(|_| "Invalid Luna address.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Luna address must be http:// or https://".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Invalid Luna address.".to_string());
    }
    let url = format!("{}/dav/{drive_id}", base_url.trim_end_matches('/'));
    let opened = url::Url::parse(&url).map_err(|_| "Invalid Luna address.".to_string())?;
    if opened.scheme() != "http" && opened.scheme() != "https" {
        return Err("Luna address must be http:// or https://".to_string());
    }
    Ok(url)
}

pub fn mount_instructions(
    base_url: &str,
    token: &str,
    username: &str,
    drive_id: &str,
) -> Result<String, String> {
    let url = dav_mount_url(base_url, drive_id)?;
    let creds = format!(
        "Address: {url}. Username: {username}. Password: use this access token (not your household password): {token}"
    );
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("gio")
            .args(["mount", &url])
            .output();
        match status {
            Ok(out) if out.status.success() => {
                Ok(format!("Mounted. Look in your file manager. {creds}"))
            }
            _ => Ok(format!(
                "Luna couldn't mount automatically. Open {url} in your file manager's “Connect to Server”. {creds}"
            )),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).output();
        Ok(format!(
            "Finder is opening {url}. Use Connect to Server if it doesn't appear. {creds}"
        ))
    }
    #[cfg(target_os = "windows")]
    {
        // rundll32 avoids cmd.exe parsing of & | in the URL.
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .output();
        Ok(format!(
            "Windows is opening {url}. You can also map it as a network drive. {creds}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn spawn_server() -> (
        String,
        std::thread::JoinHandle<()>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop2 = stop.clone();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if stop2.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let mut buf = [0u8; 4096];
                let mut s = stream;
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let extra = if req.contains("/api/v1/auth/login") {
                    "Set-Cookie: luna_session=sess-cookie; Path=/\r\n"
                } else {
                    ""
                };
                let (status, body) = if req.contains("/api/v1/auth/login") {
                    (
                        200,
                        r#"{"ok":true,"id":"u1","username":"max","display_name":"Max","role":"admin"}"#
                            .to_string(),
                    )
                } else if req.contains("/api/v1/auth/logout") {
                    (200, r#"{"ok":true}"#.to_string())
                } else if req.contains("/api/v1/device-tokens") {
                    assert!(
                        req.to_ascii_lowercase()
                            .contains("cookie: luna_session=sess-cookie"),
                        "device-token mint must reuse the login session cookie"
                    );
                    assert!(
                        !req.to_ascii_lowercase()
                            .contains("authorization: bearer tok-"),
                        "must not mint with a JSON session JWT"
                    );
                    (
                        200,
                        r#"{"id":"dt-1","name":"Luna Desktop","token":"device-tok-456","revoked":false}"#.to_string(),
                    )
                } else if req.contains("/api/v1/drives") {
                    (200, r#"[{"id":"a","label":"Photos Drive","state":"as_is","fs_type":"ext4","device":"sda","mount_point":"/x"}]"#.to_string())
                } else {
                    (404, "{}".to_string())
                };
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}"), handle, stop)
    }

    #[test]
    fn dav_mount_url_rejects_shell_metacharacters() {
        assert!(dav_mount_url("http://luna.local", "photos").is_ok());
        assert!(dav_mount_url("javascript:alert(1)", "photos").is_err());
        assert!(dav_mount_url("http://luna.local", "a/../../etc").is_err());
        assert!(dav_mount_url("http://luna.local", "a&calc.exe").is_err());
    }

    #[test]
    fn luna_session_cookie_parses_set_cookie() {
        assert_eq!(
            luna_session_cookie(Some(
                "luna_session=sess-cookie; Path=/; HttpOnly; SameSite=Lax"
            )),
            Some("luna_session=sess-cookie".to_string())
        );
        assert_eq!(luna_session_cookie(Some("other=x")), None);
    }

    #[test]
    fn login_and_drive_list_speak_the_luna_api() {
        let (base, handle, stop) = spawn_server();
        let token = login(&base, "max", "hunter22hunter").unwrap();
        assert_eq!(token, "device-tok-456");
        let drives = list_drives(&base, &token).unwrap();
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].id, "a");
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(handle);
    }

    #[test]
    fn soak_fake_luna_api_repeated_login_and_drives() {
        let (base, handle, stop) = spawn_server();
        for _ in 0..25 {
            let token = login(&base, "max", "hunter22hunter").unwrap();
            assert_eq!(token, "device-tok-456");
            let drives = list_drives(&base, &token).unwrap();
            assert_eq!(drives[0].label, "Photos Drive");
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(handle);
    }
}
