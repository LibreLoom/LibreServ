//! Software updates from Forgejo `luna-*` releases.
//!
//! Tags look like `luna-0.2.0`. Assets follow LibreServ's checksum file:
//! `lunad-linux-amd64` plus `SHA256SUMS.txt`. Apply is tap-to-update only —
//! never silent. Checksum mismatch refuses the install.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DEFAULT_API: &str = "https://gt.plainskill.net/api/v1";
const DEFAULT_OWNER: &str = "LibreLoom";
const DEFAULT_REPO: &str = "LibreServ";
const TAG_PREFIX: &str = "luna-";

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum UpdateError {
    #[error("Luna couldn't reach the update server. Check that this box is online and try again.")]
    Unreachable,
    #[error("No Luna software update is waiting.")]
    NoneAvailable,
    #[error("That update file didn't match its checksum. Nothing was installed.")]
    Checksum,
    #[error("That update is missing a checksum file. Nothing was installed.")]
    MissingChecksum,
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
        std::fs::rename(&exec, &backup).map_err(|e| UpdateError::Other(e.to_string()))?;
        if let Err(e) = std::fs::rename(&tmp, &exec) {
            let _ = std::fs::rename(&backup, &exec);
            return Err(UpdateError::Other(e.to_string()));
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

        let checksum = self.fetch_checksum(&rel.tag_name, &binary)?;
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

    fn fetch_checksum(&self, tag: &str, binary: &str) -> Result<String, UpdateError> {
        let url = format!("{}/download/{tag}/SHA256SUMS.txt", self.download_base);
        let Ok((status, body)) = self.http.get(&url) else {
            return Ok(String::new());
        };
        if status != 200 {
            return Ok(String::new());
        }
        let text = String::from_utf8_lossy(&body);
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let Some(sum) = parts.next() else { continue };
            let Some(name) = parts.next() else { continue };
            if name.contains(binary) {
                return Ok(sum.to_string());
            }
        }
        Ok(String::new())
    }

    pub fn apply(&self, current_version: &str) -> Result<UpdateInfo, UpdateError> {
        let info = self.check(current_version, true)?;
        if !info.update_available {
            return Err(UpdateError::NoneAvailable);
        }
        if info.checksum.is_empty() {
            return Err(UpdateError::MissingChecksum);
        }
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
        if actual != info.checksum {
            return Err(UpdateError::Checksum);
        }
        self.installer.install_lunad(&bytes)?;
        Ok(info)
    }
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
    use std::collections::HashMap;
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

    #[test]
    fn discovers_newest_luna_tag_and_ignores_libreserv_tags() {
        let api = "http://forgejo.test/api/v1";
        let list = format!("{api}/repos/LibreLoom/LibreServ/releases?limit=50");
        let sums =
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-0.2.0/SHA256SUMS.txt";
        let bin = binary_name();
        let payload = b"fake-lunad-bytes";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
        let mut map = HashMap::new();
        map.insert(
            list,
            (
                200,
                json_releases(&["v1.9.0", "luna-0.1.0", "luna-0.2.0", "connect-2.0.0"]),
            ),
        );
        map.insert(
            sums.to_string(),
            (200, format!("{sum}  {bin}\n").into_bytes()),
        );
        let svc = UpdateService::new(
            Box::new(MapHttp { map }),
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            api.into(),
            "LibreLoom".into(),
            "LibreServ".into(),
        );
        let info = svc.check("0.1.0", true).unwrap();
        assert_eq!(info.latest_version, "luna-0.2.0");
        assert!(info.update_available);
        assert_eq!(info.checksum, sum);
    }

    #[test]
    fn apply_requires_matching_checksum() {
        let api = "http://forgejo.test/api/v1";
        let bin = binary_name();
        let payload = b"good-bytes";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
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
            format!("{api}/repos/LibreLoom/LibreServ/releases?limit=50"),
            (200, json_releases(&["luna-0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-0.2.0/SHA256SUMS.txt"
                .into(),
            (200, format!("{sum}  {bin}\n").into_bytes()),
        );
        map.insert(
            format!("http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-0.2.0/{bin}"),
            (200, payload.to_vec()),
        );
        let svc = UpdateService::new(
            Box::new(MapHttp { map }),
            Box::new(ArcInst(got.clone())),
            api.into(),
            "LibreLoom".into(),
            "LibreServ".into(),
        );
        svc.apply("0.1.0").unwrap();
        assert_eq!(*got.lock().unwrap(), payload);
    }

    #[test]
    fn apply_rejects_bad_checksum() {
        let api = "http://forgejo.test/api/v1";
        let bin = binary_name();
        let mut map = HashMap::new();
        map.insert(
            format!("{api}/repos/LibreLoom/LibreServ/releases?limit=50"),
            (200, json_releases(&["luna-0.2.0"])),
        );
        map.insert(
            "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-0.2.0/SHA256SUMS.txt"
                .into(),
            (200, format!("deadbeef  {bin}\n").into_bytes()),
        );
        map.insert(
            format!("http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-0.2.0/{bin}"),
            (200, b"tampered".to_vec()),
        );
        let svc = UpdateService::new(
            Box::new(MapHttp { map }),
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
            }),
            api.into(),
            "LibreLoom".into(),
            "LibreServ".into(),
        );
        assert_eq!(svc.apply("0.1.0").unwrap_err(), UpdateError::Checksum);
    }

    #[test]
    fn prerelease_luna_tags_are_skipped() {
        let raw = br#"[{"tag_name":"luna-9.0.0","body":"","html_url":"","prerelease":true,"draft":false},{"tag_name":"luna-0.3.0","body":"ok","html_url":"u","prerelease":false,"draft":false}]"#;
        let releases: Vec<ForgejoRelease> = serde_json::from_slice(raw).unwrap();
        let latest = pick_latest_luna(&releases).unwrap();
        assert_eq!(latest.tag_name, "luna-0.3.0");
    }
}
