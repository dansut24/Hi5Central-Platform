# Phase 21 — fix "tenant added but nothing happens" in Platform Admin

**Root cause (10 October 2026):** A tenant created through
`admin.hi5central.com` was only a central database registration. The older
Production Admin UI displayed an `active` status and generated hostnames even
when no Production runtime, no initial owner, no UAT provisioning request and
no email invitation existed. The public Production stack is **different**
from the isolated, non-public pilot control plane and has not been
replaced by the pilot image releases.

## Behaviour implemented on develop

1. **New tenant** requires company name, slug, first owner full name and email,
   modules, and an explicit Managed/Custom release mode.
2. Within one database transaction, store the customer, modules, billing,
   update preference, first-owner onboarding intent and environment
   reservations. The newly reserved Production environment is explicitly
   **pending** (never claim deployed or customer accessible solely from
   a hostname reservation).
3. If **Custom** or Managed with customer UAT opt-in, automatically enqueue
   **one** separate UAT provisioning request for independent operator approval.
   Managed without UAT opt-in receives no UAT provisioning request.
4. The server response says `awaiting_environment`,
   `productionActivated:false`, `invitationSent:false`, and
   `uatQueued` (as appropriate); this is not a claim of successful
   provisioning.
5. The Admin UI displays the customer registration result and a
   **provisioning pending** notice. It withholds Workspace/Portal/RMM links
   until Production is actually marked ready **and** isolation verified.
   The card shows queued/requested/claimed UAT status, rather than looking
   like a functioning customer.
6. Earlier registrations without an owner can be repaired using the
   `/api/platform/v1/tenants/:id/onboarding-owner` endpoint and the new
   first-owner contact form. This records an owner contact only: **no
   user account, password, invitation, MFA bypass or session is created.**
   Already-issued invitations cannot be silently replaced.

## CI acceptance tests

The `test-first-admin-lifecycle.mjs` disposable API/PostgreSQL suite now
creates both Managed and Custom customers and verifies:

- missing Managed/Custom choice, invalid schedule and missing first-owner
  information fail validation;
- Custom automatically queues exactly one UAT request, Managed without opt-in
  queues none, while new Production is still `pending`;
- neither customer has an owner membership, access token or sent invitation;
- first-owner contact can be repaired on a prior registration but not
  silently changed after an invitation has been issued;
- duplicate UAT requests are returned as already queued;
- customer-specific UAT → Production preflight remains blocked without a
  verified, isolated customer UAT **and** Production runtime;
- all CI-only tenants, credentials, services and volumes are destroyed.

## Still required for real customer usability

**Registrations alone cannot deliver a real pilot customer environment.**
The missing operational steps are deliberate security gates:

- execute the isolated managed UAT (and separately managed Production)
  provisioning worker under an authorised operator, with attested database,
  Redis, DNS and network identities;
- register separate human operator/reviewer/executor identities and keys;
- finish first-platform-Admin verified email/MFA and trusted mail relay;
- send the customer owner's invitation **after** approved environment
  activation and then complete the customer onboarding wizard in a browser;
- implement customer-specific configuration diff/review/apply with audit and
  rollback. The existing platform-wide release promotion endpoint is **not**
  a substitute for per-customer UAT → Production settings promotion.

**The existing public `admin.hi5central.com` Production deployment has
not been updated yet.** It uses the older
`hi5central-prod-admin` and `hi5central-api` images. The changes
above are committed to `develop` and tested in disposable CI, and must pass
a dedicated, reviewed Production cutover and migration sequence. Do not
insert additional real tenants into the Production system just to retry
the new UI before it is deployed.

## Next live pilot acceptance

1. Read-only inventory existing tenant records and their actual environments.
   Preserve earlier customer registrations.
2. Upgrade only the dedicated private pilot controller to a verified
   matched API/Admin image pair, run migration 144 and confirm zero real users.
3. Independently enrol the first real pilot Platform Admin with MFA and
   approved SMTP/ingress; this remains required.
4. In the approved pilot Admin, create one Custom customer, observe automatic
   UAT request, provision/attest UAT, issue owner invitation, walk onboarding,
   make a customer-specific safe config change and approve a UAT → Production
   dry-run **without touching public Production**.
5. After signed release, tested rollback, off-host backup/restore and gateway
   mapping review, schedule production Admin cutover separately.
