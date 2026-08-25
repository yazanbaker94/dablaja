"""Security-critical payment/license route tests.

Covers: strict fulfillment matrix, webhook signature/event handling, origin
gating with zero-side-effect rejections, recovery codes (hash-only storage,
stable license IDs, rotation), refund/dispute revocation, and the four
adversarial checks from the security review. Uses Starlette TestClient with
the Stripe SDK mocked at the module boundary — no network, no live keys.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

os.environ.setdefault("DABLAJA_DB", str(Path(tempfile.gettempdir()) / "unused-dablaja-test.db"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from unittest.mock import patch

from starlette.applications import Starlette
from starlette.testclient import TestClient

import dablaja


ALLOWED_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
GOOD_INSTALL = "i" * 24
GOOD_CREDENTIAL = "a" * 64
OTHER_CREDENTIAL = "b" * 64


def make_app(store):
    dablaja.store = store
    app = Starlette()
    app.router.routes.extend(dablaja.dablaja_routes())
    return app


class PaymentTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = dablaja.DablajaStore(Path(self.tmp.name) / "dablaja.db")
        self.client = TestClient(make_app(self.store))
        self._origins = dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS
        dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS = [ALLOWED_ORIGIN]
        self._key_before = dablaja.STRIPE_SECRET_KEY
        dablaja.STRIPE_SECRET_KEY = "sk_test_local_only_placeholder"
        self._wh_before = dablaja.STRIPE_WEBHOOK_SECRET
        dablaja.STRIPE_WEBHOOK_SECRET = "whsec_test"
        # Local throwaway signing key so token issuance is exercisable without
        # any production secret.
        import base64 as _b64
        self._signing_before = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(os.urandom(32)).decode()

    def tearDown(self):
        dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS = self._origins
        dablaja.STRIPE_SECRET_KEY = self._key_before
        dablaja.STRIPE_WEBHOOK_SECRET = self._wh_before
        dablaja.LICENSE_SIGNING_KEY_B64 = self._signing_before
        self.tmp.cleanup()


def fake_session(**overrides):
    """A Stripe Checkout Session payload that passes every strict check."""
    install = overrides.get("install_id", GOOD_INSTALL)
    sid = overrides.get("session", "cs_default")
    session = {
        "id": sid,
        "object": "checkout.session",
        "payment_status": "paid",
        "status": "complete",
        "mode": "payment",
        "currency": "usd",
        "amount_total": 1000,
        "customer": "cus_test123",
        "client_reference_id": install,
        "metadata": {"install_id": install},
        "line_items": {
            "data": [
                {
                    "quantity": 1,
                    "price": {
                        "id": dablaja.STRIPE_PRICE_ID,
                        "product": {"id": dablaja.STRIPE_PRODUCT_ID},
                    },
                }
            ]
        },
        "payment_intent": {
            "id": "pi_" + hashlib.sha1(sid.encode()).hexdigest()[:16],
            "latest_charge": "ch_" + hashlib.sha1((sid + "ch").encode()).hexdigest()[:16],
            "metadata": {"install_id": install, "dablaja_purchase": "1"},
        },
    }
    for key, value in overrides.get("patch", {}).items():
        session[key] = value
    return session


class UsageStoreTests(unittest.TestCase):
    def test_usage_is_deduplicated_and_aggregated_without_page_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = dablaja.DablajaStore(Path(directory) / "dablaja.db")
            self.assertEqual(store.add_usage("event-1234567890123456", "youtube", 3_600_000), "ok")
            self.assertEqual(store.add_usage("event-1234567890123456", "youtube", 3_600_000), "duplicate")
            self.assertEqual(store.add_usage("event-abcdefghijklmnop", "other", 1_800_000), "ok")

            stats = store.public_stats()
            self.assertEqual(stats["total_hours"], 1.5)
            self.assertEqual(stats["total_sessions"], 2)

            with store._db() as connection:
                columns = {
                    row[1]
                    for table in ("usage_event_ids", "usage_daily")
                    for row in connection.execute(f"PRAGMA table_info({table})")
                }
            self.assertFalse({"url", "title", "audio", "transcript", "api_key"} & columns)

    def test_client_rate_key_is_day_scoped_hmac_and_never_raw_address(self):
        class Client:
            host = "127.0.0.1"

        class RequestStub:
            client = Client()
            headers = {"x-forwarded-for": "203.0.113.77"}

        with patch.object(dablaja, "RATE_LIMIT_SECRET", "test-rate-limit-secret"):
            first = dablaja._client_rate_key(RequestStub())
            second = dablaja._client_rate_key(RequestStub())

        self.assertEqual(first, second)
        self.assertRegex(first, r"^[0-9a-f]{32}$")
        self.assertNotIn("203.0.113.77", first)


# ---- Checkout endpoint -------------------------------------------------------

class CheckoutTests(PaymentTestBase):
    def post_checkout(self, install=GOOD_INSTALL, credential=GOOD_CREDENTIAL, origin=ALLOWED_ORIGIN, body=None):
        headers = {"Origin": origin} if origin else {}
        payload = body if body is not None else {"install_id": install, "install_credential": credential}
        return self.client.post("/dablaja/api/checkout", json=payload, headers=headers)

    def test_allowed_origin_creates_session_and_checkout_attempt(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            create.return_value = {"id": "cs_new_123", "url": "https://checkout.stripe.com/c/pay/cs_new_123"}
            resp = self.post_checkout()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertEqual(create.call_count, 1)
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["client_reference_id"], GOOD_INSTALL)
        self.assertEqual(kwargs["metadata"]["install_id"], GOOD_INSTALL)
        self.assertEqual(kwargs["payment_intent_data"]["metadata"]["dablaja_purchase"], "1")
        attempt = self.store.get_checkout_attempt("cs_new_123")
        self.assertIsNotNone(attempt)
        self.assertEqual(attempt["install_id"], GOOD_INSTALL)

    def test_non_stripe_checkout_url_is_rejected_without_attempt_row(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            create.return_value = {"id": "cs_bad_url", "url": "https://checkout.stripe.com.evil.example/c/pay/cs_bad_url"}
            resp = self.post_checkout()
        self.assertEqual(resp.status_code, 502)
        self.assertEqual(resp.json()["error"], "checkout_failed")
        self.assertIsNone(self.store.get_checkout_attempt("cs_bad_url"))

    def test_disallowed_origin_zero_stripe_calls_and_writes(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.post_checkout(origin="chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(create.call_count, 0, "disallowed origin must not reach Stripe")
        self.assertIsNone(self.store.get_checkout_attempt("cs_anything"))

    def test_missing_origin_rejected(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.client.post("/dablaja/api/checkout", json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL})
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(create.call_count, 0)

    def test_invalid_json_rejected_before_side_effects(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.client.post(
                "/dablaja/api/checkout",
                content=b"{not json",
                headers={"Origin": ALLOWED_ORIGIN, "Content-Type": "application/json"},
            )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(create.call_count, 0)

    def test_oversized_json_rejected(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.post_checkout(body={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL, "junk": "x" * 20000})
        self.assertEqual(resp.status_code, 413)
        self.assertEqual(create.call_count, 0)

    def test_invalid_install_rejected(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.post_checkout(install="short")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(create.call_count, 0)

    def test_checkout_rate_limit_blocks_before_stripe_side_effect(self):
        for _ in range(dablaja.CHECKOUT_PER_INSTALL):
            self.store.reserve(f"checkout:{GOOD_INSTALL}", dablaja.CHECKOUT_PER_INSTALL)
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            resp = self.post_checkout()
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(create.call_count, 0)

    def test_options_follows_same_allowlist(self):
        ok = self.client.options("/dablaja/api/checkout", headers={"Origin": ALLOWED_ORIGIN})
        bad = self.client.options("/dablaja/api/checkout", headers={"Origin": "https://evil.example"})
        self.assertEqual(ok.status_code, 204)
        self.assertEqual(bad.status_code, 403)

    def test_no_wildcard_header_on_privileged_endpoints(self):
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            create.return_value = {"id": "cs_hdr", "url": "https://checkout.stripe.com/c/pay/cs_hdr"}
            resp = self.post_checkout()
        self.assertNotEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")
        status = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertNotEqual(status.headers.get("Access-Control-Allow-Origin"), "*")
        token = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertNotEqual(token.headers.get("Access-Control-Allow-Origin"), "*")

    def test_license_status_never_returns_entitlement_record(self):
        s = fake_session(session="cs_stat_rec")
        cred_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            dablaja.strict_verify_and_activate(s["id"])
        resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("license", resp.json())


# ---- Strict fulfillment -------------------------------------------------------

class FulfillmentTests(PaymentTestBase):
    def activate(self, session_payload):
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=session_payload):
            return dablaja.strict_verify_and_activate(session_payload["id"])

    def make_paid(self, **patch_fields):
        s = fake_session(patch=patch_fields)
        self.store.create_checkout_attempt(s["client_reference_id"], s["id"])
        return s

    def test_exact_purchase_activates_once(self):
        s = fake_session(session="cs_ok_1")
        s["payment_intent"] = {**s["payment_intent"], "id": "pi_ok_1"}
        self.store.create_checkout_attempt(GOOD_INSTALL, "cs_ok_1")
        out = self.activate(s)
        self.assertTrue(out["ok"])
        self.assertEqual(out["result"], "activated")
        out2 = self.activate(s)
        self.assertEqual(out2["result"], "already")
        purchase = self.store.get_purchase_by_session("cs_ok_1")
        self.assertIsNotNone(purchase)
        self.assertEqual(purchase["payment_intent_id"], "pi_ok_1")

    def test_completed_but_unpaid_rejected(self):
        s = self.make_paid(payment_status="unpaid")
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_mismatched_client_reference_id_rejected(self):
        s = self.make_paid(client_reference_id="attacker-install-12345678")
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_two_line_items_rejected(self):
        s = self.make_paid()
        s["line_items"]["data"].append(dict(s["line_items"]["data"][0]))
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_wrong_amount_rejected(self):
        s = self.make_paid(amount_total=100)
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_wrong_currency_rejected(self):
        s = self.make_paid(currency="eur")
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_wrong_price_id_rejected(self):
        s = self.make_paid()
        s["line_items"]["data"][0]["price"]["id"] = "price_evil"
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_wrong_product_id_rejected(self):
        s = self.make_paid()
        s["line_items"]["data"][0]["price"]["product"]["id"] = "prod_evil"
        out = self.activate(s)
        self.assertFalse(out["ok"])

    def test_cross_session_reuse_rejected_as_conflict(self):
        s1 = fake_session(session="cs_user_a", install_id="install_user_a_00000000")
        self.store.create_checkout_attempt(s1["client_reference_id"], s1["id"])
        out1 = self.activate(s1)
        self.assertTrue(out1["ok"])

        # Same stripe session id presented for a different installation
        s2 = dict(s1)
        s2["client_reference_id"] = "install_user_b_00000000"
        s2["metadata"] = {"install_id": s2["client_reference_id"]}
        s2["payment_intent"] = dict(s1["payment_intent"])
        s2["payment_intent"]["metadata"] = {"install_id": s2["client_reference_id"], "dablaja_purchase": "1"}
        self.store.create_checkout_attempt(s2["client_reference_id"], s2["id"])
        out2 = self.activate(s2)
        self.assertFalse(out2["ok"])
        self.assertEqual(out2["reason"], "conflict")


# ---- Webhook handler ----------------------------------------------------------

class WebhookTests(PaymentTestBase):
    def post_event(self, event, sig=None):
        payload = json.dumps(event).encode()
        if sig is None:
            t = int(time.time())
            import hmac
            mac = hmac.new(dablaja.STRIPE_WEBHOOK_SECRET.encode(), f"{t}.".encode() + payload, "sha256").hexdigest()
            sig = f"t={t},v1={mac}"
        return self.client.post(
            "/dablaja/webhook",
            content=payload,
            headers={"Stripe-Signature": sig, "Content-Type": "application/json"},
        )

    def test_missing_signature_returns_400(self):
        resp = self.client.post("/dablaja/webhook", content=b"{}")
        self.assertEqual(resp.status_code, 400)

    def test_bad_signature_returns_400(self):
        event = {"type": "checkout.session.completed", "data": {"object": {"id": "cs_x"}}}
        resp = self.post_event(event, sig="t=1,v1=deadbeef")
        self.assertEqual(resp.status_code, 400)

    def test_async_success_activates(self):
        event = {"type": "checkout.session.async_payment_succeeded", "data": {"object": {"id": "cs_wh_2"}}}
        with patch.object(dablaja, "strict_verify_and_activate", return_value={"ok": True}) as sv:
            resp = self.post_event(event)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(sv.call_count, 1)

    def test_async_failure_marks_failed(self):
        event = {"type": "checkout.session.async_payment_failed", "data": {"object": {"id": "cs_fail_1"}}}
        resp = self.post_event(event)
        self.assertEqual(resp.status_code, 200)

    def test_expired_checkout_marks_attempt_failed(self):
        self.store.create_checkout_attempt(GOOD_INSTALL, "cs_expired_1", hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest())
        event = {"type": "checkout.session.expired", "data": {"object": {"id": "cs_expired_1"}}}
        resp = self.post_event(event)
        self.assertEqual(resp.status_code, 200)
        attempt = self.store.get_checkout_attempt("cs_expired_1")
        self.assertEqual(attempt["status"], "failed")

    def test_transient_processing_failure_returns_500(self):
        event = {"type": "checkout.session.completed", "data": {"object": {"id": "cs_err"}}}
        with patch.object(dablaja, "strict_verify_and_activate", return_value={"ok": False, "reason": "stripe_error"}):
            resp = self.post_event(event)
        self.assertEqual(resp.status_code, 500)

    def test_unsupported_event_returns_200(self):
        resp = self.post_event({"type": "invoice.paid", "data": {"object": {}}})
        self.assertEqual(resp.status_code, 200)

    def test_missing_secret_returns_503(self):
        dablaja.STRIPE_WEBHOOK_SECRET = ""
        try:
            resp = self.client.post("/dablaja/webhook", content=b"{}", headers={"Stripe-Signature": "t=1,v1=x"})
            self.assertEqual(resp.status_code, 503)
        finally:
            dablaja.STRIPE_WEBHOOK_SECRET = "whsec_test"

    def test_unknown_checkout_attempt_requests_retry_for_create_db_race(self):
        event = {"type": "checkout.session.completed", "data": {"object": {"id": "cs_no_attempt"}}}
        with patch.object(dablaja, "strict_verify_and_activate", return_value={"ok": False, "reason": "unknown_session"}):
            resp = self.post_event(event)
        self.assertEqual(resp.status_code, 500)

    def test_refund_with_payment_intent_and_no_charge_revokes_purchase(self):
        session = fake_session(session="cs_refund_pi_only")
        session["payment_intent"] = {
            **session["payment_intent"],
            "id": "pi_refund_pi_only",
            "latest_charge": "ch_refund_pi_only",
        }
        credential_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, session["id"], credential_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=session):
            activated = dablaja.strict_verify_and_activate(session["id"])
        self.assertTrue(activated["ok"])
        self.assertTrue(self.store.has_active_license(GOOD_INSTALL))

        event = {
            "type": "refund.created",
            "data": {
                "object": {
                    "id": "re_pi_only",
                    "payment_intent": "pi_refund_pi_only",
                    "charge": None,
                    "amount": 1000,
                }
            },
        }
        response = self.post_event(event)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.store.has_active_license(GOOD_INSTALL))


# ---- Recovery codes -------------------------------------------------------------

class RecoveryTests(PaymentTestBase):
    def provision(self, suffix="a", install=GOOD_INSTALL, cred=GOOD_CREDENTIAL):
        s = fake_session(session=f"cs_rec_{suffix}")
        s["payment_intent"] = {**s["payment_intent"], "id": f"pi_rec_{suffix}", "latest_charge": f"ch_rec_{suffix}"}
        cred_hash = hashlib.sha256(cred.encode()).hexdigest()
        self.store.create_checkout_attempt(install, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertTrue(out["ok"])
        return out["purchase_id"]

    def test_code_stored_only_as_hash(self):
        pid = self.provision()
        code = self.store.rotate_recovery_code(pid)
        self.assertTrue(code.startswith("DABLAJA-"))
        with self.store._db() as conn:
            rows = conn.execute(
                "SELECT code_hash FROM recovery_codes WHERE license_id=?", (pid,)
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["code_hash"], hashlib.sha256(code.encode()).hexdigest())

    def test_second_issue_returns_none_not_plaintext(self):
        pid = self.provision()
        first_code = self.store.issue_recovery_code(pid)
        self.assertTrue(first_code and first_code.startswith("DABLAJA-"))
        self.assertIsNone(self.store.issue_recovery_code(pid))

    def test_correct_code_binds_installation_to_stable_id(self):
        pid = self.provision()
        code = self.store.rotate_recovery_code(pid)
        other_install = "k" * 24
        self.assertEqual(self.store.recover_installation(code, other_install), pid)
        self.assertEqual(self.store.active_purchase_id_for_install(other_install), pid)

    def test_wrong_code_rejected_generically_at_route(self):
        self.provision()
        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": "m" * 24, "code": "DABLAJA-" + "0" * 20, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["error"], "recovery_failed")

    def test_recovery_route_rejects_non_code_formats(self):
        for bad in ("buyer@example.com", "cs_abc123", "pi_abc123", "cus_abc123"):
            resp = self.client.post(
                "/dablaja/api/recover-license",
                json={"install_id": "m" * 24, "code": bad, "install_credential": GOOD_CREDENTIAL},
                headers={"Origin": ALLOWED_ORIGIN},
            )
            self.assertEqual(resp.status_code, 403)

    def test_recovery_code_never_appears_as_token_license_id(self):
        pid = self.provision()
        code = self.store.rotate_recovery_code(pid)
        other_install = "n" * 24
        resolved = self.store.recover_installation(code, other_install)
        token = dablaja.sign_license_token(resolved, other_install)
        self.assertIsNotNone(token)
        self.assertNotIn(code, token)
        parts = token.split(".")
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        self.assertNotEqual(payload["lid"], code)
        self.assertEqual(payload["lid"], pid)

    def test_rotated_code_invalidates_old(self):
        pid = self.provision()
        old = self.store.rotate_recovery_code(pid)
        new = self.store.rotate_recovery_code(pid)
        self.assertNotEqual(old, new)
        self.assertIsNone(self.store.recover_installation(old, "o" * 24))
        self.assertIsNotNone(self.store.recover_installation(new, "o" * 24))

    def test_revoked_license_cannot_recover(self):
        pid = self.provision()
        code = self.store.rotate_recovery_code(pid)
        self.store.revoke_purchase(pid, "refunded")
        self.assertIsNone(self.store.recover_installation(code, "p" * 24))

    def test_recovery_route_rate_limited_per_install(self):
        self.provision()
        for _ in range(dablaja.VERIFY_PER_INSTALL):
            self.store.reserve(f"recover:{'q' * 24}", dablaja.VERIFY_PER_INSTALL)
        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": "q" * 24, "code": "DABLAJA-" + "A" * 20, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 429)


# ---- Refund / dispute revocation -------------------------------------------------

class RevocationTests(PaymentTestBase):
    def provision_with_refs(self):
        s = fake_session(session="cs_refund_me")
        s["payment_intent"] = {**s["payment_intent"], "id": "pi_refund_me", "latest_charge": "ch_refund_me"}
        cred_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertTrue(out["ok"])
        return out["purchase_id"]

    def test_refund_by_charge_revokes_all_bindings(self):
        pid = self.provision_with_refs()
        extra_install = "r" * 24
        self.store.recover_installation(self.store.rotate_recovery_code(pid), extra_install)
        self.assertTrue(self.store.has_active_license(GOOD_INSTALL))
        self.assertTrue(self.store.has_active_license(extra_install))
        self.assertTrue(self.store.revoke_by_payment_reference(charge_id="ch_refund_me"))
        self.assertFalse(self.store.has_active_license(GOOD_INSTALL))
        self.assertFalse(self.store.has_active_license(extra_install))
        self.assertEqual(self.store.install_status(GOOD_INSTALL), "revoked")

    def test_dispute_by_charge_resolves_via_intent(self):
        self.provision_with_refs()
        with patch.object(dablaja, "_stripe_payment_intent_for_charge", return_value="pi_refund_me"):
            self.assertTrue(self.store.revoke_by_charge_dispute("ch_unknown"))
        self.assertFalse(self.store.has_active_license(GOOD_INSTALL))

    def test_token_renewal_refused_after_refund(self):
        self.provision_with_refs()
        self.store.revoke_by_payment_reference(charge_id="ch_refund_me")
        resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)

    def test_authenticated_status_reports_revocation_but_wrong_credential_stays_generic(self):
        self.provision_with_refs()
        self.store.revoke_by_payment_reference(charge_id="ch_refund_me")
        revoked = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(revoked.status_code, 200)
        self.assertEqual(revoked.json(), {"ok": True, "status": "revoked"})

        wrong = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": "b" * 64},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json(), {"ok": False, "error": "unauthorized"})


# ---- Signed token binding ---------------------------------------------------------

class TokenSigningTests(unittest.TestCase):
    def test_token_signs_and_carries_stable_binding_and_expiry(self):
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        except ImportError:
            self.skipTest("cryptography not installed")
        seed = os.urandom(32)
        original = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = base64.b64encode(seed).decode()
        try:
            token = dablaja.sign_license_token("purchase-stable-id-0001", GOOD_INSTALL)
            self.assertTrue(token and token.startswith("dpl1."))
            parts = token.split(".")
            self.assertEqual(len(parts), 3)
            payload = json.loads(dablaja._b64u_decode(parts[1]))
            self.assertEqual(payload["lid"], "purchase-stable-id-0001")
            self.assertEqual(payload["iid"], GOOD_INSTALL)
            self.assertGreater(payload["exp"], int(time.time()))
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = original

    def test_signing_without_key_returns_none(self):
        original = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = ""
        try:
            self.assertIsNone(dablaja.sign_license_token("pid", GOOD_INSTALL))
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = original


# ---- Adversarial checks from the review -------------------------------------------

class AdversarialRegressionTests(PaymentTestBase):
    def test_legacy_unpaid_complete_accepted_is_false(self):
        s = fake_session(session="cs_adv_1")
        s["payment_status"] = "unpaid"
        s["status"] = "complete"
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertFalse(out["ok"])
        self.assertIsNone(self.store.get_purchase_by_session(s["id"]))

    def test_legacy_activated_is_false(self):
        s = fake_session(session="cs_adv_2")
        s["payment_status"] = "unpaid"
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            dablaja.strict_verify_and_activate(s["id"])
        self.assertIsNone(self.store.get_purchase_by_session(s["id"]))
        self.assertEqual(self.store.install_status(GOOD_INSTALL), "none")

    def test_strict_wrong_metadata_accepted_is_false(self):
        s = fake_session(session="cs_adv_3")
        s["metadata"] = {"install_id": "evil-install-12345678"}
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertFalse(out["ok"])
        self.assertIsNone(self.store.get_purchase_by_session(s["id"]))

    def test_strict_wrong_metadata_activated_is_false(self):
        s = fake_session(session="cs_adv_4")
        s["payment_intent"]["metadata"] = {"install_id": "evil-install-98765432", "dablaja_purchase": "1"}
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertFalse(out["ok"])
        self.assertIsNone(self.store.get_purchase_by_session(s["id"]))


class SuccessPageTests(PaymentTestBase):
    def test_missing_session_id_returns_400(self):
        resp = self.client.get("/dablaja/success")
        self.assertEqual(resp.status_code, 400)

    def test_invalid_session_id_returns_400(self):
        resp = self.client.get("/dablaja/success?session_id=bad_id")
        self.assertEqual(resp.status_code, 400)

    def test_stripe_error_returns_502(self):
        with patch.object(dablaja, "strict_verify_and_activate", return_value={"ok": False, "reason": "stripe_error"}):
            resp = self.client.get("/dablaja/success?session_id=cs_error_session")
            self.assertEqual(resp.status_code, 502)

    def test_not_paid_returns_400(self):
        with patch.object(dablaja, "strict_verify_and_activate", return_value={"ok": False, "reason": "not_paid"}):
            resp = self.client.get("/dablaja/success?session_id=cs_unpaid_session")
            self.assertEqual(resp.status_code, 400)

    def test_valid_paid_session_shows_recovery_code_once(self):
        s = fake_session(session="cs_success_page")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            resp1 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(resp1.status_code, 200)
            self.assertIn("DABLAJA-", resp1.text)

            # Second visit does not re-issue or display plaintext code
            resp2 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(resp2.status_code, 200)
            self.assertNotIn("DABLAJA-", resp2.text)


class RotateRecoveryTests(PaymentTestBase):
    def test_rotate_recovery_rejects_disallowed_origin(self):
        resp = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": "https://evil.com"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_rotate_recovery_rejects_inactive_install(self):
        resp = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)

    def test_rotate_recovery_succeeds_for_active_install(self):
        s = fake_session(session="cs_rotate_rec")
        cred_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            dablaja.strict_verify_and_activate(s["id"])

        resp = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        code = resp.json().get("code")
        self.assertTrue(code and code.startswith("DABLAJA-"))


class InstallationCredentialAuthenticationTests(PaymentTestBase):
    def provision_active(self, install=GOOD_INSTALL, credential=GOOD_CREDENTIAL):
        s = fake_session(session="cs_auth_test", install_id=install)
        cred_hash = hashlib.sha256(credential.encode()).hexdigest()
        self.store.create_checkout_attempt(install, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertTrue(out["ok"])
        return out["purchase_id"]

    def test_license_status_requires_credential_and_matches_hash(self):
        self.provision_active()
        resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"ok": True, "status": "active"})

    def test_license_status_rejects_wrong_credential(self):
        self.provision_active()
        resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": OTHER_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 401)
        self.assertFalse(resp.json()["ok"])

    def test_license_status_rate_limited_per_install(self):
        self.provision_active()
        for _ in range(dablaja.VERIFY_PER_INSTALL):
            self.store.reserve(f"status:{GOOD_INSTALL}", dablaja.VERIFY_PER_INSTALL)
        resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 429)

    def test_license_status_get_without_credential_returns_401(self):
        self.provision_active()
        resp = self.client.get(
            f"/dablaja/api/license-status?iid={GOOD_INSTALL}",
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 401)

    def test_license_token_requires_valid_credential(self):
        self.provision_active()
        resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertTrue(resp.json()["token"].startswith("dpl1."))

    def test_license_token_rejects_wrong_credential(self):
        self.provision_active()
        resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": OTHER_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)

    def test_rotate_recovery_rejects_wrong_credential(self):
        self.provision_active()
        resp = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": OTHER_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)

    def test_recover_license_binds_new_installation_credential(self):
        pid = self.provision_active()
        code = self.store.rotate_recovery_code(pid)
        new_install = "z" * 24
        new_cred = "c" * 64

        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": new_install, "code": code, "install_credential": new_cred},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

        # Verify new install is now authenticated with new_cred
        status_resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": new_install, "install_credential": new_cred},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(status_resp.status_code, 200)
        self.assertEqual(status_resp.json()["status"], "active")

        # Wrong cred for new install rejected
        wrong_status = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": new_install, "install_credential": OTHER_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(wrong_status.status_code, 401)

    def test_spoofed_origin_plus_known_install_cannot_obtain_token(self):
        self.provision_active()
        # Disallowed / spoofed origin
        resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": "https://attacker.example.com"},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json(), {"ok": False, "error": "origin_not_allowed"})

    def test_known_install_without_credential_cannot_rotate_recovery_code(self):
        self.provision_active()
        # Missing credential
        resp1 = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp1.status_code, 401)

        # Malformed credential
        resp2 = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": "short"},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp2.status_code, 401)

    def test_credential_stored_only_as_hash_never_plaintext(self):
        pid = self.provision_active()
        expected_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        with self.store._db() as conn:
            # Check license_installations
            inst_rows = conn.execute(
                "SELECT credential_hash FROM license_installations WHERE license_id = ?", (pid,)
            ).fetchall()
            self.assertEqual(len(inst_rows), 1)
            self.assertEqual(inst_rows[0]["credential_hash"], expected_hash)
            self.assertNotEqual(inst_rows[0]["credential_hash"], GOOD_CREDENTIAL)

            # Check checkout_attempts
            attempt_rows = conn.execute(
                "SELECT credential_hash FROM checkout_attempts WHERE install_id = ?", (GOOD_INSTALL,)
            ).fetchall()
            self.assertEqual(len(attempt_rows), 1)
            self.assertEqual(attempt_rows[0]["credential_hash"], expected_hash)
            self.assertNotEqual(attempt_rows[0]["credential_hash"], GOOD_CREDENTIAL)

            # Check entire db dump for plaintext credential
            cursor = conn.cursor()
            for table in ("purchases", "license_installations", "checkout_attempts", "recovery_codes"):
                for row in cursor.execute(f"SELECT * FROM {table}").fetchall():
                    for val in row:
                        if val is not None:
                            self.assertNotIn(GOOD_CREDENTIAL, str(val))

    def test_credential_never_leaked_in_urls_logs_responses_or_stripe_meta(self):
        # 1. Checkout session creation args
        with patch.object(dablaja.stripe.checkout.Session, "create") as create:
            create.return_value = {"id": "cs_sec_test", "url": "https://checkout.stripe.com/c/pay/cs_sec_test"}
            resp = self.client.post(
                "/dablaja/api/checkout",
                json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
                headers={"Origin": ALLOWED_ORIGIN},
            )
            self.assertEqual(resp.status_code, 200)
            kwargs = create.call_args.kwargs
            # Metadata must not contain plaintext credential
            self.assertNotIn(GOOD_CREDENTIAL, str(kwargs))
            self.assertNotIn(GOOD_CREDENTIAL, resp.text)

        # 2. License status response
        self.provision_active()
        stat_resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(stat_resp.status_code, 200)
        self.assertNotIn(GOOD_CREDENTIAL, stat_resp.text)

        # 3. License token response
        tok_resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(tok_resp.status_code, 200)
        self.assertNotIn(GOOD_CREDENTIAL, tok_resp.text)

        # 4. Rotate recovery response
        rot_resp = self.client.post(
            "/dablaja/api/rotate-recovery",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(rot_resp.status_code, 200)
        self.assertNotIn(GOOD_CREDENTIAL, rot_resp.text)

        # 5. GET query strings reject credentials or do not expose them
        get_resp = self.client.get(
            f"/dablaja/api/license-status?install_credential={GOOD_CREDENTIAL}",
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(get_resp.status_code, 401)
        self.assertNotIn(GOOD_CREDENTIAL, get_resp.text)

    def test_one_time_binding_for_authentic_token_when_credential_missing(self):
        pid = self.provision_active()
        # Simulate legacy db row where credential_hash is NULL
        with self.store._db() as conn:
            conn.execute("UPDATE license_installations SET credential_hash = NULL WHERE license_id = ?", (pid,))

        token = dablaja.sign_license_token(pid, GOOD_INSTALL)
        # Token request with valid authentic token allows one-time binding
        resp = self.client.post(
            "/dablaja/api/license-token",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL, "token": token},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

        # Now normal status check succeeds with bound credential
        status_resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(status_resp.status_code, 200)
        self.assertEqual(status_resp.json()["status"], "active")



class AuthorizationOracleAndBindingConcurrencyTests(PaymentTestBase):
    def provision_active(self, install=GOOD_INSTALL, credential=GOOD_CREDENTIAL):
        s = fake_session(session="cs_oracle_active", install_id=install)
        cred_hash = hashlib.sha256(credential.encode()).hexdigest()
        self.store.create_checkout_attempt(install, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        self.assertTrue(out["ok"])
        return out["purchase_id"]

    def test_license_status_exposes_revocation_only_to_the_authentic_installation(self):
        # Active install.
        s = fake_session(session="cs_oracle_active")
        cred_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            dablaja.strict_verify_and_activate(s["id"])
        # Revoked install: revoked directly.
        other_install = "o" * 24
        s2 = fake_session(session="cs_oracle_revoked", install_id=other_install)
        cred2 = "d" * 64
        self.store.create_checkout_attempt(other_install, s2["id"], hashlib.sha256(cred2.encode()).hexdigest())
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s2):
            out = dablaja.strict_verify_and_activate(s2["id"])
            pid2 = out["purchase_id"]
        self.store.revoke_purchase(pid2, "refunded")
        # Absent install: never provisioned.
        absent_install = "z" * 24
        absent_cred = "e" * 64
        # Legacy-pending install: credential_hash NULL, no token supplied.
        legacy_install = "l" * 24
        s3 = fake_session(session="cs_oracle_legacy2", install_id=legacy_install)
        legacy_cred = "f" * 64
        self.store.create_checkout_attempt(legacy_install, s3["id"], hashlib.sha256(legacy_cred.encode()).hexdigest())
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s3):
            dablaja.strict_verify_and_activate(s3["id"])
        with self.store._db() as conn:
            conn.execute("UPDATE license_installations SET credential_hash = NULL WHERE install_id = ?", (legacy_install,))

        authentic_revoked = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": other_install, "install_credential": cred2},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(authentic_revoked.status_code, 200)
        self.assertEqual(authentic_revoked.json(), {"ok": True, "status": "revoked"})

        probes = [
            (other_install, "a" * 64, "revoked (wrong hash)"),
            (absent_install, absent_cred, "absent install"),
            (legacy_install, legacy_cred, "legacy unbound without token"),
        ]
        for install, cred, label in probes:
            resp = self.client.post(
                "/dablaja/api/license-status",
                json={"install_id": install, "install_credential": cred},
                headers={"Origin": ALLOWED_ORIGIN},
            )
            self.assertEqual(resp.status_code, 401, f"oracle: expected 401 for {label}")
            body = resp.json()
            self.assertFalse(body.get("ok"))
            self.assertEqual(body.get("error"), "unauthorized", f"oracle: same error for {label}")
            self.assertNotIn("revoked", resp.text.lower(), f"oracle response leaks revocation for {label}")
            self.assertNotIn("none", resp.text.lower(), f"oracle response leaks absence for {label}")

    def test_license_status_with_authentic_token_bootstraps_legacy_and_uses_generic_on_failure(self):
        # Provision legacy row with no hash.
        s = fake_session(session="cs_legacy_bootstrap")
        cred_hash = hashlib.sha256(GOOD_CREDENTIAL.encode()).hexdigest()
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], cred_hash)
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        pid = out["purchase_id"]
        with self.store._db() as conn:
            conn.execute("UPDATE license_installations SET credential_hash = NULL WHERE license_id = ?", (pid,))
        token = dablaja.sign_license_token(pid, GOOD_INSTALL)
        # Without token, status remains generic unauthorized.
        absent = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(absent.status_code, 401)
        self.assertEqual(absent.json().get("error"), "unauthorized")
        # With an authentic token carrying the correct iid/lid/iat structure,
        # status authenticates and the DB binding is created.
        resp = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL, "token": token},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"ok": True, "status": "active"})
        # Subsequent plain status succeeds without token.
        again = self.client.post(
            "/dablaja/api/license-status",
            json={"install_id": GOOD_INSTALL, "install_credential": GOOD_CREDENTIAL},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(again.status_code, 200)

    def test_concurrent_legacy_credentials_report_one_success(self):
        pid = self.provision_active()
        with self.store._db() as conn:
            conn.execute("UPDATE license_installations SET credential_hash = NULL WHERE license_id = ?", (pid,))
        token = dablaja.sign_license_token(pid, GOOD_INSTALL)
        cred_a = "a" * 64
        cred_b = "b" * 64
        import concurrent.futures
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futs = [
                pool.submit(self.store.verify_installation_credential, GOOD_INSTALL, cred_a, token),
                pool.submit(self.store.verify_installation_credential, GOOD_INSTALL, cred_b, token),
            ]
            for f in concurrent.futures.as_completed(futs):
                results.append(f.result())
        ok_rows = [ok for ok, _ in results if ok]
        self.assertEqual(len(ok_rows), 1, "exactly one concurrent legacy binder wins")

    def test_recovery_preserves_existing_different_binding_and_is_idempotent_for_same_hash(self):
        pid = self.provision_active()
        target = "n" * 24
        first_cred = "a" * 64
        second_cred = "b" * 64
        first_hash = hashlib.sha256(first_cred.encode()).hexdigest()
        second_hash = hashlib.sha256(second_cred.encode()).hexdigest()
        code = self.store.rotate_recovery_code(pid)
        # First recovery binds the target install with first_cred.
        ok_id = self.store.recover_installation(code, target, credential_hash=first_hash)
        self.assertEqual(ok_id, pid)
        # Idempotent replay with the SAME hash succeeds.
        again = self.store.recover_installation(code, target, credential_hash=first_hash)
        self.assertEqual(again, pid)
        # Recovery with a DIFFERENT credential already bound must return None
        # and preserve the original hash — even via the HTTP route.
        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": target, "code": code, "install_credential": second_cred},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json().get("error"), "conflict", "generic conflict when a credential is already bound")
        with self.store._db() as conn:
            row = conn.execute("SELECT credential_hash FROM license_installations WHERE install_id = ?", (target,)).fetchone()
            self.assertEqual(row["credential_hash"], first_hash, "existing binding preserved")


class SuccessPageSecurityHeaderTests(PaymentTestBase):
    def test_success_and_recovery_responses_carry_protective_headers(self):
        s = fake_session(session="cs_header_sensitive")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            resp = self.client.get(f"/dablaja/success?session_id={s['id']}")
        self.assertEqual(resp.status_code, 200)
        h = {k.lower(): v for k, v in resp.headers.items()}
        self.assertIn("no-store", h.get("cache-control", "").lower())
        self.assertIn("private", h.get("cache-control", "").lower())
        self.assertEqual(h.get("pragma"), "no-cache")
        self.assertEqual(h.get("referrer-policy"), "no-referrer")
        self.assertEqual(h.get("x-content-type-options"), "nosniff")
        self.assertEqual(h.get("x-frame-options"), "DENY")
        csp = h.get("content-security-policy", "").lower()
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("base-uri 'none'", csp)
        self.assertIn("form-action 'none'", csp)
        self.assertIn("script-src 'none'", csp)

    def test_feedback_pages_carry_form_csp_permitting_self_images_and_self_form(self):
        resp = self.client.get("/dablaja/feedback?install_id=test123&source=popup")
        self.assertEqual(resp.status_code, 200)
        h = {k.lower(): v for k, v in resp.headers.items()}
        self.assertIn("no-store", h.get("cache-control", "").lower())
        self.assertEqual(h.get("x-frame-options"), "DENY")
        csp = h.get("content-security-policy", "").lower()
        self.assertIn("form-action 'self'", csp)
        self.assertIn("script-src 'none'", csp)
        self.assertIn("img-src 'self' data:", csp)
        self.assertNotIn("<script", resp.text.lower())
        self.assertIn('type="radio"', resp.text)
        self.assertIn('name="reason"', resp.text)
        self.assertNotIn('name="install_id"', resp.text)
        self.assertRegex(resp.text, r'name="submission_id" value="[0-9a-f-]{36}"')

    def test_feedback_form_submission_with_valid_reason_succeeds(self):
        get_resp = self.client.get("/dablaja/feedback")
        self.assertEqual(get_resp.status_code, 200)
        submission_id = re.search(r'name="submission_id" value="([0-9a-f-]{36})"', get_resp.text).group(1)
        post_resp = self.client.post(
            "/dablaja/feedback",
            data={"reason": "خطأ أو عطل", "message": "test", "submission_id": submission_id, "source": "popup"},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(post_resp.status_code, 200)
        self.assertIn("شكراً", post_resp.text)

    def test_feedback_missing_reason_is_rejected(self):
        resp = self.client.post(
            "/dablaja/feedback",
            data={"message": "no reason", "submission_id": str(uuid.uuid4())},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(resp.status_code, 400)

    def test_recovery_code_never_appears_in_redirect_query_or_log_artifacts(self):
        s = fake_session(session="cs_no_redirect_leak")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            resp = self.client.get(
                f"/dablaja/success?session_id={s['id']}",
                follow_redirects=False,
            )
        self.assertEqual(resp.status_code, 200, "success page responds directly, not via redirect")
        self.assertEqual(resp.headers.get("location"), None, "no redirect carrying a code in the URL")
        # The recovery code itself must live only in the 200 HTML body — never
        # in the URL the user sees beyond the session_id already supplied, and
        # never echoed through analytics/logs/redirects by the server. The
        # body claim is exercised in SuccessPageTests already; this probes the
        # redirect/URL absence explicitly.
        self.assertIn("DABLAJA-", resp.text)
        self.assertNotIn("DABLAJA-", resp.headers.get("location") or "")

    def test_feedback_pages_never_contain_recovery_codes(self):
        for path in ("/dablaja/feedback", "/dablaja/uninstall"):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200)
            self.assertNotIn("DABLAJA-", resp.text)




class AtomicRecoveryConcurrencyTests(PaymentTestBase):
    def test_concurrent_issue_recovery_code_exactly_one_plaintext(self):
        import concurrent.futures
        s = fake_session(session="cs_concur_1")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        pid = out["purchase_id"]

        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(self.store.issue_recovery_code, pid) for _ in range(10)]
            for f in concurrent.futures.as_completed(futures):
                results.append(f.result())

        non_null = [r for r in results if r is not None]
        self.assertEqual(len(non_null), 1, "Exactly one concurrent caller must receive plaintext code")
        self.assertTrue(non_null[0].startswith("DABLAJA-"))
        self.assertEqual(len(results), 10)
        self.assertEqual(results.count(None), 9)

    def test_webhook_before_success_page(self):
        s = fake_session(session="cs_order_1")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            # Webhook arrives first
            event = {"type": "checkout.session.completed", "data": {"object": {"id": s["id"]}}}
            payload = json.dumps(event).encode()
            t = int(time.time())
            import hmac
            mac = hmac.new(dablaja.STRIPE_WEBHOOK_SECRET.encode(), f"{t}.".encode() + payload, "sha256").hexdigest()
            sig = f"t={t},v1={mac}"
            wh_resp = self.client.post("/dablaja/webhook", content=payload, headers={"Stripe-Signature": sig, "Content-Type": "application/json"})
            self.assertEqual(wh_resp.status_code, 200)

            # Success page arrives after webhook
            succ_resp1 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(succ_resp1.status_code, 200)
            self.assertIn("DABLAJA-", succ_resp1.text)

            # Second visit to success page does not reveal code
            succ_resp2 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(succ_resp2.status_code, 200)
            self.assertNotIn("DABLAJA-", succ_resp2.text)

    def test_success_page_before_webhook(self):
        s = fake_session(session="cs_order_2")
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            # Success page arrives first
            succ_resp1 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(succ_resp1.status_code, 200)
            self.assertIn("DABLAJA-", succ_resp1.text)

            # Webhook arrives after success page
            event = {"type": "checkout.session.completed", "data": {"object": {"id": s["id"]}}}
            payload = json.dumps(event).encode()
            t = int(time.time())
            import hmac
            mac = hmac.new(dablaja.STRIPE_WEBHOOK_SECRET.encode(), f"{t}.".encode() + payload, "sha256").hexdigest()
            sig = f"t={t},v1={mac}"
            wh_resp = self.client.post("/dablaja/webhook", content=payload, headers={"Stripe-Signature": sig, "Content-Type": "application/json"})
            self.assertEqual(wh_resp.status_code, 200)

            # Second visit to success page still does not reveal code
            succ_resp2 = self.client.get(f"/dablaja/success?session_id={s['id']}")
            self.assertEqual(succ_resp2.status_code, 200)
            self.assertNotIn("DABLAJA-", succ_resp2.text)


class TelemetryTests(PaymentTestBase):
    def test_report_error_rejects_disallowed_origin(self):
        resp = self.client.post(
            "/dablaja/api/errors",
            json={"event_id": "e" * 24, "error_code": "test"},
            headers={"Origin": "https://evil.com"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_report_error_accepts_allowed_origin(self):
        resp = self.client.post(
            "/dablaja/api/errors",
            json={
                "event_id": "e" * 24,
                "error_code": "test_err",
                "error_message": "safe msg",
                "status": "invented",
                "site_host": "private.example",
                "reconnect_count": "not-a-number",
            },
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json().get("ok"))
        row = self.store.list_errors()[0]
        self.assertNotIn("error_message", row)
        self.assertNotIn("user_agent", row)
        self.assertEqual(row["error_code"], "unknown")
        self.assertEqual(row["status"], "")
        self.assertEqual(row["site_host"], "other")
        self.assertEqual(row["reconnect_count"], 0)
        with self.store._db() as conn:
            budget_categories = [r["category"] for r in conn.execute("SELECT category FROM daily_budget")]
        self.assertEqual(budget_categories, ["errors"])
        self.assertFalse(any("testclient" in value or "." in value for value in budget_categories))

    def test_report_error_uses_one_time_event_id_and_ignores_install_identity(self):
        payload = {
            "event_id": "e1" + "f" * 22,
            "install_id": "a" * 24,
            "error_code": "network_error",
            "status": "reconnecting",
            "site_host": "youtube",
            "extension_version": "1.0.0",
        }
        first = self.client.post("/dablaja/api/errors", json=payload, headers={"Origin": ALLOWED_ORIGIN})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["status"], "ok")
        # A retry of the same event is stored once even if other fields differ.
        second = self.client.post(
            "/dablaja/api/errors",
            json={**payload, "error_code": "api_key_invalid"},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(second.json()["status"], "duplicate")
        rows = self.store.list_errors()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event_id"], payload["event_id"])
        self.assertNotIn("install_id", rows[0])
        # A different one-time event is a distinct row.
        third = self.client.post(
            "/dablaja/api/errors",
            json={**payload, "event_id": "e3" + "f" * 22, "error_code": "api_key_invalid"},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(third.json()["status"], "ok")
        rows = self.store.list_errors()
        self.assertEqual(len(rows), 2)

    def test_report_error_requires_bounded_one_time_event_id(self):
        event = "one-time-event-000001"
        resp = self.client.post(
            "/dablaja/api/errors",
            json={"event_id": event, "error_code": "unknown"},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        rows = self.store.list_errors()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event_id"], event)

    def test_legacy_telemetry_schema_migration_erases_stable_identifiers(self):
        legacy_path = Path(self.tmp.name) / "legacy-telemetry.db"
        conn = dablaja.sqlite3.connect(str(legacy_path))
        conn.executescript(
            """
            CREATE TABLE error_reports (
              id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
              install_id TEXT NOT NULL, error_code TEXT NOT NULL,
              error_message TEXT NOT NULL, status TEXT NOT NULL,
              site_host TEXT NOT NULL, extension_version TEXT NOT NULL,
              reconnect_count INTEGER NOT NULL, user_agent TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE feedback_reports (
              id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL, install_id TEXT NOT NULL, source TEXT NOT NULL,
              reason TEXT NOT NULL, message TEXT NOT NULL, email TEXT NOT NULL,
              user_agent TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE daily_budget (
              day TEXT NOT NULL, category TEXT NOT NULL,
              accepted INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (day, category)
            );
            """
        )
        conn.execute(
            "INSERT INTO error_reports VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("err-row", "dedupe-err", "stable-install", "network_error", "", "error", "youtube", "0.9.0", 0, "", dablaja.utc_now()),
        )
        conn.execute(
            "INSERT INTO feedback_reports VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("form-row", "dedupe-form", "feedback", "stable-install", "popup", "أخرى", "", "", "", dablaja.utc_now()),
        )
        conn.executemany(
            "INSERT INTO daily_budget VALUES (?,?,?)",
            [
                (dablaja.utc_day(), "errors:203.0.113.10", 1),
                (dablaja.utc_day(), "token:203.0.113.11", 1),
                (dablaja.utc_day(), "recover:2001:db8::1", 1),
                (dablaja.utc_day(), "rotate:198.51.100.7", 1),
                (dablaja.utc_day(), "token:" + "a" * 32, 1),
                (dablaja.utc_day(), "token:valid-install-id-123456", 1),
            ],
        )
        conn.commit()
        conn.close()

        migrated = dablaja.DablajaStore(legacy_path)
        error = migrated.list_errors()[0]
        feedback = migrated.list_feedback("feedback")[0]
        self.assertEqual(error["event_id"], "err-row")
        self.assertEqual(feedback["submission_id"], "form-row")
        self.assertNotIn("install_id", error)
        self.assertNotIn("install_id", feedback)
        self.assertNotIn("error_message", error)
        self.assertNotIn("user_agent", error)
        self.assertNotIn("user_agent", feedback)
        with migrated._db() as db:
            categories = {
                row["category"] for row in db.execute("SELECT category FROM daily_budget")
            }
            self.assertEqual(categories, {"token:" + "a" * 32, "token:valid-install-id-123456"})

    def test_transitional_telemetry_schema_removes_unused_empty_columns(self):
        transitional_path = Path(self.tmp.name) / "transitional-telemetry.db"
        conn = dablaja.sqlite3.connect(str(transitional_path))
        conn.executescript(
            """
            CREATE TABLE error_reports (
              id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
              event_id TEXT NOT NULL, error_code TEXT NOT NULL,
              error_message TEXT NOT NULL, status TEXT NOT NULL,
              site_host TEXT NOT NULL, extension_version TEXT NOT NULL,
              reconnect_count INTEGER NOT NULL, user_agent TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE feedback_reports (
              id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL, submission_id TEXT NOT NULL, source TEXT NOT NULL,
              reason TEXT NOT NULL, message TEXT NOT NULL, email TEXT NOT NULL,
              user_agent TEXT NOT NULL, created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO error_reports VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("err-row", "dedupe-err", "one-time-event", "network_error", "", "error", "youtube", "1.0.0", 1, "", dablaja.utc_now()),
        )
        conn.execute(
            "INSERT INTO feedback_reports VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("form-row", "dedupe-form", "feedback", "one-time-form", "stats", "أخرى", "message", "", "", dablaja.utc_now()),
        )
        conn.commit()
        conn.close()

        migrated = dablaja.DablajaStore(transitional_path)
        error = migrated.list_errors()[0]
        feedback = migrated.list_feedback("feedback")[0]
        self.assertEqual(error["event_id"], "one-time-event")
        self.assertEqual(feedback["submission_id"], "one-time-form")
        self.assertNotIn("error_message", error)
        self.assertNotIn("user_agent", error)
        self.assertNotIn("user_agent", feedback)

    def test_legacy_payment_references_migrate_to_distinct_purchases(self):
        legacy_path = Path(self.tmp.name) / "legacy-licenses.db"
        conn = dablaja.sqlite3.connect(str(legacy_path))
        conn.executescript(
            """
            CREATE TABLE licenses (
              stripe_session_id TEXT, install_id TEXT NOT NULL,
              stripe_customer_id TEXT, amount_total INTEGER, currency TEXT,
              status TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT
            );
            """
        )
        now = dablaja.utc_now()
        conn.execute(
            "INSERT INTO licenses VALUES (?,?,?,?,?,?,?,?)",
            ("pi_legacy_one", "install-one-123456", "cus_one", 1000, "usd", "active", now, now),
        )
        conn.execute(
            "INSERT INTO licenses VALUES (?,?,?,?,?,?,?,?)",
            ("ch_legacy_two", "install-two-123456", "cus_two", 1000, "usd", "active", now, now),
        )
        conn.commit()
        conn.close()

        migrated = dablaja.DablajaStore(legacy_path)
        with migrated._db() as db:
            rows = db.execute(
                """SELECT i.install_id, i.license_id, p.payment_intent_id, p.charge_id
                   FROM license_installations i
                   JOIN purchases p ON p.id = i.license_id
                   ORDER BY i.install_id"""
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["license_id"], rows[1]["license_id"])
        refs = {
            row["install_id"]: (row["payment_intent_id"], row["charge_id"])
            for row in rows
        }
        self.assertEqual(refs["install-one-123456"], ("pi_legacy_one", None))
        self.assertEqual(refs["install-two-123456"], (None, "ch_legacy_two"))

    def test_report_usage_rejects_disallowed_origin(self):
        resp = self.client.post(
            "/dablaja/api/usage",
            json={"event_id": "e" * 24, "platform": "youtube", "dubbed_ms": 60000},
            headers={"Origin": "https://evil.com"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_report_usage_accepts_allowed_origin(self):
        resp = self.client.post(
            "/dablaja/api/usage",
            json={"event_id": "e" * 24, "platform": "youtube", "dubbed_ms": 60000},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json().get("ok"))

    def test_webhook_rejects_oversized_payload(self):
        resp = self.client.post(
            "/dablaja/webhook",
            content=b"x" * 70000,
            headers={"Stripe-Signature": "t=1,v1=abc", "Content-Type": "application/json"},
        )
        self.assertEqual(resp.status_code, 413)

    def test_defensive_redaction_redacts_synthetic_aiza_and_aq_keys_and_urls(self):
        fake_aiza = "AIza" + "X" * 35
        fake_aq = "AQ." + "Y" * 35
        fake_url = "https://secret.example.com/token?key=123"
        fake_wss = "wss://generativelanguage.googleapis.com/ws/xyz"

        cleaned_aiza = dablaja.clean_text(f"Error with key {fake_aiza} occurred", 200)
        self.assertNotIn(fake_aiza, cleaned_aiza)
        self.assertIn("[redacted]", cleaned_aiza)

        cleaned_aq = dablaja.clean_text(f"Error with auth {fake_aq} occurred", 200)
        self.assertNotIn(fake_aq, cleaned_aq)
        self.assertIn("[redacted]", cleaned_aq)

        cleaned_url = dablaja.clean_text(f"Connection failed at {fake_url} or {fake_wss}", 200)
        self.assertNotIn("secret.example.com", cleaned_url)
        self.assertNotIn("generativelanguage.googleapis.com", cleaned_url)


class LegacyRemovalStaticTests(unittest.TestCase):
    SOURCE = None

    @classmethod
    def setUpClass(cls):
        cls.SOURCE = (Path(__file__).resolve().parent / "dablaja.py").read_text(encoding="utf-8")

    def test_removed_legacy_names_absent_from_runtime_code(self):
        for name in (
            "_try_activate_from_session",
            "upsert_license_from_stripe",
            "_strict_verify_checkout_session",
            "_handle_refund_or_dispute",
            "has_active_license_for_email",
            "insert_license_for_install",
            "stripe_api_get",
            "_license_record",
            "_license_response",
            "verify_recovery_code",
            "generate_recovery_code_for_license",
            "insert_pending_license",
            "latest_pending_session",
            "latest_license_status",
            "get_license_by_session",
        ):
            self.assertNotIn(name, self.SOURCE, f"legacy symbol resurrected: {name}")

    def test_single_verification_entrypoint_exists(self):
        self.assertIn("def strict_verify_and_activate(", self.SOURCE)

    def test_no_bare_except_pass_in_runtime_code(self):
        self.assertNotIn("except:\n        pass", self.SOURCE)


class LegacyBootstrapAndCrossLicenseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _store(self, filename):
        return dablaja.DablajaStore(Path(self.tmp.name) / filename)

    def _make_token(self, lid, iid, iat, exp, seed=None):
        # Sign a dpl1 token directly via the server key so tests exercise the
        # real Ed25519 path (no mocking of verify helper).
        import base64 as _b64
        old = dablaja.LICENSE_SIGNING_KEY_B64
        if seed is not None:
            dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(seed).decode()
        try:
            tok = dablaja.sign_license_token(lid, iid)
            # sign_license_token uses current time; override payload for ancient
            # tokens by re-signing with explicit iat/exp.
            if tok and (iat is not None or exp is not None):
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
                raw_seed = dablaja._b64u_decode(dablaja.LICENSE_SIGNING_KEY_B64)
                key = Ed25519PrivateKey.from_private_bytes(raw_seed)
                payload = {"lid": lid[:120], "iid": iid[:80], "iat": iat, "exp": exp}
                raw = json.dumps(payload, separators=(",", ":")).encode()
                sig = key.sign(b"dpl1." + raw)
                tok = f"dpl1.{dablaja._b64u(raw)}.{dablaja._b64u(sig)}"
            return tok
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = old

    def test_ancient_authentic_token_cannot_bootstrap_active_legacy_row(self):
        import base64 as _b64
        seed = os.urandom(32)
        old_key = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(seed).decode()
        install = "m" * 24
        try:
            cred = "a" * 64
            store2 = self._store("legacy-ancient.db")
            # Provision via store.fulfill directly: create a purchase + legacy NULL row
            pid = str(uuid.uuid4())
            with store2._db() as conn:
                conn.execute(
                    "INSERT INTO purchases (id, stripe_session_id, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)",
                    (pid, "cs_legacy_direct", dablaja.utc_now(), dablaja.utc_now()),
                )
                conn.execute(
                    "INSERT INTO license_installations (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, NULL, ?)",
                    (pid, install, dablaja.utc_now()),
                )
            ancient_iat = int(time.time()) - 20 * 86400
            ancient_exp = int(time.time()) - 15 * 86400  # 15 days ago -> beyond 7-day grace
            tok = self._make_token(pid, install, ancient_iat, ancient_exp, seed=seed)
            self.assertIsNotNone(tok)
            ok, lic = store2.verify_installation_credential(install, cred, token=tok)
            self.assertFalse(ok, "token beyond the seven-day grace horizon must not bootstrap")
            self.assertIsNone(lic)
            with store2._db() as conn:
                row = conn.execute(
                    "SELECT credential_hash FROM license_installations WHERE license_id = ? AND install_id = ?",
                    (pid, install),
                ).fetchone()
            self.assertIsNone(row["credential_hash"], "failed bootstrap must leave the legacy row unbound")
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = old_key

    def test_recent_authentic_token_bootstraps_active_legacy_row_once(self):
        import base64 as _b64
        seed = os.urandom(32)
        old_key = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(seed).decode()
        install = "w" * 24
        try:
            store = self._store("legacy-recent.db")
            pid = str(uuid.uuid4())
            with store._db() as conn:
                conn.execute(
                    "INSERT INTO purchases (id, stripe_session_id, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)",
                    (pid, "cs_legacy_recent", dablaja.utc_now(), dablaja.utc_now()),
                )
                conn.execute(
                    "INSERT INTO license_installations (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, NULL, ?)",
                    (pid, install, dablaja.utc_now()),
                )
            now = int(time.time())
            tok = self._make_token(pid, install, now - 31 * 86400, now - 3 * 86400, seed=seed)
            cred = "a" * 64
            ok, lic = store.verify_installation_credential(install, cred, token=tok)
            self.assertTrue(ok)
            self.assertEqual(lic, pid)
            ok2, lic2 = store.verify_installation_credential(install, cred)
            self.assertTrue(ok2)
            self.assertEqual(lic2, pid)
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = old_key

    def test_ancient_token_rejected_for_revoked_wrong_iid_lid_tampered(self):
        import base64 as _b64
        seed = os.urandom(32)
        old_key = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(seed).decode()
        try:
            # Revoked row
            store = self._store("legacy-revoked.db")
            pid = str(uuid.uuid4())
            install = "n" * 24
            with store._db() as conn:
                conn.execute(
                    "INSERT INTO purchases (id, stripe_session_id, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)",
                    (pid, "cs_rev_ancient", dablaja.utc_now(), dablaja.utc_now()),
                )
                conn.execute(
                    "INSERT INTO license_installations (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, NULL, ?)",
                    (pid, install, dablaja.utc_now()),
                )
            store.revoke_purchase(pid, "refunded")
            ancient_iat = int(time.time()) - 20 * 86400
            ancient_exp = int(time.time()) - 15 * 86400
            tok = self._make_token(pid, install, ancient_iat, ancient_exp, seed=seed)
            ok, _ = store.verify_installation_credential(install, "a" * 64, token=tok)
            self.assertFalse(ok, "revoked row must not bootstrap")
            # Wrong iid
            store2 = self._store("legacy-wrong-iid.db")
            pid2 = str(uuid.uuid4())
            with store2._db() as conn:
                conn.execute(
                    "INSERT INTO purchases (id, stripe_session_id, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)",
                    (pid2, "cs_iid_ancient", dablaja.utc_now(), dablaja.utc_now()),
                )
                conn.execute(
                    "INSERT INTO license_installations (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, NULL, ?)",
                    (pid2, install, dablaja.utc_now()),
                )
            tok_wrong_iid = self._make_token(pid2, "WRONG_INSTALL_123456", ancient_iat, ancient_exp, seed=seed)
            ok2, _ = store2.verify_installation_credential(install, "a" * 64, token=tok_wrong_iid)
            self.assertFalse(ok2, "wrong iid must fail")
            # Wrong lid
            tok_wrong_lid = self._make_token("wrong-lid-0000", install, ancient_iat, ancient_exp, seed=seed)
            ok3, _ = store2.verify_installation_credential(install, "a" * 64, token=tok_wrong_lid)
            self.assertFalse(ok3, "wrong lid must fail")
            # Tampered signature
            tok_good = self._make_token(pid2, install, ancient_iat, ancient_exp, seed=seed)
            tampered = tok_good[:-4] + "AAAA"
            ok4, _ = store2.verify_installation_credential(install, "a" * 64, token=tampered)
            self.assertFalse(ok4, "tampered signature must fail")
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = old_key

    def test_concurrent_different_credentials_one_winner_for_recent_bootstrap(self):
        import base64 as _b64
        import concurrent.futures
        seed = os.urandom(32)
        old_key = dablaja.LICENSE_SIGNING_KEY_B64
        dablaja.LICENSE_SIGNING_KEY_B64 = _b64.b64encode(seed).decode()
        try:
            store = self._store("legacy-concurrent.db")
            pid = str(uuid.uuid4())
            install = "o" * 24
            with store._db() as conn:
                conn.execute(
                    "INSERT INTO purchases (id, stripe_session_id, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)",
                    (pid, "cs_concur_ancient", dablaja.utc_now(), dablaja.utc_now()),
                )
                conn.execute(
                    "INSERT INTO license_installations (license_id, install_id, credential_hash, activated_at) VALUES (?, ?, NULL, ?)",
                    (pid, install, dablaja.utc_now()),
                )
            recent_iat = int(time.time()) - 31 * 86400
            recent_exp = int(time.time()) - 3 * 86400
            tok = self._make_token(pid, install, recent_iat, recent_exp, seed=seed)
            cred_a = "a" * 64
            cred_b = "b" * 64
            results = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futs = [
                    pool.submit(store.verify_installation_credential, install, cred_a, tok),
                    pool.submit(store.verify_installation_credential, install, cred_b, tok),
                ]
                for f in concurrent.futures.as_completed(futs):
                    results.append(f.result())
            ok_rows = [ok for ok, _ in results if ok]
            self.assertEqual(len(ok_rows), 1, "exactly one concurrent recent bootstrapper wins")
        finally:
            dablaja.LICENSE_SIGNING_KEY_B64 = old_key


class CrossLicenseRecoveryTests(PaymentTestBase):
    def test_different_license_same_install_is_conflict_preserves_original(self):
        s = fake_session(session="cs_cross_a")
        s2 = fake_session(session="cs_cross_b", install_id="x" * 24)
        cred_a = "a" * 64
        cred_b = "b" * 64
        # Provision two distinct purchases
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], hashlib.sha256(cred_a.encode()).hexdigest())
        self.store.create_checkout_attempt("x" * 24, s2["id"], hashlib.sha256(cred_b.encode()).hexdigest())
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out_a = dablaja.strict_verify_and_activate(s["id"])
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s2):
            out_b = dablaja.strict_verify_and_activate(s2["id"])
        pid_a = out_a["purchase_id"]
        pid_b = out_b["purchase_id"]
        code_b = self.store.rotate_recovery_code(pid_b)
        # Attempt to recover GOOD_INSTALL (bound to pid_a) using pid_b's code — different license, same install+cred
        with self.store._db() as conn:
            before = conn.execute("SELECT license_id FROM license_installations WHERE install_id = ?", (GOOD_INSTALL,)).fetchone()["license_id"]
        self.assertEqual(before, pid_a)
        result = self.store.recover_installation(code_b, GOOD_INSTALL, credential_hash=hashlib.sha256(cred_a.encode()).hexdigest())
        self.assertIsNone(result, "different license must be generic conflict")
        with self.store._db() as conn:
            after = conn.execute("SELECT license_id FROM license_installations WHERE install_id = ?", (GOOD_INSTALL,)).fetchone()["license_id"]
        self.assertEqual(after, pid_a, "original binding preserved across cross-license attempt")
        # HTTP path also returns generic conflict
        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": GOOD_INSTALL, "code": code_b, "install_credential": cred_a},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn(resp.json().get("error"), ("recovery_failed", "conflict"))

    def test_same_license_different_credential_is_conflict_without_integrity_error(self):
        s = fake_session(session="cs_cross_same")
        cred_a = "a" * 64
        cred_b = "b" * 64
        self.store.create_checkout_attempt(GOOD_INSTALL, s["id"], hashlib.sha256(cred_a.encode()).hexdigest())
        with patch.object(dablaja, "_stripe_retrieve_session", return_value=s):
            out = dablaja.strict_verify_and_activate(s["id"])
        pid = out["purchase_id"]
        target = "y" * 24
        code = self.store.rotate_recovery_code(pid)
        # First recovery binds target to pid with cred_a
        ok = self.store.recover_installation(code, target, credential_hash=hashlib.sha256(cred_a.encode()).hexdigest())
        self.assertEqual(ok, pid)
        # Second recovery with same code/lid but different credential must be conflict, not 500
        result = self.store.recover_installation(code, target, credential_hash=hashlib.sha256(cred_b.encode()).hexdigest())
        self.assertIsNone(result)
        with self.store._db() as conn:
            row = conn.execute("SELECT credential_hash FROM license_installations WHERE install_id = ?", (target,)).fetchone()
            self.assertEqual(row["credential_hash"], hashlib.sha256(cred_a.encode()).hexdigest())
        resp = self.client.post(
            "/dablaja/api/recover-license",
            json={"install_id": target, "code": code, "install_credential": cred_b},
            headers={"Origin": ALLOWED_ORIGIN},
        )
        self.assertEqual(resp.status_code, 403)


class RetentionPruningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = dablaja.DablajaStore(Path(self.tmp.name) / "dablaja.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_prune_removes_only_expired_abandoned_checkout_attempts(self):
        old = "2000-01-01T00:00:00+00:00"
        recent = dablaja.utc_now()
        with self.store._db() as conn:
            conn.executemany(
                """INSERT INTO checkout_attempts
                   (stripe_session_id, install_id, credential_hash, status, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                [
                    ("cs_old_pending", "p" * 24, "a" * 64, "pending", old),
                    ("cs_old_failed", "f" * 24, "b" * 64, "failed", old),
                    ("cs_recent_pending", "r" * 24, "c" * 64, "pending", recent),
                    ("cs_completed", "c" * 24, "d" * 64, "completed", old),
                ],
            )
            conn.execute(
                """INSERT INTO purchases
                   (id, stripe_session_id, status, created_at, activated_at)
                   VALUES (?, ?, 'active', ?, ?)""",
                (str(uuid.uuid4()), "cs_completed", old, old),
            )

        self.store.prune()

        self.assertIsNone(self.store.get_checkout_attempt("cs_old_pending"))
        self.assertIsNone(self.store.get_checkout_attempt("cs_old_failed"))
        self.assertIsNotNone(self.store.get_checkout_attempt("cs_recent_pending"))
        self.assertIsNotNone(self.store.get_checkout_attempt("cs_completed"))

    def test_prune_parses_iso_timestamps_at_retention_boundary(self):
        # ISO timestamps use a T/+00:00 form while SQLite datetime('now') uses
        # a space. datetime(created_at) must parse them instead of relying on
        # a lexical comparison that can retain boundary-day rows too long.
        with self.store._db() as conn:
            conn.execute(
                """INSERT INTO error_reports
                   (id, event_id, error_code, status, site_host,
                    extension_version, reconnect_count, created_at, dedupe_key)
                   VALUES (?, ?, 'unknown', 'error', 'other', '1.0.0', 0,
                           datetime('now', '-45 days', '-1 minute'), ?)""",
                (str(uuid.uuid4()), "retention-boundary-event", uuid.uuid4().hex),
            )
        self.store.prune()
        with self.store._db() as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM error_reports WHERE event_id = ?",
                ("retention-boundary-event",),
            ).fetchone()["n"]
        self.assertEqual(count, 0)


class AdminSessionTests(unittest.TestCase):
    def setUp(self):
        os.environ["DABLAJA_ALLOW_INSECURE_COOKIE"] = "1"
        self.tmp = tempfile.TemporaryDirectory()
        self.store = dablaja.DablajaStore(Path(self.tmp.name) / "dablaja.db")
        self.client = TestClient(make_app(self.store))
        self._origins = dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS
        dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS = [ALLOWED_ORIGIN]
        self._admin_token = dablaja.ADMIN_TOKEN
        self._admin_secret = dablaja.ADMIN_SESSION_SECRET
        dablaja.ADMIN_TOKEN = "admin-secret-token-xyz"
        dablaja.ADMIN_SESSION_SECRET = "session-secret-abc-1234567890"

    def tearDown(self):
        dablaja.DABLAJA_ALLOWED_EXTENSION_ORIGINS = self._origins
        dablaja.ADMIN_TOKEN = self._admin_token
        dablaja.ADMIN_SESSION_SECRET = self._admin_secret
        os.environ.pop("DABLAJA_ALLOW_INSECURE_COOKIE", None)
        self.tmp.cleanup()

    def test_admin_login_success_sets_signed_cookie_and_grants_access(self):
        # Starlette TestClient follows 303 by default, so we assert via history.
        resp = self.client.post("/dablaja/admin", data={"token": "admin-secret-token-xyz"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.history and resp.history[0].status_code == 303, "login must 303-redirect")
        redirect = resp.history[0]
        self.assertIn("dablaja_admin", redirect.headers.get("set-cookie", ""))
        cookie = redirect.headers.get("set-cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Path=/dablaja/admin", cookie)
        self.assertNotIn("admin-secret-token-xyz", resp.text)
        self.assertNotIn("admin-secret-token-xyz", cookie)
        # Follow-up GET should be authenticated via jar.
        page2 = self.client.get("/dablaja/admin")
        self.assertEqual(page2.status_code, 200)
        self.assertNotIn("admin-secret-token-xyz", page2.text)
        self.assertNotIn("session-secret-abc", page2.text)
        self.assertNotIn("token=", page2.text)

    def test_admin_login_failure_returns_generic_error(self):
        resp = self.client.post("/dablaja/admin", data={"token": "wrong"})
        self.assertEqual(resp.status_code, 401)
        self.assertNotIn("admin-secret-token-xyz", resp.text)

    def test_admin_login_rate_limit_blocks_authentication_attempts(self):
        with patch.object(dablaja, "ADMIN_LOGIN_DAILY_LIMIT", 0):
            resp = self.client.post("/dablaja/admin", data={"token": "admin-secret-token-xyz"})
        self.assertEqual(resp.status_code, 429)
        self.assertNotIn("admin-secret-token-xyz", resp.text)

    def test_admin_query_token_no_longer_accepted(self):
        resp = self.client.get("/dablaja/admin?token=admin-secret-token-xyz")
        self.assertEqual(resp.status_code, 401)
        self.assertNotIn("admin-secret-token-xyz", resp.text)

    def test_admin_expired_and_tampered_cookie_rejected(self):
        # Expired
        past = str(int(time.time()) - 3600)
        sig = hmac.new(dablaja.ADMIN_SESSION_SECRET.encode(), past.encode(), hashlib.sha256).hexdigest()
        expired = f"{past}.{sig}"
        resp = self.client.get("/dablaja/admin", cookies={"dablaja_admin": expired})
        self.assertEqual(resp.status_code, 401)
        # Tampered
        future = str(int(time.time()) + 600)
        tampered = f"{future}.{'0'*64}"
        resp2 = self.client.get("/dablaja/admin", cookies={"dablaja_admin": tampered})
        self.assertEqual(resp2.status_code, 401)

    def test_admin_logout_clears_cookie(self):
        from starlette.testclient import TestClient as _TC
        self.client.post("/dablaja/admin", data={"token": "admin-secret-token-xyz"})
        no_follow = _TC(make_app(self.store), follow_redirects=False)
        # Copy cookies into no-follow client so it carries the session.
        for k, v in self.client.cookies.items():
            no_follow.cookies.set(k, v)
        resp = no_follow.post("/dablaja/admin/logout")
        self.assertEqual(resp.status_code, 303)
        self.assertIn("Max-Age=0", resp.headers.get("set-cookie", ""))

    def test_admin_links_and_redirects_never_contain_token(self):
        login = self.client.post("/dablaja/admin", data={"token": "admin-secret-token-xyz"})
        page = self.client.get("/dablaja/admin?tab=errors")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn("admin-secret-token-xyz", page.text)
        self.assertNotIn("token=", page.text)
        self.assertNotIn("admin-secret-token-xyz", login.headers.get("location", ""))
        self.assertNotIn("admin-secret-token-xyz", login.headers.get("set-cookie", ""))

    def test_admin_missing_configuration_fails_closed(self):
        dablaja.ADMIN_SESSION_SECRET = ""
        resp = self.client.post("/dablaja/admin", data={"token": "admin-secret-token-xyz"})
        self.assertEqual(resp.status_code, 503)
        resp2 = self.client.get("/dablaja/admin")
        self.assertEqual(resp2.status_code, 503)
        # No secret in error bodies
        self.assertNotIn("admin-secret-token-xyz", resp.text)
        self.assertNotIn("session-secret", resp2.text)


if __name__ == "__main__":
    unittest.main()
