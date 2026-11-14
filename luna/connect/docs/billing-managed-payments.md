# Billing: move to Stripe Managed Payments (handoff notes)

Status as of 2026-11-13: **built.** Commits `c2d6486d` (stripe-go v87), `7bf9fe9b` (backend), `34e35268`
(web). Not yet done: Go tests and vitest were not run, no end-to-end run against a real Connect with the
sandbox, and the Stripe Dashboard steps below. Resume at "What's left".

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
  Under Managed Payments it is paid on its own Stripe Checkout (plus tax), still a separate step.

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

### Step 1 results (2026-11-13, sandbox `acct_1Ty2Wr2YkLLziVSu`, API `2025-09-30.clover`) — PASSED

Test objects left in the sandbox: product `prod_VcnAyogB4huQnQ` ("MP gate test storage", tax code
`txcd_10010001`), metered prices `price_1UbXac2YkLLziVSu0XafOW2j` ($0.008/GB on meter `luna_backup_gb`)
and `price_1UbXac2YkLLziVSuBKBAT9KX` ($0.01/GB on `luna_egress_gb`), both `tax_behavior=exclusive`.
The real sandbox prices (`Luna Backup`, `Luna Egress`) have no tax code and `tax_behavior=unspecified`;
set both before switching.

- Checkout Session `mode=subscription`, `managed_payments[enabled]=true`, both metered prices as line
  items (no quantity): **created and rendered** ("$0.00 due today, then billed monthly based on usage",
  "Sold through Link"). For a German customer it asked only for the country, no street address.
- Completed with test card + DE: subscription `active`, `managed_payments.enabled=true`,
  `automatic_tax.liability=stripe`, both items `metered`. Session `payment_status` is `unpaid` (nothing
  due), so the webhook must not wait for `paid`.
- Meter events (1000 GB storage, 50 GB egress) showed up in the invoice preview after ~1 minute:
  $8.50 + **19% DE VAT $1.62 = $10.12**, `taxability_reason=standard_rated`. Tax-on-top works.
- `subscription.Cancel(invoice_now=true, prorate=false)` (our `CancelSubscriptionFinal`) works: final
  invoice $10.12 incl. VAT, created as a **draft**; finalize + pay succeeded. Stripe would auto-finalize
  the draft after ~1 hour; finalize and pay it ourselves if "Turn off payment" should charge at once.

Answers to the open questions below (from the same run):

- **Q1:** an off-session $1 PaymentIntent on the Link-collected card **succeeds technically** (card is
  saved on the customer with `allow_redisplay=limited`), but it runs with `managed_payments.enabled=false`:
  we're the seller for that $1 and its tax, and Stripe's docs say the subscription consent doesn't cover
  it. Decided: the $1 becomes its own Managed Payments Checkout (see Open questions 1).
- **Q3 confirmed:** updating `default_payment_method` fails with "default_payment_method cannot be
  updated for Subscriptions created by Checkout Sessions with Managed Payments enabled."
- **Q4:** 3.5% per successful transaction (on the amount incl. tax), on top of normal card processing
  (2.9% + $0.30 US): about 6.4% + $0.30 all-in for a US card. Source:
  https://support.stripe.com/questions/managed-payments-pricing
- **Q2 can't be tested in a sandbox:** test purchases don't appear in the Link app. Handle both cases in
  the `customer.subscription.deleted` webhook.

How it was run: `browser-harness-js` read the sandbox secret key from Developers → API keys, then curl.
The checkout form was filled through raw CDP (`Runtime.evaluate` focus + `Input.insertText`); the
guarded locator API lost the tab on every click on checkout.stripe.com.

## Open questions (status 2026-11-13)

1. **$1 check: DECIDED (user, 2026-11-13): its own Managed Payments Checkout.** Same onboarding step,
   same $1, but paid on a Stripe-hosted `mode=payment` Checkout with `managed_payments[enabled]=true`,
   `customer=<cus>` and `payment_intent_data[setup_future_usage]=off_session`. A direct charge would
   make every EU signup a sale we owe VAT on. Sandbox result: DE customer paid **$1.00 + 19% VAT =
   $1.19**, session `payment_status=paid`, card saved on the customer (`allow_redisplay=limited`).
   The line item is a product framed as prepaid "Cloud backup credit" with tax code `txcd_10010001`
   (sandbox test product `prod_VcnMIOeAFp5CGj`, price `price_1UbXlY2YkLLziVSul1RYmKp2`). That matches
   the "counts toward cloud backup" promise and keeps it an eligible digital product.
   - The subscription Checkout for the same customer with
     `saved_payment_method_options[allow_redisplay_filters][]=limited` (and `=always`) shows
     "Pay with •••• 4242": subscribing is one click, no second card entry. Without that option the
     card form is empty.
   - Write `human_verified` / `oss_payments` from the `checkout.session.completed` webhook
     (`mode=payment`, `payment_status=paid`), not from the redirect.
2. **Cancelling through Link:** can't be tested in a sandbox (test purchases don't show in the Link
   app). Handle both immediate and period-end cancels in `customer.subscription.deleted`.
3. **Card field: confirmed.** "default_payment_method cannot be updated for Subscriptions created by
   Checkout Sessions with Managed Payments enabled." `billing.Subscribe` goes away.
4. **Fee:** 3.5% per successful transaction (on the amount incl. tax) on top of card processing
   (2.9% + $0.30 US): about 6.4% + $0.30 all-in for a US card.
   https://support.stripe.com/questions/managed-payments-pricing
5. **Statement and refunds.** Card statements read `LINK.COM* <descriptor>`. Stripe applies EU cooling-off
   rules and may refund within 60 days. Make sure the support email in Stripe's business details is right.

### Credits (the $1 and admin credits) under Managed Payments

**Bug today:** the credit ledger never reaches Stripe. `applyCreditsFromInvoice` (on `invoice.paid`)
only debits `account_credits` locally; nothing refunds, discounts or credits the customer in Stripe, so
"It counts toward cloud backup" is not true.

Tested in the sandbox:

- Negative invoice items are **blocked** on Managed Payments subscriptions: `amount=-100` needs "an
  eligible product tax code or existing eligible product", `price_data[unit_amount]` can't be negative,
  and tax parameters can't be set on invoice items.
- A `duration=once` `amount_off` coupon on the **subscription** works ($8.00 − $1.00, VAT on $7.00 =
  $1.33, total $8.33) but is used up by whatever invoice comes next, even a $0 month.
- A coupon on the **draft invoice** also works ($8.00 − $2.50, VAT on $5.50 = $1.05, paid $6.55), but
  needs an `invoice.created` webhook, a throwaway coupon per invoice, and our own ledger.
- **Use this: Stripe billing credits (credit grants).** Tested 2026-11-13 on a Managed Payments
  subscription: `POST /v1/billing/credit_grants` with `category=paid`, `amount[monetary][value]=100`,
  `applicability_config[scope][price_type]=metered` (`credgr_test_61VkvrIQ0ZLCLUk4V412YkLLziVSuL9s`).
  The finalized invoice applied it as a pre-tax credit (`total_pretax_credit_amounts`, credit balance
  transaction `cbtxn_test_61VkvsXUa75wLvRVI412YkLLziVSuJ3g`): $8.00 − $1.00, VAT on $7.00 = $1.33,
  paid $8.33. It also worked on the "Turn off payment" final invoice (cancel with `invoice_now`, then
  finalize).
  - Credits apply after discounts and **before tax**, so the $1 (taxed when bought) isn't taxed twice.
  - Stripe keeps the balance: each finalized invoice uses what it can and the rest carries over, so a
    $0 month wastes nothing. Applied only at finalization, so previews can show credit a later invoice
    takes.
  - The $1 check is `category=paid`; admin goodwill credits are `category=promotional`. Optional
    `expires_at`. Max 100 unused grants per customer.
  - Not the customer invoice balance: that applies **after** tax and would tax the $1 twice.
  - Our `account_credits` / `credit_transactions` tables and `applyCreditsFromInvoice` go away; balance
    and history come from the credit balance summary and credit balance transactions APIs.
  - The grant needs the Stripe customer to exist, which it does once the $1 checkout completes.

## What's left (2026-11-13)

1. **Run the tests:** `go test ./...` in `luna/connect` and vitest in `luna/connect/web` (neither run
   yet), or a full `./ci run`.
2. **End-to-end in the sandbox:** run Connect with the sandbox keys and `stripe listen` forwarding to
   `/api/v1/billing/webhook`, then: DIY signup → $1 checkout → device token; turn on cloud backup →
   one-click subscribe; admin credit; Turn off payment. Webhook signing secret from `stripe listen`.
3. **Stripe Dashboard (sandbox, then live):** see README "Stripe Dashboard setup" steps 0–10. In short:
   turn on Managed Payments; tax code `txcd_10010001` + tax behavior exclusive on the storage and egress
   prices (the sandbox's `Luna Backup` / `Luna Egress` have neither yet); webhook API version
   `2026-10-28.endive` and the six events; support email in business details.
4. **Known gaps kept on purpose:**
   - `invoice.payment_action_required` is still ignored. Link emails the customer about it (Managed
     Payments sends the transaction emails); nothing else to do in Connect yet.
   - A cancel on link.com arrives as `customer.subscription.deleted` and starts the 30-day countdown
     (same as before). If Link cancels immediately, the month so far is not billed; can't be tested in a
     sandbox.
   - `stripe_publishable_key` is still in `/me` and Admin → Connections but unused by the web.

## Build plan (as built)

1. **Stripe config:** every product used gets tax code `txcd_10010001`, every price
   `tax_behavior=exclusive`. The $1 "Cloud backup credit" is an inline `price_data` product, so no
   new config field. Webhook events: see README step 9.
2. **$1 check:** `POST /billing/checkout {kind: card_check}` returns a Checkout URL; `ChargeOneDollar`
   and `verify-human` are gone. The return page (`POST /billing/checkout/complete`) and the webhook share
   `fulfillCheckout`, which grants the $1 (idempotency key from the session id) and writes `oss_payments`.
3. **Subscribe:** `POST /billing/checkout {kind: backup}` (both metered prices, saved-card filter,
   anchor on the 1st UTC); `AttachCard` / `billing.Subscribe` / `VerifyCard` / SetupIntent code are gone.
   `fulfillCheckout` stores the subscription id; a second subscription is cancelled, not stored. A
   failed payment does NOT start a new checkout (two subscriptions would bill the same meters twice):
   checkout answers 409 with link.com, where the card is updated and Stripe retries.
4. **Credits:** Stripe credit grants (above). Admin "Add credit" creates a `promotional` grant; the
   account and admin pages read the balance from Stripe. Drop our credit tables and the `invoice.paid`
   debit.
5. **Cancel:** "Turn off payment" (`CancelSubscriptionFinal`) now finalizes and charges the final draft
   at once (credits apply on finalize). A cancel on link.com still goes through
   `customer.subscription.deleted` → 30-day countdown (see "What's left" 4).
6. **Copy:** "plus tax" on `MonthlyCostHighlight`, the pricing table, the turn-off confirm and the $1
   step; say the charge shows as `LINK.COM*` on the card statement.
7. **Live Dashboard:** turn on Managed Payments in the live account (eligibility review) and check the
   support email in business details.

## Known problems found before the migration (status after the build)

- FIXED (link.com, no second subscription) — **No way back after a failed payment.** `invoice.payment_failed` → `lockSubscription` keeps the
  subscription id, and `AttachCard` returns early whenever one is stored
  (`internal/api/handlers/account.go`), so "Add a payment card" on the "Payment didn't go through"
  screen does nothing.
- WORDING FIXED (mail says the payment didn't go through; countdown kept as the failsafe) — **The first failed charge starts the 30-day deletion countdown** while Stripe is still retrying,
  and the mail says "Payment for cloud backup is off". The user wants the countdown kept as a
  failsafe ("I can't be losing money"), but the wording should say the payment failed.
- FIXED (cancels with a final charge first) — **Admin account deletion leaves the Stripe subscription running** (`deleteCustomerAccount` in
  `internal/api/handlers/purge.go` never cancels it).
- OPEN (Link emails the customer) — **`invoice.payment_action_required` is ignored**, so a renewal that needs the bank's confirmation
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
