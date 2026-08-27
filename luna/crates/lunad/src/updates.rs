//! Software updates from Forgejo `luna-v*` releases.
//!
//! Tags look like `luna-v0.2.0`. LibreServ stays on `v*`. Assets:
//! `lunad-linux-amd64`, `SHA256SUMS.txt`, and `SHA256SUMS.txt.minisig`.
//! Apply is tap-to-update only — never silent. A missing or invalid minisign
//! signature, or a checksum mismatch, refuses the install. Draft and
//! prerelease tags are ignored.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DEFAULT_API: &str = "https://gt.plainskill.net/api/v1";
const DEFAULT_OWNER: &str = "LibreLoom";
const DEFAULT_REPO: &str = "LibreServ";
const TAG_PREFIX: &str = "luna-v";

/// Committed minisign public key (`keys/releases.minisign.pub`).
const PINNED_PUB: &str = include_str!("../../../../keys/releases.minisign.pub");

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum UpdateError {
    #[error("Luna couldn't reach the update server. Check that this Luna is online and try again.")]
    Unreachable,
    #[error("No Luna software update is waiting.")]
    NoneAvailable,
    #[error("That update file didn't match its checksum. Nothing was installed.")]
    Checksum,
    #[error("That update is missing a checksum file. Nothing was installed.")]
    MissingChecksum,
    #[error("That update is missing its signature. Nothing was installed.")]
    MissingSignature,
    #[error("That update could not be verified. Nothing was installed.")]
    BadSignature,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: String,
    pub url: String,
    pub checksum: String,
    pub binary_name: String,
}

pub trait HttpGet: Send + Sync {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError>;
}

pub trait Installer: Send + Sync {
    fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError>;
}

pub struct UreqHttp;

impl HttpGet for UreqHttp {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
        let resp = ureq::get(url)
            .call()
            .map_err(|_| UpdateError::Unreachable)?;
        let status = resp.status().as_u16();
        let mut body = Vec::new();
        resp.into_body()
            .into_reader()
            .read_to_end(&mut body)
            .map_err(|_| UpdateError::Unreachable)?;
        Ok((status, body))
    }
}

/// Replace the running lunad binary (same path OpenRC already supervises).
pub struct BinaryInstaller;

impl Installer for BinaryInstaller {
    fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
        let exec = std::env::current_exe().map_err(|e| UpdateError::Other(e.to_string()))?;
        let tmp = exec.with_extension("update-tmp");
        {
            let mut f =
                std::fs::File::create(&tmp).map_err(|e| UpdateError::Other(e.to_string()))?;
            f.write_all(bytes)
                .map_err(|e| UpdateError::Other(e.to_string()))?;
            f.sync_all()
                .map_err(|e| UpdateError::Other(e.to_string()))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&tmp)
                .map_err(|e| UpdateError::Other(e.to_string()))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&tmp, perms).map_err(|e| UpdateError::Other(e.to_string()))?;
        }
        let backup = PathBuf::from(format!("{}.old", exec.display()));
        // Swap tmp and exec in one atomic step so a power cut between the two
        // renames of the old scheme can never leave no binary at `exec` (which
        // would stop OpenRC from restarting lunad at all). After the exchange,
        // `tmp` holds the previous binary and becomes the `.old` backup.
        #[cfg(unix)]
        {
            use std::ffi::CString;
            use std::os::unix::ffi::OsStrExt;
            let to_c = |p: &Path| -> Result<CString, UpdateError> {
                CString::new(p.as_os_str().as_bytes())
                    .map_err(|_| UpdateError::Other("NUL byte in binary path".into()))
            };
            let exec_c = to_c(&exec)?;
            let tmp_c = to_c(&tmp)?;
            // musl 1.2.x has SYS_renameat2 but no renameat2() wrapper; use syscall.
            const RENAME_EXCHANGE: libc::c_uint = 2;
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    libc::AT_FDCWD,
                    exec_c.as_ptr(),
                    libc::AT_FDCWD,
                    tmp_c.as_ptr(),
                    RENAME_EXCHANGE,
                )
            };
            if rc == 0 {
                // Old binary now lives at `tmp`; park it as the rollback copy.
                let _ = std::fs::remove_file(&backup);
                let _ = std::fs::rename(&tmp, &backup);
            } else {
                // Kernel/filesystem without RENAME_EXCHANGE: fall back to the
                // two-step rename, restoring on failure.
                std::fs::rename(&exec, &backup).map_err(|e| UpdateError::Other(e.to_string()))?;
                if let Err(e) = std::fs::rename(&tmp, &exec) {
                    let _ = std::fs::rename(&backup, &exec);
                    return Err(UpdateError::Other(e.to_string()));
                }
            }
        }
        #[cfg(not(unix))]
        {
            std::fs::rename(&exec, &backup).map_err(|e| UpdateError::Other(e.to_string()))?;
            if let Err(e) = std::fs::rename(&tmp, &exec) {
                let _ = std::fs::rename(&backup, &exec);
                return Err(UpdateError::Other(e.to_string()));
            }
        }
        // Persist the directory entries themselves, not just the file data.
        if let Some(parent) = exec.parent()
            && let Ok(dir) = std::fs::File::open(parent)
        {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}

pub struct UpdateService {
    http: Box<dyn HttpGet>,
    installer: Box<dyn Installer>,
    api_base: String,
    download_base: String,
    owner: String,
    repo: String,
    pinned_keys: Vec<String>,
    cache: Mutex<Option<(Instant, UpdateInfo)>>,
}

impl UpdateService {
    pub fn from_env() -> Self {
        let api = std::env::var("LUNA_UPDATES_API").unwrap_or_else(|_| DEFAULT_API.into());
        let owner = std::env::var("LUNA_UPDATES_OWNER").unwrap_or_else(|_| DEFAULT_OWNER.into());
        let repo = std::env::var("LUNA_UPDATES_REPO").unwrap_or_else(|_| DEFAULT_REPO.into());
        Self::new(
            Box::new(UreqHttp),
            Box::new(BinaryInstaller),
            api,
            owner,
            repo,
        )
    }

    pub fn new(
        http: Box<dyn HttpGet>,
        installer: Box<dyn Installer>,
        api_base: String,
        owner: String,
        repo: String,
    ) -> Self {
        Self::with_keys(
            http,
            installer,
            api_base,
            owner,
            repo,
            parse_minisign_pub(PINNED_PUB),
        )
    }

    fn with_keys(
        http: Box<dyn HttpGet>,
        installer: Box<dyn Installer>,
        api_base: String,
        owner: String,
        repo: String,
        pinned_keys: Vec<String>,
    ) -> Self {
        let api_base = api_base.trim_end_matches('/').to_string();
        let host = api_base
            .trim_end_matches("/api/v1")
            .trim_end_matches("/api")
            .to_string();
        let download_base = format!("{host}/{owner}/{repo}/releases");
        Self {
            http,
            installer,
            api_base,
            download_base,
            owner,
            repo,
            pinned_keys,
            cache: Mutex::new(None),
        }
    }

    pub fn check(&self, current_version: &str, force: bool) -> Result<UpdateInfo, UpdateError> {
        if !force
            && let Ok(guard) = self.cache.lock()
            && let Some((at, info)) = guard.as_ref()
            && at.elapsed() < Duration::from_secs(3600)
            && info.current_version == current_version
        {
            return Ok(info.clone());
        }

        let url = format!(
            "{}/repos/{}/{}/releases?limit=50",
            self.api_base, self.owner, self.repo
        );
        let (status, body) = self.http.get(&url)?;
        if status != 200 {
            return Err(UpdateError::Unreachable);
        }
        let releases: Vec<ForgejoRelease> =
            serde_json::from_slice(&body).map_err(|_| UpdateError::Unreachable)?;
        let latest = pick_latest_luna(&releases);
        let binary = binary_name();
        let Some(rel) = latest else {
            let info = UpdateInfo {
                current_version: current_version.to_string(),
                latest_version: format!("{TAG_PREFIX}{current_version}"),
                update_available: false,
                release_notes: String::new(),
                url: String::new(),
                checksum: String::new(),
                binary_name: binary,
            };
            *self.cache.lock().unwrap() = Some((Instant::now(), info.clone()));
            return Ok(info);
        };

        let checksum = self
            .fetch_signed_checksum(&rel.tag_name, &binary)
            .unwrap_or_default();
        let latest_ver = strip_tag(&rel.tag_name);
        let available = version_newer(&latest_ver, current_version);
        let info = UpdateInfo {
            current_version: current_version.to_string(),
            latest_version: rel.tag_name.clone(),
            update_available: available,
            release_notes: rel.body.clone(),
            url: rel.html_url.clone(),
            checksum,
            binary_name: binary,
        };
        *self.cache.lock().unwrap() = Some((Instant::now(), info.clone()));
        Ok(info)
    }

    fn fetch_signed_checksum(&self, tag: &str, binary: &str) -> Result<String, UpdateError> {
        let sums_url = format!("{}/download/{tag}/SHA256SUMS.txt", self.download_base);
        let sig_url = format!(
            "{}/download/{tag}/SHA256SUMS.txt.minisig",
            self.download_base
        );
        let (sums_status, sums) = self.http.get(&sums_url)?;
        if sums_status != 200 {
            return Err(UpdateError::MissingChecksum);
        }
        let (sig_status, sig) = match self.http.get(&sig_url) {
            Ok(v) => v,
            Err(_) => return Err(UpdateError::MissingSignature),
        };
        if sig_status != 200 {
            return Err(UpdateError::MissingSignature);
        }
        verify_sums_signature(&self.pinned_keys, &sums, &sig)?;
        checksum_for_binary(&sums, binary)
    }

    pub fn apply(&self, current_version: &str) -> Result<UpdateInfo, UpdateError> {
        let info = self.check(current_version, true)?;
        if !info.update_available {
            return Err(UpdateError::NoneAvailable);
        }
        let checksum = self.fetch_signed_checksum(&info.latest_version, &info.binary_name)?;
        let url = format!(
            "{}/download/{}/{}",
            self.download_base, info.latest_version, info.binary_name
        );
        let (status, bytes) = self.http.get(&url)?;
        if status != 200 {
            return Err(UpdateError::Unreachable);
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual = hex_lower(&hasher.finalize());
        if actual != checksum {
            return Err(UpdateError::Checksum);
        }
        self.installer.install_lunad(&bytes)?;
        Ok(info)
    }
}

fn parse_minisign_pub(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("untrusted comment"))
        .filter(|l| l.starts_with("RW"))
        .map(|s| s.to_string())
        .collect()
}

fn verify_sums_signature(keys: &[String], sums: &[u8], sig: &[u8]) -> Result<(), UpdateError> {
    let sig_text = std::str::from_utf8(sig).map_err(|_| UpdateError::BadSignature)?;
    let signature = Signature::decode(sig_text).map_err(|_| UpdateError::BadSignature)?;
    for k in keys {
        if let Ok(pk) = PublicKey::from_base64(k)
            && pk.verify(sums, &signature, false).is_ok()
        {
            return Ok(());
        }
    }
    Err(UpdateError::BadSignature)
}

fn checksum_for_binary(sums: &[u8], binary: &str) -> Result<String, UpdateError> {
    let text = String::from_utf8_lossy(sums);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(sum) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        if name.contains(binary) {
            return Ok(sum.to_string());
        }
    }
    Err(UpdateError::MissingChecksum)
}

#[derive(Debug, Deserialize)]
struct ForgejoRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

fn pick_latest_luna(releases: &[ForgejoRelease]) -> Option<&ForgejoRelease> {
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease && r.tag_name.starts_with(TAG_PREFIX))
        .max_by(|a, b| cmp_version(&strip_tag(&a.tag_name), &strip_tag(&b.tag_name)))
}

fn strip_tag(tag: &str) -> String {
    tag.trim()
        .trim_start_matches(TAG_PREFIX)
        .trim_start_matches('v')
        .to_string()
}

fn version_newer(latest: &str, current: &str) -> bool {
    if current == "dev" {
        return false;
    }
    cmp_version(latest, current) == std::cmp::Ordering::Greater
}

fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = parse_ver(a);
    let pb = parse_ver(b);
    pa.cmp(&pb)
}

fn parse_ver(s: &str) -> (u64, u64, u64) {
    let mut it = s.split('.');
    let maj = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let min = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let pat = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (maj, min, pat)
}

fn binary_name() -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("lunad-{os}-{arch}")
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use minisign::KeyPair;
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::Mutex;

    struct MapHttp {
        map: HashMap<String, (u16, Vec<u8>)>,
    }

    impl HttpGet for MapHttp {
        fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
            self.map.get(url).cloned().ok_or(UpdateError::Unreachable)
        }
    }

    struct RecInstaller {
        got: Mutex<Vec<u8>>,
    }

    impl Installer for RecInstaller {
        fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
            *self.got.lock().unwrap() = bytes.to_vec();
            Ok(())
        }
    }

    fn json_releases(tags: &[&str]) -> Vec<u8> {
        let items: Vec<String> = tags
            .iter()
            .map(|t| {
                format!(
                    r#"{{"tag_name":"{t}","body":"notes for {t}","html_url":"https://example.test/{t}","prerelease":false,"draft":false}}"#
                )
            })
            .collect();
        format!("[{}]", items.join(",")).into_bytes()
    }

    fn ephemeral_sign(sums: &[u8]) -> (String, Vec<u8>) {
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        let pk_line = pk.to_base64();
        let sig = minisign::sign(None, &sk, Cursor::new(sums), None, None).unwrap();
        (pk_line, sig.to_string().into_bytes())
    }

    fn svc_with(
        map: HashMap<String, (u16, Vec<u8>)>,
        installer: Box<dyn Installer>,
        pk: String,
    ) -> UpdateService {
        UpdateService::with_keys(
            Box::new(MapHttp { map }),
            installer,
            "http://forgejo.test/api/v1".into(),
            "LibreLoom".into(),
            "LibreServ".into(),
            vec![pk],
        )
    }

    #[test]
    fn pinned_pub_parses() {
        assert!(
            !parse_minisign_pub(PINNED_PUB).is_empty(),
            "keys/releases.minisign.pub must contain an RW public key line"
        );
    }

    #[test]
    fn discovers_newest_luna_tag_and_ignores_libreserv_tags() {
        let api = "http://forgejo.test/api/v1";
        let list = format!("{api}/repos/LibreLoom/LibreServ/releases?limit=50");
        let sums_url =
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt";
        let sig_url = "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt.minisig";
        let bin = binary_name();
        let payload = b"fake-lunad-bytes";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
        let sums = format!("{sum}  {bin}\n");
        let (pk, sig) = ephemeral_sign(sums.as_bytes());
        let mut map = HashMap::new();
        map.insert(
            list,
            (
                200,
                json_releases(&["v1.9.0", "luna-v0.1.0", "luna-v0.2.0", "connect-2.0.0"]),
            ),
        );
        map.insert(sums_url.to_string(), (200, sums.into_bytes()));
        map.insert(sig_url.to_string(), (200, sig));
        let svc = svc_with(
            map,
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            pk,
        );
        let info = svc.check("0.1.0", true).unwrap();
        assert_eq!(info.latest_version, "luna-v0.2.0");
        assert!(info.update_available);
        assert_eq!(info.checksum, sum);
    }

    #[test]
    fn apply_requires_matching_checksum() {
        let bin = binary_name();
        let payload = b"good-bytes";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
        let sums = format!("{sum}  {bin}\n");
        let (pk, sig) = ephemeral_sign(sums.as_bytes());
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        struct ArcInst(std::sync::Arc<Mutex<Vec<u8>>>);
        impl Installer for ArcInst {
            fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
                *self.0.lock().unwrap() = bytes.to_vec();
                Ok(())
            }
        }
        let mut map = HashMap::new();
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt"
                .into(),
            (200, sums.into_bytes()),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt.minisig"
                .into(),
            (200, sig),
        );
        map.insert(
            format!("http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/{bin}"),
            (200, payload.to_vec()),
        );
        let svc = svc_with(map, Box::new(ArcInst(got.clone())), pk);
        svc.apply("0.1.0").unwrap();
        assert_eq!(*got.lock().unwrap(), payload);
    }

    #[test]
    fn apply_rejects_bad_checksum() {
        let bin = binary_name();
        let sums = format!("deadbeef  {bin}\n");
        let (pk, sig) = ephemeral_sign(sums.as_bytes());
        let mut map = HashMap::new();
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt"
                .into(),
            (200, sums.into_bytes()),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt.minisig"
                .into(),
            (200, sig),
        );
        map.insert(
            format!("http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/{bin}"),
            (200, b"tampered".to_vec()),
        );
        let svc = svc_with(
            map,
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            pk,
        );
        assert_eq!(svc.apply("0.1.0").unwrap_err(), UpdateError::Checksum);
    }

    #[test]
    fn apply_rejects_missing_signature() {
        let bin = binary_name();
        let mut map = HashMap::new();
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt"
                .into(),
            (200, format!("abc  {bin}\n").into_bytes()),
        );
        let svc = svc_with(
            map,
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            "RWnotarealkey".into(),
        );
        assert_eq!(
            svc.apply("0.1.0").unwrap_err(),
            UpdateError::MissingSignature
        );
    }

    #[test]
    fn apply_rejects_wrong_key() {
        let bin = binary_name();
        let sums = format!("deadbeef  {bin}\n");
        let (_pk, sig) = ephemeral_sign(sums.as_bytes());
        let other = ephemeral_sign(b"other").0;
        let mut map = HashMap::new();
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt"
                .into(),
            (200, sums.into_bytes()),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/SHA256SUMS.txt.minisig"
                .into(),
            (200, sig),
        );
        let svc = svc_with(
            map,
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            other,
        );
        assert_eq!(svc.apply("0.1.0").unwrap_err(), UpdateError::BadSignature);
    }

    #[test]
    fn prerelease_luna_tags_are_skipped() {
        let raw = br#"[{"tag_name":"luna-v9.0.0","body":"","html_url":"","prerelease":true,"draft":false},{"tag_name":"luna-v0.3.0","body":"ok","html_url":"u","prerelease":false,"draft":false},{"tag_name":"v0.4.0","body":"libreserv","html_url":"","prerelease":false,"draft":false},{"tag_name":"luna-0.9.0","body":"old prefix","html_url":"","prerelease":false,"draft":false}]"#;
        let releases: Vec<ForgejoRelease> = serde_json::from_slice(raw).unwrap();
        let latest = pick_latest_luna(&releases).unwrap();
        assert_eq!(latest.tag_name, "luna-v0.3.0");
    }
}
