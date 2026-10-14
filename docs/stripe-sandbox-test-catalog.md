# Hi5Central Stripe sandbox catalogue and QA evidence

Recorded: 2026-10-13. Connected Stripe context: **Hi5 Central sandbox** (`livemode=false`). All Stripe IDs below belong to the isolated sandbox; **none** are production/live IDs. No secrets, payment card data, or real customer details belong in this document.

## Recommended launch price list

Prices are **exclusive of applicable VAT**. These are starting commercial recommendations, not contractual price promises; launch pricing requires commercial sign-off.

| Billing item | GBP price | Stripe price lookup key | Stripe test price ID |
| --- | ---: | --- | --- |
| ITSM support agent, monthly | £29 / agent / month | `hi5_itsm_agent_gbp_monthly_v1` | `price_1UQCaWBCiFdWXLmO30UMLI7k` |
| ITSM support agent, annual | £288 / agent / year (£24 monthly equivalent) | `hi5_itsm_agent_gbp_annual_v1` | `price_1UQCajBCiFdWXLmO6cndaqTJ` |
| RMM eligible device, monthly | £2.50 / eligible device / month | `hi5_rmm_device_gbp_monthly_v1` | `price_1UQCamBCiFdWXLmOXAszs1cb` |

ITSM sandbox product: `prod_VR4j6AL2AelUbY`. RMM sandbox product: `prod_VR4jN1Wtw4dWRi`.

ITSM seats are licensed subscription quantities. Requesters are not chargeable seats. RMM uses a licensed quantity in this catalogue. **A production billing engine is not yet wired up**: before any automatic renewal invoices, calculate an immutable billing-cycle snapshot, exclude disabled devices or devices lacking a verified check-in within the preceding 30 days, reconcile quantity, and update using a controlled no-proration cycle boundary. Do not assume the illustrative quantities below reflect real tenant inventory.

## Synthetic sandbox customers

| Scenario | Synthetic Stripe customer | Subscription(s) | Status when created |
| --- | --- | --- | --- |
| Managed trial: 5 ITSM seats + 20 eligible devices | `cus_VR4kZVSfbeEDXD` | `sub_1UQCbdBCiFdWXLmObK1SGCxh` | trialing |
| Custom trial: 10 ITSM seats annually + 50 monthly devices | `cus_VR4kSHnVC1XKB6` | `sub_1UQCbgBCiFdWXLmOgqHCkJjA`, `sub_1UQCbjBCiFdWXLmOMTYl1hOl` | trialing |
| Payment and invoice lifecycle testing | `cus_VR4kBWGgmcJwJ4` | Checkout Session generated but not completed | unpaid checkout |

- All customer email addresses use `@example.invalid`. They are synthetic records and **not** actual Hi5Central tenants.
- Trial term: 30 days. Missing payment method at trial end: **pause**.
- Trial creation generated **£0 paid invoices**; this is not a successful card charge.
- Managed illustrative price: £195/month excl. VAT.
- Custom illustrative price: £2,880/year ITSM + £125/month RMM, excl. VAT.
- Checkout test: `cs_test_a1Co1c97t6TUWUaeaX2XfGtnl7X4I8F93OFpX2EYr0afoF7r2e5GzEsLi6` (subscription for one ITSM seat at £29/month), **open, unpaid** when created. The hosted checkout URL is short-lived. Use Stripe's Dashboard or API to obtain a fresh test Checkout URL after expiry.
- Illustrative RMM invoice: `in_1UQCeMBCiFdWXLmOYW6eKyqS`, **open £20, payment not attempted**; eight eligible devices x £2.50; automatic collection disabled. Its hosted invoice page may be used with a Stripe test card. It is not tied to any real tenant.
- The sandbox default payment-method configuration currently supports cards, but Bacs Direct Debit was not enabled in the inspected default configuration.
- Stripe Tax settings were in `pending` status. Do not represent automatic VAT calculations as tested or deploy these prices in live billing before tax configuration is complete.

## Stripe test payments — manual acceptance

When opening a hosted **test-mode** Checkout/Invoice URL, use Stripe's test card numbers, not real card details:

- Successful Visa test payment: `4242 4242 4242 4242` (any future expiry and valid CVC).
- Declined payment: `4000 0000 0000 0002` (generic decline).

Test steps:
1. In the Stripe sandbox, verify the exact catalogue prices and all subscriptions show `livemode=false`.
2. Open the hosted test Checkout URL; first attempt a decline, verify no completed payment, then a successful test card. Confirm the resulting sandbox subscription and invoice/charge details.
3. Separately open the £20 synthetic invoice and complete a test payment, if desired. Check invoice status moves `open` → `paid`.
4. Confirm real tenant balances, platform entitlements, Production webhooks and live billing were not touched.
5. After webhook verification has been implemented, repeat these tests against a dedicated signed-test-webhook endpoint and assert idempotent delivery/replay/tenant isolation.
6. Before merging PR #64: validate build/migration CI and ensure all Stripe API write operations remain isolated to explicitly authorized test-mode flows; never add test secrets to GitHub.

## Payment acceptance results — verified after user's test

Both charges are confirmed successful in Stripe **test mode**:

| Test | Stripe evidence | Outcome |
| --- | --- | --- |
| Hosted £29 ITSM Checkout | `cs_test_a1Co1c97t6TUWUaeaX2XfGtnl7X4I8F93OFpX2EYr0afoF7r2e5GzEsLi6`; subscription `sub_1UQCjwBCiFdWXLmOnBnUe2YI`; PaymentIntent `pi_3UQCjvBCiFdWXLmO1iT3qHZD` | Checkout complete, payment paid; charge succeeded, £29.00 |
| £20 RMM illustrative invoice | `in_1UQCeMBCiFdWXLmOYW6eKyqS`; PaymentIntent `pi_3UQCeWBCiFdWXLmO0q0ZwW58` | Invoice paid, £20.00 received in test mode |

Total test-mode captured payments: **£49.00**. No live money moved. Authenticated Stripe readback found both `payment_intent.succeeded`, `charge.succeeded`, `checkout.session.completed`, and `invoice.paid` events, with sandbox `livemode=false`. Earlier trial-created £0 invoices are separate, not paid card revenue.

## Signed webhook processing (prepared in PR #64; not deployed)

`POST /api/platform/v1/billing/stripe/webhook` is **disabled by default**. Route works only in managed central live runtime when all of:

- `STRIPE_BILLING_MODE=sandbox`
- `STRIPE_SECRET_KEY=sk_test_...` (or appropriate `rk_test_...` with read permissions)
- `STRIPE_EXPECTED_ACCOUNT_ID=acct_...`
- `STRIPE_WEBHOOK_ENABLED=true`
- `STRIPE_WEBHOOK_SECRET=whsec_...` matching the **sandbox** webhook destination's signing secret

Only after PR and isolated QA approval should operators configure a Stripe **test-mode** webhook destination pointing at the central API host URL. Do **not** reuse a live webhook destination, add fake subscriptions to a real tenant automatically, put secrets in GitHub, or enable this before endpoint routing and database migration are verified. Subscribe to `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, and `payment_intent.payment_failed` (other supported events are optional).

The receiver verifies the raw-body HMAC signature and five-minute timestamp tolerance, refuses live-mode events, checks any Connect account identifier, and stores a minimal receipt keyed by immutable Stripe event ID. Concurrent retries are idempotent. Unmapped synthetic customers are recorded as `unmapped`; a signature alone never creates/activates an entitlement. **No status sync, billing writes, or retrospective Stripe event import is implemented.** Admin Billing displays locally ingested receipts via an authorized read-only endpoint, not a Stripe-wide backfill.

For QA: deploy only a reviewed Test build; verify the public route is not callable before explicit sandbox configuration; configure the test webhook secret on the isolated appropriate instance (never in a commit); submit a Stripe sandbox event; confirm one receipt despite retry; verify no other tenant is updated. Current code intentionally requires the central managed API runtime and will **not** activate a sandbox webhook on Test/UAT pools; test unit/HTTP acceptance in isolated CI first and plan approved routing before any public activation.

## Outstanding launch gates

- Stripe webhooks with strict signature validation, replay/idempotency, correct tenant ownership and monetary state reconciliation.
- Trial-to-paid policy, seat counting, 30-day RMM cycle cutoff and snapshot; invoice month reconciliation and proration rules.
- Billing Portal, changes/cancellations, failure retry/grace, export and retention.
- VAT/business registration and Bacs configuration if enabled.
- Admin/tenant customer-facing billing UI and per-tenant controls.
- Separate pricing approval and explicit live-mode authorization. PR #64 remains draft and cannot create live charges.
