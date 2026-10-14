# QA26 Fake Billing Prototype

This is a throwaway **simulated** user experience for exactly two existing QA tenants, not a Stripe customer/payment integration. It must never be offered for real invoice payment.

## Scope and safety
- Only h5c-managed-qa26 (Managed: Production + Test) and h5c-custom-qa26 (Custom: Production + UAT + Test) may use the demo.
- The retired testing-test tenant and any synthetic Stripe catalogue customers are never used, created, assigned or reenabled.
- The module services/api/src/qa26DemoBilling.js does not import Stripe, make HTTP calls, accept payment card details, create payment intents, or use Stripe keys.
- Tenant ID is derived exclusively from the authenticated session (never supplied by the browser). Requires tenant owner/admin, MFA-verified user session, and matching tenant Origin for the fake payment mutation.
- Platform billing admins may **only read** mock invoices and cannot simulate payments on behalf of tenants.
- All fake payment states are confined to qa26_demo_invoice_states, not commercial settings, real Stripe links, entitlement, subscription or invoicing tables.
- QA26_DEMO_BILLING_DISABLED=true disables all these demo endpoints with 404 as an emergency kill switch.
- Static RMM device quantities are demonstrative and never claimed to be actual billable devices.
- Non-QA tenant requests receive 404. Never link synthetic customers (e.g. cus_VR4kZVSfbeEDXD or cus_VR4kSHnVC1XKB6) to the actual QA tenants.

## Acceptance screens
- Hi5Central platform admin: https://admin.hi5central.com → Billing → a QA26 tenant → QA26 fake invoices. Shows example balances and simulated statuses, read-only.
- Managed tenant owner: https://h5c-managed-qa26.hi5central.com/settings/subscription. Shows two example invoices, including one outstanding.
- Custom tenant owner: https://h5c-custom-qa26.hi5central.com/settings/subscription. Shows three example invoices, including two outstanding.

On either owner page choose Simulate decline for an outstanding example invoice; check that it becomes payment_failed, that the balance remains outstanding, and that Hi5Central Admin reads the identical status. Then choose Simulate payment: the status becomes paid and the open balance decreases. Repeated payment is idempotent. No card numbers, payment-method data or test/real Stripe credentials should be entered.

## Explicit example pricing (ex VAT; tax is not calculated)
- Managed: 5 *fictional* ITSM seats at GBP29/month plus 20 *illustrative* RMM devices at GBP2.50/month; fictional October amount GBP195.
- Custom: 50 illustrative RMM devices at GBP2.50/month and 10 annual ITSM seats at GBP288/seat/year; fictional October amounts GBP125 and GBP2,880.
- Previous month sample invoices show paid to illustrate history only. Not evidence of any money movement.

## Build and rollout
- Run node --test test/qa26-demo-billing.mjs in services/api with DATABASE_URL configured.
- CI in .github/workflows/stripe-sandbox-billing.yml runs guards/security, isolated PostgreSQL migration and API, Admin and ITSM builds.
- New SQL migration services/api/migrations/platform-admin/153_qa26_demo_invoice_states.sql must be applied prior to enabling UI.
- Keep Platform PR #64 draft until CI and security QA pass. Do not deploy the complete draft to a general-production pool without protecting unrelated tenants and respecting Managed/Custom release policies.

## Separate real implementation later
Real Stripe billing will require explicit tenant-to-customer association, UK VAT configuration, monthly immutable device usage snapshots, actual Stripe-hosted invoice payment, payment failure/grace handling, and signed webhook reconciliation, then separate live-mode approval. None of those real financial actions are implemented by this fake QA26 prototype. Existing Stripe sandbox foundation code remains separate from this demonstration.
