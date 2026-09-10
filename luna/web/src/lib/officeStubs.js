/**
 * Minimal OOXML stubs (store-method ZIP, no compression).
 * Enough for EuroOffice / LibreOffice to open a blank or text-filled document.
 */

import { listZipEntries, readZipEntry } from "./archiveReader.js";

/**
 * @param {Array<[string, string|Uint8Array]>} entries
 * @returns {Blob}
 */
export function buildStoreZip(entries) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {{ name: Uint8Array, offset: number, size: number, crc: number }[]} */
  const central = [];
  let offset = 0;

  for (const [name, body] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true); // store
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);
    central.push({ name: nameBytes, offset, size: data.length, crc });
    offset += local.length;
  }

  /** @type {Uint8Array[]} */
  const centralChunks = [];
  let centralSize = 0;
  for (const ent of central) {
    const rec = new Uint8Array(46 + ent.name.length);
    const view = new DataView(rec.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(10, 0, true);
    view.setUint32(16, ent.crc, true);
    view.setUint32(20, ent.size, true);
    view.setUint32(24, ent.size, true);
    view.setUint16(28, ent.name.length, true);
    view.setUint32(42, ent.offset, true);
    rec.set(ent.name, 46);
    centralChunks.push(rec);
    centralSize += rec.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, central.length, true);
  eocdView.setUint16(10, central.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  for (const c of centralChunks) {
    out.set(c, pos);
    pos += c.length;
  }
  out.set(eocd, pos);
  return new Blob([out]);
}

/** @param {Uint8Array} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} s */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} [text]
 * @returns {Blob}
 */
export function blankDocx(text = "") {
  const paragraphs = String(text)
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return "<w:p/>";
      return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
    })
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs || "<w:p><w:r><w:t></w:t></w:r></w:p>"}</w:body>
</w:document>`;
  return new Blob(
    [
      buildStoreZip([
        ["[Content_Types].xml", contentTypes],
        ["_rels/.rels", rels],
        ["word/document.xml", document],
      ]),
    ],
    { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  );
}

/**
 * @param {string} [text] put in A1 as a shared string
 * @returns {Blob}
 */
export function blankXlsx(text = "") {
  const cell = String(text ?? "");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t xml:space="preserve">${xmlEscape(cell)}</t></si>
</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
</worksheet>`;
  return new Blob(
    [
      buildStoreZip([
        ["[Content_Types].xml", contentTypes],
        ["_rels/.rels", rels],
        ["xl/workbook.xml", workbook],
        ["xl/_rels/workbook.xml.rels", workbookRels],
        ["xl/sharedStrings.xml", shared],
        ["xl/worksheets/sheet1.xml", sheet],
      ]),
    ],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  );
}

/**
 * @param {string} [text] title text on slide 1
 * @returns {Blob}
 */
export function blankPptx(text = "") {
  const title = String(text ?? "") || " ";
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:t>${xmlEscape(title)}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  return new Blob(
    [
      buildStoreZip([
        ["[Content_Types].xml", contentTypes],
        ["_rels/.rels", rels],
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
      ]),
    ],
    { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  );
}

/**
 * @param {"docx"|"xlsx"|"pptx"} stub
 * @param {string} [text]
 * @returns {Blob}
 */
export function blankOfficeStub(stub, text = "") {
  if (stub === "xlsx") return blankXlsx(text);
  if (stub === "pptx") return blankPptx(text);
  return blankDocx(text);
}

/**
 * Best-effort plain text from an OOXML (or plaintext) buffer for the fallback editor.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {string} pathOrName
 * @returns {Promise<string>}
 */
export async function extractOfficePlainText(bytes, pathOrName) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const name = String(pathOrName || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  // Legacy / non-zip office: do not pretend we can parse.
  if (ext === "doc" || ext === "xls" || ext === "ppt" || ext === "rtf") {
    return "";
  }
  if (ext === "odt" || ext === "ods" || ext === "odp") {
    try {
      return await extractFromZipXml(buf, [/content\.xml$/i], stripXml);
    } catch {
      return "";
    }
  }

  try {
    if (ext === "xlsx" || ext === "xlsm") {
      const shared = await extractFromZipXml(buf, [/xl\/sharedStrings\.xml$/i], stripXml);
      if (shared.trim()) return shared;
      return await extractFromZipXml(buf, [/xl\/worksheets\/[^/]+\.xml$/i], stripXml);
    }
    if (ext === "pptx" || ext === "pptm") {
      return await extractFromZipXml(buf, [/ppt\/slides\/[^/]+\.xml$/i], stripXml);
    }
    // docx / default zip office
    return await extractFromZipXml(buf, [/word\/document\.xml$/i], stripXml);
  } catch {
    // Not a zip — treat as utf-8 text
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(buf),
      );
    } catch {
      return "";
    }
  }
}

/**
 * @param {ArrayBuffer} buf
 * @param {RegExp[]} nameMatchers
 * @param {(xml: string) => string} map
 */
async function extractFromZipXml(buf, nameMatchers, map) {
  const entries = listZipEntries(buf);
  const parts = [];
  for (const ent of entries) {
    if (!nameMatchers.some((re) => re.test(ent.name))) continue;
    const data = await readZipEntry(buf, ent);
    parts.push(map(new TextDecoder("utf-8", { fatal: false }).decode(data)));
  }
  return parts.filter(Boolean).join("\n");
}

/** @param {string} xml */
function stripXml(xml) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
