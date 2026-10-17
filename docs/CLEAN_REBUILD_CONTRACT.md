# Hi5Central clean rebuild: required product and repository contract

**Baseline agreed 2026-10-17.** This document defines the product to reproduce
from a *fresh* VPS and the source-of-truth policy. It does not authorise a wipe,
release unpause, account deletion, or removal of live release code.

## Public routes and modules

| DNS route | Function | Tenant eligibility |
| --- | --- | --- |
| `hi5central.com` | Marketing, signup, verification, login and onboarding | Public |
| `customer.hi5central.com` | ITSM Production staff | ITSM entitlement |
| `customer.hi5central.com/portal` | Requester self-service ITSM web portal | ITSM entitlement |
| `customer-rmm.hi5central.com` | RMM/Control Production | RMM entitlement |
| `customer-admin.hi5central.com` | Tenant billing, invoices, subscription and upgrade/version policy | Every tenant |
| `customer-uat.hi5central.com` | ITSM UAT; customer approval for promotion | ITSM Custom only |
| `customer-test.hi5central.com` | Latest **eligible Dev** ITSM Test; never customer Live route | ITSM Managed or Custom |
| `admin.hi5central.com` | Global tenant/payment/invoice/environment/release administration | Platform staff |
| `dev.hi5central.com` | Hi5Dev internal development, QA and release preparation | Internal staff |

Tenant choices are **ITSM+Portal**, **RMM**, or **ITSM+Portal+RMM**.
RMM has **one managed Production instance** per tenant (no customer RMM
Test/UAT domains). All tenant suffixes are lowercase DNS, even if the UI
uses UAT capitalisation. Subdomain assignment must be collision-safe;
`customer`, `customer-rmm`, `customer-admin`, `customer-uat`,
`customer-test` must be reserved atomically for the tenant.

## Release semantics: mutually independent channels

- **ITSM Test:** Automatically tracks the latest approved-to-test Hi5Dev
  development build. Test is restricted/non-Production; never promote raw
  unverified Dev code to Live solely because Test advances.
- **ITSM Managed:** Dev -> certified release (build/artifacts, changelog,
  automated QA, canary, host-gate) -> Managed Production **automatically
  inside the tenant's maintenance window**; Test continues tracking Dev.
- **ITSM Custom:** Dev -> certified release -> customer UAT -> explicit
  customer-authorised Production promotion in its maintenance window;
  Test continues tracking Dev. No implicit Live approval.
- **New tenant lifecycle:** completing standard verified onboarding makes a
  tenant eligible for its permitted Test and future certified release scans,
  once the separately approved release scheduler and security gates are
  enabled. No minimum tenant count is needed to install the platform.
- **Windows/macOS/Linux agents:** latest central agent channel managed by
  Hi5Central, not tenant-selected; global guarded distribution, signing,
  compatibility check, reversible rollout and enrolled device trust required.
- **Windows/macOS/Linux native viewer + mobile viewer:** latest compatible
  centrally managed release. Remote-viewer header actions adapt to the
  **connected endpoint OS and session permissions**, not the viewer host OS.
  Mobile browser viewer is an acceptance target; do not claim a native
  Android/iOS app exists without a separately reviewed source/build.
- Hi5Dev, generic planner, Test/UAT/Live operators, host dispatcher, notes,
  gateway fences and rollback are distinct from the agent/viewer channel.

## Installer footprint: must not omit subsystems

A single operator command on a fresh approved Ubuntu LTS VPS takes a
**versioned, pinned manifest** and private config and installs:

Marketing/signup/auth/email verification/MFA; ITSM staff/requester Portal;
RMM/Control API+web; tenant Admin; global Admin; Hi5Dev; PostgreSQL+Redis;
Caddy and wildcard routing/TLS; SMTP and password reset; TURN/coturn with
UDP relay/firewall; tenant provisioning and managed/custom environments;
durable audit, backups and restore; GitHub-certified release workers with
four non-superuser stage-specific database logins, tenant+stage+fenced
approval checks and protected host deployment; artifact/image distribution
with Windows/Linux/macOS agents and viewer installers; Avalonia/C# end-user
self-service portal for tickets, software install and allowlisted scripts;
Windows qualification orchestration+software catalogue+vendor sources,
cross-platform vulnerability intelligence, refresh sync jobs and RMM
patching. The standalone Windows qualifier endpoint is an **external RMM
agent**, not an extra VPS container: install can prepare its server tables,
and be marked NOT CONFIGURED after a clean VPS rebuild until a Windows
qualification device is re-enrolled and verified. Its absence does **not**
block core installation, and qualification dispatch stays disabled.

Optional external credentials can be connected **after** installation or
skipped: SMTP, Stripe payments, public DNS/TLS, remote TURN relay, agent/viewer
signing credentials and the Windows qualification device. All server-side
software and integration settings are still installed, with accurate status
NOT CONFIGURED/SKIPPED where appropriate. A safe administrator bootstrap,
pinned image registry artifacts and backup destination remain required for
core installation. Never log credentials or pretend skipped services work.

## Database reset and retained catalogue

A **new PostgreSQL data volume** is created. Apply all reviewed canonical
migrations exactly once; seed the initial owner and infrastructure policy,
global rollout paused=true and **zero** old tenants, ITSM tickets, user
sessions, RMM devices, agent jobs, release jobs or stale customer approvals.
Do NOT truncate/drop current Production as a shortcut.

Retain and verify a private **global-only software catalogue bundle**:
`rmm_software_catalogue` (`tenant_id IS NULL`),
`rmm_software_vendor_sources`, `rmm_software_vendor_bindings`,
`rmm_software_vendor_releases`. Strip legacy user FK references, review
source secrets, and re-check installer URLs/hashes/trust before actual
deployment. Qualification evidence may be kept as product metadata;
historical queue rows and Windows runner device registration are NOT
imported. Rebuild NVD/OSV/MSRC/CISA, OUI and other public threat intelligence
from approved sources, independently verifying seed and refresh jobs.

Full old-VPS backup, encrypted off-host catalogue seed, **tested fresh DB
import**, core service health, restart/idempotency, and private pgAdmin
**full-edit** DB checks are required before the VPS reset. Tests needing
missing SMTP, public TURN, signing, qualification endpoint or payment
credentials can be skipped and separately validated later. Private pgAdmin
is mandatory on the managed VPS: bind to loopback, access through SSH/VPN,
use its own web login and a distinct application DB admin role with complete
record-edit rights and controlled schema maintenance. Do not expose it
or database port 5432 publicly, or use a cluster superuser from the UI.

## Source repository inventory and cleanup boundaries

| Repository | Current responsibility | Cleanup policy |
| --- | --- | --- |
| `Hi5Central-Platform` | Shared API, ITSM, RMM, Admin, web Portal, native Agent/Viewer copies, Avalonia AppPortal, CI, migrations | CANONICAL application integration. Never delete active native build inputs. |
| `hi5central-deploy` | Public/self-host distribution, managed Compose overlays, installer and operator | CANONICAL deploy/clean-rebuild entrypoint; preserve separated private managed secrets. |
| `Hi5Central-Agent`, `hi5central-viewer`, `hi5central-app-portal` | Standalone provenance, platform-specific release toolchains | Retain until build workflow and artifact/digest equivalence proven then archive, not silently delete. |
| `hi5central-control-server`, `hi5central-itsm`, `hi5central-rmm`, `hi5central-admin` | Legacy/import source provenance | Keep until import migration verified; archive after independent owner review. |
| `Hi5Central-Cloud` | Older managed VPS/gateway/Stripe/bootstrap scripts | Reconcile exact Caddy/host/gateway dependencies before archive. |
| `H5C-CC`, `lsl-itsm-platform` | Unverified unrelated/legacy code | Do not delete without code owner and deployment dependency validation. |

First safe cleanup removes only manifest-verified no-content accidental
command-token files and obsolete personal build logs from the Platform
agent working directory. No deletion of other agent/viewer files, patch
scripts, git history, release workflows, migration SQL or QA evidence
until protected PRs and build checks prove replacement coverage.

## Clean rebuild acceptance — zero tenants

The managed installer must be repeatable/idempotent and provide `--dry-run`,
`--verify-core`, and `--restore-catalogue`. It must pin image/agent/viewer
digests, apply migrations to NEW PostgreSQL volume, restore the checked
global software catalogue and sources, bootstrap Admin, Caddy, Control,
ITSM/Portal, RMM, Redis, release scheduler, backups and private pgAdmin.
It must start with **zero tenants** and no old ITSM/RMM operational data.

The browser-based database tool must enable **SELECT, INSERT, UPDATE and
DELETE** of application records (plus separately controlled schema-owner
operations), not only read-only queries. Verify access against a disposable
table with audit/backup discipline. No superuser credentials in pgAdmin.

SMTP, Stripe/payments, public TURN connectivity, code signing/publishing,
Windows qualification endpoint and other external integrations can be
configured later or skipped. Mark each READY/NOT CONFIGURED/SKIPPED/FAILED
independently. Their absence cannot block clean core setup, but affected
dependent functions stay unavailable until tested.

**No ten-tenant test or minimum number of new tenants is required before
the fresh VPS install/reset.** Additional signup, agent enrollment, software
qualification and ITSM release automation testing can follow when the blank
platform is installed and the operator chooses to configure them.
