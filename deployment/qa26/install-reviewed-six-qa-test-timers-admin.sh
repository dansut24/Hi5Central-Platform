#!/usr/bin/env bash
# Installs two ONE-TIME, fail-closed systemd timers for the six exact QA Test
# tenants. Requires reviewed restricted credential and signed source SHA.
# Does not run a tenant deployment, create a permit, or unpause release workers.
set -Eeuo pipefail
set +x
umask 077
[[ "$(id -u)" == 0 ]] || { echo "QA_TIMER_INSTALL_BLOCKED: SSH root only";exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$root" == /root/hi5central-release-provisioning ]] ||
 { echo "QA_TIMER_INSTALL_BLOCKED: unexpected operator checkout";exit 1; }
cd "$root"
sha="${H5C_CANARY_REVIEWED_SHA:-}"
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$sha" ]] ||
 { echo "QA_TIMER_INSTALL_BLOCKED: reviewed SHA mismatch";exit 1; }
# A one-shot window installation must not silently miss its first calendar slot.
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$now" < "2026-10-16T13:02:00Z" ]] ||
 { echo "QA_TIMER_INSTALL_BLOCKED: 14:02 BST first window has passed";exit 1; }
node deployment/qa26/check-six-qa-test-credential-readiness.mjs
image="hi5central-qa-six-test-worker:reviewed-${sha:0:12}"
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "hi5central.qa.reviewed_source"}}')" == "$sha" ]] ||
 { echo "QA_TIMER_INSTALL_BLOCKED: reviewed six-tenant image not staged";exit 1; }
for name in afternoon overnight;do
 unit="hi5central-qa-six-test-$name"
 [[ ! -e "/etc/systemd/system/$unit.service" &&
    ! -e "/etc/systemd/system/$unit.timer" ]] ||
 { echo "QA_TIMER_INSTALL_BLOCKED: unit already exists: $unit";exit 1; }
done
systemd-analyze calendar '2026-10-16 14:02:00 Europe/London' >/dev/null
systemd-analyze calendar '2026-10-17 02:02:00 Europe/London' >/dev/null
# Stable source paths, exact six-job cohort and no network credentials in unit.
make_units(){
 local suffix="$1" when="$2" target="/etc/systemd/system/hi5central-qa-six-test-$1"
 cat >"$target.service" <<EOF
[Unit]
Description=Hi5Central reviewed six-tenant QA Test $suffix one-shot
Requires=docker.service
After=docker.service
ConditionPathExists=/etc/hi5central/qa-single-test-canary/database.url

[Service]
Type=oneshot
User=root
WorkingDirectory=$root
Environment=H5C_CANARY_REVIEWED_SHA=$sha
ExecStart=/bin/bash $root/deployment/qa26/run-six-qa-test-window-admin.sh $suffix
TimeoutStartSec=90min
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal
EOF
 cat >"$target.timer" <<EOF
[Unit]
Description=One-time Hi5Central QA Test $suffix deployment window

[Timer]
OnCalendar=$when
AccuracySec=5s
RandomizedDelaySec=0
Persistent=false
Unit=hi5central-qa-six-test-$suffix.service

[Install]
WantedBy=timers.target
EOF
 chmod 0644 "$target.service" "$target.timer"
}
make_units afternoon '2026-10-16 14:02:00 Europe/London'
make_units overnight '2026-10-17 02:02:00 Europe/London'
systemctl daemon-reload
systemctl enable --now hi5central-qa-six-test-afternoon.timer
systemctl enable --now hi5central-qa-six-test-overnight.timer
echo 'QA_SIX_TEST_ONE_TIME_TIMERS_INSTALLED'
systemctl list-timers --all --no-pager 'hi5central-qa-six-test-*.timer'
echo 'ALL_TENANT_RELEASE_WORKERS_STILL_GLOBALLY_PAUSED'
