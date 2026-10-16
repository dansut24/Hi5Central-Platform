#!/bin/sh
# Provision an API-readable, least-privilege copy of the existing trusted
# release-operator token WITHOUT changing the original root-owned secret.
# Named volumes persist after container replacement and can be reused
# in Compose. Never print the secret, commit it or expose it over HTTP.
set -eu
SOURCE=hi5central-release-operator-config
TARGET=hi5central-release-operator-api-secret
test "$(docker inspect hi5central-release-operator --format '{{.State.Running}}')" = true
docker volume inspect "$SOURCE" >/dev/null
docker volume create "$TARGET" >/dev/null
docker run --rm --network none \
  --mount type=volume,source="$SOURCE",target=/source,readonly \
  --mount type=volume,source="$TARGET",target=/target \
  busybox:1.36 sh -c '
    set -eu
    test -s /source/operator.token
    umask 077
    cat /source/operator.token >/target/operator.token
    chown 1000:1000 /target/operator.token
    chmod 0400 /target/operator.token
    cmp -s /source/operator.token /target/operator.token
    test "$(stat -c %a /target/operator.token)" = 400
    test "$(stat -c %u /target/operator.token)" = 1000
  '
# Check actual API runtime's non-root UID can read it.
docker run --rm --network none --user 1000:1000 \
  --mount type=volume,source="$TARGET",target=/config,readonly \
  busybox:1.36 sh -c 'test -r /config/operator.token; test -s /config/operator.token'
echo 'OPERATOR_API_SECRET_SYNC_VERIFIED_READONLY_UID1000'
