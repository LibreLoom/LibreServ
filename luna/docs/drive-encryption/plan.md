# Drive encryption and formatting

> **Superseded** by [`../drive-format/plan.md`](../drive-format/plan.md). This file
> describes code removed in `05801e3e` (last present at `e29a2c2c`).

Encryption and formatting are separate systems. Encryption manages a container
and its credentials; formatting executes an explicit plan for new storage.
Neither lock, unlock nor password change may create a filesystem or erase data.

## Boundaries

| Component | Responsibility |
| --- | --- |
| Drive inventory | Physical disk, partitions, containers, filesystems and mounts |
| `api/encryption.rs`, `drives/vault.rs`, `drives/luks.rs` | Non-destructive container access and password changes |
| `api/formatting.rs` | Admin-owned plans, review deadlines, durable operations and results |
| `drives/format.rs`, `drives/fsprobe.rs` | Bounded disk preparation and exactly the requested filesystem |
| `drives/format_lifecycle.rs` | Quiescence, registration, content invalidation and restart reconciliation |
| `FormatDriveSheet` | One Choose → Review → Format → Result flow |
| `DriveEncryptionSheet` | Protection state, unlocking, locking and password changes |

A physical disk is not its partition, and neither is a mapper. Formatting returns
the created partition explicitly. Registration mounts that partition or the
mapper opened on it, verifies the new marker and only then publishes the drive.
A kernel device name alone is never permission to erase a disk.

## Encryption

Encrypted storage uses a standard LUKS2 container with ext4 inside. The current
profile is AES-XTS, 512-bit key, Argon2id and 512-byte sectors. Argon2id memory is
bounded for the appliance. Luna does not provide a cross-platform reader yet;
this is not a claim that standard LUKS2 can only be opened by Luna.

- Anyone with existing drive access may unlock or lock it. Unlocking makes it
  available to existing principals; it does not grant additional file access.
- Password changes are Admin-only and require the current password. Add a new
  credential, verify it, then remove the old credential. Do not reformat data.
- Password requests and temporary copies are zeroized on drop. Passwords travel
  through stdin or memory-only file descriptors, never command arguments, logs,
  the database or a disk file. The active volume key lives in the kernel mapper.
- The drive password has no recovery mechanism. The cloud recovery phrase is a
  separate credential. An independent backup may still contain recoverable files.
- There is no idle auto-lock. Power loss removes the active kernel key. A daemon
  restart may leave the mapping open, so startup verifies actual mapper, mount
  and marker state instead of blindly declaring the drive locked.

Unlock resolves the actual container partition, opens it, mounts it and verifies
its Luna identity before publishing Unlocked. Mount or identity failure cleans
up the resources opened by that attempt. Wrong passwords remain distinct from
filesystem, identity and tool errors. Attempts are rate-limited per user/drive.

Lock blocks new work, refuses active jobs or documents, flushes pending saves,
unmounts and closes the mapping. It reports Locked only after the key is no
longer active. Failure must preserve unsaved buffers and report the observed
state. Shared lock consequences belong in the confirmation.

Changing protection while preserving existing files is not implemented as an
in-place conversion. Set up encryption and Format without encryption hand off
to the format flow and explicitly disclose that formatting erases files.

## Unified formatting

All destructive entry points use `/api/v1/drive-format`. The old encryption
mutation routes and wipe-preview UI are removed. Adding existing storage remains
non-destructive; the adopt endpoint refuses erase/encryption requests.

The supported scope is the whole physical drive, replaced with one partition.
The API declares that scope explicitly so a future partition-specific operation
cannot accidentally inherit whole-disk behavior. Supported initial combinations:

| Filesystem | Protection |
| --- | --- |
| exFAT | None |
| ext4 | None or LUKS2 |

The capabilities response drives the choices. Missing tools fail before writes;
exFAT must never silently become FAT32. Directory-backed developer mock drives
are simulations and must not call disk tools or pretend to provide encryption.

### Plan and review

A plan is immutable, Admin-owned, expiring and bound to the observed physical
attachment and complete partition geometry. Its preview covers all affected
partitions, with names, counts and unknown/unreadable contents represented
honestly. Filesystem overhead and a byte threshold cannot prove emptiness.

The Review step starts a server-enforced 30-second wait only after the preview
has rendered. Every format uses the wait, including apparently empty drives.
The deadline belongs to the plan, not a mounted React component. Review retries
are idempotent. Changing the target or choices requires a new plan and review.
Passwords never enter the persisted plan.

Start consumes the plan once and returns a durable operation. A retried request
returns that operation. It revalidates ownership, expiration, the review deadline,
attachment identity and layout. It rejects concurrent operations on the disk and
invalidates other outstanding plans for that same disk.

### Execution and completion

The operation holds both the physical-device lock and registered-drive mutation
lock. Temporary inspection, adoption and release use the same device lock.
Reconciliation leaves busy or interrupted/gated drives alone.

Before writing, stop new work, refuse active copies or editors, hold backup slots,
flush pending RAM writes and stop indexers. Unmount before closing an encrypted
mapping. Verify the attachment again before destructive commands. Every disk
tool has a deadline; tool failure is not automatically permission to try a
different filesystem or device.

Persist the destructive boundary before writing. Create the selected layout,
optional encrypted container and filesystem. Open the exact new partition,
write and verify a fresh Luna marker, then publish registration transactionally.
A successfully formatted encrypted drive is unlocked and ready to use.

An existing drive may keep its familiar ID and name, but formatting starts a new
content generation. Keep explicit whole-drive member access; revoke old public
links, file/folder and album grants. Remove stale recents/forwarding references,
stop affected backup rules, and invalidate records of copies erased from a backup
target. Preserve cloud snapshots and copies on other drives. Recreate current
Luna recovery material on the new filesystem.

Only a verified completed operation may produce success UI. Progress reports
named phases, not guessed percentages or encryption-flag changes. Closing a sheet
or refreshing the browser recovers progress from operation records.

On failure, persist the phase, error and whether destructive work began. A
pre-write failure must not discard pending saves or leave a stale usable mount.
A destructive failure remains gated until reviewed again. Restart marks unfinished
operations Interrupted and never automatically repeats destructive work.

## Privacy and limits

Drive encryption protects the contents at rest while the mapper is closed. Drive
labels remain visible, and the central Luna database can retain paths and other
metadata. It does not replace Luna permissions or cloud backup encryption.

Drive backup creation and each run refuse an encrypted source paired with a
plain destination. Formatting a source or destination stops affected rules so
new files cannot silently inherit an old backup relationship.

Source, render and API regression coverage belong alongside these components.
Static checks do not establish real-device, power-cut or cryptsetup keyslot
behavior; those remain separate verification work requiring an authorized run.
