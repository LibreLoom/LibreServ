//! Local-console admin recovery.
//!
//! If an admin forgets their password, they plug a USB keyboard into Luna,
//! type `pwreset`, and press Enter. That signs into the local pwreset
//! recovery session and starts the reset wizard. It works headless (no
//! screen required); a screen just makes the prompts easier to follow.
//! It never runs over the network.
//!
//! These steps are **not** shown in the Luna web UI (Settings/Login tests
//! assert that). Keep this block as the source of truth for the printed
//! card, booklet, and future docs:
//!
//!   If you forget your password
//!   1. Hold the power button until Luna is visibly off and silent.
//!   2. Press the power button once to turn it back on.
//!   3. Wait about 2 minutes (until Luna has finished starting).
//!   4. Plug a USB keyboard into Luna.
//!      (Optional: plug in a screen too — it makes the prompts easier to
//!      read, but you do not need one.)
//!   5. Type pwreset and press Enter.
//!   6. Type your admin username and press Enter.
//!   7. Type a new password (at least 12 characters, with letters and
//!      numbers) and press Enter.
//!   8. Type logout and press Enter.
//!   9. On your phone or computer, open the Luna web page and sign in
//!      with that username and the new password.
//!
//! Typing pwreset once is enough — do not ask the user to type it twice.
//! Only an admin account can be reset this way.

use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::auth::AuthService;

/// Linux evdev KEY_* codes (USB HID mapped the same way on x86).
pub const KEY_ESC: u16 = 1;
pub const KEY_ENTER: u16 = 28;
pub const KEY_A: u16 = 30;
pub const KEY_L: u16 = 38;
pub const KEY_N: u16 = 49;
pub const KEY_U: u16 = 22;

/// Esc, then L U N A, then Enter.
pub const SEQUENCE: &[u16] = &[KEY_ESC, KEY_L, KEY_U, KEY_N, KEY_A, KEY_ENTER];

/// Friendly copy for the printed recovery card / booklet / future docs.
/// Not rendered in the Luna web UI — keep in sync with the module comment above.
pub const CARD_TITLE: &str = "If you forget your password";
pub const CARD_STEPS: &[&str] = &[
    "Hold the power button until Luna is visibly off and silent.",
    "Press the power button once to turn it back on.",
    "Wait about 2 minutes (until Luna has finished starting).",
    "Plug a USB keyboard into Luna. A screen is optional — it makes the prompts easier to read, but you do not need one.",
    "Type pwreset and press Enter.",
    "Type your admin username and press Enter.",
    "Type a new password (at least 12 characters, with letters and numbers) and press Enter.",
    "Type logout and press Enter.",
    "On your phone or computer, open the Luna web page and sign in with that username and the new password.",
];

/// Soft-login name for console recovery. Typing this once signs into the
/// pwreset session and starts the reset wizard — do not ask for it twice.
pub const PWRESET_USER: &str = "pwreset";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleCommand {
    /// Sign in as pwreset and run the reset wizard.
    StartReset,
    /// End the pwreset session.
    Logout,
    /// Already signed in; remind them how to finish or retry.
    HintWhileSignedIn,
    Ignore,
}

/// Map one console line to a recovery action. `signed_in` is the soft
/// pwreset session (not a Linux or Luna account login).
pub fn console_command(line: &str, signed_in: bool) -> ConsoleCommand {
    match line.trim().to_lowercase().as_str() {
        PWRESET_USER => ConsoleCommand::StartReset,
        "logout" if signed_in => ConsoleCommand::Logout,
        "" => ConsoleCommand::Ignore,
        _ if signed_in => ConsoleCommand::HintWhileSignedIn,
        _ => ConsoleCommand::Ignore,
    }
}

const SEQUENCE_TIMEOUT: Duration = Duration::from_secs(8);
const MATCH_WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_MATCHES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedResult {
    Idle,
    Progress,
    Matched,
    RateLimited,
    Reset,
}

/// In-memory matcher. Tests feed key codes; production feeds evdev KEY downs.
pub struct Gesture {
    pos: usize,
    started: Option<Instant>,
    matches: Vec<Instant>,
}

impl Default for Gesture {
    fn default() -> Self {
        Self::new()
    }
}

impl Gesture {
    pub fn new() -> Self {
        Self {
            pos: 0,
            started: None,
            matches: Vec::new(),
        }
    }

    pub fn feed(&mut self, code: u16, now: Instant) -> FeedResult {
        self.matches
            .retain(|t| now.duration_since(*t) < MATCH_WINDOW);
        if self.pos > 0
            && let Some(started) = self.started
            && now.duration_since(started) > SEQUENCE_TIMEOUT
        {
            self.pos = 0;
            self.started = None;
        }

        let expected = SEQUENCE[self.pos];
        if code != expected {
            let restart = code == SEQUENCE[0];
            self.pos = 0;
            self.started = None;
            if restart {
                return self.feed(code, now);
            }
            return FeedResult::Reset;
        }

        if self.pos == 0 {
            self.started = Some(now);
        }
        self.pos += 1;
        if self.pos < SEQUENCE.len() {
            return FeedResult::Progress;
        }

        self.pos = 0;
        self.started = None;
        if self.matches.len() >= MAX_MATCHES {
            return FeedResult::RateLimited;
        }
        self.matches.push(now);
        FeedResult::Matched
    }
}

pub trait PasswordPrompt {
    fn prompt_new_password(&mut self) -> Result<String, String>;
}

/// Blocking loop: read keys, and on a match ask for a new admin password.
pub fn run_loop(
    auth: Arc<AuthService>,
    keys: impl Iterator<Item = u16>,
    mut prompt: impl PasswordPrompt,
    mut now: impl FnMut() -> Instant,
) {
    let mut gesture = Gesture::new();
    for code in keys {
        match gesture.feed(code, now()) {
            FeedResult::Matched => match prompt.prompt_new_password() {
                Ok(password) => match auth.reset_admin_password(&password) {
                    Ok(user) => {
                        tracing::info!(username = %user.username, "admin password reset from local keyboard");
                    }
                    Err(e) => tracing::warn!(error = %e, "console password reset failed"),
                },
                Err(e) => tracing::warn!(error = %e, "console password prompt failed"),
            },
            FeedResult::RateLimited => {
                tracing::warn!("console recovery rate-limited");
            }
            _ => {}
        }
    }
}

/// Linux evdev KEY-down iterator. Skips virtual and Bluetooth devices so a
/// network-adjacent input cannot reset the admin password.
pub struct EvdevKeys {
    files: Vec<std::fs::File>,
    buf: [u8; 24],
}

impl EvdevKeys {
    pub fn open_dir(dir: &Path) -> Self {
        let mut files = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Self {
                files,
                buf: [0; 24],
            };
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("event") {
                continue;
            }
            let path = entry.path();
            if !is_physical_keyboard(&path) {
                continue;
            }
            if let Ok(f) = std::fs::File::open(&path) {
                files.push(f);
            }
        }
        Self {
            files,
            buf: [0; 24],
        }
    }

    pub fn scan() -> Self {
        Self::open_dir(Path::new("/dev/input"))
    }
}

impl Iterator for EvdevKeys {
    type Item = u16;

    fn next(&mut self) -> Option<u16> {
        // Blocking poll of every open event node. Rescan often while empty so
        // a cold-plugged keyboard that appears after luna-input still works.
        loop {
            if self.files.is_empty() {
                std::thread::sleep(Duration::from_secs(2));
                *self = Self::scan();
                continue;
            }
            for file in &mut self.files {
                match file.read(&mut self.buf) {
                    Ok(n) if n >= 24 => {
                        let ev_type = u16::from_le_bytes([self.buf[16], self.buf[17]]);
                        let code = u16::from_le_bytes([self.buf[18], self.buf[19]]);
                        let value = i32::from_le_bytes([
                            self.buf[20],
                            self.buf[21],
                            self.buf[22],
                            self.buf[23],
                        ]);
                        // EV_KEY = 1, value 1 = press (ignore repeats).
                        if ev_type == 1 && value == 1 {
                            return Some(code);
                        }
                    }
                    Ok(0) | Err(_) => {}
                    Ok(_) => {}
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

const BUS_USB: u16 = 0x03;
const BUS_I8042: u16 = 0x11;
const EV_KEY: u32 = 1;

fn is_physical_keyboard(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    // struct input_id { bustype, vendor, product, version } — EVIOCGID
    let mut id = [0u16; 4];
    const EVIOCGID: u64 = 0x8008_4502;
    // SAFETY: ioctl reads 8 bytes into id.
    let rc = unsafe { libc_ioctl(fd, EVIOCGID, id.as_mut_ptr() as usize) };
    if rc != 0 {
        return false;
    }
    let bustype = id[0];
    if bustype != BUS_USB && bustype != BUS_I8042 {
        return false;
    }
    // EVIOCGBIT(EV_KEY) — need KEY_A present so mice/power buttons drop out.
    let mut bits = [0u8; 96];
    const EVIOCGBIT_KEY: u64 = ioc_read(b'E', 0x20 + EV_KEY, 96);
    let rc = unsafe { libc_ioctl(fd, EVIOCGBIT_KEY, bits.as_mut_ptr() as usize) };
    if rc < 0 {
        return false;
    }
    let a = KEY_A as usize;
    (bits[a / 8] & (1 << (a % 8))) != 0
}

const fn ioc_read(typ: u8, nr: u32, size: u32) -> u64 {
    // _IOC(_IOC_READ, 'E', nr, size) on linux x86_64
    ((2u64) << 30) | ((size as u64) << 16) | ((typ as u64) << 8) | (nr as u64)
}

unsafe extern "C" {
    fn ioctl(fd: i32, request: u64, ...) -> i32;
}

unsafe fn libc_ioctl(fd: i32, request: u64, arg: usize) -> i32 {
    unsafe { ioctl(fd, request, arg) }
}

/// Prompt on /dev/console or /dev/tty1 — the screen plugged into Luna.
pub struct ConsolePrompt;

impl PasswordPrompt for ConsolePrompt {
    fn prompt_new_password(&mut self) -> Result<String, String> {
        let mut tty = open_console()?;
        writeln!(
            tty,
            "\nLuna recovery\nType a new admin password (at least 8 characters), then Enter."
        )
        .map_err(|e| e.to_string())?;
        let first = read_secret(&mut tty)?;
        writeln!(tty, "Type it again to confirm.").map_err(|e| e.to_string())?;
        let second = read_secret(&mut tty)?;
        if first != second {
            let _ = writeln!(tty, "Those didn't match. Nothing was changed.");
            return Err("passwords did not match".into());
        }
        if first.len() < 8 {
            let _ = writeln!(tty, "Use at least 8 characters. Nothing was changed.");
            return Err("password too short".into());
        }
        let _ = writeln!(tty, "Password updated. Sign in on your phone or computer.");
        Ok(first)
    }
}

fn open_console() -> Result<std::fs::File, String> {
    for path in ["/dev/console", "/dev/tty1", "/dev/tty"] {
        if let Ok(f) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            return Ok(f);
        }
    }
    Err("no local screen to type on".into())
}

fn read_secret(tty: &mut std::fs::File) -> Result<String, String> {
    let mut buf = String::new();
    let mut byte = [0u8; 1];
    loop {
        match tty.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    break;
                }
                if byte[0] == 0x7f || byte[0] == 8 {
                    buf.pop();
                    continue;
                }
                if byte[0].is_ascii_graphic() || byte[0] == b' ' {
                    buf.push(byte[0] as char);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(buf)
}

pub fn run_console_loop(auth: Arc<AuthService>) {
    let Ok(mut console) = open_console() else {
        tracing::warn!("no local console for password recovery");
        return;
    };
    let reader = match console.try_clone() {
        Ok(c) => std::io::BufReader::new(c),
        Err(_) => return,
    };
    let mut signed_in = false;
    for line in reader.lines().flatten() {
        match console_command(&line, signed_in) {
            ConsoleCommand::StartReset => {
                signed_in = true;
                let _ = writeln!(console, "\nLuna recovery (pwreset)");
                let _ = pwreset_flow(&auth, &mut console);
            }
            ConsoleCommand::Logout => {
                signed_in = false;
                let _ = writeln!(console, "Signed out of recovery.");
            }
            ConsoleCommand::HintWhileSignedIn => {
                let _ = writeln!(
                    console,
                    "Type logout when you're done, or pwreset to try again."
                );
            }
            ConsoleCommand::Ignore => {}
        }
    }
}

fn pwreset_flow(auth: &AuthService, console: &mut std::fs::File) -> Result<(), String> {
    write!(console, "Username: ").map_err(|e| e.to_string())?;
    let username = read_line_console(console)?;
    write!(console, "New password (at least 12 characters, letters and numbers): ")
        .map_err(|e| e.to_string())?;
    let password = read_line_console(console)?;
    if let Err(err) = crate::password::validate_password(&password) {
        let _ = writeln!(console, "{}", err.message());
        return Err(err.message().into());
    }
    match auth.reset_user_password(&username, &password) {
        Ok(user) => {
            writeln!(console, "Password updated for {}. Type logout.", user.username)
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = writeln!(console, "{e}");
            Err(e.to_string())
        }
    }
}

fn read_line_console(console: &mut std::fs::File) -> Result<String, String> {
    let mut reader = std::io::BufReader::new(console.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthService;
    use crate::db;
    use std::sync::{Arc, Mutex};

    fn seq() -> Vec<u16> {
        SEQUENCE.to_vec()
    }

    #[test]
    fn full_sequence_matches() {
        let mut g = Gesture::new();
        let t0 = Instant::now();
        let mut last = FeedResult::Idle;
        for (i, code) in seq().into_iter().enumerate() {
            last = g.feed(code, t0 + Duration::from_millis(50 * i as u64));
            if i + 1 < SEQUENCE.len() {
                assert_eq!(last, FeedResult::Progress);
            }
        }
        assert_eq!(last, FeedResult::Matched);
    }

    #[test]
    fn wrong_key_resets() {
        let mut g = Gesture::new();
        let t0 = Instant::now();
        assert_eq!(g.feed(KEY_ESC, t0), FeedResult::Progress);
        assert_eq!(
            g.feed(KEY_A, t0 + Duration::from_millis(10)),
            FeedResult::Reset
        );
    }

    #[test]
    fn slow_typing_times_out() {
        let mut g = Gesture::new();
        let t0 = Instant::now();
        assert_eq!(g.feed(KEY_ESC, t0), FeedResult::Progress);
        assert_eq!(
            g.feed(KEY_L, t0 + Duration::from_secs(20)),
            FeedResult::Reset
        );
    }

    #[test]
    fn rate_limits_repeated_matches() {
        let mut g = Gesture::new();
        let t0 = Instant::now();
        for round in 0..MAX_MATCHES {
            let mut last = FeedResult::Idle;
            for (i, code) in seq().into_iter().enumerate() {
                last = g.feed(
                    code,
                    t0 + Duration::from_secs(round as u64) + Duration::from_millis(i as u64),
                );
            }
            assert_eq!(last, FeedResult::Matched);
        }
        let mut last = FeedResult::Idle;
        for (i, code) in seq().into_iter().enumerate() {
            last = g.feed(
                code,
                t0 + Duration::from_secs(10) + Duration::from_millis(i as u64),
            );
        }
        assert_eq!(last, FeedResult::RateLimited);
    }

    struct ScriptedPrompt {
        password: String,
        calls: usize,
    }

    impl PasswordPrompt for ScriptedPrompt {
        fn prompt_new_password(&mut self) -> Result<String, String> {
            self.calls += 1;
            Ok(self.password.clone())
        }
    }

    #[test]
    fn mocked_keys_reset_admin_password() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let conn = db::open(&data_dir.join("luna.db")).unwrap();
        let secret = crate::secrets::ensure_jwt_secret(&data_dir, &conn).unwrap();
        let auth = Arc::new(AuthService::new(
            Arc::new(Mutex::new(conn)),
            secret,
            data_dir,
        ));
        auth.register("Max", "Max", "old-password12", "user")
            .unwrap();
        let old_session = auth.login("max", "old-password12").unwrap().1;

        let prompt = ScriptedPrompt {
            password: "brand-new-12".into(),
            calls: 0,
        };
        let t0 = Instant::now();
        run_loop(auth.clone(), seq().into_iter(), prompt, || t0);
        assert!(
            auth.verify(&old_session).is_err(),
            "USB recovery must kill stolen browser sessions"
        );
        auth.login("max", "brand-new-12").unwrap();
        assert!(auth.login("max", "old-password12").is_err());
    }

    #[test]
    fn pwreset_once_starts_reset_without_root() {
        assert_eq!(
            console_command("pwreset", false),
            ConsoleCommand::StartReset
        );
        assert_eq!(
            console_command("PWRESET", false),
            ConsoleCommand::StartReset,
            "login name is case-insensitive"
        );
        assert_eq!(
            console_command("root", false),
            ConsoleCommand::Ignore,
            "old root gate must not open recovery anymore"
        );
        assert_eq!(console_command("logout", false), ConsoleCommand::Ignore);
    }

    #[test]
    fn pwreset_again_while_signed_in_retries_wizard() {
        assert_eq!(
            console_command("pwreset", true),
            ConsoleCommand::StartReset
        );
        assert_eq!(console_command("logout", true), ConsoleCommand::Logout);
        assert_eq!(
            console_command("help", true),
            ConsoleCommand::HintWhileSignedIn
        );
    }

    #[test]
    fn card_steps_use_single_pwreset_login() {
        assert_eq!(CARD_STEPS.iter().filter(|s| s.contains("pwreset")).count(), 1);
        assert!(
            CARD_STEPS.iter().all(|s| !s.to_lowercase().contains("root")),
            "printed card must not tell users to type root"
        );
        assert!(
            CARD_STEPS
                .iter()
                .any(|s| s.contains("visibly off and silent")),
            "card must tell users how to confirm Luna is off"
        );
        assert!(
            CARD_STEPS.iter().any(|s| s.contains("do not need one")),
            "card must say a screen is optional"
        );
        assert!(CARD_STEPS.iter().any(|s| s.starts_with("Type pwreset")));
        assert!(CARD_STEPS.iter().any(|s| s.contains("admin username")));
        assert!(CARD_STEPS.iter().any(|s| s.contains("new password")));
        assert!(CARD_STEPS.iter().any(|s| s.starts_with("Type logout")));
        assert_eq!(CARD_TITLE, "If you forget your password");
    }
}
