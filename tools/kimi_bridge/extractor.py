"""
Extractor and cleaning functions for Gradio Chatbot output from cw-105/kimi-k3-gguf-demo.
"""
import re
from typing import Any, List, Optional, Tuple


def _extract_text_from_content(content: Any) -> str:
    """Extract plain text from various content representations."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and "text" in part:
                parts.append(part["text"])
        return "\n".join(parts)
    if isinstance(content, dict) and "text" in content:
        return content["text"]
    return str(content) if content is not None else ""


def extract_assistant_text_from_gradio_output(gradio_result: Any) -> str:
    """
    Extracts the clean assistant response from Gradio client prediction result.
    Handles Gradio 4/5 Chatbot component format where reasoning tags (<think>...</think>)
    are split into separate messages:
      - marker chunks (e.g. '<', '>')
      - reasoning chunk: metadata={'title': 'Reasoning', 'status': 'done'}
      - final answer chunk(s): metadata=None, content='>Actual response...'
    """
    if gradio_result is None:
        return ""

    if isinstance(gradio_result, str):
        return clean_reasoning_and_response(gradio_result)

    # If tuple or list, first element is typically the chatbot component output
    history = gradio_result
    if isinstance(gradio_result, (list, tuple)) and len(gradio_result) > 0:
        first_item = gradio_result[0]
        if isinstance(first_item, list):
            history = first_item
        elif isinstance(first_item, (dict, tuple)):
            history = gradio_result

    if not isinstance(history, list) or len(history) == 0:
        return clean_reasoning_and_response(str(gradio_result))

    # Find the index of the last user message
    last_user_idx = -1
    for i, msg in enumerate(history):
        if isinstance(msg, dict) and msg.get("role") == "user":
            last_user_idx = i

    # Collect assistant messages following the last user message
    candidate_messages = history[last_user_idx + 1:] if last_user_idx != -1 else history

    answer_chunks: List[str] = []
    reasoning_chunks: List[str] = []

    for item in candidate_messages:
        if isinstance(item, dict):
            role = item.get("role")
            if role != "assistant":
                continue

            metadata = item.get("metadata") or {}
            title = metadata.get("title", "")
            raw_text = _extract_text_from_content(item.get("content", ""))
            stripped = raw_text.strip()

            # Skip pure delimiters like '<', '>', '</'
            if stripped in {"<", ">", "</", "…", "..."}:
                continue

            if title.lower() == "reasoning":
                # Strip leading '>' and trailing '</' if present
                clean_reason = stripped
                if clean_reason.startswith(">"):
                    clean_reason = clean_reason[1:].strip()
                if clean_reason.endswith("</"):
                    clean_reason = clean_reason[:-2].strip()
                reasoning_chunks.append(clean_reason)
            else:
                # Normal answer chunk
                clean_answer = stripped
                if clean_answer.startswith(">"):
                    clean_answer = clean_answer[1:].lstrip()
                answer_chunks.append(clean_answer)

        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            bot_msg = _extract_text_from_content(item[1])
            if bot_msg.strip():
                answer_chunks.append(bot_msg.strip())

    if answer_chunks:
        full_answer = "\n\n".join(answer_chunks).strip()
        return clean_reasoning_and_response(full_answer)

    # If no normal answer chunks found, check reasoning chunks or fallback
    if reasoning_chunks:
        combined_reasoning = "\n\n".join(reasoning_chunks).strip()
        return clean_reasoning_and_response(combined_reasoning)

    # Final fallback: string of last item
    return clean_reasoning_and_response(str(history[-1]))


def clean_reasoning_and_response(text: str) -> str:
    """
    Cleans reasoning tokens (<think>...</think>), status markers, and artifacts.
    Ensures safe fallback to the whole content if stripping reasoning leaves nothing.
    """
    if not isinstance(text, str):
        return str(text) if text is not None else ""

    raw = text.strip()
    if not raw:
        return ""

    # Check for complete </think> tag
    if "</think>" in raw:
        parts = raw.split("</think>")
        final_answer = parts[-1].strip()
        if final_answer:
            raw = final_answer
        else:
            content_inside = parts[0]
            if "<think>" in content_inside:
                content_inside = content_inside.split("<think>", 1)[1].strip()
            if content_inside:
                raw = content_inside

    if "<think>" in raw and "</think>" not in raw:
        cleaned = raw.replace("<think>", "").strip()
        if cleaned:
            raw = cleaned

    # Strip leading '>' if left over from Gradio format
    if raw.startswith(">"):
        raw = raw[1:].lstrip()

    # Remove isolated marker artifacts
    lines = raw.splitlines()
    filtered_lines = []
    for line in lines:
        stripped_line = line.strip()
        if stripped_line in {"<", ">", "</", "…", "..."}:
            continue
        filtered_lines.append(line)

    cleaned_text = "\n".join(filtered_lines).strip()
    return cleaned_text if cleaned_text else raw
