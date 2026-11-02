//! Generation-specific local HTTP targets for the managed Tailscale node.
use std::collections::HashMap;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static TARGETS: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
static AUTHORITIES: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();

pub fn register(data: &Path, path: &Path) {
    TARGETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .insert(data.to_path_buf(), format!("unix:{}", path.display()));
}

pub fn target(data: &Path) -> Option<String> {
    TARGETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?
        .get(data)
        .cloned()
}

pub fn unregister(data: &Path) {
    if let Ok(mut targets) = TARGETS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        targets.remove(data);
    }
    set_authority(data, None);
}

pub fn set_authority(data: &Path, authority: Option<&str>) {
    if let Ok(mut values) = AUTHORITIES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        if let Some(authority) = authority {
            values.insert(data.to_path_buf(), authority.to_owned());
        } else {
            values.remove(data);
        }
    }
}

pub fn authority(data: &Path) -> Option<String> {
    AUTHORITIES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?
        .get(data)
        .cloned()
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.file_type().is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "remote-access directory is not private and owned by Luna",
        ));
    }
    Ok(())
}

fn protected_ancestry(path: &Path) -> std::io::Result<()> {
    let uid = unsafe { libc::geteuid() };
    let mut current = Some(path);
    while let Some(component) = current {
        let meta = std::fs::symlink_metadata(component)?;
        if !meta.file_type().is_dir()
            || (meta.uid() != 0 && meta.uid() != uid)
            || meta.mode() & 0o022 != 0
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "remote-access path has an unprotected ancestor",
            ));
        }
        current = component.parent().filter(|p| *p != component);
    }
    Ok(())
}

/// Create a fresh socket path that is never reused by a later process.
pub async fn bind(data: &Path) -> std::io::Result<(tokio::net::UnixListener, PathBuf)> {
    if !data.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "remote-access data path must be absolute",
        ));
    }
    protected_ancestry(data)?;
    private_directory(data)?;
    let parent = data.join("ts");
    match std::fs::DirBuilder::new().mode(0o700).create(&parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    private_directory(&parent)?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let generation = parent.join(name);
    let socket = generation.join("s");
    use std::os::unix::ffi::OsStrExt;
    if socket.as_os_str().as_bytes().len() >= 108 || socket.to_str().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "remote-access socket path is too long",
        ));
    }
    std::fs::DirBuilder::new().mode(0o700).create(&generation)?;
    let listener = tokio::net::UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, socket))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime_dir() -> std::path::PathBuf {
        let uid = unsafe { libc::geteuid() };
        let fallback: std::path::PathBuf = if uid == 0 {
            "/run".into()
        } else {
            format!("/run/user/{uid}").into()
        };
        let candidate = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| fallback.clone());
        if protected_ancestry(&candidate).is_ok() {
            candidate
        } else {
            fallback
        }
    }
    fn assert_fixture_ancestry(path: &Path) {
        if let Err(error) = protected_ancestry(path) {
            let components: Vec<_> = path
                .ancestors()
                .map(|p| {
                    let meta = std::fs::symlink_metadata(p).unwrap();
                    format!(
                        "{} uid={} mode={:o}",
                        p.display(),
                        meta.uid(),
                        meta.mode() & 0o7777
                    )
                })
                .collect();
            panic!(
                "fixture uid={} ancestry rejected: {error}; {}",
                unsafe { libc::geteuid() },
                components.join("; ")
            );
        }
    }
    #[tokio::test]
    async fn generations_are_private_and_never_reused() {
        let dir = tempfile::Builder::new()
            .prefix("ts-")
            .tempdir_in(runtime_dir())
            .unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_fixture_ancestry(dir.path());
        let (first, one) = bind(dir.path()).await.unwrap();
        let (second, two) = bind(dir.path()).await.unwrap();
        assert_ne!(one, two);
        assert_eq!(
            std::fs::metadata(one.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(std::fs::metadata(&one).unwrap().mode() & 0o777, 0o600);
        drop(first);
        assert!(tokio::net::UnixStream::connect(&one).await.is_err());
        assert!(tokio::net::UnixStream::connect(&two).await.is_ok());
        drop(second);
    }
    #[tokio::test]
    async fn rejects_symlink_parent_and_overlong_path() {
        let dir = tempfile::Builder::new()
            .prefix("ts-")
            .tempdir_in(runtime_dir())
            .unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_fixture_ancestry(dir.path());
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), dir.path().join("ts")).unwrap();
        assert!(bind(dir.path()).await.is_err());
        let long = dir.path().join("x".repeat(90));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&long)
            .unwrap();
        assert_eq!(
            bind(&long).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[tokio::test]
    async fn rejects_writable_ancestor() {
        let parent = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        std::fs::set_permissions(parent.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        let data = parent.path().join("data");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&data)
            .unwrap();
        assert_eq!(
            bind(&data).await.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
}
