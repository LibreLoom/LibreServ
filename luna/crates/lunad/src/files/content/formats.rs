//! Which files Luna reads the words out of, and how big each kind may be.

/// How a file's text is pulled out. Chosen by extension only: the worker
/// still checks the bytes, and a file that lies about its type just fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// Plain text in any common encoding (notes, CSV, subtitles, mail).
    Text,
    /// HTML and XHTML pages.
    Html,
    Rtf,
    /// Word 2007+ (`.docx`), plus macro and template variants.
    Docx,
    /// PowerPoint 2007+ (`.pptx`).
    Pptx,
    /// OpenDocument text and slides (`.odt`, `.odp`): one `content.xml`.
    Odf,
    /// Any spreadsheet `calamine` reads: `.xlsx`, `.xls`, `.ods`, `.xlsb`.
    Sheet,
    Epub,
    /// Word 97–2003 (`.doc`).
    Doc,
    /// PowerPoint 97–2003 (`.ppt`).
    Ppt,
    /// Read by `pdftotext`; pages without a text layer go to OCR.
    Pdf,
    /// Photos and scans: read by OCR only.
    Image,
    /// Any other file: plain text if it is text, otherwise the readable
    /// strings inside it (like `strings`). Chosen for every extension that
    /// is neither listed below nor known to be media or program data.
    Strings,
}

impl Format {
    /// The name the worker is invoked with.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Html => "html",
            Self::Rtf => "rtf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Odf => "odf",
            Self::Sheet => "sheet",
            Self::Epub => "epub",
            Self::Doc => "doc",
            Self::Ppt => "ppt",
            Self::Pdf => "pdf",
            Self::Image => "image",
            Self::Strings => "strings",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        ALL.iter().copied().find(|f| f.as_str() == s)
    }

    /// Largest file of this kind Luna reads. Bigger ones are recorded as
    /// skipped: a 2 GiB box can't hold their parse, and nobody searches
    /// inside a 300 MB log for a word.
    pub fn max_input_bytes(self) -> u64 {
        const MIB: u64 = 1024 * 1024;
        match self {
            Self::Text | Self::Html | Self::Rtf => 32 * MIB,
            Self::Docx | Self::Pptx | Self::Odf | Self::Epub => 100 * MIB,
            Self::Sheet => 40 * MIB,
            Self::Doc | Self::Ppt => 64 * MIB,
            Self::Pdf => 300 * MIB,
            Self::Image => 64 * MIB,
            // Only the first few MiB are read, so the size hardly matters.
            Self::Strings => 1024 * MIB,
        }
    }

    /// Read by OCR rather than by a parser.
    pub fn is_ocr(self) -> bool {
        matches!(self, Self::Image)
    }
}

const ALL: [Format; 13] = [
    Format::Text,
    Format::Html,
    Format::Rtf,
    Format::Docx,
    Format::Pptx,
    Format::Odf,
    Format::Sheet,
    Format::Epub,
    Format::Doc,
    Format::Ppt,
    Format::Pdf,
    Format::Image,
    Format::Strings,
];

/// (extension, format). Lowercase, no dot.
pub const EXTENSIONS: &[(&str, Format)] = &[
    ("txt", Format::Text),
    ("text", Format::Text),
    ("md", Format::Text),
    ("markdown", Format::Text),
    ("csv", Format::Text),
    ("tsv", Format::Text),
    ("log", Format::Text),
    ("json", Format::Text),
    ("xml", Format::Text),
    ("yaml", Format::Text),
    ("yml", Format::Text),
    ("toml", Format::Text),
    ("ini", Format::Text),
    ("srt", Format::Text),
    ("vtt", Format::Text),
    ("ics", Format::Text),
    ("vcf", Format::Text),
    ("eml", Format::Text),
    ("tex", Format::Text),
    ("html", Format::Html),
    ("htm", Format::Html),
    ("xhtml", Format::Html),
    ("rtf", Format::Rtf),
    ("docx", Format::Docx),
    ("docm", Format::Docx),
    ("dotx", Format::Docx),
    ("pptx", Format::Pptx),
    ("pptm", Format::Pptx),
    ("odt", Format::Odf),
    ("odp", Format::Odf),
    ("xlsx", Format::Sheet),
    ("xlsm", Format::Sheet),
    ("xlsb", Format::Sheet),
    ("xls", Format::Sheet),
    ("ods", Format::Sheet),
    ("epub", Format::Epub),
    ("doc", Format::Doc),
    ("ppt", Format::Ppt),
    ("pdf", Format::Pdf),
    ("jpg", Format::Image),
    ("jpeg", Format::Image),
    ("jpe", Format::Image),
    ("jfif", Format::Image),
    ("png", Format::Image),
    ("apng", Format::Image),
    ("gif", Format::Image),
    ("webp", Format::Image),
    ("tif", Format::Image),
    ("tiff", Format::Image),
    ("bmp", Format::Image),
    ("heic", Format::Image),
    ("heif", Format::Image),
    ("hif", Format::Image),
    ("avif", Format::Image),
    ("dng", Format::Image),
    ("cr2", Format::Image),
    ("cr3", Format::Image),
    ("nef", Format::Image),
    ("nrw", Format::Image),
    ("arw", Format::Image),
    ("srf", Format::Image),
    ("sr2", Format::Image),
    ("orf", Format::Image),
    ("rw2", Format::Image),
    ("raf", Format::Image),
    ("pef", Format::Image),
    ("srw", Format::Image),
];

/// Extensions that are never read: media, archives, program and database
/// files, fonts, and download leftovers. Nothing a person would search for
/// words in, and some are huge. Lowercase, no dot.
pub const NOT_READ: &[&str] = &[
    "zip",
    "gz",
    "tgz",
    "bz2",
    "xz",
    "zst",
    "7z",
    "rar",
    "tar",
    "iso",
    "img",
    "dmg",
    "cab",
    "lz4",
    "mp3",
    "flac",
    "wav",
    "ogg",
    "oga",
    "opus",
    "m4a",
    "aac",
    "mka",
    "aiff",
    "wma",
    "mid",
    "midi",
    "mp4",
    "mkv",
    "avi",
    "mov",
    "webm",
    "m4v",
    "wmv",
    "mpg",
    "mpeg",
    "flv",
    "ts",
    "m2ts",
    "3gp",
    "gif",
    "ico",
    "icns",
    "avif",
    "jxl",
    "psd",
    "xcf",
    "kra",
    "raw",
    "cr2",
    "cr3",
    "nef",
    "arw",
    "dng",
    "orf",
    "rw2",
    "exe",
    "dll",
    "so",
    "o",
    "a",
    "bin",
    "dat",
    "db",
    "sqlite",
    "sqlite3",
    "wasm",
    "class",
    "jar",
    "apk",
    "deb",
    "rpm",
    "appimage",
    "pyc",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "blend",
    "part",
    "tmp",
    "crdownload",
    "swp",
    "lock",
    "vmdk",
    "qcow2",
    "vdi",
    "luks",
    "gpg",
    "age",
    "enc",
];

/// The format for a file name: by its extension, or [`Format::Strings`] for
/// an extension that is not listed and not in [`NOT_READ`].
pub fn format_for(name: &str) -> Option<Format> {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return Some(Format::Strings);
    };
    let ext = ext.to_ascii_lowercase();
    if let Some((_, f)) = EXTENSIONS.iter().find(|(e, _)| *e == ext) {
        return Some(*f);
    }
    if NOT_READ.contains(&ext.as_str()) {
        return None;
    }
    Some(Format::Strings)
}

fn like_any(column: &str, exts: impl Iterator<Item = &'static str>) -> String {
    let parts: Vec<String> = exts.map(|e| format!("{column} LIKE '%.{e}'")).collect();
    parts.join(" OR ")
}

/// SQL that keeps only names Luna reads: everything except [`NOT_READ`] and,
/// unless `include_ocr`, the image types. Built from fixed literals, so
/// nothing user-typed reaches it.
pub fn sql_name_filter(column: &str, include_ocr: bool) -> String {
    let mut skip: Vec<&'static str> = NOT_READ.to_vec();
    if !include_ocr {
        skip.extend(
            EXTENSIONS
                .iter()
                .filter(|(_, f)| f.is_ocr())
                .map(|(e, _)| *e),
        );
    }
    format!("NOT ({})", like_any(column, skip.into_iter()))
}

/// SQL sort key: listed document types first (0), other files (1), then
/// images (2), so slow OCR and guesswork never hold up real documents.
pub fn sql_priority(column: &str) -> String {
    let images = like_any(
        column,
        EXTENSIONS
            .iter()
            .filter(|(_, f)| f.is_ocr())
            .map(|(e, _)| *e),
    );
    let known = like_any(column, EXTENSIONS.iter().map(|(e, _)| *e));
    format!("CASE WHEN {images} THEN 2 WHEN {known} THEN 0 ELSE 1 END")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_format_by_extension_ignoring_case() {
        assert_eq!(format_for("Report.DOCX"), Some(Format::Docx));
        assert_eq!(format_for("notes.md"), Some(Format::Text));
        assert_eq!(format_for("budget.xls"), Some(Format::Sheet));
        assert_eq!(format_for("scan.HEIC"), Some(Format::Image));
        assert_eq!(format_for("archive.zip"), None);
        assert_eq!(format_for("README"), Some(Format::Strings));
        assert_eq!(format_for("main.rs"), Some(Format::Strings));
        assert_eq!(format_for("movie.MKV"), None);
    }

    #[test]
    fn every_photo_format_can_be_read_for_text() {
        // The text index and Photos must never disagree about what an image is.
        for f in crate::photos::formats::FORMATS {
            assert_eq!(
                format_for(&format!("scan.{}", f.ext)),
                Some(Format::Image),
                "{} is a photo format but has no text-reading entry",
                f.ext
            );
        }
    }

    #[test]
    fn names_round_trip() {
        for f in ALL {
            assert_eq!(Format::parse(f.as_str()), Some(f));
        }
    }

    #[test]
    fn the_sql_filter_can_leave_out_images() {
        let all = sql_name_filter("name", true);
        let docs = sql_name_filter("name", false);
        assert!(all.contains("'%.jpg'"));
        assert!(!docs.contains("'%.jpg'"));
        assert!(!docs.contains("'%.pdf'"));
        assert!(docs.contains("'%.zip'"));
    }
}
