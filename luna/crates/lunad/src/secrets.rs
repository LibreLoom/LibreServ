//! The sign-in signing key, stored outside SQLite as a 0600 file.

use std::fs;
use std::io::Write;
use std::path::Path;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use rusqlite::Connection;

use crate::db;

const JWT_FILE: &str = "jwt_secret";

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
        return read_secret_file(&path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn conn() -> Connection {
        Connection::open_in_memory()
            .and_then(|c| {
                c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
                Ok(c)
            })
            .unwrap()
    }

    #[test]
    fn jwt_secret_is_created_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let conn = conn();
        let first = ensure_jwt_secret(dir.path(), &conn).unwrap();
        assert_eq!(first.len(), 32);
        assert_eq!(ensure_jwt_secret(dir.path(), &conn).unwrap(), first);
        assert_eq!(fs::read(dir.path().join("jwt_secret")).unwrap(), first);
    }

    #[cfg(unix)]
    #[test]
    fn secret_files_are_private_and_leave_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        ensure_jwt_secret(dir.path(), &conn()).unwrap();
        assert_eq!(mode(&dir.path().join("jwt_secret")), 0o600);
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic write must rename its temp file away"
        );
    }

    #[test]
    fn writing_replaces_the_old_secret_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/secret");
        write_secret_file(&path, b"first, longer value").unwrap();
        write_secret_file(&path, b"second").unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"second",
            "no tail of the old value"
        );
    }

    #[test]
    fn rotating_changes_the_key_and_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = ensure_jwt_secret(dir.path(), &conn()).unwrap();
        let rotated = rotate_jwt_secret(dir.path()).unwrap();
        assert_ne!(first, rotated);
        assert_eq!(fs::read(dir.path().join("jwt_secret")).unwrap(), rotated);
    }

    #[test]
    fn a_legacy_database_secret_moves_into_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = conn();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('jwt_secret', 'legacy-secret')",
            [],
        )
        .unwrap();
        let bytes = ensure_jwt_secret(dir.path(), &conn).unwrap();
        assert_eq!(bytes, b"legacy-secret");
        assert_eq!(
            fs::read(dir.path().join("jwt_secret")).unwrap(),
            b"legacy-secret"
        );
        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM meta WHERE key = 'jwt_secret'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "the database copy is removed once the file has it");
    }

    #[test]
    fn an_unreadable_jwt_secret_is_an_error_not_a_silent_new_key() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: reading it fails. The caller must
        // see that rather than quietly minting a key that signs everyone out.
        fs::create_dir(dir.path().join("jwt_secret")).unwrap();
        assert!(ensure_jwt_secret(dir.path(), &conn()).is_err());
    }
}
