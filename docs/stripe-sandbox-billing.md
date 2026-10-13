# Stripe sandbox billing foundation

Scope: Hi5Central managed B2B ITSM/RMM billing. This branch is **read-only** to Stripe. It creates no Stripe products, prices, subscriptions, invoices, customers, payment methods, or payments; no changes to live billing or tenant entitlements.

## Configuration

The ChatGPT Stripe connection is **not** a credential for the deployed API. The VPS/runtime needs its own securely managed Stripe **test-mode restricted or secret key** when sandbox inspection is desired. Do not commit keys or print them in logs.

- `STRIPE_BILLING_MODE=sandbox` (default is disabled).
- `STRIPE_SECRET_KEY=sk_test_...` (server-side only).
- `STRIPE_EXPECTED_ACCOUNT_ID=acct_...` (recommended; the read-only account check fails closed if the account does not match).

Any missing, live-mode, or incorrectly scoped key disables the Stripe connection. No /v1 Stripe POST calls are implemented.

## Platform Admin endpoints

- `GET /api/platform/v1/billing/stripe/status`: admin billing-role only, returns sandbox configuration state; with a configured key, verifies the Stripe account using a GET request.
- `GET /api/platform/v1/billing/tenants/:tenantId/preview`: admin billing-role only, shows tenant modules, existing test-mode Stripe binding (if any) and real-time RMM billable-device counts. This **does not generate a snapshot or invoice**.

Eligibility preview: devices are excluded when the tenant does not have RMM enabled; disabled devices are excluded; devices with no authenticated connection/telemetry are excluded; devices whose last authenticated connection/telemetry is older than 30 days are excluded. A recent verified check-in is billable even if currently offline. An invoice-cycle snapshot must be persisted immutably at a defined cutoff in the next phase; the preview is not authoritative billing history.

`tenant_stripe_billing_links` stores future sandbox-only customer/subscription associations. `tenant_rmm_billing_snapshots` stores future invoice-cycle evidence. Both tables are empty after migration; live account IDs are refused by design.

## Next review gates (not yet implemented)

1. Approve ITSM base and RMM device prices, plan/trial duration, VAT handling and whether a payment method is required at trial start.
2. Implement verified Stripe webhook signatures, replay protection and idempotent tenant-scoped subscription synchronization.
3. Implement immutable cycle snapshots and usage posting with reconciliation/test clocks.
4. Implement approved Checkout, Customer Portal, UK payment methods, Bacs mandates, payment-failure grace, audit and tenant export.
5. QA isolated Managed/Custom tenant paths, staging/rollback, and **separately authorize** any live-mode enablement.

Do not apply this branch to production until migrations, CI and review gates pass.

## Signed event and read-only reconciliation increment

Draft PR #64 adds migrations `151_stripe_sandbox_webhook_ledger.sql` and `152_stripe_multi_subscription_links.sql`. The latter allows one test customer to have an independently linked ITSM, RMM, or combined Stripe subscription; it does **not** link any tenant automatically.

Authenticated Platform Billing read-only endpoints (requires owner/admin/billing role):

- `GET /api/platform/v1/billing/stripe/payments`: freshly retrieves current test-mode PaymentIntents from the pinned Stripe sandbox; **no production payment access**.
- `GET /api/platform/v1/billing/stripe/events`: lists signed webhook receipt audit rows stored locally; may be empty before a configured webhook destination delivers events.
- `GET /api/platform/v1/billing/tenants/:tenantId/stripe/reconcile-preview`: reads linked customer subscriptions and invoices directly from Stripe, returning a safe `linked:false` response otherwise. Shows subscription status, quantities, totals, invoice paid/remaining, but does **not** write any commercial settings.
- `POST /api/platform/v1/billing/stripe/webhook`: **not yet activated** signed Stripe endpoint, guarded by sandbox key, account pinning, runtime, enable switch and signing secret; no tenant entitlements are changed.

The webhook ledger only treats a subscription-scoped event as linked if both the test-mode Stripe customer and subscription associations match the same tenant. Signed event receipt does not imply an entitlement. No customer/subscription mappings have been created for real QA tenants yet. Actual billing synchronization, migration rollout, VAT configuration, subscription upgrades/cancellation, checkout integration into onboarding and live payments remain blocked on additional QA and approval.

**Do not merge or deploy until the full PR CI checks pass.**


## QA26 tenant-only sandbox acceptance

**Authoritative QA targets (verified 2026-10-14 on the central tenant database and public routes):**

| QA tenant | Policy | Existing environments | Public application hosts (HTTP 200 at initial audit) |
| --- | --- | --- | --- |
| `h5c-managed-qa26` | Managed | Production + Test | `h5c-managed-qa26.hi5central.com`; `h5c-managed-qa26test.hi5central.com` |
| `h5c-custom-qa26` | Custom | Production + UAT + Test | `h5c-custom-qa26.hi5central.com`; `h5c-custom-qa26uat.hi5central.com`; `h5c-custom-qa26test.hi5central.com` |

The customer-facing billing UI must be available only to an authenticated owner or authorized billing administrator **for their own tenant**, not another tenant's invoice/customer ID. Hi5Central platform admins retain cross-tenant billing oversight in `admin.hi5central.com`. Include invoice numbers, issued/due dates, amounts, status, trial/plan details, and RMM device quantities with the verified last-check-in 30-day exclusion. An optional **Stripe test-mode hosted invoice payment URL** is provided only for an explicitly mapped invoice belonging to the authenticated QA tenant. Never accept an arbitrary browser-supplied Stripe invoice/customer ID as proof of tenant ownership. Check hosted invoice URL validity with Stripe, enforce sandbox-only and expected customer/account matching, then use signed idempotent webhooks to reconcile payment state; never mark paid just because the hosted page was opened or because the browser returned.

- `h5c-custom-qa26` has active monthly commercial settings in the central database; **preserve** these values. `h5c-managed-qa26` currently lacks a commercial-settings row; do not guess its pricing, trial or quantities. Establish explicit approved sandbox configuration.
- Do not attach the synthetic `cus_...` examples in `docs/stripe-sandbox-test-catalog.md` to either QA tenant automatically. They are unrelated sandbox demonstration customers. Link only an explicitly created and verified test-mode Stripe customer/subscription to the exact QA tenant UUID through the tenant billing tables, with tests for wrong-tenant and duplicate associations.
- Managed QA policy: Test receives the latest candidate; Production updates only through its maintenance/release policy. Custom QA policy: Test may run latest, UAT receives candidate, and Production promotion remains customer-approved. Billing tests may not bypass either policy or affect non-QA tenants.
- `testing-test.hi5central.com` and its isolated `stripeqa20261013` pilot are **obsolete and prohibited** as targets. The old public Stripe route was disabled on 2026-10-14, with the Test Caddy baseline restored to SHA-256 `69d7154bf19e3fcad0d36fe9e4eb91bc52a52bd5d96388d89cfe45cdf31d0882`. Residual `testing-test` Caddy routes and pilot containers require a reviewed, dependency-safe cleanup. They must not be restored by another generator run.
- Prior to claiming complete: exercise owner MFA and tenant scope; prove platform admin and both QA tenant invoice screens; create and pay a Stripe-hosted **sandbox** invoice using test credentials; confirm received signed webhook, replay idempotency, correct paid status in *both* billing views, no cross-tenant mutation, and no real Stripe/live environment activity.

**Status as of this scoping change:** QA tenants and their five routes verified, obsolete public Stripe webhook disabled, no central invoice rows yet for either QA tenant. The existing Stripe PR is still read-only for platform admin and does **not** yet implement QA customer invoices, owner-facing payment initiation or end-to-end paid-state synchronization. Do not present these as completed until supported by independent tests and deployed build evidence.
