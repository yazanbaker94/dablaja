#!/usr/bin/env bash
set -euo pipefail

candidate="${1:-}"
case "$candidate" in
  /tmp/dablaja-caddy.*) ;;
  *) echo "Refusing unexpected Caddy staging file." >&2; exit 2 ;;
esac
test -f "$candidate"

# This deploys the complete root Caddyfile, not the site-block reference in
# server/Caddyfile.audiofetcher.production. Fail closed before a partial file
# can remove the VPS imports or unrelated sites.
grep -Fq 'import /etc/caddy/sites/*.caddy' "$candidate"
grep -Fq 'import rook-origin' "$candidate"
grep -Fq 'audiofetcher.com {' "$candidate"
grep -Fq 'reverse_proxy 127.0.0.1:8080' "$candidate"
grep -Fq 'https://www.youtube-nocookie.com' "$candidate"

# The shared root config imports the rook-origin snippet, whose matcher uses a
# secret supplied to the running Caddy service. Validate with the same trusted
# environment file without printing its contents; otherwise an otherwise valid
# candidate fails closed because the placeholder expands to an empty value.
env_file="/etc/rook/caddy.env"
test -r "$env_file"
set -a
# shellcheck disable=SC1091
. "$env_file"
set +a
test -n "${ROOK_ORIGIN_TOKEN:-}"

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
