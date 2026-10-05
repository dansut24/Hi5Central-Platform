#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/opt/hi5central-viewer"
APPLICATIONS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
DESKTOP_FILE="${APPLICATIONS_DIR}/hi5central-viewer.desktop"

rm -rf "${INSTALL_DIR}"
rm -f "${DESKTOP_FILE}"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${APPLICATIONS_DIR}" >/dev/null 2>&1 || true
fi

echo "Hi5Central Viewer removed."
