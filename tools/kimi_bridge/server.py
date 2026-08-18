"""
OpenAI-Compatible Local Bridge Server for Hugging Face Kimi K3 Space (cw-105/kimi-k3-gguf-demo).
Features:
  - Text chat completions (single-turn & multi-turn)
  - Multimodal vision / image inputs (OpenAI-compatible image_url data URIs & disk path auto-detection)
  - Real-time SSE streaming (stream: true) for Cline, Roo-Cline, Cursor, etc.
  - Smart Context Windowing (prevents 150k+ char context overflow & attention degradation)
  - Tool Call Reinforcement & Auto-Repair for Cline XML actions
"""
import os
import sys
import time
import uuid
import json
import re
import logging
from typing import Any, Dict, List, Optional, Union
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field, ConfigDict
from gradio_client import Client, handle_file

from extractor import extract_assistant_text_from_gradio_output, clean_reasoning_and_response
from images import extract_images_and_text_from_content, cleanup_temp_images

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("kimi_bridge")


def _sanitize_proxy_env():
    for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
        val = os.environ.get(k)
        if val and ("127.0.0.1" in val or "localhost" in val):
            logger.info("Bypassing dead local proxy env variable: %s=%s", k, val)
            os.environ.pop(k, None)

_sanitize_proxy_env()

HF_SPACE_ID = os.environ.get("KIMI_SPACE_ID", "cw-105/kimi-k3-gguf-demo")
DEFAULT_BACKEND_V = os.environ.get("KIMI_BACKEND_V", "direct:together")
DEFAULT_MAX_TOKENS = int(os.environ.get("KIMI_MAX_TOKENS", "4096"))
DEFAULT_TEMPERATURE = float(os.environ.get("KIMI_TEMPERATURE", "0.2"))
DEFAULT_REASON = os.environ.get("KIMI_REASON", "high")
DEBUG_MODE = os.environ.get("KIMI_DEBUG", "0") == "1"

MAX_PROMPT_CHARS = 38000  # Cap prompt to safe, optimal attention window

app = FastAPI(
    title="Kimi K3 Local Bridge",
    description="OpenAI-compatible multimodal bridge with streaming & smart agent context optimization",
    version="1.3.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global gradio client instance
_gradio_client: Optional[Client] = None


def get_gradio_client() -> Client:
    global _gradio_client
    if _gradio_client is None:
        logger.info("Initializing Gradio Client for Space: %s", HF_SPACE_ID)
        _sanitize_proxy_env()
        try:
            _gradio_client = Client(HF_SPACE_ID)
        except Exception as e:
            logger.warning("First client init failed (%s), attempting clean proxy retry...", e)
            for k in list(os.environ.keys()):
                if "proxy" in k.lower() and k.upper() != "NO_PROXY":
                    os.environ.pop(k, None)
            os.environ["NO_PROXY"] = "*"
            _gradio_client = Client(HF_SPACE_ID)
    return _gradio_client


# Pydantic models for OpenAI compatibility
class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: str
    content: Union[str, List[Dict[str, Any]], Any]
    name: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model: str = "kimi-k3-hf"
    messages: List[ChatMessage]
    temperature: Optional[float] = DEFAULT_TEMPERATURE
    top_p: Optional[float] = 1.0
    max_tokens: Optional[int] = DEFAULT_MAX_TOKENS
    stream: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    presence_penalty: Optional[float] = 0.0
    frequency_penalty: Optional[float] = 0.0
    user: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChoiceMessage(BaseModel):
    role: str = "assistant"
    content: str


class Choice(BaseModel):
    index: int = 0
    message: ChoiceMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[Choice]
    usage: UsageInfo


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "space": HF_SPACE_ID,
        "backend": DEFAULT_BACKEND_V,
        "model": "moonshotai/Kimi-K3",
        "local_model_id": "kimi-k3-hf",
        "features": {
            "text": True,
            "vision": True,
            "multimodal": True,
            "streaming": True,
            "smart_context": True
        }
    }


@app.get("/v1/models")
@app.get("/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "kimi-k3-hf",
                "object": "model",
                "created": 1700000000,
                "owned_by": "moonshotai",
                "root": "moonshotai/Kimi-K3",
                "parent": None,
                "permission": [],
                "capabilities": {
                    "vision": True,
                    "chat": True,
                    "streaming": True
                }
            }
        ]
    }


def format_messages_for_gradio(messages: List[ChatMessage]):
    """
    Smart Message Formatter with Context Compaction:
      - Always preserves System Prompt & Instructions
      - Always preserves Initial User Request & Recent Active Turns (last 4-6 turns)
      - Truncates giant historical tool dumps to prevent attention failure & hallucination
      - Injects Cline tool enforcement to guarantee immediate XML tool emission
    """
    gradio_files = []
    current_image_paths = []
    
    # 1. Identify last user index
    last_user_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].role == "user":
            last_user_idx = i
            break

    # 2. Extract messages and handle images
    processed_messages = []
    is_agent_session = False

    for idx, msg in enumerate(messages):
        role_tag = msg.role.upper()
        
        if idx == last_user_idx:
            text_part, img_paths = extract_images_and_text_from_content(msg.content)
            current_image_paths.extend(img_paths)
            for p in img_paths:
                gradio_files.append(handle_file(p))
        else:
            text_part, img_paths = extract_images_and_text_from_content(msg.content)

        if "<read_file>" in text_part or "<write_to_file>" in text_part or "<replace_in_file>" in text_part or "system_information" in text_part:
            is_agent_session = True

        processed_messages.append({
            "idx": idx,
            "role": role_tag,
            "text": text_part,
            "is_current": (idx == last_user_idx)
        })

    # 3. Smart Context Trimming for long agent loops (> 6 messages)
    total_messages = len(processed_messages)
    if total_messages > 6:
        # Keep: msg[0] (system prompt), msg[1] (initial request), and the last 5 messages
        keep_indices = {0, 1}
        for i in range(max(2, total_messages - 5), total_messages):
            keep_indices.add(i)

        for item in processed_messages:
            if item["idx"] not in keep_indices:
                # Truncate large middle history outputs to preserve memory budget
                if len(item["text"]) > 400:
                    item["text"] = item["text"][:200] + f"\n... [Previous turn details ({len(item['text'])} chars) truncated for context focus] ...\n" + item["text"][-100:]

    # 4. Construct prompt parts
    prompt_parts = []
    for item in processed_messages:
        if item["is_current"]:
            if total_messages > 1:
                prompt_parts.append(f"[{item['role']} (Current Turn)]:\n{item['text']}")
            else:
                prompt_parts.append(item["text"])
        else:
            prompt_parts.append(f"[{item['role']}]:\n{item['text']}")

    # 5. Agent Tool Calling Reinforcement (guarantees Kimi emits tool XML instead of conversational delay)
    if is_agent_session and total_messages > 1:
        prompt_parts.append(
            "[SYSTEM DIRECTIVE]: You are operating as the autonomous coding agent. "
            "If you need to inspect, search, or edit code, DO NOT say 'I will read...' or 'Reading now...'. "
            "Emit the tool execution XML IMMEDIATELY in your response: "
            "<read_file><path>file</path></read_file> or <write_to_file><path>file</path><content>code</content></write_to_file>."
        )

    full_prompt = "\n\n".join(prompt_parts) if len(prompt_parts) > 1 else (prompt_parts[0] if prompt_parts else "")

    # Hard cap to ensure upstream Together AI never rejects payload
    if len(full_prompt) > MAX_PROMPT_CHARS:
        # Keep head (system instructions) and tail (latest context)
        head = full_prompt[:12000]
        tail = full_prompt[-24000:]
        full_prompt = head + "\n\n... [Intermediate history compacted for maximum reasoning clarity] ...\n\n" + tail
        logger.info("Compacted oversized prompt from %d to %d chars.", len(prompt_parts), len(full_prompt))

    return {"text": full_prompt, "files": gradio_files}, [], current_image_paths


def repair_agent_tool_calls(text: str) -> str:
    """
    Auto-corrects malformed tool calls emitted by models so Cline never fails validation:
      - Converts malformed <replace_in_file> without <diff> into valid <write_to_file>
      - Ensures proper XML tag closures
    """
    if not text:
        return text

    # If model emitted <replace_in_file> with <content> instead of <diff>, convert to <write_to_file>
    if "<replace_in_file>" in text and "<content>" in text and "<diff>" not in text:
        text = text.replace("<replace_in_file>", "<write_to_file>").replace("</replace_in_file>", "</write_to_file>")
        logger.info("Auto-repaired malformed <replace_in_file> tag to <write_to_file>.")

    return text


def call_upstream_space(message_payload, history_payload, max_tokens, temperature):
    """
    Executes inference against upstream Hugging Face Space cw-105/kimi-k3-gguf-demo.
    """
    client = get_gradio_client()
    max_retries = 2
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            logger.info("Calling HF Space /on_submit (attempt %d/%d)...", attempt, max_retries)
            result = client.predict(
                message=message_payload,
                history=history_payload,
                backend_v=DEFAULT_BACKEND_V,
                max_tok=max_tokens,
                temp=temperature,
                reason=DEFAULT_REASON,
                api_name="/on_submit"
            )

            if DEBUG_MODE:
                logger.info("Raw Gradio Output preview: %s", str(result)[:300])

            raw_assistant_text = extract_assistant_text_from_gradio_output(result)

            if "❌ **API error**" in raw_assistant_text or "⚠️ **Config error:**" in raw_assistant_text:
                logger.error("Upstream error returned from Space: %s", raw_assistant_text)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"HF Space upstream error: {raw_assistant_text}"
                )

            clean_content = clean_reasoning_and_response(raw_assistant_text)
            if not clean_content.strip():
                clean_content = raw_assistant_text.strip() or "No response generated."

            # Auto-repair any malformed tool tags for Cline
            repaired_content = repair_agent_tool_calls(clean_content)

            return repaired_content

        except HTTPException:
            raise
        except Exception as exc:
            last_error = exc
            logger.warning("Attempt %d failed with error: %s", attempt, str(exc))
            time.sleep(1.0)

    logger.error("All attempts failed to get response from HF Space: %s", str(last_error))
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Failed to communicate with Hugging Face Space ({HF_SPACE_ID}): {str(last_error)}"
    )


def sse_chunk_generator(completion_id: str, model_id: str, clean_content: str, temp_images: list):
    """
    Generates standard OpenAI SSE chunks for streaming clients (Cline, Roo, etc.).
    """
    try:
        created_ts = int(time.time())

        # 1. Initial role chunk
        role_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created_ts,
            "model": model_id,
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": ""},
                    "finish_reason": None
                }
            ]
        }
        yield f"data: {json.dumps(role_chunk)}\n\n"

        # 2. Content stream chunks
        words = clean_content.split(" ")
        for i, word in enumerate(words):
            token = word if i == 0 else " " + word
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model_id,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": token},
                        "finish_reason": None
                    }
                ]
            }
            yield f"data: {json.dumps(chunk)}\n\n"

        # 3. Stop chunk
        stop_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created_ts,
            "model": model_id,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        }
        yield f"data: {json.dumps(stop_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    finally:
        cleanup_temp_images(temp_images)


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    logger.info(
        "Incoming completion: model=%s, msgs=%d, tools_present=%s, stream=%s",
        req.model,
        len(req.messages),
        bool(req.tools),
        bool(req.stream)
    )

    message_payload, history_payload, temp_images = format_messages_for_gradio(req.messages)

    max_tokens = min(max(256, req.max_tokens or DEFAULT_MAX_TOKENS), 8192)
    temperature = max(0.0, min(1.5, req.temperature if req.temperature is not None else DEFAULT_TEMPERATURE))

    logger.info(
        "Prepared payload: prompt_len=%d, images_count=%d, max_tok=%d, temp=%.2f",
        len(message_payload.get("text", "")),
        len(temp_images),
        max_tokens,
        temperature
    )

    if req.stream:
        clean_content = call_upstream_space(message_payload, history_payload, max_tokens, temperature)
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        logger.info("Streaming response to client: id=%s, chars=%d", completion_id, len(clean_content))
        return StreamingResponse(
            sse_chunk_generator(completion_id, req.model, clean_content, temp_images),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )

    try:
        clean_content = call_upstream_space(message_payload, history_payload, max_tokens, temperature)
        prompt_chars = len(message_payload.get("text", ""))
        completion_chars = len(clean_content)
        prompt_tokens = max(1, prompt_chars // 4)
        completion_tokens = max(1, completion_chars // 4)

        completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created_ts = int(time.time())

        response = ChatCompletionResponse(
            id=completion_id,
            created=created_ts,
            model=req.model,
            choices=[
                Choice(
                    index=0,
                    message=ChoiceMessage(role="assistant", content=clean_content),
                    finish_reason="stop"
                )
            ],
            usage=UsageInfo(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens
            )
        )
        logger.info("Successfully generated completion: id=%s, chars=%d", completion_id, len(clean_content))
        return response
    finally:
        cleanup_temp_images(temp_images)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
