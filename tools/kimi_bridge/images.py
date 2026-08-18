"""
Safe image extraction and lifecycle management for Kimi K3 Local Bridge.
Handles:
  1. OpenAI-compatible image_url payloads (data:image/...;base64,...)
  2. Local file path citations in text prompts (e.g. "C:\\...\\mascot.png" or "design images/mascot.png")
"""
import os
import re
import base64
import uuid
import tempfile
import logging
from typing import Any, Dict, List, Optional, Tuple
from fastapi import HTTPException, status

logger = logging.getLogger("kimi_bridge.images")

ALLOWED_MIME_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
}

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

MAX_IMAGES_PER_REQUEST = 4
MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024  # 20 MB

# Isolated temp directory for ephemeral vision assets
VISION_TEMP_DIR = os.path.join(tempfile.gettempdir(), "kimi_bridge_vision")
os.makedirs(VISION_TEMP_DIR, exist_ok=True)


def parse_and_save_base64_image(data_url: str) -> str:
    """
    Decodes an OpenAI data:image URL or raw base64 string and writes it to a temporary file.
    Returns the absolute path to the temporary file.
    """
    if not isinstance(data_url, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_url.url must be a valid string."
        )

    mime_type = "image/png"
    b64_data = data_url.strip()

    if data_url.startswith("data:"):
        header, sep, payload = data_url.partition(",")
        if not sep:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Malformed data URL: missing comma separator."
            )
        prefix = header[5:].strip()
        parts = prefix.split(";")
        if parts:
            mime_type = parts[0].strip().lower()
        b64_data = payload.strip()

    if mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image MIME type: '{mime_type}'. Supported formats: {list(ALLOWED_MIME_TYPES.keys())}"
        )

    if len(b64_data) > MAX_IMAGE_SIZE_BYTES * 1.5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Image payload exceeds maximum allowed size ({MAX_IMAGE_SIZE_BYTES // (1024 * 1024)}MB)."
        )

    try:
        image_bytes = base64.b64decode(b64_data, validate=True)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid base64 image encoding: {str(e)}"
        )

    if len(image_bytes) > MAX_IMAGE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Decoded image exceeds maximum allowed size ({MAX_IMAGE_SIZE_BYTES // (1024 * 1024)}MB)."
        )

    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decoded image payload is empty."
        )

    ext = ALLOWED_MIME_TYPES.get(mime_type, ".png")
    temp_filename = f"kimi_vis_{uuid.uuid4().hex}{ext}"
    temp_path = os.path.join(VISION_TEMP_DIR, temp_filename)

    try:
        with open(temp_path, "wb") as f:
            f.write(image_bytes)
        logger.info("Saved temporary vision asset: %s (%d bytes)", temp_filename, len(image_bytes))
        return temp_path
    except Exception as e:
        logger.error("Failed to write temporary image file: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to store temporary image file."
        )


def find_local_image_paths_in_text(text: str) -> List[str]:
    """
    Scans text for local file paths matching image extensions that actually exist on disk.
    Supports Windows absolute paths, POSIX paths, and relative workspace paths.
    """
    if not text or not isinstance(text, str):
        return []

    found_paths = []
    
    # Patterns for quoted, tagged, or whitespace-delimited paths
    patterns = [
        r'["\']([A-Za-z]:\\[^"\'\n\r\t]+?\.(?:png|jpg|jpeg|webp|gif))["\']',  # "C:\...\img.png"
        r'([A-Za-z]:\\[^\s"\'<>\n\r\t]+?\.(?:png|jpg|jpeg|webp|gif))',        # C:\...\img.png
        r'["\']([^"\'\n\r\t]+?\.(?:png|jpg|jpeg|webp|gif))["\']',              # "design images/mascot.png"
        r'@([^\s"\'<>\n\r\t]+?\.(?:png|jpg|jpeg|webp|gif))',                  # @design images/mascot.png
        r'`([^`\n\r\t]+?\.(?:png|jpg|jpeg|webp|gif))`',                        # `design images/mascot.png`
    ]

    cwd = os.getcwd()

    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            clean_match = match.strip().strip('"\'`')
            candidate_paths = [
                clean_match,
                os.path.join(cwd, clean_match),
                os.path.normpath(clean_match),
                os.path.normpath(os.path.join(cwd, clean_match))
            ]
            for candidate in candidate_paths:
                if os.path.isfile(candidate):
                    ext = os.path.splitext(candidate)[1].lower()
                    if ext in ALLOWED_EXTENSIONS:
                        abs_candidate = os.path.abspath(candidate)
                        if abs_candidate not in found_paths:
                            found_paths.append(abs_candidate)
                            logger.info("Auto-detected local image reference on disk: %s", abs_candidate)
                        break

    return found_paths


def extract_images_and_text_from_content(content: Any) -> Tuple[str, List[str]]:
    """
    Parses OpenAI message content (str or list of dicts) and extracts:
      - Clean text representation
      - List of file paths for attached images (both base64 temp files and existing disk files)
    """
    image_paths: List[str] = []

    if isinstance(content, str):
        # Check if text contains path to existing local image
        detected_local_images = find_local_image_paths_in_text(content)
        for p in detected_local_images:
            if len(image_paths) < MAX_IMAGES_PER_REQUEST:
                image_paths.append(p)
        return content, image_paths

    if isinstance(content, list):
        text_parts: List[str] = []

        for part in content:
            if isinstance(part, str):
                text_parts.append(part)
                for p in find_local_image_paths_in_text(part):
                    if p not in image_paths and len(image_paths) < MAX_IMAGES_PER_REQUEST:
                        image_paths.append(p)
            elif isinstance(part, dict):
                part_type = part.get("type", "")
                if part_type == "text" or "text" in part:
                    txt = part.get("text", "")
                    text_parts.append(txt)
                    for p in find_local_image_paths_in_text(txt):
                        if p not in image_paths and len(image_paths) < MAX_IMAGES_PER_REQUEST:
                            image_paths.append(p)
                elif part_type == "image_url" or "image_url" in part:
                    img_obj = part.get("image_url")
                    if isinstance(img_obj, str):
                        url = img_obj
                    elif isinstance(img_obj, dict):
                        url = img_obj.get("url", "")
                    else:
                        url = ""

                    if url:
                        if len(image_paths) >= MAX_IMAGES_PER_REQUEST:
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Exceeded maximum images per request ({MAX_IMAGES_PER_REQUEST})."
                            )
                        path = parse_and_save_base64_image(url)
                        image_paths.append(path)
                elif part_type == "image" and "image" in part:
                    img_data = part.get("image")
                    if isinstance(img_data, str) and img_data:
                        path = parse_and_save_base64_image(img_data)
                        image_paths.append(path)

        return "\n".join(text_parts), image_paths

    return str(content) if content is not None else "", []


def cleanup_temp_images(image_paths: List[str]) -> None:
    """
    Safely removes temporary image files created during request processing.
    NEVER deletes original files in user workspaces.
    """
    abs_temp_dir = os.path.abspath(VISION_TEMP_DIR)
    for path in image_paths:
        try:
            if path and os.path.exists(path):
                abs_path = os.path.abspath(path)
                # Ensure the path is inside VISION_TEMP_DIR before deleting
                if os.path.commonpath([abs_path, abs_temp_dir]) == abs_temp_dir:
                    os.remove(abs_path)
                    logger.info("Cleaned up temporary vision asset: %s", os.path.basename(abs_path))
        except Exception as e:
            logger.warning("Failed to remove temporary image %s: %s", path, str(e))
