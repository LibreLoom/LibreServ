//! Software updates from the signed Luna feed (`luna/<channel>.json`).
//!
//! The feed format and its rules live in `luna_feed` (spec:
//! `infra/ci-source/internal/feed/README.md`). Two parts matter here: `lunad` (the daemon,
//! installed under LUNA_DATA) and `os` (an `.img.xz` slot image). When the
//! OS part's SHA256 differs from the hash stored on LUNA_DATA, that image is
//! decompressed onto the inactive A/B slot in the same Install update
//! (tryboot). The Settings UI does not differentiate OS vs software.
//!
//! Apply is tap-to-update only — never silent.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use luna_feed::{self as feed, FeedError, Part};
use minisign_verify::PublicKey;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

const DEFAULT_FEED_URL: &str = "https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds";
const DEFAULT_CHANNEL: &str = "stable";
/// Release unit this updater follows (feed path `luna/<channel>.json`).
const UNIT: &str = "luna";
/// Channels the feed offers.
pub const CHANNELS: [&str; 2] = ["stable", "beta"];
const OS_HASH_FILE: &str = "os-image.sha256";
/// Written by `apply()` once an OS image is on the spare slot:
/// `hash slot boot-id version`. It becomes `os-image.sha256` only after the
/// new slot has booted and `luna-boot-ok` has confirmed that boot.
const OS_PENDING_FILE: &str = "os-image.pending";
/// `hash version` of an OS image whose slot did not boot; never re-flashed
/// automatically (the Admin can clear it to try again).
const OS_FAILED_FILE: &str = "os-image.failed";
/// Written by `luna-boot-ok` (OS image) once GRUB has been told this boot is
/// good: holds the kernel boot id. `/run` is empty again after every reboot.
const BOOT_OK_MARKER: &str = "/run/luna/boot-ok";
/// Newest feed `published` seen per unit + channel (replay protection).
const FEED_SEEN_FILE: &str = "update-feed-seen.json";
/// OS slot images are streamed to disk, never held in RAM. Cap (on the
/// decompressed image) matches the 1280 MiB A/B slot plus a little headroom.
const OS_IMAGE_MAX_BYTES: u64 = 1536 * 1024 * 1024;

/// Committed Luna minisign public key (`keys/lsluna.minisign.pub`).
/// This is Luna’s production trust root (separate from Sol).
const PINNED_PUB: &str = include_str!("../../../../../keys/lsluna.minisign.pub");

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
    #[error("No updates have been published on this channel yet.")]
    NoFeed,
    #[error("No Luna software update is waiting.")]
    NoneAvailable,
    #[error("That update file looks damaged. Nothing was installed.")]
    Checksum,
    #[error(
        "That update is missing the signature Luna uses to confirm it's genuine. Nothing was installed."
    )]
    MissingSignature,
    #[error("That update could not be verified. Nothing was installed.")]
    BadSignature,
    #[error(
        "That update list is meant for a different product or channel, or is not readable. Nothing was installed."
    )]
    BadFeed,
    #[error(
        "That update list comes from newer software than this Luna understands. Nothing was installed."
    )]
    UnknownFormat,
    #[error(
        "That update list is older than one Luna has already seen, so it was ignored. Nothing was installed."
    )]
    Replayed,
    #[error("That update has no software for this Luna. Nothing was installed.")]
    MissingPart,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: String,
    pub checksum: String,
    pub binary_name: String,
    /// True when applying will (or did) write an OS slot and reboot the box.
    #[serde(default)]
    pub reboot_required: bool,
}

pub trait HttpGet: Send + Sync {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError>;

    /// Open a (possibly huge) body to stream from. Anything but a 200 is an
    /// error. The default buffers `get`; production streams.
    fn open(&self, url: &str) -> std::io::Result<Box<dyn Read>> {
        let (status, bytes) = self.get(url).map_err(std::io::Error::other)?;
        if status != 200 {
            return Err(std::io::Error::other(format!("status {status}")));
        }
        Ok(Box::new(std::io::Cursor::new(bytes)))
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

    /// `bytes` is the whole `.img.xz` as published.
    fn install_os_image(&self, bytes: &[u8]) -> Result<(), UpdateError> {
        let _ = bytes;
        Err(UpdateError::Other(
            "This Luna cannot apply an OS image update here.".into(),
        ))
    }

    /// Stream-decompress the `.img.xz` at `path` onto the inactive A/B partition.
    fn install_os_image_file(&self, path: &Path) -> Result<(), UpdateError> {
        let bytes = std::fs::read(path).map_err(|e| UpdateError::Other(e.to_string()))?;
        self.install_os_image(&bytes)
    }

    /// Where update downloads are staged. `/tmp` is a small tmpfs on the
    /// appliance — nowhere near big enough for an OS slot image — so
    /// production stages on the data partition.
    fn staging_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn read_os_hash(&self) -> Option<String> {
        None
    }
    fn write_os_hash(&self, _hash: &str) -> Result<(), UpdateError> {
        Ok(())
    }

    /// The OS image just written to the spare slot is waiting for its first
    /// boot. Its hash becomes the installed hash only once that slot boots.
    fn mark_os_pending(&self, _hash: &str, _version: &str) -> Result<(), UpdateError> {
        Ok(())
    }
    /// Hash of the image waiting for its first boot, if any.
    fn read_os_pending(&self) -> Option<String> {
        None
    }
    /// Hash of an image that was flashed but did not boot (the box fell back).
    fn read_os_failed(&self) -> Option<String> {
        None
    }
    /// Version of the image that was flashed but did not boot, when known.
    fn read_os_failed_version(&self) -> Option<String> {
        None
    }
    /// Forget the failed image so it is offered again.
    fn clear_os_failed(&self) -> Result<(), UpdateError> {
        Ok(())
    }
    /// Settle a pending OS image as booted or failed. Safe to call often:
    /// it does nothing until the boot has a verdict.
    fn settle_os_boot(&self) {}

    /// Newest feed `published` already seen for this unit + channel.
    fn read_feed_seen(&self, _unit: &str, _channel: &str) -> Option<String> {
        None
    }
    fn write_feed_seen(
        &self,
        _unit: &str,
        _channel: &str,
        _published: &str,
    ) -> Result<(), UpdateError> {
        Ok(())
    }
}

/// ureq 3 has no timeout by default; a wedged connection would hang the
/// update thread for good. Feeds and signatures are small.
const API_TIMEOUT: Duration = Duration::from_secs(30);
/// An OS image is hundreds of megabytes: the clock covers the whole download,
/// so it allows a slow home connection while still ending a stuck one.
const IMAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct UreqHttp;

impl HttpGet for UreqHttp {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
        let max = crate::budget::limits().update_download_bytes;
        let resp = ureq::get(url)
            .config()
            .timeout_global(Some(API_TIMEOUT))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .http_status_as_error(false)
            .build()
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

    fn open(&self, url: &str) -> std::io::Result<Box<dyn Read>> {
        let resp = ureq::get(url)
            .config()
            .timeout_global(Some(IMAGE_DOWNLOAD_TIMEOUT))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(API_TIMEOUT))
            .build()
            .call()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Box::new(resp.into_body().into_reader()))
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
        write_os_slot(&RealSlotOps, &part, inactive, || {
            let mut f =
                std::fs::File::create(&part).map_err(|e| UpdateError::Other(e.to_string()))?;
            f.write_all(bytes)
                .map_err(|e| UpdateError::Other(e.to_string()))?;
            f.sync_all().map_err(|e| UpdateError::Other(e.to_string()))
        })
    }

    fn install_os_image_file(&self, src: &Path) -> Result<(), UpdateError> {
        let (part, inactive) = inactive_slot_device()?;
        // The inactive slot is not booted from until `write_os_slot` arms it,
        // so a failed or cut-short write here leaves the running system alone.
        write_os_slot(&RealSlotOps, &part, inactive, || {
            decompress_xz_streaming(src, &part, OS_IMAGE_MAX_BYTES)
        })
    }

    fn staging_dir(&self) -> PathBuf {
        self.data_dir.join("updates")
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

    fn mark_os_pending(&self, hash: &str, version: &str) -> Result<(), UpdateError> {
        let active = active_slot_letter()?;
        let slot = if active == 'A' { 'B' } else { 'A' };
        let line = format!("{hash} {slot} {} {version}\n", current_boot_id());
        std::fs::create_dir_all(&self.data_dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        write_atomic(&self.data_dir.join(OS_PENDING_FILE), &line)
    }

    fn read_os_pending(&self) -> Option<String> {
        read_pending(&self.data_dir).map(|p| p.hash)
    }

    fn read_os_failed(&self) -> Option<String> {
        read_failed(&self.data_dir).map(|f| f.0)
    }

    fn read_os_failed_version(&self) -> Option<String> {
        read_failed(&self.data_dir).and_then(|f| f.1)
    }

    fn clear_os_failed(&self) -> Result<(), UpdateError> {
        match std::fs::remove_file(self.data_dir.join(OS_FAILED_FILE)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(UpdateError::Other(e.to_string())),
        }
    }

    fn settle_os_boot(&self) {
        let boot_id = current_boot_id();
        let booted = active_slot_letter().ok();
        let boot_ok = boot_ok_confirmed(Path::new(BOOT_OK_MARKER), &boot_id);
        match self.settle_pending(booted, &boot_id, boot_ok) {
            Settle::Booted => tracing::info!("the new operating system booted; update recorded"),
            Settle::FellBack => tracing::warn!(
                "the new operating system did not start and Luna went back; it won't retry that image on its own"
            ),
            Settle::Nothing | Settle::SameBoot | Settle::Unconfirmed => {}
        }
    }

    fn read_feed_seen(&self, unit: &str, channel: &str) -> Option<String> {
        let raw = std::fs::read_to_string(self.data_dir.join(FEED_SEEN_FILE)).ok()?;
        let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&raw).ok()?;
        map.get(&format!("{unit}/{channel}")).cloned()
    }

    fn write_feed_seen(
        &self,
        unit: &str,
        channel: &str,
        published: &str,
    ) -> Result<(), UpdateError> {
        let path = self.data_dir.join(FEED_SEEN_FILE);
        let mut map: std::collections::BTreeMap<String, String> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        map.insert(format!("{unit}/{channel}"), published.to_string());
        std::fs::create_dir_all(&self.data_dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&map).unwrap_or_default())
            .map_err(|e| UpdateError::Other(e.to_string()))?;
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
            #[cfg(target_os = "linux")]
            let rc = {
                // musl 1.2.x has SYS_renameat2 but no renameat2() wrapper; use syscall.
                const RENAME_EXCHANGE: libc::c_uint = 2;
                unsafe {
                    libc::syscall(
                        libc::SYS_renameat2,
                        libc::AT_FDCWD,
                        exec_c.as_ptr(),
                        libc::AT_FDCWD,
                        tmp_c.as_ptr(),
                        RENAME_EXCHANGE,
                    )
                }
            };
            #[cfg(target_os = "macos")]
            let rc = {
                // macOS: same atomic swap via renamex_np(RENAME_SWAP).
                unsafe { libc::renamex_np(exec_c.as_ptr(), tmp_c.as_ptr(), libc::RENAME_SWAP) }
            };
            #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
            let rc = -1;
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

/// What `settle_pending` decided.
#[derive(Debug, PartialEq, Eq)]
enum Settle {
    Nothing,
    /// Still the boot that wrote the image: no verdict yet.
    SameBoot,
    /// On the new slot, but `luna-boot-ok` hasn't confirmed this boot yet.
    Unconfirmed,
    Booted,
    FellBack,
}

struct Pending {
    hash: String,
    slot: char,
    boot_id: String,
    version: String,
}

/// `(hash, version)` of the image that did not boot.
fn read_failed(data_dir: &Path) -> Option<(String, Option<String>)> {
    let text = read_trimmed(&data_dir.join(OS_FAILED_FILE))?;
    let mut it = text.split_whitespace();
    let hash = it.next()?.to_string();
    Some((hash, it.next().map(str::to_string)))
}

/// Has `luna-boot-ok` confirmed the boot with this id? The marker lives in
/// `/run`, so an old one never survives a reboot; the id check is belt and
/// braces.
fn boot_ok_confirmed(marker: &Path, boot_id: &str) -> bool {
    !boot_id.is_empty() && read_trimmed(marker).as_deref() == Some(boot_id)
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_pending(data_dir: &Path) -> Option<Pending> {
    let text = read_trimmed(&data_dir.join(OS_PENDING_FILE))?;
    let mut it = text.split_whitespace();
    let hash = it.next()?.to_string();
    let slot = match it.next()? {
        "A" => 'A',
        "B" => 'B',
        _ => return None,
    };
    let boot_id = it.next()?.to_string();
    let version = it.next().unwrap_or_default().to_string();
    Some(Pending {
        hash,
        slot,
        boot_id,
        version,
    })
}

fn write_atomic(path: &Path, text: &str) -> Result<(), UpdateError> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| UpdateError::Other(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| UpdateError::Other(e.to_string()))
}

fn current_boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

impl DataDirInstaller {
    /// Decide what happened to an OS image written before the last reboot.
    /// `booted` is the slot this boot came from (`None` when unknown, which
    /// gives no verdict). A different boot on the new slot means the image
    /// works once `luna-boot-ok` has confirmed it (`boot_ok`; GRUB only keeps
    /// a tryboot slot after that, so lunad must not outrun it): its hash
    /// becomes the installed one. A different boot on the old
    /// slot means GRUB fell back: the hash is remembered as failed so the same
    /// image is not flashed again and again.
    fn settle_pending(&self, booted: Option<char>, boot_id: &str, boot_ok: bool) -> Settle {
        let Some(p) = read_pending(&self.data_dir) else {
            return Settle::Nothing;
        };
        if p.boot_id == boot_id {
            return Settle::SameBoot;
        }
        let Some(booted) = booted else {
            return Settle::Nothing;
        };
        let pending = self.data_dir.join(OS_PENDING_FILE);
        if booted == p.slot {
            if !boot_ok {
                return Settle::Unconfirmed;
            }
            if self.write_os_hash(&p.hash).is_err() {
                return Settle::Nothing;
            }
            let _ = std::fs::remove_file(self.data_dir.join(OS_FAILED_FILE));
            let _ = std::fs::remove_file(&pending);
            Settle::Booted
        } else {
            if write_atomic(
                &self.data_dir.join(OS_FAILED_FILE),
                &format!("{} {}\n", p.hash, p.version),
            )
            .is_err()
            {
                return Settle::Nothing;
            }
            let _ = std::fs::remove_file(&pending);
            Settle::FellBack
        }
    }
}

/// The steps that touch a real disk or run a tool, so the order they run in
/// can be tested without either.
trait SlotOps {
    fn read_uuid(&self, part: &Path) -> Result<String, UpdateError>;
    /// The filesystem ID GRUB looks the slot up by. Normally what the slot
    /// carries now, but after an interrupted update the slot holds half of a new
    /// image with a different ID, so the boot menu's own record is the truth.
    fn pinned_uuid(&self, slot: char, part: &Path) -> Result<String, UpdateError> {
        let _ = slot;
        self.read_uuid(part)
    }
    fn check_fs(&self, part: &Path) -> Result<(), UpdateError>;
    fn set_uuid(&self, part: &Path, uuid: &str) -> Result<(), UpdateError>;
    fn set_label(&self, part: &Path, label: &str);
    fn arm(&self, slot: char) -> Result<(), UpdateError>;
}

struct RealSlotOps;

/// e2fsck exits 0 (clean) or 1 (fixed something) on success.
fn fsck_succeeded(code: Option<i32>) -> bool {
    matches!(code, Some(0 | 1))
}

impl SlotOps for RealSlotOps {
    fn read_uuid(&self, part: &Path) -> Result<String, UpdateError> {
        read_ext4_uuid(part)
    }

    fn pinned_uuid(&self, slot: char, part: &Path) -> Result<String, UpdateError> {
        if let Ok(esp) = find_esp_mount_or_temp()
            && let Ok(cfg) = std::fs::read_to_string(esp.path.join("grub/grub.cfg"))
            && let Some(uuid) = pinned_uuid_from_grub_cfg(&cfg, slot)
        {
            return Ok(uuid);
        }
        self.read_uuid(part)
    }

    fn check_fs(&self, part: &Path) -> Result<(), UpdateError> {
        let status = Command::new("e2fsck").arg("-fy").arg(part).status();
        match status {
            Ok(s) if fsck_succeeded(s.code()) => Ok(()),
            _ => Err(UpdateError::Other(
                "The new operating system didn't pass its disk check, so Luna won't switch to it."
                    .into(),
            )),
        }
    }

    fn set_uuid(&self, part: &Path, uuid: &str) -> Result<(), UpdateError> {
        match Command::new("tune2fs").arg("-U").arg(uuid).arg(part).status() {
            Ok(s) if s.success() => Ok(()),
            _ => Err(UpdateError::Other(
                "Luna couldn't prepare the new operating system for startup, so it won't switch to it."
                    .into(),
            )),
        }
    }

    fn set_label(&self, part: &Path, label: &str) {
        let _ = Command::new("e2label").arg(part).arg(label).status();
    }

    fn arm(&self, slot: char) -> Result<(), UpdateError> {
        set_tryboot_slot(slot)
    }
}

/// The `root=UUID=` the boot menu uses for `slot` (its `luna.slot=` line).
fn pinned_uuid_from_grub_cfg(cfg: &str, slot: char) -> Option<String> {
    let marker = format!("luna.slot={slot}");
    cfg.lines().filter(|l| l.contains(&marker)).find_map(|l| {
        let rest = l.split("root=UUID=").nth(1)?;
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .collect();
        (id.len() == 36).then_some(id)
    })
}

/// Read the filesystem UUID from an ext4 superblock (1024 bytes in; magic at
/// +0x38, UUID at +0x68), formatted the way `tune2fs -U` takes it. Refuses
/// anything that isn't ext2/3/4 so a blank or foreign slot is never guessed at.
fn read_ext4_uuid(dev: &Path) -> Result<String, UpdateError> {
    use std::io::{Seek, SeekFrom};
    let fail = || {
        UpdateError::Other(
            "Luna couldn't read the spare OS slot's ID, so nothing was installed.".into(),
        )
    };
    let mut f = std::fs::File::open(dev).map_err(|_| fail())?;
    let mut sb = [0u8; 0x78];
    f.seek(SeekFrom::Start(1024)).map_err(|_| fail())?;
    f.read_exact(&mut sb).map_err(|_| fail())?;
    if sb[0x38..0x3a] != [0x53, 0xEF] {
        return Err(fail());
    }
    let u = &sb[0x68..0x78];
    if u.iter().all(|b| *b == 0) {
        return Err(fail());
    }
    let h: String = u.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// Put a new OS image on the spare slot and arm the next boot into it.
///
/// Each image build has its own random filesystem UUID, but GRUB finds the
/// slots by the UUIDs pinned at install time. So the slot's UUID is read
/// before anything is written, and put back after the check.
fn write_os_slot(
    ops: &dyn SlotOps,
    part: &Path,
    inactive: char,
    write: impl FnOnce() -> Result<(), UpdateError>,
) -> Result<(), UpdateError> {
    let uuid = ops.pinned_uuid(inactive, part)?;
    write()?;
    ops.check_fs(part)?;
    ops.set_uuid(part, &uuid)?;
    ops.set_label(part, &format!("LUNA_{inactive}"));
    ops.arm(inactive)
}

/// Decompress the `.img.xz` at `src` into `dest` (the inactive slot) as a
/// stream: nothing but small buffers (plus the decoder's dictionary) sits in
/// RAM. Refuses to write more than `max_bytes`, so a crafted file cannot
/// balloon past the slot.
fn decompress_xz_streaming(src: &Path, dest: &Path, max_bytes: u64) -> Result<(), UpdateError> {
    let io = |e: std::io::Error| UpdateError::Other(e.to_string());
    let input =
        std::io::BufReader::with_capacity(256 * 1024, std::fs::File::open(src).map_err(io)?);
    let mut reader = lzma_rust2::XzReader::new(input, false).take(max_bytes.saturating_add(1));
    let mut output = std::fs::File::create(dest).map_err(io)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|_| {
            UpdateError::Other(
                "The operating-system update could not be unpacked. Nothing was installed.".into(),
            )
        })?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > max_bytes {
            return Err(UpdateError::Other(
                "The operating-system update is larger than the space set aside for it. Nothing was installed."
                    .into(),
            ));
        }
        output.write_all(&buf[..n]).map_err(io)?;
    }
    output.sync_all().map_err(io)?;
    Ok(())
}

/// The A/B slot this boot came from. Missing `luna.slot=` is an error,
/// never a guess: picking 'A' blind would overwrite the running system.
fn active_slot_letter() -> Result<char, UpdateError> {
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    for token in cmdline.split_whitespace() {
        if let Some(slot) = token.strip_prefix("luna.slot=") {
            return match slot {
                "A" => Ok('A'),
                "B" => Ok('B'),
                _ => Err(UpdateError::Other(
                    "Luna can't tell which operating-system slot it booted from, so it won't touch the disks.".into(),
                )),
            };
        }
    }
    Err(UpdateError::Other(
        "This Luna did not boot from an OS slot, so an operating-system update can't be written here.".into(),
    ))
}

fn inactive_slot_device() -> Result<(PathBuf, char), UpdateError> {
    let active = active_slot_letter()?;
    let inactive = if active == 'A' { 'B' } else { 'A' };
    // GPT partition names, never filesystem LABELs — a removable drive can
    // carry a forged label and win a LABEL= lookup.
    let dev = resolve_partlabel(&format!("LUNA_{inactive}")).ok_or_else(|| {
        UpdateError::Other("Luna couldn't find the spare OS slot to write the update.".into())
    })?;
    ensure_on_boot_disk(&dev)?;
    Ok((dev, inactive))
}

/// Resolve a GPT partition name (PARTLABEL) to its device node.
/// `/dev/disk/by-partlabel` only exists under udev; `findfs`/`blkid` cover
/// the mdev-based Luna OS.
fn resolve_partlabel(partlabel: &str) -> Option<PathBuf> {
    let by = PathBuf::from(format!("/dev/disk/by-partlabel/{partlabel}"));
    if by.exists() {
        return Some(by);
    }
    let key = format!("PARTLABEL={partlabel}");
    let outs = [
        Command::new("findfs").arg(&key).output(),
        Command::new("blkid")
            .args(["-t", &key, "-o", "device"])
            .output(),
    ];
    for out in outs.into_iter().flatten() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// True when `dev` is the GPT partition named `partlabel`.
pub(crate) fn device_has_partlabel(dev: &str, partlabel: &str) -> bool {
    let by = PathBuf::from(format!("/dev/disk/by-partlabel/{partlabel}"));
    if by.exists()
        && let (Ok(a), Ok(b)) = (std::fs::canonicalize(&by), std::fs::canonicalize(dev))
        && a == b
    {
        return true;
    }
    Command::new("blkid")
        .args(["-o", "value", "-s", "PARTLABEL", dev])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == partlabel)
        .unwrap_or(false)
}

/// The device backing `/`, canonicalized (mounts may name a by-uuid link).
fn root_mount_device() -> Option<PathBuf> {
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(dev), Some(point)) = (fields.next(), fields.next()) else {
            continue;
        };
        if point == "/" {
            return Some(std::fs::canonicalize(dev).unwrap_or_else(|_| PathBuf::from(dev)));
        }
    }
    None
}

/// The disk a block device lives on: itself for a whole-disk device, else
/// its parent (`sda3` → `sda`, `mmcblk0p3` → `mmcblk0`) via sysfs.
pub(crate) fn parent_disk_of(dev: &Path) -> Option<String> {
    let canon = std::fs::canonicalize(dev).ok()?;
    let name = canon.file_name()?.to_str()?;
    let sys = Path::new("/sys/class/block").join(name);
    if !sys.join("partition").is_file() {
        return Some(name.to_string());
    }
    let part = std::fs::canonicalize(&sys).ok()?;
    part.parent()?.file_name()?.to_str().map(str::to_string)
}

/// Refuse to write a partition that is not on the disk backing `/` — and
/// never the very partition that backs `/` — so the update can only land
/// on the inactive slot of Luna's own boot disk.
fn ensure_on_boot_disk(dev: &Path) -> Result<(), UpdateError> {
    let Some(root) = root_mount_device() else {
        return Err(UpdateError::Other(
            "Luna can't tell which disk it runs from, so it won't write an operating-system update.".into(),
        ));
    };
    if std::fs::canonicalize(dev).ok() == Some(root.clone()) {
        return Err(UpdateError::Other(
            "The update would overwrite the partition Luna is running from, so Luna stopped. Nothing was installed.".into(),
        ));
    }
    match (parent_disk_of(dev), parent_disk_of(&root)) {
        (Some(target), Some(boot)) if target == boot => Ok(()),
        _ => Err(UpdateError::Other(
            "The update would write a different disk than the one Luna runs from, so Luna stopped. Nothing was installed.".into(),
        )),
    }
}

/// True when `dev` resolves by filesystem LABEL=LUNAASSETS is safe to
/// trust: the TOKENS magazine only ever lives on the removable install
/// stick, so a same-named filesystem on the boot disk or any fixed disk is
/// forged and must lose.
pub(crate) fn device_is_factory_media(dev: &str) -> bool {
    let Some(disk) = parent_disk_of(Path::new(dev)) else {
        return false;
    };
    let same_as_boot = root_mount_device()
        .and_then(|root| parent_disk_of(&root))
        .is_some_and(|boot| boot == disk);
    if same_as_boot {
        return false;
    }
    if std::fs::read_to_string(format!("/sys/block/{disk}/removable"))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
    {
        return true;
    }
    // USB bridges can report removable=0; the sysfs device path tells it.
    std::fs::canonicalize(format!("/sys/block/{disk}/device"))
        .map(|p| {
            p.components()
                .any(|c| crate::drives::detect::is_usb_bus_component(c.as_os_str()))
        })
        .unwrap_or(false)
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

/// True when `point` is itself a mounted vfat filesystem on the GPT
/// partition named `partlabel` — grub-looking files on any other
/// filesystem must not arm tryboot.
fn mounted_vfat_with_partlabel(point: &Path, partlabel: &str) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/self/mounts") else {
        return false;
    };
    let canon = std::fs::canonicalize(point).unwrap_or_else(|_| point.to_path_buf());
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(dev), Some(target), Some(fs)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !matches!(fs, "vfat" | "fat" | "msdos") {
            continue;
        }
        if Path::new(&target.replace("\\040", " ")) != canon {
            continue;
        }
        return device_has_partlabel(dev, partlabel);
    }
    false
}

fn find_esp_mount_or_temp() -> Result<EspGuard, UpdateError> {
    for cand in ["/boot/efi", "/efi", "/boot"] {
        let grubenv = Path::new(cand).join("grub/grubenv");
        let grubcfg = Path::new(cand).join("grub/grub.cfg");
        if (grubenv.exists() || grubcfg.exists())
            && mounted_vfat_with_partlabel(Path::new(cand), "LUNAESP")
        {
            return Ok(EspGuard {
                path: PathBuf::from(cand),
                tmp: false,
            });
        }
    }
    // GPT partition name only — a filesystem LABEL=LUNAESP can be forged on
    // any plugged-in drive.
    let dev = resolve_partlabel("LUNAESP").ok_or_else(|| {
        UpdateError::Other("Luna couldn't find the boot partition for the update.".into())
    })?;
    ensure_on_boot_disk(&dev)?;
    let tmp = std::env::temp_dir().join(format!("luna-esp-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| UpdateError::Other(e.to_string()))?;
    let status = Command::new("mount")
        .arg("-o")
        .arg("rw,nosuid,nodev,noexec")
        .arg(&dev)
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

/// Admin-visible update source: where Luna reads the signed update feed, which
/// channel it follows, and which minisign public keys it trusts. Empty fields
/// mean "use the built-in default" (env var if set, else the compiled-in value).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UpdateSettings {
    /// Folder that holds `luna/<channel>.json`, with no trailing slash.
    #[serde(default)]
    pub feed_url: String,
    /// `stable` or `beta`.
    #[serde(default)]
    pub channel: String,
    /// Minisign public keys (base64 `RW…` lines). Empty means the compiled-in
    /// release key.
    #[serde(default)]
    pub keys: Vec<String>,
}

impl UpdateSettings {
    pub(crate) fn is_empty(&self) -> bool {
        self.feed_url.is_empty() && self.channel.is_empty() && self.keys.is_empty()
    }
}

/// Resolved source the updater actually uses (no empty fields left).
#[derive(Debug, Clone)]
struct ActiveSource {
    feed_url: String,
    channel: String,
    keys: Vec<String>,
}

fn active_from(feed_url: String, channel: String, keys: Vec<String>) -> ActiveSource {
    ActiveSource {
        feed_url: feed_url.trim().trim_end_matches('/').to_string(),
        channel,
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
        feed_url: std::env::var("LUNA_UPDATES_FEED").unwrap_or_else(|_| DEFAULT_FEED_URL.into()),
        channel: std::env::var("LUNA_UPDATES_CHANNEL").unwrap_or_else(|_| DEFAULT_CHANNEL.into()),
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
    let feed_url = settings.feed_url.trim();
    if feed_url.is_empty() {
        return Err(
            "The feed address needs a value. Put in the old address if you want to keep it.",
        );
    }
    crate::system::update_host::validate_feed_url_host(feed_url)?;
    if !CHANNELS.contains(&settings.channel.trim()) {
        return Err("Pick Stable or Beta as the update channel.");
    }
    let total: usize = settings.keys.iter().map(|k| k.len()).sum();
    if total > MAX_PUB_TEXT_BYTES {
        return Err("That signing key list is too long. One key per line is enough.");
    }
    normalize_pub_keys(&settings.keys)
}

/// What one successful feed read tells us.
struct Resolved {
    info: UpdateInfo,
    lunad: Part,
    os: Option<Part>,
    lunad_newer: bool,
    os_needed: bool,
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
            d.feed_url,
            d.channel,
        )
    }

    /// Build the service from persisted settings, falling back to env vars and
    /// compiled-in defaults for every unset field.
    pub fn from_db(conn: &Connection, data_dir: &Path) -> Self {
        let stored = load_settings(conn).unwrap_or_default();
        let d = default_settings();
        Self::with_keys(
            Box::new(UreqHttp),
            Box::new(DataDirInstaller::new(data_dir)),
            first_nonempty(&stored.feed_url, &d.feed_url),
            first_nonempty(&stored.channel, &d.channel),
            if stored.keys.is_empty() {
                d.keys
            } else {
                stored.keys
            },
        )
    }

    pub fn new(
        http: Box<dyn HttpGet>,
        installer: Box<dyn Installer>,
        feed_url: String,
        channel: String,
    ) -> Self {
        Self::with_keys(
            http,
            installer,
            feed_url,
            channel,
            parse_minisign_pub(PINNED_PUB),
        )
    }

    pub(crate) fn with_keys(
        http: Box<dyn HttpGet>,
        installer: Box<dyn Installer>,
        feed_url: String,
        channel: String,
        keys: Vec<String>,
    ) -> Self {
        warn_on_custom_keys(&keys);
        installer.settle_os_boot();
        Self {
            http,
            installer,
            active: Mutex::new(active_from(feed_url, channel, keys)),
            cache: Mutex::new(None),
        }
    }

    /// Settle a freshly booted OS image. Called at startup, on a timer and
    /// before every feed read, because `luna-boot-ok` runs after lunad starts.
    pub fn settle_os_boot(&self) {
        self.installer.settle_os_boot();
    }

    /// Version of the OS update that didn't start (Luna went back to the
    /// previous system), if the last one failed. The version may be empty.
    pub fn failed_os_update(&self) -> Option<String> {
        self.installer.read_os_failed()?;
        Some(self.installer.read_os_failed_version().unwrap_or_default())
    }

    /// Forget a failed OS update so the same image is offered again.
    pub fn clear_failed_os_update(&self) -> Result<(), UpdateError> {
        self.installer.clear_os_failed()?;
        *self.cache.lock().unwrap() = None;
        Ok(())
    }

    fn source(&self) -> ActiveSource {
        self.active.lock().unwrap().clone()
    }

    /// The update source currently in effect.
    pub fn settings(&self) -> UpdateSettings {
        let src = self.source();
        UpdateSettings {
            feed_url: src.feed_url,
            channel: src.channel,
            keys: src.keys,
        }
    }

    /// How many trusted signing keys actually decode as minisign keys. Zero
    /// means no feed can pass verification.
    pub fn usable_key_count(&self) -> usize {
        self.source()
            .keys
            .iter()
            .filter(|k| PublicKey::from_base64(k).is_ok())
            .count()
    }

    /// True when the trusted keys are still the compiled-in release key.
    pub fn using_default_keys(&self) -> bool {
        self.source().keys == parse_minisign_pub(PINNED_PUB)
    }

    /// Hot-swap the update source (admin saved new settings). Clears the
    /// cache so the next check goes to the new source.
    pub fn reconfigure(&self, feed_url: String, channel: String, keys: Vec<String>) {
        let keys = if keys.is_empty() {
            parse_minisign_pub(PINNED_PUB)
        } else {
            keys
        };
        warn_on_custom_keys(&keys);
        *self.active.lock().unwrap() = active_from(feed_url, channel, keys);
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
        let resolved = self.read_feed(current_version)?;
        *self.cache.lock().unwrap() = Some((Instant::now(), resolved.info.clone()));
        Ok(resolved.info)
    }

    /// Fetch, verify and read the feed for this source, then work out what
    /// (if anything) would be installed.
    fn read_feed(&self, current_version: &str) -> Result<Resolved, UpdateError> {
        self.installer.settle_os_boot();
        let src = self.source();
        let feed_path = format!("{}/{UNIT}/{}.json", src.feed_url, src.channel);
        let (status, body) = self.http.get(&feed_path)?;
        if status == 404 {
            return Err(UpdateError::NoFeed);
        }
        if status != 200 {
            return Err(UpdateError::Unreachable);
        }
        let (sig_status, sig) = self
            .http
            .get(&format!("{feed_path}.minisig"))
            .map_err(|_| UpdateError::MissingSignature)?;
        if sig_status != 200 {
            return Err(UpdateError::MissingSignature);
        }

        let arch = feed_arch();
        let seen = self
            .installer
            .read_feed_seen(UNIT, &src.channel)
            .unwrap_or_default();
        let verified = feed::check(
            &body,
            &sig,
            &src.keys,
            &feed::Request {
                unit: UNIT,
                channel: &src.channel,
                part: "lunad",
                os: FEED_OS,
                arch,
                installed_version: current_version,
                newest_published_seen: &seen,
            },
        )
        .map_err(map_feed_error)?;

        if verified.feed.published.as_str() > seen.as_str()
            && let Err(e) =
                self.installer
                    .write_feed_seen(UNIT, &src.channel, &verified.feed.published)
        {
            tracing::warn!(error = %e, "couldn't remember the newest update list");
        }

        let os = feed::select_part(&verified.feed.parts, "os", FEED_OS, arch).cloned();
        // Never move to an older release: an OS image only counts when the
        // feed is not behind what is running.
        let os_needed = !verified.older
            && match (&os, self.installer.read_os_hash()) {
                (Some(part), Some(local)) => {
                    let same =
                        |h: Option<String>| h.is_some_and(|h| h.eq_ignore_ascii_case(&part.sha256));
                    !local.eq_ignore_ascii_case(&part.sha256)
                        // Already written and waiting for its reboot, or
                        // written once and the box fell back: don't re-flash.
                        && !same(self.installer.read_os_pending())
                        && !same(self.installer.read_os_failed())
                }
                // No recorded hash: the factory install always writes one. A
                // box without it must not be surprised by a re-flash.
                _ => false,
            };
        let info = UpdateInfo {
            current_version: current_version.to_string(),
            latest_version: verified.feed.version.clone(),
            update_available: verified.newer || os_needed,
            release_notes: verified.feed.notes.clone(),
            checksum: verified.part.sha256.clone(),
            binary_name: verified.part.file.clone(),
            reboot_required: os_needed,
        };
        Ok(Resolved {
            info,
            lunad: verified.part,
            os,
            lunad_newer: verified.newer,
            os_needed,
        })
    }

    pub fn apply(&self, current_version: &str) -> Result<UpdateInfo, UpdateError> {
        let resolved = self.read_feed(current_version)?;
        let mut info = resolved.info.clone();
        if !info.update_available {
            return Err(UpdateError::NoneAvailable);
        }

        if resolved.lunad_newer {
            let max = crate::budget::limits().update_download_bytes;
            let tmp = self.download_verified(&resolved.lunad, max)?;
            if let Err(e) = self.installer.install_lunad_file(&tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            let _ = std::fs::remove_file(&tmp);
        }

        if resolved.os_needed
            && let Some(os) = &resolved.os
        {
            let tmp = self.download_verified(os, OS_IMAGE_MAX_BYTES)?;
            if let Err(e) = self.installer.install_os_image_file(&tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            let _ = std::fs::remove_file(&tmp);
            // Not the installed hash yet: that is recorded only once the new
            // slot has booted (`Installer::settle_os_boot`).
            self.installer
                .mark_os_pending(&os.sha256.to_lowercase(), &info.latest_version)?;
            info.reboot_required = true;
        } else {
            info.reboot_required = false;
        }

        *self.cache.lock().unwrap() = None;
        Ok(info)
    }

    /// Stream a feed part into the staging dir, checking size and SHA-256 as
    /// it lands (`luna_feed::download_with`). The file name is
    /// unguessable and created exclusively, so a planted symlink can't
    /// redirect the download.
    fn download_verified(&self, part: &Part, max_bytes: u64) -> Result<PathBuf, UpdateError> {
        if part.size > max_bytes {
            return Err(UpdateError::Other(
                "That update file is too large for the free memory on this Luna.".into(),
            ));
        }
        let dir = self.installer.staging_dir();
        std::fs::create_dir_all(&dir).map_err(|e| UpdateError::Other(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dir)
                .map_err(|e| UpdateError::Other(e.to_string()))?
                .permissions();
            perms.set_mode(0o700);
            let _ = std::fs::set_permissions(&dir, perms);
        }
        // `part.name` is what we asked the feed for ("lunad" or "os"), never
        // text the feed chose, so it is safe in a file name.
        let tmp = dir.join(format!(
            "luna-update-{}-{}",
            uuid::Uuid::new_v4().simple(),
            part.name
        ));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| UpdateError::Other(e.to_string()))?;
        if let Err(e) = feed::download_with(part, &tmp, |url| self.http.open(url)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(match e {
                FeedError::SizeMismatch | FeedError::ShaMismatch => UpdateError::Checksum,
                FeedError::AllUrlsFailed => UpdateError::Unreachable,
                other => UpdateError::Other(other.to_string()),
            });
        }
        Ok(tmp)
    }
}

/// OS the feed's `lunad` and `os` parts are published for.
const FEED_OS: &str = "linux";

fn feed_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn map_feed_error(e: FeedError) -> UpdateError {
    match e {
        FeedError::BadSignature => UpdateError::BadSignature,
        FeedError::UnknownFormat(_) => UpdateError::UnknownFormat,
        FeedError::Replayed => UpdateError::Replayed,
        FeedError::MissingPart => UpdateError::MissingPart,
        FeedError::WrongUnit
        | FeedError::WrongChannel
        | FeedError::Malformed(_)
        | FeedError::BadVersion(_) => UpdateError::BadFeed,
        other => UpdateError::Other(other.to_string()),
    }
}

/// Anything other than the compiled-in release key means updates come from
/// a source Luna does not control — loud in the log, flagged in System
/// check via `using_default_keys`.
fn warn_on_custom_keys(keys: &[String]) {
    if keys != parse_minisign_pub(PINNED_PUB) {
        tracing::warn!(
            "update source is signed with custom keys, not the built-in Luna release key"
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use minisign::KeyPair;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    const FEED: &str = "http://feeds.test";

    struct MapHttp {
        map: HashMap<String, (u16, Vec<u8>)>,
    }

    impl HttpGet for MapHttp {
        fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
            self.map.get(url).cloned().ok_or(UpdateError::Unreachable)
        }
    }

    /// Records what the service installed and remembers state in memory.
    #[derive(Default)]
    struct RecInstaller {
        lunad: Mutex<Vec<u8>>,
        os: Mutex<Vec<u8>>,
        os_hash: Mutex<Option<String>>,
        os_pending: Mutex<Option<String>>,
        os_failed: Mutex<Option<String>>,
        seen: Mutex<HashMap<String, String>>,
    }

    impl Installer for Arc<RecInstaller> {
        fn install_lunad(&self, bytes: &[u8]) -> Result<(), UpdateError> {
            *self.lunad.lock().unwrap() = bytes.to_vec();
            Ok(())
        }
        fn install_os_image(&self, bytes: &[u8]) -> Result<(), UpdateError> {
            *self.os.lock().unwrap() = bytes.to_vec();
            Ok(())
        }
        fn read_os_hash(&self) -> Option<String> {
            self.os_hash.lock().unwrap().clone()
        }
        fn write_os_hash(&self, hash: &str) -> Result<(), UpdateError> {
            *self.os_hash.lock().unwrap() = Some(hash.to_string());
            Ok(())
        }
        fn mark_os_pending(&self, hash: &str, _version: &str) -> Result<(), UpdateError> {
            *self.os_pending.lock().unwrap() = Some(hash.to_string());
            Ok(())
        }
        fn read_os_pending(&self) -> Option<String> {
            self.os_pending.lock().unwrap().clone()
        }
        fn read_os_failed(&self) -> Option<String> {
            self.os_failed.lock().unwrap().clone()
        }
        fn read_feed_seen(&self, unit: &str, channel: &str) -> Option<String> {
            self.seen
                .lock()
                .unwrap()
                .get(&format!("{unit}/{channel}"))
                .cloned()
        }
        fn write_feed_seen(&self, unit: &str, channel: &str, p: &str) -> Result<(), UpdateError> {
            self.seen
                .lock()
                .unwrap()
                .insert(format!("{unit}/{channel}"), p.to_string());
            Ok(())
        }
    }

    fn sha(bytes: &[u8]) -> String {
        feed::hex_lower(&Sha256::digest(bytes))
    }

    fn sign(bytes: &[u8], sk: &minisign::SecretKey) -> Vec<u8> {
        minisign::sign(None, sk, Cursor::new(bytes), None, None)
            .unwrap()
            .to_string()
            .into_bytes()
    }

    /// A feed with a lunad part and an optional os part, both downloadable
    /// from `http://dl.test/<file>`.
    struct Release<'a> {
        version: &'a str,
        published: &'a str,
        channel: &'a str,
        unit: &'a str,
        lunad: &'a [u8],
        os: Option<&'a [u8]>,
    }

    impl Default for Release<'_> {
        fn default() -> Self {
            Release {
                version: "0.4.0",
                published: "2026-10-12T14:03:00Z",
                channel: "stable",
                unit: "luna",
                lunad: b"lunad-v0.4.0",
                os: None,
            }
        }
    }

    impl Release<'_> {
        fn feed_json(&self) -> String {
            let arch = feed_arch();
            let mut parts = vec![format!(
                r#"{{"name":"lunad","os":"linux","arch":"{arch}","file":"lunad-linux-amd64-musl","size":{},"sha256":"{}","urls":["http://dl.test/lunad"]}}"#,
                self.lunad.len(),
                sha(self.lunad)
            )];
            if let Some(os) = self.os {
                parts.push(format!(
                    r#"{{"name":"os","os":"linux","arch":"{arch}","file":"luna-os-x86_64.img.xz","size":{},"sha256":"{}","urls":["http://dl.test/os"]}}"#,
                    os.len(),
                    sha(os)
                ));
            }
            format!(
                r#"{{"format":1,"unit":"{}","channel":"{}","version":"{}","published":"{}","notes":"notes for {}","parts":[{}]}}"#,
                self.unit,
                self.channel,
                self.version,
                self.published,
                self.version,
                parts.join(",")
            )
        }

        /// The service, its trusted key, and the installer it records into.
        fn service(&self) -> (UpdateService, Arc<RecInstaller>) {
            let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
            self.service_with(&sk, pk.to_base64())
        }

        fn service_with(
            &self,
            sk: &minisign::SecretKey,
            trusted: String,
        ) -> (UpdateService, Arc<RecInstaller>) {
            let body = self.feed_json().into_bytes();
            let sig = sign(&body, sk);
            let mut map = HashMap::new();
            map.insert(format!("{FEED}/luna/stable.json"), (200, body.clone()));
            map.insert(format!("{FEED}/luna/stable.json.minisig"), (200, sig));
            map.insert("http://dl.test/lunad".into(), (200, self.lunad.to_vec()));
            if let Some(os) = self.os {
                map.insert("http://dl.test/os".into(), (200, os.to_vec()));
            }
            let installer = Arc::new(RecInstaller::default());
            let svc = UpdateService::with_keys(
                Box::new(MapHttp { map }),
                Box::new(installer.clone()),
                FEED.into(),
                "stable".into(),
                vec![trusted],
            );
            (svc, installer)
        }
    }

    #[test]
    fn pinned_pub_parses() {
        assert!(
            !parse_minisign_pub(PINNED_PUB).is_empty(),
            "keys/lsluna.minisign.pub must contain an RW public key line"
        );
        let dir = tempfile::tempdir().unwrap();
        assert!(
            UpdateService::from_env(dir.path()).usable_key_count() > 0,
            "the pinned key must decode, or the system check flags every Luna"
        );
    }

    #[test]
    fn missing_feed_says_nothing_is_published_yet() {
        let mut map = HashMap::new();
        map.insert(format!("{FEED}/luna/stable.json"), (404, Vec::new()));
        let svc = UpdateService::with_keys(
            Box::new(MapHttp { map }),
            Box::new(Arc::new(RecInstaller::default())),
            FEED.into(),
            "stable".into(),
            vec![],
        );
        assert_eq!(svc.check("0.3.0", true).unwrap_err(), UpdateError::NoFeed);
    }

    #[test]
    fn newer_feed_is_an_update() {
        let (svc, _) = Release::default().service();
        let info = svc.check("0.3.0", true).unwrap();
        assert_eq!(info.latest_version, "0.4.0");
        assert!(info.update_available);
        assert!(!info.reboot_required);
        assert_eq!(info.release_notes, "notes for 0.4.0");
        assert_eq!(info.checksum, sha(b"lunad-v0.4.0"));
        assert_eq!(info.binary_name, "lunad-linux-amd64-musl");
    }

    #[test]
    fn same_or_lower_version_is_no_update_and_apply_refuses() {
        let (svc, _) = Release::default().service();
        for current in ["0.4.0", "0.5.0", "0.4.1"] {
            assert!(
                !svc.check(current, true).unwrap().update_available,
                "{current}"
            );
            assert_eq!(svc.apply(current).unwrap_err(), UpdateError::NoneAvailable);
        }
        // A beta is below its release.
        assert!(svc.check("0.4.0-beta.3", true).unwrap().update_available);
    }

    #[test]
    fn apply_installs_the_lunad_part() {
        let (svc, inst) = Release::default().service();
        let info = svc.apply("0.3.0").unwrap();
        assert!(!info.reboot_required);
        assert_eq!(*inst.lunad.lock().unwrap(), b"lunad-v0.4.0");
        assert!(inst.os.lock().unwrap().is_empty());
    }

    #[test]
    fn apply_rejects_a_part_that_does_not_match_the_feed() {
        let r = Release::default();
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        // Same feed, but the server hands out different bytes of the same size.
        let body = r.feed_json().into_bytes();
        let sig = sign(&body, &sk);
        let mut map = HashMap::new();
        map.insert(format!("{FEED}/luna/stable.json"), (200, body));
        map.insert(format!("{FEED}/luna/stable.json.minisig"), (200, sig));
        map.insert(
            "http://dl.test/lunad".into(),
            (200, b"LUNAD-V0.4.0".to_vec()),
        );
        let installer = Arc::new(RecInstaller::default());
        let svc = UpdateService::with_keys(
            Box::new(MapHttp { map }),
            Box::new(installer.clone()),
            FEED.into(),
            "stable".into(),
            vec![pk.to_base64()],
        );
        assert_eq!(svc.apply("0.3.0").unwrap_err(), UpdateError::Checksum);
        assert!(installer.lunad.lock().unwrap().is_empty());
    }

    #[test]
    fn untrusted_or_missing_signature_installs_nothing() {
        let r = Release::default();
        let other = KeyPair::generate_unencrypted_keypair()
            .unwrap()
            .pk
            .to_base64();
        let KeyPair { sk, .. } = KeyPair::generate_unencrypted_keypair().unwrap();
        let (svc, inst) = r.service_with(&sk, other);
        assert_eq!(svc.apply("0.3.0").unwrap_err(), UpdateError::BadSignature);
        assert!(inst.lunad.lock().unwrap().is_empty());

        let svc = UpdateService::with_keys(
            Box::new(MapHttp {
                map: HashMap::from([(
                    format!("{FEED}/luna/stable.json"),
                    (200, r.feed_json().into_bytes()),
                )]),
            }),
            Box::new(Arc::new(RecInstaller::default())),
            FEED.into(),
            "stable".into(),
            vec!["RWnotarealkey".into()],
        );
        assert_eq!(
            svc.apply("0.3.0").unwrap_err(),
            UpdateError::MissingSignature
        );
    }

    #[test]
    fn feed_for_another_unit_or_channel_is_refused() {
        let (svc, _) = Release {
            unit: "sol",
            ..Release::default()
        }
        .service();
        assert_eq!(svc.check("0.3.0", true).unwrap_err(), UpdateError::BadFeed);
        let (svc, _) = Release {
            channel: "beta",
            ..Release::default()
        }
        .service();
        assert_eq!(svc.check("0.3.0", true).unwrap_err(), UpdateError::BadFeed);
    }

    #[test]
    fn unknown_format_is_refused_in_plain_words() {
        let r = Release::default();
        let body = r
            .feed_json()
            .replace(r#""format":1"#, r#""format":2"#)
            .into_bytes();
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        let sig = sign(&body, &sk);
        let svc = UpdateService::with_keys(
            Box::new(MapHttp {
                map: HashMap::from([
                    (format!("{FEED}/luna/stable.json"), (200, body)),
                    (format!("{FEED}/luna/stable.json.minisig"), (200, sig)),
                ]),
            }),
            Box::new(Arc::new(RecInstaller::default())),
            FEED.into(),
            "stable".into(),
            vec![pk.to_base64()],
        );
        assert_eq!(
            svc.check("0.3.0", true).unwrap_err(),
            UpdateError::UnknownFormat
        );
    }

    #[test]
    fn replayed_feed_is_refused_and_newest_published_is_remembered() {
        let (svc, inst) = Release::default().service();
        // Nothing seen yet: accepted, and the date is remembered per unit+channel.
        svc.check("0.3.0", true).unwrap();
        assert_eq!(
            inst.read_feed_seen("luna", "stable").as_deref(),
            Some("2026-10-12T14:03:00Z")
        );
        // Equal is fine.
        svc.check("0.3.0", true).unwrap();
        // A newer one seen elsewhere makes this feed a replay.
        inst.write_feed_seen("luna", "stable", "2026-10-13T00:00:00Z")
            .unwrap();
        assert_eq!(svc.check("0.3.0", true).unwrap_err(), UpdateError::Replayed);
        // The date never moves backwards.
        assert_eq!(
            inst.read_feed_seen("luna", "stable").as_deref(),
            Some("2026-10-13T00:00:00Z")
        );
        // Another channel's state is separate.
        assert_eq!(inst.read_feed_seen("luna", "beta"), None);
    }

    #[test]
    fn os_part_with_a_different_hash_is_applied_and_hash_stored() {
        let r = Release {
            os: Some(b"os-image-v2"),
            ..Release::default()
        };
        let (svc, inst) = r.service();
        *inst.os_hash.lock().unwrap() = Some("old-os-hash".into());
        // Same lunad version, different OS hash: still an update that reboots.
        let info = svc.check("0.4.0", true).unwrap();
        assert!(info.update_available);
        assert!(info.reboot_required);
        let applied = svc.apply("0.4.0").unwrap();
        assert!(applied.reboot_required);
        assert_eq!(*inst.os.lock().unwrap(), b"os-image-v2");
        assert!(inst.lunad.lock().unwrap().is_empty(), "lunad is not newer");
        // Not recorded as installed until the new slot has booted.
        assert_eq!(*inst.os_hash.lock().unwrap(), Some("old-os-hash".into()));
        assert_eq!(*inst.os_pending.lock().unwrap(), Some(sha(b"os-image-v2")));
        // Written and waiting for its reboot: the next look finds nothing to do.
        assert!(!svc.check("0.4.0", true).unwrap().update_available);
    }

    #[test]
    fn an_image_that_already_failed_to_boot_is_not_offered_again() {
        let r = Release {
            os: Some(b"os-image-v2"),
            ..Release::default()
        };
        let (svc, inst) = r.service();
        *inst.os_hash.lock().unwrap() = Some("old-os-hash".into());
        *inst.os_failed.lock().unwrap() = Some(sha(b"os-image-v2").to_uppercase());
        assert!(!svc.check("0.4.0", true).unwrap().update_available);
        // A different image is still offered.
        *inst.os_failed.lock().unwrap() = Some("some-other-image".into());
        assert!(svc.check("0.4.0", true).unwrap().update_available);
    }

    #[derive(Default)]
    struct FakeSlot {
        log: Mutex<Vec<String>>,
        fail_at: Option<&'static str>,
    }

    impl FakeSlot {
        fn step(&self, what: &str) -> Result<(), UpdateError> {
            self.log.lock().unwrap().push(what.to_string());
            if self.fail_at == Some(what) {
                Err(UpdateError::Other(format!("{what} failed")))
            } else {
                Ok(())
            }
        }
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl SlotOps for FakeSlot {
        fn read_uuid(&self, _part: &Path) -> Result<String, UpdateError> {
            self.step("read_uuid")?;
            Ok("11111111-2222-3333-4444-555555555555".into())
        }
        fn check_fs(&self, _part: &Path) -> Result<(), UpdateError> {
            self.step("fsck")
        }
        fn set_uuid(&self, _part: &Path, uuid: &str) -> Result<(), UpdateError> {
            self.step(&format!("uuid {uuid}"))
        }
        fn set_label(&self, _part: &Path, label: &str) {
            let _ = self.step(&format!("label {label}"));
        }
        fn arm(&self, slot: char) -> Result<(), UpdateError> {
            self.step(&format!("arm {slot}"))
        }
    }

    #[test]
    fn slot_is_written_checked_given_its_old_uuid_then_armed() {
        let ops = FakeSlot::default();
        write_os_slot(&ops, Path::new("/dev/x"), 'B', || ops.step("write")).unwrap();
        assert_eq!(
            ops.log(),
            [
                "read_uuid",
                "write",
                "fsck",
                "uuid 11111111-2222-3333-4444-555555555555",
                "label LUNA_B",
                "arm B"
            ]
        );
    }

    #[test]
    fn slot_is_never_armed_when_a_step_fails() {
        for bad in [
            "read_uuid",
            "write",
            "fsck",
            "uuid 11111111-2222-3333-4444-555555555555",
        ] {
            let ops = FakeSlot {
                fail_at: Some(bad),
                ..FakeSlot::default()
            };
            assert!(write_os_slot(&ops, Path::new("/dev/x"), 'A', || ops.step("write")).is_err());
            assert!(!ops.log().iter().any(|l| l.starts_with("arm")), "{bad}");
        }
        // Nothing is written when the old UUID can't be read.
        let ops = FakeSlot {
            fail_at: Some("read_uuid"),
            ..FakeSlot::default()
        };
        let _ = write_os_slot(&ops, Path::new("/dev/x"), 'A', || ops.step("write"));
        assert_eq!(ops.log(), ["read_uuid"]);
    }

    #[test]
    fn the_slot_id_comes_from_the_boot_menu_not_from_a_half_written_slot() {
        let cfg = r#"menuentry "Luna" {
    if [ "$luna_slot" = "B" ]; then
      search --no-floppy --fs-uuid --set=root bbbbbbbb-2222-3333-4444-555555555555
      linux /boot/vmlinuz-lts root=UUID=bbbbbbbb-2222-3333-4444-555555555555 luna.slot=B modules=ext4 quiet
    else
      search --no-floppy --fs-uuid --set=root aaaaaaaa-2222-3333-4444-555555555555
      linux /boot/vmlinuz-lts root=UUID=aaaaaaaa-2222-3333-4444-555555555555 luna.slot=A modules=ext4 quiet
    fi
}"#;
        assert_eq!(
            pinned_uuid_from_grub_cfg(cfg, 'B').as_deref(),
            Some("bbbbbbbb-2222-3333-4444-555555555555")
        );
        assert_eq!(
            pinned_uuid_from_grub_cfg(cfg, 'A').as_deref(),
            Some("aaaaaaaa-2222-3333-4444-555555555555")
        );
        assert_eq!(pinned_uuid_from_grub_cfg("nothing here", 'A'), None);
    }

    #[test]
    fn fsck_exit_codes_zero_and_one_are_success() {
        assert!(fsck_succeeded(Some(0)));
        assert!(fsck_succeeded(Some(1)));
        assert!(!fsck_succeeded(Some(2)));
        assert!(!fsck_succeeded(Some(4)));
        assert!(!fsck_succeeded(None));
    }

    #[test]
    fn ext4_uuid_is_read_from_the_superblock() {
        let dir = tempfile::tempdir().unwrap();
        let dev = dir.path().join("slot");
        let mut img = vec![0u8; 4096];
        img[1024 + 0x38] = 0x53;
        img[1024 + 0x39] = 0xEF;
        let raw: [u8; 16] = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
            0xcd, 0xef,
        ];
        img[1024 + 0x68..1024 + 0x78].copy_from_slice(&raw);
        std::fs::write(&dev, &img).unwrap();
        assert_eq!(
            read_ext4_uuid(&dev).unwrap(),
            "01234567-89ab-cdef-0123-456789abcdef"
        );
        // Not ext4 (no magic): refused, never guessed.
        img[1024 + 0x38] = 0;
        std::fs::write(&dev, &img).unwrap();
        assert!(read_ext4_uuid(&dev).is_err());
        assert!(read_ext4_uuid(&dir.path().join("missing")).is_err());
    }

    fn pending_installer(dir: &Path) -> DataDirInstaller {
        let inst = DataDirInstaller::new(dir);
        inst.write_os_hash("old").unwrap();
        std::fs::write(dir.join(OS_PENDING_FILE), "newhash B boot-1\n").unwrap();
        inst
    }

    #[test]
    fn pending_hash_is_recorded_only_after_the_new_slot_boots() {
        let dir = tempfile::tempdir().unwrap();
        let inst = pending_installer(dir.path());
        // Same boot (e.g. lunad restarted before the reboot): no verdict.
        assert_eq!(
            inst.settle_pending(Some('A'), "boot-1", true),
            Settle::SameBoot
        );
        assert_eq!(inst.read_os_hash().as_deref(), Some("old"));
        assert_eq!(inst.read_os_pending().as_deref(), Some("newhash"));
        // Unknown slot after a reboot: leave it for a boot that can tell.
        assert_eq!(inst.settle_pending(None, "boot-2", true), Settle::Nothing);
        assert_eq!(inst.read_os_pending().as_deref(), Some("newhash"));
        // Rebooted into the new slot, but boot-ok hasn't confirmed it: wait.
        assert_eq!(
            inst.settle_pending(Some('B'), "boot-2", false),
            Settle::Unconfirmed
        );
        assert_eq!(inst.read_os_hash().as_deref(), Some("old"));
        assert_eq!(inst.read_os_pending().as_deref(), Some("newhash"));
        // boot-ok confirmed it: now it counts.
        assert_eq!(
            inst.settle_pending(Some('B'), "boot-2", true),
            Settle::Booted
        );
        assert_eq!(inst.read_os_hash().as_deref(), Some("newhash"));
        assert_eq!(inst.read_os_pending(), None);
        assert_eq!(inst.read_os_failed(), None);
        assert_eq!(
            inst.settle_pending(Some('B'), "boot-3", true),
            Settle::Nothing
        );
    }

    #[test]
    fn fallback_keeps_the_old_hash_and_remembers_the_failed_image() {
        let dir = tempfile::tempdir().unwrap();
        let inst = pending_installer(dir.path());
        // Rebooted, but on the old slot: GRUB fell back.
        assert_eq!(
            inst.settle_pending(Some('A'), "boot-2", false),
            Settle::FellBack
        );
        assert_eq!(inst.read_os_hash().as_deref(), Some("old"));
        assert_eq!(inst.read_os_pending(), None);
        assert_eq!(inst.read_os_failed().as_deref(), Some("newhash"));
        // A later image that boots clears the failure.
        std::fs::write(dir.path().join(OS_PENDING_FILE), "better A boot-2 1.2.3\n").unwrap();
        assert_eq!(
            inst.settle_pending(Some('A'), "boot-3", true),
            Settle::Booted
        );
        assert_eq!(inst.read_os_failed(), None);
    }

    #[test]
    fn fallback_remembers_the_failed_version_and_it_can_be_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let inst = DataDirInstaller::new(dir.path());
        inst.write_os_hash("old").unwrap();
        std::fs::write(dir.path().join(OS_PENDING_FILE), "newhash B boot-1 0.9.0\n").unwrap();
        // Fallback needs no boot-ok: the old slot is simply what came up.
        assert_eq!(
            inst.settle_pending(Some('A'), "boot-2", false),
            Settle::FellBack
        );
        assert_eq!(inst.read_os_failed().as_deref(), Some("newhash"));
        assert_eq!(inst.read_os_failed_version().as_deref(), Some("0.9.0"));
        inst.clear_os_failed().unwrap();
        assert_eq!(inst.read_os_failed(), None);
        // Clearing when nothing failed is fine.
        inst.clear_os_failed().unwrap();
    }

    #[test]
    fn boot_ok_counts_only_for_this_boot() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("boot-ok");
        assert!(!boot_ok_confirmed(&marker, "boot-2"));
        std::fs::write(&marker, "boot-1\n").unwrap();
        assert!(!boot_ok_confirmed(&marker, "boot-2"));
        std::fs::write(&marker, "boot-2\n").unwrap();
        assert!(boot_ok_confirmed(&marker, "boot-2"));
        assert!(!boot_ok_confirmed(&marker, ""));
    }

    #[test]
    fn os_part_is_skipped_when_hash_matches_unknown_or_feed_is_older() {
        let r = Release {
            os: Some(b"os-image-v2"),
            ..Release::default()
        };
        let (svc, inst) = r.service();
        // Matching hash.
        *inst.os_hash.lock().unwrap() = Some(sha(b"os-image-v2"));
        assert!(!svc.check("0.4.0", true).unwrap().update_available);
        // No recorded hash: never surprise a box with a re-flash.
        *inst.os_hash.lock().unwrap() = None;
        assert!(!svc.check("0.4.0", true).unwrap().update_available);
        // Feed older than what is running: never go backwards, OS included.
        *inst.os_hash.lock().unwrap() = Some("different".into());
        assert!(!svc.check("0.5.0", true).unwrap().update_available);
    }

    #[test]
    fn xz_image_is_decompressed_as_a_stream() {
        let dir = tempfile::tempdir().unwrap();
        let image: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let xz = dir.path().join("os.img.xz");
        {
            let mut w = lzma_rust2::XzWriter::new(
                std::fs::File::create(&xz).unwrap(),
                lzma_rust2::XzOptions::with_preset(1),
            )
            .unwrap();
            w.write_all(&image).unwrap();
            w.finish().unwrap();
        }
        let out = dir.path().join("slot");
        decompress_xz_streaming(&xz, &out, 1 << 20).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), image);

        // Over the cap: refused rather than written past the slot.
        let capped = dir.path().join("capped");
        let err = decompress_xz_streaming(&xz, &capped, 1000).unwrap_err();
        assert!(matches!(err, UpdateError::Other(m) if m.contains("larger")));

        // Not xz at all.
        let junk = dir.path().join("junk.xz");
        std::fs::write(&junk, b"definitely not xz data").unwrap();
        assert!(decompress_xz_streaming(&junk, &dir.path().join("o2"), 1 << 20).is_err());
    }

    #[test]
    fn data_dir_installer_remembers_hash_and_feed_dates() {
        let dir = tempfile::tempdir().unwrap();
        let inst = DataDirInstaller::new(dir.path());
        inst.install_lunad(b"hello-lunad").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("bin/lunad")).unwrap(),
            b"hello-lunad"
        );
        inst.write_os_hash("abc123").unwrap();
        assert_eq!(inst.read_os_hash().as_deref(), Some("abc123"));

        assert_eq!(inst.read_feed_seen("luna", "stable"), None);
        inst.write_feed_seen("luna", "stable", "2026-10-12T14:03:00Z")
            .unwrap();
        inst.write_feed_seen("luna", "beta", "2026-10-14T00:00:00Z")
            .unwrap();
        let again = DataDirInstaller::new(dir.path());
        assert_eq!(
            again.read_feed_seen("luna", "stable").as_deref(),
            Some("2026-10-12T14:03:00Z")
        );
        assert_eq!(
            again.read_feed_seen("luna", "beta").as_deref(),
            Some("2026-10-14T00:00:00Z")
        );
    }

    #[test]
    fn settings_round_trip_through_db() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        assert!(load_settings(&conn).is_none());
        let settings = UpdateSettings {
            feed_url: "https://staging.feeds.test/feeds".into(),
            channel: "beta".into(),
            keys: vec!["RWnotarealkey".into()],
        };
        save_settings(&conn, &settings).unwrap();
        assert_eq!(load_settings(&conn).unwrap(), settings);
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
        let key = KeyPair::generate_unencrypted_keypair()
            .unwrap()
            .pk
            .to_base64();
        save_settings(
            &conn,
            &UpdateSettings {
                feed_url: "https://staging.feeds.test/feeds/".into(),
                channel: "beta".into(),
                keys: vec![key.clone()],
            },
        )
        .unwrap();
        let svc = UpdateService::from_db(&conn, dir.path());
        let got = svc.settings();
        assert_eq!(got.feed_url, "https://staging.feeds.test/feeds");
        assert_eq!(got.channel, "beta");
        assert_eq!(got.keys, vec![key]);
        assert!(!svc.using_default_keys());

        let conn2 = crate::db::open(&dir.path().join("luna2.db")).unwrap();
        let svc2 = UpdateService::from_db(&conn2, dir.path());
        let got2 = svc2.settings();
        assert_eq!(got2.feed_url, DEFAULT_FEED_URL);
        assert_eq!(got2.channel, "stable");
        assert!(svc2.using_default_keys());
    }

    #[test]
    fn validate_settings_rejects_bad_input() {
        let base = UpdateSettings {
            feed_url: "https://feeds.test/feeds".into(),
            channel: "stable".into(),
            keys: vec![],
        };
        assert!(validate_settings(&base).is_ok());
        let beta = UpdateSettings {
            channel: "beta".into(),
            ..base.clone()
        };
        assert!(validate_settings(&beta).is_ok());
        let nightly = UpdateSettings {
            channel: "nightly".into(),
            ..base.clone()
        };
        assert!(validate_settings(&nightly).is_err());
        let empty_channel = UpdateSettings {
            channel: "".into(),
            ..base.clone()
        };
        assert!(validate_settings(&empty_channel).is_err());
        let empty = UpdateSettings {
            feed_url: "".into(),
            ..base.clone()
        };
        assert!(validate_settings(&empty).is_err());
        let no_scheme = UpdateSettings {
            feed_url: "ftp://feeds.test".into(),
            ..base.clone()
        };
        assert!(validate_settings(&no_scheme).is_err());
        let bad_key = UpdateSettings {
            keys: vec!["not-a-key".into()],
            ..base.clone()
        };
        assert!(validate_settings(&bad_key).is_err());
        let private_host = UpdateSettings {
            feed_url: "https://192.168.1.10/feeds".into(),
            ..base.clone()
        };
        assert!(validate_settings(&private_host).is_err());
        // Plain http is allowed for a source on this machine/network only.
        for ok in ["http://127.0.0.1:3000/feeds", "http://192.168.1.10/feeds"] {
            let s = UpdateSettings {
                feed_url: ok.into(),
                ..base.clone()
            };
            assert!(validate_settings(&s).is_ok(), "{ok}");
        }
        let public_http = UpdateSettings {
            feed_url: "http://203.0.113.10/feeds".into(),
            ..base.clone()
        };
        assert!(validate_settings(&public_http).is_err());
        // A whole pub file (comment + key) is accepted, comment dropped.
        let real = KeyPair::generate_unencrypted_keypair()
            .unwrap()
            .pk
            .to_base64();
        let file = UpdateSettings {
            keys: vec![format!("untrusted comment: x\n{real}\n")],
            ..base
        };
        assert_eq!(validate_settings(&file).unwrap(), vec![real]);
    }

    #[test]
    fn custom_source_with_custom_key_installs() {
        // The acceptance case for pointing Luna at a staging feed.
        let (svc, inst) = Release::default().service();
        assert!(!svc.using_default_keys());
        svc.apply("0.1.0").unwrap();
        assert_eq!(*inst.lunad.lock().unwrap(), b"lunad-v0.4.0");
    }

    #[test]
    fn reconfigure_swaps_source_and_clears_cache() {
        let r = Release::default();
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        let body = r.feed_json().into_bytes();
        let sig = sign(&body, &sk);
        let beta_body = Release {
            channel: "beta",
            version: "0.5.0-beta.1",
            ..Release::default()
        }
        .feed_json()
        .into_bytes();
        let beta_sig = sign(&beta_body, &sk);
        let mut map = HashMap::new();
        map.insert(format!("{FEED}/luna/stable.json"), (200, body));
        map.insert(format!("{FEED}/luna/stable.json.minisig"), (200, sig));
        map.insert("http://other.test/luna/beta.json".into(), (200, beta_body));
        map.insert(
            "http://other.test/luna/beta.json.minisig".into(),
            (200, beta_sig),
        );
        let svc = UpdateService::with_keys(
            Box::new(MapHttp { map }),
            Box::new(Arc::new(RecInstaller::default())),
            FEED.into(),
            "stable".into(),
            vec![pk.to_base64()],
        );
        assert_eq!(svc.check("0.3.0", false).unwrap().latest_version, "0.4.0");
        // The hour-long cache holds that result.
        assert_eq!(svc.check("0.3.0", false).unwrap().latest_version, "0.4.0");
        svc.reconfigure(
            "http://other.test".into(),
            "beta".into(),
            vec![pk.to_base64()],
        );
        assert_eq!(
            svc.check("0.3.0", false).unwrap().latest_version,
            "0.5.0-beta.1"
        );
    }
}
