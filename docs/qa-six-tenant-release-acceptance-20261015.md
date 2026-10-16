# Six-tenant real rollout acceptance — 15 October 2026

## Protected real tenants

| Tenant slug | Update model | Production | Test | UAT | QA maintenance schedule (Europe/London) |
|---|---|---|---|---|---|
| `h5c-managed-qa26` | Managed | Yes | Yes | **No** | Daily 14:00–22:00 |
| `managed1` | Managed | Yes | Yes | **No** | Daily 02:00–05:00 |
| `managed2` | Managed | Yes | Yes | **No** | Daily 02:00–05:00 |
| `h5c-custom-qa26` | Custom | Yes | Yes | Yes | Daily 14:00–22:00 |
| `custom1` | Custom | Yes | Yes | Yes | Daily 02:00–05:00 |
| `custom2` | Custom | Yes | Yes | Yes | Daily 02:00–05:00 |

All six have real active `tenants`, `tenant_release_preferences` and `tenant_settings.onboarding_completed_at`; each has ITSM and not RMM. The two older QA26 tenants are enabled `platform_release_canary_tenants`. The four new onboardings were verified in the VPS database, their update preferences corrected *only for QA* (including seven explicit maintenance days), and individual changes recorded in `platform_admin_audit_events` under `release.qa_six_tenant_policy_fix`. Prior four-tenant preference snapshot: `/tmp/h5c-six-qa-policy-before-20261015.json` (mode 0600) on `hi5central-prod-01`.

**Test environment policy:** Managed UAT must never exist for users. The UAT gateway routes for `managed1-uat`, `managed2-uat`, both corresponding `-uat-portal` and `-uat-rmm` aliases return HTTP **404**; `custom1-uat-rmm` and `custom2-uat-rmm` also return 404 (RMM has no UAT). Custom workspace/portal UAT remain HTTP 200. Older `h5c-managed-qa26-uat`/portal/rmm remain blocked. The new Caddy source is reproduced **byte for byte** using `deployment/qa26/qa-six-tenant-uat-deny-overlay.cjs` applied to the previously verified UAT source. Running SHA-256: `54391d8f91419224993e582071cbc40bfdc1c82d01f9db2dbc01aeaea1599af1`. Persistent UAT gateway rollback: Docker volume `hi5central_qa_uat_route_rollback_backups`, file `six-tenant-uat-1792098433682.caddy`. Independent recovery watchdog protected the live Caddy reload.

**Host release scope:** Planner `hi5central-certified-release-planner` and workers `hi5central-release-executor-{test,uat,live}` have been rebuilt/restarted using the QA cohort images from pinned GitHub source `115510680645c8f6aa4ae2b3da44a49d82853eff`, with the exact nonempty environment value:

```text
RELEASE_QA_TENANT_SLUGS=h5c-managed-qa26,managed1,managed2,h5c-custom-qa26,custom1,custom2
```

All four verified running and scoped, with three fresh **paused** worker heartbeats. Previous container states are preserved as `-previous-sixqa`. Global `platform_release_rollout_control.paused=true`; **0 approved certifications, 0 scheduled/running jobs** at verification. No unpausing, unsupported tenant additions, manual queue insertions or staff approval impersonations took place.

**Dev candidate awaiting genuine certification:** Public `dev.hi5central.com/release-manifest.json` and `dev-api.hi5central.com/api/v1/updates/version` both serve immutable `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`. The exact official successful [GitHub Actions run](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38791420784) completed all six jobs. Publish release notes as an authenticated Dev staff member and verify/approve that exact SHA in Admin → Certified application releases as an authenticated platform administrator. **Do not invent the human approval**.

**Initial maintenance preview at 2026-10-15T21:11Z:** four new QA tenants next Test window 2026-10-16T01:00Z (02:00 BST); original QA26 tenants next Test window 2026-10-16T13:00Z (14:00 BST), if release is already legitimately published and certified by then. These are *previews*, not actual queued deployments. Custom UAT is automatic after successful same-version Test and ≥30-minute soak, subject to its policy; Managed Production is gated by **two designated real Test canaries**, actual maintenance window and **24h release delay**; Custom Production requires explicit real tenant-admin UAT acceptance and scheduling.

**Remaining technical NO-GO:** Live gateway active Caddy Admin JSON differs from mounted read-only Caddyfile and persisted host file. Guarded exact QA live runtime cutover of one Managed QA26 tenant to `4a363cf9054b0b3667fd450f36e354b704ec2166` and full automatic rollback passed public API/web+peer+auth/blocked-UAT checks, with independent JSON snapshot. **This does not yet establish restart-durable unattended Live worker changes.** The generic Live worker stays fail-closed on source drift; review/persist a canonical runtime gateway deployment without applying unrelated pending Auth/Admin routes before permitting any automatic Live cutover.

## Acceptance checklist

1. Human publish and certification of exact Dev SHA; verified published release note, official CI, audit.
2. Explicit QA cohort exactly these six tenants; ensure global pause policy and no unrelated queued customer.
3. Safely release the QA-only Test/UAT waves after separate authorisation and read-only guards; observe real scheduled, claimed, verified, duration and rollback reference in Admin Worker Activity.
4. Verify all six immutable Test frontend+API SHAs, canary quality signoff, then all three Custom UAT SHAs; Managed UAT must remain absent.
5. Only after durable Live gateway reconciliation and real elapsed Managed release delay/maintenance windows, observe three Managed Production updates. For Custom, obtain three actual customer-admin UAT acceptances and Production schedules before promotion.
6. Prove restart, rollback, cross-tenant isolation, login/MFA and permanent version assignment. Preserve old containers, gateway backups and all unrelated customer data until success.
