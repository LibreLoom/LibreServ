#!/usr/bin/env python3
"""Generate real photo fixtures for the Luna mock 64GB PSSD."""

from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "mock-pssd"
MANIFEST = FIXTURE / ".photo-manifest.json"
SEED_VERSION = FIXTURE / ".seed-version"

random.seed(9035)

LOCATIONS = {
    "sf": (37.7749, -122.4194),
    "yosemite": (37.8651, -119.5383),
    "portland": (45.5152, -122.6784),
    "chicago": (41.8781, -87.6298),
}


@dataclass
class PhotoSpec:
    rel_path: str
    width: int
    height: int
    fmt: str
    quality: int
    hue: float
    datetime: str
    lat: float | None = None
    lon: float | None = None


def jitter(base_lat: float, base_lon: float, spread: float = 0.08) -> tuple[float, float]:
    return (
        base_lat + random.uniform(-spread, spread),
        base_lon + random.uniform(-spread, spread),
    )


def exif_datetime(dt: datetime) -> str:
    return dt.strftime("%Y:%m:%d %H:%M:%S")


def build_specs() -> list[PhotoSpec]:
    specs: list[PhotoSpec] = []
    base = datetime(2019, 3, 10, 14, 30, 0)

    def add(
        folder: str,
        name: str,
        *,
        days_offset: int,
        hour: int,
        loc: str | None = None,
        w: int = 1600,
        h: int = 1200,
        fmt: str = "JPEG",
        quality: int = 88,
        hue: float | None = None,
    ) -> None:
        dt = base + timedelta(days=days_offset, hours=hour, minutes=random.randint(0, 59))
        lat = lon = None
        if loc:
            lat, lon = jitter(*LOCATIONS[loc])
        specs.append(
            PhotoSpec(
                rel_path=f"{folder}/{name}",
                width=w,
                height=h,
                fmt=fmt,
                quality=quality,
                hue=hue if hue is not None else random.random(),
                datetime=exif_datetime(dt),
                lat=lat,
                lon=lon,
            )
        )

    for i in range(1, 13):
        add(
            "DCIM/100CANON",
            f"IMG_{1000 + i:04d}.JPG",
            days_offset=120 + i * 3,
            hour=9 + (i % 6),
            loc="yosemite" if i <= 8 else None,
            w=4032,
            h=3024,
        )

    for i in range(1, 9):
        add(
            "DCIM/100APPLE",
            f"IMG_{2000 + i:04d}.JPG",
            days_offset=400 + i * 2,
            hour=11 + (i % 5),
            loc="sf" if i <= 5 else None,
            w=3024,
            h=4032,
        )

    for folder, loc, count in [
        ("Photos/Vacation - Yosemite", "yosemite", 12),
        ("Photos/Vacation - Portland", "portland", 10),
        ("Photos/2022 Chicago trip", "chicago", 8),
    ]:
        for i in range(1, count + 1):
            add(folder, f"2022-{loc}-{i:02d}.jpg", days_offset=600 + i * 4, hour=8 + i, loc=loc)

    for i in range(1, 9):
        add("Photos/Family", f"family-{i:02d}.jpg", days_offset=900 + i, hour=16, w=2048, h=1536)

    for year, count in (("2024", 6), ("2025", 5)):
        for i in range(1, count + 1):
            add(
                f"Photos/{year}",
                f"{year}-{i:02d}.jpg",
                days_offset=1100 + int(year) + i * 7,
                hour=10 + i,
                loc="sf" if i % 2 == 0 else None,
            )

    for i in range(1, 5):
        add("Photos/Misc", f"misc-{i:02d}.jpg", days_offset=1300 + i * 11, hour=13)

    for i in range(1, 4):
        add(
            "Pictures/Screenshots",
            f"Screenshot_{2024}{i:02d}{10 + i:02d}-120000.png",
            days_offset=1400 + i,
            hour=12,
            fmt="PNG",
            w=1920,
            h=1080,
        )

    for i in range(1, 4):
        add(
            "Pictures/Wallpapers",
            f"wallpaper-{i:02d}.jpg",
            days_offset=1500 + i,
            hour=0,
            w=2560,
            h=1440,
            quality=92,
        )

    specs.append(
        PhotoSpec(
            rel_path="Photos/Misc/sparkle.gif",
            width=320,
            height=240,
            fmt="GIF",
            quality=85,
            hue=0.55,
            datetime=exif_datetime(base + timedelta(days=1450, hours=3)),
        )
    )
    specs.append(
        PhotoSpec(
            rel_path="Photos/Misc/icon.png",
            width=512,
            height=512,
            fmt="PNG",
            quality=90,
            hue=0.12,
            datetime=exif_datetime(base + timedelta(days=1451, hours=4)),
        )
    )

    add(".Trashes/501", "deleted-beach.jpg", days_offset=700, hour=18, loc="portland")
    add(".Trashes/501", "deleted-selfie.jpg", days_offset=750, hour=19, loc="sf")

    return specs


def render_image(spec: PhotoSpec) -> Image.Image:
    w, h = spec.width, spec.height
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(40 + 180 * abs(math.sin(spec.hue * math.pi + t * 2)))
        g = int(50 + 160 * abs(math.cos(spec.hue * math.pi * 1.3 + t * 1.5)))
        b = int(60 + 140 * abs(math.sin(spec.hue * math.pi * 0.7 + t * 3)))
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    cx, cy = w // 2, h // 2
    radius = min(w, h) // 6
    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        outline=(255, 255, 255),
        width=max(2, min(w, h) // 200),
    )
    label = Path(spec.rel_path).stem[:24]
    try:
        font = ImageFont.load_default()
        draw.text((20, 20), label, fill=(255, 255, 255), font=font)
        draw.text((20, h - 30), spec.datetime[:10], fill=(240, 240, 240), font=font)
    except OSError:
        pass
    return img


def save_image(spec: PhotoSpec, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    img = render_image(spec)
    if spec.fmt == "JPEG":
        img.save(dest, format="JPEG", quality=spec.quality, optimize=True)
    elif spec.fmt == "PNG":
        img.save(dest, format="PNG", optimize=True)
    elif spec.fmt == "GIF":
        frame2 = img.copy()
        ImageDraw.Draw(frame2).rectangle((0, 0, spec.width, spec.height // 4), fill=(30, 30, 30))
        frame2.save(dest, format="GIF", save_all=True, append_images=[frame2], duration=400, loop=0)
    else:
        raise ValueError(spec.fmt)


def main() -> int:
    specs = build_specs()
    manifest: list[dict] = []

    for rel in ("DCIM", "Photos", "Pictures", ".Trashes"):
        target = FIXTURE / rel
        if target.exists():
            shutil.rmtree(target)

    for spec in specs:
        dest = FIXTURE / spec.rel_path
        save_image(spec, dest)
        if spec.fmt == "JPEG":
            manifest.append(
                {
                    "path": spec.rel_path.replace("\\", "/"),
                    "datetime": spec.datetime,
                    "lat": spec.lat,
                    "lon": spec.lon,
                }
            )
        print(f"  wrote {spec.rel_path}")

    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    SEED_VERSION.write_text("3\n", encoding="utf-8")
    print(f">> wrote {len(specs)} media files ({len(manifest)} JPEGs for EXIF inject)")

    cmd = ["cargo", "run", "--quiet", "--bin", "inject-mock-pssd-exif"]
    print(">> running:", " ".join(cmd), file=sys.stderr)
    subprocess.run(["cargo", "build", "--quiet", "--bin", "inject-mock-pssd-exif"], cwd=ROOT, check=True)
    subprocess.run(cmd, cwd=ROOT, check=True)

    total_bytes = sum(f.stat().st_size for f in FIXTURE.rglob("*") if f.is_file())
    print(f">> fixture total: {total_bytes / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
