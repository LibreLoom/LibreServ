//! Have I Been Pwned (k-anonymity) check for account passwords.
//!
//! Only the first 5 hex chars of the SHA-1 hash leave the device. The client
//! refuses redirects — a redirect would send the hash prefix to a host nobody
//! chose — and tries once more when the service does not answer, so a blip
//! does not leave a password unchecked.
//!
//! What happens when the service still cannot answer is the interesting
//! part. A Luna without internet is a normal Luna, and it has to stay able to
//! change a password, so an unreachable service does not block the change.
//! It is not silent either: the caller is told the check did not happen, so
//! the person hears it and can pick a different password.

use std::sync::Mutex;
use std::time::Duration;

use sha1::{Digest, Sha1};

/// Same plain-language copy as Sol.
pub const BREACHED_PASSWORD_MESSAGE: &str = "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password.";

/// What the person is told when the breach service could not answer and the
/// password was therefore allowed unchecked.
pub const BREACH_CHECK_UNAVAILABLE_MESSAGE: &str = "Luna couldn't check this password against known data breaches, so it was allowed. Please choose a different password if you can.";

const DEFAULT_HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";

/// How long one attempt may take before it counts as "no answer".
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(4);
/// The pause between the first attempt and the retry.
const RETRY_PAUSE: Duration = Duration::from_millis(250);

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
        .and_then(|g| if g.is_empty() { None } else { Some(g.clone()) })
        .unwrap_or_else(|| {
            // Unit/integration tests stay hermetic: unreachable URL → no
            // answer unless a test installs a stub via set_hibp_range_url.
            if cfg!(test) {
                "http://127.0.0.1:1/range/".to_string()
            } else {
                DEFAULT_HIBP_RANGE_URL.to_string()
            }
        })
}

/// What the breach service could tell us about a password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreachCheck {
    /// The service answered: this password is in no known breach.
    Clean,
    /// The service answered: this password is in a known breach.
    Breached,
    /// The service could not be reached or did not answer, so nobody knows.
    Unavailable,
}
/// Why one attempt did not produce an answer.
enum RangeError {
    /// The service could not be reached, or the answer never arrived.
    Transport(String),
    /// The service answered with something other than a range listing.
    Status(u16),
}

impl RangeError {
    /// Is another attempt worth it? A busy service (5xx) or a rate limit
    /// (429) may answer differently a moment later; a broken connection may
    /// too. Any other answer would only repeat itself.
    fn worth_retrying(&self) -> bool {
        match self {
            RangeError::Transport(_) => true,
            RangeError::Status(code) => *code >= 500 || *code == 429,
        }
    }
}

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RangeError::Transport(err) => write!(f, "{err}"),
            RangeError::Status(code) => write!(f, "hibp range api returned {code}"),
        }
    }
}

/// Ask the range API for every hash that starts with `prefix`.
fn fetch_range(prefix: &str) -> Result<String, RangeError> {
    let url = format!("{}{}", hibp_range_url(), prefix);
    let mut response = ureq::get(&url)
        .config()
        .timeout_global(Some(ATTEMPT_TIMEOUT))
        .timeout_connect(Some(Duration::from_secs(3)))
        // A redirect would send the password's hash prefix to a host nobody
        // chose. Sol and Luna Connect refuse redirects here for the same
        // reason.
        .max_redirects(0)
        .build()
        .header("User-Agent", "Luna")
        .call()
        .map_err(|e| match e {
            // A 4xx/5xx answer is an answer, not a broken connection.
            ureq::Error::StatusCode(code) => RangeError::Status(code),
            other => RangeError::Transport(other.to_string()),
        })?;

    let status = response.status().as_u16();
    if status != 200 {
        return Err(RangeError::Status(status));
    }

    response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_string()
        .map_err(|e| RangeError::Transport(e.to_string()))
}

/// Does a range listing hold this hash suffix?
fn range_contains(body: &str, suffix: &str) -> bool {
    body.lines().any(|line| {
        line.split_once(':')
            .is_some_and(|(hash_suffix, _)| hash_suffix.eq_ignore_ascii_case(suffix))
    })
}

/// Returns true when `pw` appears in known data breaches.
/// On any API/network error returns `Err` so callers can tell "not breached"
/// apart from "nobody answered".
pub fn check_breached_password(pw: &str) -> Result<bool, String> {
    let mut hasher = Sha1::new();
    hasher.update(pw.as_bytes());
    let full = hex_upper(&hasher.finalize());
    let (prefix, suffix) = full.split_at(5);

    // A broken connection is worth one more try — the breach service blinks
    // more often than it is down. So is a busy one (5xx) or a rate limit
    // (429). Any other answer would only repeat itself.
    let mut last_error = String::new();
    for attempt in 0..2 {
        match fetch_range(prefix) {
            Ok(body) => return Ok(range_contains(&body, suffix)),
            Err(err) => {
                let retry = attempt == 0 && err.worth_retrying();
                last_error = err.to_string();
                if !retry {
                    return Err(last_error);
                }
                std::thread::sleep(RETRY_PAUSE);
            }
        }
    }
    Err(last_error)
}

/// Check a password against the breach list.
///
/// `Breached` means the service answered "this password is in a known
/// breach" — the caller refuses it. `Unavailable` means the service could
/// not answer: the password is allowed (a Luna without internet must still
/// be able to change a password), and the caller tells the person the check
/// did not happen, so it is never a silent pass.
pub fn check_password_breach(pw: &str) -> BreachCheck {
    match check_breached_password(pw) {
        Ok(true) => BreachCheck::Breached,
        Ok(false) => BreachCheck::Clean,
        Err(err) => {
            tracing::warn!(error = %err, "HIBP breach check skipped");
            BreachCheck::Unavailable
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
    use std::net::{Shutdown, TcpListener};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    /// Global HIBP URL is process-wide — serialize these tests.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct StubServer {
        url: String,
        // Drop closes the listener by connecting once after join signal… we
        // just keep the join handle and abandon the thread at process end.
        _join: Option<thread::JoinHandle<()>>,
    }

    /// Persistent stub: same body for every GET until the process ends.
    fn start_stub(body: impl Into<String>) -> StubServer {
        let body = Arc::new(body.into());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        // Accept with a short timeout so the thread can exit after tests.
        listener.set_nonblocking(false).expect("blocking listener");
        let addr = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            ready_tx.send(()).ok();
            // Serve a handful of requests (retries + multiple asserts).
            for _ in 0..32 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body.as_str()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Write);
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // Give the accept loop a beat to park on accept().
        thread::sleep(Duration::from_millis(5));
        StubServer {
            url: format!("http://{addr}/range/"),
            _join: Some(join),
        }
    }

    /// A stub that answers every GET with one fixed raw response.
    fn start_raw_stub(response: &'static str) -> StubServer {
        let body = Arc::new(response.to_string());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(false).expect("blocking listener");
        let addr = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            ready_tx.send(()).ok();
            for _ in 0..32 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Write);
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        thread::sleep(Duration::from_millis(5));
        StubServer {
            url: format!("http://{addr}/range/"),
            _join: Some(join),
        }
    }

    fn sha1_suffix(pw: &str) -> String {
        let mut hasher = Sha1::new();
        hasher.update(pw.as_bytes());
        let full = hex_upper(&hasher.finalize());
        full[5..].to_string()
    }

    #[test]
    fn detects_breached_password() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = sha1_suffix("password123");
        let stub = start_stub(format!("{suffix}:999\nDEADBEEF:1\n"));
        set_hibp_range_url(&stub.url);
        assert!(check_breached_password("password123").unwrap());
        set_hibp_range_url("");
    }

    #[test]
    fn clean_password_ok() {
        let _guard = TEST_LOCK.lock().unwrap();
        let stub = start_stub("DEADBEEF:1\nCAFEBABE:2\n");
        set_hibp_range_url(&stub.url);
        assert!(!check_breached_password("Tr0ub4dor&3-Good!").unwrap());
        set_hibp_range_url("");
    }

    /// The service being unreachable must not look like "this password is
    /// fine" — the caller has to be able to tell the two apart.
    #[test]
    fn unreachable_service_reports_no_answer() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_hibp_range_url("http://127.0.0.1:1/range/");
        assert!(check_breached_password("whatever12345").is_err());
        assert_eq!(
            check_password_breach("whatever12345"),
            BreachCheck::Unavailable
        );
        set_hibp_range_url("");
    }

    /// A password the service could not vouch for is allowed, but never
    /// silently: the caller is told the check did not run.
    #[test]
    fn unavailable_check_is_reported_not_hidden() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_hibp_range_url("http://127.0.0.1:1/range/");
        assert_eq!(
            check_password_breach("whatever12345"),
            BreachCheck::Unavailable
        );
        assert!(!BREACH_CHECK_UNAVAILABLE_MESSAGE.is_empty());
        set_hibp_range_url("");
    }

    #[test]
    fn clean_password_is_reported_clean() {
        let _guard = TEST_LOCK.lock().unwrap();
        let stub = start_stub("DEADBEEF:1\n");
        set_hibp_range_url(&stub.url);
        assert_eq!(
            check_password_breach("Tr0ub4dor&3-Good!"),
            BreachCheck::Clean
        );
        set_hibp_range_url("");
    }

    /// A redirect would send the password's hash prefix to a host nobody
    /// chose, so the client must not follow one.
    #[test]
    fn redirects_are_not_followed() {
        let _guard = TEST_LOCK.lock().unwrap();
        let stub = start_raw_stub(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        set_hibp_range_url(&stub.url);
        let err = check_breached_password("password123").unwrap_err();
        assert!(err.contains("302"), "unexpected error: {err}");
        set_hibp_range_url("");
    }

    /// An answer that is not a range listing is not an answer.
    #[test]
    fn a_failing_service_is_not_an_answer() {
        let _guard = TEST_LOCK.lock().unwrap();
        let stub = start_raw_stub(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        set_hibp_range_url(&stub.url);
        let err = check_breached_password("password123").unwrap_err();
        assert!(err.contains("503"), "unexpected error: {err}");
        set_hibp_range_url("");
    }

    #[test]
    fn a_breached_password_is_reported_as_breached() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = sha1_suffix("password123");
        let stub = start_stub(format!("{suffix}:1\n"));
        set_hibp_range_url(&stub.url);
        assert_eq!(check_password_breach("password123"), BreachCheck::Breached);
        set_hibp_range_url("");
    }

    #[test]
    fn breached_copy_matches_sol_constant() {
        assert_eq!(
            BREACHED_PASSWORD_MESSAGE,
            "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password."
        );
    }

    #[test]
    fn unavailable_copy_is_plain_language() {
        assert_eq!(
            BREACH_CHECK_UNAVAILABLE_MESSAGE,
            "Luna couldn't check this password against known data breaches, so it was allowed. Please choose a different password if you can."
        );
    }
}
