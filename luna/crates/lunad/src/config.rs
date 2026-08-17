use std::path::PathBuf;

/// Daemon configuration. Env-only for now (LUNA_ prefix), with sane
/// defaults. No YAML parser, no hot-reload — the smallest possible surface.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            host: std::env::var("LUNA_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            port: std::env::var("LUNA_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8090),
            data_dir: std::env::var("LUNA_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    // Root can use the production path; a developer running a
                    // plain `lunad` gets a disposable data dir instead of a
                    // permission error on /var/lib/luna.
                    if cfg!(unix) && libc_geteuid() == 0 {
                        PathBuf::from("/var/lib/luna")
                    } else {
                        home_data_dir()
                    }
                }),
        }
    }

    /// Overlay command-line flags on top of env-derived values so
    /// `lunad --port 9000 --data-dir /tmp/x` works the way people expect.
    /// Flags win; env vars still work when flags are absent.
    pub fn overlay_from_args(self) -> Self {
        self.overlay(std::env::args().skip(1))
    }

    /// Flag overlay against an explicit argument iterator (testable).
    fn overlay(mut self, args: impl Iterator<Item = String>) -> Self {
        let mut args = args;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--port" | "-p" => {
                    if let Some(v) = args.next().and_then(|v| v.parse().ok()) {
                        self.port = v;
                    }
                }
                "--host" | "-h" => {
                    if let Some(v) = args.next() {
                        self.host = v;
                    }
                }
                "--data-dir" | "-d" => {
                    if let Some(v) = args.next() {
                        self.data_dir = PathBuf::from(v);
                    }
                }
                "--help" => {
                    println!("lunad [--port N] [--host ADDR] [--data-dir DIR]");
                    println!(
                        "Defaults: 0.0.0.0:8090, data dir under your home (or /var/lib/luna as root)."
                    );
                    std::process::exit(0);
                }
                _ => { /* ignore unknown flags; env vars are authoritative */ }
            }
        }
        self
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("luna.db")
    }
}

fn home_data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".local/share/luna")
    } else {
        PathBuf::from(".luna-data")
    }
}

unsafe extern "C" {
    fn geteuid() -> u32;
}

fn libc_geteuid() -> u32 {
    unsafe { geteuid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let cfg = Config::from_env();
        assert!(!cfg.host.is_empty());
        assert!(cfg.port > 0);
        assert!(!cfg.data_dir.as_os_str().is_empty());
    }

    #[test]
    fn overlay_parses_flags() {
        let cfg = Config {
            host: "0.0.0.0".into(),
            port: 8090,
            data_dir: PathBuf::from("/tmp/a"),
        }
        .overlay(
            [
                "--port",
                "9000",
                "--data-dir",
                "/tmp/b",
                "--host",
                "127.0.0.1",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.data_dir, PathBuf::from("/tmp/b"));
        assert_eq!(cfg.db_path(), PathBuf::from("/tmp/b/luna.db"));
    }

    #[test]
    fn overlay_ignores_unknown_flags() {
        let cfg = Config {
            host: "0.0.0.0".into(),
            port: 8090,
            data_dir: PathBuf::from("/tmp/a"),
        }
        .overlay(["--bogus", "--port"].iter().map(|s| s.to_string()));
        // trailing --port with no value is ignored, keeping the default
        assert_eq!(cfg.port, 8090);
    }
}
