#!/bin/sh
set -eu
umask 077
test ! -e "$1"
password=$(docker exec hi5central-api node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
{
 printf '%s\n' 'POSTGRES_USER=phase22_user' 'POSTGRES_DB=phase22_shadow'
 printf 'POSTGRES_PASSWORD=%s\n' "$password"
 printf 'DATABASE_URL=postgresql://phase22_user:%s@shadow-postgres:5432/phase22_shadow\n' "$password"
 printf '%s\n' 'NODE_ENV=production'
} > "$1"
chmod 600 "$1"
echo SHADOW_CREDENTIALS_CREATED_PRIVATE