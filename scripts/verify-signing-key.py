#!/usr/bin/env python3
"""Safely verify that a private Ed25519 license signing key matches the extension's public key.

Usage on VPS:
    python3 scripts/verify-signing-key.py
    python3 scripts/verify-signing-key.py --env-file /etc/dablaja.env

Security guarantees:
- NEVER prints, logs, or exports the private signing key.
- Prints only safe SHA-256 public key fingerprints (16 hex chars) and MATCH/MISMATCH status.
- Exits 0 on MATCH, 1 on MISMATCH or missing configuration.
"""
import argparse
import base64
import hashlib
import os
import re
import sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
except ImportError:
    print("ERROR: cryptography package required. Run: pip install cryptography", file=sys.stderr)
    sys.exit(1)


def load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def find_expected_public_key(root: Path) -> str | None:
    target_file = root / "src" / "shared" / "plus-entitlement.js"
    if not target_file.is_file():
        return None
    content = target_file.read_text(encoding="utf-8")
    m = re.search(r"export\s+const\s+PLUS_LICENSE_PUBLIC_KEY_B64\s*=\s*['\"]([^'\"]*)['\"];", content)
    return m.group(1).strip() if m else None


def main():
    parser = argparse.ArgumentParser(description="Verify Ed25519 signing key against extension public key safely.")
    parser.add_argument("--env-file", type=Path, default=Path("/etc/dablaja.env"), help="Path to VPS environment file")
    parser.add_argument("--public-key", type=str, default=None, help="Explicit base64 public key (optional)")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent

    # 1. Obtain private key from environment or env file
    priv_b64 = os.environ.get("DABLAJA_LICENSE_SIGNING_KEY")
    if not priv_b64 and args.env_file.is_file():
        env_vars = load_env_file(args.env_file)
        priv_b64 = env_vars.get("DABLAJA_LICENSE_SIGNING_KEY")

    if not priv_b64:
        print("STATUS: FAILED - DABLAJA_LICENSE_SIGNING_KEY not found in environment or env-file.", file=sys.stderr)
        sys.exit(1)

    try:
        priv_bytes = base64.b64decode(priv_b64.strip())
        if len(priv_bytes) != 32:
            print("STATUS: FAILED - Private key is not 32 bytes.", file=sys.stderr)
            sys.exit(1)
        private_key = Ed25519PrivateKey.from_private_bytes(priv_bytes)
        derived_pub_bytes = private_key.public_key().public_bytes(
            encoding=Encoding.Raw,
            format=PublicFormat.Raw
        )
        derived_pub_b64 = base64.b64encode(derived_pub_bytes).decode()
    except Exception as e:
        print(f"STATUS: FAILED - Error deriving public key: {e}", file=sys.stderr)
        sys.exit(1)

    # 2. Obtain expected public key
    expected_pub_b64 = args.public_key or find_expected_public_key(root)
    if not expected_pub_b64:
        print("STATUS: FAILED - PLUS_LICENSE_PUBLIC_KEY_B64 not found in codebase.", file=sys.stderr)
        sys.exit(1)

    try:
        expected_pub_bytes = base64.b64decode(expected_pub_b64.strip())
    except Exception:
        print("STATUS: FAILED - Expected public key is not valid base64.", file=sys.stderr)
        sys.exit(1)

    # 3. Calculate safe SHA-256 fingerprints (never expose private key)
    derived_fp = hashlib.sha256(derived_pub_bytes).hexdigest()[:16]
    expected_fp = hashlib.sha256(expected_pub_bytes).hexdigest()[:16]

    print("=== Dablaja Ed25519 Signing Key Verification ===")
    print(f"Derived Public Key Fingerprint:  sha256:{derived_fp}")
    print(f"Expected Public Key Fingerprint: sha256:{expected_fp}")

    if derived_pub_b64 == expected_pub_b64:
        print("\nRESULT: MATCH (The server signing key matches the extension public key.)")
        sys.exit(0)
    else:
        print("\nRESULT: MISMATCH (The server signing key DOES NOT match the extension public key!)")
        sys.exit(1)


if __name__ == "__main__":
    main()
