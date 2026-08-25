#!/usr/bin/env python3
"""Read-only, content-free Dablaja schema/migration verification."""

from __future__ import annotations

import argparse
import ipaddress
import sqlite3
from pathlib import Path


EXPECTED_TABLES = {
    "purchases",
    "license_installations",
    "checkout_attempts",
    "recovery_codes",
    "daily_budget",
    "error_reports",
    "feedback_reports",
    "usage_daily",
    "usage_event_ids",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    database = args.database.resolve()
    if not database.is_file():
        print("DB=missing")
        return 1

    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row["name"]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        missing = sorted(EXPECTED_TABLES - tables)
        installation_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(license_installations)")
        }
        attempt_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(checkout_attempts)")
        }
        categories = [row["category"] for row in connection.execute("SELECT category FROM daily_budget")]
        raw_ip = 0
        for value in categories:
            suffix = str(value).split(":", 1)[-1]
            try:
                ipaddress.ip_address(suffix)
                raw_ip += 1
            except ValueError:
                pass
        legacy_error = sum(str(value).startswith("errors:") for value in categories)

        checks = {
            "expected_tables": not missing,
            "legacy_licenses_removed": "licenses" not in tables,
            "installation_credential_hash": "credential_hash" in installation_columns,
            "attempt_credential_hash": "credential_hash" in attempt_columns,
            "legacy_error_ip_budgets": legacy_error == 0,
            "raw_ip_budget_keys": raw_ip == 0,
        }
        for name, passed in checks.items():
            print(f"{name}={'PASS' if passed else 'FAIL'}")
        if missing:
            print("missing_tables=" + ",".join(missing))
        return 0 if all(checks.values()) else 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
