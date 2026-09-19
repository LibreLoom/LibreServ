#!/usr/bin/env python3
"""Luna Mock Drive Generator and Manager.

Allows easily spawning, listing, plugging, unplugging, and removing mock drives
with realistic test data (photos with EXIF, documents, media, deep folder trees).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT / "dev"))
MOCK_DRIVES_DIR = Path(os.environ.get("LUNA_MOCK_DRIVES_PATH", DATA_DIR / "mock-drives"))
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


def _xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# Minimal valid .docx (OOXML zip) — mirrors web/src/lib/officeStubs.js blankDocx.
def create_mock_docx(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    paragraphs = "".join(
        "<w:p/>" if not line
        else f'<w:p><w:r><w:t xml:space="preserve">{_xml_escape(line)}</w:t></w:r></w:p>'
        for line in text.split("\n")
    ) or "<w:p><w:r><w:t></w:t></w:r></w:p>"
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n'
        '</Relationships>'
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
        f'  <w:body>{paragraphs}</w:body>\n'
        '</w:document>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document)


# Minimal valid .xlsx — mirrors officeStubs.js blankXlsx (text lands in A1 via sharedStrings).
def create_mock_xlsx(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cell = _xml_escape(text)
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n'
        '  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n'
        '  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>\n'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n'
        '</Relationships>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"\n'
        '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        '  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>\n'
        '</workbook>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n'
        '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>\n'
        '</Relationships>'
    )
    shared = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">\n'
        f'  <si><t xml:space="preserve">{cell}</t></si>\n'
        '</sst>'
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n'
        '  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>\n'
        '</worksheet>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        zf.writestr("xl/sharedStrings.xml", shared)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)


# Minimal valid .pptx — mirrors officeStubs.js blankPptx (text is the slide 1
# title). Includes slideMaster/slideLayout/theme: Document Server's renderers
# (e.g. pptx→pdf) crash on presentations without a master.
def create_mock_pptx(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    title = _xml_escape(text) or " "
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>\n'
        '  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n'
        '  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>\n'
        '  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>\n'
        '  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>\n'
        '</Relationships>'
    )
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"\n'
        '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        '  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>\n'
        '  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>\n'
        '  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>\n'
        '  <p:notesSz cx="6858000" cy="9144000"/>\n'
        '</p:presentation>'
    )
    presentation_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>\n'
        '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>\n'
        '</Relationships>'
    )
    slide_master = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"\n'
        '  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"\n'
        '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        '  <p:cSld><p:spTree>\n'
        '    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n'
        '    <p:grpSpPr/>\n'
        '  </p:spTree></p:cSld>\n'
        '  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"\n'
        '    accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"\n'
        '    hlink="hlink" folHlink="folHlink"/>\n'
        '  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>\n'
        '  <p:txStyles>\n'
        '    <p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle>\n'
        '    <p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>\n'
        '    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>\n'
        '  </p:txStyles>\n'
        '</p:sldMaster>'
    )
    slide_master_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\n'
        '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>\n'
        '</Relationships>'
    )
    slide_layout = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"\n'
        '  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"\n'
        '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"\n'
        '  type="blank" preserve="1">\n'
        '  <p:cSld name="Blank"><p:spTree>\n'
        '    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n'
        '    <p:grpSpPr/>\n'
        '  </p:spTree></p:cSld>\n'
        '  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n'
        '</p:sldLayout>'
    )
    slide_layout_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>\n'
        '</Relationships>'
    )
    slide_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\n'
        '</Relationships>'
    )
    theme = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">\n'
        '  <a:themeElements>\n'
        '    <a:clrScheme name="Office">\n'
        '      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>\n'
        '      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>\n'
        '      <a:dk2><a:srgbClr val="1F497D"/></a:dk2>\n'
        '      <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>\n'
        '      <a:accent1><a:srgbClr val="4F81BD"/></a:accent1>\n'
        '      <a:accent2><a:srgbClr val="C0504D"/></a:accent2>\n'
        '      <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>\n'
        '      <a:accent4><a:srgbClr val="8064A2"/></a:accent4>\n'
        '      <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>\n'
        '      <a:accent6><a:srgbClr val="F79646"/></a:accent6>\n'
        '      <a:hlink><a:srgbClr val="0000FF"/></a:hlink>\n'
        '      <a:folHlink><a:srgbClr val="800080"/></a:folHlink>\n'
        '    </a:clrScheme>\n'
        '    <a:fontScheme name="Office">\n'
        '      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>\n'
        '      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>\n'
        '    </a:fontScheme>\n'
        '    <a:fmtScheme name="Office">\n'
        '      <a:fillStyleLst>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '      </a:fillStyleLst>\n'
        '      <a:lnStyleLst>\n'
        '        <a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>\n'
        '        <a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>\n'
        '        <a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>\n'
        '      </a:lnStyleLst>\n'
        '      <a:effectStyleLst>\n'
        '        <a:effectStyle><a:effectLst/></a:effectStyle>\n'
        '        <a:effectStyle><a:effectLst/></a:effectStyle>\n'
        '        <a:effectStyle><a:effectLst/></a:effectStyle>\n'
        '      </a:effectStyleLst>\n'
        '      <a:bgFillStyleLst>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\n'
        '      </a:bgFillStyleLst>\n'
        '    </a:fmtScheme>\n'
        '  </a:themeElements>\n'
        '</a:theme>'
    )
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"\n'
        '  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">\n'
        '  <p:cSld><p:spTree>\n'
        '    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n'
        '    <p:grpSpPr/>\n'
        '    <p:sp>\n'
        '      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\n'
        '      <p:spPr/>\n'
        '      <p:txBody>\n'
        f'        <a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{title}</a:t></a:r></a:p>\n'
        '      </p:txBody>\n'
        '    </p:sp>\n'
        '  </p:spTree></p:cSld>\n'
        '</p:sld>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("ppt/presentation.xml", presentation)
        zf.writestr("ppt/_rels/presentation.xml.rels", presentation_rels)
        zf.writestr("ppt/slides/slide1.xml", slide)
        zf.writestr("ppt/slides/_rels/slide1.xml.rels", slide_rels)
        zf.writestr("ppt/slideMasters/slideMaster1.xml", slide_master)
        zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", slide_master_rels)
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout)
        zf.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slide_layout_rels)
        zf.writestr("ppt/theme/theme1.xml", theme)


# Minimal valid ODF package: `mimetype` member FIRST and STORED, then manifest + content.
def create_mock_odf(path: Path, mimetype: str, content_xml: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n'
        f'  <manifest:file-entry manifest:full-path="/" manifest:media-type="{mimetype}"/>\n'
        '  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>\n'
        '</manifest:manifest>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("mimetype", mimetype)
        zf.writestr("META-INF/manifest.xml", manifest)
        zf.writestr("content.xml", content_xml)


def create_mock_odt(path: Path, text: str) -> None:
    paras = "".join(
        f"<text:p>{_xml_escape(line)}</text:p>" for line in text.split("\n") if line
    ) or "<text:p/>"
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"\n'
        '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">\n'
        f'  <office:body><office:text>{paras}</office:text></office:body>\n'
        '</office:document-content>'
    )
    create_mock_odf(path, "application/vnd.oasis.opendocument.text", content)


def create_mock_ods(path: Path, rows: list[list[str]]) -> None:
    row_xml = "".join(
        "<table:table-row>"
        + "".join(
            f'<table:table-cell office:value-type="string"><text:p>{_xml_escape(c)}</text:p></table:table-cell>'
            for c in row
        )
        + "</table:table-row>"
        for row in rows
    )
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"\n'
        '  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"\n'
        '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">\n'
        '  <office:body><office:spreadsheet>\n'
        f'    <table:table table:name="Sheet1">{row_xml}</table:table>\n'
        '  </office:spreadsheet></office:body>\n'
        '</office:document-content>'
    )
    create_mock_odf(path, "application/vnd.oasis.opendocument.spreadsheet", content)


def create_mock_odp(path: Path, title: str) -> None:
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"\n'
        '  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"\n'
        '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">\n'
        '  <office:body><office:presentation>\n'
        '    <draw:page draw:name="Slide1">\n'
        '      <draw:frame draw:name="Title"><draw:text-box>\n'
        f'        <text:p>{_xml_escape(title)}</text:p>\n'
        '      </draw:text-box></draw:frame>\n'
        '    </draw:page>\n'
        '  </office:presentation></office:body>\n'
        '</office:document-content>'
    )
    create_mock_odf(path, "application/vnd.oasis.opendocument.presentation", content)


# Minimal valid .epub: `mimetype` member FIRST and STORED, then container + OPF + one xhtml doc.
def create_mock_epub(path: Path, title: str, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    container = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
        '</container>'
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        '    <dc:identifier id="uid">luna-mock-epub-001</dc:identifier>\n'
        f'    <dc:title>{_xml_escape(title)}</dc:title>\n'
        '    <dc:language>en</dc:language>\n'
        '    <meta property="dcterms:modified">2025-01-01T00:00:00Z</meta>\n'
        '  </metadata>\n'
        '  <manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>\n'
        '  <spine><itemref idref="ch1"/></spine>\n'
        '</package>'
    )
    chapter = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml">\n'
        f'<head><title>{_xml_escape(title)}</title></head>\n'
        f'<body><h1>{_xml_escape(title)}</h1><p>{_xml_escape(text)}</p></body>\n'
        '</html>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/chapter1.xhtml", chapter)


# Minimal valid 1x1 JPEG (fallback when Pillow is absent)
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
    0x00, 0xBF, 0x00, 0xFF, 0xD9,
])


def create_mock_image(path: Path, width: int, height: int, label: str, dt_str: str) -> None:
    """Synthetic JPEG (no EXIF). Falls back to a 1x1 pixel without Pillow."""
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
        path.write_bytes(TINY_JPEG)


# --- Real photos: Wikimedia Commons pixels + synthetic EXIF ------------------
#
# The gallery indexes taken_at, GPS (lat/lon + place label), camera make/model,
# lens, ISO, focal length, flash, plus width/height for the orientation and
# megapixel filters. Real Commons JPEGs are downloaded once into
# {LUNA_DATA_DIR}/.commons-cache (dot-prefixed, so the drive scanner skips it)
# and each is stamped with a deterministic spec that spreads every filterable
# field. Deliberate edge cases: one photo with no EXIF at all (no-date /
# has-gps filters) and one PNG (format filter + mtime fallback).
#
# Set LUNA_MOCK_NO_NETWORK=1 to skip downloads (Pillow-drawn fallbacks are
# stamped with the same EXIF specs).

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
COMMONS_CATEGORY = "Category:Featured pictures on Wikimedia Commons"
COMMONS_UA = "LunaMockDrive/1.0 (LibreLoom dev fixture generator)"
COMMONS_THUMB_WIDTH = 1600
COMMONS_ORIG_MAX_BYTES = 30_000_000
PHOTO_COUNT = 30

MOCK_CAMERAS = [
    ("Canon", "Canon EOS R5", "RF24-105mm F4 L IS USM", "100CANON"),
    ("Apple", "iPhone 16 Pro", "iPhone 16 Pro back camera 6.765mm f/1.78", "101APPLE"),
    ("FUJIFILM", "X-T5", "XF16-55mmF2.8 R LM WR", "102FUJI"),
    ("NIKON CORPORATION", "NIKON Z 8", "NIKKOR Z 24-70mm f/2.8 S", "103NIKON"),
    ("SONY", "ILCE-7M4", "FE 35mm F1.4 GM", "104SONY"),
]

MOCK_CITIES = [
    ("Paris", 48.8566, 2.3522),
    ("New York", 40.7128, -74.0060),
    ("Tokyo", 35.6762, 139.6503),
    ("Sydney", -33.8688, 151.2093),
    ("San Francisco", 37.7749, -122.4194),
    ("Reykjavik", 64.1466, -21.9426),
    ("Cape Town", -33.9249, 18.4241),
    ("Cusco", -13.5320, -71.9675),
]

MOCK_ISOS = [64, 100, 200, 400, 800, 1600, 3200, 6400]
MOCK_FOCALS = [14, 24, 35, 50, 85, 105, 200, 400]
MOCK_APERTURES = [1.4, 1.8, 2.8, 4.0, 5.6, 8.0, 11.0]
MOCK_SHUTTERS = [(1, 8000), (1, 1000), (1, 250), (1, 60), (1, 30), (1, 8), (2, 1)]
MOCK_ALBUMS = ["Summer Trip", "New Year", "Reunion", "Wallpapers"]


def _photo_specs(count: int) -> list[dict]:
    """Deterministic per-photo spec: spreads every filterable EXIF field."""
    specs = []
    base = datetime(2025, 6, 15, 14, 0, 0)
    for i in range(count):
        make, model, lens, dcim = MOCK_CAMERAS[i % len(MOCK_CAMERAS)]
        dt = base - timedelta(days=13 * i + 5, hours=(7 * i) % 24, minutes=(11 * i) % 60)
        gps = None
        if i % 3 != 2:  # ~2/3 of photos carry GPS
            city, lat, lon = MOCK_CITIES[(2 * i) % len(MOCK_CITIES)]
            jitter = ((i * 37) % 100) / 5000.0  # ±0.02° spread inside the city
            gps = (lat + jitter, lon - jitter, city)
        shape = "landscape"
        if i % 5 == 1:
            shape = "portrait"
        elif i % 5 == 4:
            shape = "square"
        if i % 2 == 0:
            rel = f"DCIM/{dcim}/IMG_{1000 + i:04d}.JPG"
        else:
            album = MOCK_ALBUMS[(i // 2) % len(MOCK_ALBUMS)]
            rel = f"Photos/{dt.year}/{album}/photo_{i:02d}.jpg"
        specs.append({
            "rel": rel,
            "label": f"{model} #{i}",
            "dt": dt.strftime("%Y:%m:%d %H:%M:%S"),
            "make": make,
            "model": model,
            "lens": lens,
            "iso": MOCK_ISOS[i % len(MOCK_ISOS)],
            "focal": MOCK_FOCALS[(3 * i) % len(MOCK_FOCALS)],
            "aperture": MOCK_APERTURES[i % len(MOCK_APERTURES)],
            "shutter": MOCK_SHUTTERS[i % len(MOCK_SHUTTERS)],
            "flash": 1 if i % 4 == 0 else 0,
            "gps": gps,
            "shape": shape,
            # Edge cases: last photo has no EXIF (no-date filter), second to
            # last is a PNG (format filter + mtime fallback).
            "bare": i == count - 1,
            "png": i == count - 2,
            # Every 8th photo downloads the full original for megapixel range.
            "original": i % 8 == 0,
        })
    return specs


def _commons_cache() -> Path:
    d = DATA_DIR / ".commons-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _commons_get(params: dict) -> dict:
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": COMMONS_UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _commons_candidates(limit: int = 240) -> list[dict]:
    data = _commons_get({
        "action": "query",
        "format": "json",
        "generator": "categorymembers",
        "gcmtitle": COMMONS_CATEGORY,
        "gcmtype": "file",
        "gcmlimit": str(limit),
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "iiurlwidth": str(COMMONS_THUMB_WIDTH),
    })
    pages = (data.get("query") or {}).get("pages") or {}
    out = []
    for page in pages.values():
        info = (page.get("imageinfo") or [{}])[0]
        if info.get("mime") != "image/jpeg" or not info.get("thumburl"):
            continue
        if (info.get("width") or 0) < 600 or (info.get("height") or 0) < 600:
            continue
        out.append({
            "title": page.get("title") or "photo.jpg",
            "thumburl": info["thumburl"],
            "url": info.get("url") or "",
            "size": info.get("size") or 0,
        })
    out.sort(key=lambda c: c["title"])
    return out


def _download(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": COMMONS_UA})
        with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        return dest.stat().st_size > 0
    except Exception:
        dest.unlink(missing_ok=True)
        return False


def fetch_commons_images(specs: list[dict]) -> list[tuple[Path, str] | None]:
    """Download one cached JPEG per spec. Entry is (path, source_url) or None.

    Cached under {LUNA_DATA_DIR}/.commons-cache so re-spawns stay offline.
    """
    if os.environ.get("LUNA_MOCK_NO_NETWORK"):
        return [None] * len(specs)
    try:
        candidates = _commons_candidates()
    except Exception as e:
        print(f"Warning: Wikimedia Commons query failed ({e}); using drawn photos", file=sys.stderr)
        return [None] * len(specs)
    if not candidates:
        return [None] * len(specs)
    step = max(1, len(candidates) // len(specs))
    picked = candidates[::step][: len(specs)]
    cache = _commons_cache()
    images: list[tuple[Path, str] | None] = []
    for i, spec in enumerate(specs):
        cand = picked[i % len(picked)]
        url = cand["thumburl"]
        # A few photos take the full-resolution original for megapixel spread.
        if spec["original"] and cand["url"] and cand["size"] < COMMONS_ORIG_MAX_BYTES:
            url = cand["url"]
        key = hashlib.sha1(url.encode()).hexdigest()[:16] + ".jpg"
        local = cache / key
        if not local.exists() and not _download(url, local):
            images.append(None)
            continue
        images.append((local, cand["url"]))
    return images


def _synth_image(width: int, height: int, label: str, dt_str: str):
    """Pillow-drawn fallback photo (used offline or when a download fails)."""
    from PIL import Image, ImageDraw, ImageFont
    color = (
        random.randint(40, 210),
        random.randint(40, 210),
        random.randint(40, 210),
    )
    img = Image.new("RGB", (width, height), color=color)
    draw = ImageDraw.Draw(img)
    draw.rectangle((20, 20, width - 20, height - 20), outline=(255, 255, 255), width=3)
    draw.ellipse((width // 4, height // 4, width * 3 // 4, height * 3 // 4), outline=(240, 240, 240), width=2)
    try:
        font = ImageFont.load_default()
        draw.text((30, 30), label, fill=(255, 255, 255), font=font)
        draw.text((30, height - 50), dt_str, fill=(230, 230, 230), font=font)
    except Exception:
        pass
    return img


def _shape_image(img, shape: str):
    """Center-crop to a portrait (3:4) or square (1:1) aspect when asked."""
    w, h = img.size
    if shape == "portrait" and w > h * 3 // 4:
        nw = h * 3 // 4
        x = (w - nw) // 2
        return img.crop((x, 0, x + nw, h))
    if shape == "square" and w != h:
        side = min(w, h)
        x, y = (w - side) // 2, (h - side) // 2
        return img.crop((x, y, x + side, y + side))
    return img


def _dms(value: float):
    """Decimal degrees → EXIF (deg, min, sec) IFDRationals."""
    from PIL.TiffImagePlugin import IFDRational
    v = abs(value)
    d = int(v)
    m_full = (v - d) * 60
    m = int(m_full)
    s = round((m_full - m) * 60 * 100)
    return (IFDRational(d), IFDRational(m), IFDRational(s, 100))


def _stamp_exif(img, spec: dict):
    """Fill IFD0 + Exif IFD + GPS IFD from a spec dict (Pillow Exif)."""
    from PIL.TiffImagePlugin import IFDRational
    num, den = spec["shutter"]
    w, h = img.size
    exif = img.getexif()
    exif[0x010E] = f"{spec['label']} — Luna test fixture"  # ImageDescription
    exif[0x010F] = spec["make"]                           # Make
    exif[0x0110] = spec["model"]                          # Model
    exif[0x0112] = 1                                      # Orientation: normal
    exif[0x0131] = "Luna mock-drive.py"                   # Software
    exif[0x0132] = spec["dt"]                             # DateTime
    exif[0x013B] = "Luna Test Fixture"                    # Artist
    exif[0x8298] = "CC BY-SA, Wikimedia Commons"          # Copyright
    exif[0x8769] = {                                      # Exif IFD
        0x829A: IFDRational(num, den),                    # ExposureTime
        0x829D: IFDRational(spec["aperture"]),            # FNumber
        0x8822: 2 + (spec["iso"] % 3),                    # ExposureProgram
        0x8827: spec["iso"],                              # PhotographicSensitivity (ISO)
        0x9000: b"0232",                                  # ExifVersion
        0x9003: spec["dt"],                               # DateTimeOriginal
        0x9004: spec["dt"],                               # DateTimeDigitized
        0x9207: 5,                                        # MeteringMode: pattern
        0x9209: spec["flash"],                            # Flash
        0x920A: IFDRational(spec["focal"]),               # FocalLength
        0xA001: 1,                                        # ColorSpace: sRGB
        0xA002: w,                                        # PixelXDimension
        0xA003: h,                                        # PixelYDimension
        0xA403: 0,                                        # WhiteBalance: auto
        0xA405: min(200, int(spec["focal"] * 1.5)),       # FocalLengthIn35mmFilm
        0xA434: spec["lens"],                             # LensModel
    }
    if spec["gps"]:
        lat, lon, _city = spec["gps"]
        hh, mm, ss = (int(x) for x in spec["dt"][11:].split(":"))
        exif[0x8825] = {                                  # GPS IFD
            1: "N" if lat >= 0 else "S",
            2: _dms(lat),
            3: "E" if lon >= 0 else "W",
            4: _dms(lon),
            5: 0,                                         # AltitudeRef: above sea
            6: IFDRational(15 + (spec["iso"] % 400)),     # Altitude (m)
            7: (IFDRational(hh), IFDRational(mm), IFDRational(ss)),  # GPSTimeStamp
            29: spec["dt"][:10],                          # GPSDateStamp
        }
    return exif


def _write_photo(target: Path, src: Path | None, spec: dict, have_pil: bool) -> bool:
    """Write one photo: real Commons pixels (or drawn fallback) + EXIF spec."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if not have_pil:
        if src:
            shutil.copy2(src, target)
        else:
            target.write_bytes(TINY_JPEG)
        return True
    from PIL import Image
    img = None
    if src:
        try:
            img = Image.open(src)
            img.load()
        except Exception:
            img = None
    if img is None:
        img = _synth_image(1920, 1280, spec["label"], spec["dt"].replace(":", "-", 2))
    img = _shape_image(img.convert("RGB"), spec["shape"])
    out = target.with_suffix(".png") if spec["png"] else target
    if spec["png"]:
        img.save(out, format="PNG")
        return True
    if spec["bare"]:
        img.save(out, format="JPEG", quality=88)
        return True
    img.save(out, format="JPEG", quality=88, exif=_stamp_exif(img, spec))
    return True


def populate_photos(dest: Path) -> int:
    """Seed photo content: real Wikimedia Commons JPEGs + full synthetic EXIF."""
    count = 0
    specs = _photo_specs(PHOTO_COUNT)
    try:
        import PIL  # noqa: F401
        have_pil = True
    except ImportError:
        have_pil = False
    images = fetch_commons_images(specs) if have_pil else [None] * len(specs)
    sources = []
    for spec, src in zip(specs, images):
        if _write_photo(dest / spec["rel"], src[0] if src else None, spec, have_pil):
            count += 1
        if src:
            sources.append(f"{spec['rel']}  <-  {src[1]}")
    if sources:
        (dest / "SOURCES.txt").write_text(
            "Photos downloaded from Wikimedia Commons (see license terms there):\n\n"
            + "\n".join(sources)
            + "\n",
            encoding="utf-8",
        )
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

    # Real office docs — one valid file per EuroOffice/OnlyOffice editable format.
    # Legacy .doc/.xls/.ppt (OLE2 compound binaries) are intentionally skipped:
    # they can't be fabricated as minimal stubs like OOXML/ODF zips.
    create_mock_docx(
        dest / "Documents/Office/Report.docx",
        "Q3 Engineering Status Report\n"
        "All storage milestones are on track. Thumbnail pipeline shipped in Sprint 14.",
    )
    create_mock_xlsx(
        dest / "Documents/Office/Budget.xlsx",
        "2025 Hardware Budget: drives $4,200, enclosures $900, spare parts $350",
    )
    create_mock_pptx(dest / "Documents/Office/Slides.pptx", "Luna Storage Roadmap")
    create_mock_odt(
        dest / "Documents/Office/Notes.odt",
        "Meeting notes\nBackup worker sync moved to Sprint 15.",
    )
    create_mock_ods(
        dest / "Documents/Office/Table.ods",
        [["Item", "Qty", "Cost"], ["NVMe SSD 2TB", "4", "180"], ["SATA HDD 8TB", "2", "220"]],
    )
    create_mock_odp(dest / "Documents/Office/Deck.odp", "Luna Investor Deck")
    letter_rtf = dest / "Documents/Office/Letter.rtf"
    letter_rtf.parent.mkdir(parents=True, exist_ok=True)
    letter_rtf.write_text(
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\n"
        "\\f0\\fs24 Dear Luna Team,\\par\n"
        "Please find the enclosed storage report.\\par\n"
        "Regards,\\par Plainskill Ops}\n",
        encoding="utf-8",
    )
    count += 7
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


def populate_stress(dest: Path) -> int:
    """One real, valid file per OpenableKind in web/src/lib/fileKinds.js."""
    count = 0
    base = dest / "StressTest"

    # image
    (base / "image").mkdir(parents=True, exist_ok=True)
    (base / "image/sample.jpg").write_bytes(TINY_JPEG)
    count += 1

    # video
    create_mock_mp4(base / "video/clip.mp4", size_kb=64)
    count += 1

    # text
    (base / "text").mkdir(parents=True, exist_ok=True)
    (base / "text/notes.txt").write_text(
        "Stress-test plain text file.\nEvery OpenableKind has one file under StressTest/.\n",
        encoding="utf-8",
    )
    count += 1

    # pdf
    create_mock_pdf(base / "pdf/document.pdf", "Stress Test PDF", "Generated by mock-drive.py")
    count += 1

    # audio
    create_mock_mp3(base / "audio/tone.mp3", duration_kb=60)
    count += 1

    # archive — real .zip
    (base / "archive").mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(base / "archive/bundle.zip", "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("readme.txt", "Stress-test archive bundle.\n")
        zf.writestr("data/list.csv", "a,b\n1,2\n")
    count += 1

    # ebook — real .epub
    create_mock_epub(
        base / "ebook/book.epub",
        "Luna Stress Test Ebook",
        "This minimal EPUB exists to exercise the in-app ebook reader.",
    )
    count += 1

    # comic — .cbz is just a zip of ordered page images
    (base / "comic").mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(base / "comic/issue01.cbz", "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("page01.jpg", TINY_JPEG)
    count += 1

    # font — real TTF shipped in the Luna web UI
    font_src = ROOT / "web" / "public" / "fonts" / "FreeMono.ttf"
    (base / "font").mkdir(parents=True, exist_ok=True)
    if font_src.is_file():
        shutil.copy2(font_src, base / "font/FreeMono.ttf")
    else:
        print(f"Warning: font fixture missing at {font_src}", file=sys.stderr)
        (base / "font/FreeMono.ttf").write_bytes(TINY_JPEG)
    count += 1

    # notebook — minimal nbformat 4 .ipynb
    (base / "notebook").mkdir(parents=True, exist_ok=True)
    (base / "notebook/analysis.ipynb").write_text(
        json.dumps(
            {
                "cells": [
                    {
                        "cell_type": "markdown",
                        "metadata": {},
                        "source": ["# Stress Test Notebook\n", "One markdown cell is enough."],
                    }
                ],
                "metadata": {
                    "kernelspec": {
                        "display_name": "Python 3",
                        "language": "python",
                        "name": "python3",
                    },
                    "language_info": {"name": "python", "version": "3.12"},
                },
                "nbformat": 4,
                "nbformat_minor": 5,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    count += 1

    # geo — minimal GeoJSON FeatureCollection
    (base / "geo").mkdir(parents=True, exist_ok=True)
    (base / "geo/waypoint.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [-122.4194, 37.7749]},
                        "properties": {"name": "Stress Test Waypoint"},
                    }
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    count += 1

    # calendar — minimal iCalendar VEVENT (CRLF line endings per RFC 5545)
    (base / "calendar").mkdir(parents=True, exist_ok=True)
    (base / "calendar/event.ics").write_text(
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Luna Mock Drive//EN\r\n"
        "BEGIN:VEVENT\r\n"
        "UID:stress-test-001@luna\r\n"
        "DTSTAMP:20250601T120000Z\r\n"
        "DTSTART:20250615T140000Z\r\n"
        "DTEND:20250615T150000Z\r\n"
        "SUMMARY:Stress Test Event\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n",
        encoding="utf-8",
    )
    count += 1

    # contact — minimal vCard
    (base / "contact").mkdir(parents=True, exist_ok=True)
    (base / "contact/person.vcf").write_text(
        "BEGIN:VCARD\r\n"
        "VERSION:3.0\r\n"
        "FN:Jane Doe\r\n"
        "N:Doe;Jane;;;\r\n"
        "EMAIL:jane.doe@example.com\r\n"
        "TEL;TYPE=CELL:+1-555-123-4567\r\n"
        "END:VCARD\r\n",
        encoding="utf-8",
    )
    count += 1

    # office — reuse the OOXML generators (docx + xlsx)
    create_mock_docx(base / "office/report.docx", "Stress test office document.")
    create_mock_xlsx(base / "office/budget.xlsx", "Stress test spreadsheet, cell A1")
    count += 2

    # cad — ASCII STL, one triangular facet
    (base / "cad").mkdir(parents=True, exist_ok=True)
    (base / "cad/part.stl").write_text(
        "solid stress_test_part\n"
        "  facet normal 0 0 1\n"
        "    outer loop\n"
        "      vertex 0 0 0\n"
        "      vertex 1 0 0\n"
        "      vertex 0 1 0\n"
        "    endloop\n"
        "  endfacet\n"
        "endsolid stress_test_part\n",
        encoding="utf-8",
    )
    count += 1
    return count


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
    "stress": populate_stress,
    "handlers": populate_stress,
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

    # Preset defaults to the drive name when it matches one (so `spawn photos`
    # gives photo fixtures), otherwise falls back to "mixed".
    if args.preset is not None:
        preset = args.preset.lower()
    else:
        preset = name.lower() if name.lower() in PRESETS else "mixed"
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

    # Generate into a hidden sibling and swap it in, so an interrupted spawn
    # never leaves a half-populated drive directory behind.
    MOCK_DRIVES_DIR.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f".{name}.tmp-", dir=MOCK_DRIVES_DIR))
    try:
        (staging_dir / ".drive.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        file_count = PRESETS[preset](staging_dir)
        if target_dir.exists():
            shutil.rmtree(target_dir)
        os.replace(staging_dir, target_dir)
    except BaseException:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

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
    target_dir = MOCK_DRIVES_DIR / name
    if not target_dir.exists():
        print(f"Error: Mock drive '{name}' not found at {target_dir}", file=sys.stderr)
        return 1
    (target_dir / ".unplugged").write_text("", encoding="utf-8")
    print(f">> Simulated UNPLUGGING drive '{name}'. Luna will report it disconnected/missing.")
    return 0


def cmd_plug(args: argparse.Namespace) -> int:
    name = args.name.strip()
    target_dir = MOCK_DRIVES_DIR / name
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
    p_spawn.add_argument("preset", nargs="?", default=None, choices=list(PRESETS.keys()), help="Fixture content preset (default: the drive name if it matches a preset, else 'mixed')")
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
