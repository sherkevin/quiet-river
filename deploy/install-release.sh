#!/usr/bin/env bash
# Install an immutable, already-tested commit; no legacy data is copied or replaced.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Administrator required' >&2; exit 1; }
REPO=/home/qr-dev/work/quiet-river
COMMIT="${1:?Pass the exact tested commit}"
[[ "$COMMIT" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid commit' >&2; exit 1; }
REV=$(runuser -u qr-dev -- git -C "$REPO" rev-parse "${COMMIT}^{commit}")
DEST="/opt/quiet-river-platform/releases/$REV"
install -d -m 755 /opt/quiet-river-platform/releases
if [ ! -e "$DEST" ]; then
  install -d -m 755 "$DEST"
  runuser -u qr-dev -- git -C "$REPO" archive "$REV" | tar -x -C "$DEST"
  chmod -R go-w "$DEST"
fi
if [ ! -x /usr/local/bin/qr-node ]; then
  install -m 755 /home/qr-dev/.nvm/versions/node/v22.23.2/bin/node /usr/local/bin/qr-node
fi
install -d -o qr -g qr -m 700 /var/lib/quiet-river-platform/bridge
install -m 644 "$DEST/deploy/quiet-river-bridge.service" /etc/systemd/system/quiet-river-bridge.service
if [ -L /opt/quiet-river-platform/current ]; then
  readlink /opt/quiet-river-platform/current > /var/backups/quiet-river/previous-platform-release
fi
ln -s "$DEST" /opt/quiet-river-platform/current.next
mv -Tf /opt/quiet-river-platform/current.next /opt/quiet-river-platform/current
systemctl daemon-reload
systemctl enable quiet-river-bridge
systemctl restart quiet-river-bridge
printf 'Installed reader commit %s. Legacy application unchanged.\n' "$REV"
