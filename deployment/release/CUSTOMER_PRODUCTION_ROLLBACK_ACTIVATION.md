# Hi5Central customer Production rollback — staged activation

This is a **separate, opt-in control plane**. CI publication, a merged PR, and a
successful gateway rehearsal do **not** give a tenant permission to roll back.
Customer-facing upgrades and Production routes are not changed by these files.

## Scope and identities

- Rollback requests originate from a real authenticated Custom tenant owner/admin.
  The request contains the installed SHA, the exact previous SHA, the route
  generation, the user's reason, and a second explicit confirmation.
- A separately authenticated Hi5Central platform owner/admin reviews the exact
  build pair and the exact executor revision at the platform review endpoints.
  Both attestations expire after 1–24 hours and are individually revocable.
- SQL migrations 178, 179, 180 introduce the certification table, NOLOGIN role,
  atomic request leases and narrowly scoped host-verification functions.
  **Do not grant the worker generic table INSERT/UPDATE/DELETE.**
- The worker role starts **NOLOGIN**. Provision a unique, stage-restricted
  credential out of band and use a root-owned environment file before
  setting LOGIN. This is not done by migrations or GitHub Actions.
- Rollback executor runs separately from the generic release scheduler. It
  holds the same *session* advisory lock on the shared gateway while processing
  exactly one customer request. Its DB functions verify the tenant upgrade
  hold, original successful and verified job, reviewed build-pair compatibility,
  staff-certified executor revision, and unchanged route generation.
- No API or customer browser ever receives a Docker or gateway credential.

## Required gates before activation

1. Merge the reviewed implementation with green tests and publish the exact
   immutable `ghcr.io/dansut24/hi5central-customer-rollback-executor:sha-<SHA>`
   image. The workflow **publishes only**; it never deploys or turns it on.
2. Apply reviewed migrations 178–180 using the controlled migration runner,
   including a **rollback** transaction rehearsal first. Do not seed fake staff
   reviews, create fake customer requests, or change other customer data.
3. Independently test the dedicated DB identity: no direct table writes,
   correct gateway lock, no cross-stage grants, no claim without certification.
4. Independently rehearse API, frontend, rollback and injected failure using
   isolated network-only gateway assets. Validate the **actual prior** immutable
   API/frontend images and an intact previous Caddy snapshot.
5. Deploy the dedicated worker as a separately reviewed, **disabled** service
   with a unique root-owned database credential and pinned source/image SHA.
   `ROLLBACK_WORKER_ACTIVE` stays false. Run `--preflight` for read-only checks.
6. Obtain named staff reviews through the authenticated central admin API:
   `/api/platform/v1/releases/customer-rollback/review-compatibility` and
   `/api/platform/v1/releases/customer-rollback/certify-worker`.
   Only sign true independently verified evidence. CI green is not itself
   a certification. Record the exact revision and reviewed recovery QA run.
7. Separately deploy the updated **customer Production release-management API
   and UI through Dev→UAT→Production** using the normal customer gates. The
   original Production application may not contain rollback endpoints.
8. Enable `ROLLBACK_WORKER_ACTIVE=true` only after the restricted service,
   gateway recovery monitor and audit completion have all been independently
   certified. Set `H5C_CUSTOMER_ROLLBACK_EXECUTOR_READY=true` and pin
   `H5C_CUSTOMER_ROLLBACK_EXECUTOR_SHA` to the *same* certified worker revision
   on the release-control API. This is **not** done by CI.
9. Have the customer administrator sign a genuine exact-build request from
   the Live release centre. Monitor the event trail: requested → started →
   verified, or a failed/held review state. The worker must independently
   prove the public API and frontend, unchanged UAT, and other tenant routes
   before a verified result can be committed.
10. After any verified rollback, retain the **customer-only Production upgrade
    hold** until the platform and customer explicitly accept their recovery and
    agree on a later permitted update. Never auto-redeploy the rejected build.

## Failure semantics

- If a public check fails, the worker restores its original gateway source and
  checks the original customer API/frontend before writing a terminal failure.
- If original Production cannot be reverified, the request stays open and the
  per-tenant upgrade hold stays active. Staff intervention is mandatory.
- The watchdog checks the **durable request state** before any rescue. It never
  overwrites a verified completed rollback. Its source-hash compare-and-swap
  also rejects a later unrelated Caddy revision.
- A crash after claim but before gateway write can leave a running, expired
  claim. Such requests require reviewed reconciliation rather than an
  unattended retry. Do not manually reset leases or impersonate the customer.
- Customer-visible success must come from `state='verified'` plus host proof,
  never from HTTP 202 on a request.

## Explicit unresolved release prerequisites

The 2026-10-19 Custom rollback target `a0504d0b` is a **legacy shared-route**
application. Its frontend predates this new recovery UI. A stable control-plane
entrypoint or reviewed customer notification is still required to show recovery
status and safely release the hold **after** that old application is restored.
Do not claim this legacy acceptance test proves ongoing customer self-service
until that post-rollback status/acknowledgement path has been independently
deployed and exercised.
