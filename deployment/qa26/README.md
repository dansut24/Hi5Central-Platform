# QA26 existing shared Test/UAT release — no sidecars

**Scope:** Managed QA26 and Custom QA26 only. One existing shared Test API+ITSM service pool and one existing shared UAT API+ITSM service pool. RMM remains Live-only. No new sandbox sidecars, databases or tenants.

## Verified 2026-10-14 baseline

- The user deployed API and ITSM revision `77a79172d748b75a04373acc603359befa423c38` into the existing Test and UAT pools using native Ubuntu Docker Compose.
- All four containers reported healthy; the read-only public staging acceptance suite passed **12/12**, independently repeated after deployment.
- Production gateway, API and RMM containers were healthy and were not replaced.
- This 12/12 revision is preserved as the **rollback** image lock (`compose.sandbox-current-image-lock.yml`).
- Screenshots from iPhone UAT testing revealed two problems that the 12 unauthenticated public checks could not detect: Live People read-through requests returned 503 to users because the outbound service request omitted the gateway's internal route header, and ITSM configuration history rendered oversized raw key/UUID strings on mobile.

## QA26 People and mobile-history correction

- Corrected API + ITSM **candidate** revision: `4fad62ab8578bda7c2d4aa5fdd4df8c4983257b7`.
- `compose.sandbox-pr69-image-lock.yml` pins the exact API and ITSM candidate images. They have been pulled to the VPS but **not yet deployed** when this document was updated.
- The directory fix sends the gateway's internal route marker on the existing authenticated Live directory service request, even with `QA26_STAGING_MODE` disabled on the shared pools. The backend still requires the service bearer secret, tenant membership and Live environment grant. Operator proof: the current outbound UAT request returns 404 without this header and 200 with the header and valid bearer secret; returned directory shape was verified. No copied People data or relaxed identity permissions.
- The ITSM history interface now displays a compact summary with expandable, readable setting keys, scoped responsive styling and bounded metadata, rather than unstyled comma-separated keys and full user UUIDs.
- CI for correction revision `4fad62ab8578bda7c2d4aa5fdd4df8c4983257b7` passed **9/9** including image publication.
- Both correction images are pulled on the VPS; previous release remains healthy. After an authorised native-host Test-first and UAT-second in-place replacement, rerun the 12 unauthenticated boundary checks, verify the authenticated UAT Live People directory works, and inspect the ITSM history on iPhone. Do not mark the two reported regressions resolved until actual deployed/browser confirmation.

## Durable configuration layers

The old Test/UAT containers originally referenced a deleted `/tmp/hi5-test-cb836705.override.yml` image override. Permanent image-only locks remove that ambiguity:

- `compose.sandbox-current-image-lock.yml`: last known **12/12** passing Test/UAT API/ITSM revision (rollback).
- `compose.sandbox-pr69-image-lock.yml`: proposed QA26 People/mobile correction images.
- `compose.sandbox-runtime-policy.yml`: `BACKGROUND_WORKERS_ENABLED=false` for Test/UAT only.
- `validate-native-compose.sh`: read-only native-host `docker compose config --quiet` with protected `environments/test.env` and `environments/uat.env` files.

The matching manifest files are installed on `hi5central-prod-01` under `/opt/hi5central/hi5central-deploy/` as `compose.qa26-sandbox-current-pins.yml`, `compose.qa26-sandbox-pr69-pins.yml`, and `compose.qa26-sandbox-runtime-policy.yml`. The protected env files remain mode 600. Do not derive missing secrets from container metadata.

## Release and rollback safeguards

1. Use the native Ubuntu Docker Compose CLI. The remote-command helper runs in Alpine and does not contain Compose; this does not mean the Ubuntu host lacks Compose (native host v5.5.1 was confirmed).
2. Validate both environment configurations before deployment. Use the existing base, managed-edge, sandbox-ITSM, sandbox-auth, environment-specific, runtime worker policy and image pin layers in their previously tested order.
3. Recreate **only the existing** `control-server` and `itsm-web` services in Test first, then UAT after Test checks pass. Preserve PostgreSQL, Redis, networks, secret mounts, all Live services, the central directory and the software qualification runner.
4. Do not reuse the previous **blocked additional sidecar creation** action or circumvent any tool's execution controls. Never blindly recreate or restart the Live `hi5central-web` gateway: its Caddy bind-mount inode differs from the persistent file, so restart may alter Live routing.
5. Verify the 12 public checks from `deployment/pilots/qa26-pr69-20261014/qa26-stage-acceptance.mjs` after cutover. They only cover unauthenticated API/browser host boundaries and do **not** validate authenticated Live People read-through or mobile history.
6. Test sign-in/MFA, shared People read-through, UAT history, Managed no-UAT, RMM Live-only and tenant isolation. Roll back to `compose.qa26-sandbox-current-pins.yml` on API/frontend regressions (the 12/12 revision), not the original pre-12/12 images. No Production promotion until authenticated UAT and formal release gates pass.
