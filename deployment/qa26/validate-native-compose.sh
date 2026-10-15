#!/bin/sh
# Hi5Central: read-only native Ubuntu Compose config check for existing Test/UAT pools.
# Never echoes sensitive environment values, starts services, or modifies data.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for cmd in docker stat grep; do command -v "$cmd" >/dev/null 2>&1 || { echo "BLOCKED: missing $cmd" >&2; exit 2; }; done
docker compose version >/dev/null 2>&1 || { echo "BLOCKED: Docker Compose unavailable in this shell; use the native Ubuntu VPS." >&2; exit 2; }
failed=0
for env in test uat; do
  case "$env" in
    test) policy=compose.portal-auth-85eb7daa.yml ;;
    uat) policy=compose.customer-lifecycle-21d0a43.yml ;;
  esac
  envfile="$script_dir/environments/$env.env"
  if [ ! -s "$envfile" ]; then
    echo "$env: BLOCKED — missing protected env file at $envfile"
    failed=1
    continue
  fi
  mode=$(stat -c %a "$envfile")
  if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    echo "$env: BLOCKED — env file permissions are $mode, require 600 or 400"
    failed=1
    continue
  fi
  echo "Checking $env with protected environment file (values withheld)..."
  # All layer paths are pinned to the existing runtime; this command is read-only.
  if docker compose --env-file "$envfile" -p "hi5central-$env" \
    -f "$script_dir/compose.yml" \
    -f "$script_dir/compose.managed-edge.yml" \
    -f "$script_dir/../phase42-sandbox-releases-mobile/compose.sandbox-itsm.yml" \
    -f "$script_dir/../phase40-sandbox-native-login/compose.sandbox.yml" \
    -f "$script_dir/$policy" \
    -f "$script_dir/compose.qa26-sandbox-runtime-policy.yml" \
    -f "$script_dir/compose.qa26-sandbox-pr69-pins.yml" \
    config --quiet; then
    echo "$env: PASS — Compose interpolation and YAML validation"
  else
    echo "$env: BLOCKED — configuration validation failed; no services changed"
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "RESULT: BLOCKED. Do not run docker compose up."
  exit 2
fi
echo "RESULT: BOTH CONFIGURATIONS VALID. This does NOT authorise deployment."
