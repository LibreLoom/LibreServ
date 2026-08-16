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
                .unwrap_or_else(|_| PathBuf::from("/var/lib/luna")),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("luna.db")
    }
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
}
