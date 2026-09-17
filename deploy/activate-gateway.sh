#!/usr/bin/env bash
# Switch the existing application to a read-only legacy view, with immediate rollback.
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 1
ROOT=/opt/quiet-river-platform/current
BACKUP="/var/backups/quiet-river/gateway-$(date +%Y%m%dT%H%M%S)"
DROPIN=/etc/systemd/system/quiet-river.service.d/90-platform-gateway.conf
install -d -m 700 "$BACKUP"
cp -a /opt/quiet-river/server.js "$BACKUP/server.js"
cp -a /etc/caddy/Caddyfile "$BACKUP/Caddyfile"
if [ -f "$DROPIN" ]; then cp -a "$DROPIN" "$BACKUP/dropin"; fi
systemctl cat quiet-river > "$BACKUP/quiet-river.service.txt"
tar -czf "$BACKUP/legacy-data.tgz" -C /opt/quiet-river data
rollback() {
  echo 'Gateway verification failed; restoring previous service routing' >&2
  cp -a "$BACKUP/Caddyfile" /etc/caddy/Caddyfile
  systemctl reload caddy || true
  cp -a "$BACKUP/server.js" /opt/quiet-river/server.js
  if [ -f "$BACKUP/dropin" ]; then cp -a "$BACKUP/dropin" "$DROPIN"; else rm -f "$DROPIN"; fi
  systemctl daemon-reload
  systemctl restart quiet-river
}
trap rollback ERR
curl -fsS --max-time 10 http://127.0.0.1:4380/healthz >/dev/null
install -d -m 755 "$(dirname "$DROPIN")"
printf '%s\n' '[Service]' 'ExecStart=' 'ExecStart=/usr/local/bin/qr-node server.js' > /etc/systemd/system/quiet-river.service.d/10-qr-runtime.conf
cat > "$DROPIN" <<'UNIT'
[Service]
Environment=PORT=4322
Environment=HOST=127.0.0.1
Environment=QR_READ_ONLY=true
UNIT
install -o qr -g qr -m 644 "$ROOT/server.js" /opt/quiet-river/server.js
sed -e 's@http://127.0.0.1:4381 {@http://:80, http://:4321 {@' -e '/bind 127.0.0.1/d' \
  "$ROOT/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl restart quiet-river
systemctl reload caddy
for port in 80 4321; do
  status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/desk/")
  [ "$status" = 200 ] || { echo 'New interface unavailable' >&2; false; }
  status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/desk/api/state")
  [ "$status" = 401 ] || { echo 'Private API access gate failed' >&2; false; }
done
for pass in 1 2 3; do
  systemctl is-active --quiet quiet-river quiet-river-bridge caddy
  test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4322/api/state)" = 401
  sleep 2
done
trap - ERR
printf '%s\n' "$BACKUP" > /var/backups/quiet-river/latest-gateway-checkpoint
printf 'Gateway verified on existing ports. Backup: %s\n' "$BACKUP"
