//! Luna HTTP client shared by the desktop commands.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::dest::LunaRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drive {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
}

pub fn plain_connect_error(err: &ureq::Error) -> String {
    let text = err.to_string();
    if text.contains("Connection refused")
        || text.contains("failed to connect")
        || text.contains("Name or service not known")
        || text.contains("Temporary failure")
        || text.contains("timed out")
        || text.contains("Network is unreachable")
    {
        "Luna couldn't be reached. Check the address and that Luna is on, then try again.".into()
    } else if text.contains("401") || text.contains("status code 401") {
        "That username or password didn't work. Check them and try again.".into()
    } else if text.contains("403") || text.contains("status code 403") {
        "You don't have permission to do that on Luna.".into()
    } else {
        format!("Something went wrong talking to Luna. {text}")
    }
}

pub fn login(base_url: &str, username: &str, password: &str) -> Result<String, String> {
    let cookies = session_login_cookies(base_url, username, password)?;
    let token = create_device_token(base_url, &cookies, "Luna Desktop")?;
    let _ = drop_session_cookie(base_url, &cookies);
    Ok(token)
}

struct SessionCookies {
    /// Full Cookie header value: `luna_session=…; luna_csrf=…`
    cookie_header: String,
    csrf: Option<String>,
}

fn session_login_cookies(
    base_url: &str,
    username: &str,
    password: &str,
) -> Result<SessionCookies, String> {
    let body = serde_json::json!({ "username": username, "password": password });
    let resp = ureq::post(&format!(
        "{}/api/v1/auth/login",
        base_url.trim_end_matches('/')
    ))
    .send_json(body)
    .map_err(|e| plain_connect_error(&e))?;
    if resp.status() == 401 {
        return Err("That username or password didn't work. Check them and try again.".into());
    }
    if !resp.status().is_success() {
        return Err("Luna couldn't sign you in. Check the address and try again.".into());
    }
    let mut session = None;
    let mut csrf = None;
    for value in resp.headers().get_all("set-cookie") {
        let Ok(raw) = value.to_str() else { continue };
        let pair = raw.split(';').next().unwrap_or("").trim();
        if let Some(rest) = pair.strip_prefix("luna_session=") {
            session = Some(format!("luna_session={rest}"));
        } else if let Some(rest) = pair.strip_prefix("luna_csrf=") {
            csrf = Some(rest.to_string());
        }
    }
    let session =
        session.ok_or_else(|| "Luna did not start a sign-in session. Try again.".to_string())?;
    let cookie_header = match &csrf {
        Some(token) => format!("{session}; luna_csrf={token}"),
        None => session,
    };
    Ok(SessionCookies {
        cookie_header,
        csrf,
    })
}

fn create_device_token(
    base_url: &str,
    cookies: &SessionCookies,
    name: &str,
) -> Result<String, String> {
    let body = serde_json::json!({ "name": name });
    let mut req = ureq::post(&format!(
        "{}/api/v1/device-tokens",
        base_url.trim_end_matches('/')
    ))
    .header("Cookie", &cookies.cookie_header);
    if let Some(csrf) = &cookies.csrf {
        req = req.header("X-CSRF-Token", csrf);
    }
    let mut resp = req.send_json(body).map_err(|e| plain_connect_error(&e))?;
    if resp.status() == 403 {
        return Err("Luna blocked the sign-in request. Check the address and try again.".into());
    }
    if !resp.status().is_success() {
        return Err("Luna did not return an access token. Try again.".into());
    }
    let value: serde_json::Value = resp
        .body_mut()
        .read_json()
        .map_err(|_| "Luna did not return an access token.".to_string())?;
    value
        .get("token")
        .and_then(|t| t.as_str())
        .map(String::from)
        .ok_or_else(|| "Luna did not return an access token.".to_string())
}

fn drop_session_cookie(base_url: &str, cookies: &SessionCookies) -> Result<(), String> {
    let mut req = ureq::post(&format!(
        "{}/api/v1/auth/logout",
        base_url.trim_end_matches('/')
    ))
    .header("Cookie", &cookies.cookie_header);
    if let Some(csrf) = &cookies.csrf {
        req = req.header("X-CSRF-Token", csrf);
    }
    req.send_empty().map_err(|e| plain_connect_error(&e))?;
    Ok(())
}

fn auth_get(
    base_url: &str,
    token: &str,
    path: &str,
) -> Result<ureq::http::Response<ureq::Body>, String> {
    ureq::get(&format!("{}{path}", base_url.trim_end_matches('/')))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| plain_connect_error(&e))
}

/// Who this access token belongs to. Used when signing in with a pasted token.
pub fn auth_me(base_url: &str, token: &str) -> Result<(String, String), String> {
    let mut resp = auth_get(base_url, token, "/api/v1/auth/me")?;
    if resp.status() == 401 {
        return Err(
            "That access token didn't work. Create a new one in Luna → Settings → Apps and access tokens."
                .into(),
        );
    }
    if !resp.status().is_success() {
        return Err("Luna couldn't check that access token. Try again.".into());
    }
    let value: serde_json::Value = resp
        .body_mut()
        .read_json()
        .map_err(|_| "Luna returned a bad sign-in reply.".to_string())?;
    if value.is_null() {
        return Err(
            "That access token didn't work. Create a new one in Luna → Settings → Apps and access tokens."
                .into(),
        );
    }
    let username = value
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "That access token didn't work. Create a new one in Luna → Settings → Apps and access tokens."
                .to_string()
        })?
        .to_string();
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((username, id))
}

pub fn list_drives(base_url: &str, token: &str) -> Result<Vec<Drive>, String> {
    let mut resp = auth_get(base_url, token, "/api/v1/drives")?;
    if resp.status() == 401 {
        return Err("unauthorized".into());
    }
    if !resp.status().is_success() {
        return Err("Luna couldn't list your drives. Try again.".into());
    }
    let values: Vec<serde_json::Value> = resp
        .body_mut()
        .read_json()
        .map_err(|_| "Luna returned a bad drive list.".to_string())?;
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

pub fn list_files(
    base_url: &str,
    token: &str,
    drive_id: &str,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    let enc = urlencoding_path(path);
    let mut resp = auth_get(
        base_url,
        token,
        &format!("/api/v1/drives/{drive_id}/files?path={enc}"),
    )?;
    if resp.status() == 401 {
        return Err("unauthorized".into());
    }
    if resp.status() == 403 {
        return Err("You don't have permission to view this folder.".into());
    }
    if !resp.status().is_success() {
        return Err("Luna couldn't open that folder. Try again.".into());
    }
    let values: Vec<serde_json::Value> = resp
        .body_mut()
        .read_json()
        .map_err(|_| "Luna returned a bad folder listing.".to_string())?;
    Ok(values
        .into_iter()
        .filter_map(|v| {
            Some(FileEntry {
                name: v.get("name")?.as_str()?.to_string(),
                kind: v.get("kind")?.as_str()?.to_string(),
                size: v.get("size")?.as_u64().unwrap_or(0),
                modified: v.get("modified")?.as_i64().unwrap_or(0),
            })
        })
        .collect())
}

pub fn mkdir(base_url: &str, token: &str, drive_id: &str, path: &str) -> Result<(), String> {
    let body = serde_json::json!({ "path": path });
    let resp = ureq::post(&format!(
        "{}/api/v1/drives/{drive_id}/files/mkdir",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_json(body)
    .map_err(|e| plain_connect_error(&e))?;
    match resp.status().as_u16() {
        200 => Ok(()),
        401 => Err("unauthorized".into()),
        403 => Err("You don't have permission to create a folder here.".into()),
        409 => Err("A folder with this name is already here. Choose another name.".into()),
        404 => Err("Luna can't find the parent folder. Open it and try again.".into()),
        _ => Err("Luna couldn't create that folder. Try again.".into()),
    }
}

pub fn delete_path(base_url: &str, token: &str, drive_id: &str, path: &str) -> Result<(), String> {
    let enc = urlencoding_path(path);
    let resp = ureq::delete(&format!(
        "{}/api/v1/drives/{drive_id}/files?path={enc}",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .call()
    .map_err(|e| plain_connect_error(&e))?;
    match resp.status().as_u16() {
        200 => Ok(()),
        401 => Err("unauthorized".into()),
        404 => Ok(()), // already gone
        _ => Err("Luna couldn't remove that file. Try again.".into()),
    }
}

pub fn download_file(
    base_url: &str,
    token: &str,
    drive_id: &str,
    path: &str,
    dest: &Path,
) -> Result<(), String> {
    let enc = urlencoding_path(path);
    let mut resp = auth_get(
        base_url,
        token,
        &format!("/api/v1/drives/{drive_id}/files/content?path={enc}&download=1"),
    )?;
    if resp.status() == 401 {
        return Err("unauthorized".into());
    }
    if !resp.status().is_success() {
        return Err("Luna couldn't download that file. Try again.".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| {
            "Couldn't create a folder on this computer for the download.".to_string()
        })?;
    }
    let tmp = dest.with_extension("luna-download-tmp");
    {
        let mut file = std::fs::File::create(&tmp)
            .map_err(|_| "Couldn't write the downloaded file on this computer.".to_string())?;
        let mut body = resp.body_mut().as_reader();
        std::io::copy(&mut body, &mut file)
            .map_err(|_| "Couldn't finish downloading that file.".to_string())?;
    }
    std::fs::rename(&tmp, dest)
        .map_err(|_| "Couldn't save the downloaded file on this computer.".to_string())?;
    Ok(())
}

const CHUNK: usize = 1024 * 1024;

pub fn upload_file(
    base_url: &str,
    token: &str,
    dest: &LunaRef,
    local: &Path,
    remote_rel: &str,
) -> Result<(), String> {
    let meta = std::fs::metadata(local)
        .map_err(|_| "Couldn't read that file on this computer.".to_string())?;
    let size = meta.len();
    let name = local
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let full = if dest.path.is_empty() {
        remote_rel.to_string()
    } else if remote_rel.is_empty() {
        format!("{}/{}", dest.path, name)
    } else {
        format!("{}/{}", dest.path, remote_rel)
    };
    let dest_dir = full.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let file_name = full.rsplit('/').next().unwrap_or(&name);

    let mut created = ureq::post(&format!(
        "{}/api/v1/uploads",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_json(serde_json::json!({
        "drive_id": dest.drive_id,
        "path": dest_dir,
        "name": file_name,
        "size": size
    }))
    .map_err(|e| plain_connect_error(&e))?;
    if created.status() == 401 {
        return Err("unauthorized".into());
    }
    if !created.status().is_success() {
        return Err("Luna couldn't start the upload. Try again.".into());
    }
    let created_val: serde_json::Value = created
        .body_mut()
        .read_json()
        .map_err(|_| "Luna didn't return an upload id.".to_string())?;
    let upload_id = created_val
        .get("upload_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Luna didn't return an upload id.".to_string())?;

    let mut file = std::fs::File::open(local)
        .map_err(|_| "Couldn't open that file on this computer.".to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let mut start: u64 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|_| "Couldn't read that file on this computer.".to_string())?;
        if n == 0 {
            break;
        }
        let end = start + n as u64 - 1;
        let resp = ureq::put(&format!(
            "{}/api/v1/uploads/{upload_id}",
            base_url.trim_end_matches('/')
        ))
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Range", &format!("bytes {start}-{end}/{size}"))
        .header("Content-Type", "application/octet-stream")
        .send(&buf[..n])
        .map_err(|e| plain_connect_error(&e))?;
        if !resp.status().is_success() {
            return Err("Luna couldn't accept part of the upload. Try again.".into());
        }
        start += n as u64;
    }

    let complete = ureq::post(&format!(
        "{}/api/v1/uploads/{upload_id}/complete",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_empty()
    .map_err(|e| plain_connect_error(&e))?;
    match complete.status().as_u16() {
        200 | 201 => Ok(()),
        409 => Ok(()),
        _ => Err("Luna couldn't finish the upload. Try again.".into()),
    }
}

fn urlencoding_path(path: &str) -> String {
    path.split('/')
        .map(|p| {
            let mut out = String::new();
            for b in p.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        out.push(b as char)
                    }
                    _ => out.push_str(&format!("%{b:02X}")),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("%2F")
}

/// Recursively list files under a Luna folder as (relative path, entry).
pub fn walk_remote_files(
    base_url: &str,
    token: &str,
    drive_id: &str,
    root_path: &str,
) -> Result<Vec<(String, FileEntry)>, String> {
    let mut out = Vec::new();
    walk_remote_rec(base_url, token, drive_id, root_path, "", &mut out)?;
    Ok(out)
}

fn walk_remote_rec(
    base_url: &str,
    token: &str,
    drive_id: &str,
    abs_path: &str,
    rel: &str,
    out: &mut Vec<(String, FileEntry)>,
) -> Result<(), String> {
    let entries = list_files(base_url, token, drive_id, abs_path)?;
    for e in entries {
        if e.name.starts_with('.') {
            continue;
        }
        let child_rel = if rel.is_empty() {
            e.name.clone()
        } else {
            format!("{rel}/{}", e.name)
        };
        let child_abs = if abs_path.is_empty() {
            e.name.clone()
        } else {
            format!("{abs_path}/{}", e.name)
        };
        if e.kind == "dir" {
            walk_remote_rec(base_url, token, drive_id, &child_abs, &child_rel, out)?;
        } else if e.kind == "file" {
            out.push((child_rel, e));
        }
    }
    Ok(())
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
                    "Set-Cookie: luna_session=sess-cookie; Path=/\r\nSet-Cookie: luna_csrf=csrf-tok; Path=/\r\n"
                } else {
                    ""
                };
                let (status, body) = if req.contains("/api/v1/auth/login") {
                    (
                        200,
                        r#"{"ok":true,"id":"u1","username":"max","display_name":"Max","role":"admin"}"#
                            .to_string(),
                    )
                } else if req.contains("/api/v1/auth/me") {
                    assert!(
                        req.to_ascii_lowercase()
                            .contains("authorization: bearer device-tok-456"),
                        "auth/me must send Bearer access token"
                    );
                    (200, r#"{"id":"u1","username":"max","role":"admin"}"#.to_string())
                } else if req.contains("/api/v1/auth/logout") {
                    assert!(
                        req.to_ascii_lowercase().contains("x-csrf-token: csrf-tok"),
                        "logout must send CSRF"
                    );
                    (200, r#"{"ok":true}"#.to_string())
                } else if req.contains("/api/v1/device-tokens") {
                    assert!(
                        req.to_ascii_lowercase()
                            .contains("cookie: luna_session=sess-cookie"),
                        "device-token mint must reuse the login session cookie"
                    );
                    assert!(
                        req.to_ascii_lowercase().contains("x-csrf-token: csrf-tok"),
                        "device-token mint must send CSRF"
                    );
                    assert!(
                        req.to_ascii_lowercase().contains("luna_csrf=csrf-tok"),
                        "device-token mint must include csrf cookie"
                    );
                    (
                        200,
                        r#"{"id":"dt-1","name":"Luna Desktop","token":"device-tok-456","revoked":false}"#.to_string(),
                    )
                } else if req.contains("/api/v1/drives") && !req.contains("/files") {
                    (200, r#"[{"id":"a","label":"Photos Drive","state":"as_is","fs_type":"ext4","device":"sda","mount_point":"/x"}]"#.to_string())
                } else if req.contains("/files/mkdir") {
                    (200, r#"{"ok":true}"#.to_string())
                } else if req.contains("/files") {
                    (
                        200,
                        r#"[{"name":"Family","kind":"dir","size":0,"modified":1,"hidden":false}]"#
                            .to_string(),
                    )
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
    fn access_token_auth_me_and_drives() {
        let (base, handle, stop) = spawn_server();
        let (username, id) = auth_me(&base, "device-tok-456").unwrap();
        assert_eq!(username, "max");
        assert_eq!(id, "u1");
        let drives = list_drives(&base, "device-tok-456").unwrap();
        assert_eq!(drives[0].label, "Photos Drive");
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(handle);
    }

    #[test]
    fn list_files_and_mkdir_speak_api() {
        let (base, handle, stop) = spawn_server();
        let token = login(&base, "max", "hunter22hunter").unwrap();
        let files = list_files(&base, &token, "a", "").unwrap();
        assert_eq!(files[0].name, "Family");
        mkdir(&base, &token, "a", "Family/New").unwrap();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(handle);
    }
}
