// @vitest-environment node
/// <reference types="node" />
/**
 * Verifies every extension in OFFICE_FORMATS against the real bundled
 * x2t.wasm — the same converter the in-browser worker runs. Any ext added to
 * OFFICE_FORMATS must convert here; any ext in OFFICE_SAVE_EXT must also
 * write back to a structurally valid file (not just exit 0 — a thin input
 * once produced a 22-byte empty zip with a clean exit code).
 *
 * Skips entirely when the dev pack (luna/dev/eurooffice/x2t) is absent — a
 * Luna without the pack has nothing to verify. Legacy OLE fixtures live in
 * ./fixtures (see its README); OOXML/ODF inputs are built in-memory.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICE_FORMATS, OFFICE_SAVE_EXT } from "../../../lib/fileKinds.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACK_X2T = path.resolve(TEST_DIR, "../../../../../dev/eurooffice/x2t");
const FIXTURES_DIR = path.join(TEST_DIR, "fixtures");
const PACK_AVAILABLE =
  existsSync(path.join(PACK_X2T, "x2t.js")) &&
  existsSync(path.join(PACK_X2T, "x2t.wasm"));

// ---------- minimal stored-zip writer (x2t accepts uncompressed entries) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {[string, string][]} entries name → utf8 content */
function zipStore(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameB = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(head.buffer), nameB, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- document fixtures ----------

const CT_OPEN =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>';
const RELS_OPEN =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

const WORD_CT = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  docxf: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  oform: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  docm: "application/vnd.ms-word.document.macroEnabled.main+xml",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  dotm: "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
};
const CELL_CT = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  xltm: "application/vnd.ms-excel.template.macroEnabled.main+xml",
};
const SLIDE_CT = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  ppsm: "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  potm: "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
};

function wordPkg(mainCt) {
  return zipStore([
    [
      "[Content_Types].xml",
      `<?xml version="1.0"?>${CT_OPEN}` +
        `<Override PartName="/word/document.xml" ContentType="${mainCt}"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body><w:p><w:r><w:t>Luna format check</w:t></w:r></w:p></w:body></w:document>",
    ],
  ]);
}

function cellPkg(mainCt) {
  return zipStore([
    [
      "[Content_Types].xml",
      `<?xml version="1.0"?>${CT_OPEN}` +
        `<Override PartName="/xl/workbook.xml" ContentType="${mainCt}"/>` +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      "xl/workbook.xml",
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Luna format check</t></is></c>' +
        '<c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    ],
  ]);
}

/**
 * A presentation needs its master/layout/theme chain — a deck without one
 * converts to a degenerate Editor.bin and then writes a 22-byte empty zip
 * back out, which is exactly the false negative this suite exists to catch.
 */
function slidePkg(mainCt) {
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return zipStore([
    [
      "[Content_Types].xml",
      `<?xml version="1.0"?>${CT_OPEN}` +
        `<Override PartName="/ppt/presentation.xml" ContentType="${mainCt}"/>` +
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        `<Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ],
    [
      "ppt/presentation.xml",
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
        '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        `<Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rId2" Type="${R}/slide" Target="slides/slide1.xml"/>` +
        `<Relationship Id="rId3" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`,
    ],
    [
      "ppt/slides/slide1.xml",
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
        '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Luna format check</a:t></a:r></a:p></p:txBody></p:sp>' +
        "</p:spTree></p:cSld></p:sld>",
    ],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        `<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    ],
    [
      "ppt/slideMasters/slideMaster1.xml",
      '<?xml version="1.0"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
        "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>",
    ],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        `<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    ],
    [
      "ppt/slideLayouts/slideLayout1.xml",
      '<?xml version="1.0"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="blank">' +
        '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
        "<p:clrMapOvr><a:overrideClrMapping/></p:clrMapOvr></p:sldLayout>",
    ],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      `<?xml version="1.0"?>${RELS_OPEN}` +
        `<Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ],
    [
      "ppt/theme/theme1.xml",
      '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements>' +
        '<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
        '<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>' +
        '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3>' +
        '<a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>' +
        '<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>' +
        '<a:fmtScheme name="f"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
        '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
        '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
        "<a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>",
    ],
  ]);
}

const ODF_BODY = {
  "application/vnd.oasis.opendocument.text":
    '<office:body><office:text><text:p>Luna format check</text:p></office:text></office:body>',
  "application/vnd.oasis.opendocument.text-template":
    '<office:body><office:text><text:p>Luna format check</text:p></office:text></office:body>',
  "application/vnd.oasis.opendocument.spreadsheet":
    '<office:body><office:spreadsheet><table:table table:name="S1"><table:table-row><table:table-cell><text:p>Luna format check</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body>',
  "application/vnd.oasis.opendocument.spreadsheet-template":
    '<office:body><office:spreadsheet><table:table table:name="S1"><table:table-row><table:table-cell><text:p>Luna format check</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body>',
  "application/vnd.oasis.opendocument.presentation":
    '<office:body><office:presentation><draw:page draw:name="p1"><draw:text-box><text:p>Luna format check</text:p></draw:text-box></draw:page></office:presentation></office:body>',
  "application/vnd.oasis.opendocument.presentation-template":
    '<office:body><office:presentation><draw:page draw:name="p1"><draw:text-box><text:p>Luna format check</text:p></draw:text-box></draw:page></office:presentation></office:body>',
};

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';

function odfPkg(mime) {
  return zipStore([
    ["mimetype", mime],
    [
      "content.xml",
      `<?xml version="1.0"?><office:document-content ${ODF_NS}>${ODF_BODY[mime]}</office:document-content>`,
    ],
    [
      "META-INF/manifest.xml",
      '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
        `<manifest:file-entry manifest:media-type="${mime}" manifest:full-path="/"/></manifest:manifest>`,
    ],
  ]);
}

function flatOdf(mime) {
  return new TextEncoder().encode(
    `<?xml version="1.0"?><office:document ${ODF_NS} office:mimetype="${mime}">${ODF_BODY[mime]}</office:document>`,
  );
}

const M = "application/vnd.oasis.opendocument";
/** @type {Record<string, () => Uint8Array>} */
const FIXTURES = {
  ...Object.fromEntries(Object.keys(WORD_CT).map((e) => [e, () => wordPkg(WORD_CT[e])])),
  ...Object.fromEntries(Object.keys(CELL_CT).map((e) => [e, () => cellPkg(CELL_CT[e])])),
  ...Object.fromEntries(Object.keys(SLIDE_CT).map((e) => [e, () => slidePkg(SLIDE_CT[e])])),
  odt: () => odfPkg(`${M}.text`),
  ott: () => odfPkg(`${M}.text-template`),
  ods: () => odfPkg(`${M}.spreadsheet`),
  ots: () => odfPkg(`${M}.spreadsheet-template`),
  odp: () => odfPkg(`${M}.presentation`),
  otp: () => odfPkg(`${M}.presentation-template`),
  fodt: () => flatOdf(`${M}.text`),
  fods: () => flatOdf(`${M}.spreadsheet`),
  fodp: () => flatOdf(`${M}.presentation`),
  rtf: () => new TextEncoder().encode("{\\rtf1\\ansi Luna format check}"),
  // Legacy OLE — real application output, can't be synthesized (see
  // fixtures/README.md).
  xls: () => readFileSync(path.join(FIXTURES_DIR, "real.xls")),
  xlt: () => readFileSync(path.join(FIXTURES_DIR, "real.xlt")),
  ppt: () => readFileSync(path.join(FIXTURES_DIR, "real.ppt")),
  pps: () => readFileSync(path.join(FIXTURES_DIR, "real.pps")),
};

// ---------- x2t.wasm harness (mirrors dev/eurooffice/x2t/office-x2t-worker.js) ----------

let moduleP = null;
function bootX2t() {
  if (moduleP) return moduleP;
  const req = createRequire(import.meta.url);
  const src = readFileSync(path.join(PACK_X2T, "x2t.js"), "utf8");
  moduleP = new Promise((resolve, reject) => {
    const Module = {
      onRuntimeInitialized: () => resolve(Module),
      onAbort: (what) => reject(new Error(`x2t abort: ${what}`)),
      locateFile: (p) => path.join(PACK_X2T, p),
      printErr: () => {},
    };
    const run = new Function("Module", "require", "__dirname", "__filename", src);
    run(Module, req, PACK_X2T, path.join(PACK_X2T, "x2t.js"));
  });
  return moduleP;
}

const WORK_DIRS = ["/working", "/working/media", "/working/fonts", "/working/themes"];

function ensureDirs(FS) {
  for (const d of WORK_DIRS) {
    try {
      FS.mkdir(d);
    } catch {
      /* exists */
    }
  }
}

function cleanWork(FS) {
  ensureDirs(FS);
  for (const f of FS.readdir("/working")) {
    if (f === "." || f === "..") continue;
    const p = `/working/${f}`;
    try {
      FS.unlink(p);
    } catch {
      try {
        FS.rmdir(p);
      } catch {
        /* keep */
      }
    }
  }
}

async function x2t(inName, outName, input) {
  const m = await bootX2t();
  const FS = m.FS;
  cleanWork(FS);
  const params =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    "<m_sFontDir>/working/fonts/</m_sFontDir>" +
    "<m_sThemeDir>/working/themes</m_sThemeDir>" +
    `<m_sFileFrom>/working/${inName}</m_sFileFrom>` +
    `<m_sFileTo>/working/${outName}</m_sFileTo>` +
    "<m_bIsNoBase64>false</m_bIsNoBase64>" +
    "<m_nCsvTxtEncoding>46</m_nCsvTxtEncoding>" +
    "<m_nCsvDelimiter>4</m_nCsvDelimiter>" +
    "</TaskQueueDataConvert>";
  FS.writeFile("/working/params.xml", params);
  FS.writeFile(`/working/${inName}`, input);
  const code = m.ccall("main1", "number", ["string"], ["/working/params.xml"]);
  if (code !== 0) throw new Error(`x2t exit ${code}`);
  let out;
  try {
    out = FS.readFile(`/working/${outName}`);
  } catch {
    throw new Error("x2t produced no output");
  }
  return out;
}

// Lazily built via x2t itself: xlsx → Editor.bin → out.xlsb gives a real
// binary-workbook fixture for the xlsb read check.
let xlsbBytes = null;

async function fixtureFor(ext) {
  if (ext === "xlsb") {
    if (!xlsbBytes) {
      const bin = await x2t("in.xlsx", "Editor.bin", FIXTURES.xlsx());
      xlsbBytes = await x2t("Editor.bin", "out.xlsb", bin);
    }
    return xlsbBytes;
  }
  const make = FIXTURES[ext];
  if (!make) throw new Error(`no fixture for .${ext} — add a builder or committed file`);
  return make();
}

function looksLikeZip(out) {
  return out.length > 200 && out[0] === 0x50 && out[1] === 0x4b;
}

describe.skipIf(!PACK_AVAILABLE)("x2t format verification (real wasm)", () => {
  it(
    "every OFFICE_FORMATS ext converts to a non-trivial Editor.bin",
    async () => {
      const failures = [];
      for (const ext of Object.keys(OFFICE_FORMATS)) {
        try {
          const input = await fixtureFor(ext);
          const bin = await x2t(`in.${ext}`, "Editor.bin", input);
          if (!bin || bin.length < 200) {
            failures.push(`${ext}: converted but Editor.bin is ${bin?.length ?? 0} bytes`);
          }
        } catch (err) {
          failures.push(`${ext}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      expect(failures, `unsupported exts: ${failures.join("; ")}`).toEqual([]);
    },
    300_000,
  );

  it(
    "every OFFICE_SAVE_EXT writes back a structurally valid file",
    async () => {
      const familyInput = {
        word: "docx",
        cell: "xlsx",
        slide: "pptx",
      };
      const failures = [];
      for (const ext of OFFICE_SAVE_EXT) {
        const docType = OFFICE_FORMATS[ext];
        try {
          const input = await fixtureFor(familyInput[docType]);
          const bin = await x2t(`in.${familyInput[docType]}`, "Editor.bin", input);
          const out = await x2t("Editor.bin", `out.${ext}`, bin);
          const valid =
            ext === "rtf"
              ? out.length > 20 && new TextDecoder().decode(out.slice(0, 5)) === "{\\rtf"
              : looksLikeZip(out);
          if (!valid) {
            failures.push(`${ext}: wrote ${out.length} bytes, not a valid container`);
          }
        } catch (err) {
          failures.push(`${ext}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      expect(failures, `unwritable exts: ${failures.join("; ")}`).toEqual([]);
    },
    300_000,
  );

  it(
    "formats we dropped still fail — if this breaks, the pack gained converters; revisit OFFICE_FORMATS",
    async () => {
      const deadInputs = {
        csv: new TextEncoder().encode("a,b\n1,2\n"),
        pdf: new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        epub: zipStore([
          ["mimetype", "application/epub+zip"],
          [
            "META-INF/container.xml",
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="o.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
          ],
          [
            "o.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest/><spine/></package>',
          ],
        ]),
        doc: readFileSync(path.join(FIXTURES_DIR, "real.doc")),
      };
      for (const [ext, input] of Object.entries(deadInputs)) {
        await expect(
          x2t(`in.${ext}`, "Editor.bin", input),
          `.${ext} unexpectedly converted`,
        ).rejects.toThrow();
      }
    },
    120_000,
  );
});
