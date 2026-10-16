#!/bin/sh
# Native-host / authorised-Docker recovery for the TEST QA gateway only.
# Usage: sh deployment/qa26/qa-real-tenant-route-restore.sh <snapshot-file>
# Example snapshot: test-before-real-route-1792075260958.Caddyfile
set -eu
snapshot="$1"
case "$snapshot" in
  test-before-real-route-*.Caddyfile) ;;
  *) echo 'ERROR: supply an exact QA Test backup filename' >&2;exit 2 ;;
esac
case "$snapshot" in
  *'/'*|*'..'*|*' '*|*'	'*) echo 'ERROR: invalid snapshot filename' >&2;exit 2 ;;
esac
gateway=hi5central-test-gateway
config_volume=hi5central-test_gateway_runtime_config
backup_volume=hi5central_qa_route_rollback_backups

echo "RESTORE BACKUP: $snapshot"
echo "Restoring only $gateway via its existing Docker volume."
docker inspect "$gateway" >/dev/null
docker volume inspect "$backup_volume" >/dev/null
docker volume inspect "$config_volume" >/dev/null

docker run --rm --network none \
  --mount "type=volume,source=$backup_volume,target=/backup,readonly" \
  busybox:1.36 sh -c 'test -s "/backup/$1" && sha256sum "/backup/$1"' sh "$snapshot"

# Preserve the current gateway config before restoring the requested snapshot.
docker run --rm --network none \
  --mount "type=volume,source=$backup_volume,target=/backup" \
  --mount "type=volume,source=$config_volume,target=/gateway" \
  busybox:1.36 sh -c '
set -eu
test -s "/backup/$1"
if [ ! -e "/backup/recovery-before-restore.Caddyfile" ]; then
  cp /gateway/Caddyfile /backup/recovery-before-restore.Caddyfile
  chmod 0600 /backup/recovery-before-restore.Caddyfile
fi
cp "/backup/$1" /gateway/Caddyfile
chmod 0644 /gateway/Caddyfile
' sh "$snapshot"

if ! docker exec "$gateway" caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile; then
  echo 'ERROR: Caddy reload failed. An additional recovery-before-restore.Caddyfile backup exists.' >&2
  exit 1
fi
docker exec "$gateway" caddy adapt \
  --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
echo 'RESTORE COMPLETE: prior QA Test Caddyfile loaded.'
echo 'Verify both tenant hostnames and SHA before resuming queued jobs.'
