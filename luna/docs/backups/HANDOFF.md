# Luna decisions for the next pass

## Cloud identity

**What should Connect recognize as the same Luna?** Decide what the identity represents before choosing where it lives. For each of these events, say whether Connect should treat the Luna as the same one or as a new one, and what access the resulting Luna should have to earlier backups.

| Event | Product behavior to decide |
| --- | --- |
| The device token is replaced on the same box | Decide whether token replacement itself is supported and who can authorize it. |
| A Luna is unlinked, then linked again | Decide whether the answer changes if the account changes. |
| A box is factory-reset or loses its database | Decide how earlier backups appear on the website and whether they stay associated with the same Luna. |

The backup signing key and recovery phrase already serve different purposes. The current implementation uses a locally generated signing seed to authenticate records and phrase-derived keys to open backup data. These facts do not settle the product meaning of identity. See [the crypto review](REVIEW-crypto.md).

## Drive backups after a reset

**Should the original Luna rediscover its drive backups after a reset or database loss?** The backup spec currently promises paused rediscovery in that case. Cross-Luna import is out of scope. Decide whether to keep the same-box promise when Luna has lost its local record, or to limit discovery to backups the current setup already knows. Ordinary unplug and reconnect works with the existing record. See [the backup spec](SPEC.md).

## Independent Lunas in Connect

**What does a customer see and pay for after unlinking a Luna?** The existing spec keeps paid backups available on Connect while billing continues. The decision is whether the unlink flow should also offer to cancel billing and start retention, or leave cancellation as a separate action. The Multi-Luna plan carries forward the $1 DIY activation credit on that Luna's bill. Any change to the monthly minimum or proration is a pricing decision. See [the Multi-Luna plan](../multi-luna/plan.md).

## Existing backup data

- **Legacy signing seeds already on drives.** Decide whether Luna should remove existing copies automatically when it next mounts a drive, or whether cleanup should be an explicit operation. Luna already ignores the copies and has stopped creating them.
- **Conflicting public keys already stored in Connect.** Decide whether historical conflicts need a repair path and what evidence support should require before accepting a correction. Routine registration now accepts the same key again and refuses a different key.
- **Older backups with missing published keys.** Decide whether users need a recovery flow for versions that normal retries cannot repair. If so, decide who may receive a repaired key when the access list has since changed. Limit any repair to people eligible for that version unless the product explicitly changes historical access.
- **Reader changes.** The current spec starts a fresh key version and re-uploads when the eligible readers change. A policy change should say what history a newly added reader may open and which future data a removed reader must lose access to. Performance work can then follow those rules. See [the backup spec](SPEC.md) and [the flow review](REVIEW-flows.md).
