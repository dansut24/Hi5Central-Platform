# Dev RMM Windows Agent installer recovery (16 October 2026)

## Purpose and current blocker

The Dev RMM **Create installer → Windows x64 → EXE** download can respond with:

```json
{"error":"Windows EXE tenant installer template is not published."}
```

In `services/api/src/rmmAgent.js`, the EXE generator reads `TENANT_INSTALLER_WINDOWS_TEMPLATE_PATH`, defaulting to `/srv/tenant-installers/templates/Hi5CentralAgentTemplate.exe`. The file must have the single unmodified `H5C0F9A17D42B6E3` configuration marker; the API stamps it with the tenant deployment ID, secret and configured API URL at download time.

The isolated GitHub workflow `.github/workflows/agent-deployment-installers.yml` builds reusable Windows EXE/MSI assets and publishes `ghcr.io/dansut24/hi5central-agent-deployment-assets`. This PR enables ordinary `develop` pushes to build/publish the `:dev` tag. Publication alone does **not** populate the running Dev API filesystem, which must be checked separately.

**Safety boundary:** Do not restart or redeploy shared API, Caddy, databases, ITSM or release-worker services. Do not touch tenant Production, Test, UAT or the scheduled 02:02 ITSM upgrade test. This PR is not a host deployment.

## Tonight: enroll a Dev device without a template

The existing *Generate one-time token* flow is independent of the tenant-specific EXE template.

1. Open `https://dev-rmm.hi5central.com` → Agent deployment → **Generate one-time token**.
2. On a **clean, non-Production-enrolled Windows x64 test device**, download the standard Windows installer from the portal's Windows download link (currently `https://downloads.hi5central.com/agent/latest/Hi5CentralAgentSetup.exe`).
3. Copy the one-time install command from Dev RMM; **add** `/API_BASE_URL="https://dev-api.hi5central.com"` before launching it as Administrator. The API currently constructs the command with `/ENROLLMENT_TOKEN`, `/TENANT_ID`, `/PACKAGE_ID` and `/INSTALL_SOURCE`, but does **not** itself include the API-base argument.
4. Never paste the enrollment token into GitHub, logs or chat. A one-time token normally expires after 60 minutes and can be used once; verify the actual record's expiry/use count.
5. Verify the device appears in **Dev RMM only**, reports online, and sends device inventory/telemetry. Check the Windows service `Hi5CentralAgent` and local log `C:\ProgramData\Hi5Central\Agent\Logs\agent.log` if necessary.

**Important:** Do not use a device already enrolled in Production: reinstalling or rerouting an existing service can affect its existing identity and connectivity.

## Build and publish the persistent Windows EXE template

- Once this isolated workflow change is approved/merged into `develop`, a push touching `native/agent/**` or the workflow file triggers the Agent deployment installers pipeline.
- Alternatively use GitHub Actions → **Agent deployment installers** → **Run workflow**, selecting `develop`. This existing manual dispatch path already works without the one-line branch trigger.
- Wait for the `windows`, `macos`, `linux` and `assets` jobs to succeed. Validate the artifact `Hi5Central-Windows-Tenant-Template` exists and the GHCR image for the **exact successful workflow commit** was published. Do not assume success from a queued or partial run.
- Prefer the pinned `ghcr.io/dansut24/hi5central-agent-deployment-assets:sha-<40-character-successful-workflow-commit>` image over a mutable tag.

## Dev API template population — AFTER the 02:02 ITSM test, and only after host review

Read-only Dev API checks can be done without restarting any services:

```bash
export DEV_API_CONTAINER='<actual running Dev API container name>'
docker inspect --format '{{.State.Running}}' "$DEV_API_CONTAINER"
docker exec "$DEV_API_CONTAINER" node -e '
const fs = require("fs");
const env = process.env.RUNTIME_ENVIRONMENT;
const api = (process.env.TENANT_INSTALLER_API_BASE || process.env.API_URL || "").replace(/\/$/, "");
const path = process.env.TENANT_INSTALLER_WINDOWS_TEMPLATE_PATH || "/srv/tenant-installers/templates/Hi5CentralAgentTemplate.exe";
if (env !== "dev" || api !== "https://dev-api.hi5central.com") {
  console.error("REFUSING: container is not the verified Dev API");
  process.exit(1);
}
console.log(JSON.stringify({ devVerified: true, templatePresent: fs.existsSync(path), templatePath: path }));
'
```

If the guard fails, **stop** and inspect the Dev deployment environment. Do not weaken the guard or guess a replacement container. The live environment could use different variables and requires explicit review.

When a successful pinned image is available and the actual Dev API container has been verified, a reviewed operator can populate only the missing Dev template without restarting services:

```bash
set -euo pipefail
export DEV_API_CONTAINER='<verified Dev API container name>'
export AGENT_ASSET_IMAGE='ghcr.io/dansut24/hi5central-agent-deployment-assets:sha-<exact-successful-workflow-commit>'
# Re-run the strict Dev API guard above before any writes.
docker pull "$AGENT_ASSET_IMAGE"
tmp="$(mktemp -d)"
asset_cid=''
cleanup() { if [ -n "$asset_cid" ]; then docker rm -f "$asset_cid" >/dev/null 2>&1 || :; fi; rm -rf "$tmp"; }
trap cleanup EXIT
asset_cid="$(docker create "$AGENT_ASSET_IMAGE")"
docker cp "$asset_cid:/assets/templates/Hi5CentralAgentTemplate.exe" "$tmp/Hi5CentralAgentTemplate.exe"
python3 - "$tmp/Hi5CentralAgentTemplate.exe" <<'PY'
from pathlib import Path
import sys
data = Path(sys.argv[1]).read_bytes()
marker = b'H5C0F9A17D42B6E3'
assert 1_000_000 <= len(data) <= 50_000_000, "Invalid Windows EXE template size"
assert data.count(marker) == 1, "Invalid Windows EXE configuration marker"
print("Windows Dev installer template validated")
PY
docker exec -u 0 "$DEV_API_CONTAINER" mkdir -p /srv/tenant-installers/templates
docker cp "$tmp/Hi5CentralAgentTemplate.exe" "$DEV_API_CONTAINER:/srv/tenant-installers/templates/.Hi5CentralAgentTemplate.exe.pending"
docker exec -u 0 "$DEV_API_CONTAINER" sh -ec '
  chmod 0644 /srv/tenant-installers/templates/.Hi5CentralAgentTemplate.exe.pending
  mv -f /srv/tenant-installers/templates/.Hi5CentralAgentTemplate.exe.pending /srv/tenant-installers/templates/Hi5CentralAgentTemplate.exe
'
```

**Persistence:** Docker copying into a running container without a mounted persistent volume may be lost when that container is recreated. For permanent readiness, mount an independently maintained, read-only Dev installer-assets volume or incorporate the published assets into the Dev API image under a separately reviewed deployment change. Do not alter shared Compose/container routing just before the ITSM upgrade test.

## Acceptance

- Windows EXE template is present in verified Dev API and marker count equals one.
- **Create installer** returns a Windows EXE, not JSON error.
- The downloaded EXE is non-empty, tenant-stamped, and configured for `https://dev-api.hi5central.com`.
- A consenting new Windows test device enrolls, appears online in Dev RMM and delivers telemetry/inventory.
- No API, gateway, release worker, Production or tenant-version changes occurred while protecting the scheduled ITSM run.
