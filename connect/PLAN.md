# LibreServ Connect — Full Plan

Status: draft, 2026-07-10. Realignment pass completed 2026-07-31: dead code deleted, local credit/plan system removed (Connect enforces all limits service-side), settings pipeline fixed, email architecture unified. Tunnel relay fleet (Phase 4 below) remains unbuilt — it is a product roadmap item, not part of the realignment.  
Scope: cloud control plane, subscription management, and SaaS services for LibreServ devices.

---

## 1. What Connect is

Connect is the cloud companion for LibreServ home servers. A user adds a device to Connect, chooses a subscription plan, and manages remote services from one place. Connect also provides a staff console for configuration, analytics, support tickets, and live chat.

### Services provided

| Service | Description |
|---|---|
| **Email / SMTP relay** | Outbound transactional email from apps and the LibreServ itself. |
| **Domain & DNS** | Subdomain assignment and management under `*.servers.libreloom.org`. |
| **Cloud backup storage** | S3-compatible restic repository for app and system backups. |
| **Tunnel access** | Encrypted public relay so a device is reachable without opening home router ports. |
| **AI inference** | OpenAI-compatible API for device agent and support review models. |
| **Human support** | Tickets and live chat with staff, subject to client-side AI audit before any staff action. |

### Key principles

- **No compatibility layers.** Existing `payg` plan is renamed to `lite`, migrations are rewritten in place, and obsolete code is removed as if it never existed.
- **Stripe first.** Crypto payments deferred to a later phase as account credits.
- **Account credit supported from the start.** 1 USD = 1 credit.
- **Models are live-configurable.** No hardcoded base URLs; Connect Admin configures providers, fallback chains, and per-provider pricing.
- **Billing is transparent.** Paid inference, email, and backup are charged at LibreLoom's actual cost plus only the agreed markup.

---

## 2. Pricing & plans

### Verified upstream costs (live fetches, 2026-07-10)

| Service | Provider | Cost |
|---|---|---|
| Backup storage | Backblaze B2 | $6.95/TB/month |
| Backup egress | Backblaze B2 | Free up to 3× average storage; then $0.01/GB |
| SMTP relay | Resend | $20/mo for 50,000 emails; overage $0.90/1,000 = $0.0009/email |
| Agent inference | Crof AI GLM-5.2 | $0.30/M input tokens, $1.05/M output tokens |
| Review inference | Crof AI DSv4 Pro | $0.35/M input tokens, $0.80/M output tokens |
| Premium tunnel relay | Hetzner + Akamai/Linode | Hetzner ~$7/mo/node (20 TB+); Akamai ~$5/mo/node (1 TB); overage ~$0.01/GB |

### Plans

#### Connect Free — $0/month

| Feature | Inclusion |
|---|---|
| Backup | Not included |
| AI inference | Free models only; 50 messages/day rate limit; no data-privacy guarantee; providers may use requests for training |
| Agent/review models | Admin-configured free models; separate from paid config |
| Tunnel | Best-effort non-premium relay; data-transfer limits and anti-abuse policy apply |
| SMTP relay | 30 emails/day |
| Domain | `*.free.servers.libreloom.org` |
| Human support | Not included |

#### Connect Lite — $6/month + PAYGO

| Feature | Base | Overage |
|---|---|---|
| Backup | 100 GB | $7.50/TB/month |
| AI inference | $2/month credit | At actual Crof AI cost |
| Agent/review models | GLM-5.2 / DSv4 Pro default; live-configurable | Same |
| Tunnel | 50 GB/month premium relay | $0.01/GB, or fall back to non-premium relay |
| SMTP relay | 250 emails/month | $0.001/email |
| Domain | `*.servers.libreloom.org` | None |
| Human support | Included | N/A |

#### Connect One — $25/month + overage

| Feature | Base | Overage |
|---|---|---|
| Backup | 1 TB/month | $6.95/TB/month (you-pay-what-we-pay) |
| AI inference | $5/month credit | At actual Crof AI cost |
| Agent/review models | GLM-5.2 / DSv4 Pro | Same |
| Tunnel | 200 GB/month premium relay | $0.01/GB, or fall back to non-premium relay |
| SMTP relay | 2,500 emails/month | $0.001/email |
| Domain | `*.servers.libreloom.org` | None |
| Human support | Included | N/A |

### Unit economics (representative usage)

| Plan | Backup | AI credit | SMTP | Tunnel | Variable cost | Base price | Margin | Margin % |
|---|---|---|---|---|---|---|---|---|
| Lite | 100 GB | $2.00 | 250 emails | 50 GB | $3.43 | $6.00 | $2.57 | 43% |
| One | 1 TB | $5.00 | 2,500 emails | 200 GB | $16.20 | $25.00 | $8.80 | 35% |

Both plans exceed the 25% gross-margin target before fixed costs.

### Why these prices

- **Lite $6** is low enough to attract users but bundles real value: backup, AI credit, email, and support.
- **One $25** is the better deal for anyone using more than ~100 GB backup or more than ~$2 of AI.
- **Tunnel overage** defaults to the non-premium fallback so users are never surprised by a bandwidth bill.

---

## 3. Architecture

### Components

```
connect/
├── cmd/server/               # Connect server entry point
├── internal/
│   ├── api/                  # chi/v5 HTTP router
│   │   ├── handlers/         # device, admin, provision, support, billing
│   │   └── middleware/       # device auth, admin auth, logger, recoverer
│   ├── billing/              # Stripe, invoices, account credit, usage aggregation
│   ├── catalog/              # plan definitions, service pricing, limits
│   ├── database/             # SQLite + migrations
│   ├── models/               # AI provider + model configuration, fallbacks
│   ├── relay/                # tunnel relay fleet orchestration
│   └── services/             # credential provisioning, usage metering
├── web/
│   ├── admin/                # staff UI: config, analytics, support
│   └── customer/             # self-service UI: devices, plans, usage, billing
└── configs/
    └── connect.yaml.example
```

### Tunnel relay topology

| Region | Provider | Node spec | Why |
|---|---|---|---|
| US East, US West, EU Central | Hetzner | ~$7/mo small VPS | Cheapest bandwidth, 100% renewable hydropower |
| APAC, South America, other | Akamai/Linode | ~$5/mo Nanode | Global reach where Hetzner is absent |

Estimated base fleet: 3 Hetzner + 3 Akamai nodes = ~$36/month.

### AI configuration

Connect Admin maintains a live-editable table of:

- `providers` (name, base URL, API key, enabled)
- `models` (provider, model ID, role, input/cache/output price, context window)
- `fallback chains` per role (e.g., agent → GLM-5.2 → GLM-5.1 → free fallback)
- `free-tier configuration` separate from paid configuration

No provider URLs are hardcoded in source. All are loaded from the database at startup and refreshable at runtime.

---

## 4. Data model changes

Migration `001` is rewritten in place. Key changes:

### Plans

| id | name | description | price_monthly_cents | limits_json |
|---|---|---|---|---|
| `free` | Connect Free | ... | 0 | backup_gb=0, ai_credit_cents=0, tunnel_gb=0, smtp_monthly=0 |
| `lite` | Connect Lite | ... | 600 | backup_gb=100, ai_credit_cents=200, tunnel_gb=50, smtp_monthly=250 |
| `one` | Connect One | ... | 2500 | backup_gb=1024, ai_credit_cents=500, tunnel_gb=200, smtp_monthly=2500 |

### New tables

- `account_credits` — balance, transactions, expiration
- `invoices` — Stripe invoice IDs, status, amount, period
- `usage_events` — expanded to include `plan_id`, `credits_consumed`, `provider_cost`
- `ai_providers` — runtime provider config
- `ai_models` — runtime model config with pricing
- `relay_regions` — provider, region, host, capacity, health

### Removed concepts

- Old `crypto` billing table (deferred).
- Any hardcoded plan limits outside the database seed.

---

## 5. API changes

### Device API

```
POST /api/v1/activate          # token → plan assignment
POST /api/v1/deactivate
GET  /api/v1/status             # current plan + quotas
GET  /api/v1/usage              # current cycle + cost
GET  /api/v1/info               # public catalog
POST /api/v1/services/provision # request credentials for a service
```

### Admin API

```
GET    /admin/devices
GET    /admin/devices/{deviceID}
POST   /admin/devices/{deviceID}/credentials/rotate
GET    /admin/cases
POST   /admin/cases/{caseID}/messages
POST   /admin/cases/{caseID}/consent-requests
GET    /admin/plans
PUT    /admin/plans/{planID}
GET    /admin/usage             # NEW: aggregated + per-device
GET    /admin/models            # NEW: AI provider/model config
POST   /admin/models            # NEW
PUT    /admin/models/{id}       # NEW
GET    /admin/relay             # NEW: relay fleet status
```

### Customer web API (new)

```
GET /portal/devices
GET /portal/plans
GET /portal/usage
GET /portal/billing
POST /portal/subscribe
POST /portal/cancel
POST /portal/change-plan
```

---

## 6. Implementation phases

### Phase 1 — Foundation (week 1–2)

- [ ] Rewrite `connect/internal/database/db.go` migration `001` with new schema.
- [x] Update plan seed to `free`, `lite`, `one` with new limits.
- [x] Remove old `payg` references and obsolete code paths.
- [ ] Implement account-credit table and transactions.
- [x] Update config example with new sections (`tunnel`, `stripe`); models are DB-configured.

### Phase 2 — Billing & usage (week 2–3)

- [ ] Implement real usage metering for backup, AI, SMTP, tunnel.
- [ ] Connect Stripe for subscriptions and overage.
- [ ] Implement invoice generation and account-credit redemption.
- [ ] Expose usage APIs for device and admin.

### Phase 3 — AI configuration runtime (week 3–4)

- [ ] Add `ai_providers` and `ai_models` tables.
- [ ] Implement admin endpoints to CRUD providers/models/fallbacks.
- [ ] Update device AI credential provisioning to use configured models.
- [ ] Implement free-tier model config separately from paid.

### Phase 4 — Tunnel relay (week 4–5)

- [ ] Define relay region abstraction (Hetzner + Akamai).
- [ ] Build relay provisioning/orchestration (manual or API-driven).
- [ ] Implement premium vs. non-premium routing logic.
- [x] Enforce tunnel quotas (overage/fallback behavior pending relay fleet implementation).

### Phase 5 — Web UIs (week 5–6)

- [ ] Customer portal: devices, plans, usage, billing.
- [ ] Admin dashboard: analytics, model config, support tickets/live chat.
- [ ] Integrate client-side review model for staff action audit.

### Phase 6 — Support safeguards (week 6–7)

- [ ] Port/reuse existing `internal/agent/review.go` model for staff actions.
- [ ] Build permission dialog flow: model audits, assigns danger/intrusiveness, human decides.
- [ ] Audit log all staff actions.

### Phase 7 — Polish & launch (week 7–8)

- [ ] End-to-end smoke tests.
- [ ] Plain-language user-facing copy.
- [ ] Security review of credentials, quotas, and billing.

---

## 7. Operational considerations

### Free tier abuse

- Admin dashboard must show free-tier usage in real time.
- Automated throttling/capping must be possible per device or globally.
- AI messages, tunnel transfer, and SMTP are the primary abuse vectors.

### Support cost

- Human support is currently provided by LibreLoom at no direct cash cost.
- It is treated as fixed overhead, not per-ticket variable cost.
- If ticket volume grows, Lite viability must be re-evaluated.

### Provider risk

- Hetzner has no APAC regions; Akamai/Linode fills that gap.
- If either provider changes pricing, Connect Admin model config and plan math can be updated without a deploy.
- Tunnel overage is priced at the most expensive upstream rate ($0.01/GB) to avoid losses.

### Taxes and fees

- Backup overage on One is priced at cost.
- Sales tax/VAT is handled by Stripe Tax (add-on).
- Account credit is 1:1 USD.
- All you-pay-what-we-pay products will be billed with any additional taxes & fees LibreLoom pays forwarded to customer.

---

1. Should the customer portal be built in the existing Connect web stack or share the main LibreServ frontend?
   - **Connect web stack.** Connect is separate from LibreServ.

2. Do we need dedicated-domain add-ons before launch, or can it wait?
   - **Use Porkbun API.** Dedicated-domain add-ons are straightforward to add and can be implemented before launch using the Porkbun API.

3. Should Stripe handle sales tax automatically, or do we need a separate tax provider?
   - **Stripe Tax calculates tax globally; Stripe is not MoR so you file returns.** Since LibreLoom is US-based, Stripe Tax covers all jurisdictions for $0.50/month + 0.05% per transaction.

4. What is the exact non-premium fallback tunnel architecture?
   - **Home-lab overflow.** LibreLoom operates a homelab that can serve as the non-premium fallback relay pool. This is cheaper than renting extra VPSes and provides a clear quality tier below premium Hetzner/Akamai relays.

No remaining open questions.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **ZDR** | Zero Data Retention. Paid inference requests are not retained by the provider. |
| **PAYGO** | Pay-as-you-go. Charged per unit actually consumed. |
| **Premium tunnel** | Routed through Hetzner/Akamai relay fleet. |
| **Non-premium fallback** | Best-effort tunnel path, may be slower or throttled. |
| **Account credit** | Prepaid balance that can be applied to subscriptions and overages. 1 USD = 1 credit. |
