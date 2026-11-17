//! Where the editor packs live.
//!
//! EuroOffice and draw.io are program files, not user data: they ship inside
//! the OS image (`/usr/share/luna/<pack>`) with the rest of the system, and an
//! update replaces the whole image. Nothing executable belongs on the data
//! partition.
//!
//! Data-directory packs are supported only outside Luna OS for development.
//! An appliance uses the image even when a pack is missing: report the broken
//! image instead of silently running a different version from writable data.

use std::path::{Path, PathBuf};

/// The image's pack root. Overridable for tests and dev runs.
pub const IMAGE_PACK_ROOT: &str = "/usr/share/luna";

/// Root that holds the pack folders.
pub fn root() -> PathBuf {
    std::env::var_os("LUNA_PACK_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(IMAGE_PACK_ROOT))
}

/// The appliance marker is baked into every Luna OS slot.
pub(crate) fn on_luna_os() -> bool {
    Path::new("/etc/luna-os-release").is_file()
}

/// Where the search models are: the image's `models/` folder, or on a dev
/// machine `$LUNA_DATA_DIR/models` (`make models`) when the image has none.
pub fn models_dir() -> PathBuf {
    let image = root().join("models");
    if image.is_dir() || on_luna_os() {
        return image;
    }
    match std::env::var_os("LUNA_DATA_DIR") {
        Some(data) if PathBuf::from(&data).join("models").is_dir() => {
            PathBuf::from(data).join("models")
        }
        _ => image,
    }
}

/// Directory of one pack (`eurooffice`, `drawio`), whichever copy exists.
///
/// The image is authoritative on Luna OS. Outside the appliance, the image's
/// copy wins when present and a data-dir copy is honoured next. When
/// neither exists the answer depends on where packs are supposed to live: the
/// image on a Luna OS box (so a missing pack is reported against its real
/// home), the data dir everywhere else, which is what a dev run and the tests
/// have.
pub fn dir(data_dir: &Path, pack: &str) -> PathBuf {
    if on_luna_os() {
        return root().join(pack);
    }
    dir_in(&root(), data_dir, pack)
}

/// [`dir`] against an explicit image root, so a test never has to touch the
/// process environment (which every other test in this binary shares).
fn dir_in(image_root: &Path, data_dir: &Path, pack: &str) -> PathBuf {
    let image = image_root.join(pack);
    if image.is_dir() {
        return image;
    }
    let legacy = data_dir.join(pack);
    if legacy.is_dir() {
        return legacy;
    }
    if image_root.is_dir() { image } else { legacy }
}

/// True when the pack is present anywhere Luna looks.
pub fn present(data_dir: &Path, pack: &str) -> bool {
    dir(data_dir, pack).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_copy_wins_and_data_dir_is_the_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        std::fs::create_dir_all(data.join("drawio")).unwrap();
        let image = tmp.path().join("image");
        // Only the data dir has it: the old location still works.
        assert_eq!(dir_in(&image, &data, "drawio"), data.join("drawio"));
        assert!(dir_in(&image, &data, "drawio").is_dir());

        // The image copy takes over once it is there.
        std::fs::create_dir_all(image.join("drawio")).unwrap();
        assert_eq!(dir_in(&image, &data, "drawio"), image.join("drawio"));

        // Neither, and the image root exists: report the image, its real home.
        assert_eq!(
            dir_in(&image, &data, "eurooffice"),
            image.join("eurooffice")
        );
        assert!(!dir_in(&image, &data, "eurooffice").is_dir());

        // Neither, and there is no image root (a dev run): the data dir.
        std::fs::remove_dir_all(&image).unwrap();
        assert_eq!(dir_in(&image, &data, "eurooffice"), data.join("eurooffice"));
    }
}
