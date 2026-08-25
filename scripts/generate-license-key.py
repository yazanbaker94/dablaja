"""Generate an Ed25519 keypair for Dablaja Plus license signing.

Run ON THE VPS (never commit the private output):

    python3 scripts/generate-license-key.py

Output:
  - DABLAJA_LICENSE_SIGNING_KEY=...   -> put in /etc/dablaja.env (SECRET)
  - Public key (base64)               -> paste into
     src/shared/plus-entitlement.js  ->  PLUS_LICENSE_PUBLIC_KEY_B64

The private key never leaves the machine that ran this script.
"""
import base64
import os

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
except ImportError:
    raise SystemExit("pip install cryptography first")

seed = os.urandom(32)
private = Ed25519PrivateKey.from_private_bytes(seed)
public_raw = private.public_key().public_bytes(encoding=Encoding.Raw, format=PublicFormat.Raw)

print("# 1) Add to /etc/dablaja.env on the VPS (keep secret, chmod 600):")
print(f"DABLAJA_LICENSE_SIGNING_KEY={base64.b64encode(seed).decode()}")
print()
print("# 2) Paste this PUBLIC key into src/shared/plus-entitlement.js:")
print(f"PUBLIC: {base64.b64encode(public_raw).decode()}")
