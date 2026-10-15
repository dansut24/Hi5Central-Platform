#!/usr/bin/env python3
"""Administrator-run one-time provisioning. Run locally on the authorised VPS,
NOT through the remote assistant, and never paste credentials into a chat.
Requires the Dev-only SQL role bootstrap already reviewed and applied.
Generates NEW secrets; it never reads or reuses application/container secrets.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.parse import quote

DIRECTORY = Path("/etc/hi5central/qa-release-relay")
DEV_URL = DIRECTORY / "dev-db.url"
TOKEN = DIRECTORY / "publication.token"
DEV_DATABASE_CONTAINER = "hi5central-dev-postgres-1"
ROLE = "hi5_release_publisher"


def abort(message: str) -> None:
    raise SystemExit("PROVISIONING_REFUSED: " + message)


def secret_file(path: Path, value: str) -> None:
    # No overwrite and no symlink following.
    fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
    try:
        os.fchmod(fd, 0o400)
        os.fchown(fd, 100, 101)  # dedicated non-root relay image UID/GID
        os.write(fd, value.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def psql(sql: str) -> str:
    args = [
        "docker", "exec", "-i", DEV_DATABASE_CONTAINER,
        "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "hi5central", "-d", "hi5central",
    ]
    result = subprocess.run(args, input=sql, text=True, capture_output=True,
                            check=False, timeout=25)
    if result.returncode != 0:
        # Do not print output: it could include a SQL command containing
        # a generated password or other confidential material.
        abort("Dev PostgreSQL role operation failed. Consult administrator-only DB logs.")
    return result.stdout.strip()


def main() -> None:
    if os.geteuid() != 0:
        abort("Must be run in an approved root administrator session.")
    if not Path("/usr/bin/docker").exists():
        abort("Docker CLI unavailable.")
    if DIRECTORY.exists():
        info = DIRECTORY.stat()
        if info.st_uid != 0 or (info.st_mode & 0o777) != 0o700:
            abort("Secret directory ownership/permissions do not match.")
    else:
        DIRECTORY.mkdir(parents=True, mode=0o700)
        os.chown(DIRECTORY, 0, 0)
        DIRECTORY.chmod(0o700)
    if DEV_URL.exists() or TOKEN.exists() or DEV_URL.is_symlink() or TOKEN.is_symlink():
        abort("Secret files already exist. Rotate with a separate reviewed procedure.")

    role = psql(
        "SELECT rolname || ':' || rolcanlogin || ':' || rolsuper "
        "FROM pg_roles WHERE rolname='hi5_release_publisher';"
    )
    if role != f"{ROLE}:f:f":
        abort("Dev-only publisher role was not bootstrapped as NOLOGIN/non-superuser.")

    password = secrets.token_urlsafe(48)
    publisher_token = secrets.token_urlsafe(48)
    url = (
        f"postgresql://{ROLE}:{quote(password, safe='')}"
        f"@hi5central-dev-postgres-1:5432/hi5central"
    )
    secret_file(DEV_URL, url)
    try:
        secret_file(TOKEN, publisher_token)
        # No secret in process arguments or shell history: password is sent
        # over stdin to the trusted local Dev PostgreSQL container only.
        psql(f"ALTER ROLE {ROLE} WITH LOGIN PASSWORD '{password}';")
    except BaseException:
        DEV_URL.unlink(missing_ok=True)
        TOKEN.unlink(missing_ok=True)
        raise

    token_hash = hashlib.sha256(publisher_token.encode("utf-8")).hexdigest()
    del password, publisher_token
    print("SCOPED_PUBLISHER_SECRETS_PROVISIONED")
    print("DEV_SECRET_FILE=" + str(DEV_URL))
    print("PUBLICATION_TOKEN_FILE=" + str(TOKEN))
    print("RELEASE_PUBLICATION_TOKEN_SHA256=" + token_hash)
    print("Do not print either file. Supply only the SHA-256 hash in the")
    print("approved central Live API deployment environment.")
    print("Run the nonpublishing relay preflight before any actual publication.")


if __name__ == "__main__":
    main()
