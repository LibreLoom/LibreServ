#!/usr/bin/env python3
"""Luna Mock Drive Generator and Manager.

Allows easily spawning, listing, plugging, unplugging, and removing mock drives
with realistic test data (photos with EXIF, documents, media, deep folder trees).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT / "dev"))
MOCK_DRIVES_DIR = Path(os.environ.get("LUNA_MOCK_DRIVES_PATH", DATA_DIR / "mock-drives"))
LEGACY_PSSD_DIR = Path(os.environ.get("LUNA_MOCK_PSSD_PATH", DATA_DIR / "mock-pssd-vol"))
DB_PATH = DATA_DIR / "luna.db"

# Minimal valid PDF generator
def create_mock_pdf(path: Path, title: str, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        f"%PDF-1.4\n"
        f"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        f"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        f"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n"
        f"4 0 obj << /Length {len(text) + 50} >> stream\n"
        f"BT /F1 16 Tf 50 720 Td ({title}) Tj ET\n"
        f"BT /F1 11 Tf 50 680 Td ({text}) Tj ET\n"
        f"endstream endobj\n"
        f"xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n"
        f"0000000115 00000 n \n0000000204 00000 n \n"
        f"trailer << /Size 5 /Root 1 0 R >>\nstartxref\n320\n%%EOF\n"
    )
    path.write_bytes(content.encode("utf-8", errors="replace"))

# Minimal valid MP3 header generator
def create_mock_mp3(path: Path, duration_kb: int = 120) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Sync frame 0xFFFB (MPEG 1 Layer 3, 128kbps, 44.1kHz)
    frame = b"\xff\xfb\x90\x00" + b"\x55" * 414
    count = max(1, (duration_kb * 1024) // len(frame))
    path.write_bytes(frame * count)

# Minimal mock MP4 generator (ftyp atom)
def create_mock_mp4(path: Path, size_kb: int = 250) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # ftyp box for mp42
    ftyp = b"\x00\x00\x00\x1cftypmp42\x00\x00\x00\x00mp42isom"
    # mdat box containing zeroes
    payload_len = max(0, (size_kb * 1024) - len(ftyp) - 8)
    mdat_header = (payload_len + 8).to_bytes(4, byteorder="big") + b"mdat"
    path.write_bytes(ftyp + mdat_header + (b"\x00" * payload_len))

# Real JPEG generator with optional PIL + EXIF
def create_mock_image(path: Path, width: int, height: int, label: str, dt_str: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image, ImageDraw, ImageFont
        color = (
            random.randint(40, 210),
            random.randint(40, 210),
            random.randint(40, 210),
        )
        img = Image.new("RGB", (width, height), color=color)
        draw = ImageDraw.Draw(img)
        # Geometric patterns
        draw.rectangle((20, 20, width - 20, height - 20), outline=(255, 255, 255), width=3)
        draw.ellipse((width // 4, height // 4, width * 3 // 4, height * 3 // 4), outline=(240, 240, 240), width=2)
        try:
            font = ImageFont.load_default()
            draw.text((30, 30), label, fill=(255, 255, 255), font=font)
            draw.text((30, height - 50), dt_str, fill=(230, 230, 230), font=font)
        except Exception:
            pass

        img.save(path, format="JPEG", quality=85)
    except ImportError:
        # Fallback tiny valid 1x1 JPEG
        TINY_JPEG = bytes([
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
            0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
            0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
            0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
            0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
            0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
            0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
            0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
            0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
            0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0A, 0x0B, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F,
            0x00, 0xBF, 0x00, 0xFF, 0xD9
        ])
        path.write_bytes(TINY_JPEG)


def populate_photos(dest: Path) -> int:
    count = 0
    now = datetime(2025, 6, 15, 14, 0, 0)
    cameras = [("100CANON", "Canon EOS R5"), ("101APPLE", "iPhone 16 Pro"), ("102FUJI", "Fujifilm X-T5")]
    for folder, cam in cameras:
        for i in range(1, 7):
            dt = now - timedelta(days=random.randint(1, 300), hours=random.randint(1, 10))
            fn = f"IMG_{1000 + i:04d}.JPG"
            create_mock_image(dest / "DCIM" / folder / fn, 1920, 1080, f"{cam} - {fn}", dt.strftime("%Y-%m-%d %H:%M"))
            count += 1

    albums = [
        ("Photos/2024/Summer Trip", 5),
        ("Photos/2025/New Year", 4),
        ("Photos/Family/Reunion", 5),
        ("Pictures/Wallpapers", 3),
    ]
    for album, num in albums:
        for i in range(1, num + 1):
            dt = now - timedelta(days=random.randint(50, 400))
            create_mock_image(dest / album / f"photo_{i:02d}.jpg", 1600, 1200, f"{album} #{i}", dt.strftime("%Y-%m-%d %H:%M"))
            count += 1
    return count


def populate_documents(dest: Path) -> int:
    count = 0
    # Tax & Finance
    create_mock_pdf(dest / "Documents/Financial/2024_W2_Summary.pdf", "W-2 Wage and Tax Statement 2024", "Employer: Plainskill Inc. Total wages: $115,000. Fed Tax: $18,400.")
    create_mock_pdf(dest / "Documents/Financial/2024_Tax_Return.pdf", "Form 1040 Individual Income Tax", "Filing Status: Single. Total Income: $115,000. Refund: $1,250.")
    count += 2

    # CSV Budget
    budget_csv = dest / "Documents/Financial/Annual_Budget_2025.csv"
    budget_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(budget_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Category", "Monthly Allocation", "Actual Q1", "Actual Q2", "Status"])
        w.writerow(["Housing & Utilities", "2400", "7200", "7150", "On Track"])
        w.writerow(["Groceries & Dining", "850", "2600", "2490", "Under Budget"])
        w.writerow(["Transportation", "400", "1180", "1220", "On Track"])
        w.writerow(["Savings & Investments", "1500", "4500", "4500", "Target Met"])
    count += 1

    # Work & Strategy Docs
    roadmap_md = dest / "Documents/Work/Projects/Q3_Strategic_Roadmap.md"
    roadmap_md.parent.mkdir(parents=True, exist_ok=True)
    roadmap_md.write_text(
        "# Q3 Product Roadmap & Strategy\n\n"
        "## Key Objectives\n"
        "- [x] Complete hardware storage integration and mock device harness\n"
        "- [ ] Polish responsive file browsing & photo thumbnail generation\n"
        "- [ ] Run end-to-end desktop and mobile companion sync benchmarks\n\n"
        "| Sprint | Milestone | Lead | Target Date |\n"
        "|---|---|---|---|\n"
        "| Sprint 14 | Storage Pools | Core Dev | 2026-09-12 |\n"
        "| Sprint 15 | Backup Worker Sync | Mobile Dev | 2026-09-26 |\n",
        encoding="utf-8"
    )
    count += 1

    create_mock_pdf(dest / "Documents/Work/Client_Proposal_Acme.pdf", "Enterprise Storage Architecture Proposal", "Prepared for: Acme Corp. High-availability distributed nodes.")
    count += 1

    # Personal Notes
    notes_txt = dest / "Documents/Personal/Home_Inventory.txt"
    notes_txt.parent.mkdir(parents=True, exist_ok=True)
    notes_txt.write_text(
        "HOME INVENTORY LIST (Updated 2026)\n"
        "------------------------------------\n"
        "1. Workstation PC - Serial: SN-9982412\n"
        "2. Moto G Power (2021) - Serial: ZY22BK7HZK\n"
        "3. Luna Storage Box - rev 1.0\n"
        "4. Portable NVMe SSD 2TB - SanDisk\n",
        encoding="utf-8"
    )
    count += 1
    return count


def populate_media(dest: Path) -> int:
    count = 0
    tracks = [
        ("Music/Daft Punk - Discovery", ["01 - One More Time.mp3", "02 - Aerodynamic.mp3", "03 - Digital Love.mp3"]),
        ("Music/Radiohead - OK Computer", ["01 - Airbag.mp3", "02 - Paranoid Android.mp3"]),
        ("Music/Tycho - Awake", ["01 - Awake.mp3", "02 - Montana.mp3"]),
    ]
    for album, songs in tracks:
        for song in songs:
            create_mock_mp3(dest / album / song, duration_kb=80)
            count += 1

    playlist = dest / "Music/Playlists/Favorites.m3u"
    playlist.parent.mkdir(parents=True, exist_ok=True)
    playlist.write_text(
        "#EXTM3U\n"
        "#EXTINF:320,Daft Punk - One More Time\n"
        "../Daft Punk - Discovery/01 - One More Time.mp3\n"
        "#EXTINF:284,Tycho - Awake\n"
        "../Tycho - Awake/01 - Awake.mp3\n",
        encoding="utf-8"
    )
    count += 1

    videos = [
        ("Videos/Vacation 2024/beach_drone_4k.mp4", 150),
        ("Videos/Family/holiday_dinner.mov", 120),
    ]
    for rel_path, size_kb in videos:
        create_mock_mp4(dest / rel_path, size_kb=size_kb)
        count += 1
    return count


def populate_projects(dest: Path) -> int:
    count = 0
    # Web project
    web_dir = dest / "Projects/web-dashboard"
    web_dir.mkdir(parents=True, exist_ok=True)
    (web_dir / "src").mkdir(parents=True, exist_ok=True)
    (web_dir / "src/index.html").write_text("<!DOCTYPE html><html><body><h1>Luna Dashboard</h1></body></html>\n", encoding="utf-8")
    (web_dir / "src/style.css").write_text("body { font-family: monospace; background: #121212; color: #fff; }\n", encoding="utf-8")
    (web_dir / "package.json").write_text('{\n  "name": "web-dashboard",\n  "version": "1.0.0"\n}\n', encoding="utf-8")
    (web_dir / "README.md").write_text("# Web Dashboard\nFrontend components for storage review.\n", encoding="utf-8")
    count += 4

    # Python tool
    py_dir = dest / "Projects/cli-tool"
    py_dir.mkdir(parents=True, exist_ok=True)
    (py_dir / "main.py").write_text('def main():\n    print("Luna CLI Tool v1.0")\n\nif __name__ == "__main__":\n    main()\n', encoding="utf-8")
    (py_dir / "requirements.txt").write_text("requests>=2.31.0\npydantic>=2.5.0\n", encoding="utf-8")
    count += 2
    return count


def populate_deep(dest: Path) -> int:
    count = 0
    deep_path = dest / "DeepArchive/2021/Corporate/Clients/Enterprise/Audits/Internal/Signed"
    deep_path.mkdir(parents=True, exist_ok=True)
    (deep_path / "final_audit_report.txt").write_text("Integrity check passed: all 12 hashes verified.\n", encoding="utf-8")
    count += 1

    intl_dir = dest / "International_Names"
    intl_dir.mkdir(parents=True, exist_ok=True)
    (intl_dir / "résumé_ingénieur.txt").write_text("CV en français.\n", encoding="utf-8")
    (intl_dir / "日本語_メモ.txt").write_text("ストレージのテストデータ。\n", encoding="utf-8")
    (intl_dir / "사진_2026.txt").write_text("한국어 파일 이름 테스트.\n", encoding="utf-8")
    (intl_dir / "File with spaces & symbols (v2.1).md").write_text("# Symbols & Spaces Test\n\n- item 1\n- item 2\n", encoding="utf-8")
    count += 4
    return count


def populate_mixed(dest: Path) -> int:
    c = 0
    c += populate_photos(dest)
    c += populate_documents(dest)
    c += populate_media(dest)
    c += populate_projects(dest)
    c += populate_deep(dest)
    return c


PRESETS = {
    "photos": populate_photos,
    "documents": populate_documents,
    "docs": populate_documents,
    "media": populate_media,
    "projects": populate_projects,
    "code": populate_projects,
    "deep": populate_deep,
    "mixed": populate_mixed,
    "all": populate_mixed,
    "empty": lambda dest: 0,
}


def sanitize_device_name(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c == "_" else "_" for c in name.strip().lower())
    if not cleaned.startswith("sdmock"):
        cleaned = f"sdmock_{cleaned}"
    # Ensure it ends with an alphabetic character so it doesn't look like a partition
    if cleaned and cleaned[-1].isdigit():
        cleaned = f"{cleaned}_drv"
    return cleaned


def cmd_spawn(args: argparse.Namespace) -> int:
    name = args.name.strip()
    if not name:
        print("Error: name cannot be empty", file=sys.stderr)
        return 1

    dev_name = sanitize_device_name(name)
    target_dir = MOCK_DRIVES_DIR / name
    target_dir.mkdir(parents=True, exist_ok=True)

    # Remove unplugged marker if it was there
    (target_dir / ".unplugged").unlink(missing_ok=True)

    preset = args.preset.lower()
    if preset not in PRESETS:
        print(f"Error: Unknown preset '{preset}'. Available: {', '.join(sorted(PRESETS.keys()))}", file=sys.stderr)
        return 1

    model = args.model or f"Mock {name.replace('_', ' ').replace('-', ' ').title()} Drive"
    size_bytes = int(args.size_gb * 1_000_000_000)

    config = {
        "name": dev_name,
        "model": model,
        "size_bytes": size_bytes,
        "fs_type": args.fs,
        "removable": True,
        "usb": True,
        "mount_readonly": args.readonly,
    }
    (target_dir / ".drive.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

    file_count = PRESETS[preset](target_dir)

    print(f">> Spawned mock drive '{name}' successfully!")
    print(f"   Device Name : {dev_name}")
    print(f"   Model       : {model}")
    print(f"   Capacity    : {args.size_gb} GB ({size_bytes:,} bytes)")
    print(f"   Filesystem  : {args.fs}")
    print(f"   Preset      : {preset} ({file_count} files generated)")
    print(f"   Directory   : {target_dir}")
    print(f"   Status      : Connected (Plugged in)")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    MOCK_DRIVES_DIR.mkdir(parents=True, exist_ok=True)
    drives: list[dict] = []

    # Check adopted drives in luna.db if present
    adopted_map: dict[str, str] = {}
    if DB_PATH.exists():
        try:
            con = sqlite3.connect(str(DB_PATH))
            cur = con.cursor()
            for row in cur.execute("SELECT device, label, state FROM drives"):
                adopted_map[row[0]] = f"{row[1]} ({row[2]})"
            con.close()
        except Exception:
            pass

    # 1. Legacy PSSD volume
    if LEGACY_PSSD_DIR.exists():
        unplugged = (LEGACY_PSSD_DIR / ".unplugged").exists()
        adopted = adopted_map.get("sdmock", "Not Adopted (Available to Add)")
        num_files = sum(1 for f in LEGACY_PSSD_DIR.rglob("*") if f.is_file() and not f.name.startswith("."))
        drives.append({
            "id": "mock-pssd (built-in)",
            "device": "sdmock",
            "model": "64GB PSSD",
            "size": "64 GB",
            "status": "UNPLUGGED" if unplugged else ("Adopted: " + adopted if "Adopted" not in adopted else adopted),
            "files": num_files,
            "path": str(LEGACY_PSSD_DIR),
        })

    # 2. Dynamic mock drives
    for entry in sorted(MOCK_DRIVES_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        unplugged = (entry / ".unplugged").exists()
        cfg_file = entry / ".drive.json"
        cfg = {}
        if cfg_file.exists():
            try:
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        dev_name = cfg.get("name") or sanitize_device_name(entry.name)
        model = cfg.get("model") or f"Mock Drive ({entry.name})"
        size_gb = round(cfg.get("size_bytes", 64_000_000_000) / 1_000_000_000)
        adopted = adopted_map.get(dev_name, "Not Adopted (Available to Add)")
        num_files = sum(1 for f in entry.rglob("*") if f.is_file() and not f.name.startswith("."))

        drives.append({
            "id": entry.name,
            "device": dev_name,
            "model": model,
            "size": f"{size_gb} GB",
            "status": "UNPLUGGED" if unplugged else ("Adopted: " + adopted if "Adopted" not in adopted else adopted),
            "files": num_files,
            "path": str(entry),
        })

    if not drives:
        print("No mock drives found. Use './scripts/mock-drive.sh spawn <name>' to create one.")
        return 0

    print(f"\n{'ID / NAME':<24} {'DEVICE':<18} {'MODEL':<24} {'SIZE':<8} {'FILES':<8} {'STATUS'}")
    print("-" * 105)
    for d in drives:
        print(f"{d['id']:<24} {d['device']:<18} {d['model']:<24} {d['size']:<8} {d['files']:<8} {d['status']}")
    print("")
    return 0


def cmd_unplug(args: argparse.Namespace) -> int:
    name = args.name.strip()
    target_dir = LEGACY_PSSD_DIR if name in ("sdmock", "mock-pssd", "mock-pssd-vol") else (MOCK_DRIVES_DIR / name)
    if not target_dir.exists():
        print(f"Error: Mock drive '{name}' not found at {target_dir}", file=sys.stderr)
        return 1
    (target_dir / ".unplugged").write_text("", encoding="utf-8")
    print(f">> Simulated UNPLUGGING drive '{name}'. Luna will report it disconnected/missing.")
    return 0


def cmd_plug(args: argparse.Namespace) -> int:
    name = args.name.strip()
    target_dir = LEGACY_PSSD_DIR if name in ("sdmock", "mock-pssd", "mock-pssd-vol") else (MOCK_DRIVES_DIR / name)
    if not target_dir.exists():
        print(f"Error: Mock drive '{name}' not found at {target_dir}", file=sys.stderr)
        return 1
    (target_dir / ".unplugged").unlink(missing_ok=True)
    print(f">> Simulated PLUGGING IN drive '{name}'. Luna will detect it on next poll.")
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    name = args.name.strip()
    target_dir = MOCK_DRIVES_DIR / name
    if not target_dir.exists():
        print(f"Error: Mock drive '{name}' not found at {target_dir}", file=sys.stderr)
        return 1
    shutil.rmtree(target_dir)
    print(f">> Removed mock drive '{name}'.")
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    if MOCK_DRIVES_DIR.exists():
        shutil.rmtree(MOCK_DRIVES_DIR)
        MOCK_DRIVES_DIR.mkdir(parents=True, exist_ok=True)
    print(">> Cleaned all spawned mock drives.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna Mock Drive Manager")
    sub = parser.add_subparsers(dest="command", required=True)

    # spawn
    p_spawn = sub.add_parser("spawn", aliases=["create", "add"], help="Spawn a new mock drive with test fixtures")
    p_spawn.add_argument("name", help="Identifier / name of the mock drive (e.g. photos, docs, backup)")
    p_spawn.add_argument("preset", nargs="?", default="mixed", choices=list(PRESETS.keys()), help="Fixture content preset")
    p_spawn.add_argument("--model", help="Hardware model name reported to UI")
    p_spawn.add_argument("--size-gb", type=int, default=128, help="Reported drive capacity in GB (default: 128)")
    p_spawn.add_argument("--fs", default="exfat", help="Filesystem type (default: exfat)")
    p_spawn.add_argument("--readonly", action="store_true", help="Mount drive in readonly mode")
    p_spawn.set_defaults(func=cmd_spawn)

    # list
    p_list = sub.add_parser("list", aliases=["ls"], help="List all active and unplugged mock drives")
    p_list.set_defaults(func=cmd_list)

    # unplug
    p_unplug = sub.add_parser("unplug", help="Simulate pulling out the drive (marks unplugged)")
    p_unplug.add_argument("name", help="Identifier of the mock drive to unplug")
    p_unplug.set_defaults(func=cmd_unplug)

    # plug
    p_plug = sub.add_parser("plug", help="Simulate plugging the drive back in")
    p_plug.add_argument("name", help="Identifier of the mock drive to plug in")
    p_plug.set_defaults(func=cmd_plug)

    # delete
    p_del = sub.add_parser("delete", aliases=["rm", "remove"], help="Delete a mock drive")
    p_del.add_argument("name", help="Identifier of the mock drive to delete")
    p_del.set_defaults(func=cmd_delete)

    # clean
    p_clean = sub.add_parser("clean", help="Remove all spawned mock drives")
    p_clean.set_defaults(func=cmd_clean)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
