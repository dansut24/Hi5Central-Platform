#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/opt/hi5central-viewer"
APPLICATIONS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
DESKTOP_FILE="${APPLICATIONS_DIR}/hi5central-viewer.desktop"

mkdir -p "${INSTALL_DIR}" "${APPLICATIONS_DIR}"
rm -rf "${INSTALL_DIR}/web"
cp "${SOURCE_DIR}/Hi5CentralViewer" "${INSTALL_DIR}/Hi5CentralViewer"
cp -R "${SOURCE_DIR}/web" "${INSTALL_DIR}/web"
chmod 755 "${INSTALL_DIR}/Hi5CentralViewer"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=Hi5Central Viewer
Comment=Hi5Central remote support viewer
Exec=${INSTALL_DIR}/Hi5CentralViewer %u
Terminal=false
Categories=Network;RemoteAccess;
MimeType=x-scheme-handler/hi5central-viewer;x-scheme-handler/hi5viewer;x-scheme-handler/hi5tech;
NoDisplay=false
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${APPLICATIONS_DIR}" >/dev/null 2>&1 || true
fi

if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default hi5central-viewer.desktop x-scheme-handler/hi5central-viewer || true
    xdg-mime default hi5central-viewer.desktop x-scheme-handler/hi5viewer || true
    xdg-mime default hi5central-viewer.desktop x-scheme-handler/hi5tech || true
fi

echo "Hi5Central Viewer installed to ${INSTALL_DIR}"
echo "Custom URL schemes registered for this user."
