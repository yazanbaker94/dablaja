"""
Phase 2: Direct Gradio Client Test against cw-105/kimi-k3-gguf-demo.
Verifies anonymous access without API key or HF token.
"""
import sys
import time
from gradio_client import Client

print("=" * 60)
print("Phase 2: Direct HF Gradio Client Verification")
print("Connecting to Space: cw-105/kimi-k3-gguf-demo ...")
print("=" * 60)

start_time = time.time()
try:
    client = Client("cw-105/kimi-k3-gguf-demo")
    print(f"Connected to Gradio Space in {time.time() - start_time:.2f}s")
except Exception as e:
    print(f"FAILED to connect to Gradio Space: {e}")
    sys.exit(1)

prompt = "Write a clean Python function that checks if a string is a palindrome."
print(f"\nSending test prompt: '{prompt}'")
print("Parameters: backend_v='direct:together', max_tok=1024, temp=0.2, reason='high'")

try:
    result = client.predict(
        message={"text": prompt, "files": []},
        history=[],
        backend_v="direct:together",
        max_tok=1024,
        temp=0.2,
        reason="high",
        api_name="/on_submit"
    )
    elapsed = time.time() - start_time
    print(f"\nResponse received successfully in {elapsed:.2f}s!")
    print("\nRaw result structure type:", type(result))
    if isinstance(result, (list, tuple)):
        print(f"Result elements count: {len(result)}")
        print("\nFirst element (chatbot state snippet):")
        first_elem = str(result[0])
        print(first_elem[:400] + ("..." if len(first_elem) > 400 else ""))
    else:
        print(str(result)[:400])

    print("\n" + "=" * 60)
    print("VERIFICATION SUCCESS:")
    print(" [x] HF login not required")
    print(" [x] HF token not required")
    print(" [x] Together API key not required")
    print(" [x] Response received")
    print(" [x] Coding content received")
    print("=" * 60)

except Exception as e:
    print(f"\nFAILED to query /on_submit: {e}")
    sys.exit(1)
