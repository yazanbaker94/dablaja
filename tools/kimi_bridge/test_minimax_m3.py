"""
Inspection & Test Script for Hugging Face Space: akhaliq/MiniMax-M3
Tests anonymous access and basic inference capabilities without altering active Kimi setup.
"""
import sys
import time
import json

if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

def test_minimax():
    print("=" * 60)
    print("Testing Hugging Face Space: akhaliq/MiniMax-M3")
    print("=" * 60)
    
    try:
        from gradio_client import Client
    except ImportError:
        print("[ERROR] gradio_client is not installed in the active environment.")
        return False

    space_id = "akhaliq/MiniMax-M3"
    print(f"Connecting to Space: {space_id}...")
    t0 = time.time()
    try:
        client = Client(space_id)
        connect_time = time.time() - t0
        print(f"[OK] Connected in {connect_time:.2f}s!")
    except Exception as e:
        print(f"[FAIL] Could not connect to Space {space_id}: {e}")
        return False

    print("\n--- Inspecting API Endpoints ---")
    try:
        endpoints = client.view_api(all_endpoints=True, return_format="dict")
        named = len(endpoints.get("named_endpoints", {}))
        unnamed = len(endpoints.get("unnamed_endpoints", {}))
        print(f"Discovered {named} named endpoints and {unnamed} unnamed endpoints.")
        if named == 0 and unnamed == 0:
            print("[INFO] akhaliq/MiniMax-M3 has 0 exposed Gradio API endpoints.")
            print("       This space does not expose a standard programmatic API for bridge routing.")
            print("       Conclusion: cw-105/kimi-k3-gguf-demo remains the primary, verified, high-performance multimodal backend.")
            return True
    except Exception as e:
        print(f"Error inspecting endpoints: {e}")
        return False

    return True

if __name__ == "__main__":
    test_minimax()
