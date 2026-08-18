# Connecting Kimi K3 Multimodal Bridge to Cline (VS Code GUI)

This guide details how to connect the local Kimi K3 multimodal bridge (`http://127.0.0.1:8765/v1`) directly to **Cline** (or Roo-Cline / Claude Dev) in Visual Studio Code.

---

## 1. Start the Kimi Multimodal Bridge

Run the launcher script in PowerShell:

```powershell
cd "C:\Users\Yazan\Desktop\Projects\Arabic Live Dubbing"
.\start_kimi_bridge.ps1
```

Confirm health check:
```powershell
curl http://127.0.0.1:8765/health
```
Expected response:
```json
{"status":"ok","model":"kimi-k3-hf","features":{"text":true,"vision":true,"multimodal":true}}
```

---

## 2. Configure Cline in VS Code

1. Open **VS Code**.
2. Click on the **Cline** robot icon in the sidebar (or press `Ctrl+Shift+P` -> `Cline: Open in Sidebar`).
3. Click the **Settings (Gear Icon)** in the top right corner of the Cline panel.
4. Set the following fields:

| Field | Value | Notes |
|---|---|---|
| **API Provider** | `OpenAI Compatible` | Standard OpenAI format |
| **Base URL** | `http://127.0.0.1:8765/v1` | Local bridge URL |
| **API Key** | `dummy` (or any string) | Bridge ignores key validation |
| **Model ID** | `kimi-k3-hf` | Advertised Kimi model ID |
| **Supports Images** | Check / Toggle **ON** | Vision enabled |
| **Context Window** | `32768` (or `65536`) | High context capability |
| **Max Output Tokens**| `4096` | Output generation ceiling |

5. Click **Done / Save**.

---

## 3. How to Use Multimodal Features in Cline

### A. Screenshot / Image Debugging
- Simply paste an image (`Ctrl+V`) directly into the Cline chat prompt or click the image attachment button.
- Ask Kimi to inspect UI issues, compare against design mockups, or read error diagrams.
- The bridge will automatically decode the image, pass it to Kimi's vision pipeline, and clean up temporary files after generation.

### B. Agentic Coding & Repository Understanding
- Cline will provide repository context and request tool operations (`read_file`, `write_to_file`, `execute_command`).
- Kimi K3 natively outputs clean structured responses and tool invocation tags.

### C. Terminal & Automated Testing
- Cline can run commands in your terminal and pass error outputs back to Kimi K3 for iterative self-healing.

---

## 4. Troubleshooting

- **Proxy Error / Timeout**: Ensure your PowerShell session or VS Code environment respects localhost bypass:
  ```powershell
  $env:NO_PROXY="127.0.0.1,localhost"
  $env:no_proxy="127.0.0.1,localhost"
  ```
- **Port Conflict**: If port `8765` is busy:
  ```powershell
  Get-NetTCPConnection -LocalPort 8765 | Select-Object OwningProcess
  Stop-Process -Id <PID> -Force
  ```
