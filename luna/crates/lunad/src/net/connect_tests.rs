use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::auth::is_auth_token_format;
use super::*;

const UID: &str = "7K4M2Q9XR8N36T5W1PZH";
const CODE: &str = "A3F91C";
const TOKEN_ZERO: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn token(fill: u8) -> String {
    URL_SAFE_NO_PAD.encode([fill; 32])
}

#[derive(Debug, Clone)]
struct RecordedRequest {
    path: String,
    authorization: Option<String>,
    body: String,
}

struct MockReply {
    status: u16,
    body: String,
}

impl MockReply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
        }
    }
}

struct MockConnect {
    url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl MockConnect {
    fn new(replies: Vec<MockReply>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            let mut replies: VecDeque<_> = replies.into();
            while let Some(reply) = replies.pop_front() {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    return;
                }
                let mut parts = request_line.split_whitespace();
                parts.next();
                let path = parts.next().unwrap_or("").to_string();
                let mut authorization = None;
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                    let Some((name, value)) = line.split_once(':') else {
                        continue;
                    };
                    let value = value.trim();
                    if name.eq_ignore_ascii_case("authorization") {
                        authorization = Some(value.to_string());
                    }
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_length];
                let _ = reader.read_exact(&mut body);
                seen.lock().unwrap().push(RecordedRequest {
                    path,
                    authorization,
                    body: String::from_utf8_lossy(&body).to_string(),
                });
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    reply.body.len(),
                    reply.body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            url: format!("http://{addr}"),
            requests,
        }
    }

    fn calls(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn service(dir: &Path, url: String) -> ConnectService {
    ConnectService::new(dir, Some(url))
}

fn write_pairing(dir: &Path) {
    std::fs::write(dir.join(DEVICE_UID_FILE), format!("{UID}\n")).unwrap();
    std::fs::write(dir.join(PAIRING_CODE_FILE), format!("{CODE}\n")).unwrap();
}

fn write_bound(dir: &Path, connect: &ConnectService, credential: &str) {
    write_pairing(dir);
    std::fs::write(dir.join(CONNECT_CREDENTIAL_FILE), format!("{credential}\n")).unwrap();
    connect
        .save(&json!({
            "state": "bound",
            "bound": true,
            "paired": true,
            "hostname": "photos.luna.servers.libreloom.org",
            "tunnel_token": "mock-token",
            "tunnel_active": true,
        }))
        .unwrap();
}

#[test]
fn device_uid_and_code_are_exact_separate_formats() {
    assert_eq!(normalize_device_uid("7k4m-2q9x-r8n3-6t5w-1pzh"), UID);
    assert!(is_device_uid_format(UID));
    assert!(!is_device_uid_format(&UID[..19]));
    assert!(!is_device_uid_format("7K4M2Q9XR8N36T5W1PZI"));
    assert_eq!(normalize_verification_code(" a3f91c "), CODE);
    assert!(is_verification_code_format(CODE));
    assert!(!is_verification_code_format("A3F91"));
    assert!(!is_verification_code_format("A3F91G"));
}

#[test]
fn rolling_credential_is_32_random_bytes_in_unpadded_base64url() {
    let value = token(7);
    assert_eq!(value.len(), 43);
    assert!(is_auth_token_format(&value));
    assert!(is_auth_token_format(TOKEN_ZERO));
    assert!(!is_auth_token_format("ABCD-EFGH-JKMN-PQRS-TVWX"));
    assert!(!is_auth_token_format(&format!("{value}=")));
    assert!(!is_auth_token_format(&value[..42]));
}

#[test]
fn pairing_files_are_separate_and_private() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    connect.set_pairing_material(UID, CODE).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join(DEVICE_UID_FILE)).unwrap(),
        format!("{UID}\n")
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join(PAIRING_CODE_FILE)).unwrap(),
        format!("{CODE}\n")
    );
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join(PAIRING_CODE_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn concurrent_magazine_reads_serialize_to_one_factory_identity() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("TOKENS"), format!("not-a-code\n{UID} {CODE}\n")).unwrap();
    let connect = Arc::new(service(dir.path(), "http://127.0.0.1:1".into()));
    let options = crate::system::factory_mag::MagFetchOptions {
        assets_root: Some(assets),
        max_attempts: 2,
        retry_delay: Duration::from_millis(500),
    };
    let mut workers = Vec::new();
    for _ in 0..2 {
        let connect = connect.clone();
        let options = options.clone();
        workers.push(std::thread::spawn(move || {
            connect.ensure_pairing_material_from_mag_with_options(options)
        }));
    }
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == crate::system::factory_mag::MagFetchOutcome::AlreadyValid)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                crate::system::factory_mag::MagFetchOutcome::Fetched { .. }
            ))
            .count(),
        1
    );
    assert_eq!(connect.device_uid().unwrap(), UID);
    assert_eq!(connect.verification_code().unwrap(), CODE);
}

#[test]
fn a_pairing_write_cannot_mix_with_an_in_flight_magazine_identity() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("TOKENS"), format!("not-a-code\n{UID} {CODE}\n")).unwrap();
    let connect = Arc::new(service(dir.path(), "http://127.0.0.1:1".into()));
    let options = crate::system::factory_mag::MagFetchOptions {
        assets_root: Some(assets.clone()),
        max_attempts: 2,
        retry_delay: Duration::from_millis(500),
    };
    let fetching = {
        let connect = connect.clone();
        std::thread::spawn(move || connect.ensure_pairing_material_from_mag_with_options(options))
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::fs::read_to_string(assets.join("TOKENS"))
        .unwrap()
        .contains("not-a-code")
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    let writing = {
        let connect = connect.clone();
        std::thread::spawn(move || connect.set_pairing_material("ZZZZYYYYXXXXWWWWVVVV", "ABCDEF"))
    };
    assert!(matches!(
        fetching.join().unwrap(),
        crate::system::factory_mag::MagFetchOutcome::Fetched { .. }
    ));
    assert!(writing.join().unwrap().is_err());
    assert_eq!(connect.device_uid().unwrap(), UID);
    assert_eq!(connect.verification_code().unwrap(), CODE);
}

#[test]
fn legacy_files_and_first_user_secret_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("device-token"),
        "ABCD-EFGH-JKMN-PQRS-TVWX\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("setup-token"), "ABCD-EFGH-JKMN-PQRS-TVWX\n").unwrap();
    std::fs::write(
        dir.path().join("connect.json"),
        json!({
            "bound": true,
            "device_token": "ABCD-EFGH-JKMN-PQRS-TVWX",
            "first_user_secret": "one-time-secret",
        })
        .to_string(),
    )
    .unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    assert!(!connect.has_pairing_material());
    assert!(!connect.is_connect_active());
    assert!(
        connect.poll_needed(),
        "a broken binding is settled locally once"
    );
    assert!(!connect.poll_status());
    let state = connect.load();
    assert!(state.get("device_token").is_none());
    assert!(state.get("first_user_secret").is_none());
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
}

#[test]
fn a_legacy_permanent_token_in_the_credential_file_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    write_pairing(dir.path());
    std::fs::write(
        dir.path().join(CONNECT_CREDENTIAL_FILE),
        "ABCD-EFGH-JKMN-PQRS-TVWX\n",
    )
    .unwrap();
    connect
        .save(&json!({ "state": "bound", "bound": true, "paired": true }))
        .unwrap();
    assert!(!connect.is_connect_active());
    assert!(connect.token().is_err());
    assert_eq!(
        connect.status().connect_error.as_deref(),
        Some(CREDENTIAL_MALFORMED_MSG)
    );
}

#[test]
fn unbound_device_polls_claim_until_it_receives_a_credential() {
    let dir = tempfile::tempdir().unwrap();
    let first = token(1);
    let mock = MockConnect::new(vec![
        MockReply::json(404, json!({ "error": "no pairing" })),
        MockReply::json(
            200,
            json!({
                "auth_token": first,
                "device_id": "connect-device-1",
                "refresh_after_seconds": 300,
            }),
        ),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_pairing(dir.path());

    assert!(!connect.poll_status());
    assert!(!connect.is_connect_active());
    let waiting = connect.status();
    assert_eq!(waiting.state, ConnectState::Unbound);
    assert!(waiting.connect_error.is_none());
    assert!(waiting.connect_unreachable.is_none());
    assert_eq!(connect.poll_interval_secs(false), AGGRESSIVE_POLL_SECS);

    assert!(connect.poll_status());
    assert!(connect.is_connect_active());
    assert_eq!(connect.status().state, ConnectState::Bound);
    assert_eq!(connect.token().unwrap(), first);
    assert_eq!(connect.device_uid().unwrap(), UID);
    assert_eq!(connect.verification_code().unwrap(), CODE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join(CONNECT_CREDENTIAL_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let calls = mock.calls();
    assert_eq!(calls.len(), 2);
    assert!(
        calls
            .iter()
            .all(|call| call.path == "/api/v1/devices/pair/claim")
    );
    assert!(calls.iter().all(|call| call.authorization.is_none()));
    let body: Value = serde_json::from_str(&calls[1].body).unwrap();
    assert_eq!(body["device_uid"], "7K4M-2Q9X-R8N3-6T5W-1PZH");
    assert_eq!(body["verification_code"], CODE);
}

#[test]
fn a_claim_keeps_the_issued_credential_when_the_state_save_fails() {
    let dir = tempfile::tempdir().unwrap();
    let issued = token(9);
    let mock = MockConnect::new(vec![MockReply::json(
        200,
        json!({ "auth_token": issued, "device_id": "device-1" }),
    )]);
    let connect = service(dir.path(), mock.url.clone());
    write_pairing(dir.path());
    // A directory at the state path makes the atomic rename fail after the
    // credential has already been durably written.
    std::fs::create_dir(dir.path().join("connect.json")).unwrap();

    assert!(!connect.poll_status());
    assert_eq!(
        std::fs::read_to_string(dir.path().join(CONNECT_CREDENTIAL_FILE))
            .unwrap()
            .trim(),
        issued
    );
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(mock.calls()[0].path, "/api/v1/devices/pair/claim");
}

#[test]
fn stale_unbound_and_revoked_labels_reconcile_a_surviving_credential() {
    for stale in ["unbound", "revoked"] {
        let dir = tempfile::tempdir().unwrap();
        let next = token(10);
        let mock = MockConnect::new(vec![
            MockReply::json(200, json!({ "auth_token": next })),
            MockReply::json(
                200,
                json!({ "hostname": "recovered.luna.servers.libreloom.org" }),
            ),
        ]);
        let connect = service(dir.path(), mock.url.clone());
        write_bound(dir.path(), &connect, TOKEN_ZERO);
        connect
            .save(&json!({ "state": stale, "bound": false, "paired": false }))
            .unwrap();

        assert!(connect.poll_status(), "stale {stale} state must recover");
        assert_eq!(connect.status().state, ConnectState::Bound);
        assert_eq!(connect.token().unwrap(), next);
        assert_eq!(
            mock.calls()
                .iter()
                .map(|call| call.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/api/v1/token/refresh", "/api/v1/status"]
        );
    }
}

#[test]
fn stale_state_reconciliation_never_falls_back_to_pairing_claims() {
    for (reply, expected) in [
        (
            MockReply::json(403, json!({ "code": "device_unbound" })),
            ConnectState::Unbound,
        ),
        (
            MockReply::json(403, json!({ "code": "device_revoked" })),
            ConnectState::Revoked,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mock = MockConnect::new(vec![reply]);
        let connect = service(dir.path(), mock.url.clone());
        write_bound(dir.path(), &connect, TOKEN_ZERO);
        connect
            .save(&json!({ "state": "unbound", "bound": false, "paired": false }))
            .unwrap();

        assert!(!connect.poll_status());
        assert_eq!(connect.status().state, expected);
        assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
        assert_eq!(mock.calls().len(), 1);
        assert_eq!(mock.calls()[0].path, "/api/v1/token/refresh");
    }
}

#[test]
fn an_offline_stale_state_recovery_keeps_the_credential_for_the_next_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(500, json!({ "error": "offline" }))]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect
        .save(&json!({ "state": "unbound", "bound": false, "paired": false }))
        .unwrap();

    assert!(!connect.poll_status());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert!(connect.status().connect_unreachable.is_some());
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(mock.calls()[0].path, "/api/v1/token/refresh");
}

#[test]
fn an_unbind_state_save_failure_keeps_the_marker_and_credential() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(200, json!({ "ok": true }))]);
    let connect = service(dir.path(), mock.url.clone());
    write_pairing(dir.path());
    std::fs::write(
        dir.path().join(CONNECT_CREDENTIAL_FILE),
        format!("{TOKEN_ZERO}\n"),
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("connect.json")).unwrap();

    assert!(connect.unbind_now().is_err());
    assert!(connect.unbind_pending());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(!connect.is_connect_active());
    assert!(connect.prepare_factory_reset(true).is_err());
}

#[test]
fn a_revocation_state_save_failure_keeps_the_marker_and_credential() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    write_pairing(dir.path());
    std::fs::write(
        dir.path().join(CONNECT_CREDENTIAL_FILE),
        format!("{TOKEN_ZERO}\n"),
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("connect.json")).unwrap();

    connect.settle_explicit_auth_failure(TOKEN_ZERO, &ConnectError::Revoked);
    assert!(connect.unbind_pending());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(!connect.is_connect_active());
    assert_eq!(connect.status().state, ConnectState::Revoked);
}

#[test]
fn bound_device_refreshes_every_five_minutes_and_on_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let first = token(1);
    let second = token(2);
    let mock = MockConnect::new(vec![
        MockReply::json(200, json!({ "auth_token": first })),
        MockReply::json(
            200,
            json!({ "hostname": "photos.luna.servers.libreloom.org" }),
        ),
        MockReply::json(
            200,
            json!({ "hostname": "photos.luna.servers.libreloom.org" }),
        ),
        MockReply::json(200, json!({ "auth_token": second })),
        MockReply::json(
            200,
            json!({ "hostname": "photos.luna.servers.libreloom.org" }),
        ),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(connect.poll_status(), "boot refreshes before status");
    assert_eq!(connect.token().unwrap(), first);
    assert!(
        connect.poll_status(),
        "the next poll is before the five-minute refresh"
    );
    connect.poll_wake().wake_reconnect();
    assert!(connect.poll_status(), "reconnect refreshes immediately");

    let calls = mock.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/token/refresh",
            "/api/v1/status",
            "/api/v1/status",
            "/api/v1/token/refresh",
            "/api/v1/status",
        ]
    );
    assert_eq!(
        calls[0].authorization.as_deref(),
        Some(format!("Bearer {TOKEN_ZERO}").as_str())
    );
    assert_eq!(
        calls[1].authorization.as_deref(),
        Some(format!("Bearer {first}").as_str())
    );
    assert_eq!(
        calls[3].authorization.as_deref(),
        Some(format!("Bearer {first}").as_str())
    );
    assert_eq!(
        calls[4].authorization.as_deref(),
        Some(format!("Bearer {second}").as_str())
    );
}

#[test]
fn a_lost_refresh_response_retries_the_old_token() {
    let dir = tempfile::tempdir().unwrap();
    let next = token(3);
    let mock = MockConnect::new(vec![
        MockReply::json(500, json!({ "error": "lost response" })),
        MockReply::json(200, json!({ "auth_token": next })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(matches!(
        connect.refresh_credential(true),
        Err(ConnectError::Unreachable)
    ));
    assert_eq!(connect.token().unwrap(), TOKEN_ZERO);
    connect.refresh_credential(true).unwrap();
    assert_eq!(connect.token().unwrap(), next);
    // The first failed attempt did not replace the credential; the successful
    // retry used the same old token, which Connect accepts for 60 seconds.
    let calls = mock.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].authorization, calls[1].authorization);
    assert_eq!(
        std::fs::read_to_string(dir.path().join(CONNECT_CREDENTIAL_FILE))
            .unwrap()
            .trim(),
        next
    );
}

#[test]
fn a_normal_route_rejection_recovers_an_immediate_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let first = token(1);
    let second = token(2);
    let mock = MockConnect::new(vec![
        MockReply::json(200, json!({ "auth_token": first })),
        MockReply::json(401, json!({ "error": "rotated" })),
        MockReply::json(200, json!({ "auth_token": second })),
        MockReply::json(
            200,
            json!({ "hostname": "photos.luna.servers.libreloom.org" }),
        ),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect.refresh_credential(true).unwrap();

    assert!(connect.poll_status());
    assert_eq!(connect.token().unwrap(), second);
    let calls = mock.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/token/refresh",
            "/api/v1/status",
            "/api/v1/token/refresh",
            "/api/v1/status",
        ]
    );
    assert_eq!(
        calls[2].authorization.as_deref(),
        Some(format!("Bearer {first}").as_str())
    );
    assert_eq!(
        calls[3].authorization.as_deref(),
        Some(format!("Bearer {second}").as_str())
    );
}

#[test]
fn a_rejected_refresh_stops_remote_access_and_requires_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(401, json!({ "error": "revoked" }))]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(!connect.poll_status());
    let status = connect.status();
    assert_eq!(status.state, ConnectState::Revoked);
    assert!(!status.connect_active);
    assert!(!status.tunnel_active);
    assert!(status.hostname.is_none());
    assert_eq!(
        status.connect_error.as_deref(),
        Some(CREDENTIAL_REJECTED_MSG)
    );
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(dir.path().join(DEVICE_UID_FILE).exists());
    assert!(dir.path().join(PAIRING_CODE_FILE).exists());
}

#[test]
fn an_explicit_revocation_stops_remote_access_without_a_refresh_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![
        MockReply::json(200, json!({ "auth_token": token(4) })),
        MockReply::json(403, json!({ "code": "device_revoked" })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(!connect.poll_status());
    let status = connect.status();
    assert_eq!(status.state, ConnectState::Revoked);
    assert!(!status.connect_active);
    assert!(!status.tunnel_active);
    assert!(status.hostname.is_none());
    assert_eq!(
        status.connect_error.as_deref(),
        Some(CREDENTIAL_REJECTED_MSG)
    );
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert_eq!(
        mock.calls()
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/v1/token/refresh", "/api/v1/status"]
    );
}

#[test]
fn a_backup_revocation_reply_settles_the_local_state_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(
        403,
        json!({ "code": "device_revoked" }),
    )]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(matches!(
        connect.put_backup_object("photo.jpg", &b"image"[..]),
        Err(ConnectError::Revoked)
    ));
    assert_eq!(connect.status().state, ConnectState::Revoked);
    assert!(!connect.is_connect_active());
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
}

#[test]
fn a_backup_unbind_reply_finishes_the_local_unbind_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(
        403,
        json!({ "code": "device_unbound" }),
    )]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(matches!(
        connect.delete_backup_object("photo.jpg"),
        Err(ConnectError::Unbound)
    ));
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert!(!connect.is_connect_active());
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
}

#[test]
fn device_unbound_finishes_a_pending_unbind_in_that_request() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(
        403,
        json!({ "code": "device_unbound" }),
    )]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect.mark_unbind_pending().unwrap();

    connect.unbind_now().unwrap();
    assert!(!connect.unbind_pending());
    assert!(!connect.is_connect_active());
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    let state = connect.load();
    assert!(state.get("hostname").is_none());
    assert!(state.get("tunnel_token").is_none());
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(mock.calls()[0].path, "/api/v1/unregister");
}

#[test]
fn a_generic_401_does_not_complete_an_unbind() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![
        MockReply::json(401, json!({ "error": "invalid" })),
        MockReply::json(401, json!({ "error": "still invalid" })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect.mark_unbind_pending().unwrap();

    assert!(matches!(
        connect.unbind_now(),
        Err(ConnectError::InvalidToken)
    ));
    assert!(connect.unbind_pending());
    assert!(!connect.is_connect_active());
    assert_eq!(connect.status().state, ConnectState::Revoked);
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    let calls = mock.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/v1/unregister", "/api/v1/token/refresh"]
    );
    assert!(connect.prepare_factory_reset(true).is_err());
}

#[test]
fn pairing_state_can_cancel_its_claim_without_a_credential() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply {
        status: 204,
        body: String::new(),
    }]);
    let connect = service(dir.path(), mock.url.clone());
    write_pairing(dir.path());
    connect
        .save(&json!({ "state": "pairing", "bound": false, "paired": false }))
        .unwrap();

    assert!(connect.can_unbind());
    connect.unbind_now().unwrap();
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert!(dir.path().join(DEVICE_UID_FILE).exists());
    assert!(dir.path().join(PAIRING_CODE_FILE).exists());
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(mock.calls()[0].path, "/api/v1/devices/pair/cancel");
}

#[test]
fn an_unbind_401_recovers_a_rotated_credential_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    let next = token(8);
    let mock = MockConnect::new(vec![
        MockReply::json(401, json!({ "error": "rotated" })),
        MockReply::json(200, json!({ "auth_token": next })),
        MockReply::json(200, json!({ "ok": true })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    connect.unbind_now().unwrap();
    assert!(!connect.unbind_pending());
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    let calls = mock.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/unregister",
            "/api/v1/token/refresh",
            "/api/v1/unregister"
        ]
    );
    assert_eq!(
        calls[0].authorization.as_deref(),
        Some(format!("Bearer {TOKEN_ZERO}").as_str())
    );
    assert_eq!(calls[1].authorization, calls[0].authorization);
    assert_eq!(
        calls[2].authorization.as_deref(),
        Some(format!("Bearer {next}").as_str())
    );
}

#[test]
fn failed_unbind_keeps_only_revocation_material_and_retries_before_pairing() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![
        MockReply::json(500, json!({ "error": "down" })),
        MockReply::json(200, json!({ "ok": true })),
        MockReply::json(404, json!({ "error": "no pairing" })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    assert!(matches!(
        connect.unbind_now(),
        Err(ConnectError::Unreachable)
    ));
    assert!(connect.unbind_pending());
    assert!(!connect.is_connect_active());
    assert!(connect.public_hostname().is_none());
    assert!(!connect.status().tunnel_active);
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert_eq!(mock.calls().len(), 1, "pending blocks pairing claims");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join(UNBIND_PENDING_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    assert!(
        !connect.poll_status(),
        "retry settles unbind, then no pairing is waiting"
    );
    assert!(!connect.unbind_pending());
    assert!(!dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert_eq!(connect.status().state, ConnectState::Unbound);
    assert_eq!(connect.device_uid().unwrap(), UID);
    assert_eq!(connect.verification_code().unwrap(), CODE);
    assert_eq!(
        mock.calls()
            .iter()
            .map(|call| call.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/unregister",
            "/api/v1/unregister",
            "/api/v1/devices/pair/claim"
        ]
    );
}

#[test]
fn removing_the_verification_code_is_local_only() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(200, json!({ "ok": true }))]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    connect.remove_pairing_code().unwrap();
    assert!(mock.calls().is_empty());
    assert!(!dir.path().join(PAIRING_CODE_FILE).exists());
    assert!(dir.path().join(DEVICE_UID_FILE).exists());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(connect.is_connect_active());
    assert_eq!(
        connect.public_hostname().as_deref(),
        Some("photos.luna.servers.libreloom.org")
    );
    assert!(connect.status().tunnel_active);
}

#[test]
fn factory_reset_keep_and_disconnect_have_distinct_pending_behavior() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![MockReply::json(500, json!({ "error": "down" }))]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    connect.prepare_factory_reset(false).unwrap();
    assert!(connect.is_connect_active());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(mock.calls().is_empty());

    assert!(connect.prepare_factory_reset(true).is_err());
    assert!(connect.unbind_pending());
    assert!(!connect.is_connect_active());
    assert!(dir.path().join(CONNECT_CREDENTIAL_FILE).exists());
    assert!(connect.prepare_factory_reset(false).is_err());
    assert_eq!(mock.calls().len(), 1);
}

#[test]
fn setup_grant_is_consumed_once_and_failures_are_not_retried_as_success() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockConnect::new(vec![
        MockReply::json(200, json!({ "ok": true })),
        MockReply::json(400, json!({ "error": "grant already used" })),
    ]);
    let connect = service(dir.path(), mock.url.clone());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    connect.consume_setup_grant("grant-one").unwrap();
    assert!(matches!(
        connect.consume_setup_grant("grant-one"),
        Err(ConnectError::Other(_))
    ));
    let calls = mock.calls();
    assert_eq!(calls.len(), 2);
    assert!(
        calls
            .iter()
            .all(|call| call.path == "/api/v1/devices/setup-grant/consume")
    );
    assert!(calls.iter().all(|call| {
        serde_json::from_str::<Value>(&call.body).unwrap()["setup_grant"] == "grant-one"
    }));
}

#[test]
fn pending_disconnect_blocks_pairing_and_new_pairing_material() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect.mark_unbind_pending().unwrap();
    assert!(connect.unbind_pending());
    assert!(connect.set_pairing_material(UID, CODE).is_err());
    assert!(connect.poll_needed());
}

#[test]
fn reconnect_wake_is_distinct_and_taken_once() {
    let wake = PollWake::default();
    wake.wake();
    assert!(!wake.take_reconnect());
    assert!(wake.is_set());
    wake.wake_reconnect();
    assert!(wake.take_reconnect());
    assert!(!wake.take_reconnect());
    assert!(wake.is_set());
}

#[test]
fn plain_connect_state_is_private_and_strips_removed_secret_paths() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    connect
        .save(&json!({
            "hostname": "kitchen.example",
            "device_token": "legacy",
            "first_user_secret": "legacy",
        }))
        .unwrap();
    let raw = std::fs::read_to_string(dir.path().join("connect.json")).unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["hostname"], "kitchen.example");
    assert!(value.get("device_token").is_none());
    assert!(value.get("first_user_secret").is_none());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("connect.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn base_url_requires_https_or_a_local_http_host() {
    for url in [
        "https://connect.luna.libreloom.org",
        "http://127.0.0.1:18765",
        "http://localhost:18765",
        "http://[::1]:18765",
        "http://10.0.0.5",
        "http://luna.local",
    ] {
        assert!(base_url_allowed(url), "{url}");
    }
    for url in [
        "http://8.8.8.8",
        "http://203.0.113.10",
        "http://connect.example.com",
        "ftp://127.0.0.1:18765",
    ] {
        assert!(!base_url_allowed(url), "{url}");
    }
}

#[test]
fn classify_403_distinguishes_revoked_unbound_and_gateway_errors() {
    assert!(matches!(
        classify_403(
            403,
            "application/json",
            r#"{"code":"device_revoked"}"#,
            None,
        ),
        ConnectError::Revoked
    ));
    assert!(matches!(
        classify_403(
            403,
            "application/json",
            r#"{"code":"device_unbound"}"#,
            None,
        ),
        ConnectError::Unbound
    ));
    for body in [
        r#"{"error":"unbound"}"#,
        r#"{"error":"revoked"}"#,
        r#"{"code":"some_other_error"}"#,
        r#"{}"#,
    ] {
        assert!(matches!(
            classify_403(403, "application/json", body, None),
            ConnectError::Unreachable
        ));
    }
    assert!(matches!(
        classify_403(403, "text/html", "Just a moment...", Some("challenge")),
        ConnectError::GatewayChallenge
    ));
    assert!(matches!(
        classify_403(403, "text/plain", "blocked", None),
        ConnectError::Unreachable
    ));
}

#[test]
fn object_key_segments_are_percent_encoded() {
    assert_eq!(encode_object_key("a/b/c.txt"), "a/b/c.txt");
    assert_eq!(
        encode_object_key("dir/what?.txt#/frag%20"),
        "dir/what%3F.txt%23/frag%2520"
    );
}

#[test]
fn idle_requires_quiet_window() {
    assert!(!auth::is_idle(100, 110));
    assert!(auth::is_idle(100, 140));
}

#[test]
fn tunnel_error_helpers_are_visible_to_the_supervisor() {
    let dir = tempfile::tempdir().unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    write_bound(dir.path(), &connect, TOKEN_ZERO);

    connect.set_tunnel_error(TUNNEL_START_FAILED_MSG);
    assert_eq!(
        connect.status().tunnel_error.as_deref(),
        Some(TUNNEL_START_FAILED_MSG)
    );
    connect.clear_tunnel_error();
    assert!(connect.status().tunnel_error.is_none());
}

#[cfg(unix)]
#[test]
fn an_orphaned_cloudflared_counts_as_running_until_it_is_reaped() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let fake = bin_dir.join("cloudflared");
    let mut body = String::from(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo cloudflared version fake; exit 0; fi\nsleep 3600\n",
    );
    while body.len() < MIN_CLOUDFLARED_BYTES as usize {
        body.push('#');
    }
    std::fs::write(&fake, body).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut orphan = Command::new(&fake)
        .args(["tunnel", "--no-autoupdate", "run"])
        .env("TUNNEL_TOKEN", "orphan-token")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let connect = service(dir.path(), "http://127.0.0.1:1".into());
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect
        .save(&json!({
            "state": "bound",
            "bound": true,
            "paired": true,
            "hostname": "photos.luna.servers.libreloom.org",
            "tunnel_token": "real-orphan-token",
        }))
        .unwrap();

    std::thread::sleep(Duration::from_millis(50));
    assert!(connect.status().tunnel_active);
    connect.stop_tunnel();
    let _ = orphan.kill();
    let _ = orphan.wait();
    assert!(!connect.tunnel_running());
}

#[cfg(unix)]
#[test]
fn unbind_stops_a_supervisor_start_that_is_already_in_flight() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let log = dir.path().join("starts.log");
    let fake = bin_dir.join("cloudflared");
    let mut body = format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo cloudflared version fake; exit 0; fi\necho start >> {}\nsleep 3600\n",
        log.display()
    );
    while body.len() < MIN_CLOUDFLARED_BYTES as usize {
        body.push('#');
    }
    std::fs::write(&fake, body).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mock = MockConnect::new(vec![MockReply::json(200, json!({ "ok": true }))]);
    let connect = Arc::new(service(dir.path(), mock.url.clone()));
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    connect
        .save(&json!({
            "state": "bound",
            "bound": true,
            "paired": true,
            "hostname": "photos.luna.servers.libreloom.org",
            "tunnel_token": "real-race-token",
        }))
        .unwrap();

    let starting = {
        let connect = connect.clone();
        std::thread::spawn(move || connect.ensure_tunnel())
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !log.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(log.exists(), "cloudflared start did not begin");
    let unbinding = {
        let connect = connect.clone();
        std::thread::spawn(move || connect.unbind_now())
    };
    let _ = starting.join().unwrap();
    unbinding.join().unwrap().unwrap();

    assert!(!connect.unbind_pending());
    assert!(!connect.is_connect_active());
    assert!(connect.child.lock().unwrap().is_none());
    assert!(connect.ensure_tunnel().is_err());
    assert_eq!(
        std::fs::read_to_string(log).unwrap().lines().count(),
        1,
        "a queued supervisor must not restart remote access after unbind"
    );
}

#[test]
fn backup_payment_state_update_uses_the_connect_state_lock() {
    let dir = tempfile::tempdir().unwrap();
    let connect = Arc::new(service(dir.path(), "http://127.0.0.1:1".into()));
    write_bound(dir.path(), &connect, TOKEN_ZERO);
    let held = connect.state_mu_for_test().lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = {
        let connect = connect.clone();
        std::thread::spawn(move || {
            connect.mark_backup_locked();
            tx.send(()).unwrap();
        })
    };
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "backup state update must wait for the Connect transition lock"
    );
    drop(held);
    worker.join().unwrap();
    assert!(!connect.backup_unlocked());
}

#[cfg(target_os = "linux")]
#[test]
fn a_watched_child_reports_its_exit_without_polling() {
    let mut child = std::process::Command::new("sleep")
        .arg("0.1")
        .spawn()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    assert!(watch_child_exit(child.id(), move || {
        let _ = tx.send(());
    }));
    assert!(rx.recv_timeout(Duration::from_secs(10)).is_ok());
    assert!(child.wait().unwrap().success());
}
