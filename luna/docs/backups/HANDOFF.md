# Luna decisions for the next pass

## Decided

- **Device token replacement:** the credential rotates on the same box. The UID, device row and cloud identity survive rotation and unbind, and recovery from revoked is started from the account with a password step-up. See [connect-auth design](../connect-auth/DESIGN.md).
- **Reader removal:** removing a reader deletes their future envelopes and share links, and retained snapshots are not re-encrypted. See [cloud backup model](ARCHIVE_MODEL.md).
- **Legacy signing seeds on drives:** closed. There are no existing users (early development, per AGENTS.md), so no cleanup path is built and Luna keeps ignoring the legacy copies.
- **Conflicting public keys stored in Connect:** closed for the same reason. No repair path is built.
- **Older backups with missing published keys:** closed for the same reason. No recovery flow is built.
- **Unlink, then link again under a different account:** a different account gets a fresh cloud identity and the old backups stay with the old account until deleted; the same account keeps its identity.
- **Earlier cloud backups after a factory reset or database loss:** Connect lists them under the same Luna in a "Before reset" section, still openable with the phrase and still billed to that Luna.
- **Drive backup rediscovery after a reset:** Backups found on a drive with no local record come back paused until the owner or an Admin taps Resume, as SPEC.md says.
- **Unlink flow and billing:** unlinking on the Connect website asks whether to keep paying and keep cloud backups, or cancel billing (the existing "Turn off payment" path, one request with `cancel_billing: true`). See [the Multi-Luna plan](../multi-luna/plan.md).
- **History a newly added reader can open:** Only snapshots made from the next run on; older snapshots are never sealed to them.
- **Billing:** Connect bills exactly the way Backblaze B2 bills us: hourly-sampled average stored bytes per month, in arrears, with egress free up to 3× storage. Bytes in the 7-day delete queue stay billed until they are really deleted. A failed payment stops new uploads at once; the up-to-30-days of storage before deletion is an accepted loss, because avoiding it would mean billing in advance, which B2 doesn't do.
