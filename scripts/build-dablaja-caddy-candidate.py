#!/usr/bin/env python3
"""Build a complete, guarded Caddy candidate from the current VPS root file.

The repository stores only the reviewed audiofetcher.com site block. Replacing
the root Caddyfile with that fragment would remove unrelated imports/sites, so
the production update is deliberately expressed as one exact substitution on
the existing full root configuration.
"""

from __future__ import annotations

import argparse
from pathlib import Path


OLD_FRAME_POLICY = "frame-src https://challenges.cloudflare.com;"
NEW_FRAME_POLICY = (
    "frame-src https://challenges.cloudflare.com "
    "https://www.youtube-nocookie.com https://www.youtube.com;"
)
REQUIRED_ROOT_MARKERS = (
    "import /etc/caddy/sites/*.caddy",
    "import rook-origin",
    "audiofetcher.com {",
    "reverse_proxy 127.0.0.1:8080",
)


def build(source: Path, output: Path) -> None:
    raw = source.read_text(encoding="utf-8")
    missing = [marker for marker in REQUIRED_ROOT_MARKERS if marker not in raw]
    if missing:
        raise SystemExit("Refusing incomplete root Caddyfile; missing required markers.")
    if raw.count(OLD_FRAME_POLICY) != 1:
        raise SystemExit("Refusing ambiguous CSP update; expected one old frame-src policy.")
    updated = raw.replace(OLD_FRAME_POLICY, NEW_FRAME_POLICY)
    if updated.count(NEW_FRAME_POLICY) != 1:
        raise SystemExit("Refusing invalid CSP update result.")
    output.write_text(updated, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.source, args.output)


if __name__ == "__main__":
    main()
