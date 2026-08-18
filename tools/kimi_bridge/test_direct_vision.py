import os
import sys
import time
from gradio_client import Client, handle_file

from extractor import extract_assistant_text_from_gradio_output, clean_reasoning_and_response

def run_direct_vision_test():
    print("=" * 60)
    print("PART 6 — Directly Test Kimi K3 Vision Through Gradio")
    print("Connecting to Space: cw-105/kimi-k3-gguf-demo ...")
    print("=" * 60)

    asset_dir = os.path.join(os.path.dirname(__file__), "test_assets")
    image_path = os.path.join(asset_dir, "vision_test.png")

    if not os.path.exists(image_path):
        print(f"Error: image not found at {image_path}")
        sys.exit(1)

    print(f"Using test image: {image_path} ({os.path.getsize(image_path)} bytes)")

    client = Client("cw-105/kimi-k3-gguf-demo")

    prompt = (
        "Inspect the attached image.\n\n"
        "Return exactly:\n\n"
        "CODE: <the text code visible in the image>\n"
        "SHAPE1: <color and shape>\n"
        "SHAPE2: <color and shape>\n\n"
        "Do not guess. Read the actual image."
    )

    print("\nSending multimodal request with backend_v='direct:together', reason='high'...")
    start_time = time.time()

    try:
        # Test with handle_file
        file_obj = handle_file(image_path)
        result = client.predict(
            message={"text": prompt, "files": [file_obj]},
            history=[],
            backend_v="direct:together",
            max_tok=2048,
            temp=0.2,
            reason="high",
            api_name="/on_submit"
        )
        elapsed = time.time() - start_time
        print(f"Prediction returned in {elapsed:.2f}s!")

        raw_text = extract_assistant_text_from_gradio_output(result)
        cleaned = clean_reasoning_and_response(raw_text)

        print("\n--- Assistant Response ---")
        print(cleaned)
        print("--------------------------\n")

        # Verify criteria
        code_found = "7429" in cleaned or "VISION-CODE-7429" in cleaned
        blue_found = "blue" in cleaned.lower() or "rectangle" in cleaned.lower() or "مستطيل" in cleaned.lower() or "أزرق" in cleaned.lower()
        red_found = "red" in cleaned.lower() or "circle" in cleaned.lower() or "دائرة" in cleaned.lower() or "أحمر" in cleaned.lower()

        print(f"Verification:")
        print(f"  [x] Code 7429 Recognized: {code_found}")
        print(f"  [x] Blue Shape Recognized: {blue_found}")
        print(f"  [x] Red Shape Recognized: {red_found}")

        if code_found and blue_found and red_found:
            print("\nDIRECT VISION TEST SUCCESSFUL!")
            return True
        else:
            print("\nDIRECT VISION TEST FAILED: Response did not contain expected visual elements.")
            return False

    except Exception as e:
        print(f"\nDirect Vision Test Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    ok = run_direct_vision_test()
    sys.exit(0 if ok else 1)
