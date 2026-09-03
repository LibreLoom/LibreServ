//! Live HDMI status screen + getty-shaped login for Luna OS tty1.
//!
//! lunad writes `{LUNA_DATA_DIR}/issue` on every console-help tick (including
//! when the text is unchanged). This binary redraws when the painted screen
//! changes, then hands a username to `/bin/login`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::io::RawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime};

use lunad::console::{is_issue_stale, STALE_NOTE_LINE1, STALE_NOTE_LINE2};

const DEFAULT_TTY: &str = "/dev/tty1";
const DEFAULT_ISSUE: &str = "/var/lib/luna/issue";
const DEFAULT_LOGIN: &str = "/bin/login";
const POLL_MS: u64 = 250;

fn main() {
    if let Err(err) = run() {
        let _ = writeln!(io::stderr(), "luna-console: {err}");
        // Respawn via inittab; avoid tight crash loops when tty is missing.
        thread::sleep(Duration::from_secs(2));
        std::process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let tty_path = env_or("LUNA_CONSOLE_TTY", DEFAULT_TTY);
    let issue_path = issue_path_from_env();
    let login_bin = env_or("LUNA_CONSOLE_LOGIN", DEFAULT_LOGIN);

    let tty = open_tty(&tty_path)?;
    let fd = tty.as_raw_fd();
    become_session_leader(fd)?;
    dup_stdio(fd)?;
    // Keep the File alive so the fd is not closed after dup2.
    let _tty_keep = tty;

    prepare_terminal()?;

    let mut username = String::new();
    let mut last_paint = String::new();

    loop {
        let (body, mtime) = read_issue(&issue_path);
        let screen = compose_screen(&body, is_issue_stale(mtime), &username);

        // Repaint only when the visible screen changes. lunad heartbeats the
        // issue file mtime every few seconds; that must not flicker the VT.
        if screen != last_paint {
            paint(&screen)?;
            last_paint = screen;
        }

        match read_key(Duration::from_millis(POLL_MS))? {
            None => continue,
            Some(Key::Char(c)) => {
                if !c.is_control() {
                    username.push(c);
                    // Echo grows on the same line; full repaint keeps layout stable.
                    let (body, mtime) = read_issue(&issue_path);
                    let screen = compose_screen(&body, is_issue_stale(mtime), &username);
                    paint(&screen)?;
                    last_paint = screen;
                }
            }
            Some(Key::Backspace) => {
                username.pop();
                let (body, mtime) = read_issue(&issue_path);
                let screen = compose_screen(&body, is_issue_stale(mtime), &username);
                paint(&screen)?;
                last_paint = screen;
            }
            Some(Key::Enter) => {
                let name = username.trim().to_string();
                username.clear();
                if name.is_empty() {
                    continue;
                }
                // Clear prompt area before handing off.
                let _ = write!(io::stdout(), "\r\n");
                let _ = io::stdout().flush();
                exec_login(&login_bin, &name)?;
                // exec only returns on failure
            }
            Some(Key::CtrlC) | Some(Key::CtrlD) => {
                username.clear();
                let (body, mtime) = read_issue(&issue_path);
                let screen = compose_screen(&body, is_issue_stale(mtime), &username);
                paint(&screen)?;
                last_paint = screen;
            }
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn issue_path_from_env() -> PathBuf {
    if let Ok(p) = std::env::var("LUNA_CONSOLE_ISSUE") {
        return PathBuf::from(p);
    }
    if let Ok(data) = std::env::var("LUNA_DATA_DIR") {
        return PathBuf::from(data).join("issue");
    }
    PathBuf::from(DEFAULT_ISSUE)
}

fn open_tty(path: &str) -> io::Result<File> {
    OpenOptions::new().read(true).write(true).open(path)
}

fn become_session_leader(fd: RawFd) -> io::Result<()> {
    // Best-effort: setsid + claim controlling terminal.
    unsafe {
        libc::setsid();
        // TIOCSCTTY = 0x540E on Linux.
        let _ = libc::ioctl(fd, 0x540E, 0);
    }
    Ok(())
}

fn dup_stdio(fd: RawFd) -> io::Result<()> {
    unsafe {
        if libc::dup2(fd, 0) < 0 || libc::dup2(fd, 1) < 0 || libc::dup2(fd, 2) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn prepare_terminal() -> io::Result<()> {
    // Canonical line discipline with echo off — we paint the username ourselves.
    unsafe {
        let mut term = std::mem::MaybeUninit::<libc::termios>::uninit();
        if libc::tcgetattr(0, term.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut term = term.assume_init();
        term.c_lflag &= !(libc::ECHO | libc::ICANON);
        term.c_cc[libc::VMIN] = 0;
        term.c_cc[libc::VTIME] = 0;
        if libc::tcsetattr(0, libc::TCSANOW, &term) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn read_issue(path: &Path) -> (String, Option<SystemTime>) {
    let meta = fs::metadata(path).ok();
    let mtime = meta.and_then(|m| m.modified().ok());
    let body = fs::read_to_string(path).unwrap_or_else(|_| {
        "\n============================================================\n  Luna is starting. Wait a moment, or log in as root for recovery.\n============================================================\n\n".into()
    });
    (body, mtime)
}

fn compose_screen(body: &str, stale: bool, username: &str) -> String {
    let mut out = String::new();
    out.push_str(body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    if stale {
        out.push_str(STALE_NOTE_LINE1);
        out.push('\n');
        out.push_str(STALE_NOTE_LINE2);
        out.push_str("\n\n");
    }
    out.push_str("login: ");
    out.push_str(username);
    out
}

fn paint(screen: &str) -> io::Result<()> {
    // Clear screen + home cursor (ANSI). Works on the Linux VT used by Luna OS.
    let mut stdout = io::stdout();
    stdout.write_all(b"\x1b[2J\x1b[H")?;
    stdout.write_all(screen.as_bytes())?;
    stdout.flush()
}

enum Key {
    Char(char),
    Backspace,
    Enter,
    CtrlC,
    CtrlD,
}

fn read_key(timeout: Duration) -> io::Result<Option<Key>> {
    let mut fds = [libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    }];
    let wait = timeout.as_millis().min(i32::MAX as u128) as i32;
    let rc = unsafe { libc::poll(fds.as_mut_ptr(), 1, wait) };
    if rc < 0 {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::Interrupted {
            return Ok(None);
        }
        return Err(err);
    }
    if rc == 0 || fds[0].revents & libc::POLLIN == 0 {
        return Ok(None);
    }
    let mut buf = [0u8; 8];
    let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut _, buf.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    if n == 0 {
        return Ok(Some(Key::CtrlD));
    }
    Ok(Some(match buf[0] {
        b'\n' | b'\r' => Key::Enter,
        0x7f | 0x08 => Key::Backspace,
        0x03 => Key::CtrlC,
        0x04 => Key::CtrlD,
        b if (32..127).contains(&b) => Key::Char(b as char),
        _ => return Ok(None),
    }))
}

fn exec_login(login_bin: &str, username: &str) -> io::Result<()> {
    // BusyBox / util-linux: `login -- USER` prompts for password.
    let err = Command::new(login_bin).arg("--").arg(username).exec();
    Err(io::Error::other(format!("exec {login_bin} failed: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lunad::console::STALE_SECS;

    #[test]
    fn compose_omits_stale_note_when_fresh() {
        let screen = compose_screen("hello\n", false, "");
        assert!(screen.contains("hello"));
        assert!(!screen.contains("not updating"));
        assert!(screen.ends_with("login: "));
    }

    #[test]
    fn compose_includes_stale_note_when_stale() {
        let screen = compose_screen("hello\n", true, "root");
        assert!(screen.contains("not updating"));
        assert!(screen.contains(STALE_NOTE_LINE1.trim()));
        assert!(screen.ends_with("login: root"));
    }

    #[test]
    fn shared_stale_helper_matches_threshold() {
        assert!(!is_issue_stale(None));
        assert!(!is_issue_stale(Some(SystemTime::now())));
        let old = SystemTime::now() - Duration::from_secs(STALE_SECS + 1);
        assert!(is_issue_stale(Some(old)));
    }
}
