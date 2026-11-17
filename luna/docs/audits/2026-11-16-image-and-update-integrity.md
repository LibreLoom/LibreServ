# Luna image and update integrity — 2026-11-16

Scope: source review of the Luna release graph, development image wrappers,
rootfs assembly, editor/model locations, and A/B updater. No published release
was unpacked, and no device or virtual machine was booted during this review.
The screenshot's four warnings are consistent with missing packs; its device
and release have not been independently identified.

## Confirmed defects and changes

| Defect | Effect | Change |
| --- | --- | --- |
| `035.frag` sorted between an `else` at the end of `03.frag` and its body in `04.frag` | All editor/model installation and required-pack checks ran only when root was absent from `/etc/shadow`. Alpine normally has root already. | Move installation to `05.frag`, after the account block, and add a regression case for both root-shadow branches. |
| OS cache key omitted the application source and version; a cut accepted any release-version daemon | A newly built daemon/UI could be discarded in favor of an old image and installer. | Include commit and version in the image key; require the exact cached daemon version. The installer key inherits the image identity. |
| Development skip hash excluded the daemon and UI sources | `build-iso.sh` could skip web, daemon, rootfs and image after application edits. | Include application/UI sources and version when the checkout is available. Release jobs mount only OS sources and use the outer commit/version key. |
| Pack/model lookup fell back to writable data directories; tunnel lookup accepted a data-directory binary before checking appliance mode | Software could run from the data partition rather than the active image. | Appliance pack/model lookup uses the image; appliance tunnel lookup skips the data-directory binary. Existing download code was already blocked on Luna OS. Development fallbacks remain. |
| Apply could succeed with `os_needed=false` | A newer feed could produce a success response and restart without changing software, including with a missing installed hash or a failed/pending image. | Refuse apply when there is no image to write. Add regression coverage for these cases. |
| Boot confirmation searched only `/dev/disk/by-label/LUNAESP` | mdev need not create that symlink, leaving the boot unconfirmed and failed-start reboots unavailable. | Resolve GPT partition names with blkid and require the same parent disk as the current root slot. |

## Build contract

Every rootfs now requires all three packs and their checksums. Pack installation
is unconditional and decompression errors stop the build. An independent
`build/validate-rootfs.sh` runs after assembly and before image packaging. It checks:

- Kernel and initramfs; daemon, console, tunnel program and photo-search runner.
- Office entry point, conversion engine, all three editor engines and fonts;
  diagram entry point and marker; both search model sets and tokenizers.
- Required helper commands inside the target filesystem, including updater,
  drive, OCR and media tools; startup of key dynamically linked programs.
- Both ONNX encoders loading against the image's runtime libraries.
- Absence of software directories in the image's data mountpoint.

The validator runs in the rootless build container. It has been added to the
pipeline but was not executed against a newly assembled rootfs in this review.

The daemon build already checks its musl binaries and checks that the expected
web source key appears in the finished binary. That did not protect against the
outer image cache selecting an older complete image.

## Storage and update model

The intended image contains lunad with its embedded UI, luna-console,
cloudflared, luna-clip, OS packages, editor packs and search models. Runtime state
includes accounts, keys, settings, device binding, database/indexes, document
conversion results, logs, clock drift, and update bookkeeping. Update downloads
are temporary staging files under the data directory and are removed after an
ordinary success or failure; a crash can leave a staging file behind. They are
not an installed software path.

The updater verifies the signed feed and downloaded image's size and SHA-256,
writes the inactive slot on the boot disk, checks ext4, restores the UUID pinned
in GRUB, and arms tryboot. The installed hash is recorded only after a later boot
confirms success; falling back records the failed image. The installer carries
the same compressed image bytes as OTA. These are source findings, not evidence
of a successful physical update.

## Limits and remaining concerns

- The new image must be built and booted before its dependencies, feature checks,
  slot capacity, and update/rollback behavior can be considered verified.
- Follow-up: slot preparation now flushes the completed device before activation.
  Activation persists and flushes the pending record first, then prepares all
  three GRUB settings in a temporary environment and replaces the live file
  only after flushing it. The containing directories are flushed too. Failed
  preparation retains the old boot settings; an uncertain commit retains the
  pending record. Installed-hash settlement uses the same durable-write helper.
  A cut before boot selection changes is conservatively recorded as a failed
  update on the next boot and can be retried from the existing UI.
- The replacement relies on filesystem rename behavior and the storage device
  honoring flushes. The ESP is FAT, not a journaled filesystem; no claim of
  arbitrary power-failure immunity or physical cut-power validation is made.
  Bootloader-driven try-count writes and boot confirmation remain separate
  from this application-side handoff fix.
- Boot confirmation checks HTTP liveness, not every feature's health. The new
  build validator catches missing software earlier, but does not replace a boot
  and feature exercise of the release artifact.
- Root remount now fails the boot service if read-only mounting fails, so
  lunad cannot proceed on a writable root. The development rootfs also records
  its input hash; image packaging refuses to stamp a stale rootfs as current.
- Alpine package versions resolve at build time against the selected Alpine
  branch. The base container and upstream packs are pinned, but the resulting
  OS package set is recorded rather than fully locked.
- Existing legacy software directories on an already installed data partition
  are not deleted by these changes; the appliance no longer selects them.

## Verification in this turn

`./ci check -r` selected no matching checks for this diff. Passed:

- Shell syntax for the changed scripts and concatenated rootfs body (`sh -n`).
- Rust formatting (`cargo fmt --all --check`).
- Rust library typechecking (`cargo check --locked -p lunad --lib`).
- Release-tool compilation (`go build ./cmd/release`).
- Go formatting and `git diff --check`.

The CI selector leaving these paths without static coverage remains a separate
tooling gap. Added regression tests were not run: repository instructions require
explicit authorization for test runs. The new rootfs validator, image assembly,
boot, update and rollback remain unverified against an actual artifact. No
release was published or installed.

## Update handoff follow-up

Added interruption cases for pending-record failure, boot-environment preparation
failure, a completed handoff awaiting boot confirmation, and a reboot before the
boot selection changed. These are regression cases for the control flow and file
replacement, not a simulation of FAT metadata tearing or hardware power loss.

Follow-up validation: all 19 checks selected by `./ci check -r` passed;
`cargo check --locked -p lunad --tests` compiled the daemon and regression cases;
Rust formatting and diff whitespace checks passed. Regression tests were not
executed under the repository authorization rule, and FAT/image/hardware
power-loss behavior remains unverified.
