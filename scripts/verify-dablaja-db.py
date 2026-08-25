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
        error_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(error_reports)")
        }
        feedback_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(feedback_reports)")
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

        forbidden_remote_columns = {
            "install_id", "api_key", "url", "title", "transcript", "audio", "page_url"
        }
        error_sensitive_rows = connection.execute(
            "SELECT COUNT(*) AS n FROM error_reports WHERE error_message != '' OR user_agent != ''"
        ).fetchone()["n"]
        feedback_agent_rows = connection.execute(
            "SELECT COUNT(*) AS n FROM feedback_reports WHERE user_agent != ''"
        ).fetchone()["n"]
        duplicate_error_events = connection.execute(
            "SELECT COUNT(*) - COUNT(DISTINCT event_id) AS n FROM error_reports"
        ).fetchone()["n"]
        duplicate_submissions = connection.execute(
            "SELECT COUNT(*) - COUNT(DISTINCT submission_id) AS n FROM feedback_reports"
        ).fetchone()["n"]
        invalid_usage = connection.execute(
            """SELECT COUNT(*) AS n FROM usage_daily
               WHERE platform NOT IN ('youtube','x','twitch','other')
                  OR dubbed_ms < 0 OR sessions < 0"""
        ).fetchone()["n"]
        invalid_feedback_kind = connection.execute(
            "SELECT COUNT(*) AS n FROM feedback_reports WHERE kind NOT IN ('feedback','uninstall')"
        ).fetchone()["n"]
        expired_errors = connection.execute(
            "SELECT COUNT(*) AS n FROM error_reports WHERE datetime(created_at) < datetime('now', '-45 days')"
        ).fetchone()["n"]
        expired_feedback = connection.execute(
            "SELECT COUNT(*) AS n FROM feedback_reports WHERE datetime(created_at) < datetime('now', '-180 days')"
        ).fetchone()["n"]
        expired_usage_ids = connection.execute(
            "SELECT COUNT(*) AS n FROM usage_event_ids WHERE datetime(created_at) < datetime('now', '-8 days')"
        ).fetchone()["n"]
        expired_abandoned_checkouts = connection.execute(
            """SELECT COUNT(*) AS n FROM checkout_attempts a
               WHERE a.status IN ('pending', 'failed')
                 AND datetime(a.created_at) < datetime('now', '-30 days')
                 AND NOT EXISTS (
                   SELECT 1 FROM purchases p WHERE p.stripe_session_id = a.stripe_session_id
                 )"""
        ).fetchone()["n"]
        synthetic_usage_ids = connection.execute(
            "SELECT COUNT(*) AS n FROM usage_event_ids WHERE id LIKE 'e2eusage%'"
        ).fetchone()["n"]
        synthetic_error_ids = connection.execute(
            """SELECT COUNT(*) AS n FROM error_reports
               WHERE event_id LIKE 'e2e-error-%' OR event_id LIKE 'e2eerr%'"""
        ).fetchone()["n"]
        synthetic_checkout_attempts = connection.execute(
            "SELECT COUNT(*) AS n FROM checkout_attempts WHERE install_id LIKE 'e2e-checkout-%'"
        ).fetchone()["n"]

        checks = {
            "expected_tables": not missing,
            "legacy_licenses_removed": "licenses" not in tables,
            "installation_credential_hash": "credential_hash" in installation_columns,
            "attempt_credential_hash": "credential_hash" in attempt_columns,
            "legacy_error_ip_budgets": legacy_error == 0,
            "raw_ip_budget_keys": raw_ip == 0,
            "diagnostic_schema_has_no_identity_or_content": not (error_columns & forbidden_remote_columns),
            "feedback_schema_has_no_install_identity": "install_id" not in feedback_columns,
            "diagnostic_sensitive_fields_empty": error_sensitive_rows == 0,
            "feedback_user_agents_empty": feedback_agent_rows == 0,
            "diagnostic_event_ids_unique": duplicate_error_events == 0,
            "feedback_submission_ids_unique": duplicate_submissions == 0,
            "usage_rows_allowlisted_and_nonnegative": invalid_usage == 0,
            "feedback_kinds_allowlisted": invalid_feedback_kind == 0,
            "diagnostic_retention_enforced": expired_errors == 0,
            "feedback_retention_enforced": expired_feedback == 0,
            "usage_dedupe_retention_enforced": expired_usage_ids == 0,
            "abandoned_checkout_retention_enforced": expired_abandoned_checkouts == 0,
            "no_synthetic_e2e_telemetry": synthetic_usage_ids == 0 and synthetic_error_ids == 0,
            "no_synthetic_e2e_checkout_attempts": synthetic_checkout_attempts == 0,
        }
        for name, passed in checks.items():
            print(f"{name}={'PASS' if passed else 'FAIL'}")
        counts = connection.execute(
            """SELECT
                 (SELECT COUNT(*) FROM error_reports) AS diagnostics,
                 (SELECT COUNT(*) FROM feedback_reports WHERE kind='feedback') AS feedback,
                 (SELECT COUNT(*) FROM feedback_reports WHERE kind='uninstall') AS uninstalls,
                 (SELECT COALESCE(SUM(sessions), 0) FROM usage_daily) AS usage_sessions"""
        ).fetchone()
        print(f"diagnostic_count={counts['diagnostics']}")
        print(f"feedback_count={counts['feedback']}")
        print(f"uninstall_count={counts['uninstalls']}")
        print(f"usage_session_count={counts['usage_sessions']}")
        if missing:
            print("missing_tables=" + ",".join(missing))
        return 0 if all(checks.values()) else 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
