#!/usr/bin/env python3
"""Expire and remove reserved live-E2E Stripe Checkout attempts.

Dry-run by default.  ``--apply`` requires STRIPE_SECRET_KEY, refuses any
attempt that produced a purchase, expires only still-open Stripe sessions, and
deletes only rows whose installation id starts with ``e2e-checkout-``.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path

import stripe


INSTALL_PREFIX = "e2e-checkout-"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--env-file", type=Path, help="Optional environment file containing STRIPE_SECRET_KEY")
    args = parser.parse_args()
    database = args.database.resolve()
    if not database.is_file():
        print("DB=missing")
        return 1

    connection = sqlite3.connect(str(database), timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT stripe_session_id, status FROM checkout_attempts "
            "WHERE install_id LIKE ? ORDER BY created_at",
            (f"{INSTALL_PREFIX}%",),
        ).fetchall()
        session_ids = [str(row["stripe_session_id"]) for row in rows]
        purchase_count = 0
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            purchase_count = int(connection.execute(
                f"SELECT COUNT(*) AS n FROM purchases WHERE stripe_session_id IN ({placeholders})",
                session_ids,
            ).fetchone()["n"])

        print(f"synthetic_checkout_attempts={len(rows)}")
        print(f"synthetic_checkout_purchases={purchase_count}")
        print(f"mode={'apply' if args.apply else 'dry-run'}")
        if not args.apply:
            return 0
        if purchase_count:
            raise RuntimeError("refusing to remove a Checkout attempt that produced a purchase")

        secret = os.environ.get("STRIPE_SECRET_KEY", "").strip()
        if not secret and args.env_file and args.env_file.is_file():
            for raw_line in args.env_file.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, value = line.split("=", 1)
                if name.strip() == "STRIPE_SECRET_KEY":
                    secret = value.strip().strip('"').strip("'")
                    break
        if not secret:
            raise RuntimeError("STRIPE_SECRET_KEY is required for --apply")
        stripe.api_key = secret

        expired = 0
        for session_id in session_ids:
            checkout = stripe.checkout.Session.retrieve(session_id)
            status = str(getattr(checkout, "status", ""))
            if status == "complete":
                raise RuntimeError("refusing to expire a completed Checkout session")
            if status == "open":
                stripe.checkout.Session.expire(session_id)
                expired += 1

        connection.execute("BEGIN IMMEDIATE")
        connection.executemany(
            "DELETE FROM checkout_attempts WHERE stripe_session_id = ? AND install_id LIKE ?",
            [(session_id, f"{INSTALL_PREFIX}%") for session_id in session_ids],
        )
        connection.commit()
        print(f"stripe_sessions_expired={expired}")
        print("cleanup=PASS")
        return 0
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
