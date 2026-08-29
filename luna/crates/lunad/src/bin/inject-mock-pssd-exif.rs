//! Inject kamadak-compatible EXIF into mock PSSD JPEG fixtures.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    path: String,
    datetime: String,
    lat: Option<f64>,
    lon: Option<f64>,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mock-pssd")
}

fn main() -> anyhow::Result<()> {
    let root = fixture_root();
    let manifest_path = root.join(".photo-manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| anyhow::anyhow!("read {manifest_path:?}: {e}"))?;
    let entries: Vec<ManifestEntry> = serde_json::from_str(&raw)?;
    let mut injected = 0u32;
    for entry in entries {
        let path = root.join(&entry.path);
        if !path.is_file() {
            anyhow::bail!("manifest entry missing on disk: {}", entry.path);
        }
        let gps = match (entry.lat, entry.lon) {
            (Some(lat), Some(lon)) => Some((lat, lon)),
            _ => None,
        };
        lunad::fixture_exif::inject_exif_jpeg(&path, &entry.datetime, gps)?;
        injected += 1;
    }
    eprintln!(
        "injected EXIF into {injected} JPEG(s) under {}",
        root.display()
    );
    Ok(())
}
