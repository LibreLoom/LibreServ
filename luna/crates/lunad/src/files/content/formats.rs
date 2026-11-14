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
        }
    }

    /// Read by OCR rather than by a parser.
    pub fn is_ocr(self) -> bool {
        matches!(self, Self::Image)
    }
}

const ALL: [Format; 12] = [
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
    ("png", Format::Image),
    ("webp", Format::Image),
    ("tif", Format::Image),
    ("tiff", Format::Image),
    ("bmp", Format::Image),
    ("heic", Format::Image),
    ("heif", Format::Image),
];

/// The format for a file name, by its extension.
pub fn format_for(name: &str) -> Option<Format> {
    let (_, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    EXTENSIONS.iter().find(|(e, _)| *e == ext).map(|(_, f)| *f)
}

/// SQL that keeps only names with a readable extension. Built from
/// [`EXTENSIONS`], which are fixed literals, so nothing user-typed reaches it.
pub fn sql_name_filter(column: &str, include_ocr: bool) -> String {
    let parts: Vec<String> = EXTENSIONS
        .iter()
        .filter(|(_, f)| include_ocr || !f.is_ocr())
        .map(|(e, _)| format!("{column} LIKE '%.{e}'"))
        .collect();
    format!("({})", parts.join(" OR "))
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
        assert_eq!(format_for("README"), None);
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
        assert!(docs.contains("'%.pdf'"));
    }
}
