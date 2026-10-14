#!/bin/sh
# Hi5Central QA26: native Ubuntu, operator-run, existing Test/UAT only.
# Do not invoke from an Alpine helper or use this on Live/RMM.
set -eu

environment="${1:-}"
action="${2:-deploy}"
case "$environment" in test|uat) ;; *) echo 'Usage: qa26-native-release.sh test|uat deploy|rollback' >&2; exit 2 ;; esac
case "$action" in deploy|rollback) ;; *) echo 'Action must be deploy or rollback' >&2; exit 2 ;; esac

base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$base"
command -v docker >/dev/null 2>&1 || { echo 'Docker unavailable' >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo 'Native Docker Compose unavailable in this shell' >&2; exit 2; }

case "$environment" in
  test) policy=compose.portal-auth-85eb7daa.yml ;;
  uat) policy=compose.customer-lifecycle-21d0a43.yml ;;
esac
case "$action" in
  deploy) image_lock=compose.qa26-sandbox-pr69-pins.yml ;;
  rollback) image_lock=compose.qa26-sandbox-current-pins.yml ;;
esac

envfile="$base/environments/$environment.env"
if [ ! -s "$envfile" ]; then
  echo "$environment: protected environment file missing" >&2; exit 2
fi
mode=$(stat -c %a "$envfile")
if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
  echo "$environment: environment file is not sufficiently protected" >&2; exit 2
fi

compose() {
  docker compose -p "hi5central-$environment" --env-file "$envfile" \
    -f "$base/compose.yml" \
    -f "$base/compose.managed-edge.yml" \
    -f "$base/../phase42-sandbox-releases-mobile/compose.sandbox-itsm.yml" \
    -f "$base/../phase40-sandbox-native-login/compose.sandbox.yml" \
    -f "$base/$policy" \
    -f "$base/compose.qa26-sandbox-runtime-policy.yml" \
    -f "$base/$image_lock" "$@"
}

echo "Validating existing $environment $action release..."
compose config --quiet
for service in control-server itsm-web; do
  docker inspect "hi5central-$environment-$service-1" >/dev/null
done
printf '\nDRY RUN (read-only): expected existing %s control-server and itsm-web only\n' "$environment"
compose --dry-run up -d --no-deps --no-build --pull never control-server itsm-web
printf '\nNever continue if this would change postgres, redis, gateway, volumes, Live or RMM.\n'
printf 'Type DEPLOY after reviewing the dry run: '
read -r answer
if [ "$answer" != "DEPLOY" ]; then
  echo 'Cancelled without deployment'
  exit 3
fi

for service in control-server itsm-web; do
  echo "Updating existing $environment $service only"
  compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 "$service"
done
printf '\nActive image tags and health:\n'
for service in control-server itsm-web; do
  docker inspect "hi5central-$environment-$service-1" \
    --format '{{.Name}} | {{.Config.Image}} | {{if .State.Health}}{{.State.Health.Status}}{{end}}'
done
echo 'Now run public API acceptance and authenticated People/mobile UI checks. No Production promotion has occurred.'
