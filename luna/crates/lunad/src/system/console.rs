//! HDMI / local-console status for Ethernet-only setup.
//!
//! `luna-console` owns tty1 (status screen + login). lunad writes the same
//! help into `{data_dir}/issue` so the screen stays live (network, storage,
//! drives, Connect / device token).
//!
//! The text is rebuilt when something it shows changes: a link, address or
//! route change (rtnetlink), a row in the tables it reads (SQLite update
//! hook), or a Connect status change ([`ConnectShown`]). Anything that only
//! changes with time (disk space, "not backed up in a day") is
//! caught by the [`HEARTBEAT_SECS`] look. luna-console tells whether lunad
//! is running from the lock lunad holds ([`ALIVE_LOCK_FILE`]); the file's
//! mtime only backs that up for a lunad that runs but stopped looking.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const BANNER_OK: &str = "Luna is running. Open it from a browser.";

pub const BANNER_PROBLEMS: &str = "Luna needs attention. Check the notes below.";

pub const ISSUE_FILE: &str = "issue";

/// The slowest lunad looks again with nothing reported: it rebuilds the text
/// and, when nothing changed, only touches the file's mtime. Liveness comes
/// from [`ALIVE_LOCK_FILE`], so this only bounds how late text that changes
/// with time alone (disk space, "not backed up in a day") can be (D3).
pub const HEARTBEAT_SECS: u64 = 30 * 60;

/// How long after the last issue write before luna-console warns that lunad
/// may not be updating the screen, even though lunad still holds its lock (a
/// lunad that hangs). A lunad that is not running shows the note at once.
///
/// lunad rewrites (or touches) `{data_dir}/issue` on every look, at least every
/// [`HEARTBEAT_SECS`], even when the text is unchanged. Two missed heartbeats
/// plus slack, so one slow look on a busy box doesn't show the note.
pub const STALE_SECS: u64 = 2 * HEARTBEAT_SECS + 120;

/// lunad holds an exclusive `flock` on this file, next to the issue file, for
/// as long as it runs; the kernel drops the lock when lunad exits for any
/// reason. luna-console tests it instead of waiting for the mtime to age.
pub const ALIVE_LOCK_FILE: &str = "lunad.lock";
const _: () = assert!(STALE_SECS > 2 * HEARTBEAT_SECS);

/// Without kernel network events (no netlink), look this often instead.
const FALLBACK_LOOK: Duration = Duration::from_secs(10);

/// Bursts (a DHCP lease adds an address, then a route; a backup updates its
/// row) collapse into at most one look per this long.
const MIN_GAP: Duration = Duration::from_secs(2);

pub const STALE_NOTE_LINE1: &str =
    "  Note: this status is not updating. Luna may still be starting,";
pub const STALE_NOTE_LINE2: &str =
    "  or the Luna service needs a moment. You can still log in below.";

/// True when an issue file exists but has not been rewritten recently.
///
/// Missing file is not stale — luna-console already shows a "starting" banner.
pub fn is_issue_stale(mtime: Option<SystemTime>) -> bool {
    let Some(mtime) = mtime else {
        return false;
    };
    match mtime.elapsed() {
        Ok(elapsed) => elapsed > Duration::from_secs(STALE_SECS),
        // Clock skew (mtime in the future): treat as fresh.
        Err(_) => false,
    }
}

/// The liveness lock that goes with the issue file at `issue`.
pub fn alive_lock_path(issue: &Path) -> PathBuf {
    issue.with_file_name(ALIVE_LOCK_FILE)
}

/// Take lunad's liveness lock. Keep the returned file open while lunad runs.
/// `None` when it can't be taken (luna-console then goes by the mtime alone).
pub fn hold_alive_lock(data_dir: &Path) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(data_dir.join(ALIVE_LOCK_FILE))
        .ok()?;
    // luna-console takes a shared lock for an instant each time it looks
    // (every 250 ms), so try for a second before giving up.
    for _ in 0..40 {
        // SAFETY: flock on a file descriptor this function owns.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Some(file);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    None
}

/// Whether a lunad holds the lock at `lock`. `None` when that can't be told:
/// no lock file (a lunad from before the lock), or it can't be opened.
pub fn lunad_running(lock: &Path) -> Option<bool> {
    use std::os::fd::AsRawFd;
    let file = std::fs::File::open(lock).ok()?;
    // SAFETY: flock on a file descriptor this function owns; closing the
    // file below releases a lock taken here.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0 {
        return Some(false);
    }
    (std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)).then_some(true)
}

/// What luna-console shows: the issue file at `issue` (last written at
/// `mtime`) is out of date because lunad is not running, or because it has
/// not looked for [`STALE_SECS`]. A missing file is not stale.
pub fn issue_stale(issue: &Path, mtime: Option<SystemTime>) -> bool {
    if mtime.is_none() {
        return false;
    }
    lunad_running(&alive_lock_path(issue)) == Some(false) || is_issue_stale(mtime)
}

#[derive(Debug, Clone, Default)]
pub struct ConsoleSnapshot {
    pub ipv4: Vec<String>,
    pub cable_in: bool,
    pub has_default_route: bool,
    pub device_code: Option<String>,
    pub connect_hostname: Option<String>,
    /// User-facing problems, highest priority first. Empty means healthy.
    pub problems: Vec<String>,
}

pub fn issue_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ISSUE_FILE)
}

/// Admin-set names, drive labels and remote hostnames reach the HDMI console
/// through the issue file, which `luna-console` writes to the terminal as-is.
/// Drop control characters so nobody can plant a cursor move, clear-screen or
/// other escape sequence in a label.
fn console_safe(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

pub fn help_text(snap: &ConsoleSnapshot) -> String {
    help_lines(snap).join("\n")
}

pub fn help_lines(snap: &ConsoleSnapshot) -> Vec<String> {
    let banner = if snap.problems.is_empty() {
        BANNER_OK
    } else {
        BANNER_PROBLEMS
    };
    let mut lines = vec![
        String::new(),
        "============================================================".into(),
        format!("  {banner}"),
        "============================================================".into(),
        String::new(),
    ];

    if !snap.problems.is_empty() {
        lines.push("  What's wrong:".into());
        for problem in &snap.problems {
            lines.extend(wrap_indent(&console_safe(problem), "  • ", 60));
        }
        lines.push(String::new());
    }

    // Network / how to open Luna — always useful, even alongside problems.
    if snap.cable_in && snap.ipv4.is_empty() {
        lines.push("  Cable is in. Waiting for an address from your router or modem.".into());
        lines.push("  Keep the included RJ45 (ethernet) cable plugged into it.".into());
    } else if !snap.cable_in {
        lines.push("  Plug the included RJ45 (ethernet) cable from Luna".into());
        lines.push("  into your router or modem.".into());
    }
    let token_problem = snap.problems.iter().any(|p| {
        p.contains("device token") || p.contains("Device token") || p.contains("Settings → About")
    });

    if !snap.ipv4.is_empty() && snap.cable_in && !snap.has_default_route {
        lines.push("  Luna has an address but can't reach the internet.".into());
        lines.push("  Make sure your router or modem is online, then wait a moment.".into());
    }

    // How to open Luna: Everywhere (when remote is configured), then local network.
    let show_remote = !token_problem && snap.connect_hostname.is_some();
    let show_home = !snap.ipv4.is_empty() || show_remote;
    if show_remote && let Some(host) = &snap.connect_hostname {
        lines.push("  Links that work from anywhere:".into());
        lines.push(format!("    {}", console_safe(host)));
        lines.push(String::new());
    }
    if show_home {
        lines.push("  Links on your local network:".into());
        lines.push("    http://luna.local".into());
        for ip in &snap.ipv4 {
            lines.push(format!("    {ip}"));
        }
    }

    // Keep showing the device token after setup / Connect claim — HDMI is
    // local-only, and the token is the durable identity for recovery and re-bind.
    if !token_problem && let Some(code) = &snap.device_code {
        lines.push(String::new());
        lines.push("  Device token (for Luna Connect):".into());
        lines.push(format!("    {}", console_safe(code)));
        lines.push("  Type it at connect.luna.libreloom.org".into());
    }

    lines.push(String::new());
    lines.push(
        "  Open Luna in a browser with the links above. The login below is only for recovery."
            .into(),
    );
    lines.push("  Local shell: type root, press Enter at password.".into());
    lines.push(
        "  Forgot the Luna password? Start Luna with a USB flash drive that holds only luna-recover-<token>.luna.".into(),
    );
    lines.push("============================================================".into());
    lines.push(String::new());
    lines
}

fn wrap_indent(text: &str, indent: &str, width: usize) -> Vec<String> {
    let max = width.saturating_sub(indent.len()).max(8);
    let cont = " ".repeat(indent.chars().count());
    let mut out = Vec::new();
    let mut line = String::new();
    let mut first = true;
    for word in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(word);
            continue;
        }
        if line.len() + 1 + word.len() > max {
            let prefix = if first { indent } else { &cont };
            out.push(format!("{prefix}{line}"));
            first = false;
            line = word.to_string();
        } else {
            line.push(' ');
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        let prefix = if first { indent } else { &cont };
        out.push(format!("{prefix}{line}"));
    }
    out
}

/// Write help text for luna-console (and any leftover getty -f consumers).
///
/// Unchanged text is not rewritten, only its mtime is bumped, so luna-console
/// still sees a live lunad. Returns true when the text changed.
pub fn write_issue(data_dir: &Path, snap: &ConsoleSnapshot) -> std::io::Result<bool> {
    let path = issue_path(data_dir);
    let text = help_text(snap);
    if std::fs::read(&path).is_ok_and(|old| old == text.as_bytes()) {
        std::fs::File::options()
            .write(true)
            .open(&path)?
            .set_modified(SystemTime::now())?;
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text)?;
    Ok(true)
}

/// Asks the console loop to look again soon. Cheap: callers may hold the
/// database lock.
pub fn request_refresh() {
    REFRESH.ask();
}

static REFRESH: Refresh = Refresh {
    asked: Mutex::new(false),
    cv: Condvar::new(),
};

struct Refresh {
    asked: Mutex<bool>,
    cv: Condvar,
}

impl Refresh {
    fn ask(&self) {
        *self.asked.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    /// Wait up to `timeout` for a request. True (and the request is taken)
    /// when one came.
    fn wait(&self, timeout: Duration) -> bool {
        let guard = self.asked.lock().unwrap_or_else(|e| e.into_inner());
        let (mut asked, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |a| !*a)
            .unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *asked)
    }
}

/// Rows the screen is built from: drive states, backups, and the people a
/// cloud backup needs a recovery phrase from.
fn shown_table(table: &str) -> bool {
    matches!(table, "drives" | "protections" | "users" | "user_keys")
}

/// Hooks `luna.db` so a change to a row the screen shows asks for a new look,
/// a drive change wakes the FAT/exFAT write-out loop, and a new cloud backup
/// key version starts moving data to it.
/// SQLite allows one update hook per connection; this is it.
pub fn watch_db(conn: &mut rusqlite::Connection) {
    let result = conn.update_hook(Some(
        |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
            if table == "drives" {
                crate::drives::flusher::note_drives_changed();
            }
            if shown_table(table) {
                request_refresh();
            } else if table == "backup_keys" {
                crate::backup::cloud::rewrap::nudge();
            }
        },
    ));
    if let Err(error) = result {
        tracing::warn!(%error, "could not watch the database for console changes");
    }
}

/// The Connect fields the screen shows. The Connect poll loop keeps the last
/// one and asks for a look when it changes.
#[derive(Default)]
pub struct ConnectShown(Option<[Option<String>; 5]>);

impl ConnectShown {
    pub fn note(&mut self, st: &crate::net::connect::ConnectStatus) {
        let now = [
            st.device_code.clone(),
            st.hostname.clone(),
            st.device_token_error.clone(),
            st.connect_unreachable.clone(),
            st.tunnel_error.clone(),
        ];
        if self.0.as_ref() != Some(&now) {
            self.0 = Some(now);
            request_refresh();
        }
    }
}

/// Wakes the console loop on any link, IPv4 address or IPv4 route change.
/// False when the kernel can't report them (the loop then looks every 10 s).
fn spawn_net_watch() -> bool {
    let groups = libc::RTMGRP_LINK | libc::RTMGRP_IPV4_IFADDR | libc::RTMGRP_IPV4_ROUTE;
    let Some(events) = crate::net::dhcp::LinkEvents::open_groups(groups as u32) else {
        return false;
    };
    std::thread::Builder::new()
        .name("luna-console-net".into())
        .spawn(move || {
            loop {
                events.wait_forever();
                request_refresh();
            }
        })
        .is_ok()
}

/// The HDMI console loop: rebuild the screen when something it shows changes,
/// and at least every [`HEARTBEAT_SECS`]. Runs until `stop` is set.
pub fn run(
    data_dir: &Path,
    db: &crate::Db,
    connect: &crate::net::connect::ConnectService,
    stop: Arc<AtomicBool>,
) {
    // Held until this loop ends, i.e. for lunad's lifetime.
    let _alive = hold_alive_lock(data_dir);
    let backstop = if spawn_net_watch() {
        Duration::from_secs(HEARTBEAT_SECS)
    } else {
        FALLBACK_LOOK
    };
    let mut last: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        if let Some(at) = last {
            std::thread::sleep(MIN_GAP.saturating_sub(at.elapsed()));
        }
        last = Some(Instant::now());
        let snap = snapshot(data_dir, db, connect);
        let _ = write_issue(data_dir, &snap);
        REFRESH.wait(backstop);
    }
}

/// Everything the screen shows, read now.
pub fn snapshot(
    data_dir: &Path,
    db: &crate::Db,
    connect: &crate::net::connect::ConnectService,
) -> ConsoleSnapshot {
    let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    let net = crate::net::read_status(Path::new("/sys/class/net"), &proc_route);
    let st = connect.status();
    let mut problems: Vec<String> = Vec::new();

    if let Some(err) = st.device_token_error.clone() {
        problems.push(err);
    }
    if let Some(err) = st.connect_unreachable.clone() {
        problems.push(err);
    }
    if let Some(err) = st.tunnel_error.clone() {
        problems.push(err);
    }

    if !net.ethernet_connected {
        problems.push(
            "No ethernet cable detected. Plug Luna into your router or modem with the included RJ45 (ethernet) cable."
                .into(),
        );
    } else if net.ipv4.is_empty() {
        problems.push("Waiting for a network address from your router or modem.".into());
    } else if !net.has_default_route {
        problems.push(
            "Luna has a network address but can't reach the internet. Make sure your router or modem is online."
                .into(),
        );
    }

    if let Ok(conn) = db.lock() {
        use crate::system::system_health as health;
        // Core checks only: network and Connect problems are listed above,
        // and feature warnings don't belong on a small HDMI screen.
        let core = health::run_core(data_dir, &conn, health::ClockReading::live(), false);
        let mut preflight_errors: Vec<_> = core
            .checks
            .into_values()
            .filter(|c| c.status == health::FAILED)
            .map(|c| c.message)
            .collect();
        preflight_errors.sort();
        problems.extend(preflight_errors);

        if let Ok(drives) = crate::db::list_drives(&conn) {
            for drive in drives {
                // Unplugged is normal — not an HDMI-console problem.
                if drive.state.as_str() == "readonly" {
                    problems.push(format!(
                        "Luna can read {} but can't save to it. If the drive has a write-lock switch, turn it off.",
                        drive.label
                    ));
                }
            }
        }

        // Same rows and wording as the web's system checks.
        let mut backup_problems: Vec<_> = health::backup_checks(&conn, crate::db::now_unix())
            .into_values()
            .filter(|c| c.status == health::WARNING)
            .map(|c| c.message)
            .collect();
        backup_problems.sort();
        problems.extend(backup_problems);
    }

    // Keep problem list short enough for a small HDMI screen.
    problems.truncate(6);

    ConsoleSnapshot {
        ipv4: net.ipv4,
        cable_in: net.ethernet_connected,
        has_default_route: net.has_default_route,
        device_code: st.device_code,
        connect_hostname: st.hostname,
        problems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_never_mentions_deleted_paths() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            device_code: Some("ABCD-EFGH".into()),
            connect_hostname: None,
            problems: vec![],
        });
        assert!(text.contains("192.168.1.20"));
        assert!(text.contains("http://luna.local"));
        assert!(text.contains("ABCD-EFGH"));
        assert!(text.contains(BANNER_OK));
        assert!(!text.contains("169.254.42.42"));
        assert!(!text.contains("Luna Setup"));
    }

    #[test]
    fn waiting_for_address_when_cable_has_no_lease() {
        let text = help_text(&ConsoleSnapshot {
            cable_in: true,
            ipv4: vec![],
            ..Default::default()
        });
        assert!(text.contains("Waiting for an address"));
        assert!(!text.contains("169.254"));
    }

    #[test]
    fn problems_change_banner_and_list_first() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            problems: vec![
                "System disk is almost full. Free some space, then wait.".into(),
                "Drive Photos cannot be written. Check the filesystem or the write-lock switch."
                    .into(),
            ],
            ..Default::default()
        });
        assert!(text.contains(BANNER_PROBLEMS));
        assert!(text.contains("What's wrong:"));
        assert!(text.contains("almost full"));
        assert!(text.contains("Drive Photos"));
        let problem_at = text.find("What's wrong:").unwrap();
        let open_at = text.find("Links on your local network:").unwrap();
        assert!(problem_at < open_at);
    }

    #[test]
    fn remote_hostname_listed_under_everywhere() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            connect_hostname: Some("photos.luna.servers.libreloom.org".into()),
            ..Default::default()
        });
        let everywhere_at = text.find("Links that work from anywhere:").unwrap();
        let home_at = text.find("Links on your local network:").unwrap();
        let host_at = text.find("photos.luna.servers.libreloom.org").unwrap();
        let local_at = text.find("http://luna.local").unwrap();
        assert!(everywhere_at < host_at);
        assert!(host_at < home_at);
        assert!(home_at < local_at);
        assert!(!text.contains("Away from home"));
        assert!(!text.contains("On your home internet only"));
        assert!(!text.contains("https://"));
    }

    #[test]
    fn device_token_error_hides_device_code_and_remote() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            device_code: Some("ABCD-EFGH-JKMN-PQRS-TVWX".into()),
            connect_hostname: Some("photos.luna.servers.libreloom.org".into()),
            problems: vec![crate::net::connect::DEVICE_TOKEN_REJECTED_MSG.into()],
        });
        let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("did not accept this device token"),
            "flat={flat}"
        );
        assert!(
            flat.contains("Settings") && flat.contains("About") && flat.contains("Advanced"),
            "flat={flat}"
        );
        assert!(flat.contains("192.168.1.20"));
        assert!(
            !text.contains("ABCD-EFGH-JKMN-PQRS-TVWX"),
            "rejected token must not be shown as a working device token"
        );
        assert!(
            !text.contains("photos.luna.servers.libreloom.org"),
            "rejected token must not advertise remote access"
        );
    }

    #[test]
    fn device_token_still_shown_after_connect_claim() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            device_code: Some("ABCD-EFGH-JKMN-PQRS-TVWX".into()),
            connect_hostname: Some("photos.luna.servers.libreloom.org".into()),
            problems: vec![],
        });
        assert!(text.contains("ABCD-EFGH-JKMN-PQRS-TVWX"));
        assert!(text.contains("Device token (for Luna Connect)"));
        assert!(text.contains("connect.luna.libreloom.org"));
        assert!(text.contains("photos.luna.servers.libreloom.org"));
    }

    #[test]
    fn no_default_route_called_out_when_address_exists() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: false,
            problems: vec!["Luna has a network address but can't reach the internet.".into()],
            ..Default::default()
        });
        assert!(text.contains("has an address but can't reach the internet"));
    }

    #[test]
    fn lock_tells_luna_console_whether_lunad_runs() {
        let dir = tempfile::tempdir().unwrap();
        let issue = issue_path(dir.path());
        let lock = alive_lock_path(&issue);
        assert_eq!(lunad_running(&lock), None);
        let fresh = Some(SystemTime::now());
        let held = hold_alive_lock(dir.path()).expect("lock taken");
        assert_eq!(lunad_running(&lock), Some(true));
        assert!(!issue_stale(&issue, fresh));
        // Only one lunad holds it.
        assert!(hold_alive_lock(dir.path()).is_none());
        drop(held);
        assert_eq!(lunad_running(&lock), Some(false));
        assert!(issue_stale(&issue, fresh));
        // No issue file yet: luna-console shows its own "starting" text.
        assert!(!issue_stale(&issue, None));
    }

    #[test]
    fn lunad_takes_the_lock_past_a_look_from_luna_console() {
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join(ALIVE_LOCK_FILE);
        std::fs::write(&lock, b"").unwrap();
        // luna-console's shared lock, held a little longer than a real look.
        let look = std::fs::File::open(&lock).unwrap();
        // SAFETY: flock on a file descriptor this test owns.
        assert_eq!(
            unsafe { libc::flock(look.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) },
            0
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(look);
        });
        assert!(hold_alive_lock(dir.path()).is_some());
        release.join().unwrap();
    }

    #[test]
    fn write_issue_creates_file_under_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            ..Default::default()
        };
        write_issue(dir.path(), &snap).unwrap();
        let body = std::fs::read_to_string(issue_path(dir.path())).unwrap();
        assert!(body.contains("10.0.0.5"));
    }

    #[test]
    fn missing_issue_file_is_not_stale() {
        assert!(!is_issue_stale(None));
    }

    #[test]
    fn fresh_mtime_is_not_stale() {
        assert!(!is_issue_stale(Some(SystemTime::now())));
    }

    #[test]
    fn old_mtime_is_stale() {
        let old = SystemTime::now() - Duration::from_secs(STALE_SECS + 5);
        assert!(is_issue_stale(Some(old)));
    }

    #[test]
    fn write_issue_leaves_fresh_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            ..Default::default()
        };
        write_issue(dir.path(), &snap).unwrap();
        // Identical rewrite (heartbeat) must keep liveness fresh.
        write_issue(dir.path(), &snap).unwrap();
        let mtime = std::fs::metadata(issue_path(dir.path()))
            .unwrap()
            .modified()
            .unwrap();
        assert!(!is_issue_stale(Some(mtime)));
        assert!(mtime.elapsed().unwrap() < Duration::from_secs(5));
    }

    #[test]
    fn unchanged_text_only_touches_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            ..Default::default()
        };
        assert!(write_issue(dir.path(), &snap).unwrap());
        let path = issue_path(dir.path());
        let old = SystemTime::now() - Duration::from_secs(STALE_SECS + 60);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(is_issue_stale(
            std::fs::metadata(&path).unwrap().modified().ok()
        ));
        // Same text: a heartbeat, not a rewrite.
        assert!(!write_issue(dir.path(), &snap).unwrap());
        assert!(!is_issue_stale(
            std::fs::metadata(&path).unwrap().modified().ok()
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), help_text(&snap));
        // Changed text is written.
        let moved = ConsoleSnapshot {
            ipv4: vec!["10.0.0.6".into()],
            ..snap
        };
        assert!(write_issue(dir.path(), &moved).unwrap());
        assert!(std::fs::read_to_string(&path).unwrap().contains("10.0.0.6"));
    }

    #[test]
    fn refresh_request_is_taken_once() {
        let r = Refresh {
            asked: Mutex::new(false),
            cv: Condvar::new(),
        };
        assert!(!r.wait(Duration::from_millis(1)));
        r.ask();
        assert!(r.wait(Duration::from_secs(5)));
        assert!(!r.wait(Duration::from_millis(1)));
    }

    #[test]
    fn connect_change_asks_for_a_look_only_when_shown_fields_move() {
        let dir = tempfile::tempdir().unwrap();
        let svc = crate::net::connect::ConnectService::new(dir.path(), None);
        let mut st = svc.status();
        let mut shown = ConnectShown::default();
        // Drain whatever other tests asked for; REFRESH is process-wide.
        REFRESH.wait(Duration::ZERO);
        shown.note(&st);
        assert!(REFRESH.wait(Duration::ZERO));
        st.backup_unlocked = !st.backup_unlocked;
        shown.note(&st);
        assert!(shown.0.is_some());
        st.hostname = Some("photos.example".into());
        shown.note(&st);
        assert!(REFRESH.wait(Duration::ZERO));
    }

    #[test]
    fn db_hook_watches_the_tables_the_screen_reads() {
        for t in ["drives", "protections", "users", "user_keys"] {
            assert!(shown_table(t), "{t}");
        }
        for t in ["sessions", "meta", "jobs", "uploads"] {
            assert!(!shown_table(t), "{t}");
        }
    }
}
