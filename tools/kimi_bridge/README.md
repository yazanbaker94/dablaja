# Kimi K3 Local Bridge for AI Coding

A lightweight, OpenAI-compatible local proxy that bridges coding tools like [Aider](https://aider.chat) to the public Hugging Face Space `cw-105/kimi-k3-gguf-demo` running `moonshotai/Kimi-K3` via Together AI.

---

## Architecture Overview

```text
┌─────────────────────────────────────────────────┐
│     Aider / Cursor / OpenAI-compatible Client   │
└───────────────────────┬─────────────────────────┘
                        │ HTTP POST (OpenAI format)
                        ▼
┌─────────────────────────────────────────────────┐
│       Local Bridge (http://127.0.0.1:8765)      │
│  - FastAPI server                               │
│  - Strips reasoning tokens (<think>...</think>) │
│  - Clean prompt & history serializer            │
└───────────────────────┬─────────────────────────┘
                        │ Gradio API (/on_submit)
                        ▼
┌─────────────────────────────────────────────────┐
│   Hugging Face Space (cw-105/kimi-k3-gguf-demo) │
└───────────────────────┬─────────────────────────┘
                        │ Together AI Inference
                        ▼
┌─────────────────────────────────────────────────┐
│             Moonshot AI Kimi-K3 (2.8T MoE)      │
└─────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Start the Bridge Server
In PowerShell:
```powershell
.\start_kimi_bridge.ps1
```
The server will start listening on `http://127.0.0.1:8765`.

### 2. Verify Health
```powershell
curl http://127.0.0.1:8765/health
```
Expected response:
```json
{
  "status": "ok",
  "space": "cw-105/kimi-k3-gguf-demo",
  "backend": "direct:together",
  "model": "moonshotai/Kimi-K3",
  "local_model_id": "kimi-k3-hf"
}
```

### 3. Launch Aider
In a separate terminal:
```powershell
.\start_kimi_aider.ps1
```
Or manually with:
```powershell
aider --model openai/kimi-k3-hf --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key dummy --no-stream
```

---

## Testing

Run the automated integration test suite:
```powershell
.\.venv-kimi\Scripts\python.exe tools/kimi_bridge/test_bridge.py
```
This tests:
1. `GET /health`
2. `GET /v1/models`
3. `POST /v1/chat/completions` (Single-turn code generation with clean reasoning stripping)
4. `POST /v1/chat/completions` (Multi-turn conversation context retention)

---

## Upstream Model Verification

The Hugging Face Space `cw-105/kimi-k3-gguf-demo` source code (`app.py`) defines:
- `BASE_MODEL = "moonshotai/Kimi-K3"`
- Backend: `direct:together` routes to `https://api.together.xyz/v1` targeting `moonshotai/Kimi-K3`.

---

## Limitations & Stability Notes

- **Community Endpoint:** The upstream Hugging Face space is community-hosted. It may sleep, rate-limit, change behavior, or stop being free at any time.
- **Streaming:** The local bridge currently operates in non-streaming mode (`--no-stream` / `stream: false`).
- **Response Latency:** Hosted inference and reasoning chains typically take 15–40 seconds per turn.
- **Proxy Considerations:** If using local corporate proxies (e.g., `127.0.0.1:8080`), ensure `NO_PROXY=localhost,127.0.0.1` is set (which is standard).
