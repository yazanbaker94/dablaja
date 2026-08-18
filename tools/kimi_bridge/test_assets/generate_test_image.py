import os
from PIL import Image, ImageDraw, ImageFont

def generate_vision_test_image(output_path: str):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    width, height = 800, 450
    image = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(image)

    # Outer border
    draw.rectangle([10, 10, width - 10, height - 10], outline=(30, 30, 30), width=4)

    # Title / code text
    # Try default font or basic scalable
    try:
        font_large = ImageFont.truetype("arial.ttf", 48)
        font_small = ImageFont.truetype("arial.ttf", 24)
    except Exception:
        font_large = ImageFont.load_default()
        font_small = ImageFont.load_default()

    code_text = "VISION-CODE-7429"
    draw.text((width // 2, 90), code_text, fill=(0, 0, 0), font=font_large, anchor="mm")

    # Blue Rectangle
    rect_box = [120, 200, 340, 320]
    draw.rectangle(rect_box, fill=(0, 102, 204), outline=(0, 50, 150), width=3)
    draw.text((230, 360), "BLUE RECTANGLE", fill=(0, 70, 160), font=font_small, anchor="mm")

    # Red Circle
    circle_box = [480, 190, 640, 350]
    draw.ellipse(circle_box, fill=(220, 40, 40), outline=(160, 20, 20), width=3)
    draw.text((560, 380), "RED CIRCLE", fill=(180, 20, 20), font=font_small, anchor="mm")

    image.save(output_path, "PNG")
    print(f"Generated vision test image at: {output_path}")

if __name__ == "__main__":
    out_dir = os.path.dirname(os.path.abspath(__file__))
    out_file = os.path.join(out_dir, "vision_test.png")
    generate_vision_test_image(out_file)
