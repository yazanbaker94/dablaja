"""
Comprehensive Agent & Multimodal Harness Simulation Test:
Simulates Cline GUI & Aider agent workflows against Kimi K3 Local Bridge:
  1. Cline Handshake / Ping ("CLINE KIMI CONNECTED")
  2. Cline Screenshot / Multimodal Vision Input (VISION-CODE-7429)
  3. Repository Understanding & Citation (src/shared/protocol.js, etc.)
  4. Agent Tool / File Operation Format (XML/Text tool invocation)
  5. Code Reasoning on existing WebSocket 1000 fix
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


def send_chat(messages, max_tokens=2048, temperature=0.2):
    payload = {
        "model": "kimi-k3-hf",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False
    }
    t0 = time.time()
    r = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=120)
    elapsed = time.time() - t0
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text}")
    data = r.json()
    content = data["choices"][0]["message"]["content"]
    return content, elapsed


def test_1_cline_handshake():
    print("\n" + "=" * 65)
    print("[TEST 1/5] Cline Handshake & Text Connectivity")
    print("=" * 65)
    messages = [
        {"role": "user", "content": "Reply with exactly: CLINE KIMI CONNECTED"}
    ]
    content, elapsed = send_chat(messages, max_tokens=128)
    print(f"Response ({elapsed:.2f}s): {content.strip()}")
    assert "CLINE KIMI CONNECTED" in content.upper(), "Handshake phrase not found"
    print("[PASS] Handshake successful!")
    return True


def test_2_cline_screenshot_vision():
    print("\n" + "=" * 65)
    print("[TEST 2/5] Cline Screenshot / Image Attachment Understanding")
    print("=" * 65)
    asset_path = os.path.join(os.path.dirname(__file__), "test_assets", "vision_test.png")
    with open(asset_path, "rb") as f:
        b64_data = base64.b64encode(f.read()).decode("ascii")

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Read this attached screenshot from the coding environment.\n"
                        "1. What is the exact VISION-CODE shown?\n"
                        "2. Identify the two colored shapes.\n"
                        "Format your answer concisely."
                    )
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{b64_data}"
                    }
                }
            ]
        }
    ]
    content, elapsed = send_chat(messages, max_tokens=1024)
    print(f"Response ({elapsed:.2f}s):\n{content.strip()}\n")
    assert "7429" in content or "VISION-CODE-7429" in content, "Code 7429 missing"
    assert "blue" in content.lower() or "rectangle" in content.lower(), "Blue shape missing"
    assert "red" in content.lower() or "circle" in content.lower(), "Red shape missing"
    print("[PASS] Cline vision attachment understood perfectly!")
    return True


def test_3_repo_understanding():
    print("\n" + "=" * 65)
    print("[TEST 3/5] Repository Understanding & Accurate File Citation")
    print("=" * 65)
    prompt = (
        "You are inspecting the repository 'Arabic Live Dubbing'.\n"
        "Here are key files in the workspace:\n"
        " - manifest.json (Chrome Extension manifest)\n"
        " - src/background.js (service worker entry)\n"
        " - src/shared/protocol.js (Gemini Live WebSocket protocol & caption parser)\n"
        " - src/shared/audio-utils.js (audio buffer/capture utils)\n"
        " - src/library/library.html / library.js (Plus saved sessions UI)\n"
        " - tests/protocol.test.js (protocol test suite)\n\n"
        "Identify:\n"
        "1. The primary extension entry points\n"
        "2. The main audio-processing module\n"
        "3. Where WebSocket connections to Gemini Live API are handled\n"
        "4. Where tests are located\n"
        "Cite the exact filenames in your answer."
    )
    messages = [{"role": "user", "content": prompt}]
    content, elapsed = send_chat(messages, max_tokens=1024)
    print(f"Response ({elapsed:.2f}s):\n{content.strip()[:500]}...\n")
    assert "protocol.js" in content, "Failed to cite protocol.js"
    assert "background.js" in content or "manifest.json" in content, "Failed to cite entry points"
    assert "audio-utils.js" in content or "audio" in content.lower(), "Failed to cite audio module"
    assert "protocol.test.js" in content or "tests" in content.lower(), "Failed to cite test location"
    print("[PASS] Repository structure and citations verified!")
    return True


def test_4_agent_tool_invocation():
    print("\n" + "=" * 65)
    print("[TEST 4/5] Agent Tool Calling (XML / Action Format)")
    print("=" * 65)
    system_prompt = (
        "You are an AI coding assistant operating in a tool-based CLI harness.\n"
        "Whenever asked to generate or modify a file, you must output your response in this XML format:\n"
        "<write_to_file>\n<path>filepath</path>\n<content>file content</content>\n</write_to_file>"
    )
    user_prompt = (
        "Please output the tool action to create the file 'tools/kimi_bridge/cline_agent_test.txt' "
        "with content 'Kimi K3 Cline tool test successful.'"
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]
    content, elapsed = send_chat(messages, max_tokens=512)
    print(f"Response ({elapsed:.2f}s):\n{content.strip()}\n")
    assert "write_to_file" in content or "cline_agent_test.txt" in content, "Tool invocation not produced"
    assert "Kimi K3 Cline tool test successful" in content or "cline_agent_test.txt" in content, "Expected content or path missing"
    print("[PASS] Agent tool generation validated!")
    return True


def test_5_code_reasoning():
    print("\n" + "=" * 65)
    print("[TEST 5/5] Deep Code Reasoning on WebSocket Code-1000 Fix")
    print("=" * 65)
    code_context = (
        "In `src/shared/protocol.js`, the WebSocket close handler has:\n"
        "```javascript\n"
        "if (event.code === 1000) {\n"
        "  // Normal closure — session ended cleanly by server or client\n"
        "  return { isTerminal: true, isError: false };\n"
        "}\n"
        "```\n"
        "Explain why distinguishing WebSocket code 1000 (normal closure) from abnormal "
        "closures (e.g. 1006 or 1011) is essential for speech/dubbing reconnect loops."
    )
    messages = [{"role": "user", "content": code_context}]
    content, elapsed = send_chat(messages, max_tokens=1024)
    print(f"Response ({elapsed:.2f}s):\n{content.strip()[:600]}...\n")
    assert "1000" in content, "Code 1000 not discussed"
    assert "reconnect" in content.lower() or "close" in content.lower() or "loop" in content.lower(), "Reasoning lacks reconnect/closure concepts"
    print("[PASS] Deep code reasoning verified!")
    return True


def run_all():
    print("=" * 70)
    print("RUNNING ALL AGENT SIMULATION TESTS")
    print("=" * 70)
    results = [
        test_1_cline_handshake(),
        test_2_cline_screenshot_vision(),
        test_3_repo_understanding(),
        test_4_agent_tool_invocation(),
        test_5_code_reasoning()
    ]
    if all(results):
        print("\n" + "=" * 70)
        print("ALL 5 AGENT & VISION HARNESS TESTS PASSED!")
        print("=" * 70)
        return True
    return False


if __name__ == "__main__":
    ok = run_all()
    sys.exit(0 if ok else 1)
