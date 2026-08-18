"""
Integration test for OpenAI-compatible Multimodal / Vision endpoint on Kimi Bridge.
Tests base64 image_url submission and verifies that Kimi K3 understands the image.
"""
import os
import sys
import base64
import json
import time
import requests

if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_URL = "http://127.0.0.1:8765"


def run_vision_bridge_test():
    print("=" * 70)
    print("KIMI K3 LOCAL BRIDGE — MULTIMODAL VISION INTEGRATION TEST")
    print(f"Target: {BASE_URL}")
    print("=" * 70)

    # 1. Check health
    print("\n[Step 1/3] Checking bridge health at /health ...")
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=5)
        assert r.status_code == 200, f"Health check failed: {r.status_code}"
        health = r.json()
        print(f"Bridge healthy: {health.get('model')} (vision={health.get('features', {}).get('vision')})")
    except Exception as e:
        print(f"Bridge not reachable at {BASE_URL}: {e}")
        return False

    # 2. Prepare test image
    print("\n[Step 2/3] Loading and encoding vision_test.png ...")
    asset_dir = os.path.join(os.path.dirname(__file__), "test_assets")
    img_path = os.path.join(asset_dir, "vision_test.png")
    if not os.path.exists(img_path):
        print(f"Test image not found at {img_path}")
        return False

    with open(img_path, "rb") as f:
        img_bytes = f.read()

    b64_str = base64.b64encode(img_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64_str}"
    print(f"Image encoded: {len(img_bytes)} bytes -> data URL of {len(data_url)} chars")

    # 3. Send multimodal request to /v1/chat/completions
    print("\n[Step 3/3] Sending OpenAI-compatible multimodal POST /v1/chat/completions ...")
    payload = {
        "model": "kimi-k3-hf",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Read this image carefully.\n"
                            "What is the exact VISION-CODE shown?\n"
                            "Identify the two colored shapes."
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url
                        }
                    }
                ]
            }
        ],
        "temperature": 0.2,
        "max_tokens": 2048,
        "stream": False
    }

    t0 = time.time()
    try:
        r = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=120)
        assert r.status_code == 200, f"HTTP Error {r.status_code}: {r.text}"
        data = r.json()
        elapsed = time.time() - t0
        content = data["choices"][0]["message"]["content"]

        print(f"Response received in {elapsed:.2f}s!")
        print("\n--- Assistant Vision Output ---")
        print(content)
        print("--------------------------------\n")

        code_match = "7429" in content or "VISION-CODE-7429" in content
        blue_match = "blue" in content.lower() or "rectangle" in content.lower() or "مستطيل" in content.lower() or "أزرق" in content.lower()
        red_match = "red" in content.lower() or "circle" in content.lower() or "دائرة" in content.lower() or "أحمر" in content.lower()

        print("Validation Results:")
        print(f"  [x] Code recognized (7429):     {code_match}")
        print(f"  [x] Blue shape recognized:      {blue_match}")
        print(f"  [x] Red shape recognized:       {red_match}")

        assert code_match, "Kimi failed to extract VISION-CODE-7429"
        assert blue_match, "Kimi failed to identify blue rectangle"
        assert red_match, "Kimi failed to identify red circle"

        print("\n" + "=" * 70)
        print("MULTIMODAL BRIDGE TEST PASSED SUCCESSFULLY!")
        print("=" * 70)
        return True

    except Exception as e:
        print(f"\nMultimodal bridge test FAILED: {e}")
        return False


if __name__ == "__main__":
    ok = run_vision_bridge_test()
    sys.exit(0 if ok else 1)
