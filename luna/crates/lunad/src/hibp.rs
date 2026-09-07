//! Have I Been Pwned (k-anonymity) check for account passwords.
//!
//! Mirrors LibreServ `rejectBreachedPassword`: only the first 5 hex chars of
//! the SHA-1 hash leave the device; fails open on any API/network error so
//! password changes are never blocked by an outage.

use std::sync::Mutex;
use std::time::Duration;

use sha1::{Digest, Sha1};

use crate::password::PasswordValidationError;

/// Same plain-language copy as LibreServ.
pub const BREACHED_PASSWORD_MESSAGE: &str = "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password.";

const DEFAULT_HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";

static HIBP_RANGE_URL: Mutex<String> = Mutex::new(String::new());

/// Override the HIBP range endpoint (tests only).
pub fn set_hibp_range_url(url: impl Into<String>) {
    if let Ok(mut guard) = HIBP_RANGE_URL.lock() {
        *guard = url.into();
    }
}

fn hibp_range_url() -> String {
    HIBP_RANGE_URL
        .lock()
        .ok()
        .and_then(|g| {
            if g.is_empty() {
                None
            } else {
                Some(g.clone())
            }
        })
        .unwrap_or_else(|| {
            // Unit/integration tests stay hermetic: unreachable URL → fail open
            // unless a test installs a stub via set_hibp_range_url.
            if cfg!(test) {
                "http://127.0.0.1:1/range/".to_string()
            } else {
                DEFAULT_HIBP_RANGE_URL.to_string()
            }
        })
}

/// Returns true when `pw` appears in known data breaches.
/// On any API/network error returns `Err` so callers can fail open.
pub fn check_breached_password(pw: &str) -> Result<bool, String> {
    let mut hasher = Sha1::new();
    hasher.update(pw.as_bytes());
    let full = hex_upper(&hasher.finalize());
    let (prefix, suffix) = full.split_at(5);

    let url = format!("{}{}", hibp_range_url(), prefix);
    let mut response = ureq::get(&url)
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .timeout_connect(Some(Duration::from_secs(3)))
        .build()
        .header("User-Agent", "Luna")
        .call()
        .map_err(|e| e.to_string())?;

    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("hibp range api returned {status}"));
    }

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;

    for line in body.lines() {
        if let Some((hash_suffix, _)) = line.split_once(':') {
            if hash_suffix.eq_ignore_ascii_case(suffix) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Reject passwords that appear in known breaches. Fails open on HIBP errors.
pub fn ensure_password_not_breached(pw: &str) -> Result<(), PasswordValidationError> {
    match check_breached_password(pw) {
        Ok(true) => Err(PasswordValidationError(BREACHED_PASSWORD_MESSAGE)),
        Ok(false) => Ok(()),
        Err(err) => {
            tracing::warn!(error = %err, "HIBP breach check skipped");
            Ok(())
        }
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn serve_range_once(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        });
        format!("http://{addr}/range/")
    }

    #[test]
    fn detects_breached_password() {
        // SHA-1("password123") prefix is 482C3; stub returns the matching suffix.
        let full = {
            let mut hasher = Sha1::new();
            hasher.update(b"password123");
            hex_upper(&hasher.finalize())
        };
        let suffix = &full[5..];
        let url = serve_range_once(Box::leak(format!("{suffix}:999\nDEADBEEF:1\n").into_boxed_str()));
        set_hibp_range_url(url);
        assert_eq!(check_breached_password("password123").unwrap(), true);
        set_hibp_range_url("");
    }

    #[test]
    fn clean_password_ok() {
        let url = serve_range_once("DEADBEEF:1\nCAFEBABE:2\n");
        set_hibp_range_url(url);
        assert_eq!(check_breached_password("Tr0ub4dor&3-Good!").unwrap(), false);
        set_hibp_range_url("");
    }

    #[test]
    fn fails_open_on_unreachable() {
        set_hibp_range_url("http://127.0.0.1:1/range/");
        assert!(ensure_password_not_breached("whatever12345").is_ok());
        set_hibp_range_url("");
    }

    #[test]
    fn reject_message_matches_libreserv() {
        let full = {
            let mut hasher = Sha1::new();
            hasher.update(b"password123");
            hex_upper(&hasher.finalize())
        };
        let suffix = &full[5..];
        let url = serve_range_once(Box::leak(format!("{suffix}:1\n").into_boxed_str()));
        set_hibp_range_url(url);
        let err = ensure_password_not_breached("password123").unwrap_err();
        assert_eq!(err.message(), BREACHED_PASSWORD_MESSAGE);
        set_hibp_range_url("");
    }
}
