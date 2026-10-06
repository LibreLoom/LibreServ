//! Runs every case in `infra/feed-testdata/cases.json` against `luna_feed`.
//! The key is the throwaway TEST-ONLY key from the fixtures, loaded here only.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use luna_feed::{self as feed, FeedError, Request};
use serde_json::Value;

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../infra/feed-testdata")
}

fn cases() -> Value {
    serde_json::from_slice(&std::fs::read(testdata().join("cases.json")).unwrap()).unwrap()
}

fn test_keys(cases: &Value) -> Vec<String> {
    let name = cases["key"].as_str().unwrap();
    vec![std::fs::read_to_string(testdata().join(name)).unwrap()]
}

/// Serves `files/` at its root; anything under `/missing/` is a 404.
fn serve_files() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let root = testdata().join("files");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let root = root.clone();
            std::thread::spawn(move || {
                let mut head = Vec::new();
                let mut b = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut b).unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(b[0]);
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = if path.starts_with("/missing/") || path.contains("..") {
                    None
                } else {
                    std::fs::read(root.join(path.trim_start_matches('/'))).ok()
                };
                let _ = match body {
                    Some(body) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        stream.write_all(&body)
                    }
                    None => write!(
                        stream,
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    ),
                };
            });
        }
    });
    format!("http://{addr}")
}

#[test]
fn every_case() {
    let all = cases();
    let keys = test_keys(&all);
    let url_base = all["url_base"].as_str().unwrap().to_string();
    let server = serve_files();
    let dir = tempfile::tempdir().unwrap();
    let list = all["cases"].as_array().unwrap();
    assert!(list.len() > 20, "fixtures went missing");

    for case in list {
        let name = case["name"].as_str().unwrap();
        let expect = case["expect"].as_str().unwrap();
        let feed_bytes = std::fs::read(testdata().join(case["feed"].as_str().unwrap())).unwrap();
        let sig = std::fs::read(testdata().join(case["sig"].as_str().unwrap())).unwrap();
        let r = &case["request"];
        let s = |k: &str| r[k].as_str().unwrap().to_string();
        let (unit, channel, part, os, arch, installed, seen) = (
            s("unit"),
            s("channel"),
            s("part"),
            s("os"),
            s("arch"),
            s("installed_version"),
            s("newest_published_seen"),
        );
        let req = Request {
            unit: &unit,
            channel: &channel,
            part: &part,
            os: &os,
            arch: &arch,
            installed_version: &installed,
            newest_published_seen: &seen,
        };
        let got = feed::check(&feed_bytes, &sig, &keys, &req);

        if let Some(reason) = expect.strip_prefix("reject:") {
            let err = got.expect_err(name);
            assert_eq!(err.reason(), reason, "{name}");
        } else if expect == "update" {
            let v = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(v.newer, "{name}: should be newer");
        } else if expect == "no-update" {
            let v = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(!v.newer, "{name}: should not be newer");
        } else if expect == "download-ok" || expect.starts_with("download-fail:") {
            let mut v = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            // Rewrite only after verification: the signature covers the original.
            for u in &mut v.part.urls {
                *u = u.replacen(&url_base, &server, 1);
            }
            let dest = dir.path().join(format!("{name}.bin"));
            let res = feed::download(&v.part, &dest, Duration::from_secs(10));
            match expect.strip_prefix("download-fail:") {
                None => {
                    res.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(
                        std::fs::metadata(&dest).unwrap().len(),
                        v.part.size,
                        "{name}"
                    );
                }
                Some(reason) => {
                    assert_eq!(res.expect_err(name).reason(), reason, "{name}");
                    assert!(
                        !dest.exists(),
                        "{name}: failed download must not stay on disk"
                    );
                }
            }
        } else {
            panic!("{name}: unknown expectation {expect}");
        }
    }
}

#[test]
fn semver_ordering_and_invalid() {
    let all = cases();
    let asc: Vec<_> = all["semver"]["ascending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| feed::parse_version(v.as_str().unwrap()).unwrap())
        .collect();
    for w in asc.windows(2) {
        assert!(w[0] < w[1], "{} should be below {}", w[0], w[1]);
    }
    for bad in all["semver"]["invalid"].as_array().unwrap() {
        let s = bad.as_str().unwrap();
        assert!(feed::parse_version(s).is_err(), "{s:?} must be rejected");
    }
}

#[test]
fn sums_exact_name_matching() {
    let all = cases();
    let keys = test_keys(&all);
    let sums_spec = &all["sums"];
    let sums = std::fs::read(testdata().join(sums_spec["file"].as_str().unwrap())).unwrap();
    let sig = std::fs::read(testdata().join(sums_spec["sig"].as_str().unwrap())).unwrap();
    feed::verify_signature(&sums, &sig, &keys).expect("SHA256SUMS signature");
    for c in sums_spec["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let want = c["expect"].as_str().unwrap();
        let got = feed::checksum_for_name(&sums, c["file"].as_str().unwrap());
        match want {
            "not-found" => assert_eq!(got, None, "{name}"),
            hash => assert_eq!(got.as_deref(), Some(hash), "{name}"),
        }
    }
}

#[test]
fn legacy_and_garbage_signatures_are_refused() {
    let all = cases();
    let keys = test_keys(&all);
    assert_eq!(
        feed::verify_signature(b"x", b"not a signature", &keys),
        Err(FeedError::BadSignature)
    );
}
