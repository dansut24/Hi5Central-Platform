#!/usr/bin/env bash
# Retarget only the existing overnight QA TEST oneshot service from the
# pre-canary build to the reviewed, independently verified six-Test worker.
# Never start jobs, change timer times, amend credentials or unpause rollouts.
set -Eeuo pipefail
set +x
umask 077
[[ "$(id -u)" == 0 ]] || { echo 'QA_OVERNIGHT_UNIT_BLOCKED: root SSH required' >&2;exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$root" == /root/hi5central-release-provisioning ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: unreviewed working tree location' >&2;exit 1; }
cd "$root"
sha="${H5C_CANARY_REVIEWED_SHA:-}"
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$sha" ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: reviewed commit mismatch' >&2;exit 1; }
[[ "$(date -u +%FT%TZ)" < "2026-10-17T01:02:00Z" ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: overnight timer already elapsed' >&2;exit 1; }
node deployment/qa26/check-six-qa-test-credential-readiness.mjs
node deployment/qa26/verify-six-qa-test-caddy-history.mjs
node deployment/qa26/verify-six-qa-test-rollouts.mjs --expect-canaries >/dev/null
image="hi5central-qa-six-test-worker:reviewed-${sha:0:12}"
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "hi5central.qa.reviewed_source"}}')" == "$sha" ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: six-Test image not staged for reviewed commit' >&2;exit 1; }
unit=/etc/systemd/system/hi5central-qa-six-test-overnight.service
timer=/etc/systemd/system/hi5central-qa-six-test-overnight.timer
old='Environment=H5C_CANARY_REVIEWED_SHA=fc957de504bfb0ed0180949b802ea913db7d1ca3'
new="Environment=H5C_CANARY_REVIEWED_SHA=$sha"
[[ -f "$unit" && -f "$timer" ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: original one-time timer missing' >&2;exit 1; }
grep -Fx 'OnCalendar=2026-10-17 02:02:00 Europe/London' "$timer" >/dev/null ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: expected 02:02 BST calendar has drifted' >&2;exit 1; }
grep -Fx "WorkingDirectory=$root" "$unit" >/dev/null
grep -Fx "ExecStart=/bin/bash $root/deployment/qa26/run-six-qa-test-window-admin.sh overnight" "$unit" >/dev/null
systemctl is-enabled --quiet hi5central-qa-six-test-overnight.timer
systemctl is-active --quiet hi5central-qa-six-test-overnight.timer
if grep -Fx "$new" "$unit" >/dev/null;then
 echo 'QA_OVERNIGHT_UNIT_ALREADY_PINNED'
else
 grep -Fx "$old" "$unit" >/dev/null ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: existing unit SHA unexpected' >&2;exit 1; }
 source_count="$(grep -Fc "$old" "$unit")"
 [[ "$source_count" == 1 ]] ||
 { echo 'QA_OVERNIGHT_UNIT_BLOCKED: duplicate old SHA' >&2;exit 1; }
 temp="$(mktemp /etc/systemd/system/.h5c-qa-overnight.XXXXXX)"
 trap 'rm -f "$temp"' EXIT
 sed "s|^$old$|$new|" "$unit" > "$temp"
 grep -Fx "$new" "$temp" >/dev/null
 chmod 0644 "$temp"
 chown 0:0 "$temp"
 mv -- "$temp" "$unit"
 trap - EXIT
 systemctl daemon-reload
fi
systemctl is-active --quiet hi5central-qa-six-test-overnight.timer
grep -Fx "$new" "$unit" >/dev/null
echo "QA_OVERNIGHT_TIMER_REPIN_VERIFIED reviewed_sha=$sha"
systemctl list-timers --all --no-pager 'hi5central-qa-six-test-overnight.timer'
echo 'GLOBAL_ROLLOUT_PAUSE_UNCHANGED_NO_DEPLOYMENT_STARTED'
