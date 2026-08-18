import json
from gradio_client import Client

client = Client("cw-105/kimi-k3-gguf-demo")
result = client.predict(
    message={"text": "Write a python function to add two numbers.", "files": []},
    history=[],
    backend_v="direct:together",
    max_tok=512,
    temp=0.2,
    reason="high",
    api_name="/on_submit"
)

print("Full result structure:")
history = result[0]
for idx, msg in enumerate(history):
    print(f"\n--- Message {idx} ---")
    print(f"Role: {msg.get('role')}")
    print(f"Metadata: {msg.get('metadata')}")
    print(f"Content: {json.dumps(msg.get('content'), indent=2)}")
