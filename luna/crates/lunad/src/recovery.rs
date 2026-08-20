//! Local-console admin recovery.
//!
//! If the only admin forgets their password, they plug a USB keyboard into
//! Luna and type a short sequence. That never runs over the network. After
//! the sequence matches, Luna asks for a new password on the screen plugged
//! into the box (TTY / console).
//!
//! Printed card (keep this copy in the setup "done" step and Settings):
//!
//!   If you forget your password
//!   1. Plug a USB keyboard into Luna.
//!   2. Press Esc, then type luna, then press Enter.
//!   3. On the screen plugged into Luna, type a new password twice.

use std::io::{Read, Write};
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

pub const CARD_TITLE: &str = "If you forget your password";
pub const CARD_STEPS: &[&str] = &[
    "Plug a USB keyboard into Luna.",
    "Press Esc, then type luna, then press Enter.",
    "On the screen plugged into Luna, type a new password twice.",
];

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
        // Blocking poll of every open event node. A missing /dev/input just
        // parks the recovery thread forever, which is fine.
        loop {
            if self.files.is_empty() {
                std::thread::sleep(Duration::from_secs(30));
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
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let secret = AuthService::ensure_secret(&conn).unwrap();
        let auth = Arc::new(AuthService::new(
            Arc::new(Mutex::new(conn)),
            secret.into_bytes(),
        ));
        auth.register("Max", "Max", "old-password-1", "user")
            .unwrap();

        let prompt = ScriptedPrompt {
            password: "brand-new-9".into(),
            calls: 0,
        };
        let t0 = Instant::now();
        run_loop(auth.clone(), seq().into_iter(), prompt, || t0);
        auth.login("max", "brand-new-9").unwrap();
        assert!(auth.login("max", "old-password-1").is_err());
    }
}
