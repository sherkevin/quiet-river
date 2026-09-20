#!/usr/bin/env bash
set -euo pipefail

VERSION="2026.08.19"
SHA256="1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"
URL="https://github.com/yt-dlp/yt-dlp/releases/download/\${VERSION}/yt-dlp"
ROOT="\${YTDLP_ROOT:-/opt/quiet-river-tools/yt-dlp/\${VERSION}}"
TARGET="\${ROOT}/yt-dlp"

mkdir -p "\${ROOT}"
tmp="$(mktemp "\${ROOT}/yt-dlp.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

curl -fL --retry 3 --connect-timeout 15 "\${URL}" -o "\${tmp}"
printf '%s  %s\n' "\${SHA256}" "\${tmp}" | sha256sum -c -
chmod 0755 "\${tmp}"
mv -f "\${tmp}" "\${TARGET}"
trap - EXIT

actual="$("\${TARGET}" --version)"
if [[ "\${actual}" != "\${VERSION}" ]]; then
  echo "yt-dlp version mismatch: expected \${VERSION}, got \${actual}" >&2
  exit 1
fi

echo "Installed pinned yt-dlp \${VERSION} at \${TARGET}"
