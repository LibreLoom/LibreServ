//! What a drive's filesystem will and won't hold, decided per drive.
//!
//! Luna formats every plain drive as exFAT, and adopts FAT32 sticks as they
//! are. Both refuse names that ext4 happily takes (`: * ? " < > | \`, control
//! characters, a trailing dot), treat `Photo.jpg` and `photo.jpg` as one name,
//! and FAT32 caps a file at 4 GB. The kernel's own answer to a bad name is a
//! bare `EINVAL`, which would reach the person as "Luna can't open that path".
//! Everything that makes a name on a drive asks [`FsRules`] first, before any
//! byte is written, and a refusal names the character.
//!
//! The rules come from the filesystem that really holds the drive
//! (`/proc/mounts`), not from a guess, so an ext4 drive keeps every character.

use std::path::Path;

/// What one filesystem can't do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FsRules {
    /// Names may not hold `: * ? " < > | \`, control characters, or end in a
    /// dot or space (exFAT, FAT).
    pub reserved_chars: bool,
    /// `a` and `A` are the same name (exFAT, FAT).
    pub case_insensitive: bool,
    /// Largest file the filesystem can hold (FAT32: 4 GiB - 1).
    pub max_file: Option<u64>,
}

/// FAT32's biggest file: 4 GiB minus one byte.
pub const FAT32_MAX_FILE: u64 = 4 * 1024 * 1024 * 1024 - 1;

/// The characters exFAT and FAT refuse in a name (besides `/`, which no
/// filesystem allows, and control characters, handled separately).
pub const RESERVED_CHARS: [char; 9] = [':', '*', '?', '"', '<', '>', '|', '\\', '/'];

impl FsRules {
    /// No limits: ext4 and friends.
    pub const NONE: FsRules = FsRules {
        reserved_chars: false,
        case_insensitive: false,
        max_file: None,
    };

    /// The rules of a filesystem type as `/proc/mounts` or `blkid` names it.
    ///
    /// `fuseblk` is what `/proc/mounts` shows for any filesystem driven
    /// through FUSE (exfat-fuse, ntfs-3g); the real type is not visible there.
    /// It gets the exFAT rules, the stricter guess: on an ntfs-3g drive that
    /// only refuses some names it would have taken. Backups choose the same
    /// way (`drive_store::limits_for_fs`). Luna OS mounts exFAT and NTFS with
    /// the kernel drivers, so it never sees `fuseblk`.
    pub fn for_fs(fstype: &str) -> FsRules {
        match fstype.trim().to_ascii_lowercase().as_str() {
            "exfat" | "fuseblk" => FsRules {
                reserved_chars: true,
                case_insensitive: true,
                max_file: None,
            },
            "vfat" | "fat" | "fat32" | "msdos" => FsRules {
                reserved_chars: true,
                case_insensitive: true,
                max_file: Some(FAT32_MAX_FILE),
            },
            _ => FsRules::NONE,
        }
    }

    /// True when any rule applies, so callers can skip work on ext4.
    pub fn is_restricted(&self) -> bool {
        *self != FsRules::NONE
    }

    /// Check one file or folder name (not a path) before creating it.
    pub fn check_name(&self, name: &str) -> Result<(), NameProblem> {
        if !self.reserved_chars {
            return Ok(());
        }
        for ch in name.chars() {
            if ch.is_control() {
                return Err(NameProblem::ControlChar {
                    name: name.to_string(),
                });
            }
            if RESERVED_CHARS.contains(&ch) {
                return Err(NameProblem::Char {
                    ch,
                    name: name.to_string(),
                });
            }
        }
        // The kernel's exFAT and FAT drivers quietly drop a trailing dot or
        // space, so the file would be saved under a name nobody asked for.
        if name.ends_with('.') || name.ends_with(' ') {
            return Err(NameProblem::Trailing {
                name: name.to_string(),
            });
        }
        Ok(())
    }

    /// Check that a file is small enough for this filesystem.
    pub fn check_size(&self, name: &str, size: u64) -> Result<(), NameProblem> {
        match self.max_file {
            Some(max) if size > max => Err(NameProblem::TooBig {
                name: name.to_string(),
            }),
            _ => Ok(()),
        }
    }

    /// The key two names must differ by to be different on this filesystem.
    pub fn name_key(&self, name: &str) -> String {
        if self.case_insensitive {
            name.to_lowercase()
        } else {
            name.to_string()
        }
    }
}

/// Why a name can't go on a drive, in words a person can act on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameProblem {
    #[error("Names on this drive can't contain \"{ch}\". Remove it from \"{name}\" and try again.")]
    Char { ch: char, name: String },
    #[error(
        "Names on this drive can't contain hidden control characters. Rename \"{name}\" and try again."
    )]
    ControlChar { name: String },
    #[error(
        "Names on this drive can't end with a dot or a space. Remove it from \"{name}\" and try again."
    )]
    Trailing { name: String },
    #[error(
        "\"{a}\" and \"{b}\" differ only in capital letters, and this drive treats them as the same name. Rename one and try again."
    )]
    CaseClash { a: String, b: String },
    #[error("\"{name}\" is too big for this drive's format (largest 4 GB).")]
    TooBig { name: String },
}

impl NameProblem {
    /// The `code` the API sends so a client can tell the refusals apart.
    pub fn code(&self) -> &'static str {
        match self {
            NameProblem::Char { .. }
            | NameProblem::ControlChar { .. }
            | NameProblem::Trailing { .. } => "bad_name",
            NameProblem::CaseClash { .. } => "name_case_clash",
            NameProblem::TooBig { .. } => "file_too_big_for_drive",
        }
    }
}

impl From<NameProblem> for super::FilesError {
    fn from(p: NameProblem) -> Self {
        super::FilesError::Io(std::io::Error::new(std::io::ErrorKind::InvalidFilename, p))
    }
}

/// The name problem hiding inside an I/O error, when that is what it is.
pub fn problem_of(e: &std::io::Error) -> Option<&NameProblem> {
    e.get_ref()?.downcast_ref::<NameProblem>()
}

/// The rules of the filesystem holding `path`: the most specific mount in
/// `/proc/mounts` that contains it. Unknown gives no limits.
pub fn rules_at(path: &Path) -> FsRules {
    #[cfg(test)]
    if let Some(forced) = forced_rules(path) {
        return forced;
    }
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return FsRules::NONE;
    };
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    rules_from_mounts(&mounts, &path)
}

/// [`rules_at`] on mount table text, so it can be tested.
pub fn rules_from_mounts(mounts: &str, path: &Path) -> FsRules {
    FsRules::for_fs(&crate::backup::drive_store::fs_type_at(mounts, path).unwrap_or_default())
}

/// Case-only rename: is `to` the very entry `from` already is, spelled with
/// other capitals? On exFAT the OS answers "that name is taken" for such a
/// rename, because the new spelling finds the old entry.
pub fn is_case_only_change(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    if from == to || from.parent() != to.parent() {
        return false;
    }
    let (Some(a), Some(b)) = (
        from.file_name().and_then(|n| n.to_str()),
        to.file_name().and_then(|n| n.to_str()),
    ) else {
        return false;
    };
    if a == b || a.to_lowercase() != b.to_lowercase() {
        return false;
    }
    match (from.symlink_metadata(), to.symlink_metadata()) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

/// Rename an entry to the same name in other capitals. Tries a plain rename
/// first and checks the folder to see that the spelling really changed; when
/// the drive treated it as a no-op, goes through a hidden temporary name and
/// puts the old name back if the second step fails.
pub fn rename_case_only(from: &Path, to: &Path) -> std::io::Result<()> {
    let parent = to.parent().unwrap_or_else(|| Path::new("."));
    let want = to
        .file_name()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?
        .to_os_string();
    let spelled_right = || -> bool {
        std::fs::read_dir(parent)
            .map(|rd| rd.flatten().any(|e| e.file_name() == want))
            .unwrap_or(false)
    };
    std::fs::rename(from, to)?;
    if spelled_right() {
        return Ok(());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".case-{nonce}.part"));
    std::fs::rename(from, &temp)?;
    if let Err(e) = std::fs::rename(&temp, to) {
        let _ = std::fs::rename(&temp, from);
        return Err(e);
    }
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Names under one folder that would collide on this filesystem, and names it
/// can't hold, found before anything is copied. `names` are the real names of
/// one folder's children; `Err` names the first problem.
pub fn check_siblings<'a>(
    rules: &FsRules,
    names: impl IntoIterator<Item = &'a str>,
) -> Result<(), NameProblem> {
    let mut seen: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
    for name in names {
        rules.check_name(name)?;
        if rules.case_insensitive
            && let Some(first) = seen.insert(rules.name_key(name), name)
            && first != name
        {
            return Err(NameProblem::CaseClash {
                a: first.to_string(),
                b: name.to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
static FORCED: std::sync::Mutex<Vec<(std::path::PathBuf, FsRules)>> =
    std::sync::Mutex::new(Vec::new());

/// Make every path under `root` answer with `rules`, as if a drive of that
/// format were mounted there. Tests use fresh temp dirs, so entries never
/// collide.
#[cfg(test)]
pub fn force_rules_for_tests(root: &Path, rules: FsRules) {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    FORCED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((root, rules));
}

#[cfg(test)]
fn forced_rules(path: &Path) -> Option<FsRules> {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    FORCED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(root, _)| path.starts_with(root))
        .map(|(_, r)| *r)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXFAT: FsRules = FsRules {
        reserved_chars: true,
        case_insensitive: true,
        max_file: None,
    };

    #[test]
    fn exfat_refuses_each_reserved_character_and_names_it() {
        for ch in [':', '*', '?', '"', '<', '>', '|', '\\'] {
            let name = format!("a{ch}b.txt");
            let err = EXFAT.check_name(&name).unwrap_err();
            assert_eq!(err.code(), "bad_name");
            assert!(err.to_string().contains(ch), "{err}");
            assert!(err.to_string().contains(&name), "{err}");
        }
    }

    #[test]
    fn exfat_refuses_control_characters_and_trailing_dots_and_spaces() {
        let e = EXFAT.check_name("tab\there").unwrap_err();
        assert!(matches!(e, NameProblem::ControlChar { .. }));
        assert!(EXFAT.check_name("dot.").is_err());
        assert!(EXFAT.check_name("space ").is_err());
        let e = EXFAT.check_name("dot.").unwrap_err();
        assert!(e.to_string().contains("end with a dot or a space"));
    }

    #[test]
    fn exfat_takes_ordinary_names() {
        for name in [
            "Photo.jpg",
            ".hidden",
            "a b (1).txt",
            "résumé – final.docx",
            "日本語.txt",
            "dots..inside",
        ] {
            assert!(EXFAT.check_name(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn ext4_takes_every_character() {
        assert!(FsRules::NONE.check_name("a:b*c?.txt").is_ok());
        assert!(FsRules::NONE.check_name("ends with dot.").is_ok());
        assert!(!FsRules::NONE.is_restricted());
    }

    #[test]
    fn rules_follow_the_filesystem_type() {
        assert!(FsRules::for_fs("exfat").reserved_chars);
        assert!(FsRules::for_fs("EXFAT").case_insensitive);
        assert_eq!(FsRules::for_fs("vfat").max_file, Some(FAT32_MAX_FILE));
        assert_eq!(FsRules::for_fs("ext4"), FsRules::NONE);
        assert_eq!(FsRules::for_fs(""), FsRules::NONE);
    }

    #[test]
    fn rules_come_from_the_mount_holding_the_path() {
        let mounts =
            "/dev/sda2 / ext4 rw 0 0\n/dev/sdb1 /var/lib/luna/mounts/drives/x exfat rw 0 0\n";
        let on_drive = Path::new("/var/lib/luna/mounts/drives/x/Photos");
        assert!(rules_from_mounts(mounts, on_drive).reserved_chars);
        assert_eq!(
            rules_from_mounts(mounts, Path::new("/var/lib/luna/other")),
            FsRules::NONE
        );
    }

    #[test]
    fn fat_refuses_files_over_four_gigabytes() {
        let fat = FsRules::for_fs("vfat");
        assert!(fat.check_size("a.bin", FAT32_MAX_FILE).is_ok());
        let err = fat.check_size("big.bin", FAT32_MAX_FILE + 1).unwrap_err();
        assert_eq!(err.code(), "file_too_big_for_drive");
        assert!(EXFAT.check_size("big.bin", u64::MAX).is_ok());
    }

    #[test]
    fn siblings_that_differ_only_in_capitals_clash_on_exfat_only() {
        let err = check_siblings(&EXFAT, ["Photo.jpg", "photo.jpg"]).unwrap_err();
        assert_eq!(err.code(), "name_case_clash");
        assert!(err.to_string().contains("Photo.jpg"));
        assert!(err.to_string().contains("photo.jpg"));
        assert!(check_siblings(&FsRules::NONE, ["Photo.jpg", "photo.jpg"]).is_ok());
        assert!(check_siblings(&EXFAT, ["a.txt", "b.txt"]).is_ok());
    }

    #[test]
    fn a_name_problem_survives_the_trip_through_an_io_error() {
        let err: crate::files::FilesError = NameProblem::Char {
            ch: ':',
            name: "a:b".into(),
        }
        .into();
        let crate::files::FilesError::Io(e) = err else {
            panic!("expected an io error");
        };
        assert_eq!(e.kind(), std::io::ErrorKind::InvalidFilename);
        assert!(matches!(
            problem_of(&e),
            Some(NameProblem::Char { ch: ':', .. })
        ));
    }

    #[test]
    fn case_only_rename_changes_the_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("photo.jpg");
        std::fs::write(&from, b"x").unwrap();
        // Another name for the same entry stands in for exFAT's lookup.
        let to = dir.path().join("Photo.jpg");
        assert!(!is_case_only_change(&from, &to), "a free name is not one");
        rename_case_only(&from, &to).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Photo.jpg".to_string()]);
    }

    #[test]
    fn case_only_detection_needs_the_same_entry() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let upper = dir.path().join("A.TXT");
        std::fs::write(&a, b"1").unwrap();
        std::fs::write(&upper, b"2").unwrap();
        // Two different files on a case-sensitive disk: not the same entry.
        assert!(!is_case_only_change(&a, &upper));
        // A hard link is the same entry under another name, but the names
        // must also match apart from capitals.
        let link = dir.path().join("b.txt");
        std::fs::hard_link(&a, &link).unwrap();
        assert!(!is_case_only_change(&a, &link));
    }
}
