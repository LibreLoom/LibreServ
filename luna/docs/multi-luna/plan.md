# Multi-Luna accounts

## Approved scope

A Luna Connect account can own several independent Lunas. Each Luna has its own device link, cloud identity, address and tunnel, cloud storage and quota, subscription, credit, and retention state. The account provides sign-in and ownership.

Replacement workflows, Luna-to-Luna migration, address transfers, cross-Luna read grants, and recovery phrase reuse are deferred. A replacement is set up as a new Luna. Existing cloud backups remain downloadable on the Luna Connect website with the recovery phrase, subject to the [backup spec](../backups/SPEC.md). Connect's schema can be rewritten directly, with no database migration or backfill.

## Phase 0. Finish removing drive identity recovery

Drive key writes and recovery from legacy copies were removed in `d4f33955`. Key publication retries landed in `39956aad`, and `ba542433` removed the Luna web restore cards. Finish the defensive cleanup:

- Keep newly minted signing keys in Luna's system database. The decision about scrubbing legacy drive copies is tracked in the [handoff](../backups/HANDOFF.md).
- Remove the daemon's legacy cloud index rebuild routes and callers, along with obsolete identity lookup and request signing on Luna and Connect. Remove signature-based rebinding. Connect must authorize storage against the device linked to the owning Luna.
- Keep cloud downloads on the website. The customer-facing treatment of earlier backups after a reset or database loss is tracked in the [handoff](../backups/HANDOFF.md).

## Phase 1. Scope Connect state to each Luna

Give each Luna an account-owned entry distinct from its device token and cloud identity. Put setup, address, and tunnel state on the entry. Bind each cloud identity and its signing public key to one entry, and make the published key immutable. A change to a different entry requires a fresh cloud identity. Unlinking tears down the address and tunnel. Paid copies stay on Connect while payment continues, as described in the backup spec.

Scope storage access, quota, usage, backup status, and retention jobs to the entry. Derive storage access from the authenticated device's current link. Verify account ownership for web reads and actions, and charge download usage to the Luna that owns the data. Cancellation, payment failure, and backup deletion for one Luna affect only that Luna. Keep device claims and any entry cap atomic.

## Phase 2. Bill each Luna independently

Use one Stripe customer per Luna so metered usage, subscriptions, invoices, and credit are isolated. Check that Checkout and Link can distinguish Lunas and verify that credits, final invoices, and cancellation events apply to the intended Luna. Saved-card reuse is a convenience to verify before promising it in onboarding. If the billing setup cannot isolate Lunas, bring that decision back for review.

Each DIY Luna costs **$1 plus tax** to add. Credit **$1 toward cloud backup for that Luna**. A completed activation checkout issues one linked device token and one credit, even if the return handler and webhook both run or are retried. Validate the checkout's account, Luna, and Stripe customer before fulfillment. A retail Luna uses the device token on its quick-start card and has no activation fee.

## Phase 3. Let existing accounts add a Luna

Keep the printed `/onboarding` route and the DIY `/diyonboarding` route. Signed-out users can sign in or create an account and verify their email. A signed-in, verified user starts setup for the Luna they are adding. The **Add a Luna** action on the account's Lunas page offers the same retail and DIY paths.

- **Retail.** Enter the device token, then continue through name, cloud backup, and plug-in. A token already linked to this account resumes that Luna's setup. A token linked to another account is refused.
- **DIY.** Pay the activation fee, then show the linked device token with the installer instructions and continue through name, cloud backup, and plug-in.
- **Resume.** Store progress per Luna. List each Luna with its own setup, address, backup, and billing status. Group website downloads by Luna and build the existing `/setup?token=` link for the selected Luna.

Keep email verification, bind rate limits, and token validation for off-LAN first-user setup. Track customer sign-out everywhere, password reset, and on-demand tunnel token rotation as defensive follow-ups before or alongside enabling several Lunas per account.

## Remaining choices

The [decision handoff](../backups/HANDOFF.md) covers cloud identity, reset behavior, and billing choices. Carry the current pricing forward unless a change is approved. Companion-app switching is outside this Connect rollout.
