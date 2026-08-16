"""Isolated Dablaja telemetry, feedback, uninstall, and admin.

Does not touch the YouTube conversion queue database.
"""
from __future__ import annotations

import hashlib
import html
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs

from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

DATA = Path(os.environ.get("YTMP3_DATA", "/var/ytmp3"))
DB_PATH = Path(os.environ.get("DABLAJA_DB", str(DATA / "dablaja.db")))
ADMIN_TOKEN = os.environ.get("DABLAJA_ADMIN_TOKEN", "").strip()
ERROR_RETENTION_DAYS = 45
FEEDBACK_RETENTION_DAYS = 180
ERROR_DAILY_LIMIT = 400
FEEDBACK_DAILY_LIMIT = 80
ERROR_PER_INSTALL = 30
USAGE_DAILY_LIMIT = 10_000
USAGE_EVENT_RETENTION_DAYS = 8
USAGE_PLATFORMS = {"youtube", "x", "twitch", "other"}
SECRET_RE = re.compile(r"(AIza[0-9A-Za-z_\-]{10,}|geminiApiKey|sk-[A-Za-z0-9]{10,})", re.I)
HOST_RE = re.compile(r"^[a-z0-9.-]{1,80}$")
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


def clean_host(value: Any) -> str:
    host = str(value or "").strip().lower().replace("www.", "")
    if host.startswith("http"):
        try:
            from urllib.parse import urlparse
            host = (urlparse(host).hostname or "").replace("www.", "")
        except Exception:
            host = ""
    return host[:80] if HOST_RE.match(host or "") else ""


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
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS error_reports (
                  id TEXT PRIMARY KEY,
                  dedupe_key TEXT NOT NULL UNIQUE,
                  install_id TEXT NOT NULL,
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
                  install_id TEXT NOT NULL,
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
                """
            )

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
                  id, dedupe_key, install_id, error_code, error_message, status,
                  site_host, extension_version, reconnect_count, user_agent, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["dedupe_key"],
                    record["install_id"],
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
                  id, dedupe_key, kind, install_id, source, reason, message,
                  email, user_agent, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["dedupe_key"],
                    record["kind"],
                    record["install_id"],
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
                "DELETE FROM error_reports WHERE created_at < datetime('now', ?)",
                (f"-{ERROR_RETENTION_DAYS} days",),
            )
            conn.execute(
                "DELETE FROM feedback_reports WHERE created_at < datetime('now', ?)",
                (f"-{FEEDBACK_RETENTION_DAYS} days",),
            )
            conn.execute(
                "DELETE FROM usage_event_ids WHERE created_at < datetime('now', ?)",
                (f"-{USAGE_EVENT_RETENTION_DAYS} days",),
            )
            conn.execute("DELETE FROM daily_budget WHERE day < date('now', '-8 days')")


store = DablajaStore(DB_PATH)


def cors(response: Response) -> Response:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Cache-Control"] = "no-store"
    return response


async def report_error(request: Request) -> Response:
    if request.method == "OPTIONS":
        return cors(Response(status_code=204))
    try:
        body = await request.json()
    except Exception:
        return cors(JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400))

    install_id = clean_id(body.get("install_id"))
    if len(install_id) < 8:
        return cors(JSONResponse({"ok": False, "error": "bad_install"}, status_code=400))
    if not store.reserve("errors", ERROR_DAILY_LIMIT):
        return cors(JSONResponse({"ok": True, "status": "budget"}))
    if not store.reserve(f"errors:{install_id}", ERROR_PER_INSTALL):
        return cors(JSONResponse({"ok": True, "status": "budget"}))

    record = {
        "id": str(uuid.uuid4()),
        "install_id": install_id,
        "error_code": clean_text(body.get("error_code") or "unknown", 80),
        "error_message": clean_text(body.get("error_message"), 400),
        "status": clean_text(body.get("status"), 40),
        "site_host": clean_host(body.get("site_host") or body.get("site")),
        "extension_version": clean_text(body.get("extension_version"), 20),
        "reconnect_count": max(0, min(99, int(body.get("reconnect_count") or 0))),
        "user_agent": "",
        "created_at": utc_now(),
    }
    hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
    record["dedupe_key"] = hashlib.sha256(
        f"{install_id}|{record['error_code']}|{record['site_host']}|{hour}".encode()
    ).hexdigest()
    status = store.add_error(record)
    return cors(JSONResponse({"ok": True, "status": status}))


async def report_usage(request: Request) -> Response:
    origin = request.headers.get("origin", "").strip().lower()
    if not EXTENSION_ORIGIN_RE.match(origin):
        return JSONResponse({"ok": False, "error": "extension_only"}, status_code=403)
    if request.method == "OPTIONS":
        response = Response(status_code=204)
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Vary"] = "Origin"
        return response
    try:
        body = await request.json()
    except Exception:
        return cors(JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400))

    event_id = clean_id(body.get("event_id"))
    platform = clean_text(body.get("platform"), 16).lower()
    try:
        dubbed_ms = int(body.get("dubbed_ms") or 0)
    except (TypeError, ValueError):
        dubbed_ms = 0
    dubbed_ms = max(0, min(8 * 60 * 60 * 1000, dubbed_ms))
    if len(event_id) < 16 or platform not in USAGE_PLATFORMS or dubbed_ms < 1000:
        return cors(JSONResponse({"ok": False, "error": "invalid_event"}, status_code=400))
    if not store.reserve("usage", USAGE_DAILY_LIMIT):
        return cors(JSONResponse({"ok": True, "status": "budget"}))
    status = store.add_usage(event_id, platform, dubbed_ms)
    response = JSONResponse({"ok": True, "status": status})
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Vary"] = "Origin"
    response.headers["Cache-Control"] = "no-store"
    return response


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
    install_id = clean_id((qs.get("install_id") or [""])[0])
    source = clean_text((qs.get("source") or [""])[0], 40)
    reasons = UNINSTALL_REASONS if kind == "uninstall" else FEEDBACK_REASONS
    title = "لماذا أزلت دبلجة؟" if kind == "uninstall" else "أرسل ملاحظة"
    lead = (
        "جواب قصير يساعدنا نصلح الأعطال. بعدها يمكنك تحويل صوت يوتيوب من AudioFetcher."
        if kind == "uninstall"
        else "قل لنا ما الذي تعطل أو ما الذي تريده بعد ذلك."
    )
    return html_response(
        page_shell(
            title,
            form_markup(kind, title, lead, reasons, install_id, source),
            noindex=True,
        )
    )


async def submit_form(request: Request, kind: str) -> Response:
    raw = (await request.body()).decode("utf-8", "replace")
    form = parse_qs(raw, keep_blank_values=True)
    def field(name: str) -> str:
        return (form.get(name) or [""])[0]
    install_id = clean_id(field("install_id")) or "anonymous"
    reason = clean_text(field("reason"), 80)
    message = clean_text(field("message"), 1200)
    email = clean_text(field("email"), 120)
    source = clean_text(field("source"), 40) or kind
    if not reason:
        return html_response(page_shell("اختر سبباً", "<p>اختر سبباً ثم أعد الإرسال.</p>", noindex=True), 400)
    if not store.reserve("feedback", FEEDBACK_DAILY_LIMIT):
        return html_response(page_shell("شكراً", "<p>الصندوق ممتلئ اليوم. حاول غداً.</p>", noindex=True))
    record = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "install_id": install_id,
        "source": source,
        "reason": reason,
        "message": message,
        "email": email,
        "user_agent": clean_text(request.headers.get("user-agent"), 180),
        "created_at": utc_now(),
    }
    record["dedupe_key"] = hashlib.sha256(
        f"{kind}|{install_id}|{reason}|{message[:80]}|{utc_day()}".encode()
    ).hexdigest()
    store.add_feedback(record)
    thanks = (
        "<h1>شكراً</h1><p>وصلنا السبب. إذا احتجت الملف الصوتي من يوتيوب، AudioFetcher يحوّله إلى MP3.</p>"
        '<p><a class="btn" href="/">فتح AudioFetcher</a> <a class="ghost" href="/dablaja/">صفحة دبلجة</a></p>'
        if kind == "uninstall"
        else "<h1>وصلت ملاحظتك</h1><p>نقرأ كل رسالة. شكراً لوقتك.</p><p><a class='ghost' href='/dablaja/'>العودة</a></p>"
    )
    return html_response(page_shell("شكراً", thanks, noindex=True))


def admin_ok(request: Request) -> bool:
    if not ADMIN_TOKEN:
        return False
    token = request.query_params.get("token") or request.headers.get("x-dablaja-token") or ""
    return token == ADMIN_TOKEN


async def admin_page(request: Request) -> Response:
    if not ADMIN_TOKEN:
        return html_response(page_shell("Admin", "<p>DABLAJA_ADMIN_TOKEN is not set.</p>", noindex=True), 503)
    if not admin_ok(request):
        return html_response(page_shell("Admin", "<p>Missing or invalid token.</p>", noindex=True), 401)
    store.prune()
    token = html.escape(request.query_params.get("token") or "")
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
    nav = "".join(
        f'<a class="{"on" if tab == name else ""}" href="/dablaja/admin?tab={name}&token={token}">{label} ({counts[key]})</a>'
        for name, label, key in (
            ("errors", "Errors", "errors"),
            ("uninstalls", "Uninstalls", "uninstalls"),
            ("feedback", "Feedback", "feedback"),
        )
    )
    return html_response(
        page_shell(
            "Dablaja admin",
            f"<p class='muted'>Private. Bookmark this URL. Noindex.</p><nav class='tabs'>{nav}</nav>{body}",
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
            f"<p>{html.escape(row['error_message'] or '—')}</p>"
            f"<small>install {html.escape(row['install_id'][:12])} · {html.escape(row['status'] or '—')} · reconnects {row['reconnect_count']}</small>"
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
            f"<small>install {html.escape(row['install_id'][:12])} · {html.escape(row['email'] or 'no email')}</small>"
            "</article>"
        )
    return "<div class='list'>" + "".join(items) + "</div>"


def form_markup(kind: str, title: str, lead: str, reasons: list[str], install_id: str, source: str) -> str:
    chips = "".join(
        f'<button class="choice" type="button" data-value="{html.escape(reason)}">{html.escape(reason)}</button>'
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
      <input type="hidden" name="install_id" value="{html.escape(install_id)}" />
      <input type="hidden" name="source" value="{html.escape(source)}" />
      <input type="hidden" name="reason" id="reason" value="" />
      <label>السبب<div class="chips">{chips}</div></label>
      <label>التفاصيل (اختياري)<textarea name="message" placeholder="ماذا حصل؟"></textarea></label>
      <label>البريد (اختياري)<input name="email" type="email" placeholder="you@email.com" /></label>
      <button type="submit">إرسال</button>
      <small>لا رسائل تسويقية. البريد فقط إن احتجنا الرد.</small>
    </form>
    <script>
      document.addEventListener("click", function(e) {{
        var b = e.target.closest(".choice");
        if (!b) return;
        document.querySelectorAll(".choice").forEach(function(el) {{ el.classList.remove("on"); }});
        b.classList.add("on");
        document.getElementById("reason").value = b.getAttribute("data-value") || "";
      }});
    </script>
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


def html_response(content: str, status: int = 200) -> Response:
    return Response(content, status_code=status, media_type="text/html; charset=utf-8")


def dablaja_routes() -> list[Route]:
    return [
        Route("/dablaja/api/errors", report_error, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/usage", report_usage, methods=["POST", "OPTIONS"]),
        Route("/dablaja/api/stats", public_stats, methods=["GET"]),
        Route("/dablaja/uninstall", form_page, methods=["GET", "POST"]),
        Route("/dablaja/feedback", form_page, methods=["GET", "POST"]),
        Route("/dablaja/admin", admin_page, methods=["GET"]),
    ]
