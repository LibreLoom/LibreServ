//! BLE bootstrap — the same HTTP-over-GATT protocol as LibreServ.
//!
//! The wire protocol (UUIDs, JSON message shapes, 300-byte chunking, base64)
//! is byte-compatible with `server/backend/internal/network/bluetooth` so
//! Luna Mobile can set up both products with one implementation.
//!
//! The transport is behind a trait: Luna OS will advertise via BlueZ (bluer),
//! while dev machines use the no-op transport. The protocol core below is
//! fully testable without any radio.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde::{Deserialize, Serialize};
use tower::util::ServiceExt;

pub const SERVICE_UUID: &str = "5a494c42-6572-6572-7600-000000000000";
pub const CHAR_AUTH: &str = "5a494c42-6572-6572-7600-000000000002";
pub const CHAR_AUTH_STATUS: &str = "5a494c42-6572-6572-7600-000000000003";
pub const CHAR_PROXY_REQ: &str = "5a494c42-6572-6572-7600-000000000004";
pub const CHAR_PROXY_RESP: &str = "5a494c42-6572-6572-7600-000000000005";
pub const MAX_CHUNK: usize = 300; // raw bytes per base64 chunk, same as LibreServ
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
// Hard bounds so a brute-forcing or misbehaving BLE client can't exhaust the
// 4GB box: auth-code attempts are throttled with a lockout, and in-flight
// request bodies are capped.
const MAX_AUTH_FAILURES: u32 = 8;
const AUTH_LOCKOUT: std::time::Duration = std::time::Duration::from_secs(300);
const MAX_PENDING_BODY: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyRequest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub chunk: usize,
    #[serde(default)]
    pub r#final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyResponse {
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "statusText")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub chunk: usize,
    #[serde(default)]
    pub r#final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub ts: i64,
}

#[derive(Debug, Clone)]
struct PendingRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    started: std::time::Instant,
}

/// Executes an HTTP request against Luna's own router (no network hop).
pub struct RouterExecutor {
    router: axum::Router,
}

impl RouterExecutor {
    pub fn new(router: axum::Router) -> Self {
        Self { router }
    }

    pub async fn execute(
        &self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: &[u8],
    ) -> Result<HttpResponse, String> {
        let method = axum::http::Method::from_bytes(method.as_bytes())
            .map_err(|_| "invalid method".to_string())?;
        let uri = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        let mut builder = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let request = builder
            .body(Body::from(body.to_vec()))
            .map_err(|e| e.to_string())?;

        let response = tokio::time::timeout(REQUEST_TIMEOUT, self.router.clone().oneshot(request))
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(|e| e.to_string())?;
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, 16 * 1024 * 1024)
            .await
            .map_err(|e| e.to_string())?;
        let mut out_headers = HashMap::new();
        for name in parts.headers.keys() {
            if let Ok(v) = parts.headers.get(name).unwrap().to_str() {
                out_headers.insert(name.to_string(), v.to_string());
            }
        }
        Ok(HttpResponse {
            status: parts.status,
            headers: out_headers,
            body: bytes.to_vec(),
        })
    }
}

pub struct HttpResponse {
    pub status: StatusCode,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Authentication state for the BLE transport. A single shared flag is enough
/// because the GATT service is one peripheral; failed codes throttle with a
/// lockout, and a correct code flips the whole transport authenticated.
struct AuthState {
    authed: bool,
    failures: u32,
    locked_until: Option<std::time::Instant>,
}

/// The protocol core. Hardware-agnostic; a BlueZ transport will call
/// `handle_auth_write` and `handle_request_write` on characteristic events.
pub struct BleCore {
    setup_code: String,
    executor: RouterExecutor,
    auth_state: Mutex<AuthState>,
    pending: Mutex<HashMap<String, PendingRequest>>,
}

impl BleCore {
    pub fn new(setup_code: impl Into<String>, executor: RouterExecutor) -> Self {
        Self {
            setup_code: setup_code.into(),
            executor,
            auth_state: Mutex::new(AuthState {
                authed: false,
                failures: 0,
                locked_until: None,
            }),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the JSON to write to the Auth Status characteristic.
    pub async fn handle_auth_write(&self, value: &[u8]) -> Vec<u8> {
        let code = String::from_utf8_lossy(value);
        let mut status = AuthStatus {
            ok: false,
            message: None,
            ts: unix_now(),
        };
        let mut state = self.auth_state.lock().unwrap();
        let now = std::time::Instant::now();
        if let Some(until) = state.locked_until {
            if now < until {
                status.message =
                    Some("Too many wrong codes. Wait a few minutes and try again.".into());
                return serde_json::to_vec(&status).unwrap_or_default();
            }
            state.locked_until = None;
            state.failures = 0;
        }
        if code.trim().eq_ignore_ascii_case(&self.setup_code) {
            state.authed = true;
            state.failures = 0;
            status.ok = true;
        } else {
            state.authed = false;
            state.failures += 1;
            if state.failures >= MAX_AUTH_FAILURES {
                state.locked_until = Some(now + AUTH_LOCKOUT);
                status.message =
                    Some("Too many wrong codes. Wait a few minutes and try again.".into());
            } else {
                status.message = Some(
                    "The code you entered does not match. Check the setup code printed on your device and try again."
                        .into(),
                );
            }
        }
        serde_json::to_vec(&status).unwrap_or_default()
    }

    /// Returns zero or more JSON frames to write to the Proxy Response
    /// characteristic (usually one frame per 300-byte chunk).
    pub async fn handle_request_write(&self, value: &[u8]) -> Vec<Vec<u8>> {
        let allowed = {
            let state = self.auth_state.lock().unwrap();
            state.authed
                && state
                    .locked_until
                    .is_none_or(|until| std::time::Instant::now() >= until)
        };
        if !allowed {
            return vec![self.error_frame(
                "",
                StatusCode::FORBIDDEN,
                "You are not connected yet. Check your setup code and authenticate first.",
            )];
        }

        let req: ProxyRequest = match serde_json::from_slice(value) {
            Ok(req) => req,
            Err(_) => {
                return vec![self.error_frame(
                    "",
                    StatusCode::BAD_REQUEST,
                    "The companion app sent a request the server did not understand. Please restart the app and try again.",
                )]
            }
        };

        if req.chunk == 0 && req.r#final {
            let body = decode_body(&req.body);
            return self
                .execute(&req.id, &req.method, &req.path, &req.headers, &body)
                .await;
        }

        if req.chunk == 0 {
            let body = decode_body(&req.body);
            let mut map = self.pending.lock().unwrap();
            // Bound the total reassembly buffer per request id.
            if map
                .get(&req.id)
                .map_or(body.len(), |p| p.body.len() + body.len())
                > MAX_PENDING_BODY
            {
                map.remove(&req.id);
                drop(map);
                return vec![self.error_frame(
                    &req.id,
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "That message is too large to send over Bluetooth. Try a smaller file.",
                )];
            }
            map.insert(
                req.id.clone(),
                PendingRequest {
                    method: req.method.clone(),
                    path: req.path.clone(),
                    headers: req.headers.clone(),
                    body,
                    started: std::time::Instant::now(),
                },
            );
            return vec![];
        }

        let pending = {
            let mut map = self.pending.lock().unwrap();
            match map.get_mut(&req.id) {
                Some(p) => {
                    let incoming = decode_body(&req.body);
                    if p.body.len() + incoming.len() > MAX_PENDING_BODY {
                        map.remove(&req.id);
                        drop(map);
                        return vec![self.error_frame(
                            &req.id,
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "That message is too large to send over Bluetooth. Try a smaller file.",
                        )];
                    }
                    p.body.extend_from_slice(&incoming);
                    if req.r#final {
                        Some(map.remove(&req.id).unwrap())
                    } else {
                        None
                    }
                }
                None => {
                    return vec![self.error_frame(
                        &req.id,
                        StatusCode::BAD_REQUEST,
                        "The server lost track of this request. Please send it again.",
                    )];
                }
            }
        };

        let Some(pending) = pending else {
            return vec![];
        };
        self.execute(
            &req.id,
            &pending.method,
            &pending.path,
            &pending.headers,
            &pending.body,
        )
        .await
    }

    /// Drop reassembly state older than the timeout.
    pub fn sweep_pending(&self) {
        let now = std::time::Instant::now();
        self.pending
            .lock()
            .unwrap()
            .retain(|_, p| now.duration_since(p.started) < REQUEST_TIMEOUT);
    }

    async fn execute(
        &self,
        id: &str,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: &[u8],
    ) -> Vec<Vec<u8>> {
        let response = match self.executor.execute(method, path, headers, body).await {
            Ok(response) => response,
            Err(_) => {
                return vec![self.error_frame(
                    id,
                    StatusCode::BAD_REQUEST,
                    "Could not understand that request. Please check the address and try again.",
                )];
            }
        };

        let chunks = chunk_bytes(&response.body, MAX_CHUNK);
        let mut frames = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            let final_frame = i == chunks.len() - 1;
            let resp = ProxyResponse {
                id: id.to_string(),
                status: if i == 0 {
                    Some(response.status.as_u16())
                } else {
                    None
                },
                status_text: if i == 0 {
                    Some(response.status.to_string())
                } else {
                    None
                },
                headers: if i == 0 {
                    Some(response.headers.clone())
                } else {
                    None
                },
                body: base64_encode(chunk),
                chunk: i,
                r#final: final_frame,
            };
            frames.push(serde_json::to_vec(&resp).unwrap_or_default());
        }
        frames
    }

    fn error_frame(&self, id: &str, status: StatusCode, message: &str) -> Vec<u8> {
        serde_json::to_vec(&ProxyResponse {
            id: id.to_string(),
            status: Some(status.as_u16()),
            status_text: Some(status.to_string()),
            headers: None,
            body: base64_encode(message.as_bytes()),
            chunk: 0,
            r#final: true,
        })
        .unwrap_or_default()
    }
}

fn decode_body(encoded: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap_or_default()
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn chunk_bytes(data: &[u8], size: usize) -> Vec<Vec<u8>> {
    if data.is_empty() {
        return vec![Vec::new()];
    }
    data.chunks(size).map(|c| c.to_vec()).collect()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// No-op transport for machines without a BLE radio (dev/test). Luna OS will
/// swap in the BlueZ transport behind the same trait.
pub trait BleTransport: Send + Sync {
    fn start(&self) -> anyhow::Result<()>;
    fn stop(&self);
}

pub struct NoopTransport;

impl BleTransport for NoopTransport {
    fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn stop(&self) {}
}

pub struct BleService {
    core: std::sync::Arc<BleCore>,
    transport: std::sync::Arc<dyn BleTransport>,
}

impl BleService {
    pub fn new(
        setup_code: impl Into<String>,
        executor: RouterExecutor,
        transport: std::sync::Arc<dyn BleTransport>,
    ) -> Self {
        Self {
            core: std::sync::Arc::new(BleCore::new(setup_code, executor)),
            transport,
        }
    }

    pub fn core(&self) -> std::sync::Arc<BleCore> {
        self.core.clone()
    }

    pub fn from_parts(
        core: std::sync::Arc<BleCore>,
        transport: std::sync::Arc<dyn BleTransport>,
    ) -> Self {
        Self { core, transport }
    }

    pub fn start(&self) -> anyhow::Result<()> {
        self.transport.start()
    }

    pub fn stop(&self) {
        self.transport.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::routing::get;

    async fn test_core() -> BleCore {
        let router = axum::Router::new()
            .route(
                "/api/v1/test",
                get(|| async { Json(serde_json::json!({ "status": "ok" })) }),
            )
            .route("/api/v1/large", get(|| async { "x".repeat(1000) }));
        BleCore::new("a1b2c3", RouterExecutor::new(router))
    }

    #[tokio::test]
    async fn auth_must_precede_requests() {
        let core = test_core().await;
        let req = ProxyRequest {
            id: "1".into(),
            method: "GET".into(),
            path: "/api/v1/test".into(),
            headers: HashMap::new(),
            body: String::new(),
            chunk: 0,
            r#final: true,
        };
        let frames = core
            .handle_request_write(&serde_json::to_vec(&req).unwrap())
            .await;
        assert_eq!(frames.len(), 1);
        let resp: ProxyResponse = serde_json::from_slice(&frames[0]).unwrap();
        assert_eq!(resp.status, Some(403));
    }

    #[tokio::test]
    async fn auth_accepts_case_insensitive_code() {
        let core = test_core().await;
        let frame = core.handle_auth_write(b"A1B2C3").await;
        let status: AuthStatus = serde_json::from_slice(&frame).unwrap();
        assert!(status.ok);
    }

    #[tokio::test]
    async fn auth_lockout_blocks_brute_force() {
        let core = test_core().await;
        for _ in 0..MAX_AUTH_FAILURES {
            let frame = core.handle_auth_write(b"wrong-code").await;
            let status: AuthStatus = serde_json::from_slice(&frame).unwrap();
            assert!(!status.ok);
        }
        // Even the correct code is refused while the transport is locked out.
        let frame = core.handle_auth_write(b"a1b2c3").await;
        let status: AuthStatus = serde_json::from_slice(&frame).unwrap();
        assert!(!status.ok);
        assert!(status.message.unwrap().contains("Wait a few minutes"));
    }

    #[tokio::test]
    async fn large_response_is_chunked_like_libreserv() {
        let core = test_core().await;
        core.handle_auth_write(b"a1b2c3").await;
        let req = ProxyRequest {
            id: "9".into(),
            method: "GET".into(),
            path: "/api/v1/large".into(),
            headers: HashMap::new(),
            body: String::new(),
            chunk: 0,
            r#final: true,
        };
        let frames = core
            .handle_request_write(&serde_json::to_vec(&req).unwrap())
            .await;
        assert_eq!(frames.len(), 4, "1000 raw bytes → 4 chunks of ≤300");
        let first: ProxyResponse = serde_json::from_slice(&frames[0]).unwrap();
        assert_eq!(first.status, Some(200));
        assert!(first.headers.as_ref().is_some_and(|h| !h.is_empty()));
        let mut decoded = Vec::new();
        for frame in &frames {
            let resp: ProxyResponse = serde_json::from_slice(frame).unwrap();
            decoded.extend_from_slice(&decode_body(&resp.body));
        }
        assert_eq!(decoded, b"x".repeat(1000));
    }

    #[tokio::test]
    async fn multipart_style_request_reassembly() {
        let core = test_core().await;
        core.handle_auth_write(b"a1b2c3").await;
        let body = base64_encode(b"hello");
        let first = ProxyRequest {
            id: "r1".into(),
            method: "GET".into(),
            path: "/api/v1/test".into(),
            headers: HashMap::new(),
            body: base64_encode(b"he"),
            chunk: 0,
            r#final: false,
        };
        assert!(
            core.handle_request_write(&serde_json::to_vec(&first).unwrap())
                .await
                .is_empty()
        );
        let second = ProxyRequest {
            id: "r1".into(),
            method: String::new(),
            path: String::new(),
            headers: HashMap::new(),
            body: base64_encode(b"llo"),
            chunk: 1,
            r#final: true,
        };
        let frames = core
            .handle_request_write(&serde_json::to_vec(&second).unwrap())
            .await;
        assert!(!frames.is_empty());
        let resp: ProxyResponse = serde_json::from_slice(&frames[0]).unwrap();
        assert_eq!(decode_body(&resp.body), b"{\"status\":\"ok\"}");
        let _ = body;
    }
}
