//! Single-instance guard.
//!
//! Luna Desktop keeps running when its window is closed (it lives in the
//! tray / autostart), so launching it again must wake the existing process —
//! never start a second one. Two instances would race over the same ledgers
//! and jobs.
//!
//! The guard is an exclusive file lock (`luna-desktop.lock`) in the data dir
//! plus a loopback TCP listener. The first process to take the lock is the
//! primary; it writes its listener port to `luna-desktop.port` and answers a
//! one-word "show" request by presenting its window. Later launches read the
//! port, send "show", and exit quietly. If the primary died holding nothing
//! (the OS releases the lock), the next launch simply becomes the primary.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::session;

/// Raised on the primary when another launch asks for the window.
pub enum InstanceEvent {
    Show,
}

pub struct Instance {
    /// Held for the process lifetime; the OS releases it on exit/crash.
    _lock: std::fs::File,
}

/// Try to become the single running instance.
///
/// `Ok(instance)` — this process is the primary; a background thread is
/// listening and forwards `InstanceEvent::Show` on `events`. `Err(())` — a
/// primary already exists (we asked it to show its window) or the guard could
/// not be established; the caller should exit rather than run a duplicate.
pub fn claim(events: Sender<InstanceEvent>) -> Result<Instance, ()> {
    let dir = session::data_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        // No data dir means no ledgers either — still refuse to double-run
        // unmanaged: exit quietly.
        return Err(());
    }
    let lock_path = dir.join("luna-desktop.lock");
    let Ok(lock) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    else {
        return Err(());
    };

    match lock.try_lock() {
        Ok(()) => {}
        Err(_) => {
            signal_existing(&dir);
            return Err(());
        }
    }

    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        // No loopback listener — keep the lock (still single instance) and run
        // without the wake-up channel rather than doubling up.
        return Ok(Instance { _lock: lock });
    };
    if let Ok(addr) = listener.local_addr() {
        let _ = std::fs::write(dir.join("luna-desktop.port"), addr.port().to_string());
    }
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let mut conn = conn;
            let mut buf = [0u8; 16];
            let n = conn.read(&mut buf).unwrap_or(0);
            if buf[..n].starts_with(b"show") {
                let _ = events.send(InstanceEvent::Show);
            }
        }
    });
    Ok(Instance { _lock: lock })
}

/// Ask the existing primary to show its window. Best-effort: the port file
/// may be stale or briefly unwritten during startup, so retry a few times.
fn signal_existing(dir: &Path) {
    let port_path = dir.join("luna-desktop.port");
    for _ in 0..10 {
        let Ok(text) = std::fs::read_to_string(&port_path) else {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        };
        let Ok(port) = text.trim().parse::<u16>() else {
            return;
        };
        if let Ok(mut conn) = TcpStream::connect(("127.0.0.1", port))
            && conn.write_all(b"show").is_ok()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn second_claim_signals_primary_and_exits() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };

        let (tx, rx) = channel();
        let primary = claim(tx).expect("first claim is primary");
        assert!(dir.path().join("luna-desktop.port").exists());

        // A second claim must fail and wake the primary.
        assert!(claim(channel().0).is_err());
        let ev = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("primary got the show request");
        assert!(matches!(ev, InstanceEvent::Show));

        // After the primary exits the lock is free again.
        drop(primary);
        let (tx2, _rx2) = channel();
        assert!(claim(tx2).is_ok());
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }
}
