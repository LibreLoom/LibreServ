//! Pulling words out of document bytes.
//!
//! These functions parse untrusted files, so lunad never calls them on a
//! drive's files directly: the sandboxed worker ([`super::worker`]) runs them
//! as `nobody` under memory and CPU limits. They are still written to fail
//! cleanly — every length is checked, zip entries are read through a cap,
//! and the output stops at [`MAX_TEXT_BYTES`].

use std::io::{Read, Seek};

use super::formats::Format;

/// Most text kept per file. Enough for a long report or a short book; the
/// search index and snippets don't need the rest.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Most bytes inflated from one zip entry.
const MAX_ENTRY_BYTES: u64 = 48 * 1024 * 1024;
/// Most bytes inflated from a whole zip, across entries.
const MAX_ZIP_BYTES: u64 = 96 * 1024 * 1024;
/// Most zip entries looked at.
const MAX_ZIP_ENTRIES: usize = 4000;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    /// Password-protected or encrypted: there is nothing to read without the
    /// password, and that is not a failure worth retrying.
    #[error("the file is protected with a password")]
    Protected,
    /// Not the format its name says, or damaged.
    #[error("the file could not be read: {0}")]
    Unreadable(String),
}

impl ExtractError {
    fn bad(what: impl Into<String>) -> Self {
        Self::Unreadable(what.into())
    }
}

type Result<T> = std::result::Result<T, ExtractError>;

/// Extract `format` text from `input`. PDFs and images are not handled here
/// (poppler and Tesseract read those).
pub fn extract<R: Read + Seek>(format: Format, mut input: R) -> Result<String> {
    let mut out = TextSink::new();
    match format {
        Format::Text => {
            let cap = Format::Text.max_input_bytes();
            let bytes = read_capped(&mut input, cap)?;
            out.push(&decode_text_capped(&bytes, bytes.len() as u64 == cap)?);
        }
        Format::Html => {
            let cap = Format::Html.max_input_bytes();
            let bytes = read_capped(&mut input, cap)?;
            markup_text(
                &decode_text_capped(&bytes, bytes.len() as u64 == cap)?,
                Markup::Html,
                &mut out,
            );
        }
        Format::Rtf => {
            let bytes = read_capped(&mut input, Format::Rtf.max_input_bytes())?;
            rtf_text(&bytes, &mut out);
        }
        Format::Docx | Format::Pptx | Format::Odf | Format::Epub | Format::Sheet
            if is_cfb(&mut input)? && format != Format::Sheet =>
        {
            // A password-protected Office file is an OLE container holding the
            // encrypted zip; anything else in OLE under a new name is damaged.
            open_cfb(input)?;
            return Err(ExtractError::bad("not a zip container"));
        }
        Format::Docx => docx_text(input, &mut out)?,
        Format::Pptx => pptx_text(input, &mut out)?,
        Format::Odf => odf_text(input, &mut out)?,
        Format::Epub => epub_text(input, &mut out)?,
        Format::Sheet => {
            if is_cfb(&mut input)? {
                // `.xls` is OLE too; only the encryption wrapper is refused.
                let probe = cfb::CompoundFile::open(&mut input)
                    .map_err(|e| ExtractError::bad(e.to_string()))?;
                if probe.exists("EncryptionInfo") || probe.exists("EncryptedPackage") {
                    return Err(ExtractError::Protected);
                }
                drop(probe);
                input
                    .rewind()
                    .map_err(|e| ExtractError::bad(e.to_string()))?;
            }
            sheet_text(input, &mut out)?
        }
        Format::Doc => doc_text(input, &mut out)?,
        Format::Ppt => ppt_text(input, &mut out)?,
        Format::Strings => strings_text(&mut input, &mut out)?,
        Format::Pdf | Format::Image => {
            return Err(ExtractError::bad("read by an outside tool"));
        }
    }
    Ok(out.finish())
}

/// Most bytes of an unlisted file that are looked at.
const STRINGS_SCAN_BYTES: u64 = 4 * 1024 * 1024;
/// Shortest run of characters kept from a binary file.
const STRINGS_MIN_RUN: usize = 8;

/// Start bytes of files that hold no searchable words: media, archives,
/// programs, databases.
const BINARY_MAGIC: &[&[u8]] = &[
    b"\x7fELF",
    b"MZ\x90\0",
    b"PK\x03\x04",
    b"\x1f\x8b",
    b"BZh9",
    b"BZh1",
    b"7z\xbc\xaf",
    b"Rar!",
    b"\x89PNG",
    b"\xff\xd8\xff",
    b"GIF89a",
    b"GIF87a",
    b"RIFF",
    b"ID3\x03",
    b"ID3\x04",
    b"OggS",
    b"fLaC",
    b"SQLite format 3",
    b"\0asm",
    b"\xfd7zXZ",
    b"\x28\xb5\x2f\xfd",
    b"\0\0\0\x18ftyp",
    b"\0\0\0\x20ftyp",
    b"\x1a\x45\xdf\xa3",
    b"-----BEGIN PGP",
    b"\xca\xfe\xba\xbe",
];

/// Text of a file with no listed type: the file itself if it is text,
/// otherwise the readable runs inside it. Media and archives give nothing.
fn strings_text<R: Read>(input: &mut R, out: &mut TextSink) -> Result<()> {
    let bytes = read_capped(input, STRINGS_SCAN_BYTES)?;
    if BINARY_MAGIC.iter().any(|m| bytes.starts_with(m)) {
        return Ok(());
    }
    let capped = bytes.len() as u64 == STRINGS_SCAN_BYTES;
    if let Ok(text) = decode_text_capped(&bytes, capped) {
        // Text in a legacy encoding decodes to anything, so a file that is
        // mostly control characters is still treated as binary.
        let ctrl = text
            .chars()
            .take(8192)
            .filter(|c| c.is_control() && !c.is_whitespace())
            .count();
        if ctrl * 100 <= text.chars().take(8192).count() {
            out.push(&text);
            return Ok(());
        }
    }
    // Readable runs, ASCII/UTF-8 first, then UTF-16LE (Windows programs).
    let lossy = String::from_utf8_lossy(&bytes);
    let mut run = String::new();
    let mut flush = |run: &mut String, out: &mut TextSink| {
        if run.chars().count() >= STRINGS_MIN_RUN
            && run.chars().filter(|c| c.is_alphabetic()).count() * 2 >= run.chars().count()
        {
            out.push(run);
            out.line_break();
        }
        run.clear();
    };
    for c in lossy.chars() {
        if out.is_full() {
            return Ok(());
        }
        if c == '\t' || (!c.is_control() && c != '\u{FFFD}') {
            run.push(c);
        } else {
            flush(&mut run, out);
        }
    }
    flush(&mut run, out);
    for pair in bytes.chunks_exact(2) {
        if out.is_full() {
            return Ok(());
        }
        if pair[1] == 0 && (pair[0] == b'\t' || (0x20..0x7f).contains(&pair[0])) {
            run.push(pair[0] as char);
        } else {
            flush(&mut run, out);
        }
    }
    flush(&mut run, out);
    Ok(())
}

/// Starts with the OLE compound-file signature.
fn is_cfb<R: Read + Seek>(input: &mut R) -> Result<bool> {
    let mut magic = [0u8; 8];
    let n = input
        .read(&mut magic)
        .map_err(|e| ExtractError::bad(e.to_string()))?;
    input
        .rewind()
        .map_err(|e| ExtractError::bad(e.to_string()))?;
    Ok(n == 8 && magic == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

fn read_capped<R: Read>(input: &mut R, cap: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .take(cap)
        .read_to_end(&mut bytes)
        .map_err(|e| ExtractError::bad(e.to_string()))?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Output

/// Collects text: control characters dropped, runs of spaces folded, at most
/// two newlines in a row, and nothing past [`MAX_TEXT_BYTES`].
pub struct TextSink {
    buf: String,
    /// Trailing whitespace not yet written: 0 none, 1 space, 2+ newlines.
    pending: u8,
    full: bool,
}

impl Default for TextSink {
    fn default() -> Self {
        Self::new()
    }
}

impl TextSink {
    pub fn new() -> Self {
        Self {
            buf: String::new(),
            pending: 0,
            full: false,
        }
    }

    pub fn is_full(&self) -> bool {
        self.full
    }

    pub fn push(&mut self, s: &str) {
        for ch in s.chars() {
            self.push_char(ch);
            if self.full {
                return;
            }
        }
    }

    pub fn push_char(&mut self, ch: char) {
        if self.full {
            return;
        }
        match ch {
            '\n' | '\u{2028}' | '\u{000B}' => self.line_break(),
            '\u{2029}' | '\u{000C}' => self.newline(),
            '\r' => {}
            c if c.is_whitespace() => self.space(),
            c if c.is_control() || ('\u{FFF0}'..='\u{FFFF}').contains(&c) => {}
            c => {
                let gap = match self.pending {
                    0 => "",
                    1 => " ",
                    2 => "\n",
                    _ => "\n\n",
                };
                if self.buf.is_empty() {
                    self.pending = 0;
                }
                if self.buf.len() + gap.len() + c.len_utf8() > MAX_TEXT_BYTES {
                    self.full = true;
                    return;
                }
                if !self.buf.is_empty() {
                    self.buf.push_str(gap);
                }
                self.pending = 0;
                self.buf.push(c);
            }
        }
    }

    pub fn space(&mut self) {
        if self.pending == 0 {
            self.pending = 1;
        }
    }

    /// End a line. Two in a row make a paragraph break.
    pub fn line_break(&mut self) {
        self.pending = match self.pending {
            0 | 1 => 2,
            _ => 3,
        };
    }

    /// End a paragraph: one blank line before whatever comes next.
    pub fn newline(&mut self) {
        self.pending = 3;
    }

    pub fn finish(mut self) -> String {
        // Cut off at the cap: end on a whole word, not half of one.
        if self.full
            && let Some(at) = self.buf.rfind(char::is_whitespace)
        {
            self.buf.truncate(at);
        }
        self.buf
    }
}

// ---------------------------------------------------------------------------
// Plain text

/// Decode text in whatever encoding it most likely uses: a byte-order mark
/// wins, then UTF-8, then Windows-1252 (which maps every byte). Bytes that
/// look binary are refused so a renamed program isn't indexed as words.
pub fn decode_text(bytes: &[u8]) -> Result<String> {
    decode_text_capped(bytes, false)
}

/// [`decode_text`] for bytes that may stop at the size cap (`capped`), where a
/// multi-byte character cut in half is still UTF-8.
fn decode_text_capped(bytes: &[u8], capped: bool) -> Result<String> {
    if let Some((enc, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom..]);
        return Ok(text.into_owned());
    }
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        // UTF-16 without a mark: every other byte zero in ASCII text.
        let zeros_odd = head.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        let zeros_even = head.iter().step_by(2).filter(|b| **b == 0).count();
        let half = head.len() / 2;
        if half > 0 && zeros_odd * 10 > half * 8 && zeros_even * 10 < half {
            let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(bytes);
            return Ok(text.into_owned());
        }
        if half > 0 && zeros_even * 10 > half * 8 && zeros_odd * 10 < half {
            let (text, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(bytes);
            return Ok(text.into_owned());
        }
        return Err(ExtractError::bad("binary data, not text"));
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        // A cut-off multi-byte character at the cap is still UTF-8.
        Err(e) if capped && e.error_len().is_none() => {
            Ok(String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned())
        }
        Err(_) => {
            let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
            Ok(text.into_owned())
        }
    }
}

// ---------------------------------------------------------------------------
// Markup (XML and HTML)

#[derive(Clone, Copy, PartialEq, Eq)]
enum Markup {
    /// Keep all text; `<script>`/`<style>` dropped; block tags break lines.
    Html,
    /// Keep only text inside the named elements (`w:t`, `a:t`).
    Only(&'static [&'static str]),
    /// Keep all text (OpenDocument: words are the elements' own content).
    All,
}

/// Elements that end a line or paragraph in the formats Luna reads.
const BREAK_TAGS: &[&str] = &[
    "w:p",
    "w:br",
    "w:cr",
    "a:p",
    "a:br",
    "text:p",
    "text:h",
    "text:line-break",
    "text:list-item",
    "table:table-row",
    "p",
    "br",
    "div",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "section",
    "article",
    "blockquote",
    "pre",
    "title",
    "td",
    "th",
];
/// Elements that stand for a space or tab.
const SPACE_TAGS: &[&str] = &["w:tab", "a:tab", "text:s", "text:tab", "table:table-cell"];

fn local_is(name: &str, list: &[&str]) -> bool {
    list.iter().any(|t| t.eq_ignore_ascii_case(name))
}

/// Walk markup and push its text into `out`. Tolerant on purpose: a
/// malformed tag ends at the next `>`, and anything unknown is skipped.
fn markup_text(src: &str, mode: Markup, out: &mut TextSink) {
    let bytes = src.as_bytes();
    let mut i = 0;
    // Depth inside elements whose text counts (Only mode).
    let mut keep_depth = 0usize;
    // Inside <script>/<style>: skip until the matching close tag.
    let mut skip_until: Option<&'static str> = None;
    let mut text_start = 0;
    while i < bytes.len() {
        if out.is_full() {
            return;
        }
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // Flush the text run before this tag.
        if text_start < i && skip_until.is_none() {
            let keep = match mode {
                Markup::Only(_) => keep_depth > 0,
                _ => true,
            };
            if keep {
                push_entities(&src[text_start..i], out);
            }
        }
        // Comments, CDATA, and declarations.
        if src[i..].starts_with("<!--") {
            i = src[i..].find("-->").map_or(bytes.len(), |p| i + p + 3);
            text_start = i;
            continue;
        }
        if src[i..].starts_with("<![CDATA[") {
            let end = src[i..].find("]]>").map_or(bytes.len(), |p| i + p);
            if skip_until.is_none() {
                let keep = match mode {
                    Markup::Only(_) => keep_depth > 0,
                    _ => true,
                };
                if keep {
                    out.push(&src[i + 9..end]);
                }
            }
            i = (end + 3).min(bytes.len());
            text_start = i;
            continue;
        }
        let end = match src[i..].find('>') {
            Some(p) => i + p,
            None => break,
        };
        let tag = &src[i + 1..end];
        i = end + 1;
        text_start = i;
        if tag.starts_with('!') || tag.starts_with('?') {
            continue;
        }
        let closing = tag.starts_with('/');
        let self_closing = tag.ends_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if let Some(until) = skip_until {
            if closing && name.eq_ignore_ascii_case(until) {
                skip_until = None;
            }
            continue;
        }
        if mode == Markup::Html && !closing && !self_closing {
            if name.eq_ignore_ascii_case("script") {
                skip_until = Some("script");
                continue;
            }
            if name.eq_ignore_ascii_case("style") {
                skip_until = Some("style");
                continue;
            }
        }
        if let Markup::Only(keep) = mode
            && local_is(name, keep)
            && !self_closing
        {
            if closing {
                keep_depth = keep_depth.saturating_sub(1);
            } else {
                keep_depth += 1;
            }
        }
        if local_is(name, BREAK_TAGS) {
            let line_only = ["br", "w:br", "w:cr", "a:br", "text:line-break"]
                .iter()
                .any(|t| t.eq_ignore_ascii_case(name));
            if line_only {
                out.line_break();
            } else if closing || self_closing {
                out.newline();
            }
        } else if local_is(name, SPACE_TAGS) {
            out.space();
        }
    }
    if text_start < bytes.len() && skip_until.is_none() {
        let keep = match mode {
            Markup::Only(_) => keep_depth > 0,
            _ => true,
        };
        if keep {
            push_entities(&src[text_start..], out);
        }
    }
}

/// Push text with `&amp;`-style entities decoded.
fn push_entities(s: &str, out: &mut TextSink) {
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push(&rest[..amp]);
        let after = &rest[amp + 1..];
        let semi = after.find(';').filter(|p| *p <= 10);
        let decoded = semi.and_then(|p| entity(&after[..p]));
        match (semi, decoded) {
            (Some(p), Some(ch)) => {
                out.push_char(ch);
                rest = &after[p + 1..];
            }
            _ => {
                out.push_char('&');
                rest = after;
            }
        }
    }
    out.push(rest);
}

fn entity(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse().ok()?
        };
        return char::from_u32(code);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "rsquo" | "lsquo" => '\'',
        "rdquo" | "ldquo" => '"',
        "euro" => '€',
        "copy" => '©',
        "reg" => '®',
        "auml" => 'ä',
        "ouml" => 'ö',
        "uuml" => 'ü',
        "Auml" => 'Ä',
        "Ouml" => 'Ö',
        "Uuml" => 'Ü',
        "szlig" => 'ß',
        "eacute" => 'é',
        "egrave" => 'è',
        "aacute" => 'á',
        "agrave" => 'à',
        "ccedil" => 'ç',
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Zip-based formats

struct CappedZip<R: Read + Seek> {
    zip: zip::ZipArchive<R>,
    inflated: u64,
}

impl<R: Read + Seek> CappedZip<R> {
    fn open(input: R) -> Result<Self> {
        let zip = zip::ZipArchive::new(input).map_err(|e| match e {
            // An encrypted Office file is an OLE container, not a zip.
            zip::result::ZipError::InvalidArchive(_) => ExtractError::bad("not a zip container"),
            other => ExtractError::bad(other.to_string()),
        })?;
        if zip.len() > MAX_ZIP_ENTRIES * 4 {
            return Err(ExtractError::bad("too many entries"));
        }
        Ok(Self { zip, inflated: 0 })
    }

    fn names(&self) -> Vec<String> {
        self.zip
            .file_names()
            .take(MAX_ZIP_ENTRIES)
            .filter_map(|n| n.ok().map(|n| n.into_owned()))
            .collect()
    }

    /// One entry as text, or `None` if it isn't there. Inflation stops at the
    /// per-entry and whole-archive caps (a zip bomb just gets cut off).
    fn read(&mut self, name: &str) -> Result<Option<String>> {
        let left = MAX_ZIP_BYTES.saturating_sub(self.inflated);
        if left == 0 {
            return Ok(None);
        }
        let entry = match self.zip.by_name(name) {
            Ok(e) => e,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(zip::result::ZipError::UnsupportedArchive(msg)) if msg.contains("ncrypt") => {
                return Err(ExtractError::Protected);
            }
            Err(e) => return Err(ExtractError::bad(e.to_string())),
        };
        if entry.encrypted() {
            return Err(ExtractError::Protected);
        }
        let mut bytes = Vec::new();
        entry
            .take(MAX_ENTRY_BYTES.min(left))
            .read_to_end(&mut bytes)
            .map_err(|e| ExtractError::bad(e.to_string()))?;
        self.inflated += bytes.len() as u64;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

/// Numeric order for `slide12.xml`-style names, so slide 2 comes before 10.
fn numbered(names: &[String], prefix: &str) -> Vec<String> {
    let mut found: Vec<(u32, String)> = names
        .iter()
        .filter_map(|n| {
            let rest = n.strip_prefix(prefix)?.strip_suffix(".xml")?;
            rest.parse().ok().map(|k| (k, n.clone()))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, n)| n).collect()
}

fn docx_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let mut zip = CappedZip::open(input)?;
    let names = zip.names();
    let main = zip
        .read("word/document.xml")?
        .ok_or_else(|| ExtractError::bad("no document body"))?;
    markup_text(&main, Markup::Only(&["w:t"]), out);
    let mut extra: Vec<String> = names
        .iter()
        .filter(|n| {
            n.starts_with("word/header")
                || n.starts_with("word/footer")
                || *n == "word/footnotes.xml"
                || *n == "word/endnotes.xml"
                || *n == "word/comments.xml"
        })
        .cloned()
        .collect();
    extra.sort();
    for name in extra {
        if let Some(xml) = zip.read(&name)? {
            out.newline();
            markup_text(&xml, Markup::Only(&["w:t"]), out);
        }
    }
    Ok(())
}

fn pptx_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let mut zip = CappedZip::open(input)?;
    let names = zip.names();
    let slides = numbered(&names, "ppt/slides/slide");
    if slides.is_empty() {
        return Err(ExtractError::bad("no slides"));
    }
    let notes = numbered(&names, "ppt/notesSlides/notesSlide");
    for name in slides.iter().chain(notes.iter()) {
        if let Some(xml) = zip.read(name)? {
            markup_text(&xml, Markup::Only(&["a:t"]), out);
            out.newline();
        }
    }
    Ok(())
}

fn odf_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let mut zip = CappedZip::open(input)?;
    let xml = zip
        .read("content.xml")?
        .ok_or_else(|| ExtractError::bad("no content.xml"))?;
    if zip.names().iter().any(|n| n == "META-INF/manifest.xml")
        && let Some(manifest) = zip.read("META-INF/manifest.xml")?
        && manifest.contains("encryption-data")
    {
        return Err(ExtractError::Protected);
    }
    // Only the body: styles and settings carry no words worth finding.
    let body = xml.find("<office:body").map_or(xml.as_str(), |p| &xml[p..]);
    markup_text(body, Markup::All, out);
    Ok(())
}

fn epub_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let mut zip = CappedZip::open(input)?;
    let names = zip.names();
    let mut pages: Vec<&String> = names
        .iter()
        .filter(|n| {
            let l = n.to_ascii_lowercase();
            l.ends_with(".xhtml") || l.ends_with(".html") || l.ends_with(".htm")
        })
        .collect();
    if pages.is_empty() {
        return Err(ExtractError::bad("no pages"));
    }
    pages.sort();
    for name in pages {
        if out.is_full() {
            break;
        }
        if let Some(page) = zip.read(name)? {
            markup_text(&page, Markup::Html, out);
            out.newline();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Spreadsheets

fn sheet_text<R: Read + Seek>(mut input: R, out: &mut TextSink) -> Result<()> {
    use calamine::{Data, Reader};
    // calamine wants a `Read + Seek` that it can sniff; read the (size-capped)
    // file once so every format path sees the same bytes.
    let bytes = read_capped(&mut input, Format::Sheet.max_input_bytes())?;
    let mut book =
        calamine::open_workbook_auto_from_rs(std::io::Cursor::new(bytes)).map_err(|e| {
            let msg = e.to_string();
            if msg.to_ascii_lowercase().contains("password")
                || msg.to_ascii_lowercase().contains("encrypt")
            {
                ExtractError::Protected
            } else {
                ExtractError::bad(msg)
            }
        })?;
    let sheets = book.sheet_names().to_vec();
    for name in sheets {
        if out.is_full() {
            break;
        }
        out.push(&name);
        out.newline();
        let Ok(range) = book.worksheet_range(&name) else {
            continue;
        };
        for row in range.rows() {
            if out.is_full() {
                break;
            }
            let mut any = false;
            for cell in row {
                let text = match cell {
                    Data::Empty | Data::Error(_) => continue,
                    Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
                    Data::Float(f) => format_number(*f),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(d) => d.to_string(),
                };
                if any {
                    out.space();
                }
                out.push(&text);
                any = true;
            }
            if any {
                out.newline();
            }
        }
    }
    Ok(())
}

/// `12.0` as `12`, other numbers as written.
fn format_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

// ---------------------------------------------------------------------------
// Word 97–2003

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn read_stream<R: Read + Seek>(
    cfb: &mut cfb::CompoundFile<R>,
    name: &str,
    cap: u64,
) -> Result<Vec<u8>> {
    let mut stream = cfb
        .open_stream(name)
        .map_err(|_| ExtractError::bad(format!("no {name} stream")))?;
    read_capped(&mut stream, cap)
}

fn open_cfb<R: Read + Seek>(input: R) -> Result<cfb::CompoundFile<R>> {
    let cfb = cfb::CompoundFile::open(input).map_err(|e| ExtractError::bad(e.to_string()))?;
    // Office "encrypt with password" wraps the real file in these streams.
    if cfb.exists("EncryptionInfo") || cfb.exists("EncryptedPackage") {
        return Err(ExtractError::Protected);
    }
    Ok(cfb)
}

/// Text of a `.doc`, following its piece table ([MS-DOC] 2.4.1): the
/// document is a list of pieces, each either 8-bit Windows-1252 or UTF-16.
fn doc_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let cap = Format::Doc.max_input_bytes();
    let mut cfb = open_cfb(input)?;
    let word = read_stream(&mut cfb, "WordDocument", cap)?;
    if u16_at(&word, 0) != Some(0xA5EC) {
        return Err(ExtractError::bad("not a Word document"));
    }
    let flags = u16_at(&word, 0x0A).ok_or_else(|| ExtractError::bad("short header"))?;
    if flags & 0x0100 != 0 {
        return Err(ExtractError::Protected);
    }
    let table_name = if flags & 0x0200 != 0 {
        "1Table"
    } else {
        "0Table"
    };
    // FibBase (32 bytes), then csw + FibRgW, cslw + FibRgLw, cbRgFcLcb + pairs.
    let mut at = 32usize;
    let csw = u16_at(&word, at).ok_or_else(|| ExtractError::bad("short header"))? as usize;
    at += 2 + csw * 2;
    let cslw = u16_at(&word, at).ok_or_else(|| ExtractError::bad("short header"))? as usize;
    at += 2 + cslw * 4;
    let pairs = u16_at(&word, at).ok_or_else(|| ExtractError::bad("short header"))? as usize;
    at += 2;
    // fcClx/lcbClx is pair 33 of FibRgFcLcb97.
    if pairs <= 33 {
        return Err(ExtractError::bad("no piece table"));
    }
    let fc_clx =
        u32_at(&word, at + 33 * 8).ok_or_else(|| ExtractError::bad("short header"))? as usize;
    let lcb_clx =
        u32_at(&word, at + 33 * 8 + 4).ok_or_else(|| ExtractError::bad("short header"))? as usize;
    let table = read_stream(&mut cfb, table_name, cap)?;
    let clx = table
        .get(fc_clx..fc_clx.saturating_add(lcb_clx))
        .ok_or_else(|| ExtractError::bad("piece table out of range"))?;
    // Skip Prc entries (0x01) until the Pcdt (0x02).
    let mut p = 0usize;
    while clx.get(p) == Some(&0x01) {
        let len = u16_at(clx, p + 1).ok_or_else(|| ExtractError::bad("bad piece table"))?;
        p += 3 + len as usize;
    }
    if clx.get(p) != Some(&0x02) {
        return Err(ExtractError::bad("bad piece table"));
    }
    let lcb = u32_at(clx, p + 1).ok_or_else(|| ExtractError::bad("bad piece table"))? as usize;
    let plc = clx
        .get(p + 5..(p + 5).saturating_add(lcb))
        .ok_or_else(|| ExtractError::bad("bad piece table"))?;
    if lcb < 4 || !(lcb - 4).is_multiple_of(12) {
        return Err(ExtractError::bad("bad piece table"));
    }
    let n = (lcb - 4) / 12;
    let mut field_depth = 0u32;
    let mut in_instruction = false;
    for i in 0..n {
        if out.is_full() {
            break;
        }
        let cp_start = u32_at(plc, i * 4).unwrap_or(0) as usize;
        let cp_end = u32_at(plc, (i + 1) * 4).unwrap_or(0) as usize;
        let count = cp_end.saturating_sub(cp_start);
        let pcd = (n + 1) * 4 + i * 8;
        let fc = u32_at(plc, pcd + 2).ok_or_else(|| ExtractError::bad("bad piece table"))?;
        let compressed = fc & 0x4000_0000 != 0;
        let raw: String = if compressed {
            let off = ((fc & 0x3FFF_FFFF) / 2) as usize;
            let Some(bytes) = word.get(off..off.saturating_add(count)) else {
                continue;
            };
            encoding_rs::WINDOWS_1252
                .decode_without_bom_handling(bytes)
                .0
                .into_owned()
        } else {
            let off = fc as usize;
            let Some(bytes) = word.get(off..off.saturating_add(count * 2)) else {
                continue;
            };
            encoding_rs::UTF_16LE
                .decode_without_bom_handling(bytes)
                .0
                .into_owned()
        };
        for ch in raw.chars() {
            match ch {
                // Field begin / separator / end: the instruction between
                // begin and separator ("HYPERLINK …", "PAGE") is not text.
                '\u{13}' => {
                    field_depth += 1;
                    in_instruction = true;
                }
                '\u{14}' => in_instruction = false,
                '\u{15}' => {
                    field_depth = field_depth.saturating_sub(1);
                    in_instruction = false;
                }
                _ if in_instruction && field_depth > 0 => {}
                '\r' | '\u{0B}' | '\u{0C}' => out.newline(),
                '\u{07}' | '\t' => out.space(),
                c => out.push_char(c),
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// PowerPoint 97–2003

/// Text of a `.ppt`: the TextCharsAtom (UTF-16) and TextBytesAtom (8-bit)
/// records of the "PowerPoint Document" stream, skipping slide masters so
/// "Click to edit Master title style" isn't in every file.
fn ppt_text<R: Read + Seek>(input: R, out: &mut TextSink) -> Result<()> {
    let mut cfb = open_cfb(input)?;
    let doc = read_stream(
        &mut cfb,
        "PowerPoint Document",
        Format::Ppt.max_input_bytes(),
    )?;
    const MAIN_MASTER: u16 = 0x03F8;
    const TEXT_CHARS: u16 = 0x0FA0;
    const TEXT_BYTES: u16 = 0x0FA8;
    let mut pos = 0usize;
    let mut any = false;
    while pos + 8 <= doc.len() {
        if out.is_full() {
            break;
        }
        let ver_inst = u16_at(&doc, pos).unwrap_or(0);
        let rec_type = u16_at(&doc, pos + 2).unwrap_or(0);
        let len = u32_at(&doc, pos + 4).unwrap_or(0) as usize;
        let container = ver_inst & 0x000F == 0x000F;
        let body = pos + 8;
        if container && rec_type != MAIN_MASTER {
            pos = body;
            continue;
        }
        let end = body.saturating_add(len);
        if end > doc.len() {
            break;
        }
        match rec_type {
            TEXT_CHARS => {
                out.push(
                    &encoding_rs::UTF_16LE
                        .decode_without_bom_handling(&doc[body..end])
                        .0,
                );
                out.newline();
                any = true;
            }
            TEXT_BYTES => {
                out.push(
                    &encoding_rs::WINDOWS_1252
                        .decode_without_bom_handling(&doc[body..end])
                        .0,
                );
                out.newline();
                any = true;
            }
            _ => {}
        }
        pos = end;
    }
    if !any && doc.is_empty() {
        return Err(ExtractError::bad("empty presentation"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// RTF

/// Destinations whose content is not document text.
const RTF_SKIP: &[&str] = &[
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "object",
    "themedata",
    "colorschememapping",
    "datastore",
    "latentstyles",
    "listtable",
    "listoverridetable",
    "rsidtbl",
    "generator",
    "xmlnstbl",
    "mmathPr",
    "filetbl",
    "revtbl",
    "pgdsctbl",
    "fldinst",
];

fn rtf_text(bytes: &[u8], out: &mut TextSink) {
    // Per group: (skipping, unicode fallback count).
    let mut stack: Vec<(bool, usize)> = vec![(false, 1)];
    let mut i = 0usize;
    let mut skip_chars = 0usize;
    let mut pending_star = false;
    while i < bytes.len() {
        if out.is_full() {
            return;
        }
        let (skipping, uc) = *stack.last().unwrap_or(&(false, 1));
        match bytes[i] {
            b'{' => {
                stack.push((skipping, uc));
                i += 1;
            }
            b'}' => {
                if stack.len() > 1 {
                    stack.pop();
                }
                i += 1;
            }
            b'\\' => {
                i += 1;
                let Some(&c) = bytes.get(i) else { break };
                if c == b'\'' {
                    // \'hh: one Windows-1252 byte.
                    let hex = bytes
                        .get(i + 1..i + 3)
                        .and_then(|h| std::str::from_utf8(h).ok());
                    i += 3;
                    if skip_chars > 0 {
                        skip_chars -= 1;
                        continue;
                    }
                    if !skipping && let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                        let one = [b];
                        let s = encoding_rs::WINDOWS_1252
                            .decode_without_bom_handling(&one)
                            .0;
                        out.push(&s);
                    }
                    continue;
                }
                if !c.is_ascii_alphabetic() {
                    // Control symbol: \\ \{ \} are literal, \* marks an
                    // ignorable destination, \~ is a hard space.
                    i += 1;
                    match c {
                        b'*' => pending_star = true,
                        b'~' if !skipping => out.space(),
                        b'\\' | b'{' | b'}' if !skipping => out.push_char(c as char),
                        b'\n' | b'\r' if !skipping => out.newline(),
                        _ => {}
                    }
                    continue;
                }
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let word = std::str::from_utf8(&bytes[start..i]).unwrap_or("");
                let num_start = i;
                if i < bytes.len() && (bytes[i] == b'-' || bytes[i].is_ascii_digit()) {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let num: Option<i32> = std::str::from_utf8(&bytes[num_start..i])
                    .ok()
                    .and_then(|s| s.parse().ok());
                if bytes.get(i) == Some(&b' ') {
                    i += 1;
                }
                if pending_star || RTF_SKIP.contains(&word) {
                    pending_star = false;
                    if let Some(top) = stack.last_mut() {
                        top.0 = true;
                    }
                    continue;
                }
                if skipping {
                    continue;
                }
                match word {
                    "par" | "line" | "sect" | "page" | "row" => out.newline(),
                    "tab" | "cell" => out.space(),
                    "uc" => {
                        if let Some(top) = stack.last_mut() {
                            top.1 = num.unwrap_or(1).max(0) as usize;
                        }
                    }
                    "u" => {
                        if let Some(n) = num {
                            let code = if n < 0 { n + 65536 } else { n } as u32;
                            if let Some(ch) = char::from_u32(code) {
                                out.push_char(ch);
                            }
                            skip_chars = uc;
                        }
                    }
                    "emdash" => out.push_char('—'),
                    "endash" => out.push_char('–'),
                    "lquote" | "rquote" => out.push_char('\''),
                    "ldblquote" | "rdblquote" => out.push_char('"'),
                    "bullet" => out.push_char('•'),
                    _ => {}
                }
            }
            b'\r' | b'\n' => i += 1,
            c => {
                i += 1;
                if skip_chars > 0 {
                    skip_chars -= 1;
                    continue;
                }
                if !skipping {
                    if c.is_ascii() {
                        out.push_char(c as char);
                    } else {
                        let one = [c];
                        let s = encoding_rs::WINDOWS_1252
                            .decode_without_bom_handling(&one)
                            .0;
                        out.push(&s);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[test]
    fn strings_reads_unlisted_text_and_binary_runs_but_not_media() {
        let text = extract(
            Format::Strings,
            Cursor::new(b"fn main() { println!(\"quarterly budget\"); }".to_vec()),
        )
        .unwrap();
        assert!(text.contains("quarterly budget"));
        let mut bin = vec![0u8, 1, 2, 3, 0, 0];
        bin.extend_from_slice(b"Copyright Example Corporation");
        bin.extend_from_slice(&[0, 0, 7, 0, 9]);
        let got = extract(Format::Strings, Cursor::new(bin)).unwrap();
        assert!(got.contains("Copyright Example Corporation"));
        let png = extract(
            Format::Strings,
            Cursor::new(b"\x89PNG\r\n\x1a\nsome readable words here".to_vec()),
        )
        .unwrap();
        assert!(png.is_empty());
    }

    fn zip_with(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    fn run(format: Format, bytes: Vec<u8>) -> Result<String> {
        extract(format, Cursor::new(bytes))
    }

    #[test]
    fn text_decodes_utf8_utf16_and_windows_1252() {
        assert_eq!(
            run(Format::Text, "Grüße\r\nzweite".into()).unwrap(),
            "Grüße\nzweite"
        );
        let mut utf16 = vec![0xFF, 0xFE];
        for u in "Rechnung".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(run(Format::Text, utf16).unwrap(), "Rechnung");
        assert_eq!(
            run(Format::Text, vec![b'c', b'a', b'f', 0xE9]).unwrap(),
            "café"
        );
    }

    #[test]
    fn binary_named_txt_is_refused() {
        let mut bytes = b"\x7fELF".to_vec();
        bytes.extend([0u8, 1, 2, 0, 0, 0, 9, 0, 0, 0, 3, 0, 0x55, 0, 0, 0]);
        assert!(matches!(
            run(Format::Text, bytes),
            Err(ExtractError::Unreadable(_))
        ));
    }

    #[test]
    fn whitespace_is_folded_and_output_is_capped() {
        assert_eq!(
            run(Format::Text, "a   b\n\n\n\nc\t\td".into()).unwrap(),
            "a b\n\nc d"
        );
        let big = "word ".repeat(MAX_TEXT_BYTES);
        let got = run(Format::Text, big.into_bytes()).unwrap();
        assert!(got.len() <= MAX_TEXT_BYTES);
        assert!(got.ends_with("word"));
    }

    #[test]
    fn html_drops_scripts_styles_and_tags_but_keeps_words() {
        let html = "<html><head><title>Garden plan</title><style>p{color:red}</style>\
                    <script>var secret = 1;</script></head><body><p>Tomatoes &amp; beans</p>\
                    <!-- hidden note --><div>Water&nbsp;daily</div></body></html>";
        let got = run(Format::Html, html.into()).unwrap();
        assert_eq!(got, "Garden plan\n\nTomatoes & beans\n\nWater daily");
    }

    #[test]
    fn docx_reads_body_headers_and_footnotes_without_field_codes() {
        let doc = r#"<w:document><w:body><w:p><w:r><w:t>Lease</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> agreement</w:t></w:r></w:p><w:p><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r><w:r><w:t>Rent is due monthly.</w:t></w:r></w:p></w:body></w:document>"#;
        let header = r#"<w:hdr><w:p><w:r><w:t>Flat 4</w:t></w:r></w:p></w:hdr>"#;
        let bytes = zip_with(&[("word/document.xml", doc), ("word/header1.xml", header)]);
        let got = run(Format::Docx, bytes).unwrap();
        assert_eq!(got, "Lease agreement\n\nRent is due monthly.\n\nFlat 4");
        assert!(!got.contains("HYPERLINK"));
    }

    #[test]
    fn pptx_reads_slides_in_number_order() {
        let slide = |t: &str| format!("<p:sld><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>");
        let bytes = zip_with(&[
            ("ppt/slides/slide10.xml", &slide("ten")),
            ("ppt/slides/slide2.xml", &slide("two")),
            ("ppt/slides/slide1.xml", &slide("one")),
        ]);
        assert_eq!(run(Format::Pptx, bytes).unwrap(), "one\n\ntwo\n\nten");
    }

    #[test]
    fn odt_reads_the_body_only() {
        let content = r#"<office:document-content><office:automatic-styles><style:style style:name="P1">ignored</style:style></office:automatic-styles><office:body><office:text><text:h>Minutes</text:h><text:p>Budget<text:s/>approved</text:p></office:text></office:body></office:document-content>"#;
        let bytes = zip_with(&[("content.xml", content), ("META-INF/manifest.xml", "<m/>")]);
        assert_eq!(
            run(Format::Odf, bytes).unwrap(),
            "Minutes\n\nBudget approved"
        );
    }

    #[test]
    fn encrypted_odf_is_protected() {
        let bytes = zip_with(&[
            ("content.xml", "garbage"),
            ("META-INF/manifest.xml", "<manifest:encryption-data/>"),
        ]);
        assert!(matches!(
            run(Format::Odf, bytes),
            Err(ExtractError::Protected)
        ));
    }

    #[test]
    fn a_zip_bomb_is_cut_off_not_followed() {
        // 200 MiB of one letter compresses to a few hundred KiB.
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            w.start_file("word/document.xml", opts).unwrap();
            w.write_all(b"<w:t>").unwrap();
            let chunk = vec![b'a'; 1024 * 1024];
            for _ in 0..200 {
                w.write_all(&chunk).unwrap();
            }
            w.finish().unwrap();
        }
        let got = run(Format::Docx, buf.into_inner()).unwrap();
        assert!(got.len() <= MAX_TEXT_BYTES);
    }

    #[test]
    fn not_a_zip_is_unreadable() {
        assert!(matches!(
            run(Format::Docx, b"plain bytes".to_vec()),
            Err(ExtractError::Unreadable(_))
        ));
    }

    #[test]
    fn epub_reads_its_pages() {
        let bytes = zip_with(&[
            ("mimetype", "application/epub+zip"),
            (
                "OEBPS/ch1.xhtml",
                "<html><body><p>Chapter one</p></body></html>",
            ),
            (
                "OEBPS/ch2.xhtml",
                "<html><body><p>Chapter two</p></body></html>",
            ),
        ]);
        assert_eq!(
            run(Format::Epub, bytes).unwrap(),
            "Chapter one\n\nChapter two"
        );
    }

    #[test]
    fn rtf_keeps_text_and_drops_tables_of_fonts() {
        let rtf = br"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\generator Word;}\f0 Invoice\par Total: 12\'80 \u8364?\tab paid}";
        let got = run(Format::Rtf, rtf.to_vec()).unwrap();
        assert_eq!(got, "Invoice\n\nTotal: 12€ € paid");
    }

    /// A minimal Word 97 file: FIB with one piece of 8-bit text.
    fn tiny_doc(text: &str) -> Vec<u8> {
        let text_off = 0x800usize;
        let mut word = vec![0u8; text_off];
        word[0..2].copy_from_slice(&0xA5ECu16.to_le_bytes());
        word[0x0A..0x0C].copy_from_slice(&0x0200u16.to_le_bytes()); // 1Table
        let mut at = 32;
        word[at..at + 2].copy_from_slice(&14u16.to_le_bytes());
        at += 2 + 28;
        word[at..at + 2].copy_from_slice(&22u16.to_le_bytes());
        at += 2 + 88;
        word[at..at + 2].copy_from_slice(&93u16.to_le_bytes());
        at += 2;
        // Piece table: Pcdt with one piece.
        let mut plc = Vec::new();
        plc.extend(0u32.to_le_bytes());
        plc.extend((text.len() as u32).to_le_bytes());
        plc.extend(0u16.to_le_bytes());
        plc.extend(((text_off as u32 * 2) | 0x4000_0000).to_le_bytes());
        plc.extend(0u16.to_le_bytes());
        let mut clx = vec![0x02];
        clx.extend((plc.len() as u32).to_le_bytes());
        clx.extend(plc);
        word[at + 33 * 8..at + 33 * 8 + 4].copy_from_slice(&0u32.to_le_bytes());
        word[at + 33 * 8 + 4..at + 33 * 8 + 8].copy_from_slice(&(clx.len() as u32).to_le_bytes());
        word.extend(text.as_bytes());

        let mut buf = Cursor::new(Vec::new());
        {
            let mut cfb = cfb::CompoundFile::create(&mut buf).unwrap();
            cfb.create_stream("WordDocument")
                .unwrap()
                .write_all(&word)
                .unwrap();
            cfb.create_stream("1Table")
                .unwrap()
                .write_all(&clx)
                .unwrap();
            cfb.flush().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn doc_follows_its_piece_table() {
        let got = run(
            Format::Doc,
            tiny_doc("Tenancy notice\rKeys returned\x13 PAGE \x141\x15"),
        )
        .unwrap();
        assert_eq!(got, "Tenancy notice\n\nKeys returned1");
    }

    #[test]
    fn ppt_reads_text_atoms_and_skips_masters() {
        let mut stream = Vec::new();
        let atom = |kind: u16, body: &[u8]| {
            let mut r = Vec::new();
            r.extend(0u16.to_le_bytes());
            r.extend(kind.to_le_bytes());
            r.extend((body.len() as u32).to_le_bytes());
            r.extend(body);
            r
        };
        let master_text = atom(0x0FA8, b"Click to edit Master title style");
        let mut master = Vec::new();
        master.extend(0x000Fu16.to_le_bytes());
        master.extend(0x03F8u16.to_le_bytes());
        master.extend((master_text.len() as u32).to_le_bytes());
        master.extend(&master_text);
        stream.extend(master);
        stream.extend(atom(0x0FA8, b"Quarterly results"));
        let utf16: Vec<u8> = "Ventes 2024"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        stream.extend(atom(0x0FA0, &utf16));
        let mut buf = Cursor::new(Vec::new());
        {
            let mut cfb = cfb::CompoundFile::create(&mut buf).unwrap();
            cfb.create_stream("PowerPoint Document")
                .unwrap()
                .write_all(&stream)
                .unwrap();
            cfb.flush().unwrap();
        }
        let got = run(Format::Ppt, buf.into_inner()).unwrap();
        assert_eq!(got, "Quarterly results\n\nVentes 2024");
    }

    #[test]
    fn office_password_wrapper_is_protected() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut cfb = cfb::CompoundFile::create(&mut buf).unwrap();
            cfb.create_stream("EncryptionInfo")
                .unwrap()
                .write_all(b"x")
                .unwrap();
            cfb.create_stream("EncryptedPackage")
                .unwrap()
                .write_all(b"x")
                .unwrap();
            cfb.flush().unwrap();
        }
        let bytes = buf.into_inner();
        for format in [Format::Doc, Format::Docx, Format::Pptx, Format::Sheet] {
            assert!(
                matches!(run(format, bytes.clone()), Err(ExtractError::Protected)),
                "{format:?}"
            );
        }
    }
}
