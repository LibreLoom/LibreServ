//! Web fonts whose bodies already live in EuroOffice's `core-fonts/`.
//!
//! `allfontsgen` writes `fonts/NNN` as a 32-byte header followed by a copy of
//! a TTF from `core-fonts/`. The image used to ship both copies. The pack
//! build now keeps only the headers in `fonts/aliases.json` and drops the
//! duplicate bodies; this module rebuilds the exact original bytes on the
//! way out, so an editor request for `/fonts/NNN` is unchanged.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    version: u32,
    fonts: HashMap<String, Alias>,
}

#[derive(Deserialize)]
struct Alias {
    src: String,
    head: String,
}

#[derive(Clone)]
struct Entry {
    header: Vec<u8>,
    source: PathBuf,
}

struct Cache {
    dir: PathBuf,
    aliases: HashMap<String, Entry>,
}

static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

/// Look up one alias. The cache is keyed by pack directory so a dev run with
/// `LUNA_PACK_ROOT` pointing somewhere else reloads instead of serving the
/// previous pack's fonts.
fn alias_for(pack_dir: &Path, name: &str) -> Option<Entry> {
    let mut slot = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_none_or(|c| c.dir != pack_dir) {
        let path = pack_dir.join("fonts").join("aliases.json");
        let raw = std::fs::read(&path).ok()?;
        let manifest: Manifest = serde_json::from_slice(&raw).ok()?;
        if manifest.version != 1 {
            return None;
        }
        let mut aliases = HashMap::with_capacity(manifest.fonts.len());
        for (name, alias) in manifest.fonts {
            let Ok(header) = base64::engine::general_purpose::STANDARD.decode(alias.head) else {
                continue;
            };
            if header.len() != 32 {
                continue;
            }
            // Reject absolute paths and `..` components before joining.
            let rel = Path::new(&alias.src);
            if rel.is_absolute() || rel.components().any(|c| c == Component::ParentDir) {
                continue;
            }
            let source = pack_dir.join(rel);
            if !source.is_file() {
                continue;
            }
            aliases.insert(name, Entry { header, source });
        }
        *slot = Some(Cache {
            dir: pack_dir.to_path_buf(),
            aliases,
        });
    }
    slot.as_ref()?.aliases.get(name).cloned()
}

/// Return the original bytes for an aliased font, or `None` when the name is a
/// real file in `fonts/` (or no manifest exists). Callers fall back to the
/// normal static-file handler in that case.
pub async fn synth(pack_dir: &Path, name: &str) -> Option<Vec<u8>> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    let entry = alias_for(pack_dir, name)?;
    let body = tokio::fs::read(&entry.source).await.ok()?;
    let mut out = Vec::with_capacity(entry.header.len() + body.len());
    out.extend_from_slice(&entry.header);
    out.extend_from_slice(&body);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn synthesizes_the_original_bytes_and_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        std::fs::create_dir_all(pack.join("core-fonts/sub")).unwrap();
        std::fs::create_dir_all(pack.join("fonts")).unwrap();
        let body = vec![7u8; 64];
        std::fs::write(pack.join("core-fonts/sub/real.ttf"), &body).unwrap();
        let header = vec![3u8; 32];
        let manifest = serde_json::json!({
            "version": 1,
            "fonts": {
                "024": {
                    "src": "core-fonts/sub/real.ttf",
                    "head": base64::engine::general_purpose::STANDARD.encode(&header),
                },
                "evil": {
                    "src": "../outside.ttf",
                    "head": base64::engine::general_purpose::STANDARD.encode(&header),
                }
            }
        });
        std::fs::write(
            pack.join("fonts/aliases.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let got = synth(pack, "024").await.unwrap();
        let mut want = header.clone();
        want.extend_from_slice(&body);
        assert_eq!(got, want);
        assert!(synth(pack, "evil").await.is_none());
        assert!(synth(pack, "000").await.is_none());
        assert!(synth(pack, "../024").await.is_none());
    }
}
