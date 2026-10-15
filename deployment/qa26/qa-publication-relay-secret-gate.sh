#!/bin/sh
# Read-only operator preflight for a pinned Dev->central release-note relay.
# Does not read, print, copy or create credentials; does not start containers.
set -eu
: "${QA_RELEASE_DEV_DB_SECRET_FILE:?Set to an admin-provisioned Dev DB secret path}"
: "${QA_RELEASE_OPERATOR_SECRET_FILE:?Set to an admin-provisioned current Live API operator credential file path}"
require_file() {
  file=$1
  [ -f "$file" ] || { echo 'MISSING_SECRET_FILE' >&2; exit 1; }
  [ ! -L "$file" ] || { echo 'SYMLINKED_SECRET_FILE_FORBIDDEN' >&2; exit 1; }
  mode=$(stat -c %a "$file")
  uid=$(stat -c %u "$file")
  [ "$mode" = 400 ] && [ "$uid" = 100 ] ||
    { echo 'SECRET_FILE_MUST_BE_MODE_0400_AND_OWNED_BY_RELAY_UID_100' >&2; exit 1; }
  [ -s "$file" ] || { echo 'EMPTY_SECRET_FILE' >&2; exit 1; }
}
require_file "$QA_RELEASE_DEV_DB_SECRET_FILE"
require_file "$QA_RELEASE_OPERATOR_SECRET_FILE"
docker network inspect hi5central >/dev/null
docker network inspect hi5central-dev_hi5internal >/dev/null
docker image inspect hi5central-release-publication-relay:qa-local-20261015 >/dev/null
if docker ps -a --format '{{.Names}}' |grep -Fx 'hi5central-release-publication-relay-qa26' >/dev/null; then
  echo 'RELAY_CONTAINER_ALREADY_PRESENT' >&2; exit 1
fi
echo 'QA_RELAY_SECRET_METADATA_AND_NETWORKS_PASS'
echo 'No credentials were read. The next step requires separate authenticated application preflight.'
