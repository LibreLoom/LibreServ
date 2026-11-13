# Billing: move to Stripe Managed Payments (handoff notes)

Status as of 2026-11-12: **decided in principle, not started.** Resume here.

## Decisions made

- **Go with Stripe Managed Payments** (Stripe/Link is merchant of record). We're US-based, don't want
  tax complications, and don't want to exclude the EU. Managed Payments files and remits VAT/sales tax
  in 80+ countries; we never register for VAT.
- **Tax is added on top** of the price (exclusive). $8/TB stays $8 for us; EU customers pay VAT on top.
  Every in-app amount (Backups page estimate, "Turn off payment" confirm) must say "plus tax".
- **Migrate now, before building more billing UI.** No users yet; Link already gives customers card
  changes, invoices, receipts, failed-payment recovery and cancellation, so don't build a Customer
  Portal or custom dunning first.
- **Keep the $1 card check exactly as it is.** It proves a person is real (`human_verified`,
  `oss_payments`), not just that the card works. Don't drop or fold it into the first purchase.

## Step 1: the gate (do this first)

Stripe's docs don't say whether a **metered price (billing meter)** works with Managed Payments.
Test in sandbox before writing code: create a Checkout Session with
`mode=subscription`, `managed_payments[enabled]=true` and our metered storage price as the line item
(no quantity for metered prices). The product needs an eligible tax code; ours is
`txcd_10010001` (Infrastructure as a service, personal use).

- Passes: continue with the plan below.
- Fails: fallback is **Stripe Tax + EU "non-Union OSS" VAT registration** (one registration in one EU
  country, one quarterly return for all EU sales; B2B with a valid VAT ID carries no VAT). Stripe Tax
  calculates and collects; we or a filing service file. Product code stays as it is.

How to run it was still open: a direct API call with the sandbox secret key from the local Connect
config, or the Stripe Dashboard through `browser-harness-js` (the user's preferred way to drive their
browser; read the `cdp` skill's SKILL.md first).

## Open questions to settle during the migration

1. **$1 check alongside Managed Payments.** A Managed Payments subscription only authorises Managed
   Payments to charge the card. The $1 check is a separate charge outside it, so it needs its own
   consent, and its tax isn't handled by Managed Payments (it currently "counts toward cloud
   backup"). Find how to keep the check unchanged for the user while staying compliant.
2. **Cancelling through Link.** Customers can cancel on link.com, which skips our "charge the month,
   then delete" flow in `CancelBilling`. Check whether Link cancels immediately or at period end
   (period end would bill the month on its own), then move the final-charge + delete logic into the
   `customer.subscription.deleted` webhook.
3. **Subscription card field.** For Managed Payments subscriptions, `subscription.default_payment_method`
   can't be set through the API; `billing.Subscribe` sets it today and has to go.
4. **Fee.** Managed Payments adds a per-sale fee on top of card processing. Check current pricing.
5. **Statement and refunds.** Card statements read `LINK.COM* <descriptor>`. Stripe applies EU cooling-off
   rules and may refund within 60 days. Make sure the support email in Stripe's business details is right.

## What would change in Connect

- Signup: `AttachCard` / `VerifyHumanCard` + API `Subscribe` → Stripe Checkout (`mode=subscription`,
  Managed Payments on), finished by the `checkout.session.completed` webhook. The $1 check stays.
- Cancel: `CancelBilling` and the webhook share the "final charge, then delete copies" path.
- Copy: "plus tax" on `MonthlyCostHighlight`, the pricing table and the turn-off confirm.
- Stripe Dashboard: activate Managed Payments, set the product tax code, add webhook events
  (`checkout.session.completed`, `customer.subscription.*`, `invoice.*`).

## Known problems in the current billing (fix or make moot during the migration)

- **No way back after a failed payment.** `invoice.payment_failed` → `lockSubscription` keeps the
  subscription id, and `AttachCard` returns early whenever one is stored
  (`internal/api/handlers/account.go`), so "Add a payment card" on the "Payment didn't go through"
  screen does nothing.
- **The first failed charge starts the 30-day deletion countdown** while Stripe is still retrying,
  and the mail says "Payment for cloud backup is off". The user wants the countdown kept as a
  failsafe ("I can't be losing money"), but the wording should say the payment failed.
- **Admin account deletion leaves the Stripe subscription running** (`deleteCustomerAccount` in
  `internal/api/handlers/purge.go` never cancels it).
- **`invoice.payment_action_required` is ignored**, so a renewal that needs the bank's confirmation
  (common for EU cards) just fails.

## Already done (2026-11-12)

- `7943938e` feat(luna): Luna reads `cloud_backup` (`not_linked` / `no_payment` / `ready`) from lunad
  and blocks cloud backup until Connect says payment is active.
- `a967af03` feat(connect): "Turn off payment" charges the month so far (`InvoiceNow`) and deletes the
  cloud copies right away; the 30-day countdown is only for failed payments. Not tested against
  Stripe yet: worth one run in test mode, since meter events are processed asynchronously and a
  final invoice might miss the last hourly report.
- `luna/web/src/dev/contract/known-gaps.js` has two temporary `connect/status` entries; remove them
  after the next full `./ci run -p luna`.

## Sources

- https://docs.stripe.com/payments/managed-payments/how-it-works
- https://docs.stripe.com/payments/managed-payments/eligibility
- https://docs.stripe.com/payments/managed-payments/set-up
