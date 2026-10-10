# Hi5Central — separately hosted managed customer pilot control plane

**Current state: PRIVATE PILOT STAGING, not public customer onboarding.**
Do not open a new customer route merely because this Compose stack is healthy.
The single-tenant `dev.hi5central.com` must remain unchanged.

## Objective: user-created customer in Platform Admin

Create a new independent managed control database and Admin/API (not a clone
of Production), then let the platform owner enter company name and slug using
**New tenant**. The already-implemented managed-multi Admin route supports
creating a tenant and requesting its separate UAT/Test environments. An
operator approval is currently required to turn those requests into actual
runtimes and first-owner invitations.

Planned, not yet published control hosts:
- `https://pilot-admin.hi5central.com` — pilot Platform Admin GUI
- `https://pilot-control-api.hi5central.com` — independent pilot control API
- `https://pilot-uat-api.hi5central.com` — dedicated managed customer UAT API
- `https://pilot-test-api.hi5central.com` — dedicated managed customer Test API

Pilot customer names follow existing policy:
`companynameuat.hi5central.com`,
`companynameuat-portal.hi5central.com`,
`companynametest.hi5central.com`,
`companynametest-portal.hi5central.com`.
No additional `pilot-` wildcard is allowed to bypass approved routing.
Existing `admin.hi5central.com`, `api.hi5central.com`, legacy UAT/Test,
`companyname.hi5central.com` and `dev.hi5central.com` remain unchanged.

## Physical isolation and fail-closed provisioning

The pilot-control stack uses its **own** PostgreSQL 17, Redis 8, API, Admin
and one-shot migration runner, under the unique
`hi5central-pilot-control` Compose project. The database and Redis have
unique credentials and separate new named Docker volumes. Neither is exposed
on any host port or attached to the edge network. The Admin and API attach
only to a unique `hi5central-pilot-control-edge` Docker bridge (the API
also attaches to the internal data bridge), never the Production or Dev
networks. The edge bridge starts with no public gateway membership.

Copy `runtime.env.example` into a fresh secure operator work directory;
replace placeholders with **new high-entropy credentials** and four
reviewed digest-pinned images. `runtime.env` must have mode 0600 and
must never be committed, emailed or printed to logs.

Run `node preflight.mjs --check` from the same directory to check credentials,
image pins and `docker compose config` topology. It is read-only and cannot
enrol operators, enable customer hosts or deploy resources. The continuous
integration preflight uses *fake ephemeral secrets* and likewise creates no
pilot resources. Only an approved operator can later run
`docker compose --env-file runtime.env -f compose.yml up -d` on the
authorised VPS, after a backup and rollback plan have been tested.

## Platform Admin MFA is an explicit public-access blocker

The current direct Platform Admin password endpoint does **not** complete a
separate MFA challenge. Tenant workspace MFA and the signed sandbox operator
approval flow do not automatically provide central Admin MFA. Before exposing
pilot Admin to the public Internet, implement and test independent Admin MFA
or a correctly verified, MFA-enforced SSO provider, including initial platform
administrator enrolment, recovery, logout, session revocation and audit.

Do not create a test user with a published static password, copy a Dev or
Production account/password, disable MFA, or make a public route through
an unauthenticated gateway just to expedite the pilot.

## Acceptance sequence for a real end-to-end customer

1. **Independent platform owner login:** a named operator verifies the
   correct pilot control database, signs in to private Admin using MFA,
   verifies that the tenant list is isolated and can create a *new* customer
   by choosing any available slug. The UI must not route its Production
   hostname to Production until independently approved.
2. **Environment request:** Admin queues `UAT` and `Test` for that tenant;
   no automatic route, RMM device broker, production data copy or cross-tenant
   shared session is allowed.
3. **Provision/activation:** an independently authenticated operator and
   reviewer authorise the exact request; a separate executor performs
   activation against environment-attested PostgreSQL/Redis. Approval does
   not imply public DNS or TLS permission. Run DB backup/restore and identity
   attestation checks.
4. **Initial owner email:** use an approved isolated SMTP relay to send an
   owner invitation to the customer's chosen real email. Prove one-time
   redemption, cancellation, mandatory MFA and no session until MFA.
5. **Four-role browser E2E:** owner, admin, analyst, requester log in through
   their exact tenant workspace/Portal hosts; verify permissions, first login
   UX, sessions, logout, password reset and notification delivery.
6. **Isolation and recovery:** refuse unapproved customer names, cross-origin
   cookies, cross-environment tokens, unapproved RMM/Connect. Suspend a tenant;
   verify old sessions fail. Test restore, rollback, audit retention.
7. **Future phases:** Test reset and allowlisted configuration promotions
   Test → UAT → Production, beta/stable feature rollout, and independently
   compatible Agent/Viewer releases are separate acceptance requirements.
   They are not delivered merely by creating tenant/environment records.

## Evidence

- [Four-role disposable UAT/Test integration](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38010660004) passed.
- [Pilot control static CI](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38010901118) passed.
- `infrastructure/managed-sandbox/PHASE16_CUSTOMER_ACTIVATION_GATE.md`
  tracks remaining operator identity controls and signed approvals.

**Until the MFA, signed human approval, SMTP, backup and exact-host ingress
gates are complete, treat the pilot control as private infrastructure only.**
