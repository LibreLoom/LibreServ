//! Device-local secrets stored outside SQLite (0600 files).

use std::fs;
use std::io::Write;
use std::path::Path;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use base64::Engine;
use rusqlite::Connection;

use crate::db;

const JWT_FILE: &str = "jwt_secret";
const DEVICE_KEY_FILE: &str = "device_key";

fn write_secret_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.to_path_buf();
    tmp.set_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn read_secret_file(path: &Path) -> anyhow::Result<Vec<u8>> {
    Ok(fs::read(path)?)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    OsRng.fill_bytes(&mut buf);
    buf
}

/// Load or create the JWT HMAC key. Migrates legacy `meta.jwt_secret` into a file.
pub fn ensure_jwt_secret(data_dir: &Path, conn: &Connection) -> anyhow::Result<Vec<u8>> {
    let path = data_dir.join(JWT_FILE);
    if path.exists() {
        return Ok(read_secret_file(&path)?);
    }
    if let Some(existing) = db::get_meta(conn, "jwt_secret")?
        && !existing.is_empty()
    {
        let bytes = existing.into_bytes();
        write_secret_file(&path, &bytes)?;
        let _ = conn.execute("DELETE FROM meta WHERE key = 'jwt_secret'", []);
        return Ok(bytes);
    }
    let bytes = random_bytes(32);
    write_secret_file(&path, &bytes)?;
    Ok(bytes)
}

/// Rotate JWT signing key (factory reset). Invalidates all outstanding sessions.
pub fn rotate_jwt_secret(data_dir: &Path) -> anyhow::Result<Vec<u8>> {
    let bytes = random_bytes(32);
    write_secret_file(&data_dir.join(JWT_FILE), &bytes)?;
    Ok(bytes)
}

/// Stable 256-bit device key for at-rest encryption of connect.json.
pub fn ensure_device_key(data_dir: &Path) -> anyhow::Result<[u8; 32]> {
    let path = data_dir.join(DEVICE_KEY_FILE);
    if path.exists() {
        let bytes = read_secret_file(&path)?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let bytes = random_bytes(32);
    write_secret_file(&path, &bytes)?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Human-readable backup of the device key (for support docs only — not shown in UI).
#[allow(dead_code)]
pub fn device_key_b64(data_dir: &Path) -> anyhow::Result<String> {
    let key = ensure_device_key(data_dir)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(key))
}
