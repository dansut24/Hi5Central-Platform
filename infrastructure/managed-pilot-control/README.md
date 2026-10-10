# Hi5Central — separately hosted managed customer pilot control plane

## VPS private staging evidence — 10 October 2026

**Private pilot control runtime has been deployed and verified.** This is a
non-public engineering staging result, **not** a customer-enabled pilot.
The authorised VPS has a dedicated `/workspace/phase17-pilot-control`
work directory, protected mode-0600 `runtime.env` (never in Git), and
mode-0700 backup directory. The uniquely named project is
`hi5central-pilot-control`; its private edge
`hi5central-pilot-control-edge` is Docker-internal and is attached only
to pilot API and Admin, **not any public Caddy gateway**.

Four private services — pilot PostgreSQL, Redis, API and Admin — are
**healthy**. The one-shot migration job exited 0 and applied all migrations
through `140_managed_operator_evidence.sql`. The API/Admin images are
immutable, matching revision `49de889b259d27ae6c39be2847ec843230ae9436`;
their on-host digest pins were checked before deployment. The first API
boot failed safely without the required Connect HMAC key; a fresh unique
pilot-only key was generated, enforced by preflight and the API then
became healthy. RMM/Connect is **not** routed publicly.

A custom-format backup of the fresh, empty control database was restored to
a temporary scratch database; schema checks passed and that scratch
database was dropped. The initial pilot control database contains
**0 customer tenants, 0 Platform Admin users and 0 control-plane approval
identities**. No customer invitations or public routes were created.
A VPS ingress check returned **404** for both prospective pilot-control
hosts, both pilot UAT/Test API hosts and unapproved example customer hosts.
The pre-existing Dev, Production and legacy UAT/Test services were still
healthy. Test-only scratch containers/networks were absent.

CI evidence:
- [Phase 16 full four-role API-image lifecycle](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38010660004): pass
- [Phase 17 static preflight, initial matched API/Admin image build](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38010969096): pass
- [Phase 17 private Connect HMAC configuration gate](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38011196779): pass

**Next release blocker:** enrol a real named Platform Admin with independent
MFA, verify browser login and off-host backups, and complete human-verified
operator identity before connecting any approved public gateway. The
first-admin enrolment is not silently performed here: there is no
authorised operator email or authenticated owner to bootstrap against.
A separate operator approval is still required before actual customer
environment activation.


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

## Platform Admin MFA — completed privately, real owner still pending

Mandatory pilot-only Admin MFA now uses a separate password-stage challenge,
encrypted TOTP enrolment, one-time recovery codes and a verified-session
timestamp. Actual signed-in synthetic administrator integration tests PASSED
against the running private pilot API, and the test administrator was removed.
See [Phase 18 private Admin MFA evidence](./PHASE18_PRIVATE_ADMIN_MFA.md).

**Public access remains blocked:** The first *real* pilot owner has not been
independently verified/enrolled, the trusted invitation/bootstrap ceremony
is not yet enabled, exact-host browser and SMTP tests have not passed, and
two-person operator/ingress approvals are still outstanding. Authentication
code verified on a private API is not proof of public browser readiness.

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
