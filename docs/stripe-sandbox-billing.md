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
