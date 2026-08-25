"""Isolated Dablaja telemetry, feedback, uninstall, and admin.

Does not touch the YouTube conversion queue database.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

try:
    import stripe
    STRIPE_AVAILABLE = True
except ImportError:
    stripe = None
    STRIPE_AVAILABLE = False

DATA = Path(os.environ.get("YTMP3_DATA", "/var/ytmp3"))
DB_PATH = Path(os.environ.get("DABLAJA_DB", str(DATA / "dablaja.db")))
ADMIN_TOKEN = os.environ.get("DABLAJA_ADMIN_TOKEN", "").strip()
ADMIN_SESSION_SECRET = os.environ.get("DABLAJA_ADMIN_SESSION_SECRET", "").strip()
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
# Ed25519 seed (base64, 32 bytes -> 64-char b64) for signing Plus license
# tokens. Generate with scripts/generate-license-key.py ON THE VPS.
LICENSE_SIGNING_KEY_B64 = os.environ.get("DABLAJA_LICENSE_SIGNING_KEY", "").strip()
# Used only to derive short-lived, non-reversible rate-limit buckets. The raw
# client address is never written to SQLite. Production should set the
# dedicated value; existing server secrets are deterministic upgrade
# fallbacks, while the random fallback keeps local development usable.
RATE_LIMIT_SECRET = (
    os.environ.get("DABLAJA_RATE_LIMIT_SECRET", "").strip()
    or ADMIN_SESSION_SECRET
    or LICENSE_SIGNING_KEY_B64
    or uuid.uuid4().hex
)
STRIPE_PRICE_ID = "price_1U6XCyIVWhSNOyU59PdmsbaP"
STRIPE_PRODUCT_ID = "prod_V6kibqrDgsGEXV"
EXPECTED_AMOUNT = 1000
EXPECTED_CURRENCY = "usd"
# The account has Stripe Managed Payments enabled, which requires an API
# version of 2025-03-31.basil or greater; the pinned stripe-python release
# defaults to 2024-06-20 and must send this override on every call.
STRIPE_API_VERSION = "2025-03-31.basil"
DABLAJA_PLUS_SUCCESS_URL = "https://audiofetcher.com/dablaja/success?session_id={CHECKOUT_SESSION_ID}"
DABLAJA_PLUS_CANCEL_URL = "https://audiofetcher.com/dablaja/"
# CORS allowlist: exact origins, production must contain published extension origin
DABLAJA_ALLOWED_EXTENSION_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("DABLAJA_ALLOWED_EXTENSION_ORIGINS", "").split(",")
    if origin.strip()
]
# If not configured, allow no extension origins (fail closed). Dev origins via env.
MAX_JSON_BODY_BYTES = 8192
ERROR_RETENTION_DAYS = 45
FEEDBACK_RETENTION_DAYS = 180
ERROR_DAILY_LIMIT = 400
FEEDBACK_DAILY_LIMIT = 80
USAGE_DAILY_LIMIT = 10_000
VERIFY_DAILY_LIMIT = 200
VERIFY_PER_INSTALL = 20
CHECKOUT_DAILY_LIMIT = 100
CHECKOUT_PER_INSTALL = 10
ADMIN_LOGIN_DAILY_LIMIT = 30
USAGE_EVENT_RETENTION_DAYS = 8
ABANDONED_CHECKOUT_RETENTION_DAYS = 30
USAGE_PLATFORMS = {"youtube", "x", "twitch", "other"}
ERROR_CODES = {
    "network_error", "api_key_invalid", "model_unavailable", "rate_limited",
    "connection_failed", "stream_closed", "audio_capture_failed", "setup_failed",
    "worker_unresponsive", "timeout", "start_failed", "offscreen_fatal", "unknown",
}
ERROR_STATUSES = {
    "connecting", "listening", "translating", "reconnecting", "rate_limited",
    "error", "stopped", "ready", "no_key",
}
SECRET_RE = re.compile(r"(AIza[0-9A-Za-z_\-]{10,}|AQ\.[0-9A-Za-z_\-]{10,}|geminiApiKey|sk-[A-Za-z0-9]{10,}|wss?://[^\s]+|https?://[^\s]+)", re.I)
EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}$")

UNINSTALL_REASONS = [
    "احتجتها مرة واحدة",
    "لم تعمل",
    "التأخير كبير",
    "لا أفهم الاستخدام",
    "مشكلة في المفتاح",
    "وجدت أداة أفضل",
    "قلق من الخصوصية",
    "أخرى",
]
FEEDBACK_REASONS = [
    "خطأ أو عطل",
    "اقتراح ميزة",
    "جودة الصوت",
    "التأخير",
    "المفتاح أو الإعداد",
    "أخرى",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def clean_text(value: Any, limit: int) -> str:
    text = SECRET_RE.sub("[redacted]", str(value or "")).strip()
    text = re.sub(r"\s+", " ", text)
    return text[:limit]


def clean_id(value: Any) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]", "", str(value or ""))
    return text[:80]


def _client_rate_key(request: Request) -> str:
    """Return a day-scoped keyed digest for abuse throttling.

    Only trust the forwarding header when the immediate peer is the local
    reverse proxy. This prevents a direct client from choosing its own bucket.
    The UTC day prevents a stable cross-day identifier and HMAC prevents
    practical reverse lookup of IPv4 values.
    """
    peer = str(getattr(request.client, "host", "") or "").strip()
    address = peer
    if peer in {"127.0.0.1", "::1", "localhost"}:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            address = forwarded.split(",")[-1].strip()
    if not address:
        address = "unknown"
    message = f"{utc_day()}|{address}".encode("utf-8", "replace")
    return hmac.new(RATE_LIMIT_SECRET.encode("utf-8"), message, hashlib.sha256).hexdigest()[:32]


class DablajaStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._connect()
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def _init(self) -> None:
        with self._db() as conn:
            tables = {
                row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            migrate_errors = False
            migrate_feedback = False
            if "error_reports" in tables:
                error_cols = [row[1] for row in conn.execute("PRAGMA table_info(error_reports)")]
                migrate_errors = "event_id" not in error_cols
                if migrate_errors:
                    conn.execute("DROP INDEX IF EXISTS idx_dablaja_errors_created")
                    conn.execute("ALTER TABLE error_reports RENAME TO error_reports_legacy")
            if "feedback_reports" in tables:
                feedback_cols = [row[1] for row in conn.execute("PRAGMA table_info(feedback_reports)")]
                migrate_feedback = "submission_id" not in feedback_cols
                if migrate_feedback:
                    conn.execute("DROP INDEX IF EXISTS idx_dablaja_feedback_kind")
                    conn.execute("ALTER TABLE feedback_reports RENAME TO feedback_reports_legacy")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS error_reports (
                  id TEXT PRIMARY KEY,
                  dedupe_key TEXT NOT NULL UNIQUE,
                  event_id TEXT NOT NULL,
                  error_code TEXT NOT NULL,
                  error_message TEXT NOT NULL,
                  status TEXT NOT NULL,
                  site_host TEXT NOT NULL,
                  extension_version TEXT NOT NULL,
                  reconnect_count INTEGER NOT NULL DEFAULT 0,
                  user_agent TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_dablaja_errors_created
                  ON error_reports(created_at DESC);
                CREATE TABLE IF NOT EXISTS feedback_reports (
                  id TEXT PRIMARY KEY,
                  dedupe_key TEXT NOT NULL UNIQUE,
                  kind TEXT NOT NULL,
                  submission_id TEXT NOT NULL,
                  source TEXT NOT NULL,
                  reason TEXT NOT NULL,
                  message TEXT NOT NULL,
                  email TEXT NOT NULL,
                  user_agent TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_dablaja_feedback_kind
                  ON feedback_reports(kind, created_at DESC);
                CREATE TABLE IF NOT EXISTS daily_budget (
                  day TEXT NOT NULL,
                  category TEXT NOT NULL,
                  accepted INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (day, category)
                );
                CREATE TABLE IF NOT EXISTS usage_event_ids (
                  id TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_dablaja_usage_events_created
                  ON usage_event_ids(created_at);
                CREATE TABLE IF NOT EXISTS usage_daily (
                  day TEXT NOT NULL,
                  platform TEXT NOT NULL,
                  dubbed_ms INTEGER NOT NULL DEFAULT 0,
                  sessions INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (day, platform)
                );
                CREATE TABLE IF NOT EXISTS purchases (
                  id TEXT PRIMARY KEY,
                  stripe_session_id TEXT UNIQUE,
                  payment_intent_id TEXT UNIQUE,
                  charge_id TEXT UNIQUE,
                  stripe_customer_id TEXT,
                  price_id TEXT,
                  product_id TEXT,
                  amount_total INTEGER,
                  currency TEXT,
                  status TEXT NOT NULL DEFAULT 'pending',
                  created_at TEXT NOT NULL,
                  activated_at TEXT,
                  revoked_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_purchases_pi
                  ON purchases(payment_intent_id);
                CREATE TABLE IF NOT EXISTS license_installations (
                  license_id TEXT NOT NULL,
                  install_id TEXT NOT NULL,
                  credential_hash TEXT,
                  activated_at TEXT NOT NULL,
                  revoked_at TEXT,
                  PRIMARY KEY (license_id, install_id)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_installations_install
                  ON license_installations(install_id);
                CREATE TABLE IF NOT EXISTS recovery_codes (
                  id TEXT PRIMARY KEY,
                  license_id TEXT NOT NULL UNIQUE,
                  code_hash TEXT NOT NULL UNIQUE,
                  created_at TEXT NOT NULL,
                  rotated_at TEXT,
                  FOREIGN KEY (license_id) REFERENCES purchases(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS checkout_attempts (
                  stripe_session_id TEXT PRIMARY KEY,
                  install_id TEXT NOT NULL,
                  credential_hash TEXT,
                  status TEXT NOT NULL DEFAULT 'pending',
                  created_at TEXT NOT NULL
                );
                """

            )
            if migrate_errors:
                # Discard legacy stable installation identifiers. Historical
                # rows retain their safe error fields and receive their own
                # one-time row id as event id.
                conn.execute(
                    """INSERT INTO error_reports (
                         id, dedupe_key, event_id, error_code, error_message,
                         status, site_host, extension_version, reconnect_count,
                         user_agent, created_at
                       )
                       SELECT id, dedupe_key, id, error_code, error_message,
                         status, site_host, extension_version, reconnect_count,
                         user_agent, created_at
                       FROM error_reports_legacy"""
                )
                conn.execute("DROP TABLE error_reports_legacy")
            if migrate_feedback:
                # Feedback/uninstall submissions use one-time form ids, never
                # a persistent extension installation identity.
                conn.execute(
                    """INSERT INTO feedback_reports (
                         id, dedupe_key, kind, submission_id, source, reason,
                         message, email, user_agent, created_at
                       )
                       SELECT id, dedupe_key, kind, id, source, reason,
                         message, email, user_agent, created_at
                       FROM feedback_reports_legacy"""
                )
                conn.execute("DROP TABLE feedback_reports_legacy")
            # Older builds accepted free-form diagnostic text and form user
            # agents. They are unnecessary for the product and are erased so
            # the live database matches the current allowlisted disclosures.
            conn.execute("UPDATE error_reports SET error_message = '', user_agent = ''")
            conn.execute("UPDATE feedback_reports SET user_agent = ''")
            # Older builds placed the raw client IP in diagnostic and
            # licensing rate-limit keys. Remove those legacy keys immediately;
            # current licensing buckets are day-scoped HMAC values and current
            # diagnostic budgets are global.
            conn.execute("DELETE FROM daily_budget WHERE category LIKE 'errors:%'")
            conn.execute(
                """DELETE FROM daily_budget
                   WHERE (
                     category LIKE 'token:%' OR category LIKE 'recover:%' OR
                     category LIKE 'rotate:%' OR category LIKE 'status:%' OR
                     category LIKE 'checkout:%' OR category LIKE 'admin-login:%'
                   )
                   AND (
                     substr(category, instr(category, ':') + 1) LIKE '%.%' OR
                     substr(category, instr(category, ':') + 1) LIKE '%:%'
                   )"""
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dablaja_errors_created ON error_reports(created_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dablaja_feedback_kind ON feedback_reports(kind, created_at DESC)"
            )
            cols = [row[1] for row in conn.execute("PRAGMA table_info(license_installations)")]
            if "credential_hash" not in cols:
                conn.execute("ALTER TABLE license_installations ADD COLUMN credential_hash TEXT")
            attempt_cols = [row[1] for row in conn.execute("PRAGMA table_info(checkout_attempts)")]
            if "credential_hash" not in attempt_cols:
                conn.execute("ALTER TABLE checkout_attempts ADD COLUMN credential_hash TEXT")
            self._migrate_legacy_licenses(conn)

    def _migrate_legacy_licenses(self, conn: sqlite3.Connection) -> None:
        """One-time migration from the conflated pre-1.1 licenses table.

        Old rows mixed purchases and installations: stripe_session_id could
        hold a PaymentIntent id, install_id lived on the purchase row, and
        customer_email acted as a pseudo-recovery channel. This moves each
        legacy ACTIVE row to one purchase (session-id keyed when real,
        otherwise an internal id) plus one installation binding, drops the
        table, and renames the new canonical table into place. Idempotent:
        runs only while the legacy shape exists.
        """
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "licenses" not in tables:
            return
        cols = [row[1] for row in conn.execute("PRAGMA table_info(licenses)")]
        if "install_id" not in cols:
            # Already migrated (purchases-only shape under the old name).
            conn.execute("ALTER TABLE licenses RENAME TO purchases_legacy_unused")
            return
        rows = conn.execute("SELECT * FROM licenses").fetchall()
        for row in rows:
            legacy_reference = str(row["stripe_session_id"] or "")
            purchase_session = legacy_reference if legacy_reference.startswith("cs_") else None
            payment_intent_id = legacy_reference if legacy_reference.startswith("pi_") else None
            charge_id = legacy_reference if legacy_reference.startswith("ch_") else None
            purchase_id = str(uuid.uuid4())
            conn.execute(
                """INSERT OR IGNORE INTO purchases
                   (id, stripe_session_id, payment_intent_id, charge_id,
                    stripe_customer_id, amount_total, currency, status,
                    created_at, activated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    purchase_id,
                    purchase_session,
                    payment_intent_id,
                    charge_id,
                    row["stripe_customer_id"],
                    row["amount_total"],
                    row["currency"],
                    row["status"],
                    row["created_at"],
                    row["activated_at"],
                ),
            )
            if row["status"] == "active":
                if purchase_session:
                    license_row = conn.execute(
                        "SELECT id FROM purchases WHERE stripe_session_id = ?", (purchase_session,)
                    ).fetchone()
                elif payment_intent_id:
                    license_row = conn.execute(
                        "SELECT id FROM purchases WHERE payment_intent_id = ?", (payment_intent_id,)
                    ).fetchone()
                elif charge_id:
                    license_row = conn.execute(
                        "SELECT id FROM purchases WHERE charge_id = ?", (charge_id,)
                    ).fetchone()
                else:
                    license_row = conn.execute(
                        "SELECT id FROM purchases WHERE id = ?", (purchase_id,)
                    ).fetchone()
                if license_row:
                    conn.execute(
                        """INSERT OR IGNORE INTO license_installations
                           (license_id, install_id, activated_at) VALUES (?, ?, ?)""",
                        (license_row["id"], row["install_id"], row["activated_at"] or utc_now()),
                    )
        conn.execute("DROP TABLE licenses")

    def reserve(self, category: str, limit: int) -> bool:
        day = utc_day()
        with self._db() as conn:
            row = conn.execute(
                "SELECT accepted FROM daily_budget WHERE day = ? AND category = ?",
                (day, category),
            ).fetchone()
            current = int(row["accepted"]) if row else 0
            if current >= limit:
                return False
            conn.execute(
                """
                INSERT INTO daily_budget(day, category, accepted) VALUES(?, ?, 1)
                ON CONFLICT(day, category) DO UPDATE SET accepted = accepted + 1
                """,
                (day, category),
            )
            return True

    def add_error(self, record: dict[str, Any]) -> str:
        with self._db() as conn:
            existing = conn.execute(
                "SELECT id FROM error_reports WHERE dedupe_key = ?",
                (record["dedupe_key"],),
            ).fetchone()
            if existing:
                return "duplicate"
            conn.execute(
                """
                INSERT INTO error_reports (
                  id, dedupe_key, event_id, error_code, error_message, status,
                  site_host, extension_version, reconnect_count, user_agent, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["dedupe_key"],
                    record["event_id"],
                    record["error_code"],
                    record["error_message"],
                    record["status"],
                    record["site_host"],
                    record["extension_version"],
                    record["reconnect_count"],
                    record["user_agent"],
                    record["created_at"],
                ),
            )
            return "ok"

    def add_feedback(self, record: dict[str, Any]) -> str:
        with self._db() as conn:
            existing = conn.execute(
                "SELECT id FROM feedback_reports WHERE dedupe_key = ?",
                (record["dedupe_key"],),
            ).fetchone()
            if existing:
                return "duplicate"
            conn.execute(
                """
                INSERT INTO feedback_reports (
                  id, dedupe_key, kind, submission_id, source, reason, message,
                  email, user_agent, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["dedupe_key"],
                    record["kind"],
                    record["submission_id"],
                    record["source"],
                    record["reason"],
                    record["message"],
                    record["email"],
                    record["user_agent"],
                    record["created_at"],
                ),
            )
            return "ok"

    def add_usage(self, event_id: str, platform: str, dubbed_ms: int) -> str:
        with self._db() as conn:
            existing = conn.execute(
                "SELECT 1 FROM usage_event_ids WHERE id = ?",
                (event_id,),
            ).fetchone()
            if existing:
                return "duplicate"
            conn.execute(
                "INSERT INTO usage_event_ids(id, created_at) VALUES(?, ?)",
                (event_id, utc_now()),
            )
            conn.execute(
                """
                INSERT INTO usage_daily(day, platform, dubbed_ms, sessions)
                VALUES(?, ?, ?, 1)
                ON CONFLICT(day, platform) DO UPDATE SET
                  dubbed_ms = dubbed_ms + excluded.dubbed_ms,
                  sessions = sessions + 1
                """,
                (utc_day(), platform, dubbed_ms),
            )
            return "ok"

    def public_stats(self) -> dict[str, Any]:
        today = datetime.now(timezone.utc).date()
        first_day = today - timedelta(days=29)
        week_start = today - timedelta(days=6)
        with self._db() as conn:
            totals = conn.execute(
                "SELECT COALESCE(SUM(dubbed_ms), 0) AS ms, COALESCE(SUM(sessions), 0) AS sessions FROM usage_daily"
            ).fetchone()
            rows = conn.execute(
                "SELECT day, platform, dubbed_ms, sessions FROM usage_daily WHERE day >= ? ORDER BY day ASC",
                (first_day.isoformat(),),
            ).fetchall()
            platform_rows = conn.execute(
                "SELECT platform, COALESCE(SUM(dubbed_ms), 0) AS ms FROM usage_daily GROUP BY platform"
            ).fetchall()

        daily_ms: dict[str, int] = {}
        week_ms = 0
        for row in rows:
            day = str(row["day"])
            amount = max(0, int(row["dubbed_ms"] or 0))
            daily_ms[day] = daily_ms.get(day, 0) + amount
            if day >= week_start.isoformat():
                week_ms += amount

        platform_ms = {name: 0 for name in USAGE_PLATFORMS}
        for row in platform_rows:
            name = str(row["platform"])
            if name in platform_ms:
                platform_ms[name] = max(0, int(row["ms"] or 0))
        all_platform_ms = sum(platform_ms.values())
        platforms = {
            name: round((amount / all_platform_ms) * 100, 1) if all_platform_ms else 0
            for name, amount in platform_ms.items()
        }

        history = []
        cursor = first_day
        while cursor <= today:
            key = cursor.isoformat()
            history.append({"day": key, "hours": round(daily_ms.get(key, 0) / 3_600_000, 2)})
            cursor += timedelta(days=1)

        return {
            "total_hours": round(max(0, int(totals["ms"] or 0)) / 3_600_000, 1),
            "total_sessions": max(0, int(totals["sessions"] or 0)),
            "week_hours": round(week_ms / 3_600_000, 1),
            "last_30_days": history,
            "platforms": platforms,
            "updated_at": utc_now(),
        }

    def counts(self) -> dict[str, int]:
        with self._db() as conn:
            errors = conn.execute("SELECT COUNT(*) AS n FROM error_reports").fetchone()["n"]
            uninstalls = conn.execute(
                "SELECT COUNT(*) AS n FROM feedback_reports WHERE kind = 'uninstall'"
            ).fetchone()["n"]
            feedback = conn.execute(
                "SELECT COUNT(*) AS n FROM feedback_reports WHERE kind = 'feedback'"
            ).fetchone()["n"]
        return {"errors": errors, "uninstalls": uninstalls, "feedback": feedback}

    def list_errors(self, limit: int = 80) -> list[dict[str, Any]]:
        with self._db() as conn:
            rows = conn.execute(
                "SELECT * FROM error_reports ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_feedback(self, kind: str, limit: int = 80) -> list[dict[str, Any]]:
        with self._db() as conn:
            rows = conn.execute(
                "SELECT * FROM feedback_reports WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
                (kind, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def prune(self) -> None:
        with self._db() as conn:
            conn.execute(
                "DELETE FROM error_reports WHERE datetime(created_at) < datetime('now', ?)",
                (f"-{ERROR_RETENTION_DAYS} days",),
            )
            conn.execute(
                "DELETE FROM feedback_reports WHERE datetime(created_at) < datetime('now', ?)",
                (f"-{FEEDBACK_RETENTION_DAYS} days",),
            )
            conn.execute(
                "DELETE FROM usage_event_ids WHERE datetime(created_at) < datetime('now', ?)",
                (f"-{USAGE_EVENT_RETENTION_DAYS} days",),
            )
            # Checkout attempts that never produced a purchase are short-lived
            # operational records, not lifetime licensing records. Completed
            # attempts stay because they are linked to the purchase and are
            # needed for idempotent Stripe webhook reconciliation.
            conn.execute(
                """DELETE FROM checkout_attempts
                   WHERE status IN ('pending', 'failed')
                     AND datetime(created_at) < datetime('now', ?)
                     AND NOT EXISTS (
                       SELECT 1 FROM purchases p
                       WHERE p.stripe_session_id = checkout_attempts.stripe_session_id
                     )""",
                (f"-{ABANDONED_CHECKOUT_RETENTION_DAYS} days",),
            )
            conn.execute("DELETE FROM daily_budget WHERE day < date('now', '-8 days')")

    # ---- Purchases & installations (schema v2) ----------------------------
    # purchases = one Stripe payment; license_installations = purchase↔install
    # binding. A revoked purchase revokes every binding; a binding can never
    # outlive its purchase's revocation.

    def create_checkout_attempt(self, install_id: str, stripe_session_id: str, credential_hash: str | None = None) -> None:
        with self._db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO checkout_attempts
                   (stripe_session_id, install_id, credential_hash, status, created_at)
                   VALUES (?, ?, ?, 'pending', ?)""",
                (stripe_session_id, install_id, credential_hash, utc_now()),
            )

    def get_checkout_attempt(self, stripe_session_id: str):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM checkout_attempts WHERE stripe_session_id = ?",
                (stripe_session_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_purchase_by_session(self, stripe_session_id: str):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM purchases WHERE stripe_session_id = ?", (stripe_session_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_purchase_by_intent(self, payment_intent_id: str):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM purchases WHERE payment_intent_id = ?", (payment_intent_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_purchase_by_charge(self, charge_id: str):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM purchases WHERE charge_id = ?", (charge_id,)
            ).fetchone()
        return dict(row) if row else None

    def active_purchase_id_for_install(self, install_id: str) -> str | None:
        """Stable internal license ID bound to this install, if active."""
        with self._db() as conn:
            row = conn.execute(
                """SELECT p.id FROM license_installations i
                   JOIN purchases p ON p.id = i.license_id
                   WHERE i.install_id = ? AND p.status = 'active'
                     AND i.revoked_at IS NULL LIMIT 1""",
                (install_id,),
            ).fetchone()
        return row["id"] if row else None

    def install_status(self, install_id: str) -> str:
        """'active', 'revoked', or 'none' for this installation."""
        with self._db() as conn:
            row = conn.execute(
                """SELECT p.status FROM license_installations i
                   JOIN purchases p ON p.id = i.license_id
                   WHERE i.install_id = ?
                   ORDER BY COALESCE(i.revoked_at, i.activated_at) DESC LIMIT 1""",
                (install_id,),
            ).fetchone()
        if not row:
            return "none"
        return "active" if row["status"] == "active" else "revoked"

    def installation_credential_status(
        self, install_id: str, credential: str, token: str | None = None
    ) -> tuple[str | None, str | None]:
        """Authenticate an installation and return (status, license_id).

        ``status`` is ``active`` or ``revoked`` only after the supplied
        credential matches the stored hash. Unknown installs and incorrect
        credentials both return ``(None, None)`` so callers cannot use this
        method as an installation-existence oracle.

        Semantics required by the spec:
        * On ANY authentication failure (revoked, absent, unknown, wrong
          credential, absent credential, legacy-binds-failed) the caller
          receives the SAME generic 'unauthorized' — never a differentiated
          status that reveals whether the install is known to the server.
        * Legacy (hash-less) rows may be bound only through a cryptographically
          authentic token that has been fully verified: signature, iid, lid,
          iat/exp structure, the normal seven-day expiry horizon, and an active
          database row. Older installations must use recovery instead of
          allowing an indefinitely replayable token to claim a credential.
        * The legacy UPDATE is conditional (requires credential_hash IS NULL)
          so exactly one of two concurrent callers can win.
        """
        if not credential or len(credential) != 64 or not re.match(r"^[0-9a-f]{64}$", credential, re.I):
            return None, None
        expected_hash = hashlib.sha256(credential.lower().encode()).hexdigest()
        with self._db() as conn:
            row = conn.execute(
                """SELECT i.license_id, i.credential_hash, i.revoked_at, p.status FROM license_installations i
                   JOIN purchases p ON p.id = i.license_id
                   WHERE i.install_id = ?
                   ORDER BY COALESCE(i.activated_at, '') DESC LIMIT 1""",
                (install_id,),
            ).fetchone()
            if not row:
                return None, None
            stored_hash = row["credential_hash"]
            if stored_hash:
                if hmac.compare_digest(expected_hash, stored_hash):
                    status = "active" if row["status"] == "active" and not row["revoked_at"] else "revoked"
                    return status, row["license_id"]
                return None, None
            if row["status"] != "active" or row["revoked_at"]:
                return None, None
            # Backward compat: allow one-time credential binding ONLY after the
            # supplied token has been verified in legacy-bootstrap mode
            # (signature + iid/lid + bounded payload/signature + valid iat/exp
            # structure, age alone not rejecting). Expiration never unlocks Plus;
            # it only gates this one-time credential_hash=NULL migration.
            if token and verify_signed_license_token(token, install_id, row["license_id"]):  # type: ignore[arg-type]
                cur = conn.execute(
                    "UPDATE license_installations SET credential_hash = ? "
                    "WHERE license_id = ? AND install_id = ? AND credential_hash IS NULL",
                    (expected_hash, row["license_id"], install_id),  # type: ignore[arg-type]
                )
                if cur.rowcount == 0:
                    # Another concurrent caller bound a credential first.
                    return None, None
                return "active", row["license_id"]
            return None, None

    def verify_installation_credential(
        self, install_id: str, credential: str, token: str | None = None
    ) -> tuple[bool, str | None]:
        """Authenticate an active installation for privileged operations."""
        status, license_id = self.installation_credential_status(install_id, credential, token)
        return status == "active", license_id if status == "active" else None

    def fulfill_purchase(
        self,
        *,
        stripe_session_id: str,
        payment_intent_id: str,
        charge_id: str | None,
        stripe_customer_id: str,
        price_id: str,
        product_id: str,
        amount_total: int,
        currency: str,
        install_id: str,
    ) -> dict[str, Any]:
        """Idempotent fulfillment inside one transaction.

        Returns {'result': 'activated'|'already'|'revoked'|'conflict'}.
        Duplicate webhooks create one purchase and one binding; a revoked
        purchase is never reactivated; a paid session cannot activate two
        unrelated installations.
        """
        with self._db() as conn:
            attempt = conn.execute(
                "SELECT credential_hash FROM checkout_attempts WHERE stripe_session_id = ?",
                (stripe_session_id,),
            ).fetchone()
            cred_hash = attempt["credential_hash"] if attempt else None

            existing = conn.execute(
                "SELECT id, status FROM purchases WHERE stripe_session_id = ?",
                (stripe_session_id,),
            ).fetchone()
            if existing:
                # Terminal states are final: a refunded/disputed/revoked
                # purchase can NEVER be re-activated by a replayed event.
                if existing["status"] in ("revoked", "refunded", "disputed"):
                    return {"result": "revoked", "purchase_id": existing["id"]}
                if existing["status"] == "active":
                    bound_other = conn.execute(
                        "SELECT 1 FROM license_installations WHERE license_id = ? AND install_id != ? LIMIT 1",
                        (existing["id"], install_id),
                    ).fetchone()
                    if bound_other:
                        return {"result": "conflict"}
                    conn.execute(
                        """INSERT INTO license_installations
                           (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, ?, ?)
                           ON CONFLICT(license_id, install_id) DO UPDATE SET
                             credential_hash = COALESCE(excluded.credential_hash, license_installations.credential_hash),
                             revoked_at = NULL""",
                        (existing["id"], install_id, cred_hash, utc_now()),
                    )
                    return {"result": "already", "purchase_id": existing["id"]}
            bound = conn.execute(
                """SELECT 1 FROM license_installations i
                   JOIN purchases p ON p.id = i.license_id
                   WHERE p.stripe_session_id = ? AND i.install_id != ? LIMIT 1""",
                (stripe_session_id, install_id),
            ).fetchone()
            if bound:
                return {"result": "conflict"}
            purchase_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO purchases
                   (id, stripe_session_id, payment_intent_id, charge_id,
                    stripe_customer_id, price_id, product_id, amount_total,
                    currency, status, created_at, activated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
                (
                    purchase_id, stripe_session_id, payment_intent_id, charge_id,
                    stripe_customer_id, price_id, product_id, amount_total,
                    currency, utc_now(), utc_now(),
                ),
            )
            conn.execute(
                """INSERT INTO license_installations
                   (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(license_id, install_id) DO UPDATE SET
                     credential_hash = COALESCE(excluded.credential_hash, license_installations.credential_hash),
                     revoked_at = NULL""",
                (purchase_id, install_id, cred_hash, utc_now()),
            )
            conn.execute(
                "UPDATE checkout_attempts SET status='completed' WHERE stripe_session_id=?",
                (stripe_session_id,),
            )
            return {"result": "activated", "purchase_id": purchase_id}

    def mark_purchase_failed(self, stripe_session_id: str) -> None:
        with self._db() as conn:
            conn.execute(
                "UPDATE purchases SET status='failed' WHERE stripe_session_id=? AND status='pending'",
                (stripe_session_id,),
            )
            conn.execute(
                "UPDATE checkout_attempts SET status='failed' WHERE stripe_session_id=? AND status='pending'",
                (stripe_session_id,),
            )

    def revoke_purchase(self, purchase_id: str, reason: str) -> bool:
        """Revoke a stable purchase and every installation binding. Final."""
        with self._db() as conn:
            cur = conn.execute(
                """UPDATE purchases SET status = ?, revoked_at = ?
                   WHERE id = ? AND status NOT IN ('refunded', 'disputed', 'revoked')""",
                (reason, utc_now(), purchase_id),
            )
            if cur.rowcount == 0:
                return bool(
                    conn.execute(
                        "SELECT 1 FROM purchases WHERE id = ?", (purchase_id,)
                    ).fetchone()
                )
            conn.execute(
                """UPDATE license_installations SET revoked_at = ?
                   WHERE license_id = ? AND revoked_at IS NULL""",
                (utc_now(), purchase_id),
            )
        return True

    def revoke_by_payment_reference(self, *, charge_id=None, payment_intent_id=None) -> bool:
        """Refund resolution: locate the purchase via Charge or PaymentIntent."""
        purchase = None
        if charge_id:
            purchase = self.get_purchase_by_charge(charge_id)
        if not purchase and payment_intent_id:
            purchase = self.get_purchase_by_intent(payment_intent_id)
        if not purchase:
            return False
        return self.revoke_purchase(purchase["id"], "refunded")

    def revoke_by_charge_dispute(self, charge_id: str) -> bool:
        purchase = self.get_purchase_by_charge(charge_id)
        if not purchase and charge_id:
            intent = _stripe_payment_intent_for_charge(charge_id)
            if intent:
                purchase = self.get_purchase_by_intent(intent)
        if not purchase:
            return False
        return self.revoke_purchase(purchase["id"], "disputed")

    # ---- Recovery codes ----------------------------------------------------

    def issue_recovery_code(self, license_id: str) -> str | None:
        """Generate plaintext once; persist only its SHA-256 hash atomically.

        Returns None when a code already exists whose plaintext is unknowable.
        """
        import secrets as _secrets
        code = "DABLAJA-" + _secrets.token_hex(10).upper()
        digest = hashlib.sha256(code.encode()).hexdigest()
        with self._db() as conn:
            cur = conn.execute(
                """INSERT OR IGNORE INTO recovery_codes (id, license_id, code_hash, created_at)
                   VALUES (?, ?, ?, ?)""",
                (str(uuid.uuid4()), license_id, digest, utc_now()),
            )
            if cur.rowcount == 1:
                return code
            return None

    def rotate_recovery_code(self, license_id: str) -> str:
        """Transactional rotation: the old hash stops matching immediately."""
        import secrets as _secrets
        code = "DABLAJA-" + _secrets.token_hex(10).upper()
        digest = hashlib.sha256(code.encode()).hexdigest()
        with self._db() as conn:
            conn.execute(
                """INSERT INTO recovery_codes (id, license_id, code_hash, created_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(license_id) DO UPDATE SET
                     code_hash = excluded.code_hash, rotated_at = excluded.created_at""",
                (str(uuid.uuid4()), license_id, digest, utc_now()),
            )
        return code

    def recover_installation(self, code: str, install_id: str, credential_hash: str | None = None) -> str | None:
        """Bind install to the STABLE internal license ID after verifying the
        hashed code in constant time. Refuses non-active purchases. Returns
        the stable license ID — never the recovery code itself.

        Credential-preservation rule required by the spec: an install_id that
        already holds a different credential_hash must NOT be overwritten via
        recovery. Same-hash replay is idempotent and succeeds; a different
        credential yields None (the route surfaces a generic 'conflict');
        otherwise the existing binding is preserved untouched.
        """
        digest = hashlib.sha256(code.strip().upper().encode()).hexdigest()
        with self._db() as conn:
            row = conn.execute(
                "SELECT license_id, code_hash FROM recovery_codes WHERE code_hash = ?",
                (digest,),
            ).fetchone()
            if not row or not hmac.compare_digest(digest, row["code_hash"]):
                return None
            lic = conn.execute(
                "SELECT status FROM purchases WHERE id = ?", (row["license_id"],)
            ).fetchone()
            if not lic or lic["status"] != "active":
                return None
            existing = conn.execute(
                "SELECT license_id, credential_hash FROM license_installations WHERE install_id = ? LIMIT 1",
                (install_id,),
            ).fetchone()
            if existing:
                if str(existing["license_id"]) == str(row["license_id"]):
                    if existing["credential_hash"] and credential_hash:
                        if hmac.compare_digest(str(existing["credential_hash"]), str(credential_hash)):
                            # Same license + same credential: idempotent success.
                            conn.execute(
                                """INSERT INTO license_installations
                                   (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, ?, ?)
                                   ON CONFLICT(license_id, install_id) DO UPDATE SET
                                     credential_hash = excluded.credential_hash,
                                     activated_at = excluded.activated_at, revoked_at = NULL""",
                                (row["license_id"], install_id, credential_hash, utc_now()),
                            )
                            return row["license_id"]
                        # Same license, different credential.
                        return None
                    # Already bound (even NULL-credential row): differing credential.
                    if existing["license_id"] and credential_hash:
                        return None
                else:
                    # Different license already owns this install_id — conflict
                    # regardless of credential hash. Never attempt a conflicting
                    # INSERT that would violate the unique install_id index.
                    return None
            conn.execute(
                """INSERT INTO license_installations
                   (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(license_id, install_id) DO UPDATE SET
                     credential_hash = COALESCE(excluded.credential_hash, license_installations.credential_hash),
                     activated_at = excluded.activated_at, revoked_at = NULL""",
                (row["license_id"], install_id, credential_hash, utc_now()),
            )
            return row["license_id"]

    def has_active_license(self, install_id: str) -> bool:
        return self.active_purchase_id_for_install(install_id) is not None


store = DablajaStore(DB_PATH)


def _cors_allowed_origin(origin: str) -> str | None:
    if not origin:
        return None
    # Exact match against allowlist; development origins via env
    if origin in DABLAJA_ALLOWED_EXTENSION_ORIGINS:
        return origin
    # Also allow EXTENSION_ORIGIN_RE if in dev mode (env explicitly enables)
    if os.environ.get("DABLAJA_ALLOW_DEV_ORIGINS") == "1" and EXTENSION_ORIGIN_RE.match(origin):
        return origin
    return None

async def report_error(request: Request) -> Response:
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    event_id = clean_id(body.get("event_id") or "")
    if len(event_id) < 16:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "bad_event_id"}, status_code=400), request
        )
    # One global safety budget avoids persisting IP-derived rate-limit keys.
    # The exact extension-origin gate already limits the caller surface.
    if not store.reserve("errors", ERROR_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": True, "status": "budget"}), request)

    raw_error_code = clean_text(body.get("error_code") or "unknown", 80).lower()
    raw_status = clean_text(body.get("status"), 40).lower()
    raw_site = clean_text(body.get("site_host") or body.get("site"), 16).lower()
    try:
        reconnect_count = int(body.get("reconnect_count") or 0)
    except (TypeError, ValueError):
        reconnect_count = 0
    record = {
        "id": str(uuid.uuid4()),
        "event_id": event_id,
        "error_code": raw_error_code if raw_error_code in ERROR_CODES else "unknown",
        "error_message": "",
        "status": raw_status if raw_status in ERROR_STATUSES else "",
        "site_host": raw_site if raw_site in USAGE_PLATFORMS else "other",
        "extension_version": clean_text(body.get("extension_version"), 20),
        "reconnect_count": max(0, min(10, reconnect_count)),
        "user_agent": "",
        "created_at": utc_now(),
    }
    # A retry of the same one-time event id is stored once. There is no stable
    # installation identifier in diagnostics.
    record["dedupe_key"] = hashlib.sha256(event_id.encode()).hexdigest()
    status = store.add_error(record)
    return apply_origin_headers(JSONResponse({"ok": True, "status": status}), request)


async def report_usage(request: Request) -> Response:
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)

    event_id = clean_id(body.get("event_id"))
    platform = clean_text(body.get("platform"), 16).lower()
    try:
        dubbed_ms = int(body.get("dubbed_ms") or 0)
    except (TypeError, ValueError):
        dubbed_ms = 0
    dubbed_ms = max(0, min(8 * 60 * 60 * 1000, dubbed_ms))
    if len(event_id) < 16 or platform not in USAGE_PLATFORMS or dubbed_ms < 1000:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "invalid_event"}, status_code=400), request
        )
    if not store.reserve("usage", USAGE_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": True, "status": "budget"}), request)
    status = store.add_usage(event_id, platform, dubbed_ms)
    return apply_origin_headers(JSONResponse({"ok": True, "status": status}), request)


# ---------------------------------------------------------------------------
# Stripe helpers (official SDK only — no hand-rolled REST client)
# ---------------------------------------------------------------------------

def _stripe_ready() -> bool:
    return STRIPE_AVAILABLE and bool(STRIPE_SECRET_KEY)


def _safe_stripe_checkout_url(value: Any) -> str | None:
    """Accept only Stripe-hosted HTTPS Checkout URLs returned by the SDK."""
    try:
        parsed = urlparse(str(value or ""))
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname != "checkout.stripe.com":
        return None
    if parsed.username or parsed.password or parsed.port:
        return None
    return parsed.geturl()


def _stripe_retrieve_session(session_id: str):
    """Retrieve a Checkout Session with everything fulfillment needs."""
    stripe.api_key = STRIPE_SECRET_KEY
    stripe.api_version = STRIPE_API_VERSION
    return stripe.checkout.Session.retrieve(
        session_id,
        expand=[
            "line_items",
            "line_items.data.price.product",
            "payment_intent",
        ],
    )


def _stripe_payment_intent_for_charge(charge_id: str) -> str | None:
    """Resolve a Charge ID to its PaymentIntent ID (dispute mapping)."""
    if not _stripe_ready():
        return None
    try:
        stripe.api_key = STRIPE_SECRET_KEY
        stripe.api_version = STRIPE_API_VERSION
        charge = stripe.Charge.retrieve(charge_id)
        pi = getattr(charge, "payment_intent", None)
        return str(pi) if pi else None
    except stripe.error.StripeError:
        return None


async def read_bounded_json(request: Request):
    """Parse a size-bounded JSON body. Returns (body, error_response)."""
    raw = await request.body()
    if len(raw) > MAX_JSON_BODY_BYTES:
        return None, JSONResponse({"ok": False, "error": "payload_too_large"}, status_code=413)
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError):
        return None, JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400)
    if not isinstance(parsed, dict):
        return None, JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400)
    return parsed, None


def reject_origin(request: Request) -> JSONResponse | None:
    """Exact-Origin gate. MUST run before any Stripe call or DB mutation."""
    origin = request.headers.get("origin", "").strip()
    if request.method == "OPTIONS":
        allowed = _cors_allowed_origin(origin)
        if allowed:
            r = Response(status_code=204)
            r.headers["Access-Control-Allow-Origin"] = allowed
            r.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
            r.headers["Access-Control-Allow-Headers"] = "Content-Type"
            r.headers["Vary"] = "Origin"
            return r
        return Response(status_code=403)
    if not _cors_allowed_origin(origin):
        return JSONResponse({"ok": False, "error": "origin_not_allowed"}, status_code=403)
    return None


def apply_origin_headers(response: Response, request: Request) -> Response:
    origin = request.headers.get("origin", "").strip()
    allowed = _cors_allowed_origin(origin)
    if allowed:
        response.headers["Access-Control-Allow-Origin"] = allowed
    response.headers["Vary"] = "Origin"
    response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Dablaja Plus — Stripe Checkout + License management
# ---------------------------------------------------------------------------

async def dablaja_api_checkout(request: Request) -> Response:
    """POST /dablaja/api/checkout — create a bound Checkout Session.

    Origin gate runs BEFORE any Stripe call or DB write; a disallowed origin
    performs zero side effects. Client and installation rate budgets apply."""
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    install_id = clean_id(body.get("install_id") or body.get("installId") or "")
    credential = clean_text(body.get("install_credential") or body.get("installCredential") or "", 64).lower()
    if len(install_id) < 16 or len(credential) != 64 or not re.match(r"^[0-9a-f]{64}$", credential):
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "invalid_request"}, status_code=400), request
        )
    # Origin is a browser boundary, not authentication: non-browser clients can
    # forge it. Bound checkout creation before making a paid-provider API call
    # or adding an attempt row. The limits are deliberately generous for a
    # legitimate one-time purchase and use no raw address in SQLite.
    client_bucket = _client_rate_key(request)
    if not store.reserve(f"checkout:{client_bucket}", CHECKOUT_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if not store.reserve(f"checkout:{install_id}", CHECKOUT_PER_INSTALL):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if store.has_active_license(install_id):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "already_active"}, status_code=409), request)
    if not _stripe_ready():
        return apply_origin_headers(JSONResponse({"ok": False, "error": "stripe_not_configured"}, status_code=503), request)
    try:
        stripe.api_key = STRIPE_SECRET_KEY
        stripe.api_version = STRIPE_API_VERSION
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
            client_reference_id=install_id,
            metadata={"install_id": install_id},
            payment_intent_data={"metadata": {"install_id": install_id, "dablaja_purchase": "1"}},
            success_url=DABLAJA_PLUS_SUCCESS_URL,
            cancel_url=DABLAJA_PLUS_CANCEL_URL,
        )
    except stripe.error.StripeError:
        return apply_origin_headers(JSONResponse({"ok": False, "error": "checkout_failed"}, status_code=502), request)
    except Exception:
        return apply_origin_headers(JSONResponse({"ok": False, "error": "checkout_failed"}, status_code=502), request)
    url = _safe_stripe_checkout_url(_get(session, "url"))
    sid = _get(session, "id") or ""
    if not url or not sid:
        return apply_origin_headers(JSONResponse({"ok": False, "error": "checkout_failed"}, status_code=502), request)
    cred_hash = hashlib.sha256(credential.encode()).hexdigest()
    store.create_checkout_attempt(install_id, sid, cred_hash)
    return apply_origin_headers(JSONResponse({"ok": True, "url": url}), request)


async def dablaja_checkout(request: Request) -> Response:
    """GET checkout is retired: sessions are created only via POST /api/checkout
    from the allowed extension origin."""
    return JSONResponse({"ok": False, "error": "use_post_api_checkout"}, status_code=405)


async def dablaja_success(request: Request) -> Response:
    """Post-payment success page.

    Strictly verifies/reconciles the session (or loads the already-fulfilled
    purchase), then displays the plaintext recovery code EXACTLY ONCE.
    The code is never stored in plaintext and never appears in URLs beyond
    the Stripe-provided session_id; a re-visit explains it cannot be shown
    again and points at rotation via the extension's recovery flow.
    """
    qs = parse_qs(request.url.query)
    session_id = clean_text((qs.get("session_id") or [""])[0], 200).strip()
    if not session_id or not session_id.startswith("cs_"):
        return html_response(
            page_shell(
                "طلب غير صالح",
                '<div style="text-align:center; padding:40px 0;"><h1 style="color:#16324f;">طلب غير صالح</h1><p class="lead">معرّف الجلسة مفقود أو غير صالح.</p></div>',
                noindex=True,
            ),
            status=400,
        )

    outcome = strict_verify_and_activate(session_id)
    if not outcome.get("ok"):
        reason = outcome.get("reason")
        if reason == "stripe_error":
            return html_response(
                page_shell(
                    "تعذر التحقق من الدفع",
                    '<div style="text-align:center; padding:40px 0;"><h1 style="color:#16324f;">تعذر التحقق من الدفع</h1><p class="lead">تعذر الاتصال بـ Stripe حالياً. حدّث الصفحة بعد لحظات — لن تحتاج لإعادة الدفع.</p></div>',
                    noindex=True,
                ),
                status=502,
            )
        if reason == "not_paid":
            return html_response(
                page_shell(
                    "لم يكتمل الدفع",
                    '<div style="text-align:center; padding:40px 0;"><h1 style="color:#16324f;">لم يكتمل الدفع بعد</h1><p class="lead">لم تؤكد بوابة الدفع اكتمال العملية.</p></div>',
                    noindex=True,
                ),
                status=400,
            )
        return html_response(
            page_shell(
                "بيانات الدفع غير صالحة",
                '<div style="text-align:center; padding:40px 0;"><h1 style="color:#16324f;">بيانات الدفع غير صالحة</h1><p class="lead">تعذر التحقق من جلسة الدفع المطلوبة.</p></div>',
                noindex=True,
            ),
            status=400,
        )

    purchase_id = outcome.get("purchase_id")
    code = store.issue_recovery_code(purchase_id) if purchase_id else None
    if code:
        safe_code = html.escape(code)
        recovery_html = (
            '<div class="rc-box">'
            f'<strong>رمز الاسترداد</strong>'
            f'<code dir="ltr" style="display:block;font-size:18px;margin:8px 0;'
            f'letter-spacing:1px;">{safe_code}</code>'
            "<small>احفظه الآن — يُعرض مرة واحدة فقط. يُستخدم لتفعيل دبلجة Plus "
            "على أي جهاز جديد عبر نافذة التفعيل في الإضافة.</small>"
            "</div>"
        )
    else:
        recovery_html = (
            '<p style="color:#8b95a5;font-size:14px;max-width:440px;margin:0 auto 16px;">تم إصدار رمز الاسترداد '
            "مسبقاً ولا يمكن عرضه مجدداً. افتح الإضافة وفعّل عبر رمزك المحفوظ، "
            "أو يمكنك توليد رمز بديل من إعدادات Plus داخل الإضافة.</p>"
        )

    body = """
    <div style="text-align:center; padding:40px 0 12px;">
      <div style="font-size:64px; margin-bottom:16px;">✅</div>
      <h1 style="color:#16324f;">تم الدفع بنجاح!</h1>
      <p style="color:#8b95a5; font-size:16px; max-width:400px; margin:12px auto;">
        شكراً لشرائك دبلجة Plus.
      </p>
    </div>
    """ + recovery_html + """
    <div style="text-align:center;">
      <p style="color:#8b95a5; font-size:14px;">
        ستفعّل الإضافة تلقائياً خلال ثوانٍ. يمكنك إغلاق هذه الصفحة والعودة إلى الإضافة.
      </p>
    </div>
    <style>
      .rc-box { background:#fff; border:1px solid var(--line); border-radius:14px;
        padding:16px; max-width:420px; margin:0 auto 16px; text-align:center; }
      .rc-box strong { color:#16324f; }
    </style>
    """
    return html_response(page_shell("تم الدفع · دبلجة Plus", body, noindex=True))


async def license_status(request: Request):
    """Status-only endpoint. NEVER returns or stores an unsigned entitlement.
    Requires authentication via POST body { install_id, install_credential }."""
    gate = reject_origin(request)
    if gate:
        return gate
    if request.method == "GET":
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401), request
        )
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    install_id = clean_id(body.get("install_id") or body.get("iid") or "")
    credential = clean_text(body.get("install_credential") or body.get("installCredential") or "", 64).lower()
    if len(install_id) < 16 or len(credential) != 64:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401), request
        )
    client_bucket = _client_rate_key(request)
    if not store.reserve(f"status:{client_bucket}", VERIFY_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if not store.reserve(f"status:{install_id}", VERIFY_PER_INSTALL):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    authenticated_status, license_id = store.installation_credential_status(
        install_id, credential, token=body.get("token")
    )
    if not authenticated_status or not license_id:
        # Generic unauthorized: never leak whether the install is revoked,
        # absent, or legacy; the caller learns nothing about server-side
        # state from the error payload.
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401), request
        )
    return apply_origin_headers(JSONResponse({"ok": True, "status": authenticated_status}), request)


# ---------------------------------------------------------------------------
# License token signing (Ed25519)
#
# The VPS holds DABLAJA_LICENSE_SIGNING_KEY (Ed25519 seed, base64). Tokens are
# compact "dpl1.<payload>.<sig>" strings bound to an install_id and expiry.
# The extension embeds the matching PUBLIC key and verifies the signature
# locally — a forged { state: 'active' } blob is worthless without a valid
# signature, so Plus can no longer be unlocked by editing storage.
# ---------------------------------------------------------------------------

TOKEN_PREFIX = "dpl1"
TOKEN_TTL_DAYS = 30


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64u_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _signing_key():
    if not LICENSE_SIGNING_KEY_B64:
        return None
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        seed = _b64u_decode(LICENSE_SIGNING_KEY_B64)
        if len(seed) != 32:
            return None
        return Ed25519PrivateKey.from_private_bytes(seed)
    except Exception:
        return None


def sign_license_token(license_id: str, install_id: str) -> str | None:
    """Sign a compact license token. Returns None when the key isn't set."""
    key = _signing_key()
    if not key:
        return None
    payload = {
        "lid": license_id[:120],
        "iid": install_id[:80],
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_DAYS * 86400,
    }
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = key.sign(b"dpl1." + raw)
    return f"{TOKEN_PREFIX}.{_b64u(raw)}.{_b64u(sig)}"


def _verify_signed_license_token_inner(
    token: str, expected_install_id: str, expected_license_id: str | None, *, allow_ancient: bool
) -> bool:
    key = _signing_key()
    if not key:
        return False
    if not token or not isinstance(token, str) or not token.startswith("dpl1."):
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    try:
        raw = _b64u_decode(parts[1])
        sig = _b64u_decode(parts[2])
        if len(sig) != 64 or not raw or len(raw) > 1024:
            return False
        key.public_key().verify(sig, b"dpl1." + raw)
        payload = json.loads(raw.decode("utf-8"))
        lid = payload.get("lid") if isinstance(payload.get("lid"), str) else None
        iid = payload.get("iid") if isinstance(payload.get("iid"), str) else None
        if not lid or not lid.strip() or len(lid) > 120:
            return False
        if not iid or not iid.strip() or len(iid) > 80:
            return False
        if iid != expected_install_id:
            return False
        if expected_license_id and lid != expected_license_id:
            return False
        now = int(time.time())
        raw_iat = payload.get("iat")
        raw_exp = payload.get("exp")
        if not isinstance(raw_iat, (int, float)) or not isinstance(raw_exp, (int, float)):
            return False
        iat = int(raw_iat)
        exp = int(raw_exp)
        if iat > now + 300 or iat >= exp:
            return False
        if not allow_ancient and exp < now - (7 * 86400):
            return False
        return True
    except Exception:
        return False


def verify_signed_license_token(token: str, expected_install_id: str, expected_license_id: str | None = None) -> bool:
    """Normal verification: rejects tokens expired more than seven days (grace horizon)."""
    return _verify_signed_license_token_inner(token, expected_install_id, expected_license_id, allow_ancient=False)


async def license_token(request: Request) -> Response:
    """Issue an Ed25519 token ONLY when this exact installation credential is
    authenticated and bound to a non-revoked verified purchase in our database."""
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    install_id = clean_id(body.get("install_id") or "")
    credential = clean_text(body.get("install_credential") or body.get("installCredential") or "", 64).lower()
    if len(install_id) < 16 or len(credential) != 64:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401), request
        )
    client_bucket = _client_rate_key(request)
    if not store.reserve(f"token:{client_bucket}", VERIFY_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if not store.reserve(f"token:{install_id}", VERIFY_PER_INSTALL):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)

    authenticated, license_id = store.verify_installation_credential(
        install_id, credential, token=body.get("token")
    )
    if not authenticated or not license_id:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=403), request
        )

    token = sign_license_token(license_id, install_id)
    if not token:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "signing_not_configured"}, status_code=503), request
        )
    return apply_origin_headers(
        JSONResponse({"ok": True, "token": token, "licenseId": license_id}), request
    )


RECOVERY_CODE_RE = re.compile(r"^DABLAJA-[A-Z0-9]{20}$")


async def recover_license(request: Request) -> Response:
    """Recovery accepts ONLY a DABLAJA-XXXX recovery code and binds the new
    installation's high-entropy credential upon validation."""
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    install_id = clean_id(body.get("install_id") or "")
    code = clean_text(body.get("code") or "", 64).strip().upper()
    credential = clean_text(body.get("install_credential") or body.get("installCredential") or "", 64).lower()
    if len(install_id) < 16 or len(credential) != 64 or not re.match(r"^[0-9a-f]{64}$", credential):
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "invalid_request"}, status_code=400), request
        )
    client_bucket = _client_rate_key(request)
    if not store.reserve(f"recover:{client_bucket}", VERIFY_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if not store.reserve(f"recover:{install_id}", VERIFY_PER_INSTALL):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    generic_error = {"ok": False, "error": "recovery_failed"}
    if not RECOVERY_CODE_RE.match(code):
        return apply_origin_headers(JSONResponse(generic_error, status_code=403), request)
    cred_hash = hashlib.sha256(credential.encode()).hexdigest()
    license_id = store.recover_installation(code, install_id, credential_hash=cred_hash)
    if not license_id:
        # Recovery must not overwrite a different credential already bound to
        # the same install_id. Allow idempotent recovery with the same hash;
        # otherwise return a generic conflict and preserve the existing binding.
        existing = None
        with store._db() as conn:
            existing = conn.execute(
                "SELECT credential_hash FROM license_installations WHERE install_id = ? LIMIT 1",
                (install_id,),
            ).fetchone()
        if existing and existing["credential_hash"] and existing["credential_hash"] != cred_hash:
            generic_error = {"ok": False, "error": "conflict"}
        return apply_origin_headers(JSONResponse(generic_error, status_code=403), request)
    token = sign_license_token(license_id, install_id)
    if not token:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "signing_not_configured"}, status_code=503), request
        )
    return apply_origin_headers(
        JSONResponse({"ok": True, "token": token, "licenseId": license_id}), request
    )


async def rotate_recovery(request: Request) -> Response:
    """POST /dablaja/api/rotate-recovery — rotate recovery code for an authenticated active install."""
    gate = reject_origin(request)
    if gate:
        return gate
    body, err = await read_bounded_json(request)
    if err:
        return apply_origin_headers(err, request)
    install_id = clean_id(body.get("install_id") or "")
    credential = clean_text(body.get("install_credential") or body.get("installCredential") or "", 64).lower()
    if len(install_id) < 16 or len(credential) != 64:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401), request
        )
    client_bucket = _client_rate_key(request)
    if not store.reserve(f"rotate:{client_bucket}", VERIFY_DAILY_LIMIT):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    if not store.reserve(f"rotate:{install_id}", VERIFY_PER_INSTALL):
        return apply_origin_headers(JSONResponse({"ok": False, "error": "rate_limited"}, status_code=429), request)
    authenticated, license_id = store.verify_installation_credential(
        install_id, credential, token=body.get("token")
    )
    if not authenticated or not license_id:
        return apply_origin_headers(
            JSONResponse({"ok": False, "error": "unauthorized"}, status_code=403), request
        )
    code = store.rotate_recovery_code(license_id)
    return apply_origin_headers(
        JSONResponse({"ok": True, "code": code}), request
    )


def _get(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def strict_verify_and_activate(stripe_session_id: str) -> dict[str, Any]:
    """THE one payment verification function. Every activation path uses this.

    Rejects unless ALL of: payment_status=paid, mode=payment, exactly one
    line item, exact configured price/product, quantity=1, usd/1000,
    valid client_reference_id install, session+PaymentIntent metadata both
    matching, a checkout attempt created by THIS server for that install,
    and the session not already bound elsewhere. Metadata mismatch returns
    False — never a bare pass. Fulfillment is transactional/idempotent via
    store.fulfill_purchase.
    """
    if not _stripe_ready():
        return {"ok": False, "reason": "not_configured"}
    try:
        session = _stripe_retrieve_session(stripe_session_id)
    except stripe.error.StripeError:
        return {"ok": False, "reason": "stripe_error"}
    except Exception:
        return {"ok": False, "reason": "stripe_error"}

    if _get(session, "payment_status") != "paid":
        return {"ok": False, "reason": "not_paid"}
    if _get(session, "mode") != "payment":
        return {"ok": False, "reason": "wrong_mode"}

    install_id = clean_id(_get(session, "client_reference_id") or "")
    if len(install_id) < 16:
        return {"ok": False, "reason": "invalid_install"}

    session_meta = _get(session, "metadata") or {}
    if session_meta.get("install_id") != install_id:
        return {"ok": False, "reason": "metadata_mismatch"}

    payment_intent = _get(session, "payment_intent")
    if isinstance(payment_intent, dict):
        pi_id = payment_intent.get("id") or ""
        pi_meta = payment_intent.get("metadata") or {}
    else:
        pi_id = str(payment_intent or "")
        pi_meta = getattr(payment_intent, "metadata", None) or {}

    if pi_meta.get("install_id") != install_id:
        return {"ok": False, "reason": "metadata_mismatch"}
    if pi_meta.get("dablaja_purchase") != "1":
        return {"ok": False, "reason": "metadata_mismatch"}

    attempt = store.get_checkout_attempt(stripe_session_id)
    if not attempt or attempt.get("install_id") != install_id:
        return {"ok": False, "reason": "unknown_session"}

    line_items = _get(session, "line_items") or {}
    items = _get(line_items, "data") or []
    if len(items) != 1:
        return {"ok": False, "reason": "wrong_line_items"}
    item = items[0]
    price = _get(item, "price") or {}
    price_id = _get(price, "id") or ""
    product = _get(price, "product")
    product_id = _get(product, "id") or (str(product) if product else "")
    quantity = _get(item, "quantity")
    if price_id != STRIPE_PRICE_ID:
        return {"ok": False, "reason": "wrong_price"}
    if product_id != STRIPE_PRODUCT_ID:
        return {"ok": False, "reason": "wrong_product"}
    if quantity != 1:
        return {"ok": False, "reason": "wrong_quantity"}
    if _get(session, "currency") != EXPECTED_CURRENCY:
        return {"ok": False, "reason": "wrong_currency"}
    if _get(session, "amount_total") != EXPECTED_AMOUNT:
        return {"ok": False, "reason": "wrong_amount"}

    charge_id = _get(_get(payment_intent, "latest_charge"), "id") or (
        str(_get(payment_intent, "latest_charge") or "") or None
    )
    outcome = store.fulfill_purchase(
        stripe_session_id=stripe_session_id,
        payment_intent_id=pi_id,
        charge_id=charge_id or None,
        stripe_customer_id=_get(session, "customer") or "",
        price_id=price_id,
        product_id=product_id,
        amount_total=_get(session, "amount_total"),
        currency=_get(session, "currency"),
        install_id=install_id,
    )
    res = outcome.get("result")
    if res in ("activated", "already"):
        return {"ok": True, **outcome}
    return {"ok": False, "reason": res or "conflict", **outcome}


async def stripe_webhook(request: Request) -> Response:
    """Official-SDK webhook. Business rejections ack 200; transient failures
    return 500 so Stripe retries. Never logs bodies, emails, or identifiers."""
    raw_body = await request.body()
    if len(raw_body) > 65536:
        return Response("payload too large", status_code=413)
    sig_header = request.headers.get("stripe-signature", "")
    if not STRIPE_WEBHOOK_SECRET:
        return Response("not configured", status_code=503)
    if not STRIPE_AVAILABLE:
        return Response("not configured", status_code=503)
    try:
        event = stripe.Webhook.construct_event(raw_body, sig_header, STRIPE_WEBHOOK_SECRET)
    except ValueError:
        return Response("bad payload", status_code=400)
    except stripe.error.SignatureVerificationError:
        return Response("bad signature", status_code=400)

    event_type = _get(event, "type") or ""
    obj = _get(_get(event, "data") or {}, "object") or {}

    if event_type in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        session_id = _get(obj, "id") or ""
        outcome = strict_verify_and_activate(session_id)
        if outcome.get("reason") in ("stripe_error", "not_configured", "unknown_session"):
            # Transient: ask Stripe to retry.
            return Response("retry", status_code=500)
        return Response("ok", status_code=200)

    if event_type in ("checkout.session.async_payment_failed", "checkout.session.expired"):
        session_id = _get(obj, "id") or ""
        store.mark_purchase_failed(session_id)
        return Response("ok", status_code=200)

    if event_type == "refund.created":
        refund = obj
        charge_id = _get(refund, "charge")
        payment_intent_id = _get(refund, "payment_intent")
        if not payment_intent_id and charge_id:
            payment_intent_id = _stripe_payment_intent_for_charge(str(charge_id))
        if not charge_id and payment_intent_id is None:
            return Response("ok", status_code=200)
        # Product policy: any full or partial refund of the one-time purchase
        # revokes the associated lifetime license. This is disclosed in the
        # terms of use; the webhook reference match is independent of whether
        # Stripe includes a Charge object on this event.
        store.revoke_by_payment_reference(
            charge_id=str(charge_id) if charge_id else None,
            payment_intent_id=str(payment_intent_id) if payment_intent_id else None,
        )
        return Response("ok", status_code=200)

    if event_type == "charge.dispute.created":
        charge_id = _get(obj, "charge") or _get(obj, "id")
        if charge_id:
            store.revoke_by_charge_dispute(str(charge_id))
        return Response("ok", status_code=200)

    # Unsupported but validly signed event: acknowledge.
    return Response("ok", status_code=200)


async def public_stats(request: Request) -> Response:
    store.prune()
    response = JSONResponse(store.public_stats())
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
    return response


async def form_page(request: Request) -> Response:
    kind = "uninstall" if request.url.path.endswith("/uninstall") else "feedback"
    if request.method == "POST":
        return await submit_form(request, kind)
    qs = parse_qs(request.url.query)
    source = clean_text((qs.get("source") or [""])[0], 40)
    submission_id = str(uuid.uuid4())
    reasons = UNINSTALL_REASONS if kind == "uninstall" else FEEDBACK_REASONS
    title = "لماذا أزلت دبلجة؟" if kind == "uninstall" else "أرسل ملاحظة"
    lead = (
        "جواب قصير يساعدنا نصلح الأعطال. بعدها يمكنك تحويل صوت يوتيوب من AudioFetcher."
        if kind == "uninstall"
        else "قل لنا ما الذي تعطل أو ما الذي تريده بعد ذلك."
    )
    return html_form_response(
        page_shell(
            title,
            form_markup(kind, title, lead, reasons, submission_id, source),
            noindex=True,
        )
    )


async def submit_form(request: Request, kind: str) -> Response:
    body_bytes = await request.body()
    if len(body_bytes) > 16384:
        return html_form_response(page_shell("خطأ", "<p>الحجم أكبر من المسموح.</p>", noindex=True), 413)
    raw = body_bytes.decode("utf-8", "replace")
    form = parse_qs(raw, keep_blank_values=True)
    def field(name: str) -> str:
        return (form.get(name) or [""])[0]
    submission_id = clean_id(field("submission_id"))
    if len(submission_id) < 16:
        submission_id = str(uuid.uuid4())
    reason = clean_text(field("reason"), 80)
    message = clean_text(field("message"), 1200)
    email = clean_text(field("email"), 120)
    source = clean_text(field("source"), 40) or kind
    if not reason:
        return html_form_response(page_shell("اختر سبباً", "<p>اختر سبباً ثم أعد الإرسال.</p>", noindex=True), 400)
    if not store.reserve("feedback", FEEDBACK_DAILY_LIMIT):
        return html_form_response(page_shell("شكراً", "<p>الصندوق ممتلئ اليوم. حاول غداً.</p>", noindex=True))
    record = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "submission_id": submission_id,
        "source": source,
        "reason": reason,
        "message": message,
        "email": email,
        "user_agent": "",
        "created_at": utc_now(),
    }
    record["dedupe_key"] = hashlib.sha256(
        f"{kind}|{submission_id}".encode()
    ).hexdigest()
    store.add_feedback(record)
    thanks = (
        "<h1>شكراً</h1><p>وصلنا السبب. إذا احتجت الملف الصوتي من يوتيوب، AudioFetcher يحوّله إلى MP3.</p>"
        '<p><a class="btn" href="/">فتح AudioFetcher</a> <a class="ghost" href="/dablaja/">صفحة دبلجة</a></p>'
        if kind == "uninstall"
        else "<h1>وصلت ملاحظتك</h1><p>نقرأ كل رسالة. شكراً لوقتك.</p><p><a class='ghost' href='/dablaja/'>العودة</a></p>"
    )
    return html_form_response(page_shell("شكراً", thanks, noindex=True))


ADMIN_SESSION_COOKIE = "dablaja_admin"
ADMIN_SESSION_TTL_SECONDS = 60 * 30


def _admin_session_secret_configured() -> bool:
    return bool(ADMIN_TOKEN and ADMIN_SESSION_SECRET)


def _sign_admin_session(payload: str) -> str:
    mac = hmac.new(ADMIN_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def _verify_admin_session(cookie_value: str) -> bool:
    if not _admin_session_secret_configured() or not cookie_value:
        return False
    # cookie is "<exp>.<sig>" where sig = HMAC-SHA256(secret, "<exp>")
    if "." not in cookie_value:
        return False
    exp_str, sig = cookie_value.rsplit(".", 1)
    try:
        exp = int(exp_str)
    except ValueError:
        return False
    if exp < int(time.time()):
        return False
    expected = hmac.new(ADMIN_SESSION_SECRET.encode(), exp_str.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def _issue_admin_session_cookie() -> str:
    exp = str(int(time.time()) + ADMIN_SESSION_TTL_SECONDS)
    return _sign_admin_session(exp)


def _admin_session_cookie_header(cookie_value: str, *, max_age: int | None = None) -> str:
    # HttpOnly + SameSite=Strict + Path=/dablaja/admin; Secure in production.
    # HTTPX TestClient uses http://testserver and drops Secure cookies on
    # non-TLS origins, so we allow the test suite to suppress Secure via env.
    parts = [
        f"{ADMIN_SESSION_COOKIE}={cookie_value}",
        "Path=/dablaja/admin",
        "HttpOnly",
        "SameSite=Strict",
    ]
    if os.environ.get("DABLAJA_ALLOW_INSECURE_COOKIE") != "1":
        parts.append("Secure")
    if max_age is not None:
        parts.append(f"Max-Age={max_age}")
    else:
        parts.append(f"Max-Age={ADMIN_SESSION_TTL_SECONDS}")
    return "; ".join(parts)


def admin_ok(request: Request) -> bool:
    # Query-string tokens are no longer accepted — the admin token must never
    # appear in URLs, hrefs, page markup, history, referrers or logs. Only a
    # short-lived signed HttpOnly cookie issued after POST login is accepted.
    return _verify_admin_session(request.cookies.get(ADMIN_SESSION_COOKIE) or "")


def _admin_login_form(error: str = "") -> str:
    err = f'<p style="color:#c53030">{html.escape(error)}</p>' if error else ""
    return (
        '<h1>Admin login</h1>'
        + err
        + '<form method="post" action="/dablaja/admin">'
        + '<label>Admin token<input type="password" name="token" required autocomplete="current-password" /></label>'
        + '<button type="submit">Sign in</button>'
        + "</form>"
    )


async def admin_login(request: Request) -> Response:
    # POST-only login: constant-time secret verification, signed cookie on success.
    if not _admin_session_secret_configured():
        return html_form_response(
            page_shell("Admin", "<p>Admin is not configured.</p>", noindex=True), 503
        )
    if not store.reserve(f"admin-login:{_client_rate_key(request)}", ADMIN_LOGIN_DAILY_LIMIT):
        return html_form_response(
            page_shell("Admin", _admin_login_form("Sign-in is temporarily unavailable."), noindex=True), 429
        )
    # Accept form-encoded or JSON body — tests use JSON, the browser uses form.
    token = ""
    ctype = (request.headers.get("content-type") or "").lower()
    if "application/json" in ctype:
        body, _ = await read_bounded_json(request)
        if body is not None:
            token = str(body.get("token") or "")
    else:
        raw = await request.body()
        form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
        token = (form.get("token") or [""])[0]
    if not hmac.compare_digest(str(token), str(ADMIN_TOKEN)):
        return html_form_response(page_shell("Admin", _admin_login_form("Missing or invalid token."), noindex=True), 401)
    cookie_value = _issue_admin_session_cookie()
    resp = Response(status_code=303)
    resp.headers["Location"] = "/dablaja/admin?tab=errors"
    resp.headers["Set-Cookie"] = _admin_session_cookie_header(cookie_value)
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def admin_logout(request: Request) -> Response:
    resp = Response(status_code=303)
    resp.headers["Location"] = "/dablaja/admin"
    resp.headers["Set-Cookie"] = _admin_session_cookie_header("", max_age=0)
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def admin_page(request: Request) -> Response:
    if not _admin_session_secret_configured():
        return html_form_response(page_shell("Admin", "<p>Admin is not configured.</p>", noindex=True), 503)
    if not admin_ok(request):
        return html_form_response(page_shell("Admin", _admin_login_form(), noindex=True), 401)
    store.prune()
    tab = request.query_params.get("tab") or "errors"
    counts = store.counts()
    if tab == "uninstalls":
        rows = store.list_feedback("uninstall")
        body = feedback_table(rows)
    elif tab == "feedback":
        rows = store.list_feedback("feedback")
        body = feedback_table(rows)
    else:
        tab = "errors"
        rows = store.list_errors()
        body = error_table(rows)
    # Navigation never embeds the raw token — it is session-bound.
    nav = "".join(
        f'<a class="{"on" if tab == name else ""}" href="/dablaja/admin?tab={name}">{label} ({counts[key]})</a>'
        for name, label, key in (
            ("errors", "Errors", "errors"),
            ("uninstalls", "Uninstalls", "uninstalls"),
            ("feedback", "Feedback", "feedback"),
        )
    )
    logout_form = (
        '<form method="post" action="/dablaja/admin/logout" style="margin-top:16px">'
        '<button type="submit">Sign out</button></form>'
    )
    return html_form_response(
        page_shell(
            "Dablaja admin",
            f"<nav class='tabs'>{nav}</nav>{body}{logout_form}",
            noindex=True,
            wide=True,
        )
    )


def error_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "<div class='empty'>No errors yet.</div>"
    items = []
    for row in rows:
        items.append(
            "<article class='card'>"
            f"<strong>{html.escape(row['error_code'])}</strong>"
            f"<span>{html.escape(row['created_at'])} · v{html.escape(row['extension_version'] or '—')} · {html.escape(row['site_host'] or '—')}</span>"
            f"<small>event {html.escape(row['event_id'][:12])} · {html.escape(row['status'] or '—')} · reconnects {row['reconnect_count']}</small>"
            "</article>"
        )
    return "<div class='list'>" + "".join(items) + "</div>"


def feedback_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "<div class='empty'>No responses yet.</div>"
    items = []
    for row in rows:
        items.append(
            "<article class='card'>"
            f"<strong>{html.escape(row['reason'])}</strong>"
            f"<span>{html.escape(row['created_at'])} · {html.escape(row['source'] or '—')}</span>"
            f"<p>{html.escape(row['message'] or '—')}</p>"
            f"<small>submission {html.escape(row['submission_id'][:12])} · {html.escape(row['email'] or 'no email')}</small>"
            "</article>"
        )
    return "<div class='list'>" + "".join(items) + "</div>"


def form_markup(kind: str, title: str, lead: str, reasons: list[str], submission_id: str, source: str) -> str:
    radios = "".join(
        '<label class="choice"><input type="radio" name="reason" value="'
        + html.escape(reason)
        + '" required />'
        + html.escape(reason)
        + "</label>"
        for reason in reasons
    )
    extra = ""
    if kind == "uninstall":
        extra = (
            '<aside class="promo"><strong>تحتاج الملف الصوتي؟</strong>'
            "<span>AudioFetcher يحوّل يوتيوب إلى MP3 على نفس الموقع.</span>"
            '<a href="/">فتح المحوّل</a></aside>'
        )
    return f"""
    <h1>{html.escape(title)}</h1>
    <p class="lead">{html.escape(lead)}</p>
    {extra}
    <form method="post" action="/dablaja/{kind}">
      <input type="hidden" name="submission_id" value="{html.escape(submission_id)}" />
      <input type="hidden" name="source" value="{html.escape(source)}" />
      <fieldset class="chips" role="radiogroup" aria-label="السبب"><legend>السبب</legend>{radios}</fieldset>
      <label>التفاصيل (اختياري)<textarea name="message" placeholder="ماذا حصل؟"></textarea></label>
      <label>البريد (اختياري)<input name="email" type="email" placeholder="you@email.com" /></label>
      <button type="submit">إرسال</button>
      <small>لا رسائل تسويقية. البريد فقط إن احتجنا الرد.</small>
    </form>
    """


def page_shell(title: str, body: str, noindex: bool = False, wide: bool = False) -> str:
    robots = '<meta name="robots" content="noindex,nofollow" />' if noindex else ""
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  {robots}
  <title>{html.escape(title)} · دبلجة</title>
  <link rel="icon" href="/dablaja/icon.png" />
  <style>
    :root {{ color-scheme: light; --ink:#1a2744; --muted:#8b95a5; --teal:#2ad4c4; --navy:#16324f; --line:#edf1f6; }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; min-height:100vh; font:15px/1.6 "Segoe UI", Tahoma, Arial, sans-serif; color:var(--ink);
      background: radial-gradient(40% 30% at 8% 0, #d9f7f1, transparent 70%), #f3f7fb; }}
    main {{ width:min({"980px" if wide else "560px"}, calc(100vw - 32px)); margin:0 auto; padding:28px 0 48px; }}
    h1 {{ margin:0 0 8px; font-size:28px; }}
    .lead, .muted {{ color:var(--muted); }}
    form, .card, .promo {{ background:#fff; border:1px solid var(--line); border-radius:18px; padding:16px; }}
    form {{ display:grid; gap:12px; }}
    label {{ display:grid; gap:6px; font-size:13px; font-weight:700; }}
    textarea, input {{ width:100%; border:1px solid var(--line); border-radius:10px; padding:10px; font:inherit; }}
    textarea {{ min-height:110px; }}
    .chips {{ display:flex; flex-wrap:wrap; gap:8px; }}
    .choice, button[type=submit], .btn {{ border:1px solid var(--line); border-radius:999px; background:#fff; padding:8px 12px; font:inherit; cursor:pointer; }}
    .choice.on {{ border-color:var(--teal); background:#e7faf6; }}
    button[type=submit], .btn {{ background:var(--navy); color:#fff; border:0; font-weight:800; }}
    .ghost {{ color:var(--navy); }}
    .promo {{ display:grid; gap:6px; margin:0 0 16px; }}
    .promo a {{ color:#0d6f68; font-weight:800; }}
    nav.tabs {{ display:flex; gap:8px; flex-wrap:wrap; margin:16px 0; }}
    nav.tabs a {{ padding:6px 10px; border-radius:999px; background:#fff; border:1px solid var(--line); text-decoration:none; color:var(--navy); }}
    nav.tabs a.on {{ background:var(--navy); color:#fff; }}
    .list {{ display:grid; gap:10px; }}
    .card {{ display:grid; gap:4px; }}
    .card span, .card small {{ color:var(--muted); font-size:12px; }}
    .empty {{ color:var(--muted); }}
  </style>
</head>
<body><main>{body}</main></body>
</html>"""


SENSITIVE_CSP = (
    "default-src 'none'; "
    "script-src 'none'; "
    "style-src 'unsafe-inline'; "
    "img-src 'self' data:; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'none'"
)

FORM_CSP = (
    "default-src 'none'; "
    "script-src 'none'; "
    "style-src 'unsafe-inline'; "
    "img-src 'self' data:; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)


def html_response(content: str, status: int = 200, *, csp: str = SENSITIVE_CSP) -> Response:
    headers = {
        "Cache-Control": "no-store, private, max-age=0",
        "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": csp,
    }
    return Response(content, status_code=status, media_type="text/html; charset=utf-8", headers=headers)


def html_form_response(content: str, status: int = 200) -> Response:
    return html_response(content, status=status, csp=FORM_CSP)


def dablaja_routes() -> list[Route]:
    return [
        Route("/dablaja/api/errors", report_error, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/usage", report_usage, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/stats", public_stats, methods=["GET"]),
        Route("/dablaja/api/license-status", license_status, methods=["GET", "POST", "OPTIONS"]),
        Route("/dablaja/api/recover-license", recover_license, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/rotate-recovery", rotate_recovery, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/license-token", license_token, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/checkout", dablaja_api_checkout, methods=["POST", "OPTIONS"]),
        Route("/dablaja/success", dablaja_success, methods=["GET"]),
        Route("/dablaja/webhook", stripe_webhook, methods=["POST"]),
        Route("/dablaja/uninstall", form_page, methods=["GET", "POST"]),
        Route("/dablaja/feedback", form_page, methods=["GET", "POST"]),
        Route("/dablaja/admin", admin_page, methods=["GET"]),
        Route("/dablaja/admin", admin_login, methods=["POST"]),
        Route("/dablaja/admin/logout", admin_logout, methods=["POST"]),
    ]
