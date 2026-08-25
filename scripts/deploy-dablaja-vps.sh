#!/usr/bin/env bash
set -euo pipefail

stage="${1:-}"
case "$stage" in
  /tmp/dablaja-deploy.*) ;;
  *) echo "Refusing unexpected staging directory." >&2; exit 2 ;;
esac

server_src="$stage/server-dablaja.py"
privacy_src="$stage/privacy.html"
terms_src="$stage/terms.html"
secrets_file="/opt/ytmp3/secrets.env"

test -f "$server_src"
test -f "$privacy_src"
test -f "$terms_src"
test -f "$secrets_file"
python3 -m py_compile "$server_src"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/ytmp3-backups/dablaja-$stamp"
install -d -m 0700 "$backup"
cp -a /opt/ytmp3/server/dablaja.py "$backup/dablaja.py"
cp -a /opt/ytmp3/public/dablaja/privacy.html "$backup/privacy.html"
cp -a /opt/ytmp3/public/dablaja/terms.html "$backup/terms.html"
cp -a "$secrets_file" "$backup/secrets.env"
/opt/ytmp3/venv/bin/python -c 'import importlib.metadata; print(importlib.metadata.version("stripe"))' > "$backup/stripe-version.txt"

deployed=0
rollback() {
  code=$?
  trap - ERR
  if [ "$deployed" = 1 ]; then
    install -o ytmp3 -g ytmp3 -m 0644 "$backup/dablaja.py" /opt/ytmp3/server/dablaja.py
    install -o root -g root -m 0644 "$backup/privacy.html" /opt/ytmp3/public/dablaja/privacy.html
    install -o root -g root -m 0644 "$backup/terms.html" /opt/ytmp3/public/dablaja/terms.html
    install -o root -g root -m 0600 "$backup/secrets.env" "$secrets_file"
    old_stripe_version="$(cat "$backup/stripe-version.txt")"
    /opt/ytmp3/venv/bin/pip install --disable-pip-version-check --no-cache-dir --quiet "stripe==$old_stripe_version" || true
    systemctl restart ytmp3-api || true
  fi
  echo "Deployment failed; exact-file rollback attempted from $backup" >&2
  exit "$code"
}
trap rollback ERR

deployed=1

# Use a dedicated, stable secret for day-scoped HMAC rate-limit buckets. The
# raw client address is never persisted. Generate on-host and never print it.
if ! grep -Eq '^DABLAJA_RATE_LIMIT_SECRET=.+$' "$secrets_file"; then
  rate_secret="$(openssl rand -hex 32)"
  secrets_tmp="$(mktemp /opt/ytmp3/secrets.env.XXXXXX)"
  awk '!/^DABLAJA_RATE_LIMIT_SECRET=/' "$secrets_file" > "$secrets_tmp"
  printf '\nDABLAJA_RATE_LIMIT_SECRET=%s\n' "$rate_secret" >> "$secrets_tmp"
  unset rate_secret
  install -o root -g root -m 0600 "$secrets_tmp" "$secrets_file"
  rm -f -- "$secrets_tmp"
fi

# Upgrade only the Stripe SDK used by Dablaja. Avoid changing the host app's
# unrelated Starlette/Uvicorn dependency graph during this narrow deployment.
/opt/ytmp3/venv/bin/pip install --disable-pip-version-check --no-cache-dir --quiet 'stripe==15.5.0'

install -o ytmp3 -g ytmp3 -m 0644 "$server_src" /opt/ytmp3/server/dablaja.py
install -o root -g root -m 0644 "$privacy_src" /opt/ytmp3/public/dablaja/privacy.html
install -o root -g root -m 0644 "$terms_src" /opt/ytmp3/public/dablaja/terms.html
systemctl restart ytmp3-api

for _ in 1 2 3 4 5; do
  if systemctl is-active --quiet ytmp3-api \
    && curl -fsS http://127.0.0.1:8080/health >/dev/null \
    && curl -fsS http://127.0.0.1:8080/dablaja/api/stats >/dev/null \
    && /opt/ytmp3/venv/bin/python -c 'import importlib.metadata, sys; sys.exit(0 if importlib.metadata.version("stripe") == "15.5.0" else 1)'; then
    trap - ERR
    rm -rf -- "$stage"
    echo "Dablaja deployment healthy; backup retained at $backup"
    exit 0
  fi
  sleep 2
done

false
