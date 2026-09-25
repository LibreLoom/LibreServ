// color-scan: ignore-file — hex literals here are zip signatures, CRC
// constants, and CSS fixture strings, not UI styling.
import { describe, expect, it } from "vitest";
import {
  bookAuthor,
  bookTitle,
  flattenToc,
  loadReadingPosition,
  makeZipLoader,
  openEpub,
  positionKey,
  progressInfo,
  readerCss,
  sanitizeBookHtml,
  saveReadingPosition,
} from "./epubReader.js";

/* --- Minimal stored-entry zip builder (method 0, no compression) -------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {{ name: string, data: string|Uint8Array }[]} files
 * @returns {ArrayBuffer}
 */
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === "string" ? enc.encode(file.data) : file.data;
    const name = enc.encode(file.name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);

  const parts = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

/* --- EPUB fixtures ------------------------------------------------------- */

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CHAPTER = (text) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${text}</title><link rel="stylesheet" href="../style.css"/></head>
<body><p>${text}</p></body>
</html>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc">
  <ol>
    <li><a href="text/b.xhtml">Chapter One</a></li>
    <li><a href="text/a.xhtml">Chapter Two</a>
      <ol>
        <li><a href="text/a.xhtml#s2">Section 2.1</a></li>
      </ol>
    </li>
    <li><a href="text/c.xhtml">Chapter Three</a></li>
  </ol>
</nav>
</body>
</html>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Part I</text></navLabel>
      <content src="xhtml/one.xhtml"/>
      <navPoint id="n2" playOrder="2">
        <navLabel><text>Chapter 1</text></navLabel>
        <content src="xhtml/two.xhtml"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;

const OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:creator>Ada Writer</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chB" href="text/b.xhtml" media-type="application/xhtml+xml"/>
    <item id="chA" href="text/a.xhtml" media-type="application/xhtml+xml"/>
    <item id="chC" href="text/c.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chB"/>
    <itemref idref="chA"/>
    <itemref idref="chC"/>
  </spine>
</package>`;

const OPF2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">old-book</dc:identifier>
    <dc:title>Old Book</dc:title>
    <dc:creator opf:role="aut">Old Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="one" href="xhtml/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="two" href="xhtml/two.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="one"/>
    <itemref idref="two"/>
  </spine>
</package>`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function epub3Bytes() {
  return makeZip([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: CONTAINER },
    { name: "OEBPS/content.opf", data: OPF3 },
    { name: "OEBPS/nav.xhtml", data: NAV },
    { name: "OEBPS/text/b.xhtml", data: CHAPTER("First in reading order") },
    { name: "OEBPS/text/a.xhtml", data: CHAPTER("Second in reading order") },
    { name: "OEBPS/text/c.xhtml", data: CHAPTER("Third in reading order") },
    { name: "OEBPS/images/cover.png", data: PNG_BYTES },
    { name: "OEBPS/style.css", data: "body { color: black; }" },
  ]);
}

function epub2Bytes() {
  return makeZip([
    { name: "META-INF/container.xml", data: CONTAINER },
    { name: "OEBPS/content.opf", data: OPF2 },
    { name: "OEBPS/toc.ncx", data: NCX },
    { name: "OEBPS/xhtml/one.xhtml", data: CHAPTER("One") },
    { name: "OEBPS/xhtml/two.xhtml", data: CHAPTER("Two") },
  ]);
}

/* --- Tests --------------------------------------------------------------- */

describe("epubReader parsing", () => {
  it("reads sections in spine order, not alphabetical order", async () => {
    const book = await openEpub(epub3Bytes());
    expect(book.sections.map((s) => s.id)).toEqual([
      "OEBPS/text/b.xhtml",
      "OEBPS/text/a.xhtml",
      "OEBPS/text/c.xhtml",
    ]);
  });

  it("reads title and author from OPF metadata", async () => {
    const book = await openEpub(epub3Bytes());
    expect(bookTitle(book.metadata)).toBe("Test Book");
    expect(bookAuthor(book.metadata)).toBe("Ada Writer");
  });

  it("builds a nested TOC from the EPUB 3 nav document", async () => {
    const book = await openEpub(epub3Bytes());
    expect(book.toc.map((i) => i.label)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter Three",
    ]);
    expect(book.toc[1].subitems.map((i) => i.label)).toEqual(["Section 2.1"]);
    expect(book.toc[0].href).toBe("OEBPS/text/b.xhtml");
  });

  it("finds the cover image declared with the cover-image property", async () => {
    const book = await openEpub(epub3Bytes());
    const cover = await book.getCover();
    expect(cover).toBeTruthy();
    expect(cover.type).toBe("image/png");
  });

  it("falls back to the NCX for EPUB 2 books", async () => {
    const book = await openEpub(epub2Bytes());
    expect(bookTitle(book.metadata)).toBe("Old Book");
    expect(book.toc.map((i) => i.label)).toEqual(["Part I"]);
    expect(book.toc[0].subitems.map((i) => i.label)).toEqual(["Chapter 1"]);
    expect(book.toc[0].href).toBe("OEBPS/xhtml/one.xhtml");
    expect(book.sections).toHaveLength(2);
  });

  it("rejects files that are not readable EPUBs", async () => {
    await expect(openEpub(new TextEncoder().encode("not a zip").buffer))
      .rejects.toThrow();
    // A valid zip with no container.xml is still not an EPUB.
    await expect(openEpub(makeZip([{ name: "a.txt", data: "hi" }])))
      .rejects.toThrow();
  });

  it("serves zip contents through the loader interface", async () => {
    const loader = makeZipLoader(epub3Bytes());
    expect(await loader.loadText("OEBPS/style.css")).toContain("color: black");
    expect(await loader.loadText("missing.xhtml")).toBeNull();
    expect(loader.getSize("OEBPS/style.css")).toBeGreaterThan(0);
    const blob = await loader.loadBlob("OEBPS/images/cover.png");
    expect(blob.size).toBe(PNG_BYTES.length);
  });
});

describe("sanitizeBookHtml", () => {
  const DIRTY = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>t</title><script>alert(1)</script></head>
<body>
  <p onclick="steal()">Hello <a href="javascript:steal()">link</a></p>
  <img src="pic.png" onerror="steal()"/>
</body>
</html>`;

  it("removes script elements, event handlers, and javascript: URLs", () => {
    const out = sanitizeBookHtml(DIRTY);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("Hello");
    expect(out).toContain("pic.png");
  });

  it("injects a script-blocking CSP as the first head element", () => {
    const out = sanitizeBookHtml(DIRTY);
    const csp = out.indexOf("Content-Security-Policy");
    const title = out.indexOf("<title>");
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(title);
    expect(out).toContain("script-src 'none'");
  });

  it("sanitizes text/html documents too", () => {
    const out = sanitizeBookHtml(
      "<html><head></head><body><script>x()</script><p>ok</p></body></html>",
      "text/html",
    );
    expect(out).not.toContain("<script");
    expect(out).toContain("ok");
  });

  it("leaves unparseable or non-markup input untouched", () => {
    expect(sanitizeBookHtml("body { color: red }", "text/css"))
      .toBe("body { color: red }");
  });
});

describe("toc and metadata helpers", () => {
  it("flattens a nested TOC with depth", () => {
    const flat = flattenToc([
      { label: "A", href: "a.xhtml" },
      {
        label: "B",
        href: "b.xhtml",
        subitems: [{ label: "B.1", href: "b.xhtml#1" }],
      },
      { label: "  ", href: "c.xhtml" },
    ]);
    expect(flat.map((i) => [i.label, i.depth])).toEqual([
      ["A", 0],
      ["B", 0],
      ["B.1", 1],
      ["Untitled section", 0],
    ]);
    expect(flattenToc(undefined)).toEqual([]);
  });

  it("normalizes webpub-style language maps and contributor objects", () => {
    expect(bookTitle({ title: { und: "Titel" } })).toBe("Titel");
    expect(bookTitle({})).toBe("");
    expect(bookAuthor({ author: [{ name: "One" }, { name: "Two" }] })).toBe("One, Two");
    expect(bookAuthor({ author: { name: { en: "Solo" } } })).toBe("Solo");
    expect(bookAuthor({})).toBe("");
  });
});

describe("reading position storage", () => {
  it("round-trips cfi and fraction keyed by drive and path", () => {
    const key = positionKey("drive1", "/Books/test.epub");
    expect(key).toContain("drive1");
    expect(key).toContain("/Books/test.epub");
    saveReadingPosition(key, { cfi: "epubcfi(/6/4!/2)", fraction: 0.4 });
    expect(loadReadingPosition(key)).toEqual({
      cfi: "epubcfi(/6/4!/2)",
      fraction: 0.4,
    });
  });

  it("returns null for missing or malformed entries", () => {
    expect(loadReadingPosition("luna-epub-position:none")).toBeNull();
    localStorage.setItem("luna-epub-position:bad", "{not json");
    expect(loadReadingPosition("luna-epub-position:bad")).toBeNull();
    saveReadingPosition("luna-epub-position:empty", {});
    expect(loadReadingPosition("luna-epub-position:empty")).toBeNull();
  });
});

describe("progress and theme css", () => {
  it("prefers the TOC label and reports a clamped percent", () => {
    expect(progressInfo({
      fraction: 0.42,
      section: { current: 2, total: 10 },
      tocItem: { label: "Chapter 3" },
    })).toEqual({ percent: 42, label: "Chapter 3" });
    expect(progressInfo({ fraction: 2, section: { current: 0, total: 4 } }))
      .toEqual({ percent: 100, label: "Section 1 of 4" });
    expect(progressInfo(undefined)).toEqual({ percent: 0, label: "" });
  });

  it("injects theme colors and forces book content to contrast", () => {
    const css = readerCss({ bg: "#000", fg: "#fff", accent: "#767676" });
    expect(css).toContain("--theme-bg-color: #000");
    expect(css).toContain("color: #fff !important");
    expect(css).toContain("color: #767676 !important");
    expect(css).toContain("background: transparent !important");
  });
});
