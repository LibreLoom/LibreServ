//! Signed update feeds, Format 1 (`infra/docs/RELEASE-PLAN.md`).
//!
//! Receivers (lunad, Luna Desktop on Windows) fetch `<unit>/<channel>.json`
//! and its `.minisig`, then call [`check`], which runs the spec's rules in
//! order: signature, format, unit, channel, replay, part, version. Keys are
//! always passed in, so tests can use a throwaway key and production code
//! pins its own.
//!
//! Downloading is split in two: [`download_with`] has the size and SHA-256
//! rules and takes any way of opening a URL; [`download`] (feature
//! `download`) plugs in a blocking HTTP client.

use std::io::{Read, Write};
use std::path::Path;

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The feed format this code understands.
pub const FORMAT: u64 = 1;

/// Why a feed or a download was refused. [`FeedError::reason`] gives the short
/// code the shared test fixtures (`infra/feed-testdata/cases.json`) use.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum FeedError {
    #[error("the feed signature is not valid for any trusted key")]
    BadSignature,
    #[error("the feed is not valid JSON in the expected shape: {0}")]
    Malformed(String),
    #[error("the feed uses format {0}, which this software does not understand")]
    UnknownFormat(u64),
    #[error("the feed is for another product")]
    WrongUnit,
    #[error("the feed is for another channel")]
    WrongChannel,
    #[error("the feed is older than one already seen")]
    Replayed,
    #[error("the feed has no file for this device")]
    MissingPart,
    #[error("not a valid version number: {0:?}")]
    BadVersion(String),
    #[error("the downloaded file is not the size the feed promised")]
    SizeMismatch,
    #[error("the downloaded file does not match the feed's checksum")]
    ShaMismatch,
    #[error("none of the download addresses worked")]
    AllUrlsFailed,
    #[error("could not save the download: {0}")]
    Io(String),
}

impl FeedError {
    /// The fixture reason code (`bad-signature`, `wrong-unit`, ...). Errors
    /// the fixtures never expect return a descriptive code of their own.
    pub fn reason(&self) -> &'static str {
        match self {
            FeedError::BadSignature => "bad-signature",
            FeedError::Malformed(_) => "malformed",
            FeedError::UnknownFormat(_) => "unknown-format",
            FeedError::WrongUnit => "wrong-unit",
            FeedError::WrongChannel => "wrong-channel",
            FeedError::Replayed => "replayed",
            FeedError::MissingPart => "missing-part",
            FeedError::BadVersion(_) => "bad-version",
            FeedError::SizeMismatch => "size-mismatch",
            FeedError::ShaMismatch => "sha-mismatch",
            FeedError::AllUrlsFailed => "all-urls-failed",
            FeedError::Io(_) => "io",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Feed {
    pub format: u64,
    pub unit: String,
    pub channel: String,
    pub version: String,
    /// UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`, so string order is time order.
    pub published: String,
    #[serde(default)]
    pub notes: String,
    pub parts: Vec<Part>,
    #[serde(default)]
    pub api: Option<FeedApi>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub os: String,
    pub arch: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedApi {
    pub version: u64,
    pub oldest_supported: u64,
}

/// What the receiver asks for and what it already has.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub unit: &'a str,
    pub channel: &'a str,
    pub part: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    pub installed_version: &'a str,
    /// Newest `published` seen for this unit + channel; empty for none.
    pub newest_published_seen: &'a str,
}

/// A feed that passed every rule.
#[derive(Debug, Clone)]
pub struct Verified {
    pub feed: Feed,
    pub part: Part,
    /// The feed's version is strictly newer than the installed one. Receivers
    /// never install a lower or equal version.
    pub newer: bool,
    /// The feed's version is strictly lower than the installed one. Receivers
    /// must not move to it (bad releases are fixed forward).
    pub older: bool,
}

/// Accepts a key as a bare `RW...` line or as the text of a whole `.pub` file.
fn public_keys(keys: &[impl AsRef<str>]) -> Vec<PublicKey> {
    let mut out = Vec::new();
    for k in keys {
        for line in k.as_ref().lines() {
            let line = line.trim();
            if line.starts_with("RW")
                && let Ok(pk) = PublicKey::from_base64(line)
            {
                out.push(pk);
            }
        }
    }
    out
}

/// Verify minisign's prehashed (`ED`) signature over the exact feed bytes.
/// Legacy (`Ed`) signatures are refused.
pub fn verify_signature(
    bytes: &[u8],
    sig: &[u8],
    keys: &[impl AsRef<str>],
) -> Result<(), FeedError> {
    let sig = std::str::from_utf8(sig).map_err(|_| FeedError::BadSignature)?;
    let sig = Signature::decode(sig).map_err(|_| FeedError::BadSignature)?;
    for pk in public_keys(keys) {
        if pk.verify(bytes, &sig, false).is_ok() {
            return Ok(());
        }
    }
    Err(FeedError::BadSignature)
}

/// Strict semver 2.0: no leading `v`, no leading zeros, no whitespace.
pub fn parse_version(s: &str) -> Result<Version, FeedError> {
    match Version::parse(s) {
        Ok(v) if v.to_string() == s => Ok(v),
        _ => Err(FeedError::BadVersion(s.to_string())),
    }
}

fn valid_published(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// Verify, parse, and apply the receiver rules, in the spec's order.
pub fn check(
    feed_bytes: &[u8],
    sig: &[u8],
    keys: &[impl AsRef<str>],
    req: &Request<'_>,
) -> Result<Verified, FeedError> {
    verify_signature(feed_bytes, sig, keys)?;

    let raw: serde_json::Value =
        serde_json::from_slice(feed_bytes).map_err(|e| FeedError::Malformed(e.to_string()))?;
    let format = raw
        .get("format")
        .and_then(|f| f.as_u64())
        .ok_or_else(|| FeedError::Malformed("missing format".into()))?;
    if format != FORMAT {
        return Err(FeedError::UnknownFormat(format));
    }
    let feed: Feed =
        serde_json::from_value(raw).map_err(|e| FeedError::Malformed(e.to_string()))?;

    if feed.unit != req.unit {
        return Err(FeedError::WrongUnit);
    }
    if feed.channel != req.channel {
        return Err(FeedError::WrongChannel);
    }
    if !valid_published(&feed.published) {
        return Err(FeedError::Malformed(
            "published is not a UTC timestamp".into(),
        ));
    }
    // Equal is fine; older than the newest seen is a replayed old feed.
    if !req.newest_published_seen.is_empty() && feed.published.as_str() < req.newest_published_seen
    {
        return Err(FeedError::Replayed);
    }
    let part = select_part(&feed.parts, req.part, req.os, req.arch)
        .cloned()
        .ok_or(FeedError::MissingPart)?;

    let latest = parse_version(&feed.version)?;
    let installed = parse_version(req.installed_version)?;
    Ok(Verified {
        newer: latest > installed,
        older: latest < installed,
        feed,
        part,
    })
}

/// First part with this name whose `os` and `arch` are the request's or `any`.
pub fn select_part<'a>(parts: &'a [Part], name: &str, os: &str, arch: &str) -> Option<&'a Part> {
    parts.iter().find(|p| {
        p.name == name && (p.os == os || p.os == "any") && (p.arch == arch || p.arch == "any")
    })
}

/// The SHA-256 for `name` in a `SHA256SUMS.txt`. The file name field must equal
/// `name` exactly (a leading `*`, sha256sum's binary marker, is allowed);
/// substrings, prefixes and other paths never match.
pub fn checksum_for_name(sums: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(sums);
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(sum), Some(file)) = (fields.next(), fields.next()) else {
            continue;
        };
        if file.strip_prefix('*').unwrap_or(file) == name {
            return Some(sum.to_string());
        }
    }
    None
}

pub fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Open the destination for writing without following a planted symlink.
fn open_dest(dest: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts.open(dest)
}

/// Try each of the part's `urls` in order. A failed address (cannot open) goes
/// on to the next. The body is read at most `size + 1` bytes, then checked
/// against `size` and `sha256`; on success it is left at `dest`, otherwise
/// `dest` is removed. If every address failed, the error is the last size or
/// checksum problem seen, else [`FeedError::AllUrlsFailed`].
pub fn download_with<F>(part: &Part, dest: &Path, mut open: F) -> Result<(), FeedError>
where
    F: FnMut(&str) -> std::io::Result<Box<dyn Read>>,
{
    let mut integrity: Option<FeedError> = None;
    for url in &part.urls {
        let Ok(reader) = open(url) else { continue };
        match save_checked(part, dest, reader) {
            Ok(()) => return Ok(()),
            Err(e @ (FeedError::SizeMismatch | FeedError::ShaMismatch)) => integrity = Some(e),
            Err(FeedError::Io(m)) => {
                let _ = std::fs::remove_file(dest);
                return Err(FeedError::Io(m));
            }
            Err(_) => {}
        }
    }
    let _ = std::fs::remove_file(dest);
    Err(integrity.unwrap_or(FeedError::AllUrlsFailed))
}

fn save_checked(part: &Part, dest: &Path, reader: Box<dyn Read>) -> Result<(), FeedError> {
    let io = |e: std::io::Error| FeedError::Io(e.to_string());
    let mut file = open_dest(dest).map_err(io)?;
    let mut limited = reader.take(part.size.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        // A connection that drops mid-body counts as this address failing.
        let n = limited
            .read(&mut buf)
            .map_err(|_| FeedError::AllUrlsFailed)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(io)?;
    }
    if total != part.size {
        return Err(FeedError::SizeMismatch);
    }
    if !hex_lower(&hasher.finalize()).eq_ignore_ascii_case(&part.sha256) {
        return Err(FeedError::ShaMismatch);
    }
    file.sync_all().map_err(io)?;
    Ok(())
}

/// [`download_with`] over blocking HTTP (ureq). `timeout` bounds each request
/// end to end.
#[cfg(feature = "download")]
pub fn download(part: &Part, dest: &Path, timeout: std::time::Duration) -> Result<(), FeedError> {
    download_with(part, dest, |url| {
        let resp = ureq::get(url)
            .config()
            .timeout_global(Some(timeout))
            .timeout_connect(Some(std::time::Duration::from_secs(10)))
            .build()
            .call()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Box::new(resp.into_body().into_reader()) as Box<dyn Read>)
    })
}
