# Strip any broken local proxy settings before importing or calling Gradio
for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
    val = os.environ.get(k)
    if val and ("127.0.0.1" in val or "localhost" in val):
        os.environ.pop(k, None)

try:
    from gradio_client import Client
    from extractor import extract_assistant_text_from_gradio_output
except ImportError as e:
    print(f"Missing dependencies: {e}")
    print("Run using: .venv-kimi\\Scripts\\python.exe chat_kimi.py")
    sys.exit(1)


def main():
    print("=" * 60)
    print(" Connecting to Kimi K3 (cw-105/kimi-k3-gguf-demo)...")
    print("=" * 60)

    try:
        try:
            client = Client("cw-105/kimi-k3-gguf-demo")
        except Exception:
            for k in list(os.environ.keys()):
                if "proxy" in k.lower() and k.upper() != "NO_PROXY":
                    os.environ.pop(k, None)
            os.environ["NO_PROXY"] = "*"
            client = Client("cw-105/kimi-k3-gguf-demo")
        print("Connected! Type your message below.")

        print("Special commands: 'exit' or 'quit' to close, 'clear' to reset chat.")
        print("=" * 60)
    except Exception as e:
        print(f"Failed to connect to Hugging Face space: {e}")
        return

    history = []

    while True:
        try:
            user_input = input("\nYou > ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting chat. Goodbye!")
            break

        if not user_input:
            continue

        if user_input.lower() in {"exit", "quit"}:
            print("Goodbye!")
            break

        if user_input.lower() == "clear":
            history = []
            print("[Conversation history cleared]")
            continue

        print("\n[Kimi is thinking...]")
        try:
            result = client.predict(
                message={
                    "text": user_input,
                    "files": []
                },
                history=history,
                backend_v="direct:together",
                max_tok=4096,
                temp=0.3,
                reason="high",
                api_name="/on_submit"
            )

            # Extract clean assistant answer
            answer = extract_assistant_text_from_gradio_output(result)
            if not answer:
                # Fallback if structure differs
                answer = str(result)

            print(f"\nKimi >\n{answer}")

            # Keep history in gradio format if result contains the history list
            if isinstance(result, (list, tuple)) and len(result) > 0 and isinstance(result[0], list):
                history = result[0]
            else:
                history.append({"role": "user", "content": user_input})
                history.append({"role": "assistant", "content": answer})

        except Exception as err:
            print(f"\nError communicating with Kimi: {err}")


if __name__ == "__main__":
    main()
