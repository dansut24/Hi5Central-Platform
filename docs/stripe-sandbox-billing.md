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
