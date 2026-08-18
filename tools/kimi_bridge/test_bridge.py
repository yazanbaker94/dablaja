"""
Test Suite for Kimi K3 Local Bridge:
1. Health check
2. Model listing (/v1/models)
3. OpenAI-compatible single-turn completion (with clean reasoning extraction)
4. Multi-turn conversation context retention
"""
import sys
import json
import time
import requests

if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_URL = "http://127.0.0.1:8765"

def run_tests():
    print("=" * 70)
    print("KIMI K3 LOCAL BRIDGE TEST SUITE")
    print(f"Target: {BASE_URL}")
    print("=" * 70)

    # 1. Health Check
    print("\n[Test 1/4] GET /health ...")
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=10)
        assert r.status_code == 200, f"Expected status 200, got {r.status_code}: {r.text}"
        data = r.json()
        print(f"[PASS] Health OK: {json.dumps(data, indent=2)}")
        assert data.get("status") == "ok"
    except Exception as e:
        print(f"[FAIL] Health Check FAILED: {e}")
        return False

    # 2. Models Endpoint
    print("\n[Test 2/4] GET /v1/models ...")
    try:
        r = requests.get(f"{BASE_URL}/v1/models", timeout=10)
        assert r.status_code == 200, f"Expected status 200, got {r.status_code}: {r.text}"
        data = r.json()
        model_ids = [m["id"] for m in data.get("data", [])]
        print(f"[PASS] Models Available: {model_ids}")
        assert "kimi-k3-hf" in model_ids or "openai/kimi-k3-hf" in model_ids
    except Exception as e:
        print(f"[FAIL] Models Listing FAILED: {e}")
        return False

    # 3. Single-Turn Code Generation
    print("\n[Test 3/4] POST /v1/chat/completions (Single-Turn Code Generation) ...")
    prompt = (
        "Write a Python function that receives a list of integers and returns "
        "the three most frequent values. Include one unit test."
    )
    payload = {
        "model": "kimi-k3-hf",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
        "max_tokens": 2048,
        "stream": False
    }

    t0 = time.time()
    try:
        r = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=120)
        assert r.status_code == 200, f"Expected status 200, got {r.status_code}: {r.text}"
        resp = r.json()
        elapsed = time.time() - t0
        content = resp["choices"][0]["message"]["content"]
        print(f"[PASS] Single-turn response received in {elapsed:.2f}s!")
        print("\n--- Response Snippet (First 500 chars) ---")
        print(content[:500] + ("..." if len(content) > 500 else ""))
        print("------------------------------------------")
        assert len(content.strip()) > 20, "Response content is too short"
        assert "<think>" not in content and "</think>" not in content, "Reasoning tags were not stripped!"
    except Exception as e:
        print(f"[FAIL] Single-turn completion FAILED: {e}")
        return False

    # 4. Multi-Turn Conversation
    print("\n[Test 4/4] POST /v1/chat/completions (Multi-Turn Context Test) ...")
    turn1_user = "Write a Python function called normalize_name."
    turn1_payload = {
        "model": "kimi-k3-hf",
        "messages": [
            {"role": "user", "content": turn1_user}
        ],
        "temperature": 0.2,
        "max_tokens": 1024,
        "stream": False
    }

    t0 = time.time()
    try:
        print("Sending Turn 1...")
        r1 = requests.post(f"{BASE_URL}/v1/chat/completions", json=turn1_payload, timeout=120)
        assert r1.status_code == 200, f"Turn 1 error {r1.status_code}: {r1.text}"
        turn1_assistant = r1.json()["choices"][0]["message"]["content"]
        print(f"[PASS] Turn 1 received ({len(turn1_assistant)} chars).")

        turn2_user = "Now modify it so Arabic characters are preserved."
        turn2_payload = {
            "model": "kimi-k3-hf",
            "messages": [
                {"role": "user", "content": turn1_user},
                {"role": "assistant", "content": turn1_assistant},
                {"role": "user", "content": turn2_user}
            ],
            "temperature": 0.2,
            "max_tokens": 1024,
            "stream": False
        }
        print("Sending Turn 2 with history...")
        r2 = requests.post(f"{BASE_URL}/v1/chat/completions", json=turn2_payload, timeout=120)
        assert r2.status_code == 200, f"Turn 2 error {r2.status_code}: {r2.text}"
        turn2_assistant = r2.json()["choices"][0]["message"]["content"]
        elapsed = time.time() - t0
        print(f"[PASS] Turn 2 received in {elapsed:.2f}s total!")
        print("\n--- Turn 2 Snippet ---")
        print(turn2_assistant[:500] + ("..." if len(turn2_assistant) > 500 else ""))
        print("----------------------")
        assert "normalize_name" in turn2_assistant or "arabic" in turn2_assistant.lower() or "\u0600" in turn2_assistant, "Multi-turn context was not retained!"
    except Exception as e:
        print(f"[FAIL] Multi-turn completion FAILED: {e}")
        return False

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED SUCCESSFULLY!")
    print("=" * 70)
    return True

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
