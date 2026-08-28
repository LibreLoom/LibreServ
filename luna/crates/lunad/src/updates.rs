//! Software updates from Forgejo `luna-v*` releases.
//!
//! Tags look like `luna-v0.2.0`. LibreServ stays on `v*`. Assets:
//! `lunad-linux-amd64`, optional `luna-os-x86_64.img` on OS cuts,
//! `SHA256SUMS.txt`, and `SHA256SUMS.txt.minisig`.
//!
//! Apply is tap-to-update only — never silent. When the release includes an
//! OS slot image whose SHA256 differs from the hash stored on LUNA_DATA,
//! that image is applied automatically in the same Install update (inactive
//! A/B slot + tryboot). The Settings UI does not differentiate OS vs software.
//! Draft and prerelease tags are ignored.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use minisign_verify::{PublicKey, Signature};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DEFAULT_API: &str = "https://gt.plainskill.net/api/v1";
const DEFAULT_OWNER: &str = "LibreLoom";
const DEFAULT_REPO: &str = "LibreServ";
const TAG_PREFIX: &str = "luna-v";
const OS_IMAGE_NAME: &str = "luna-os-x86_64.img";
const OS_HASH_FILE: &str = "os-image.sha256";
/// OS slot images are streamed to disk, never held in RAM. Cap matches the
/// 1280 MiB A/B slot plus a little headroom.
const OS_IMAGE_MAX_BYTES: u64 = 1536 * 1024 * 1024;

/// Committed Luna minisign public key (`keys/lsluna.minisign.pub`).
/// This is Luna’s production trust root (separate from LibreServ).
const PINNED_PUB: &str = include_str!("../../../../keys/lsluna.minisign.pub");

/// Meta-table key for the persisted update-source settings.
const SETTINGS_META_KEY: &str = "updates_config";
/// A public key is one short base64 line; a config blob is bounded so a bad
/// save can never bloat the DB.
const MAX_PUB_TEXT_BYTES: usize = 16 * 1024;
const MAX_KEYS: usize = 8;

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
    /// True when applying will (or did) write an OS slot and reboot the box.
    #[serde(default)]
    pub reboot_required: bool,
}

pub trait HttpGet: Send + Sync {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError>;

    /// Download into `dest`, hashing while writing. Refuses bodies over `max_bytes`
    /// so an update can never fill RAM on a 2 GiB box.
    fn get_to_file(
        &self,
        url: &str,
        dest: &Path,
        max_bytes: u64,
    ) -> Result<(u16, String), UpdateError> {
        let (status, bytes) = self.get(url)?;
        if (bytes.len() as u64) > max_bytes {
            return Err(UpdateError::Other(
                "That update file is too large for the free memory on this Luna.".into(),
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let mut f = std::fs::File::create(dest).map_err(|e| UpdateError::Other(e.to_string()))?;
        f.write_all(&bytes)
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        f.sync_all()
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        Ok((status, hex_lower(&hasher.finalize())))
    }
}

pub trait Installer: Send + Sync {
    fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError>;

    /// Install from a file already streamed to disk. Default reads into memory
    /// — production overrides this so a 2 GiB box never holds the binary in RAM.
    fn install_lunad_file(&self, path: &Path) -> Result<(), UpdateError> {
        let bytes = std::fs::read(path).map_err(|e| UpdateError::Other(e.to_string()))?;
        self.install_lunad(&bytes)
    }

    fn install_os_image(&self, bytes: &[u8]) -> Result<(), UpdateError> {
        let _ = bytes;
        Err(UpdateError::Other(
            "This Luna cannot apply an OS image update here.".into(),
        ))
    }

    /// Stream an OS slot image from disk onto the inactive A/B partition.
    fn install_os_image_file(&self, path: &Path) -> Result<(), UpdateError> {
        let bytes = std::fs::read(path).map_err(|e| UpdateError::Other(e.to_string()))?;
        self.install_os_image(&bytes)
    }

    fn read_os_hash(&self) -> Option<String> {
        None
    }
    fn write_os_hash(&self, _hash: &str) -> Result<(), UpdateError> {
        Ok(())
    }
}

pub struct UreqHttp;

impl HttpGet for UreqHttp {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
        let max = crate::budget::limits().update_download_bytes;
        let resp = ureq::get(url)
            .call()
            .map_err(|_| UpdateError::Unreachable)?;
        let status = resp.status().as_u16();
        let mut body = Vec::new();
        let mut reader = resp.into_body().into_reader();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| UpdateError::Unreachable)?;
            if n == 0 {
                break;
            }
            if (body.len() as u64) + (n as u64) > max {
                return Err(UpdateError::Other(
                    "That update file is too large for the free memory on this Luna.".into(),
                ));
            }
            body.extend_from_slice(&buf[..n]);
        }
        Ok((status, body))
    }

    fn get_to_file(
        &self,
        url: &str,
        dest: &Path,
        max_bytes: u64,
    ) -> Result<(u16, String), UpdateError> {
        let resp = ureq::get(url)
            .call()
            .map_err(|_| UpdateError::Unreachable)?;
        let status = resp.status().as_u16();
        let mut reader = resp.into_body().into_reader();
        let mut file =
            std::fs::File::create(dest).map_err(|e| UpdateError::Other(e.to_string()))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| UpdateError::Unreachable)?;
            if n == 0 {
                break;
            }
            written = written
                .checked_add(n as u64)
                .filter(|w| *w <= max_bytes)
                .ok_or_else(|| {
                    let _ = std::fs::remove_file(dest);
                    UpdateError::Other(
                        "That update file is too large for the free memory on this Luna.".into(),
                    )
                })?;
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])
                .map_err(|e| UpdateError::Other(e.to_string()))?;
        }
        file.sync_all()
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        let _ = written;
        Ok((status, hex_lower(&hasher.finalize())))
    }
}

/// Install lunad under `$data_dir/bin/` (LUNA_DATA) and OS images into the
/// inactive A/B slot. OpenRC's `luna-run` prefers the data-dir binary.
pub struct DataDirInstaller {
    pub data_dir: PathBuf,
}

impl DataDirInstaller {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    fn hash_path(&self) -> PathBuf {
        self.data_dir.join(OS_HASH_FILE)
    }

    fn lunad_path(&self) -> PathBuf {
        self.data_dir.join("bin").join("lunad")
    }
}

impl Installer for DataDirInstaller {
    fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
        let bin_dir = self.data_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        let exec = self.lunad_path();
        let tmp = exec.with_extension("update-tmp");
        {
            let mut f =
                std::fs::File::create(&tmp).map_err(|e| UpdateError::Other(e.to_string()))?;
            f.write_all(bytes)
                .map_err(|e| UpdateError::Other(e.to_string()))?;
            f.sync_all()
                .map_err(|e| UpdateError::Other(e.to_string()))?;
        }
        swap_exec(&exec, &tmp)
    }

    fn install_lunad_file(&self, src: &Path) -> Result<(), UpdateError> {
        let bin_dir = self.data_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        let exec = self.lunad_path();
        let staged = stage_beside(src, &exec)?;
        swap_exec(&exec, &staged)
    }

    fn install_os_image(&self, bytes: &[u8]) -> Result<(), UpdateError> {
        let (part, inactive) = inactive_slot_device()?;
        {
            let mut f =
                std::fs::File::create(&part).map_err(|e| UpdateError::Other(e.to_string()))?;
            f.write_all(bytes)
                .map_err(|e| UpdateError::Other(e.to_string()))?;
            f.sync_all()
                .map_err(|e| UpdateError::Other(e.to_string()))?;
        }
        finish_os_slot(&part, inactive)
    }

    fn install_os_image_file(&self, src: &Path) -> Result<(), UpdateError> {
        let (part, inactive) = inactive_slot_device()?;
        copy_file_streaming(src, &part)?;
        finish_os_slot(&part, inactive)
    }

    fn read_os_hash(&self) -> Option<String> {
        std::fs::read_to_string(self.hash_path())
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn write_os_hash(&self, hash: &str) -> Result<(), UpdateError> {
        std::fs::create_dir_all(&self.data_dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        let path = self.hash_path();
        let tmp = path.with_extension("sha256.tmp");
        std::fs::write(&tmp, format!("{hash}\n")).map_err(|e| UpdateError::Other(e.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|e| UpdateError::Other(e.to_string()))?;
        Ok(())
    }
}

fn chmod_755(path: &Path) -> Result<(), UpdateError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| UpdateError::Other(e.to_string()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).map_err(|e| UpdateError::Other(e.to_string()))?;
    }
    Ok(())
}

/// Place `src` next to `dest` as `dest.update-tmp`, copying across devices
/// when rename would fail.
fn stage_beside(src: &Path, dest: &Path) -> Result<PathBuf, UpdateError> {
    let staged = dest.with_extension("update-tmp");
    if src == staged {
        return Ok(staged);
    }
    if std::fs::rename(src, &staged).is_err() {
        std::fs::copy(src, &staged).map_err(|e| UpdateError::Other(e.to_string()))?;
        let _ = std::fs::remove_file(src);
    }
    Ok(staged)
}

/// Swap `tmp` into `exec` with renameat2 when possible so a power cut cannot
/// leave no binary at `exec`.
fn swap_exec(exec: &Path, tmp: &Path) -> Result<(), UpdateError> {
    chmod_755(tmp)?;
    let backup = PathBuf::from(format!("{}.old", exec.display()));
    if exec.exists() {
        #[cfg(unix)]
        {
            use std::ffi::CString;
            use std::os::unix::ffi::OsStrExt;
            let to_c = |p: &Path| -> Result<CString, UpdateError> {
                CString::new(p.as_os_str().as_bytes())
                    .map_err(|_| UpdateError::Other("NUL byte in binary path".into()))
            };
            let exec_c = to_c(exec)?;
            let tmp_c = to_c(tmp)?;
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
                let _ = std::fs::remove_file(&backup);
                let _ = std::fs::rename(tmp, &backup);
            } else {
                std::fs::rename(exec, &backup).map_err(|e| UpdateError::Other(e.to_string()))?;
                if let Err(e) = std::fs::rename(tmp, exec) {
                    let _ = std::fs::rename(&backup, exec);
                    return Err(UpdateError::Other(e.to_string()));
                }
            }
        }
        #[cfg(not(unix))]
        {
            std::fs::rename(exec, &backup).map_err(|e| UpdateError::Other(e.to_string()))?;
            if let Err(e) = std::fs::rename(tmp, exec) {
                let _ = std::fs::rename(&backup, exec);
                return Err(UpdateError::Other(e.to_string()));
            }
        }
    } else {
        std::fs::rename(tmp, exec).map_err(|e| UpdateError::Other(e.to_string()))?;
    }
    if let Some(parent) = exec.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn copy_file_streaming(src: &Path, dest: &Path) -> Result<(), UpdateError> {
    let mut input = std::fs::File::open(src).map_err(|e| UpdateError::Other(e.to_string()))?;
    let mut output = std::fs::File::create(dest).map_err(|e| UpdateError::Other(e.to_string()))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input
            .read(&mut buf)
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        output
            .write_all(&buf[..n])
            .map_err(|e| UpdateError::Other(e.to_string()))?;
    }
    output
        .sync_all()
        .map_err(|e| UpdateError::Other(e.to_string()))?;
    Ok(())
}

fn finish_os_slot(part: &Path, inactive: char) -> Result<(), UpdateError> {
    let label = format!("LUNA_{inactive}");
    let _ = Command::new("e2label").arg(part).arg(&label).status();
    set_tryboot_slot(inactive)
}

fn active_slot_letter() -> char {
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    if cmdline.split_whitespace().any(|t| t == "luna.slot=B") {
        'B'
    } else {
        'A'
    }
}

fn inactive_slot_device() -> Result<(PathBuf, char), UpdateError> {
    let active = active_slot_letter();
    let inactive = if active == 'A' { 'B' } else { 'A' };
    let label = format!("LUNA_{inactive}");
    let by_label = PathBuf::from(format!("/dev/disk/by-label/{label}"));
    if by_label.exists() {
        return Ok((by_label, inactive));
    }
    // findfs fallback
    let out = Command::new("findfs")
        .arg(format!("LABEL={label}"))
        .output()
        .map_err(|e| UpdateError::Other(e.to_string()))?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return Ok((PathBuf::from(path), inactive));
        }
    }
    Err(UpdateError::Other(
        "Luna couldn't find the spare OS slot to write the update.".into(),
    ))
}

fn set_tryboot_slot(slot: char) -> Result<(), UpdateError> {
    let esp = find_esp_mount_or_temp()?;
    let env = esp.path.join("grub/grubenv");
    if !env.exists() {
        let _ = Command::new("grub-editenv")
            .arg(&env)
            .arg("create")
            .status();
    }
    for (k, v) in [
        ("luna_slot", slot.to_string()),
        ("luna_boot_ok", "0".into()),
        ("luna_tries", "3".into()),
    ] {
        let status = Command::new("grub-editenv")
            .arg(&env)
            .arg("set")
            .arg(format!("{k}={v}"))
            .status()
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        if !status.success() {
            return Err(UpdateError::Other(
                "Luna couldn't prepare the reboot into the new software.".into(),
            ));
        }
    }
    Ok(())
}

struct EspGuard {
    path: PathBuf,
    tmp: bool,
}

impl Drop for EspGuard {
    fn drop(&mut self) {
        if self.tmp {
            let _ = Command::new("umount").arg(&self.path).status();
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

fn find_esp_mount_or_temp() -> Result<EspGuard, UpdateError> {
    for cand in ["/boot/efi", "/efi", "/boot"] {
        let grubenv = Path::new(cand).join("grub/grubenv");
        let grubcfg = Path::new(cand).join("grub/grub.cfg");
        if grubenv.exists() || grubcfg.exists() {
            return Ok(EspGuard {
                path: PathBuf::from(cand),
                tmp: false,
            });
        }
    }
    let out = Command::new("findfs")
        .arg("LABEL=LUNAESP")
        .output()
        .map_err(|e| UpdateError::Other(e.to_string()))?;
    if !out.status.success() {
        return Err(UpdateError::Other(
            "Luna couldn't find the boot partition for the update.".into(),
        ));
    }
    let dev = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let tmp = std::env::temp_dir().join(format!("luna-esp-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| UpdateError::Other(e.to_string()))?;
    let status = Command::new("mount")
        .args(["-o", "rw", &dev])
        .arg(&tmp)
        .status()
        .map_err(|e| UpdateError::Other(e.to_string()))?;
    if !status.success() {
        let _ = std::fs::remove_dir(&tmp);
        return Err(UpdateError::Other(
            "Luna couldn't open the boot partition for the update.".into(),
        ));
    }
    Ok(EspGuard {
        path: tmp,
        tmp: true,
    })
}

/// Admin-visible update source: where Luna downloads releases from and which
/// minisign public keys it trusts. Empty fields mean "use the built-in
/// default" (env var if set, else the compiled-in value).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UpdateSettings {
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub repo: String,
    /// Minisign public keys (base64 `RW…` lines). Empty means the compiled-in
    /// release key.
    #[serde(default)]
    pub keys: Vec<String>,
}

impl UpdateSettings {
    pub(crate) fn is_empty(&self) -> bool {
        self.api_base.is_empty()
            && self.owner.is_empty()
            && self.repo.is_empty()
            && self.keys.is_empty()
    }
}

/// Resolved source the updater actually uses (no empty fields left).
#[derive(Debug, Clone)]
struct ActiveSource {
    api_base: String,
    download_base: String,
    owner: String,
    repo: String,
    keys: Vec<String>,
}

fn active_from(api_base: String, owner: String, repo: String, keys: Vec<String>) -> ActiveSource {
    let api_base = api_base.trim().trim_end_matches('/').to_string();
    let host = api_base
        .trim_end_matches("/api/v1")
        .trim_end_matches("/api")
        .to_string();
    let download_base = format!("{host}/{owner}/{repo}/releases");
    ActiveSource {
        api_base,
        download_base,
        owner,
        repo,
        keys,
    }
}

fn first_nonempty(a: &str, b: &str) -> String {
    if a.trim().is_empty() {
        b.to_string()
    } else {
        a.trim().to_string()
    }
}

/// Defaults from env vars, falling back to the compiled-in values. Env vars
/// stay as the dev/automation override; stored settings win over them.
pub fn default_settings() -> UpdateSettings {
    UpdateSettings {
        api_base: std::env::var("LUNA_UPDATES_API").unwrap_or_else(|_| DEFAULT_API.into()),
        owner: std::env::var("LUNA_UPDATES_OWNER").unwrap_or_else(|_| DEFAULT_OWNER.into()),
        repo: std::env::var("LUNA_UPDATES_REPO").unwrap_or_else(|_| DEFAULT_REPO.into()),
        keys: parse_minisign_pub(PINNED_PUB),
    }
}

/// Read the stored update source from the DB. Missing or unreadable rows
/// return `None` (the caller falls back to defaults) — a bad row must never
/// stop Luna from updating.
pub fn load_settings(conn: &Connection) -> Option<UpdateSettings> {
    let raw = crate::db::get_meta(conn, SETTINGS_META_KEY)
        .ok()
        .flatten()?;
    let settings: UpdateSettings = serde_json::from_str(&raw).ok()?;
    Some(settings)
}

/// Persist the update source. An all-default body deletes the row so the DB
/// stays clean and future compiled-in default changes apply.
pub fn save_settings(conn: &Connection, settings: &UpdateSettings) -> anyhow::Result<()> {
    if settings.is_empty() {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            rusqlite::params![SETTINGS_META_KEY],
        )?;
        return Ok(());
    }
    let raw = serde_json::to_string(settings)?;
    crate::db::set_meta(conn, SETTINGS_META_KEY, &raw)
}

/// Normalize key input: accept whole pub-file text or single key lines, keep
/// only `RW…` base64 lines, and verify each one decodes as a minisign key.
fn normalize_pub_keys(entries: &[String]) -> Result<Vec<String>, &'static str> {
    let mut keys = Vec::new();
    for entry in entries {
        for line in entry.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("untrusted comment") {
                continue;
            }
            if !line.starts_with("RW") || PublicKey::from_base64(line).is_err() {
                return Err(
                    "One of those signing keys is not a valid minisign public key. Paste the key exactly as it appears in its .pub file (one line starting with RW).",
                );
            }
            if !keys.contains(&line.to_string()) {
                keys.push(line.to_string());
            }
        }
    }
    if keys.len() > MAX_KEYS {
        return Err("That is more signing keys than Luna can keep. Remove one and try again.");
    }
    Ok(keys)
}

/// Validate an admin-supplied update source. Returns a plain-language reason
/// the save was refused, ready to show in the UI.
pub fn validate_settings(settings: &UpdateSettings) -> Result<Vec<String>, &'static str> {
    let api_base = settings.api_base.trim();
    if api_base.is_empty() {
        return Err(
            "The API address needs a value. Put in the old address if you want to keep it.",
        );
    }
    if !api_base.starts_with("http://") && !api_base.starts_with("https://") {
        return Err("The API address must start with http:// or https://.");
    }
    if settings.owner.trim().is_empty() || settings.repo.trim().is_empty() {
        return Err(
            "Both the owner and the repo need a value — they say which project page the updates come from.",
        );
    }
    let total: usize = settings.keys.iter().map(|k| k.len()).sum();
    if total > MAX_PUB_TEXT_BYTES {
        return Err("That signing key list is too long. One key per line is enough.");
    }
    let keys = normalize_pub_keys(&settings.keys)?;
    Ok(keys)
}

pub struct UpdateService {
    http: Box<dyn HttpGet>,
    installer: Box<dyn Installer>,
    active: Mutex<ActiveSource>,
    cache: Mutex<Option<(Instant, UpdateInfo)>>,
}

impl UpdateService {
    pub fn from_env(data_dir: &Path) -> Self {
        let d = default_settings();
        Self::new(
            Box::new(UreqHttp),
            Box::new(DataDirInstaller::new(data_dir)),
            d.api_base,
            d.owner,
            d.repo,
        )
    }

    /// Build the service from persisted settings, falling back to env vars and
    /// compiled-in defaults for every unset field.
    pub fn from_db(conn: &Connection, data_dir: &Path) -> Self {
        let stored = load_settings(conn).unwrap_or_default();
        let d = default_settings();
        let settings = UpdateSettings {
            api_base: first_nonempty(&stored.api_base, &d.api_base),
            owner: first_nonempty(&stored.owner, &d.owner),
            repo: first_nonempty(&stored.repo, &d.repo),
            keys: if stored.keys.is_empty() {
                d.keys
            } else {
                stored.keys
            },
        };
        Self::with_keys(
            Box::new(UreqHttp),
            Box::new(DataDirInstaller::new(data_dir)),
            settings.api_base,
            settings.owner,
            settings.repo,
            settings.keys,
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
        keys: Vec<String>,
    ) -> Self {
        Self {
            http,
            installer,
            active: Mutex::new(active_from(api_base, owner, repo, keys)),
            cache: Mutex::new(None),
        }
    }

    fn source(&self) -> ActiveSource {
        self.active.lock().unwrap().clone()
    }

    /// The update source currently in effect.
    pub fn settings(&self) -> UpdateSettings {
        let src = self.source();
        UpdateSettings {
            api_base: src.api_base,
            owner: src.owner,
            repo: src.repo,
            keys: src.keys,
        }
    }

    /// True when the trusted keys are still the compiled-in release key.
    pub fn using_default_keys(&self) -> bool {
        self.source().keys == parse_minisign_pub(PINNED_PUB)
    }

    /// Hot-swap the update source (admin saved new settings). Clears the
    /// release cache so the next check goes to the new source.
    pub fn reconfigure(&self, api_base: String, owner: String, repo: String, keys: Vec<String>) {
        let keys = if keys.is_empty() {
            parse_minisign_pub(PINNED_PUB)
        } else {
            keys
        };
        *self.active.lock().unwrap() = active_from(api_base, owner, repo, keys);
        *self.cache.lock().unwrap() = None;
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

        let src = self.source();
        let url = format!(
            "{}/repos/{}/{}/releases?limit=50",
            src.api_base, src.owner, src.repo
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
                reboot_required: false,
            };
            *self.cache.lock().unwrap() = Some((Instant::now(), info.clone()));
            return Ok(info);
        };

        let sums = self.fetch_signed_sums(&rel.tag_name).ok();
        let checksum = sums
            .as_ref()
            .and_then(|s| checksum_for_name(s, &binary).ok())
            .unwrap_or_default();
        let latest_ver = strip_tag(&rel.tag_name);
        let lunad_newer = version_newer(&latest_ver, current_version);
        let os_needed = sums
            .as_ref()
            .map(|s| self.os_update_needed(s))
            .unwrap_or(false);
        let info = UpdateInfo {
            current_version: current_version.to_string(),
            latest_version: rel.tag_name.clone(),
            update_available: lunad_newer || os_needed,
            release_notes: rel.body.clone(),
            url: rel.html_url.clone(),
            checksum,
            binary_name: binary,
            reboot_required: os_needed,
        };
        *self.cache.lock().unwrap() = Some((Instant::now(), info.clone()));
        Ok(info)
    }

    fn os_update_needed(&self, sums: &[u8]) -> bool {
        let Ok(remote) = checksum_for_name(sums, OS_IMAGE_NAME) else {
            return false;
        };
        match self.installer.read_os_hash() {
            Some(local) => local != remote,
            // No recorded hash: treat presence of an OS asset as needing apply
            // only when we have never stamped one — avoid surprising re-flash
            // on daemon-only boxes without data hash by requiring a local hash
            // file. Factory always writes the hash.
            None => false,
        }
    }

    fn fetch_signed_sums(&self, tag: &str) -> Result<Vec<u8>, UpdateError> {
        let src = self.source();
        let sums_url = format!("{}/download/{tag}/SHA256SUMS.txt", src.download_base);
        let sig_url = format!(
            "{}/download/{tag}/SHA256SUMS.txt.minisig",
            src.download_base
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
        verify_sums_signature(&src.keys, &sums, &sig)?;
        Ok(sums)
    }

    pub fn apply(&self, current_version: &str) -> Result<UpdateInfo, UpdateError> {
        let mut info = self.check(current_version, true)?;
        if !info.update_available {
            return Err(UpdateError::NoneAvailable);
        }
        let sums = self.fetch_signed_sums(&info.latest_version)?;
        let lunad_newer = version_newer(&strip_tag(&info.latest_version), current_version);
        let os_needed = self.os_update_needed(&sums);

        if lunad_newer {
            let checksum = checksum_for_name(&sums, &info.binary_name)?;
            let max = crate::budget::limits().update_download_bytes;
            let tmp =
                self.download_verified(&info.latest_version, &info.binary_name, &checksum, max)?;
            if let Err(e) = self.installer.install_lunad_file(&tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            let _ = std::fs::remove_file(&tmp);
            info.checksum = checksum;
        }

        if os_needed {
            let checksum = checksum_for_name(&sums, OS_IMAGE_NAME)?;
            let tmp = self.download_verified(
                &info.latest_version,
                OS_IMAGE_NAME,
                &checksum,
                OS_IMAGE_MAX_BYTES,
            )?;
            if let Err(e) = self.installer.install_os_image_file(&tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            let _ = std::fs::remove_file(&tmp);
            self.installer.write_os_hash(&checksum)?;
            info.reboot_required = true;
        } else {
            info.reboot_required = false;
        }

        Ok(info)
    }

    /// Stream `name` from the release to a temp file, hashing while writing.
    fn download_verified(
        &self,
        tag: &str,
        name: &str,
        checksum: &str,
        max_bytes: u64,
    ) -> Result<PathBuf, UpdateError> {
        let src = self.source();
        let url = format!("{}/download/{tag}/{name}", src.download_base);
        let tmp = std::env::temp_dir().join(format!(
            "luna-update-{}-{}-{name}",
            std::process::id(),
            tag.replace(['/', '\\'], "_")
        ));
        let (status, actual) = match self.http.get_to_file(&url, &tmp, max_bytes) {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        if status != 200 {
            let _ = std::fs::remove_file(&tmp);
            return Err(UpdateError::Unreachable);
        }
        if actual != checksum {
            let _ = std::fs::remove_file(&tmp);
            return Err(UpdateError::Checksum);
        }
        Ok(tmp)
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

fn checksum_for_name(sums: &[u8], name: &str) -> Result<String, UpdateError> {
    let text = String::from_utf8_lossy(sums);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(sum) = parts.next() else { continue };
        let Some(file) = parts.next() else { continue };
        if file == name || file.ends_with(name) || file.contains(name) {
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
        os_got: Mutex<Vec<u8>>,
        os_hash: Mutex<Option<String>>,
    }

    impl Installer for RecInstaller {
        fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
            *self.got.lock().unwrap() = bytes.to_vec();
            Ok(())
        }
        fn install_os_image(&self, bytes: &[u8]) -> Result<(), UpdateError> {
            *self.os_got.lock().unwrap() = bytes.to_vec();
            Ok(())
        }
        fn read_os_hash(&self) -> Option<String> {
            self.os_hash.lock().unwrap().clone()
        }
        fn write_os_hash(&self, hash: &str) -> Result<(), UpdateError> {
            *self.os_hash.lock().unwrap() = Some(hash.to_string());
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
			"keys/lsluna.minisign.pub must contain an RW public key line"
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
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
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
    fn apply_os_when_hash_differs() {
        let bin = binary_name();
        let lunad = b"lunad-v2";
        let os_img = b"os-slot-image-bytes";
        let lunad_sum = {
            let mut h = Sha256::new();
            h.update(lunad);
            hex_lower(&h.finalize())
        };
        let os_sum = {
            let mut h = Sha256::new();
            h.update(os_img);
            hex_lower(&h.finalize())
        };
        let sums = format!("{lunad_sum}  {bin}\n{os_sum}  {OS_IMAGE_NAME}\n");
        let (pk, sig) = ephemeral_sign(sums.as_bytes());
        let installer = RecInstaller {
            got: Mutex::new(Vec::new()),
            os_got: Mutex::new(Vec::new()),
            os_hash: Mutex::new(Some("old-os-hash".into())),
        };
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
            (200, lunad.to_vec()),
        );
        map.insert(
            format!(
                "http://forgejo.test/LibreLoom/LibreServ/releases/download/luna-v0.2.0/{OS_IMAGE_NAME}"
            ),
            (200, os_img.to_vec()),
        );
        let svc = svc_with(map, Box::new(installer), pk);
        // Same lunad version but OS hash differs → still an update.
        let info = svc.check("0.2.0", true).unwrap();
        assert!(info.update_available);
        assert!(info.reboot_required);
        let applied = svc.apply("0.2.0").unwrap();
        assert!(applied.reboot_required);
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
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
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
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
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
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
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

    #[test]
    fn data_dir_installer_writes_lunad_under_bin() {
        let dir = tempfile::tempdir().unwrap();
        let inst = DataDirInstaller::new(dir.path());
        inst.install_lunad(b"hello-lunad").unwrap();
        let path = dir.path().join("bin/lunad");
        assert_eq!(std::fs::read(&path).unwrap(), b"hello-lunad");
        inst.write_os_hash("abc123").unwrap();
        assert_eq!(inst.read_os_hash().as_deref(), Some("abc123"));
    }

    #[test]
    fn settings_round_trip_through_db() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        // Nothing stored yet → defaults.
        assert!(load_settings(&conn).is_none());

        let settings = UpdateSettings {
            api_base: "https://staging.forgejo.test/api/v1".into(),
            owner: "MyOrg".into(),
            repo: "LunaFork".into(),
            keys: vec!["RWnotarealkey".into()],
        };
        save_settings(&conn, &settings).unwrap();
        assert_eq!(load_settings(&conn).unwrap(), settings);

        // Saving all-defaults clears the row again.
        save_settings(&conn, &UpdateSettings::default()).unwrap();
        assert!(load_settings(&conn).is_none());
    }

    #[test]
    fn settings_survive_bad_row() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::set_meta(&conn, SETTINGS_META_KEY, "{not json").unwrap();
        // A corrupt row must never stop the updater — fall back to defaults.
        assert!(load_settings(&conn).is_none());
    }

    #[test]
    fn from_db_uses_stored_source_and_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let key = ephemeral_sign(b"x").0;
        save_settings(
            &conn,
            &UpdateSettings {
                api_base: "https://staging.forgejo.test/api/v1".into(),
                owner: "MyOrg".into(),
                repo: "LunaFork".into(),
                keys: vec![key.clone()],
            },
        )
        .unwrap();
        let svc = UpdateService::from_db(&conn, dir.path());
        let got = svc.settings();
        assert_eq!(got.api_base, "https://staging.forgejo.test/api/v1");
        assert_eq!(got.owner, "MyOrg");
        assert_eq!(got.repo, "LunaFork");
        assert_eq!(got.keys, vec![key]);
        assert!(!svc.using_default_keys());

        // No stored row → compiled-in defaults, default key.
        let conn2 = crate::db::open(&dir.path().join("luna2.db")).unwrap();
        let svc2 = UpdateService::from_db(&conn2, dir.path());
        let got2 = svc2.settings();
        assert_eq!(got2.owner, DEFAULT_OWNER);
        assert_eq!(got2.repo, DEFAULT_REPO);
        assert!(svc2.using_default_keys());
    }

    #[test]
    fn validate_settings_rejects_bad_input() {
        let base = UpdateSettings {
            api_base: "https://forgejo.test/api/v1".into(),
            owner: "MyOrg".into(),
            repo: "LunaFork".into(),
            keys: vec![],
        };
        assert!(validate_settings(&base).is_ok());
        let no_scheme = UpdateSettings {
            api_base: "ftp://forgejo.test".into(),
            ..base.clone()
        };
        assert!(validate_settings(&no_scheme).is_err());
        let no_owner = UpdateSettings {
            owner: "".into(),
            ..base.clone()
        };
        assert!(validate_settings(&no_owner).is_err());
        let bad_key = UpdateSettings {
            keys: vec!["not-a-key".into()],
            ..base.clone()
        };
        assert!(validate_settings(&bad_key).is_err());
        // A whole pub file (comment + key) is accepted, comment dropped.
        let real = ephemeral_sign(b"x").0;
        let file = UpdateSettings {
            keys: vec![format!("untrusted comment: x\n{real}\n")],
            ..base
        };
        assert_eq!(validate_settings(&file).unwrap(), vec![real]);
    }

    #[test]
    fn apply_verifies_release_signed_with_custom_key() {
        // A release signed by a non-default key installs when that key is
        // configured — the acceptance case for repointing at a staging Forgejo.
        let bin = binary_name();
        let payload = b"custom-keyed-lunad";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
        let sums = format!("{sum}  {bin}\n");
        let (custom_pk, sig) = ephemeral_sign(sums.as_bytes());
        let mut map = HashMap::new();
        map.insert(
            "http://staging.forgejo.test/api/v1/repos/MyOrg/LunaFork/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.6.0"])),
        );
        map.insert(
            "http://staging.forgejo.test/MyOrg/LunaFork/releases/download/luna-v0.6.0/SHA256SUMS.txt"
                .into(),
            (200, sums.into_bytes()),
        );
        map.insert(
            "http://staging.forgejo.test/MyOrg/LunaFork/releases/download/luna-v0.6.0/SHA256SUMS.txt.minisig"
                .into(),
            (200, sig),
        );
        map.insert(
            format!(
                "http://staging.forgejo.test/MyOrg/LunaFork/releases/download/luna-v0.6.0/{bin}"
            ),
            (200, payload.to_vec()),
        );
        let svc = UpdateService::with_keys(
            Box::new(MapHttp { map }),
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
            }),
            "http://staging.forgejo.test/api/v1".into(),
            "MyOrg".into(),
            "LunaFork".into(),
            vec![custom_pk],
        );
        let info = svc.apply("0.1.0").unwrap();
        assert_eq!(info.checksum, sum);
        assert!(!svc.using_default_keys());
    }

    #[test]
    fn reconfigure_swaps_source_and_clears_cache() {
        let bin = binary_name();
        let payload = b"staged-lunad";
        let sum = {
            let mut h = Sha256::new();
            h.update(payload);
            hex_lower(&h.finalize())
        };
        let sums = format!("{sum}  {bin}\n");
        let (pk, sig) = ephemeral_sign(sums.as_bytes());
        let mut map = HashMap::new();
        // Both the default source and a staging source; the staging release
        // list has a newer tag.
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, json_releases(&["luna-v0.2.0"])),
        );
        map.insert(
            "http://staging.forgejo.test/api/v1/repos/MyOrg/LunaFork/releases?limit=50".into(),
            (200, json_releases(&["luna-v9.9.9"])),
        );
        map.insert(
            "http://staging.forgejo.test/MyOrg/LunaFork/releases/download/luna-v9.9.9/SHA256SUMS.txt"
                .into(),
            (200, sums.into_bytes()),
        );
        map.insert(
            "http://staging.forgejo.test/MyOrg/LunaFork/releases/download/luna-v9.9.9/SHA256SUMS.txt.minisig"
                .into(),
            (200, sig),
        );
        let svc = UpdateService::with_keys(
            Box::new(MapHttp { map }),
            Box::new(RecInstaller {
                got: Mutex::new(Vec::new()),
                os_got: Mutex::new(Vec::new()),
                os_hash: Mutex::new(None),
            }),
            "http://forgejo.test/api/v1".into(),
            "LibreLoom".into(),
            "LibreServ".into(),
            vec![pk.clone()],
        );
        let before = svc.check("0.1.0", false).unwrap();
        assert_eq!(before.latest_version, "luna-v0.2.0");
        // The hour-long cache holds that result.
        let cached = svc.check("0.1.0", false).unwrap();
        assert_eq!(cached.latest_version, "luna-v0.2.0");

        // Admin points Luna at staging → cache clears, next check hits the
        // new source.
        svc.reconfigure(
            "http://staging.forgejo.test/api/v1".into(),
            "MyOrg".into(),
            "LunaFork".into(),
            vec![pk],
        );
        let after = svc.check("0.1.0", false).unwrap();
        assert_eq!(after.latest_version, "luna-v9.9.9");
        assert_eq!(after.checksum, sum);
    }
}
