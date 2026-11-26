# Luna decisions for the next pass

## Decided

- **Device token replacement:** the credential rotates on the same box. The UID, device row and cloud identity survive rotation and unbind, and recovery from revoked is started from the account with a password step-up. See [connect-auth design](../connect-auth/DESIGN.md).
- **Reader removal:** removing a reader deletes their future envelopes and share links, and retained snapshots are not re-encrypted. See [archive model](ARCHIVE_MODEL.md).
- **Legacy signing seeds on drives:** closed. There are no existing users (early development, per AGENTS.md), so no cleanup path is built and Luna keeps ignoring the legacy copies.
- **Conflicting public keys stored in Connect:** closed for the same reason. No repair path is built.
- **Older backups with missing published keys:** closed for the same reason. No recovery flow is built.

## Still open

- **Unlink, then link again under a different account.** Decided: a different account gets a fresh cloud identity and the old backups stay with the old account until deleted; the same account keeps its identity.
- **Earlier cloud backups after a factory reset or database loss.** Decided: Connect lists them under the same Luna in a "Before reset" section, still openable with the phrase and still billed to that Luna.
- **Drive backup rediscovery after a reset.** Should the original Luna find its drive backups again after a reset or database loss, or only backups its current setup already knows? See [the backup spec](SPEC.md).
- **Unlink flow and billing.** Decided: unlinking on the Connect website asks whether to keep paying and keep cloud backups, or cancel billing (the existing "Turn off payment" path, one request with `cancel_billing: true`). See [the Multi-Luna plan](../multi-luna/plan.md).
- **History a newly added reader can open.** Decide what history a reader added while Luna is alive may open. [ARCHIVE_MODEL.md](ARCHIVE_MODEL.md) does not settle this.
