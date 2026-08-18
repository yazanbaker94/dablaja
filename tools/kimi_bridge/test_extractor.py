import json
from extractor import extract_assistant_text_from_gradio_output

# Mock data matching the exact Gradio structure
sample_gradio_output = ([
    {'role': 'user', 'metadata': None, 'content': [{'text': 'Write a python function to add two numbers.', 'type': 'text'}], 'options': None},
    {'role': 'assistant', 'metadata': None, 'content': [{'text': '<', 'type': 'text'}], 'options': None},
    {'role': 'assistant', 'metadata': {'title': 'Reasoning', 'status': 'done'}, 'content': [{'text': '>The user is asking for a simple Python function to add two numbers. This is a very basic programming request. Let me write a clean, simple function with a docstring and maybe show an example of usage.\n\nThis is a simple request, so I should keep my response concise but helpful. I\'ll provide the function with a docstring (good practice) and a brief example.</', 'type': 'text'}], 'options': None},
    {'role': 'assistant', 'metadata': None, 'content': [{'text': '>\n\nHere\'s a simple Python function to add two numbers:\n\n```python\ndef add_numbers(a, b):\n    """\n    Add two numbers and return the result.\n    """\n    return a + b\n```\n', 'type': 'text'}], 'options': None}
], None)

clean_result = extract_assistant_text_from_gradio_output(sample_gradio_output)
print("Extracted clean result:")
print("=" * 40)
print(clean_result)
print("=" * 40)
assert "def add_numbers" in clean_result, "Function definition missing!"
assert "The user is asking" not in clean_result, "Reasoning thought was not stripped!"
assert not clean_result.startswith(">"), "Leading > was not stripped!"
print("Extractor unit test PASSED!")
