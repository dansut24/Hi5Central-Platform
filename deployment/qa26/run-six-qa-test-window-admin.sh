#!/usr/bin/env bash
# Strict two-window, six-tenant QA TEST rollout orchestrator. Installs nothing
# and never enables the global platform release workers.
# Intended only after separately approved restricted role+credential provisioning.
set -Eeuo pipefail
set +x
umask 077
[[ "$(id -u)" == 0 ]] || { echo "QA_WINDOW_BLOCKED: root VPS operator required";exit 1; }
window="${1:-}"
[[ "$#" == 1 ]] || { echo "Usage: $0 afternoon|overnight"; exit 1; }
case "$window" in
 afternoon)
  slugs=(h5c-managed-qa26 h5c-custom-qa26)
  expectedDay=2026-10-16
  start=14
  end=21
  verification=--expect-canaries;;
 overnight)
  slugs=(managed1 managed2 custom1 custom2)
  expectedDay=2026-10-17
  start=2
  end=4
  verification=--expect-six;;
 *) echo "QA_WINDOW_BLOCKED: reviewed afternoon/overnight windows only";exit 1;;
esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
sha="${H5C_CANARY_REVIEWED_SHA:-}"
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$sha" ]] ||
 { echo "QA_WINDOW_BLOCKED: reviewed source SHA mismatch";exit 1; }
# Do not run under a catch-up timer outside the actual customer window.
dateCheck() {
 local today hour
 today="$(TZ=Europe/London date +%F)"
 hour="$(TZ=Europe/London date +%H)"
 [[ "$today" == "$expectedDay" && 10#$hour -ge "$start" && 10#$hour -lt "$end" ]]
}
dateCheck || { echo "QA_WINDOW_BLOCKED: not inside approved local Test window";exit 1; }
# No two copies can write to the same shared Caddy Test gateway.
exec 9>/run/lock/hi5central-qa-six-test-window.lock
flock -n 9 || { echo "QA_WINDOW_BLOCKED: another QA window worker is active";exit 1; }
node deployment/qa26/check-six-qa-test-credential-readiness.mjs
image="hi5central-qa-six-test-worker:reviewed-${sha:0:12}"
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "hi5central.qa.reviewed_source"}}')" == "$sha" ]] ||
 { echo "QA_WINDOW_BLOCKED: immutable QA image not staged at reviewed SHA";exit 1; }
for slug in "${slugs[@]}";do
 dateCheck || { echo "QA_WINDOW_BLOCKED: approved Test window ended";exit 1; }
 echo "=== Starting strictly gated QA Test candidate: $slug"
 # Do not silently ignore a prior failed/retried job. Each new permit must be
 # a one-use certificate-linked staff permission, and no permits are deleted.
 current="$(node deployment/qa26/execute-six-qa-test-job-admin.mjs --check "$slug")"
 if printf '%s' "$current" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.exit(JSON.parse(s).alreadyVerified?0:1))';then
  echo "QA_TEST_PREVIOUSLY_VERIFIED slug=$slug"
  continue
 fi
 printf '%s' "$current" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.jobStatus!=="scheduled"||j.attempts!==0||j.globalPause!==true||j.windowAllowed!==true||j.publicApi!==j.publicWeb||j.permitReady)process.exit(1)})' ||
  { echo "QA_WINDOW_BLOCKED: tenant not eligible for new permit $slug";exit 1; }
 bash deployment/qa26/arm-six-qa-test-permit-admin.sh "$slug"
 node deployment/qa26/execute-six-qa-test-job-admin.mjs --execute "$slug"
 # Each deployment must be independently coherent before any other tenant
 # receives a permit; failure stops here and leaves every other job paused.
 node deployment/qa26/verify-six-qa-test-rollouts.mjs --snapshot >/dev/null
 echo "QA_ONE_TENANT_EXECUTION_VERIFIED slug=$slug"
done
node deployment/qa26/verify-six-qa-test-rollouts.mjs "$verification"
echo "QA_SIX_TEST_WINDOW_VERIFIED type=$window count=${#slugs[@]}"
echo "GLOBAL_CUSTOMER_ROLLOUT_STAYS_PAUSED"
