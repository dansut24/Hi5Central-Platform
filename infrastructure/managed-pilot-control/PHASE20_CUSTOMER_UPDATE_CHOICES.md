# Phase 20 — customer update strategy during onboarding

## Customer decision

**Managed (recommended)** means the **customer does not require a dedicated
UAT environment**. Hi5Central must still qualify signed, stable platform
releases in its own internal Dev/Test/UAT infrastructure. The customer selects
a weekday, local start time and timezone for a managed Production maintenance
window. They may separately **opt in** to their own UAT if they need to
validate integrations, workflows or bespoke changes.

**Custom (manual)** requires the customer to retain a dedicated UAT before
choosing to promote any platform release to Production. Automatic UAT staging
and automatic Production promotion for that tenant are disabled; the customer
administrator authorises UAT → Production.

**Test** is a distinct disposable customer sandbox and may be added
independently in either option. No test data, customer configuration, access
tokens, secrets or transactional records may be copied automatically into
Production.

## Implemented in develop

- Platform Admin **New tenant** requires an explicit Managed or Custom choice,
  and for Managed records a day, 24-hour time, timezone and optional dedicated
  UAT preference. New tenant preference is persisted in the same transaction.
- Tenant onboarding adds **Keeping up to date** before ITSM/RMM configuration.
  Managed offers schedule controls and optional customer UAT; Custom requires
  independent UAT and manual approval. Choice and wizard state are written
  transactionally to the isolated tenant database.
- `tenant_release_preferences.customer_uat_opt_in` records customer UAT
  separately from Hi5Central's mandatory internal release gates.
- Managed customer preferences set `uat_auto_stage=false`. The release
  operator no longer auto-activates UAT features in a Managed customer's
  unrequested UAT. Custom preferences always set `live_auto_promote=false`.
- Settings descriptions and the tenant summary explain the difference and
  allow customers to opt into a dedicated UAT if needed.
- The policy validator rejects unknown modes, invalid days/times/timezones,
  does not silently default an unselected new customer's policy to automated
  Production release, and restricts self-hosted managed updates to verified
  release-signing public keys.

## Testing

The CI suite validates policy (including midnight-spanning windows), compiles
the ITSM wizard and Platform Admin, and creates **two synthetic tenants** in
isolated disposable real PostgreSQL/API containers: one Managed without UAT
and one Custom with UAT required. It verifies exact saved release preferences
and checks the Managed tenant did not automatically create a UAT provisioning
request or a ready customer environment. The disposable state and volumes are
deleted at test completion.

No real tenant is provisioned, no DNS routes are opened, and the public pilot
Admin remains deliberately inaccessible until first real administrator
verification and independently approved private TLS access.

## What choosing a schedule does NOT yet prove

The new choice stores **release preference and an eligibility window**. An
actual per-tenant timed image deployment mechanism, its matching signed
artifact, rollout health checks, rollback, timezone/DST handling, and an
authorised per-tenant release scheduler still require separate integration
and production acceptance testing. A preferred time stored in PostgreSQL is
not proof that the web container will update itself at that time.

Until the executor is validated, scheduling must fail closed: do not trigger
a live tenant web-image rollout or customer data/config promotion based solely
on this preference. Customer UAT opt-in also does **not** automatically
provision a customer runtime. Provisioning remains the signed and
independently reviewed operator workflow from Phases 16–19.

## Full customer pilot acceptance

1. Verify first Platform Admin owner and gated invitation (Phase 19).
2. Create a Managed sample tenant without UAT; check only requested Test
   environment and the isolated Production reservation.
3. Create a Custom sample tenant; request its dedicated UAT, complete
   signed activation and owner MFA.
4. Release an approved signed build through internal UAT; verify the Managed
   customer is scheduled only for its agreed window while Custom remains
   blocked until explicit UAT → Production authorisation.
5. Validate no cross-tenant feature/data bleed, browser sessions, complete
   audit trail, rollback, notification and off-host restore before any
   public customer Production promotion.
