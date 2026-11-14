# Billing: move to Stripe Managed Payments (handoff notes)

Status as of 2026-11-13: **gate passed; $1 check and credits designed and sandbox-tested; code not
started.** Next: the build plan below. Resume here.

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
- **Use this:** a discount on the **draft invoice**. On `invoice.created` (subscription invoice, status
  `draft`, subtotal > 0) with credit balance > 0: create a coupon `amount_off=min(balance, subtotal)`,
  `duration=once`, `max_redemptions=1`, add it to the draft (`discounts[0][coupon]`), and debit the
  ledger once with the invoice id. Sandbox: $8.00 − $2.50, VAT on $5.50 = $1.05, paid $6.55. Discounts
  reduce the taxed amount, so the $1 (already taxed when bought) isn't taxed twice. The "Turn off
  payment" final invoice is a draft too: apply the same discount before finalizing it. Remove the
  `invoice.paid` debit.

## Build plan (what changes in Connect)

1. **Stripe config:** every product used gets tax code `txcd_10010001`, every price
   `tax_behavior=exclusive`. Add a one-time $1 "Cloud backup credit" price (new config field next to
   `price_id`). Webhook events: `checkout.session.completed`, `customer.subscription.*`,
   `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`.
2. **$1 check:** `VerifyHuman` returns a Checkout URL instead of charging; `ChargeOneDollar` goes; the
   webhook writes `oss_payments` + `AddCredit(100)`. The web onboarding card form becomes a redirect
   button plus a return page that waits until the webhook lands.
3. **Subscribe:** `AttachCard` returns a subscription Checkout URL (both metered prices, saved-card
   filter); `billing.Subscribe` / `VerifyCard` / SetupIntent code go. The webhook stores the
   subscription id and item and unlocks backups. A locked account (failed payment) can start a new
   checkout, which fixes the "no way back" bug.
4. **Credits:** draft-invoice discount above; drop the `invoice.paid` debit.
5. **Cancel:** `CancelBilling` and `customer.subscription.deleted` share "final charge, then delete
   copies". Finalize and pay the final draft (after applying credit) instead of waiting an hour.
6. **Copy:** "plus tax" on `MonthlyCostHighlight`, the pricing table, the turn-off confirm and the $1
   step; say the charge shows as `LINK.COM*` on the card statement.
7. **Live Dashboard:** turn on Managed Payments in the live account (eligibility review) and check the
   support email in business details.

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
