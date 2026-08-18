from gradio_client import Client

client = Client("cw-105/kimi-k3-gguf-demo")

prompt = """[Previous Conversation]
User: Write a Python function called normalize_name.
Assistant:
```python
import re

def normalize_name(name: str) -> str:
    name = name.strip()
    name = re.sub(r'\\s+', ' ', name)
    return name.title()
```

[Current User Request]
Now modify it so Arabic characters are preserved and properly normalized."""

result = client.predict(
    message={"text": prompt, "files": []},
    history=[],
    backend_v="direct:together",
    max_tok=4096,
    temp=0.2,
    reason="default",
    api_name="/on_submit"
)

from extractor import extract_assistant_text_from_gradio_output
clean_text = extract_assistant_text_from_gradio_output(result)
print("Result:")
print(clean_text)
assert "normalize_name" in clean_text
print("\nMulti-turn serialization test PASSED!")
