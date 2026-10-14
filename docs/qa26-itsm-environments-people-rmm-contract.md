# QA26: shared People, ITSM environment configuration and live-only RMM

## Scope

The two explicitly designated QA tenants are `h5c-managed-qa26` and `h5c-custom-qa26`. No Production customer migration, sandbox reset, billing write or runtime traffic cutover is included in this branch.

## Data ownership policy

| Domain | Owner | Live | UAT (Custom ITSM only) | Test (ITSM) |
| --- | --- | --- | --- | --- |
| Global user login, verified email, MFA recovery | Central identity (Live) | Authoritative | Live-issued handoff, no credentials copied | Live-issued handoff, no credentials copied |
| Membership/access | Live tenant directory | Authoritative | Explicit grant; owner implicit if Custom | Explicit grant; owner implicit |
| ITSM roles, workflows, SLA, forms, notifications | Environment-specific configuration | Supported | Supported; audited for supported settings | Disposable; no config promotion history |
| Ticket records, comments, attachments | Operational data | Live | Isolated non-live data | Isolated non-live data |
| Branding, legal organisation identity, security policy, billing | Live tenant controls | Authoritative | Read-through required; not eligible for config promotion | Read-through required; not eligible for config promotion |
| RMM devices, agents, patching, remote sessions, automations | Live RMM only | Authoritative | RMM module and URL disabled | RMM module and URL disabled |

Users are *identities* in Live, not three independent accounts. Sandbox rows are non-secret local identity projections for foreign-key compatibility. The provisioner updates their email/name/verification when reconciled. **The projection is not yet an always-live read-through.** Directory synchronization triggers and role-per-environment support still need separate work and E2E tests.

A person must not acquire Live RMM remote privileges through Test/UAT ITSM permissions. Live ITSM can refer to tenant-scoped RMM devices through a typed link, but all remote session creation and authorisation remains in the Live RMM service. Test/UAT must not start real-device sessions as a side-effect of an ITSM test.

## Delivered in this change

- Managed ITSM receives Test only; Custom ITSM receives Test + UAT. Unknown update modes fail closed.
- Live identity access grants require an active membership, ready environment and a Custom policy for UAT.
- Managed UAT is omitted from the customer Release Centre and cannot be assigned through People environment grants.
- New sandbox RMM modules, config and URL are disabled; existing sandbox tenant RMM flags are disabled on next explicit reconciliation. No Live RMM records are altered.
- Source user name/email/verified state is reconciled to sandbox projections without copying a password hash or MFA secret.
- An append-only, tenant-scoped ITSM settings history records a hash transition, field names, actor and timestamp in UAT and Live. No raw values are duplicated.
- A permission-checked history panel appears within ITSM Release Management. Test contains no change ledger.

## Deliberately not delivered yet

- Cross-database Ahead/Behind counts, three-way semantic diff/conflict resolution, selective promotion and rollback. They need an authenticated central compare/coordinator; naive copying would corrupt Production.
- Tracking of every ITSM entity (roles, custom fields, SLA objects, templates, etc.). This phase captures only the `settings.itsm` writer.
- Synchronisation of all user/People business records or independent UAT-specific role assignment.
- Full Production-read-through for legal identity/security/branding as it is being developed in separate release work.
- Production ITSM-ticket-to-RMM device binding and launch. The existing contextual device UI is not a substitute for scoped backend authorization.

## QA acceptance order

1. Review unit/API/ITSM build checks in the branch PR.
2. Apply the new migration in isolated environments *before* enabling this API build; do not migrate Production without a reviewed window.
3. Verify Managed QA26 reports only Test + Live and rejects UAT grants, while Custom QA26 exposes Test + UAT + Live.
4. Verify the RMM module is absent in all ITSM sandbox identities while the existing Live RMM portal retains its devices.
5. In Custom UAT update one non-sensitive ITSM setting; a local history entry appears. Re-save unchanged settings; no duplicate entry. In Test make the same change; no audit history entry.
6. Verify tenant isolation: a session from one QA tenant cannot read or modify the other tenant's changes.
7. Confirm Live production ITSM settings are unchanged by UAT writes. Verify no Production routing or payment changes.
8. Only after the above, design the central comparison service, snapshot baselines and approval-driven selective sync.

## Continuation summary

As of 2026-10-14 this branch implements environment and RMM boundaries, identity projection reconciliation, and the first ITSM settings-only change ledger. Next: pass CI, stage only QA tenants, then implement read-only shared People read-through and a 3-way diff coordinator before any selective promotion.


## Canonical directory and live-only remote perimeter
UAT/Test `GET /api/v1/organisation` now reads the Live People/Teams/Departments/Sites snapshot using the existing long environment-service secret. Live revalidates the user's tenant and access grant and prevents cross-tenant reads. Changes to those shared directory records are rejected outside Live. On Live authority outage, the sandbox returns 503; it does not silently read stale local People rows.

**Important rollout dependency:** The internal read route must be deployed to Live before switching UAT/Test to the new read-through API. Existing ITSM tickets may still reference locally cached sandbox identities: a subsequent phase must reconcile these to central canonical person IDs for fully shared record selection. RMM remote and Connect session API access is denied on Test/UAT and remains live-only; agent broker, enrollment, and device linkage require additional E2E hardening.

## Ticket-to-RMM direct browser remote launch
The existing device widget in ITSM ticket details now offers **Start remote desktop** for an online Agent when the user's session has effective Live RMM permissions. On click it calls the existing RMM remote-session API with `mode: console, viewerClient: browser`, validates the resulting HTTPS viewer host against the tenant's RMM hostname, and launches in a new browser tab. Offline Agent sessions, unauthorised users, Test and UAT are blocked. Existing **Open in RMM** link remains available. No session credentials are stored in ITSM tickets; session creation continues to be authorised and logged by RMM. Full WebKit/real-agent end-to-end QA is still pending.


## API perimeter hardening (follow-up)
The Hono API middleware rejects all `/api/v1/rmm/*` and `/api/v1/agent/*` requests in Test and UAT before endpoint handlers, covering power, patching, scripts, enrollment, polling and remote sessions. Live and protected internal Dev keep current behaviour. WebSocket listeners and operational workers remain separate and require explicit non-sandbox deployment isolation; this HTTP gate is not a substitute for runtime segregation.
