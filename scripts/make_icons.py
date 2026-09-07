#!/usr/bin/env python3
"""Generate the app icons (a crescent moon on a solid navy square).

The squares are deliberately full-bleed: iOS rounds the apple-touch-icon
itself and Android applies its own maskable shape, and a transparent corner
renders as black on the iOS home screen.

Written with the standard library only so the repository needs no image
dependency. Re-run after changing the colours:

    python scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "icons"
SIZES = (180, 192, 512)

NAVY = (60, 84, 136)
CREAM = (251, 244, 220)


def crescent(x: float, y: float, size: float) -> bool:
    outer_r = size * 0.30
    inner_r = size * 0.255
    outer_cx, outer_cy = size * 0.52, size * 0.50
    inner_cx, inner_cy = size * 0.63, size * 0.40

    in_outer = (x - outer_cx) ** 2 + (y - outer_cy) ** 2 <= outer_r**2
    in_inner = (x - inner_cx) ** 2 + (y - inner_cy) ** 2 <= inner_r**2
    return in_outer and not in_inner


def render(size: int) -> bytes:
    rows = bytearray()
    for py in range(size):
        rows.append(0)  # PNG filter type 0 for this scanline
        y = py + 0.5
        for px in range(size):
            x = px + 0.5
            if crescent(x, y, size):
                rows.extend((*CREAM, 255))
            else:
                rows.extend((*NAVY, 255))
    return bytes(rows)


def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int) -> None:
    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(render(size), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUTPUT_DIR / f"icon-{size}.png"
        write_png(path, size)
        print(f"{path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
