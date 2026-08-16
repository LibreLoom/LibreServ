//! Luna HTTP client shared by the desktop commands.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Drive {
    pub id: String,
    pub label: String,
}

pub fn login(base_url: &str, username: &str, password: &str) -> anyhow::Result<String> {
    let body = serde_json::json!({ "username": username, "password": password });
    let value: serde_json::Value = ureq::post(&format!("{}/api/v1/auth/login", base_url.trim_end_matches('/')))
        .send_json(body)?
        .body_mut()
        .read_json()?;
    value
        .get("token")
        .and_then(|t| t.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("Luna did not return a session"))
}

pub fn list_drives(base_url: &str, token: &str) -> anyhow::Result<Vec<Drive>> {
    let values: Vec<serde_json::Value> = ureq::get(&format!("{}/api/v1/drives", base_url.trim_end_matches('/')))
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
pub fn mount_instructions(base_url: &str, _token: &str, drive_id: &str) -> Result<String, String> {
    let url = format!("{}/dav/{drive_id}", base_url.trim_end_matches('/'));
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("gio")
            .args(["mount", &url])
            .output();
        match status {
            Ok(out) if out.status.success() => Ok("Mounted. Look in your file manager.".into()),
            _ => Ok(format!("Luna couldn't mount automatically. Open {url} in your file manager's “Connect to Server”.")),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).output();
        Ok(format!("Finder is opening {url}. Use Connect to Server if it doesn't appear."))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", &url])
            .output();
        Ok(format!("Windows is opening {url}. You can also map it as a network drive."))
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn spawn_server() -> (String, std::thread::JoinHandle<()>, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop2 = stop.clone();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if stop2.load(std::sync::atomic::Ordering::Relaxed) { break; }
                let mut buf = [0u8; 4096];
                let mut s = stream;
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if req.contains("/api/v1/auth/login") {
                    (200, r#"{"token":"tok-123","username":"max","role":"admin"}"#.to_string())
                } else if req.contains("/api/v1/drives") {
                    (200, r#"[{"id":"a","label":"Photos Drive","state":"as_is","fs_type":"ext4","device":"sda","mount_point":"/x"}]"#.to_string())
                } else {
                    (404, "{}".to_string())
                };
                let resp = format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}"), handle, stop)
    }

    #[test]
    fn login_and_drive_list_speak_the_luna_api() {
        let (base, handle, stop) = spawn_server();
        let token = login(&base, "max", "hunter22hunter").unwrap();
        assert_eq!(token, "tok-123");
        let drives = list_drives(&base, &token).unwrap();
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].id, "a");
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(handle); // detached; test process exit cleans it up
    }
}
