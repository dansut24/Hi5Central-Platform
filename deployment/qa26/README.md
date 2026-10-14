# QA26 existing-pool release contract — no sidecars

**Scope:** two existing customers (Managed QA26, Custom QA26), one shared Test API+ITSM service pool and one shared UAT API+ITSM service pool. RMM remains Live-only. The QA26 PR images are staged on the VPS but not deployed.

## Why the previous deployment was blocked

The old approach attempted *new* sandbox API sidecars with additional network/secret mounts; the host execution safety controls blocked that operation. Do not retry it through Docker, GitHub Actions, another tool, account, or operator service. Separately, the existing Test/UAT Compose container labels point at a deleted `/tmp/hi5-test-cb836705.override.yml`. A simple Compose recreation from the remaining files would silently select earlier API/frontend images.

## Durable image lock files

- `compose.sandbox-current-image-lock.yml`: exact API/ITSM images on the existing healthy Test/UAT containers. The original service networks, mounts, environment configuration and credentials remain inherited from the already-present Compose layers.
- `compose.sandbox-pr69-image-lock.yml`: exact API/ITSM CI-published images from PR69 commit `e6ffb71704ad668bc2f59376c864ec8ef5564269`. Never use a mutable `latest` tag.

The same two image-only manifests are installed on `hi5central-prod-01` under `/workspace/hi5central-deploy/` as `compose.qa26-sandbox-current-pins.yml` and `compose.qa26-sandbox-pr69-pins.yml` respectively. For a later **authorised ordinary in-place** shared-environment release, the deployment must explicitly use the existing base, managed edge, sandbox-ITSM, sandbox auth and environment-specific policy layers followed by one of these durable pins. Never rely on the missing `/tmp` path or derive secrets from `docker inspect`.

## Execution gate

A successful image pull and YAML check **do not grant permission to deploy**. The previous blocked sidecar operation remains restricted. An in-place replacement of an *existing* pool is a proposed platform release plan, **not a way to get around a blocked operation**. Only execute after the tool/service authorises the specific action, the normal release mechanism can safely reproduce the full existing Compose configuration, and the shared identity/backend compatibility is confirmed. No global Live API/Gateway swaps or new QA26 tenant databases.

The current VPS command environment reports **`docker compose` and `docker-compose` unavailable**. Do not claim that the standard Compose release command is ready. Identify or install the supported Compose mechanism through authorised VPS maintenance; re-run read-only merged config validation before any restart.

## Release readiness and rollback criteria

1. Verify immutable API+ITSM candidate tags exist locally, same reviewed source commit, migrations `154_itsm_configuration_change_events.sql` already applied on existing Test/UAT databases, and internal Live directory credentials are correctly mounted without exposing their values.
2. Preserve existing Test/UAT DBs, Redis, authorised routing, environment markers, secret volume mounts and network memberships. RMM broker/agents/workers must remain disabled on Test/UAT.
3. Verify the merged service configuration against running baseline for both Test and UAT; reject unknown changes, unexpected port publications, secret additions, or new service names.
4. Use an explicitly permitted, standard in-place shared-environment deployment and retain the pinned previous images for rollback. Never impersonate approval or retry the blocked sidecar operation.
5. Run `scripts/qa26-stage-acceptance.mjs` **after** a permitted cutover; expected 12/12, currently 7/12. Do not rewrite status codes at Caddy. Verify actual API build and Test/UAT DB scope separately.
6. Re-test Managed/Custom Live MFA, Managed Test / Custom Test+UAT sign-in, Live directory read-through, ITSM change ledger, cross-tenant denies, RMM Live-only, and original gateway/marketing endpoints. Roll back via the previous immutable image pins if regressions arise.

The obsolete temp-file problem is solved by **durable configuration**, not by reconstructing the missing file under `/tmp`. Existing containers still advertise that former filename until their next controlled replacement.
