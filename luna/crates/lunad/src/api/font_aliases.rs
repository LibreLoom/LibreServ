//! Web fonts whose bodies already live in EuroOffice's `core-fonts/`.
//!
//! `allfontsgen` copies a TTF from `core-fonts/` into `fonts/NNN`, then masks
//! its first min(32, size) bytes in place. Both files are the same length;
//! only those first bytes differ. The image used to ship both copies. The pack
//! build now keeps only the masked bytes in `fonts/aliases.json` and drops the
//! generated copy; this module rebuilds the generated web font on the way out
//! (masked prefix followed by the core-font tail), so an editor request for
//! `/fonts/NNN` is byte-for-byte unchanged.

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
    sha256: String,
}

#[derive(Clone)]
struct Entry {
    header: Vec<u8>,
    source: PathBuf,
    /// ETag of the exact bytes this entry serves, from the pack manifest.
    etag: String,
}

struct Cache {
    dir: PathBuf,
    manifest_mtime: Option<std::time::SystemTime>,
    aliases: HashMap<String, Entry>,
}

static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

/// Look up one alias. The cache is keyed by pack directory and the manifest's
/// mtime, so a dev rebuilding a pack in place reloads instead of serving a
/// hybrid of the old header and the new source tail.
fn alias_for(pack_dir: &Path, name: &str) -> Option<Entry> {
    let mut slot = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let path = pack_dir.join("fonts").join("aliases.json");
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok());
    if slot
        .as_ref()
        .is_none_or(|c| c.dir != pack_dir || c.manifest_mtime != mtime)
    {
        // Cache a miss too: a pack with no aliases.json must not re-read it on
        // every font request.
        let mut aliases = HashMap::new();
        if let Ok(raw) = std::fs::read(&path)
            && let Ok(manifest) = serde_json::from_slice::<Manifest>(&raw)
            && manifest.version == 1
        {
            aliases.reserve(manifest.fonts.len());
            for (name, alias) in manifest.fonts {
                let Ok(header) = base64::engine::general_purpose::STANDARD.decode(alias.head)
                else {
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
                if alias.sha256.len() != 64 || !alias.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    continue;
                }
                let source = pack_dir.join(rel);
                if !source.is_file() {
                    continue;
                }
                aliases.insert(
                    name,
                    Entry {
                        header,
                        source,
                        etag: format!("\"{}\"", alias.sha256),
                    },
                );
            }
        }
        *slot = Some(Cache {
            dir: pack_dir.to_path_buf(),
            manifest_mtime: mtime,
            aliases,
        });
    }
    slot.as_ref()?.aliases.get(name).cloned()
}

/// ETag of the bytes `synth` would return, without reading the font. The pack
/// build computed it from the generated file, so a conditional request can
/// answer 304 without touching the eMMC.
pub fn etag_for(pack_dir: &Path, name: &str) -> Option<String> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    alias_for(pack_dir, name).map(|entry| entry.etag)
}

/// Length of the font an alias would serve, from the source file's metadata.
/// A HEAD request can use this without reading the TTF from the eMMC.
pub fn source_len_for(pack_dir: &Path, name: &str) -> Option<u64> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    let entry = alias_for(pack_dir, name)?;
    std::fs::metadata(entry.source).ok().map(|m| m.len())
}

/// Return the generated web font for an alias, or `None` when the name is a
/// real file in `fonts/` (or no manifest exists). Callers fall back to the
/// normal static-file handler in that case.
pub async fn synth(pack_dir: &Path, name: &str) -> Option<Vec<u8>> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    let entry = alias_for(pack_dir, name)?;
    let mut body = tokio::fs::read(&entry.source).await.ok()?;
    if body.len() < entry.header.len() {
        return None;
    }
    // The source keeps its original first bytes; only the generated copy had
    // them masked. Splice the masked prefix in place rather than allocating a
    // second full-size Vec for every font request on the 2 GiB box.
    body[..entry.header.len()].copy_from_slice(&entry.header);
    Some(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_hash(data: &[u8]) -> String {
        use sha2::Digest as _;
        format!("{:x}", sha2::Sha256::digest(data))
    }

    #[tokio::test]
    async fn synthesizes_the_generated_web_font_and_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let pack = root.join("pack");
        std::fs::create_dir_all(pack.join("core-fonts/sub")).unwrap();
        std::fs::create_dir_all(pack.join("fonts")).unwrap();
        // This file exists, so the traversal alias can only be refused by the
        // ParentDir guard, not by a missing source file.
        std::fs::write(root.join("outside.ttf"), &vec![9u8; 64]).unwrap();
        // allfontsgen's real layout: same length as the source, first 32 bytes
        // XOR-masked in place.
        let source = vec![7u8; 64];
        let mut generated = source.clone();
        for byte in generated.iter_mut().take(32) {
            *byte ^= 0xa5;
        }
        std::fs::write(pack.join("core-fonts/sub/real.ttf"), &source).unwrap();
        let head = base64::engine::general_purpose::STANDARD.encode(&generated[..32]);
        let hash = hex_hash(&generated);
        let manifest = serde_json::json!({
            "version": 1,
            "fonts": {
                "024": { "src": "core-fonts/sub/real.ttf", "head": head, "sha256": hash },
                "evil": { "src": "../outside.ttf", "head": head, "sha256": hex_hash(&generated) }
            }
        });
        std::fs::write(
            pack.join("fonts/aliases.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert_eq!(
            etag_for(&pack, "024"),
            Some(format!("\"{}\"", hex_hash(&generated)))
        );
        let got = synth(&pack, "024").await.unwrap();
        assert_eq!(got.len(), source.len());
        assert_eq!(got, generated);
        assert!(synth(&pack, "evil").await.is_none());
        assert!(synth(&pack, "000").await.is_none());
        assert!(synth(&pack, "../024").await.is_none());
    }
}
