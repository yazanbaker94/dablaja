#!/usr/bin/env bash
set -euo pipefail

candidate="${1:-}"
case "$candidate" in
  /tmp/dablaja-caddy.*) ;;
  *) echo "Refusing unexpected Caddy staging file." >&2; exit 2 ;;
esac
test -f "$candidate"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/ytmp3-backups/Caddyfile-dablaja-$stamp"
cp -a /etc/caddy/Caddyfile "$backup"

rollback() {
  code=$?
  trap - ERR
  install -o root -g root -m 0644 "$backup" /etc/caddy/Caddyfile
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  systemctl reload caddy || true
  echo "Caddy update failed; rollback attempted from $backup" >&2
  exit "$code"
}
trap rollback ERR

caddy validate --adapter caddyfile --config "$candidate" >/dev/null
install -o root -g root -m 0644 "$candidate" /etc/caddy/Caddyfile
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy
systemctl is-active --quiet caddy
trap - ERR
rm -f -- "$candidate"
echo "Caddy reloaded; backup retained at $backup"
