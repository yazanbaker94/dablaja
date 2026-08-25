#!/usr/bin/env python3
"""Remove synthetic live-E2E telemetry without touching real Dablaja rows.

The opt-in live E2E suite uses the reserved event-id prefixes below and always
adds exactly one 60-second YouTube usage sample per accepted usage event.  This
tool is dry-run by default. Applying requires ``--backup``; it creates and
integrity-checks a SQLite online backup before one immediate cleanup transaction.
"""

from __future__ import annotations

import argparse
import sqlite3
from collections import Counter
from pathlib import Path


USAGE_PREFIX = "e2eusage"
ERROR_PREFIXES = ("e2e-error-", "e2eerr")
USAGE_MS_PER_EVENT = 60_000


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    database = args.database.resolve()
    if not database.is_file():
        print("DB=missing")
        return 1

    if args.apply and args.backup is None:
        parser.error("--apply requires --backup")

    backup = args.backup.resolve() if args.backup else None
    if backup and backup.exists():
        print("backup=already-exists")
        return 1
    if backup and not backup.parent.is_dir():
        print("backup-parent=missing")
        return 1

    connection = sqlite3.connect(str(database), timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        usage_rows = connection.execute(
            "SELECT id, substr(created_at, 1, 10) AS day "
            "FROM usage_event_ids WHERE id LIKE ? ORDER BY created_at",
            (f"{USAGE_PREFIX}%",),
        ).fetchall()
        error_rows = connection.execute(
            "SELECT event_id FROM error_reports "
            "WHERE event_id LIKE ? OR event_id LIKE ? ORDER BY created_at",
            (f"{ERROR_PREFIXES[0]}%", f"{ERROR_PREFIXES[1]}%"),
        ).fetchall()
        usage_by_day = Counter(str(row["day"]) for row in usage_rows)

        print(f"synthetic_usage_events={len(usage_rows)}")
        print(f"synthetic_error_events={len(error_rows)}")
        print(f"mode={'apply' if args.apply else 'dry-run'}")
        if not args.apply:
            return 0

        with sqlite3.connect(str(backup)) as backup_connection:
            connection.backup(backup_connection)
            check = backup_connection.execute("PRAGMA quick_check").fetchone()
            if check is None or str(check[0]).lower() != "ok":
                raise RuntimeError("backup integrity check failed")
        print(f"backup={backup}")

        connection.execute("BEGIN IMMEDIATE")
        for day, count in usage_by_day.items():
            current = connection.execute(
                "SELECT dubbed_ms, sessions FROM usage_daily "
                "WHERE day = ? AND platform = 'youtube'",
                (day,),
            ).fetchone()
            decrement_ms = count * USAGE_MS_PER_EVENT
            if current is None or int(current["sessions"]) < count or int(current["dubbed_ms"]) < decrement_ms:
                raise RuntimeError(f"usage aggregate does not contain the reserved E2E contribution for {day}")
            connection.execute(
                "UPDATE usage_daily SET dubbed_ms = dubbed_ms - ?, sessions = sessions - ? "
                "WHERE day = ? AND platform = 'youtube'",
                (decrement_ms, count, day),
            )
            connection.execute(
                "DELETE FROM usage_daily WHERE day = ? AND platform = 'youtube' "
                "AND dubbed_ms = 0 AND sessions = 0",
                (day,),
            )

        connection.executemany(
            "DELETE FROM usage_event_ids WHERE id = ?",
            [(str(row["id"]),) for row in usage_rows],
        )
        connection.executemany(
            "DELETE FROM error_reports WHERE event_id = ?",
            [(str(row["event_id"]),) for row in error_rows],
        )
        connection.commit()
        print("cleanup=PASS")
        return 0
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
