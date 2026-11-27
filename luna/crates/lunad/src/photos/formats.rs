//! The one list of still-image formats Photos understands.
//!
//! Everything that used to keep its own extension list (what the scanner
//! accepts, how a thumbnail is decoded, whether the browser can show the
//! original, how OCR reads it, how the format filter groups it) asks here, so
//! the lists cannot drift apart. Neural photo search needs no entry: it reads
//! the thumbnail, so any format that gets a thumbnail is searchable.
//!
//! Left out on purpose: SVG (markup, not a picture; the upload gate exists to
//! keep markup a browser can render out of Photos), ICO (icons), and JPEG XL
//! (no decoder in the Luna image that stays within its memory budget).

use std::path::Path;

/// How a format is turned into pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decode {
    /// JPEG: scaled decode (the fast path on a small CPU).
    Jpeg,
    /// PNG, GIF, WebP, BMP, TIFF: the `image` crate, with memory limits.
    Image,
    /// HEIC, HEIF, AVIF: the sandboxed `heif-dec` child process.
    Heif,
    /// Camera RAW: the JPEG preview stored inside the file. Never developed
    /// (demosaicing a 24 MP raw takes minutes on a Wyse 3040).
    Raw,
}

/// One file extension and what Luna does with it.
#[derive(Debug, Clone, Copy)]
pub struct Format {
    pub ext: &'static str,
    /// The name the format filter shows (`jpeg` → `jpg`, `tif` → `tiff`).
    pub canonical: &'static str,
    pub decode: Decode,
    /// Every browser Luna targets shows the original as is.
    pub browser_native: bool,
    /// Tesseract reads the original; otherwise OCR decodes it first.
    pub ocr_direct: bool,
}

const fn f(
    ext: &'static str,
    canonical: &'static str,
    decode: Decode,
    browser_native: bool,
    ocr_direct: bool,
) -> Format {
    Format {
        ext,
        canonical,
        decode,
        browser_native,
        ocr_direct,
    }
}

use Decode::{Heif, Image, Jpeg, Raw};

pub const FORMATS: &[Format] = &[
    f("jpg", "jpg", Jpeg, true, true),
    f("jpeg", "jpg", Jpeg, true, true),
    f("jpe", "jpg", Jpeg, true, true),
    f("jfif", "jpg", Jpeg, true, true),
    f("png", "png", Image, true, true),
    f("apng", "png", Image, true, true),
    f("gif", "gif", Image, true, true),
    f("webp", "webp", Image, true, true),
    f("bmp", "bmp", Image, true, true),
    f("tif", "tiff", Image, false, true),
    f("tiff", "tiff", Image, false, true),
    f("heic", "heic", Heif, false, false),
    f("heif", "heif", Heif, false, false),
    f("hif", "hif", Heif, false, false),
    // AVIF shares HEIF's container and decoder, but every browser plays it.
    f("avif", "avif", Heif, true, false),
    f("dng", "dng", Raw, false, false),
    f("cr2", "cr2", Raw, false, false),
    f("cr3", "cr3", Raw, false, false),
    f("nef", "nef", Raw, false, false),
    f("nrw", "nrw", Raw, false, false),
    f("arw", "arw", Raw, false, false),
    f("srf", "srf", Raw, false, false),
    f("sr2", "sr2", Raw, false, false),
    f("orf", "orf", Raw, false, false),
    f("rw2", "rw2", Raw, false, false),
    f("raf", "raf", Raw, false, false),
    f("pef", "pef", Raw, false, false),
    f("srw", "srw", Raw, false, false),
];

/// The format for a lower- or upper-case extension (no dot).
pub fn lookup(ext: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|x| x.ext.eq_ignore_ascii_case(ext))
}

/// The format for a file's name, by its extension.
pub fn for_path(path: &Path) -> Option<&'static Format> {
    let leaf = crate::files::leaf_name(path)?;
    let ext = Path::new(leaf.as_ref()).extension()?.to_str()?;
    lookup(ext)
}

/// Format-filter name for an extension: `jpeg` and `jfif` count as `jpg`,
/// `tif` as `tiff`. Unknown extensions keep their own (lower-cased) name.
pub fn canonical_ext(ext: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    let ext = ext.trim().trim_start_matches('.');
    if let Some(format) = lookup(ext) {
        Cow::Borrowed(format.canonical)
    } else if ext.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Owned(ext.to_ascii_lowercase())
    } else {
        Cow::Borrowed(ext)
    }
}

/// Extensions of one decode route, for callers that need a list (SQL).
pub fn extensions_for(decode: Decode) -> impl Iterator<Item = &'static str> {
    FORMATS
        .iter()
        .filter(move |x| x.decode == decode)
        .map(|x| x.ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_extension_is_listed_once_in_lower_case() {
        let mut seen = std::collections::HashSet::new();
        for f in FORMATS {
            assert_eq!(f.ext, f.ext.to_ascii_lowercase());
            assert!(seen.insert(f.ext), "{} is listed twice", f.ext);
        }
    }

    #[test]
    fn aliases_fold_into_one_filter_name() {
        assert_eq!(canonical_ext("JPEG"), "jpg");
        assert_eq!(canonical_ext("jfif"), "jpg");
        assert_eq!(canonical_ext(".TIF"), "tiff");
        assert_eq!(canonical_ext("CR3"), "cr3");
        assert_eq!(canonical_ext("mp4"), "mp4");
    }

    #[test]
    fn avif_decodes_like_heif_but_needs_no_browser_preview() {
        let avif = lookup("AVIF").unwrap();
        assert_eq!(avif.decode, Heif);
        assert!(avif.browser_native);
        assert!(!lookup("heic").unwrap().browser_native);
    }

    #[test]
    fn raw_and_tiff_need_a_preview_and_svg_is_not_a_photo() {
        assert!(!lookup("nef").unwrap().browser_native);
        assert!(!lookup("tiff").unwrap().browser_native);
        assert!(lookup("svg").is_none());
        assert!(lookup("ico").is_none());
    }
}
