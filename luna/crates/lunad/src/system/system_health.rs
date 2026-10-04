//! Luna system health checks — the setup wizard's system check, the About
//! page's System Checks card, and the HDMI console's problem list.
//!
//! Every check lands as `passed`, `warning`, or `failed`. `failed` means Luna
//! can't safely keep files (it blocks setup); `warning` means one named
//! feature won't work (setup continues, the UI says what's missing).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Value, json};

use crate::drives::smart;
use crate::drives::summary;
use crate::net::NetworkStatus;
use crate::net::connect::ConnectStatus;

const MIN_FREE_BYTES: u64 = 512 * 1024 * 1024;

/// Seconds of slack before a clock earlier than the build counts as wrong —
/// covers build hosts with a slightly fast clock.
const CLOCK_BUILD_SLACK_SECS: i64 = 24 * 60 * 60;

pub const PASSED: &str = "passed";
pub const WARNING: &str = "warning";
pub const FAILED: &str = "failed";

#[derive(Debug, Clone, Serialize)]
pub struct HealthCheckResult {
    pub status: String,
    /// One sentence: the surface level of the row.
    pub message: String,
    /// The next level in: what still works, why, and what to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct HealthCheckSummary {
    pub total_checks: usize,
    pub passed: usize,
    pub warnings: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComprehensiveHealthResponse {
    pub status: String,
    pub timestamp: i64,
    pub overall_pass: bool,
    pub checks: HashMap<String, HealthCheckResult>,
    pub summary: HealthCheckSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightResponse {
    pub checks: HashMap<String, HealthCheckResult>,
    /// False only when a check `failed` — warnings never block setup.
    pub healthy: bool,
    pub timestamp: i64,
}

#[derive(Clone)]
pub struct HealthCache {
    inner: Arc<Mutex<HealthCacheInner>>,
}

struct HealthCacheInner {
    cached: Option<(Instant, ComprehensiveHealthResponse)>,
    refreshing: bool,
}

impl Default for HealthCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HealthCacheInner {
                cached: None,
                refreshing: false,
            })),
        }
    }
}

impl HealthCache {
    const TTL: Duration = Duration::from_secs(60);

    pub fn should_refresh(&self) -> bool {
        let guard = self.inner.lock().unwrap();
        match guard.cached.as_ref() {
            None => true,
            Some((at, _)) => at.elapsed() >= Self::TTL,
        }
    }

    pub fn get(&self) -> Option<ComprehensiveHealthResponse> {
        let guard = self.inner.lock().unwrap();
        guard.cached.as_ref().map(|(_, v)| v.clone())
    }

    pub fn set(&self, value: ComprehensiveHealthResponse) {
        let mut guard = self.inner.lock().unwrap();
        guard.cached = Some((Instant::now(), value));
        guard.refreshing = false;
    }

    pub fn mark_refreshing(&self) {
        self.inner.lock().unwrap().refreshing = true;
    }
}

/// The system clock as the checks see it.
#[derive(Debug, Clone, Copy)]
pub struct ClockReading {
    pub now_unix: i64,
    /// Kernel NTP status (chrony clears STA_UNSYNC once it has synced).
    /// `None` when the platform can't say.
    pub synced: Option<bool>,
}

impl ClockReading {
    pub fn live() -> Self {
        Self {
            now_unix: crate::db::now_unix(),
            synced: kernel_clock_synced(),
        }
    }
}

/// Everything the non-core checks read outside the DB. Gather it before
/// taking the DB lock — `ConnectService::status` reads connect.json.
#[derive(Debug, Clone)]
pub struct Probes {
    pub clock: ClockReading,
    /// `None` skips the network check (tests, non-Linux).
    pub network: Option<NetworkStatus>,
    /// Present only while a device token is on disk — Connect is opt-in.
    pub connect: Option<ConnectStatus>,
    pub usable_update_keys: usize,
    /// True while updates verify against the compiled-in LibreLoom release
    /// key. A custom source swaps the keys — flagged as a warning check.
    pub default_update_keys: bool,
    /// Booted from a Luna OS A/B slot — OS image updates apply here.
    pub on_luna_os: bool,
    /// Directories searched for helper programs (`$PATH`, same as `Command`).
    pub path_dirs: Vec<PathBuf>,
    /// The kernel's NTFS driver (`ntfs3`) is loaded, built in, or installed
    /// as a module — how Luna mounts NTFS drives.
    pub kernel_ntfs: bool,
    /// The Excalidraw editor chunk made it into the embedded web build.
    pub whiteboard_editor: bool,
    /// Excalidraw fonts made it into the embedded web build.
    pub whiteboard_fonts: bool,
}

impl Probes {
    pub fn gather(
        connect: &crate::net::connect::ConnectService,
        updates: &crate::system::updates::UpdateService,
    ) -> Self {
        let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
        let network = crate::net::read_status(Path::new("/sys/class/net"), &proc_route);
        let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
        Self {
            clock: ClockReading::live(),
            network: Some(network),
            connect: connect
                .is_connect_active()
                .then(|| connect.status_for(false)),
            usable_update_keys: updates.usable_key_count(),
            default_update_keys: updates.using_default_keys(),
            on_luna_os: cmdline
                .split_whitespace()
                .any(|t| t.starts_with("luna.slot=")),
            path_dirs: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            kernel_ntfs: kernel_has_ntfs(),
            whiteboard_editor: crate::system::staticweb::has_asset_named("excalidraw-", ".js"),
            whiteboard_fonts: crate::system::staticweb::has_files_under("excalidraw/fonts"),
        }
    }

    pub fn from_state(state: &crate::AppState) -> Self {
        Self::gather(&state.connect, &state.updates)
    }

    fn has_program(&self, name: &str) -> bool {
        self.path_dirs
            .iter()
            .any(|dir| is_executable(&dir.join(name)))
    }

    fn missing<'a>(&self, names: &[&'a str]) -> Vec<&'a str> {
        names
            .iter()
            .copied()
            .filter(|n| !self.has_program(n))
            .collect()
    }
}

#[derive(Default)]
struct Checks(HashMap<String, HealthCheckResult>);

impl HealthCheckResult {
    fn more(&mut self, text: impl Into<String>) {
        self.more = Some(text.into());
    }
}

impl Checks {
    fn add(
        &mut self,
        name: &str,
        category: &str,
        status: &str,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> &mut HealthCheckResult {
        self.0.insert(
            name.to_string(),
            HealthCheckResult {
                status: status.into(),
                message: message.into(),
                more: None,
                details,
                category: category.into(),
            },
        );
        self.0.get_mut(name).expect("just inserted")
    }

    fn into_response(self) -> PreflightResponse {
        let healthy = self.0.values().all(|c| c.status != FAILED);
        PreflightResponse {
            checks: self.0,
            healthy,
            timestamp: crate::db::now_unix(),
        }
    }
}

/// Checks that decide whether Luna can safely keep files: its database,
/// data and log folders, system disk space, and the clock. Cheap enough for
/// the HDMI console's 2-second loop (`thorough: false` skips the full
/// database scan).
pub fn run_core(
    data_dir: &Path,
    conn: &Connection,
    clock: ClockReading,
    thorough: bool,
) -> PreflightResponse {
    let mut checks = Checks::default();
    add_core_checks(&mut checks, data_dir, conn, clock, thorough);
    checks.into_response()
}

/// Every check that doesn't need a mounted drive — the setup wizard's list.
pub fn run_preflight(data_dir: &Path, conn: &Connection, probes: &Probes) -> PreflightResponse {
    let mut checks = Checks::default();
    add_core_checks(&mut checks, data_dir, conn, probes.clock, true);
    add_update_checks(&mut checks, probes);
    add_network_checks(&mut checks, probes);
    add_feature_checks(&mut checks, data_dir, probes);
    add_drive_tool_checks(&mut checks, probes);
    checks.into_response()
}

fn add_core_checks(
    checks: &mut Checks,
    data_dir: &Path,
    conn: &Connection,
    clock: ClockReading,
    thorough: bool,
) {
    match database_state(conn, thorough) {
        DatabaseState::Ok => {
            checks.add(
                "database",
                "system",
                PASSED,
                "Accounts, sharing, and settings are readable.",
                None,
            );
        }
        DatabaseState::Unreadable => checks
            .add(
                "database",
                "system",
                FAILED,
                "Signing in and sharing may not work.",
                None,
            )
            .more("Luna can't read its record of accounts, sharing, and settings. Try restarting Luna, and if this keeps happening, contact support."),
        DatabaseState::Damaged => checks
            .add(
                "database",
                "system",
                FAILED,
                "Signing in and sharing may not work.",
                None,
            )
            .more("Luna's record of accounts, sharing, and settings is damaged. The files on your drives aren't affected; contact support."),
    }

    if path_writable(data_dir) {
        checks.add(
            "data_path_writable",
            "storage",
            PASSED,
            "Luna can save to its data folder.",
            None,
        );
    } else {
        checks
            .add(
                "data_path_writable",
                "storage",
                FAILED,
                "Luna can't save accounts, settings, or sign-ins.",
                None,
            )
            .more("Luna can't write to its data folder, which can mean its system disk is full or failing. Contact support.");
    }

    if path_writable(&data_dir.join("logs")) {
        checks.add(
            "logs_path_writable",
            "storage",
            PASSED,
            "Luna can save its logs.",
            None,
        );
    } else {
        checks
            .add(
                "logs_path_writable",
                "storage",
                WARNING,
                "Luna can't save its logs.",
                None,
            )
            .more("Logs are Luna's record of what it did, used to figure out problems later. Everything else still works.");
    }

    let free = summary::disk_space(data_dir).map(|s| s.free_bytes);
    let details = free.map(|free| json!({ "free_bytes": free, "free_human": human_bytes(free) }));
    match free {
        Some(free) if free >= MIN_FREE_BYTES => {
            checks.add(
                "disk_space",
                "system",
                PASSED,
                format!("{} free on Luna's system disk.", human_bytes(free)),
                details,
            );
        }
        Some(free) => checks
            .add(
                "disk_space",
                "system",
                FAILED,
                "Luna is running out of room for accounts and settings.",
                details,
            )
            .more(format!("Only {} is free on Luna's system disk, where it keeps accounts and settings (your files are on your drives). Contact support.", human_bytes(free))),
        None => checks
            .add(
                "disk_space",
                "system",
                FAILED,
                "Luna can't tell if it has room for accounts and settings.",
                None,
            )
            .more("Luna couldn't read how much space is free on its system disk, where it keeps accounts and settings. Contact support."),
    }

    let build_unix: i64 = env!("LUNA_BUILD_UNIX").parse().unwrap_or(0);
    add_clock_check(checks, clock, build_unix);
}

enum DatabaseState {
    Ok,
    Unreadable,
    Damaged,
}

/// `luna.db` is small (users, shares, jobs — file indexes live on each
/// drive), so a full `quick_check` is cheap outside the console loop.
fn database_state(conn: &Connection, thorough: bool) -> DatabaseState {
    if conn
        .query_row("SELECT count(*) FROM meta", [], |r| r.get::<_, i64>(0))
        .is_err()
    {
        return DatabaseState::Unreadable;
    }
    if !thorough {
        return DatabaseState::Ok;
    }
    match conn.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0)) {
        Ok(result) if result == "ok" => DatabaseState::Ok,
        Ok(_) => DatabaseState::Damaged,
        Err(_) => DatabaseState::Unreadable,
    }
}

fn add_clock_check(checks: &mut Checks, clock: ClockReading, build_unix: i64) {
    if clock.now_unix < build_unix - CLOCK_BUILD_SLACK_SECS {
        checks
            .add(
                "clock",
                "system",
                FAILED,
                format!("The clock is wrong: it says {}.", ymd(clock.now_unix)),
                None,
            )
            .more("That's before this version of Luna was made, so new and changed files would get wrong dates, and updates and Luna Connect will likely fail. Luna sets its clock over the internet: check that your router or modem is online, then check again in a minute.");
        return;
    }
    match clock.synced {
        Some(false) => checks
            .add(
                "clock",
                "system",
                WARNING,
                "The clock may be off.",
                None,
            )
            .more("Luna sets its clock over the internet and hasn't managed to yet, so new and changed files may get wrong dates. Check that your router or modem is online, then check again in a minute."),
        Some(true) => {
            checks.add(
                "clock",
                "system",
                PASSED,
                "The clock is set over the internet.",
                None,
            );
        }
        None => {
            checks.add(
                "clock",
                "system",
                PASSED,
                format!("The clock says {}.", ymd(clock.now_unix)),
                None,
            );
        }
    }
}

fn add_update_checks(checks: &mut Checks, probes: &Probes) {
    if probes.usable_update_keys > 0 {
        checks.add(
            "update_signing",
            "system",
            PASSED,
            "Luna can confirm that updates really come from LibreLoom.",
            None,
        );
    } else {
        checks
            .add(
                "update_signing",
                "system",
                WARNING,
                "Luna can't install updates.",
                None,
            )
            .more("Luna checks every update with a signing key to prove it comes from LibreLoom, and it has no usable key. To fix this, go to Settings → About → Advanced → Update source → Edit update source, choose Use defaults, then Save changes.");
    }

    if !probes.default_update_keys {
        checks.add(
            "update_source",
            "system",
            WARNING,
            "Luna checks updates with a different signing key than the built-in one.",
            None,
        )
        .more("An Admin pointed updates at another project page in Settings → About → Advanced → Update source. Updates are only checked against the keys saved there — if that wasn't on purpose, choose Use defaults there, then Save changes.");
    }

    if probes.on_luna_os {
        let missing = probes.missing(&["grub-editenv", "findfs"]);
        if missing.is_empty() {
            checks.add(
                "os_update_tools",
                "system",
                PASSED,
                "Luna can install updates to its operating system.",
                None,
            );
        } else {
            checks
                .add(
                    "os_update_tools",
                    "system",
                    WARNING,
                    "Luna can't install updates to its operating system.",
                    Some(json!({ "missing": missing })),
                )
                .more("The operating system is the software Luna runs on, and a tool Luna needs to update it is missing. Updates that only change the Luna app still install.");
        }
    }
}

fn add_network_checks(checks: &mut Checks, probes: &Probes) {
    if let Some(net) = &probes.network {
        let (status, message, more) = if !net.ethernet_connected && !net.wifi_connected {
            (
                WARNING,
                "Luna isn't connected to your network.",
                Some("Plug it into your router or modem with the included RJ45 (ethernet) cable."),
            )
        } else if net.ipv4.is_empty() {
            (
                WARNING,
                "Luna isn't connected to your network yet.",
                Some(
                    "It's plugged in, but your router or modem hasn't given it an address. Wait a minute and check again; if it stays like this, restart your router or modem.",
                ),
            )
        } else if !net.has_default_route {
            (
                WARNING,
                "Luna can't reach the internet.",
                Some(
                    "Updates, setting the clock, and Luna Connect (remote access and cloud backup) need the internet. Luna still works on your home network; check that your router or modem is online.",
                ),
            )
        } else {
            (
                PASSED,
                "Connected to your router or modem, with a path to the internet.",
                None,
            )
        };
        let row = checks.add("network", "network", status, message, None);
        if let Some(more) = more {
            row.more(more);
        }
    }

    let Some(connect) = &probes.connect else {
        return;
    };
    if let Some(err) = &connect.device_token_error {
        checks
            .add(
                "connect",
                "network",
                WARNING,
                "Remote access and cloud backup don't work.",
                None,
            )
            .more(err.clone());
    } else if let Some(err) = &connect.connect_unreachable {
        checks
            .add(
                "connect",
                "network",
                WARNING,
                "Cloud backups can't upload right now.",
                None,
            )
            .more(format!(
                "{err} Changes made in Luna Connect won't reach this Luna until then."
            ));
    } else {
        checks.add(
            "connect",
            "network",
            PASSED,
            "Linked to Luna Connect.",
            None,
        );
    }

    let Some(hostname) = connect.hostname.as_deref().filter(|h| !h.is_empty()) else {
        return;
    };
    if let Some(err) = &connect.tunnel_error {
        checks
            .add(
                "remote_access",
                "network",
                WARNING,
                format!("Luna can't be opened at {hostname} from outside your home."),
                Some(json!({ "hostname": hostname })),
            )
            .more(format!("{err} Luna still works on your home network."));
    } else {
        checks.add(
            "remote_access",
            "network",
            PASSED,
            format!("Luna can be opened from anywhere at {hostname}."),
            Some(json!({ "hostname": hostname })),
        );
    }
}

/// EuroOffice pieces shared by every editor, then each editor's own engine.
const OFFICE_SHARED: &[&str] = &[
    "web-apps/apps/api/documents/api.js",
    "x2t/x2t.js",
    "x2t/x2t.wasm",
];
/// Each editor's engine, what it opens, and example file types.
const OFFICE_EDITORS: &[(&str, &str, &str)] = &[
    ("sdkjs/word/sdk-all-min.js", "documents", ".docx and .odt"),
    (
        "sdkjs/cell/sdk-all-min.js",
        "spreadsheets",
        ".xlsx and .ods",
    ),
    (
        "sdkjs/slide/sdk-all-min.js",
        "presentations",
        ".pptx and .odp",
    ),
];

const FILES_KEPT: &str = "Your files are still on your drives and can be downloaded.";

fn add_feature_checks(checks: &mut Checks, data_dir: &Path, probes: &Probes) {
    let office = data_dir.join("eurooffice");
    let all_nouns: Vec<&str> = OFFICE_EDITORS.iter().map(|(_, noun, _)| *noun).collect();
    let mut missing: Vec<&str> = OFFICE_SHARED
        .iter()
        .copied()
        .filter(|rel| !office.join(rel).is_file())
        .collect();
    if !office.join("fonts").is_dir() {
        missing.push("fonts/");
    }
    let broken: Vec<(&str, &str, &str)> = OFFICE_EDITORS
        .iter()
        .copied()
        .filter(|(rel, _, _)| !office.join(rel).is_file())
        .collect();
    missing.extend(broken.iter().map(|(rel, _, _)| *rel));
    let shared_broken = !office.is_dir() || missing.len() > broken.len();
    if missing.is_empty() {
        checks.add(
            "office_pack",
            "features",
            PASSED,
            "Documents, spreadsheets, and presentations open and can be edited.",
            None,
        );
    } else if shared_broken || broken.len() == OFFICE_EDITORS.len() {
        let why = if office.is_dir() {
            "is missing parts"
        } else {
            "isn't installed"
        };
        checks
            .add(
                "office_pack",
                "features",
                WARNING,
                format!("Luna can't open or edit {}.", or_list(&all_nouns)),
                Some(json!({ "missing": missing })),
            )
            .more(format!(
                "The office pack Luna uses for .docx, .xlsx, and .pptx files {why}. {FILES_KEPT}"
            ));
    } else {
        let nouns: Vec<&str> = broken.iter().map(|(_, noun, _)| *noun).collect();
        let exts: Vec<&str> = broken.iter().map(|(_, _, ext)| *ext).collect();
        let working: Vec<&str> = all_nouns
            .iter()
            .copied()
            .filter(|n| !nouns.contains(n))
            .collect();
        checks
            .add(
                "office_pack",
                "features",
                WARNING,
                format!("Luna can't open or edit {}.", or_list(&nouns)),
                Some(json!({ "missing": missing })),
            )
            .more(format!(
                "Part of the office pack Luna uses for {} files is missing. {} still open, and every file can still be downloaded.",
                exts.join(" or "),
                upper_first(&join_list(&working)),
            ));
    }

    let drawio = data_dir.join("drawio");
    let marker_ok = std::fs::read_to_string(drawio.join("pack.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .is_some_and(|v| v.get("pack").and_then(Value::as_str) == Some("luna-drawio"));
    if marker_ok && drawio.join("index.html").is_file() {
        checks.add(
            "diagram_pack",
            "features",
            PASSED,
            "Diagrams (.drawio files) can be opened and edited.",
            None,
        );
    } else {
        checks
            .add(
                "diagram_pack",
                "features",
                WARNING,
                "Luna can't open or edit diagrams.",
                None,
            )
            .more(format!(
                "Diagrams (.drawio files) need the diagram pack, which is missing. {FILES_KEPT}"
            ));
    }

    match (probes.whiteboard_editor, probes.whiteboard_fonts) {
        (true, true) => {
            checks.add(
                "whiteboard",
                "features",
                PASSED,
                "Whiteboards (.excalidraw files) can be opened and edited.",
                None,
            );
        }
        (true, false) => checks
            .add(
                "whiteboard",
                "features",
                WARNING,
                "Whiteboard text shows in a plain font.",
                None,
            )
            .more("This version of Luna was built without the hand-drawn whiteboard fonts. Whiteboards still open and can be edited."),
        (false, _) => checks
            .add(
                "whiteboard",
                "features",
                WARNING,
                "Luna can't open or edit whiteboards.",
                None,
            )
            .more(format!("This version of Luna was built without the editor for whiteboards (.excalidraw files). {FILES_KEPT}")),
    }

    let missing = probes.missing(&["ffmpeg", "ffprobe"]);
    let effect = match missing.as_slice() {
        [] => None,
        ["ffmpeg"] => Some((
            "Videos get no preview pictures.",
            "Photos shows a preview picture for each video, made with a video tool that's missing.",
        )),
        ["ffprobe"] => Some((
            "Photos can't show how long videos are.",
            "Luna reads each video's length with a video tool that's missing.",
        )),
        _ => Some((
            "Videos get no preview pictures or length.",
            "Photos shows these for each video, made with video tools that are missing.",
        )),
    };
    match effect {
        None => {
            checks.add(
                "video_tools",
                "features",
                PASSED,
                "Videos get preview pictures in Photos.",
                None,
            );
        }
        Some((effect, why)) => checks
            .add(
                "video_tools",
                "features",
                WARNING,
                effect,
                Some(json!({ "missing": missing })),
            )
            .more(format!("{why} Videos can still be played and downloaded.")),
    }

    if probes.has_program("heif-dec") || probes.has_program("heif-convert") {
        checks.add(
            "heic_tools",
            "features",
            PASSED,
            "iPhone photos show in Photos and Files.",
            None,
        );
    } else {
        checks
            .add(
                "heic_tools",
                "features",
                WARNING,
                "Luna can't show most iPhone photos.",
                Some(json!({ "missing": ["heif-dec", "heif-convert"] })),
            )
            .more("iPhones save photos as HEIC (.heic files), and the tool Luna uses to show them is missing. The photos are still on your drives and can be downloaded.");
    }
}

fn add_drive_tool_checks(checks: &mut Checks, probes: &Probes) {
    let missing = probes.missing(&["blkid", "mount", "umount"]);
    let cant_add = missing.iter().any(|p| *p != "umount");
    let cant_eject = missing.contains(&"umount");
    if missing.is_empty() {
        checks.add(
            "drive_tools",
            "drives",
            PASSED,
            "Luna can add and eject drives.",
            None,
        );
    } else {
        let message = match (cant_add, cant_eject) {
            (true, true) => "Luna can't add or eject drives.",
            (true, false) => "Luna can't add drives.",
            _ => "Luna can't eject drives.",
        };
        let row = checks.add(
            "drive_tools",
            "drives",
            WARNING,
            message,
            Some(json!({ "missing": missing })),
        );
        let why: Vec<&str> = missing
            .iter()
            .filter_map(|p| match *p {
                "blkid" => Some("Luna can't tell how drives are formatted."),
                "mount" => Some("Luna can't open drives or show their files."),
                _ => None,
            })
            .collect();
        if why.is_empty() {
            row.more(
                "Luna can't disconnect drives safely, so only unplug a drive while Luna is off.",
            );
        } else {
            row.more(why.join(" "));
        }
    }

    // NTFS mounts use the kernel's ntfs3 driver (see drives::mount).
    if probes.kernel_ntfs {
        checks.add(
            "ntfs_support",
            "drives",
            PASSED,
            "Luna can open drives formatted as NTFS, the format Windows uses for its own drives.",
            None,
        );
    } else {
        checks
            .add(
                "ntfs_support",
                "drives",
                WARNING,
                "Luna can't open drives formatted as NTFS.",
                Some(json!({ "missing": ["ntfs3"] })),
            )
            .more("NTFS is the format Windows uses for its own drives and often for external hard drives. Drives in other formats, like exFAT or FAT32, still work.");
    }

    let mut missing = probes.missing(&["wipefs", "sfdisk"]);
    if !probes.has_program("mkfs.exfat") && !probes.has_program("mkfs.vfat") {
        missing.push("mkfs.exfat");
    }
    if missing.is_empty() {
        checks.add(
            "erase_tools",
            "drives",
            PASSED,
            "Luna can erase a drive while adding it.",
            None,
        );
    } else {
        checks
            .add(
                "erase_tools",
                "drives",
                WARNING,
                "Luna can't erase drives.",
                Some(json!({ "missing": missing })),
            )
            .more("Erasing clears a drive and formats it for Luna when you add it, and a tool for that is missing. Drives you add without erasing still work.");
    }

    if probes.has_program("smartctl") {
        checks.add(
            "smart_tool",
            "drives",
            PASSED,
            "Luna can read health reports from hard drives.",
            None,
        );
    } else {
        checks
            .add(
                "smart_tool",
                "drives",
                WARNING,
                "Luna can't warn you when a hard drive reports a problem.",
                Some(json!({ "missing": ["smartctl"] })),
            )
            .more("Hard drives keep a health report that can show trouble before files are lost, and the tool Luna reads it with is missing. SSDs and USB sticks aren't affected.");
    }

    if probes.has_program("fstrim") {
        checks.add(
            "trim_tool",
            "drives",
            PASSED,
            "Luna can run its weekly SSD (solid-state drive) upkeep.",
            None,
        );
    } else {
        checks
            .add(
                "trim_tool",
                "drives",
                WARNING,
                "Luna can't do its weekly SSD upkeep.",
                Some(json!({ "missing": ["fstrim"] })),
            )
            .more("SSDs (solid-state drives) need to be told which space is free, or some get slower over time. Hard drives aren't affected.");
    }
}

/// Setup checks plus per-drive read/write probes and SMART reads — callers
/// must not hold the DB lock.
pub fn finish_comprehensive(
    preflight: PreflightResponse,
    drives: Vec<crate::db::DriveRow>,
) -> ComprehensiveHealthResponse {
    let mut checks = Checks(preflight.checks);

    for drive in drives {
        if drive.state == "missing" || drive.state == "ejected" {
            continue;
        }
        let label = if drive.label.trim().is_empty() {
            "Drive".into()
        } else {
            drive.label.clone()
        };
        let rw_name = format!("drive_{}_read_write", drive.id);
        let smart_name = format!("drive_{}_smart", drive.id);
        let drive_details = json!({ "drive_id": drive.id, "drive_label": label });

        if drive.state == "readonly" || drive.mount_point.is_empty() {
            checks
                .add(
                    &rw_name,
                    "drives",
                    FAILED,
                    format!("Luna can't save new files to {label}."),
                    Some(drive_details),
                )
                .more("The drive is read-only, or Luna hasn't opened it.");
        } else if crate::drives::probe_writable(&PathBuf::from(&drive.mount_point)).is_ok() {
            checks.add(
                &rw_name,
                "drives",
                PASSED,
                format!("{label} passed a read-and-write test."),
                Some(drive_details),
            );
        } else {
            checks
                .add(
                    &rw_name,
                    "drives",
                    FAILED,
                    format!("New files may not save to {label}."),
                    Some(drive_details),
                )
                .more("Luna tried to save a test file there and couldn't.");
        }

        if smart::applicable(&drive.device) {
            let health = smart::read(&drive.device);
            if !health.available {
                continue;
            }
            let temp = health
                .temperature_c
                .map(|temp| format!("It's about {temp}°C."));
            if health.overall == "passed" {
                let worn = health.reallocated_sectors.unwrap_or(0) > 0;
                // Worn drives keep the action on the surface — it's the
                // part the person must not miss.
                let msg = if worn {
                    format!(
                        "{label} has repaired some worn spots. Copy important files off it soon."
                    )
                } else {
                    format!("{label} reported no hardware problems.")
                };
                let row = checks.add(
                    &smart_name,
                    "drives",
                    PASSED,
                    msg,
                    Some(json!({
                        "drive_id": drive.id,
                        "drive_label": label,
                        "temperature_c": health.temperature_c,
                        "reallocated_sectors": health.reallocated_sectors,
                    })),
                );
                if let Some(temp) = temp {
                    row.more(temp);
                }
            } else {
                checks.add(
                    &smart_name,
                    "drives",
                    FAILED,
                    format!(
                        "{label} reported a hardware problem. Copy your files somewhere else soon."
                    ),
                    Some(json!({
                        "drive_id": drive.id,
                        "drive_label": label,
                        "overall": health.overall,
                    })),
                );
            }
        }
    }

    let mut summary = HealthCheckSummary::default();
    for check in checks.0.values() {
        summary.total_checks += 1;
        match check.status.as_str() {
            PASSED => summary.passed += 1,
            WARNING => summary.warnings += 1,
            _ => summary.failed += 1,
        }
    }
    let overall_pass = summary.failed == 0;
    ComprehensiveHealthResponse {
        status: if overall_pass {
            "healthy".into()
        } else {
            "unhealthy".into()
        },
        timestamp: crate::db::now_unix(),
        overall_pass,
        checks: checks.0,
        summary,
    }
}

fn path_writable(path: &Path) -> bool {
    let _ = std::fs::create_dir_all(path);
    crate::drives::probe_writable(path).is_ok()
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `mount -t ntfs` autoloads `ntfs3` (it registers the `ntfs` alias), so a
/// module on disk counts as well as one already in `/proc/filesystems`.
fn kernel_has_ntfs() -> bool {
    let loaded = std::fs::read_to_string("/proc/filesystems").unwrap_or_default();
    if loaded
        .lines()
        .any(|l| matches!(l.split_whitespace().last(), Some("ntfs3" | "ntfs")))
    {
        return true;
    }
    let Ok(release) = std::fs::read_to_string("/proc/sys/kernel/osrelease") else {
        return false;
    };
    let modules = Path::new("/lib/modules").join(release.trim());
    ["modules.builtin", "modules.dep"].iter().any(|f| {
        std::fs::read_to_string(modules.join(f)).is_ok_and(|s| s.contains("/ntfs3/ntfs3.ko"))
    })
}

#[cfg(target_os = "linux")]
fn kernel_clock_synced() -> Option<bool> {
    // SAFETY: modes = 0 makes adjtimex read-only; it only fills `tx`.
    let mut tx: libc::timex = unsafe { std::mem::zeroed() };
    let state = unsafe { libc::adjtimex(&mut tx) };
    (state >= 0).then_some(state != libc::TIME_ERROR)
}

#[cfg(not(target_os = "linux"))]
fn kernel_clock_synced() -> Option<bool> {
    None
}

/// "a, b, and c" — capitalized as given.
fn join_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [a, b] => format!("{a} and {}", lower_first(b)),
        [rest @ .., last] => {
            let head: Vec<String> = rest
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    if i == 0 {
                        (*s).to_string()
                    } else {
                        lower_first(s)
                    }
                })
                .collect();
            format!("{}, and {}", head.join(", "), lower_first(last))
        }
    }
}

/// "a, b, or c" — for things that can't be done.
fn or_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [a, b] => format!("{a} or {b}"),
        [rest @ .., last] => format!("{}, or {last}", rest.join(", ")),
    }
}

fn upper_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `YYYY-MM-DD` (UTC) for a unix timestamp — civil-from-days, no date crate.
fn ymd(unix: i64) -> String {
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn human_bytes(bytes: u64) -> String {
    const KB: u64 = 1000;
    const MB: u64 = KB * 1000;
    const GB: u64 = MB * 1000;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.0} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_PROGRAMS: &[&str] = &[
        "ffmpeg",
        "ffprobe",
        "heif-dec",
        "blkid",
        "mount",
        "umount",
        "wipefs",
        "sfdisk",
        "mkfs.exfat",
        "smartctl",
        "fstrim",
        "grub-editenv",
        "findfs",
    ];

    fn fake_bin(dir: &Path, names: &[&str]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for name in names {
            let p = bin.join(name);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        bin
    }

    fn install_packs(data_dir: &Path) {
        let office = data_dir.join("eurooffice");
        for rel in OFFICE_SHARED
            .iter()
            .chain(OFFICE_EDITORS.iter().map(|(r, _, _)| r))
        {
            let p = office.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        std::fs::create_dir_all(office.join("fonts")).unwrap();
        let drawio = data_dir.join("drawio");
        std::fs::create_dir_all(&drawio).unwrap();
        std::fs::write(drawio.join("pack.json"), r#"{"pack":"luna-drawio"}"#).unwrap();
        std::fs::write(drawio.join("index.html"), "x").unwrap();
    }

    fn healthy_probes(path_dir: PathBuf) -> Probes {
        Probes {
            clock: ClockReading {
                now_unix: crate::db::now_unix(),
                synced: Some(true),
            },
            network: Some(NetworkStatus {
                ethernet_connected: true,
                wifi_interface: None,
                wifi_connected: false,
                has_default_route: true,
                ipv4: vec!["192.168.1.20".into()],
                interfaces: vec![],
            }),
            connect: None,
            usable_update_keys: 1,
            default_update_keys: true,
            on_luna_os: true,
            path_dirs: vec![path_dir],
            kernel_ntfs: true,
            whiteboard_editor: true,
            whiteboard_fonts: true,
        }
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn preflight_passes_everything_when_installed() {
        let (dir, conn) = setup();
        install_packs(dir.path());
        let probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        let resp = run_preflight(dir.path(), &conn, &probes);
        assert!(resp.healthy);
        let not_passed: Vec<_> = resp
            .checks
            .iter()
            .filter(|(_, c)| c.status != PASSED)
            .collect();
        assert!(not_passed.is_empty(), "{not_passed:?}");
        assert!(!resp.checks.contains_key("api_server"));
        assert!(!resp.checks.contains_key("database_writable"));
        assert!(!resp.checks.contains_key("connect"), "Connect is opt-in");
    }

    #[test]
    fn missing_add_ons_and_programs_warn_without_blocking_setup() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), &[]));
        probes.whiteboard_fonts = false;
        probes.kernel_ntfs = false;
        let resp = run_preflight(dir.path(), &conn, &probes);
        assert!(resp.healthy, "warnings must not block setup");
        for name in [
            "office_pack",
            "diagram_pack",
            "whiteboard",
            "video_tools",
            "heic_tools",
            "drive_tools",
            "ntfs_support",
            "erase_tools",
            "smart_tool",
            "trim_tool",
            "os_update_tools",
        ] {
            assert_eq!(resp.checks[name].status, WARNING, "{name}");
        }
        assert_eq!(
            resp.checks["office_pack"].message,
            "Luna can't open or edit documents, spreadsheets, or presentations."
        );
    }

    #[test]
    fn office_pack_names_only_the_broken_editor() {
        let (dir, conn) = setup();
        install_packs(dir.path());
        std::fs::remove_file(dir.path().join("eurooffice/sdkjs/cell/sdk-all-min.js")).unwrap();
        let probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        let office = |probes: &Probes| {
            run_preflight(dir.path(), &conn, probes)
                .checks
                .remove("office_pack")
                .unwrap()
        };
        let row = office(&probes);
        assert_eq!(row.message, "Luna can't open or edit spreadsheets.");
        let more = row.more.unwrap();
        assert!(more.contains(".xlsx and .ods"), "{more}");
        assert!(
            more.contains("Documents and presentations still open"),
            "{more}"
        );

        std::fs::remove_file(dir.path().join("eurooffice/sdkjs/slide/sdk-all-min.js")).unwrap();
        assert_eq!(
            office(&probes).message,
            "Luna can't open or edit spreadsheets or presentations."
        );

        std::fs::remove_file(dir.path().join("eurooffice/x2t/x2t.wasm")).unwrap();
        assert_eq!(
            office(&probes).message,
            "Luna can't open or edit documents, spreadsheets, or presentations.",
            "shared piece breaks all three"
        );
    }

    #[test]
    fn video_message_names_the_missing_half() {
        let (dir, conn) = setup();
        let probes = healthy_probes(fake_bin(dir.path(), &["ffmpeg"]));
        let check = &run_preflight(dir.path(), &conn, &probes).checks["video_tools"];
        assert_eq!(check.status, WARNING);
        assert!(
            check
                .message
                .starts_with("Photos can't show how long videos are.")
        );
    }

    #[test]
    fn whiteboard_without_editor_says_files_cant_open() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        probes.whiteboard_editor = false;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["whiteboard"];
        assert_eq!(check.status, WARNING);
        assert_eq!(check.message, "Luna can't open or edit whiteboards.");

        probes.whiteboard_editor = true;
        probes.whiteboard_fonts = false;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["whiteboard"];
        assert_eq!(check.status, WARNING);
        assert!(check.message.contains("plain font"));
    }

    #[test]
    fn ntfs_follows_the_kernel_driver() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        let check = &run_preflight(dir.path(), &conn, &probes).checks["ntfs_support"];
        assert_eq!(check.status, PASSED);

        probes.kernel_ntfs = false;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["ntfs_support"];
        assert_eq!(check.status, WARNING);
        assert!(check.more.as_deref().unwrap().contains("exFAT"));
    }

    #[test]
    fn surface_messages_are_one_sentence() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), &[]));
        probes.kernel_ntfs = false;
        probes.whiteboard_editor = false;
        probes.usable_update_keys = 0;
        probes.network.as_mut().unwrap().has_default_route = false;
        for (name, check) in run_preflight(dir.path(), &conn, &probes).checks {
            assert!(
                !check.message.trim_end_matches('.').contains(". "),
                "{name}: {}",
                check.message
            );
            if check.status != PASSED {
                assert!(check.more.is_some(), "{name} has nothing one step in");
            }
        }
    }

    #[test]
    fn os_update_tools_only_checked_on_luna_os() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), &[]));
        probes.on_luna_os = false;
        let resp = run_preflight(dir.path(), &conn, &probes);
        assert!(!resp.checks.contains_key("os_update_tools"));
    }

    #[test]
    fn unusable_update_keys_warn() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        probes.usable_update_keys = 0;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["update_signing"];
        assert_eq!(check.status, WARNING);
    }

    #[test]
    fn non_default_update_keys_warn() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        probes.default_update_keys = false;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["update_source"];
        assert_eq!(check.status, WARNING);
        assert!(check.more.is_some());
    }

    #[test]
    fn clock_before_build_fails_and_unsynced_warns() {
        let clock = |now_unix, synced| {
            let mut checks = Checks::default();
            add_clock_check(
                &mut checks,
                ClockReading { now_unix, synced },
                1_700_000_000,
            );
            checks.0.remove("clock").unwrap()
        };
        let row = clock(0, Some(true));
        assert_eq!(row.status, FAILED);
        assert!(row.message.contains("1970-01-01"), "{}", row.message);
        assert!(row.more.is_some());

        assert_eq!(clock(1_700_000_000, Some(false)).status, WARNING);
        assert_eq!(
            clock(1_700_000_000 - 3600, None).status,
            PASSED,
            "an hour of build-host skew is fine"
        );
    }

    #[test]
    fn network_without_route_warns() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        probes.network.as_mut().unwrap().has_default_route = false;
        let check = &run_preflight(dir.path(), &conn, &probes).checks["network"];
        assert_eq!(check.status, WARNING);
        assert!(check.message.contains("can't reach the internet"));
    }

    #[test]
    fn connect_problems_say_what_stops_working() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        let svc = crate::net::connect::ConnectService::new(dir.path(), None);
        let mut status = svc.status();
        status.connect_active = true;
        status.hostname = Some("max.luna.servers.libreloom.org".into());
        status.tunnel_error = Some("Luna could not start remote access.".into());
        probes.connect = Some(status);
        let resp = run_preflight(dir.path(), &conn, &probes);
        assert_eq!(resp.checks["connect"].status, PASSED);
        let remote = &resp.checks["remote_access"];
        assert_eq!(remote.status, WARNING);
        assert!(
            remote
                .message
                .contains("at max.luna.servers.libreloom.org from outside")
        );
    }

    #[test]
    fn damaged_database_fails() {
        let (dir, conn) = setup();
        conn.execute_batch("DROP TABLE meta").unwrap();
        let resp = run_core(dir.path(), &conn, ClockReading::live(), false);
        assert!(!resp.healthy);
        assert_eq!(resp.checks["database"].status, FAILED);
    }

    #[test]
    fn ymd_formats_known_dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(951_782_400), "2000-02-29");
        assert_eq!(ymd(1_790_467_200), "2026-09-27");
    }

    #[test]
    fn join_list_reads_naturally() {
        assert_eq!(join_list(&["Docs"]), "Docs");
        assert_eq!(join_list(&["Docs", "Sheets"]), "Docs and sheets");
        assert_eq!(
            join_list(&["Docs", "Sheets", "Slides"]),
            "Docs, sheets, and slides"
        );
    }

    fn insert_drive(
        conn: &Connection,
        id: &str,
        label: &str,
        state: &str,
        fs: &str,
        dev: &str,
        mount: &str,
    ) {
        let now = crate::db::now_unix();
        conn.execute(
            "INSERT INTO drives (id, label, state, fs_type, device, mount_point, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, label, state, fs, dev, mount, now, now],
        )
        .unwrap();
    }

    fn comprehensive(dir: &Path, conn: &Connection) -> ComprehensiveHealthResponse {
        let probes = healthy_probes(fake_bin(dir, ALL_PROGRAMS));
        install_packs(dir);
        let preflight = run_preflight(dir, conn, &probes);
        finish_comprehensive(preflight, crate::db::list_drives(conn).unwrap())
    }

    #[test]
    fn comprehensive_skips_smart_for_non_hdd() {
        let (dir, conn) = setup();
        insert_drive(
            &conn,
            "usb1",
            "General UDisk",
            "mounted",
            "vfat",
            "nvme0n1",
            "/mnt/usb",
        );
        let resp = comprehensive(dir.path(), &conn);
        assert!(
            !resp.checks.contains_key("drive_usb1_smart"),
            "USB/flash drives must not get a SMART row"
        );
    }

    #[test]
    fn comprehensive_marks_readonly_drive_failed() {
        let (dir, conn) = setup();
        insert_drive(&conn, "d1", "Photos", "readonly", "ext4", "sda1", "");
        let resp = comprehensive(dir.path(), &conn);
        assert!(!resp.overall_pass);
        assert_eq!(resp.checks["drive_d1_read_write"].status, FAILED);
    }

    #[test]
    fn comprehensive_counts_warnings_separately() {
        let (dir, conn) = setup();
        let mut probes = healthy_probes(fake_bin(dir.path(), ALL_PROGRAMS));
        probes.whiteboard_fonts = false;
        install_packs(dir.path());
        let resp = finish_comprehensive(run_preflight(dir.path(), &conn, &probes), vec![]);
        assert!(resp.overall_pass, "a warning is not a failure");
        assert_eq!(resp.summary.warnings, 1);
        assert_eq!(resp.summary.failed, 0);
        assert_eq!(
            resp.summary.passed + resp.summary.warnings,
            resp.summary.total_checks
        );
    }

    #[test]
    fn comprehensive_omits_smart_check_when_unavailable() {
        let (dir, conn) = setup();
        let mount = dir.path().to_str().unwrap().to_string();
        insert_drive(
            &conn,
            "d1",
            "UDisk",
            "ready",
            "vfat",
            "nonexistent_dev",
            &mount,
        );
        let resp = comprehensive(dir.path(), &conn);
        assert!(!resp.checks.contains_key("drive_d1_smart"));
    }
}
