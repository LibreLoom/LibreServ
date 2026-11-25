//! The GRUB A/B menu Luna writes when it changes an operating-system slot.
//!
//! There is one renderer, and both the installer (`luna/os/lib/flash-disk.sh`)
//! and an update produce the same menu. An update rewrites it before it arms
//! the new slot, so a box whose menu still describes the older boot scheme —
//! an `initrd` line for a system that has no initramfs, or `noatime` in
//! `rootflags`, which ext4 rejects — comes back on the new slot instead of
//! rolling back forever.
//!
//! Slots are named by their GPT partition UUID, not by the partition label.
//! Every Luna disk carries the same labels, so `root=PARTLABEL=LUNA_A` could
//! start the wrong disk when a retired one is plugged in; the partition UUID
//! is random per install. The filesystem UUID stays in `luna.fsuuid=` because
//! the updater keeps each slot's UUID across a write.

use std::path::Path;

use crate::system::updates::UpdateError;

/// Where the menu is read from on the ESP. The second and third are copies the
/// installer leaves for firmware that cannot search the partition (Wyse).
pub const MENU_PATHS: [&str; 3] = [
    "grub/grub.cfg",
    "EFI/BOOT/grub.cfg",
    "EFI/BOOT/grub/grub.cfg",
];

/// One side of the A/B pair, as the menu names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotEntry {
    pub letter: char,
    /// The slot filesystem's UUID (`blkid -s UUID`, kept across updates).
    pub fs_uuid: String,
    /// The slot partition's GPT UUID (`blkid -s PARTUUID`, random per install).
    pub part_uuid: String,
}

impl SlotEntry {
    /// The kernel line for this slot. `rootflags=ro` only: the kernel hands
    /// the rest of `rootflags=` to ext4, which refuses `noatime` and then
    /// cannot mount its root at all. A read-only root has no atimes to update.
    fn linux_line(&self, kernel: &str) -> String {
        format!(
            "      linux /boot/{kernel} root=PARTUUID={} luna.fsuuid={} luna.slot={} rootfstype=ext4 rootflags=ro panic=10 quiet",
            self.part_uuid, self.fs_uuid, self.letter
        )
    }
}

/// Render the whole menu. `initrd` is only passed by a slot that ships one;
/// Luna's own image carries none, so the kernel finds its root and its drivers
/// built in.
pub fn render(a: &SlotEntry, b: &SlotEntry, kernel: &str, initrd: Option<&str>) -> String {
    let mut out = String::new();
    let mut line = |s: &str| out.push_str(&format!("{s}\n"));
    line("# Written by Luna. Every change of operating-system slot rewrites this,");
    line("# so the menu always describes the software it starts.");
    // No waiting on the menu: the box has no screen and nobody to press a key,
    // and a wrong slot rolls back on its own through fallback=1 and tryboot.
    line("set timeout=0");
    line("set default=0");
    line("set fallback=1");
    line("insmod part_gpt");
    line("insmod ext2");
    line("insmod fat");
    line("insmod search");
    line("insmod search_fs_uuid");
    line("insmod search_label");
    line("insmod loadenv");
    // Label search fails on some thin-client UEFI (Wyse) when $root is already
    // the ESP. Prefer the grubenv file that only exists on LUNAESP.
    line("search --no-floppy --file --set=esp /grub/grubenv");
    line("if [ -z \"$esp\" ]; then search --no-floppy --label LUNAESP --set=esp; fi");
    line("set envfile=($esp)/grub/grubenv");
    line("load_env -f $envfile");
    line("if [ -z \"$luna_slot\" ]; then set luna_slot=A; fi");
    line("if [ -z \"$luna_boot_ok\" ]; then set luna_boot_ok=1; fi");
    line("if [ -z \"$luna_tries\" ]; then set luna_tries=3; fi");
    // Failed boot: count down tries, then flip to the other slot.
    line("if [ \"$luna_boot_ok\" != \"1\" ]; then");
    line("  if [ \"$luna_tries\" = \"0\" ]; then");
    line("    if [ \"$luna_slot\" = \"B\" ]; then set luna_slot=A; else set luna_slot=B; fi");
    line("    set luna_boot_ok=1");
    line("    set luna_tries=3");
    line("    save_env -f $envfile luna_slot luna_boot_ok luna_tries");
    line("  elif [ \"$luna_tries\" = \"1\" ]; then");
    line("    set luna_tries=0");
    line("    save_env -f $envfile luna_tries");
    line("  elif [ \"$luna_tries\" = \"2\" ]; then");
    line("    set luna_tries=1");
    line("    save_env -f $envfile luna_tries");
    line("  else");
    line("    set luna_tries=2");
    line("    save_env -f $envfile luna_tries");
    line("  fi");
    line("fi");
    // Two entries: the slot GRUB picked, and the other as a fallback. If the
    // first cannot start at all, GRUB moves on by itself instead of waiting at
    // an error for a key nobody is there to press.
    for (name, when_b, when_a) in [("Luna", b, a), ("Luna (other system)", a, b)] {
        line(&format!("menuentry \"{name}\" {{"));
        line("    if [ \"$luna_slot\" = \"B\" ]; then");
        line(&format!(
            "      search --no-floppy --fs-uuid --set=root {}",
            when_b.fs_uuid
        ));
        line(&when_b.linux_line(kernel));
        line("    else");
        line(&format!(
            "      search --no-floppy --fs-uuid --set=root {}",
            when_a.fs_uuid
        ));
        line(&when_a.linux_line(kernel));
        line("    fi");
        if let Some(i) = initrd {
            line(&format!("      initrd /boot/{i}"));
        }
        line("}");
    }
    out
}

/// Write the menu everywhere the ESP holds one. `grub/grub.cfg` is created if
/// the ESP is missing it; the EFI copies are rewritten only when present, so a
/// freshly formatted ESP is not handed a menu it has no loader for.
pub fn write_to_esp(esp: &Path, text: &str) -> Result<(), UpdateError> {
    let main = esp.join(MENU_PATHS[0]);
    if let Some(dir) = main.parent() {
        std::fs::create_dir_all(dir).map_err(|_| {
            UpdateError::Other(
                "Luna couldn't read the boot partition, so the update was not activated.".into(),
            )
        })?;
    }
    for rel in MENU_PATHS {
        let path = esp.join(rel);
        if rel != MENU_PATHS[0] && !path.exists() {
            continue;
        }
        let failed = || {
            UpdateError::Other(
                "Luna couldn't write the startup menu, so the update was not activated.".into(),
            )
        };
        // Replace the file instead of truncating it. Truncating a file in
        // place on the boot partition's FAT can leave its cluster chain
        // inconsistent; the kernel then says "deleting FAT entry beyond EOF"
        // and sets the whole boot partition read-only, so every later update
        // fails. A new file and a rename never walk the old chain.
        let tmp = with_suffix(&path, ".new");
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&tmp, text).map_err(|e| {
            tracing::warn!(path = %tmp.display(), error = %e, "startup menu write failed");
            failed()
        })?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!(from = %tmp.display(), to = %path.display(), error = %e, "startup menu rename failed");
            let _ = std::fs::remove_file(&tmp);
            return Err(failed());
        }
        // Read back: a menu that did not land would leave the old startup
        // description in place and the next boot in the old slot.
        match std::fs::read_to_string(&path) {
            Ok(got) if got == text => {}
            Ok(got) => {
                tracing::warn!(
                    path = %path.display(),
                    wrote = text.len(),
                    read = got.len(),
                    "startup menu did not read back unchanged"
                );
                return Err(failed());
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "startup menu read back failed");
                return Err(failed());
            }
        }
    }
    Ok(())
}

/// `path` with `suffix` appended to its last component (`grub.cfg` → `grub.cfg.new`).
fn with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// The kernel file name inside a slot (`/boot/vmlinuz-lts`, or whatever the
/// single kernel there is). Both slots of one install come from one image, so
/// one name covers both entries.
pub fn kernel_name(boot_dir: &Path) -> Option<String> {
    let mut found: Vec<String> = std::fs::read_dir(boot_dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n.starts_with("vmlinuz"))
        .collect();
    found.sort();
    if found.iter().any(|n| n == "vmlinuz-lts") {
        return Some("vmlinuz-lts".into());
    }
    (found.len() == 1).then(|| found.remove(0))
}

/// The initramfs file in a slot, if it ships one.
pub fn initrd_name(boot_dir: &Path) -> Option<String> {
    let mut found: Vec<String> = std::fs::read_dir(boot_dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n.starts_with("initramfs") || n.starts_with("initrd"))
        .collect();
    found.sort();
    found.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(letter: char) -> SlotEntry {
        SlotEntry {
            letter,
            fs_uuid: format!("{letter}0000000-1111-2222-3333-444444444444"),
            part_uuid: format!("{letter}aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
        }
    }

    #[test]
    fn menu_starts_each_slot_by_partition_uuid() {
        let m = render(&slot('A'), &slot('B'), "vmlinuz-lts", None);
        assert!(m.contains(
            "linux /boot/vmlinuz-lts root=PARTUUID=Aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee luna.fsuuid=A0000000-1111-2222-3333-444444444444 luna.slot=A rootfstype=ext4 rootflags=ro panic=10 quiet"
        ));
        assert!(m.contains("root=PARTUUID=Baaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert!(!m.contains("PARTLABEL"), "labels are shared between disks");
        assert!(!m.contains("initrd"), "Luna's image has no initramfs");
        assert!(!m.contains("noatime"), "ext4 rejects noatime in rootflags");
        // Both entries, so GRUB can fall back without a key press.
        assert_eq!(m.matches("menuentry").count(), 2);
        assert_eq!(m.matches("rootflags=ro panic=10 quiet").count(), 4);
        assert!(m.contains("set fallback=1"));
    }

    #[test]
    fn menu_names_the_initramfs_only_when_the_slot_has_one() {
        let m = render(&slot('A'), &slot('B'), "vmlinuz-lts", Some("initramfs-lts"));
        assert_eq!(m.matches("initrd /boot/initramfs-lts").count(), 2);
    }

    #[test]
    fn kernel_and_initrd_names_come_from_the_slot() {
        let d = tempfile::tempdir().unwrap();
        assert!(kernel_name(d.path()).is_none());
        std::fs::write(d.path().join("config-lts"), "").unwrap();
        std::fs::write(d.path().join("vmlinuz-6.18.64"), "").unwrap();
        assert_eq!(kernel_name(d.path()).as_deref(), Some("vmlinuz-6.18.64"));
        std::fs::write(d.path().join("vmlinuz-lts"), "").unwrap();
        assert_eq!(kernel_name(d.path()).as_deref(), Some("vmlinuz-lts"));
        assert_eq!(initrd_name(d.path()), None);
        std::fs::write(d.path().join("initramfs-lts"), "").unwrap();
        assert_eq!(initrd_name(d.path()).as_deref(), Some("initramfs-lts"));
    }

    #[test]
    fn write_to_esp_fills_the_menu_everywhere_and_checks_it_landed() {
        let d = tempfile::tempdir().unwrap();
        let esp = d.path();
        let text = render(&slot('A'), &slot('B'), "vmlinuz-lts", None);
        // Only grub/ exists: that one is created, the EFI copies are left out.
        write_to_esp(esp, &text).unwrap();
        assert_eq!(
            std::fs::read_to_string(esp.join("grub/grub.cfg")).unwrap(),
            text
        );
        assert!(!esp.join("EFI/BOOT/grub.cfg").exists());
        // Once the installer's copies are there, an update refreshes them too.
        std::fs::create_dir_all(esp.join("EFI/BOOT/grub")).unwrap();
        for p in ["EFI/BOOT/grub.cfg", "EFI/BOOT/grub/grub.cfg"] {
            std::fs::write(esp.join(p), "old menu\n").unwrap();
        }
        write_to_esp(esp, &text).unwrap();
        for p in MENU_PATHS {
            assert_eq!(std::fs::read_to_string(esp.join(p)).unwrap(), text, "{p}");
        }
    }

    #[test]
    fn write_to_esp_replaces_a_longer_menu_without_leaving_a_copy() {
        // The boot partition is FAT: rewriting a file in place can corrupt its
        // cluster chain and freeze the whole partition read-only. A new file
        // and a rename must leave exactly the new menu behind.
        let d = tempfile::tempdir().unwrap();
        let esp = d.path();
        std::fs::create_dir_all(esp.join("grub")).unwrap();
        let old = "x".repeat(9000);
        std::fs::write(esp.join("grub/grub.cfg"), &old).unwrap();
        let text = render(&slot('A'), &slot('B'), "vmlinuz-lts", None);
        write_to_esp(esp, &text).unwrap();
        assert_eq!(
            std::fs::read_to_string(esp.join("grub/grub.cfg")).unwrap(),
            text
        );
        assert!(!esp.join("grub/grub.cfg.new").exists());
    }

    #[test]
    fn write_to_esp_refuses_a_menu_that_did_not_land() {
        let d = tempfile::tempdir().unwrap();
        let esp = d.path();
        // A directory where the menu belongs: the write cannot succeed, and
        // the update must not be armed.
        std::fs::create_dir_all(esp.join("grub/grub.cfg")).unwrap();
        let text = render(&slot('A'), &slot('B'), "vmlinuz-lts", None);
        assert!(write_to_esp(esp, &text).is_err());
    }
}
