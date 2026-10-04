//! Run tools that parse untrusted bytes as an unprivileged user.
//!
//! lunad runs as root for mounts, partitioning, and network setup — but the
//! parsers it shells out to (`ffmpeg`, `heif-dec`, `blkid`) don't need that.
//! They decode bytes a member — or an anonymous contribution-link uploader —
//! chose, and a decoder vulnerability must not become root on the box.
//!
//! On Linux a sandboxed child gets:
//!   * `setuid`/`setgid` to `nobody` with supplementary groups cleared (only
//!     when lunad itself is root; a dev `lunad` stays as the dev user),
//!   * `no_new_privs`, cwd `/`, a scrubbed environment with a fixed PATH,
//!     stdin `/dev/null`, no core dumps, and a file-size write cap,
//!   * its input on an inherited file descriptor reached through
//!     `/proc/self/fd/N` — the child never needs path permissions on the
//!     drive, and a planted symlink swap after our `File::open` can't feed it
//!     a different file,
//!   * output into a per-run staging directory owned by `nobody` under
//!     `/tmp`, read back by the parent through `O_NOFOLLOW`.
//!
//! Nothing here is reachable from inside the child: the fd and the staging
//! dir are the only doors in. On non-Linux platforms commands run unmodified
//! (lunad is only shipped on the Luna OS image; dev machines stay simple).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// PATH inside a scrubbed environment — absolute, no user-writable dirs.
const SAFE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// First inherited-fd number handed to sandboxed children. High enough to
/// stay clear of stdio plumbing; each `input_path` call takes the next one.
const FIRST_FD: i32 = 40;

/// Cap on bytes a sandboxed child may write to any file (RLIMIT_FSIZE).
/// Thumbnails and decoded intermediates are far smaller; this is a disk-fill
/// guard, not a format limit.
const MAX_CHILD_WRITE: u64 = 512 * 1024 * 1024;

/// Absolute path to `bin` on the daemon's PATH — resolved in the parent,
/// since the child's scrubbed environment can't be trusted for lookups.
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Staging dir + inherited fds for one sandboxed run. Drop removes the dir.
pub struct SandboxIo {
    /// Lazily created: probes that only read (blkid, ffprobe) never need it.
    dir: Option<tempfile::TempDir>,
    /// `File`s owning the high dup'd fds so they close once spawn is done.
    #[cfg(target_os = "linux")]
    held: Vec<File>,
    /// (parent high fd -> child fd) pairs applied by `pre_exec` at spawn.
    #[cfg(target_os = "linux")]
    dups: Vec<(i32, i32)>,
    #[cfg(target_os = "linux")]
    next_fd: i32,
}

impl SandboxIo {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            dir: None,
            #[cfg(target_os = "linux")]
            held: Vec::new(),
            #[cfg(target_os = "linux")]
            dups: Vec::new(),
            #[cfg(target_os = "linux")]
            next_fd: FIRST_FD,
        })
    }

    /// What the child should open to read `path`. On Linux the parent opens
    /// the file as root and the child inherits it on `/proc/self/fd/N` — a
    /// regular-file fd stays seekable (unlike `pipe:N`), so ffmpeg's input
    /// seeking still works. Elsewhere the path passes through unchanged.
    pub fn input_path(&mut self, path: &Path) -> io::Result<String> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let file = File::open(path)?;
            // Dup to a high fd first: the child-side `dup2(hi, N)` must not
            // clobber a low fd that stdio plumbing or another input is using.
            let hi = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 512) };
            if hi < 0 {
                return Err(io::Error::last_os_error());
            }
            let fd = self.next_fd;
            self.next_fd += 1;
            self.dups.push((hi, fd));
            self.held.push(unsafe { File::from_raw_fd(hi) });
            Ok(format!("/proc/self/fd/{fd}"))
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(path.to_string_lossy().into_owned())
        }
    }

    /// A `nobody`-writable path for the child's output. `name` should carry
    /// the extension the tool expects — several pick encoders by suffix.
    pub fn out_path(&mut self, name: &str) -> io::Result<PathBuf> {
        Ok(self.staging_dir()?.join(name))
    }

    /// Open a file the child wrote: `O_NOFOLLOW` plus a regular-file check so
    /// a planted link can't redirect the read.
    pub fn open_out(&mut self, name: &str) -> io::Result<File> {
        let p = self.out_path(name)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let f = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&p)?;
            if !f.metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "sandbox output is not a file",
                ));
            }
            Ok(f)
        }
        #[cfg(not(unix))]
        {
            File::open(&p)
        }
    }

    #[cfg(target_os = "linux")]
    fn staging_dir(&mut self) -> io::Result<&Path> {
        if self.dir.is_none() {
            let dir = tempfile::Builder::new().prefix("luna-sbx-").tempdir()?;
            // Root-owned tempfile dirs aren't reachable by `nobody`; hand the
            // dir itself to the sandbox user. Only our own children run as
            // nobody, so nobody-vs-nobody access is a non-issue.
            if unsafe { libc::geteuid() } == 0 {
                let (uid, gid) = nobody_ids();
                let c = std::ffi::CString::new(dir.path().as_os_str().as_encoded_bytes())
                    .map_err(io::Error::other)?;
                unsafe {
                    if libc::chown(c.as_ptr(), uid, gid) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    libc::chmod(c.as_ptr(), 0o700);
                }
            }
            self.dir = Some(dir);
        }
        Ok(self.dir.as_ref().unwrap().path())
    }

    #[cfg(not(target_os = "linux"))]
    fn staging_dir(&mut self) -> io::Result<&Path> {
        if self.dir.is_none() {
            self.dir = Some(tempfile::Builder::new().prefix("luna-sbx-").tempdir()?);
        }
        Ok(self.dir.as_ref().unwrap().path())
    }
}

/// Command with a scrubbed environment, cwd `/`, stdin `/dev/null`, and — on
/// Linux — `no_new_privs` plus no core dumps. The child keeps lunad's uid:
/// use for tools that genuinely need root (device ioctls, mounts).
pub fn hardened(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear()
        .env("PATH", SAFE_PATH)
        .current_dir("/")
        .stdin(Stdio::null());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
                no_core_dumps();
                Ok(())
            });
        }
    }
    cmd
}

/// Spawn `cmd` sandboxed and wait for it, killing on `timeout`.
/// Returns the exit status; callers decide what nonzero means.
pub fn run(cmd: &mut Command, io: &SandboxIo, timeout: Duration) -> io::Result<ExitStatus> {
    let mut child = spawn_sandboxed(cmd, io)?;
    wait_timeout(&mut child, timeout)
}

/// Like [`run`], but captures stdout (and stderr when the caller piped it).
/// For small outputs only — the pipes are drained after exit, so a child
/// writing more than a pipe buffer is killed by the timeout.
pub fn output(
    cmd: &mut Command,
    io: &SandboxIo,
    timeout: Duration,
) -> io::Result<std::process::Output> {
    cmd.stdout(Stdio::piped());
    let child = spawn_sandboxed(cmd, io)?;
    collect(child, timeout)
}

/// `run` for a [`hardened`] command — same uid, still time-bounded.
pub fn run_limited(cmd: &mut Command, timeout: Duration) -> io::Result<ExitStatus> {
    let mut child = cmd.spawn()?;
    wait_timeout(&mut child, timeout)
}

/// `output` for a [`hardened`] command — same uid, still time-bounded.
pub fn output_limited(cmd: &mut Command, timeout: Duration) -> io::Result<std::process::Output> {
    cmd.stdout(Stdio::piped());
    let child = cmd.spawn()?;
    collect(child, timeout)
}

fn collect(mut child: Child, timeout: Duration) -> io::Result<std::process::Output> {
    let status = wait_timeout(&mut child, timeout)?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut s) = child.stdout.take() {
        io::Read::read_to_end(&mut s, &mut stdout)?;
    }
    if let Some(mut s) = child.stderr.take() {
        io::Read::read_to_end(&mut s, &mut stderr)?;
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "linux")]
fn spawn_sandboxed(cmd: &mut Command, io: &SandboxIo) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;
    let dups = io.dups.clone();
    let (uid, gid) = nobody_ids();
    unsafe {
        cmd.pre_exec(move || {
            for &(src, dst) in &dups {
                if libc::dup2(src, dst) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
            no_core_dumps();
            let cap = libc::rlimit {
                rlim_cur: MAX_CHILD_WRITE,
                rlim_max: MAX_CHILD_WRITE,
            };
            libc::setrlimit(libc::RLIMIT_FSIZE, &cap);
            // Drop privilege last: root's supplementary groups include disk
            // and must be cleared while we still can.
            if libc::geteuid() == 0
                && (libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setgid(gid) != 0
                    || libc::setuid(uid) != 0)
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.env_clear()
        .env("PATH", SAFE_PATH)
        .current_dir("/")
        .stdin(Stdio::null());
    cmd.spawn()
}

#[cfg(not(target_os = "linux"))]
fn spawn_sandboxed(cmd: &mut Command, _io: &SandboxIo) -> io::Result<Child> {
    cmd.env_clear()
        .env("PATH", SAFE_PATH)
        .current_dir("/")
        .stdin(Stdio::null());
    cmd.spawn()
}

/// `nobody`'s uid/gid, resolved once via getpwnam (65534/65534 fallback —
/// the conventional nobody/nogroup on Debian and Alpine).
#[cfg(target_os = "linux")]
fn nobody_ids() -> (u32, u32) {
    static IDS: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    *IDS.get_or_init(|| unsafe {
        let pw = libc::getpwnam(c"nobody".as_ptr());
        if pw.is_null() {
            (65534, 65534)
        } else {
            ((*pw).pw_uid, (*pw).pw_gid)
        }
    })
}

#[cfg(target_os = "linux")]
fn no_core_dumps() {
    let zero = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    unsafe { libc::setrlimit(libc::RLIMIT_CORE, &zero) };
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> io::Result<ExitStatus> {
    let start = Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(io::ErrorKind::TimedOut, "tool timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_ls() {
        assert!(which("ls").is_some());
        assert!(which("definitely-not-a-luna-binary").is_none());
    }

    #[test]
    fn out_path_is_inside_staging() {
        let mut io = SandboxIo::new().unwrap();
        let p = io.out_path("x.jpg").unwrap();
        assert!(p.ends_with("x.jpg"));
        assert!(p.parent().unwrap().exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sandboxed_child_reads_input_fd_and_drops_uid() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.bin");
        std::fs::write(&src, b"sandbox-payload").unwrap();

        let mut io = SandboxIo::new().unwrap();
        let input = io.input_path(&src).unwrap();
        assert!(input.starts_with("/proc/self/fd/"));

        let cat = which("cat").unwrap();
        let mut cmd = Command::new(cat);
        cmd.arg(&input);
        let out = output(&mut cmd, &io, Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, b"sandbox-payload");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sandboxed_child_uid_is_nobody_under_root() {
        // In dev runs (non-root) the child keeps our uid — both are correct.
        let Some(id) = which("id") else { return };
        let io = SandboxIo::new().unwrap();
        let mut cmd = Command::new(id);
        cmd.args(["-u"]);
        let out = output(&mut cmd, &io, Duration::from_secs(10)).unwrap();
        let uid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let want = if unsafe { libc::geteuid() } == 0 {
            nobody_ids().0
        } else {
            unsafe { libc::geteuid() }
        };
        assert_eq!(uid, want);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_writes_outfile_parent_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.bin");
        std::fs::write(&src, b"roundtrip").unwrap();

        let mut io = SandboxIo::new().unwrap();
        let input = io.input_path(&src).unwrap();
        let out = io.out_path("copy.bin").unwrap();

        let cp = which("cp").unwrap();
        let mut cmd = Command::new(cp);
        cmd.arg(&input).arg(&out);
        let status = run(&mut cmd, &mut io, Duration::from_secs(10)).unwrap();
        assert!(status.success());

        let mut f = io.open_out("copy.bin").unwrap();
        let mut buf = Vec::new();
        io::Read::read_to_end(&mut f, &mut buf).unwrap();
        assert_eq!(buf, b"roundtrip");
    }

    #[test]
    fn timeout_kills_child() {
        let Some(sleep) = which("sleep") else { return };
        let io = SandboxIo::new().unwrap();
        let mut cmd = Command::new(sleep);
        cmd.arg("60");
        let err = run(&mut cmd, &io, Duration::from_millis(100)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }
}
