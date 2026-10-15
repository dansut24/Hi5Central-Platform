# PR69 QA26 Test/UAT operator staging review

**Status: reviewed deployment plan only; not authorisation to bypass a blocked safety control.**

## Baseline verified on 2026-10-14

- `h5c-managed-qa26`: Live + Test, update policy `hi5_managed`, no UAT tenant.
- `h5c-custom-qa26`: Live + Test + UAT, update policy `admin_controlled`.
- Live/Test/UAT each have additive `154_itsm_configuration_change_events.sql` and a verified migration marker.
- `services/api/scripts/qa26-readiness.mjs` returned ready=true when run through the authorised Live API runtime with a syntactically valid operator-supplied identity URL. **It does not assert the public Live identity route exists.**
- Verified custom owner UAT and managed owner Test People snapshots (HTTP 200) against the *private* PR69 Live preview; Managed owner UAT correctly denied (403).
- Public `https://api.hi5central.com/api/v1/internal/organisation/directory-snapshot` still returns 404 on the old runtime; this is not solved by a database migration.
- Public Test and UAT change-history endpoints return 404, and unauthenticated RMM/agent paths return 401 instead of QA sandbox 403: **old API still active**.
- All four checked Test/UAT RMM QA hostname roots return HTTP 200 (both Test RMM URLs, Custom UAT RMM and Managed UAT RMM); their legacy web routes must return 404 before launch. Public Managed UAT login also currently returns HTTP 200 despite Managed having no UAT membership/database record. This is a routing/UX blocker, not evidence of successful authentication.
- Three encrypted-at-rest host-controlled PostgreSQL backup files are stored mode 0600 under `/opt/hi5central/deployment/pilots/qa26-pr69-20261014/backups/`. The original Test and UAT API image is `sha-cb8367054b8f1106b2ab01295e3c7f388c86628b`. Production Live API remains `sha-2199e58a540ff912cccdbd137fdfbb9e8d48f3c5`.
- QA26 PR69 frontend and Live API candidates are healthy inside Docker with no published host ports; the public Caddy configuration contains no PR69 route.
- A prior Test/UAT sidecar creation with additional volume/network access was blocked by tool execution safety controls. **Do not attempt that operation using different tooling, another account, GitHub Actions, or a workaround.** Obtain a separately approved deployment path.

## Operator review requirements before Test/UAT cutover

The operator must review the blocked operation and approve an isolated deployment method before changing sandbox containers. A reviewed plan should prove all of the following:

1. **Scope:** Only the exact existing `h5c-managed-qa26` Test, `h5c-custom-qa26` Test and `h5c-custom-qa26` UAT are routed to the candidate. Managed UAT is absent. A QA-only internal Live People service is available to those sandboxes with TLS and existing Bearer credentials. No other tenant, testing canary, Production gateway route, Dev, billing or RMM production traffic changes.
2. **Images:** API and ITSM images from the *same* reviewed PR69 commit with immutable tags/digests. Do not repoint shared `sha-*`, `latest` or Production image tags. Retain old image digests for rollback.
3. **Isolation:** Separate Test/UAT databases and Redis, environment marker `RUNTIME_ENVIRONMENT=test|uat`, no RMM/agent broker, WebSocket endpoints, background workers or real device credentials. No new Docker socket privileges or unrelated secret mounts.
4. **Gateway:** Only exact QA26 hostnames/allowed Origins reach new Test/UAT candidate APIs. Preserve the original API response for unrelated Test/UAT tenants (baseline 401 for an unauthenticated organisation request), rather than redirecting unrelated tenants into the QA candidate. Exact Managed UAT workspace and all QA26 Test/UAT RMM portal hostnames must return 404; no generic wildcard gateway may expose them. Restore original gateway files atomically on failure.
5. **Identity:** Live authority may respond to approved *internal* sandbox calls authenticated by the existing long service secret and current tenant/environment grant. It must not expose People data to unauthenticated public callers. Validate that private and public routes cannot be confused.
6. **Backups:** Verify recovery and state-diff evidence without restoring into production. No tenant reseeding, fake signups, user password resets, or mutation of other tenant records.

## Post-stage gates (read-only)

Run `node scripts/qa26-stage-acceptance.mjs` **only after** the operator confirms exact route changes. The script sends only unauthenticated GETs. It expects absent Managed UAT and all Test/UAT RMM web hosts to return 404, new sandbox RMM API denials to return 403, protected ITSM history endpoints to require authentication with 401, and unrelated tenant API routes to retain the previously measured 401. A PASS does **not** replace a test of session/MFA, real tenant isolation, or actual user experience.

## Manual acceptance with existing authorised QA users

- Managed Live → Test login and MFA, no UAT grant or route.
- Custom Live → Test and UAT login, MFA, environment banners, owner and analyst grants, revocation and session expiry.
- Shared People/Teams updates in Live visible in UAT/Test, sandbox People writes denied. Verify non-QA tenants cannot read either QA directory.
- Custom UAT: create a disposable ITSM-only setting change, check actor/timestamp; identical re-save has no new audit entry; verify Live unaffected. Test remains untracked.
- Live ITSM QA ticket may link to QA RMM inventory item. Start real remote desktop only with device owner's consent, confirm remote permissions and session event logs. No real devices or session actions in UAT/Test.
- Test mobile login and MFA viewport; all original unrelated customer endpoints and live RMM remain unchanged.

**Stop and rollback** if any cross-tenant access, RMM action, wrong image SHA, unexpected gateway exposure, missing identity authority, 5xx spike or auth regression occurs. Keep PR #69 draft until all gates and human verification pass.

## Operator change log: two public tenant hostnames only

User-approved customer-facing QA scope is exactly:

- `https://h5c-managed-qa26.hi5central.com`
- `https://h5c-custom-qa26.hi5central.com`

**Do not create further DNS records, new customer tenant hostnames, or temporary QA domains.** The existing technical platform API and legacy sandbox hostnames are pre-existing infrastructure, not new domains. Keep the original QA tenant portals operational and route only these tenants to approved QA code.

A future single-origin UI may present environments through a tenant-scoped selector or URL paths (`/test/` for both, `/uat/` for Custom). That is a **design proposal, not an implemented routing cutover**: shared origin requires explicit session-cookie selection, frontend assets/runtime-config routing, environment-specific API dispatch, CSRF origin checks, tenant authentication, and browser history protections. Never simply alias Test/UAT to Live or send sandbox operations to Live DB. Do not remove functioning ITSM Test/UAT aliases until one-origin replacements have authenticated acceptance evidence. Live-only RMM access must be clearly segregated.

### Validated gateway and Live People changes (2026-10-14)

The VPS gateway originally served invalid Managed-UAT and QA26 Test/UAT RMM hostnames due to generic wildcard matchers. A Caddy candidate restricting those **five existing, invalid hosts** was validated and deployed via normal gateway reload. A normal reload of the old read-only bind-mount path initially had no effect; the gateway configuration API exposed that the running Caddy container still saw an earlier inode. The operator used the Caddy binary to reload the independently validated candidate directly, and recorded the candidate in the host persistent Caddyfile for subsequent container recreation.

**Live routing verification: 12/12 PASS.** Five invalid Managed-UAT/RMM hostnames now respond 404; the two actual QA root hostnames, the three legacy valid ITSM sandbox web hosts, and unrelated Test/UAT gateway endpoints remain reachable. No DNS records were created, and the source configuration is backed up on the VPS.

The operator also enabled a **single authenticated QA-only Live People service route** on the pre-existing `api.hi5central.com`: `POST /api/v1/internal/organisation/directory-snapshot`, requiring the QA staging header `X-Hi5-QA26-Internal: pr69` and the independently verified Bearer service credential. This reverse-proxies only to the existing healthy PR69 Live API preview. Unmarked POST and GET still return 404; marked unauthorised POST returns 401. Marked authenticated Live test returned 200 for Managed Test and Custom UAT owner directory snapshots, and 403 for Managed UAT. Normal customer-facing API routes are unchanged.

**Post-change public acceptance: 7/12 PASS.** The five outstanding checks are on the **existing, unupgraded** Test/UAT API runtimes: three API-level RMM denial assertions expect 403 but receive legacy unauthenticated 401; two ITSM configuration-history routes expect 401 but currently return 404. These are not fixed by changes to the Caddy web-host deny rules, and they must not be faked as successful by rewriting public status codes. The previously blocked isolated Test/UAT sidecar operation was **not** retried or bypassed.

**No-go for declaring the full release live** until the Test/UAT runtime deployment has an explicitly approved safe procedure, the public API acceptance gate passes, environment selection uses the approved two tenant hostnames, and authenticated browser + consenting QA remote-device tests are completed. Do not merge PR #69 or reroute other tenants just to clear the gate.

### Gateway bind-mount restart caveat

The running `hi5central-web` container has a **read-only file bind mount** at `/etc/caddy/Caddyfile`. The host's persistent `/opt/hi5central/deployment/Caddyfile` contains the validated QA26 deny and Live People routing configuration, but the existing container continues to expose an older mounted file inode at `/etc/caddy/Caddyfile`. Accordingly, using `caddy reload --config /etc/caddy/Caddyfile` loads the old configuration even though the host path has the new bytes.

The operator explicitly reloaded the prevalidated candidate from `/tmp/Caddyfile.qa26-people-candidate` via Caddy's admin interface and verified the active in-memory configuration, public 404 denials, QA Live People authorisation, and unaffected endpoints. **This active state is not guaranteed to survive restarting the existing Caddy container**: a mere restart of that container may still read the old mounted inode. A normal, separately reviewed gateway **recreation** with the host persistent config is required for durable restart-safe operation; do not recreate the shared Production gateway as a side effect of Test/UAT testing. Retain the original gateway backup and perform full public smoke checks after any approved gateway recreation. The hourly readiness monitor should treat reappearing invalid QA26 web hosts as a regression.
