#!/usr/bin/env python3
"""Idempotently configure Dablaja's Stripe webhook without printing secrets."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import stripe


EVENTS = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    "refund.created",
    "charge.dispute.created",
]


def read_env(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    values: dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return lines, values


def replace_env_value(path: Path, lines: list[str], key: str, value: str) -> None:
    stat = path.stat()
    output: list[str] = []
    replaced = False
    for raw_line in lines:
        if raw_line.strip().startswith(f"{key}="):
            if not replaced:
                output.append(f"{key}={value}")
                replaced = True
            continue
        output.append(raw_line)
    if not replaced:
        if output and output[-1]:
            output.append("")
        output.append(f"{key}={value}")

    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(output) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, stat.st_mode & 0o777)
        os.chown(tmp_name, stat.st_uid, stat.st_gid)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def signed_probe(url: str, secret: str) -> int:
    payload = json.dumps(
        {
            "id": "evt_dablaja_configuration_check",
            "object": "event",
            "type": "dablaja.configuration_check",
            "data": {"object": {}},
        },
        separators=(",", ":"),
    ).encode("utf-8")
    timestamp = int(time.time())
    digest = hmac.new(secret.encode("utf-8"), str(timestamp).encode() + b"." + payload, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Stripe-Signature": f"t={timestamp},v1={digest}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--restart-service", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    parsed_url = urlparse(args.url)
    if parsed_url.scheme != "https" or parsed_url.hostname != "audiofetcher.com" or parsed_url.path != "/dablaja/webhook":
        print("result=FAIL")
        print("reason=unexpected_webhook_url")
        return 2
    if args.restart_service and not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.restart_service):
        print("result=FAIL")
        print("reason=invalid_service_name")
        return 2

    lines, env = read_env(args.env_file)
    api_key = env.get("STRIPE_SECRET_KEY", "")
    if not api_key:
        print("result=FAIL")
        print("reason=stripe_secret_missing")
        return 2

    stripe.api_key = api_key
    stripe.api_version = "2025-03-31.basil"
    account = stripe.Account.retrieve()
    if account.id != args.expected_account:
        print(f"account_id={account.id}")
        print("result=FAIL")
        print("reason=account_mismatch")
        return 2
    endpoints = list(stripe.WebhookEndpoint.list(limit=100).auto_paging_iter())
    matches = [endpoint for endpoint in endpoints if endpoint.url == args.url]
    stored_secret = env.get("STRIPE_WEBHOOK_SECRET", "")

    if matches and stored_secret:
        endpoint = matches[0]
        endpoint = stripe.WebhookEndpoint.modify(
            endpoint.id,
            enabled_events=EVENTS,
            description="Dablaja Plus production fulfillment and revocation",
        )
        action = "updated"
    else:
        # An endpoint whose secret was never durably stored cannot be verified
        # by this server. Replace only exact-URL orphan endpoints, then create a
        # new endpoint and atomically persist its one-time secret.
        for orphan in matches:
            stripe.WebhookEndpoint.delete(orphan.id)
        endpoint = stripe.WebhookEndpoint.create(
            url=args.url,
            enabled_events=EVENTS,
            description="Dablaja Plus production fulfillment and revocation",
        )
        stored_secret = endpoint.secret
        replace_env_value(args.env_file, lines, "STRIPE_WEBHOOK_SECRET", stored_secret)
        action = "created"

    if args.restart_service:
        try:
            subprocess.run(["systemctl", "restart", args.restart_service], check=True)
        except subprocess.CalledProcessError:
            print("result=FAIL")
            print("reason=service_restart_failed")
            return 3

    refreshed = stripe.WebhookEndpoint.retrieve(endpoint.id)
    actual_events = sorted(refreshed.enabled_events)
    print(f"account_id={account.id}")
    print(f"endpoint_id={refreshed.id}")
    print(f"endpoint_url={refreshed.url}")
    print(f"endpoint_status={refreshed.status}")
    print(f"endpoint_livemode={bool(refreshed.livemode)}")
    print(f"enabled_events={','.join(actual_events)}")
    print(f"action={action}")

    if sorted(EVENTS) != actual_events:
        print("result=FAIL")
        print("reason=event_mismatch")
        return 4
    if args.self_test:
        status = 0
        for _ in range(5):
            status = signed_probe(args.url, stored_secret)
            if status == 200:
                break
            time.sleep(2)
        print(f"signed_probe_status={status}")
        if status != 200:
            print("result=FAIL")
            print("reason=signed_probe_failed")
            return 5

    print("result=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
