//! Capture-date and GPS helpers for the gallery timeline / Places map.
//!
//! JPEG/TIFF EXIF is read with `kamadak-exif`. HEIC/HEIF stores the same TIFF
//! payload inside an ISOBMFF item; [`crate::heif`] extracts those bytes.
//! Original files are never rewritten.

use std::io::BufReader;
use std::path::Path;

use exif::{In, Reader, Tag, Value};

/// Capture time, GPS, camera, and shooting metadata when present in EXIF.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureMeta {
    pub taken_at: Option<i64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    /// LensModel when present.
    pub lens: Option<String>,
    /// ISO from PhotographicSensitivity (legacy ISOSpeedRatings) or ISOSpeed.
    /// `None` / stored as 0 means unknown.
    pub iso: Option<u32>,
    /// Focal length in millimetres. `None` / stored as 0.0 means unknown.
    pub focal_mm: Option<f64>,
    /// Flash fired: `Some(true)` on, `Some(false)` off, `None` unknown.
    pub flash: Option<bool>,
}

/// Best capture time for `path`: DateTimeOriginal, then Digitised, then
/// DateTime. Falls back to `None` when the file has no usable EXIF date.
pub fn capture_unix(path: &Path) -> Option<i64> {
    capture_meta(path).and_then(|m| m.taken_at)
}

/// Capture time plus GPS / camera when present. Returns `None` only when the
/// file cannot be opened / parsed at all; individual fields may still be `None`.
pub fn capture_meta(path: &Path) -> Option<CaptureMeta> {
    if crate::heif::is_heif(path) {
        let max = crate::budget::limits().source_max_bytes;
        let meta = std::fs::metadata(path).ok()?;
        if meta.len() > max {
            return None;
        }
        if let Ok(bytes) = std::fs::read(path)
            && let Some(tiff) = crate::heif::exif_tiff_from_heif(&bytes)
            && let Ok(exif) = Reader::new().read_raw(tiff)
        {
            return Some(meta_from_exif(&exif));
        }
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let exif = Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;
    Some(meta_from_exif(&exif))
}

fn meta_from_exif(exif: &exif::Exif) -> CaptureMeta {
    let (lat, lon) = gps_from_exif(exif);
    CaptureMeta {
        taken_at: unix_from_exif(exif),
        lat,
        lon,
        camera_make: camera_string(exif, Tag::Make),
        camera_model: camera_string(exif, Tag::Model),
        lens: camera_string(exif, Tag::LensModel),
        iso: iso_from_exif(exif),
        focal_mm: focal_mm_from_exif(exif),
        flash: flash_from_exif(exif),
    }
}

pub fn unix_from_tiff_bytes(tiff: &[u8]) -> Option<i64> {
    let exif = Reader::new().read_raw(tiff.to_vec()).ok()?;
    unix_from_exif(&exif)
}

fn unix_from_exif(exif: &exif::Exif) -> Option<i64> {
    for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        if let Some(field) = exif.get_field(tag, In::PRIMARY)
            && let Some(ts) = parse_exif_datetime(&value_as_ascii(&field.value))
        {
            return Some(ts);
        }
    }
    None
}

fn camera_string(exif: &exif::Exif, tag: Tag) -> Option<String> {
    let field = exif
        .get_field(tag, In::PRIMARY)
        .or_else(|| exif.fields().find(|f| f.tag == tag))?;
    let raw = value_as_ascii(&field.value);
    let cleaned = raw.trim().trim_matches('\0').trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn iso_from_exif(exif: &exif::Exif) -> Option<u32> {
    // PhotographicSensitivity is tag 0x8827 — same as legacy ISOSpeedRatings.
    for tag in [
        Tag::PhotographicSensitivity,
        Tag::ISOSpeed,
        Tag::StandardOutputSensitivity,
    ] {
        if let Some(field) = exif
            .get_field(tag, In::PRIMARY)
            .or_else(|| exif.fields().find(|f| f.tag == tag))
            && let Some(v) = field.value.get_uint(0)
            && v > 0
        {
            return Some(v);
        }
    }
    None
}

fn focal_mm_from_exif(exif: &exif::Exif) -> Option<f64> {
    let field = exif
        .get_field(Tag::FocalLength, In::PRIMARY)
        .or_else(|| exif.fields().find(|f| f.tag == Tag::FocalLength))?;
    match &field.value {
        Value::Rational(vals) if !vals.is_empty() && vals[0].denom != 0 => {
            let mm = vals[0].num as f64 / vals[0].denom as f64;
            if mm > 0.0 { Some(mm) } else { None }
        }
        _ => field.value.get_uint(0).filter(|v| *v > 0).map(|v| v as f64),
    }
}

/// Flash tag bit0 = fired. Missing tag → unknown.
fn flash_from_exif(exif: &exif::Exif) -> Option<bool> {
    let field = exif
        .get_field(Tag::Flash, In::PRIMARY)
        .or_else(|| exif.fields().find(|f| f.tag == Tag::Flash))?;
    let v = field.value.get_uint(0)?;
    Some((v & 1) != 0)
}

fn gps_from_exif(exif: &exif::Exif) -> (Option<f64>, Option<f64>) {
    let lat = gps_coord(exif, Tag::GPSLatitude, Tag::GPSLatitudeRef);
    let lon = gps_coord(exif, Tag::GPSLongitude, Tag::GPSLongitudeRef);
    (lat, lon)
}

fn gps_coord(exif: &exif::Exif, coord: Tag, reference: Tag) -> Option<f64> {
    let field = exif.fields().find(|f| f.tag == coord)?;
    let deg = dms_to_decimal(&field.value)?;
    let refer = exif
        .fields()
        .find(|f| f.tag == reference)
        .map(|f| value_as_ascii(&f.value))
        .unwrap_or_default();
    let refer = refer.trim().chars().next().unwrap_or('N');
    if refer == 'S' || refer == 'W' {
        Some(-deg)
    } else {
        Some(deg)
    }
}

fn dms_to_decimal(value: &Value) -> Option<f64> {
    match value {
        Value::Rational(vals) if vals.len() >= 3 => {
            let d = vals[0].num as f64 / vals[0].denom.max(1) as f64;
            let m = vals[1].num as f64 / vals[1].denom.max(1) as f64;
            let s = vals[2].num as f64 / vals[2].denom.max(1) as f64;
            Some(d + m / 60.0 + s / 3600.0)
        }
        _ => None,
    }
}

fn value_as_ascii(value: &Value) -> String {
    match value {
        Value::Ascii(chunks) => chunks
            .iter()
            .flat_map(|c| std::str::from_utf8(c).ok())
            .collect::<Vec<_>>()
            .join(""),
        other => other.display_as(Tag::DateTimeOriginal).to_string(),
    }
}

/// Parse `YYYY:MM:DD HH:MM:SS` (EXIF) as UTC seconds since epoch.
pub fn parse_exif_datetime(raw: &str) -> Option<i64> {
    let s = raw.trim().trim_end_matches('\0');
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b':' || b[7] != b':' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let min: u32 = s.get(14..16)?.parse().ok()?;
    let sec: u32 = s.get(17..19)?.parse().ok()?;
    civil_to_unix(year, month, day, hour, min, sec)
}

fn civil_to_unix(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil, UTC.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u32;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era as i64) * 146097 + doe as i64 - 719468;
    Some(days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64)
}

/// Minimal JPEG with an APP1 Exif IFD containing DateTimeOriginal (+ optional Make/Model).
#[cfg(test)]
pub fn jpeg_with_datetime_original(ascii: &str) -> Vec<u8> {
    jpeg_with_exif(ascii, None, None)
}

/// Minimal JPEG with DateTimeOriginal and optional camera Make/Model in IFD0.
#[cfg(test)]
pub fn jpeg_with_exif(ascii: &str, make: Option<&str>, model: Option<&str>) -> Vec<u8> {
    jpeg_with_rich_exif(RichExifOpts {
        datetime: ascii,
        make,
        model,
        lens: None,
        iso: None,
        focal_num: None,
        focal_den: None,
        flash: None,
    })
}

/// Options for a synthetic JPEG EXIF fixture used in unit tests.
#[cfg(test)]
pub struct RichExifOpts<'a> {
    pub datetime: &'a str,
    pub make: Option<&'a str>,
    pub model: Option<&'a str>,
    pub lens: Option<&'a str>,
    pub iso: Option<u16>,
    pub focal_num: Option<u32>,
    pub focal_den: Option<u32>,
    pub flash: Option<u16>,
}

/// Minimal JPEG with richer Exif IFD tags for gallery filter tests.
#[cfg(test)]
pub fn jpeg_with_rich_exif(opts: RichExifOpts<'_>) -> Vec<u8> {
    let mut ascii_bytes = opts.datetime.as_bytes().to_vec();
    ascii_bytes.push(0);
    while !ascii_bytes.len().is_multiple_of(2) {
        ascii_bytes.push(0);
    }
    let make_bytes = opts.make.map(pad_ascii);
    let model_bytes = opts.model.map(pad_ascii);
    let lens_bytes = opts.lens.map(pad_ascii);

    let ifd0_entries = 1u16 + u16::from(make_bytes.is_some()) + u16::from(model_bytes.is_some());
    let ifd0_size = 2 + (ifd0_entries as usize) * 12 + 4;

    let mut exif_count = 1u16; // DateTimeOriginal
    if lens_bytes.is_some() {
        exif_count += 1;
    }
    if opts.iso.is_some() {
        exif_count += 1;
    }
    if opts.focal_num.is_some() {
        exif_count += 1;
    }
    if opts.flash.is_some() {
        exif_count += 1;
    }

    let exif_ifd_offset = 8 + ifd0_size;
    // Exif IFD header + entries + next-IFD + inline values that need space after.
    let exif_entries_bytes = 2 + (exif_count as usize) * 12 + 4;
    let mut after_exif = Vec::new(); // values that don't fit in 4 bytes

    // Precompute offsets for long ASCII / rational values.
    let mut cursor = exif_ifd_offset + exif_entries_bytes;
    let datetime_off = cursor;
    cursor += ascii_bytes.len();
    let lens_off = if lens_bytes.is_some() {
        let o = cursor;
        cursor += lens_bytes.as_ref().map(|b| b.len()).unwrap_or(0);
        Some(o)
    } else {
        None
    };
    let focal_off = if opts.focal_num.is_some() {
        let o = cursor;
        cursor += 8; // one rational
        Some(o)
    } else {
        None
    };
    let _ = cursor;

    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at 8
    tiff.extend_from_slice(&ifd0_entries.to_le_bytes());

    // IFD0 string values live after Exif IFD payload.
    let mut ifd0_string_cursor = exif_ifd_offset
        + exif_entries_bytes
        + ascii_bytes.len()
        + lens_bytes.as_ref().map(|b| b.len()).unwrap_or(0)
        + if opts.focal_num.is_some() { 8 } else { 0 };

    if let Some(ref mb) = make_bytes {
        tiff.extend_from_slice(&0x010Fu16.to_le_bytes()); // Make
        tiff.extend_from_slice(&2u16.to_le_bytes()); // ASCII
        tiff.extend_from_slice(&(mb.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(ifd0_string_cursor as u32).to_le_bytes());
        ifd0_string_cursor += mb.len();
    }
    if let Some(ref mb) = model_bytes {
        tiff.extend_from_slice(&0x0110u16.to_le_bytes()); // Model
        tiff.extend_from_slice(&2u16.to_le_bytes()); // ASCII
        tiff.extend_from_slice(&(mb.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(ifd0_string_cursor as u32).to_le_bytes());
        ifd0_string_cursor += mb.len();
    }
    let _ = ifd0_string_cursor;

    tiff.extend_from_slice(&0x8769u16.to_le_bytes()); // ExifOffset
    tiff.extend_from_slice(&4u16.to_le_bytes()); // LONG
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&(exif_ifd_offset as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD

    // Exif IFD
    tiff.extend_from_slice(&exif_count.to_le_bytes());

    // DateTimeOriginal
    tiff.extend_from_slice(&0x9003u16.to_le_bytes());
    tiff.extend_from_slice(&2u16.to_le_bytes());
    tiff.extend_from_slice(&(ascii_bytes.len() as u32).to_le_bytes());
    tiff.extend_from_slice(&(datetime_off as u32).to_le_bytes());

    if let Some(iso) = opts.iso {
        tiff.extend_from_slice(&0x8827u16.to_le_bytes()); // PhotographicSensitivity
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&iso.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes()); // pad to 4 bytes
    }
    if let Some(flash) = opts.flash {
        tiff.extend_from_slice(&0x9209u16.to_le_bytes()); // Flash
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&flash.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes());
    }
    if let (Some(num), Some(den), Some(off)) = (opts.focal_num, opts.focal_den, focal_off) {
        tiff.extend_from_slice(&0x920Au16.to_le_bytes()); // FocalLength
        tiff.extend_from_slice(&5u16.to_le_bytes()); // RATIONAL
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&(off as u32).to_le_bytes());
        after_exif.extend_from_slice(&num.to_le_bytes());
        after_exif.extend_from_slice(&den.to_le_bytes());
    }
    if let (Some(lb), Some(off)) = (&lens_bytes, lens_off) {
        tiff.extend_from_slice(&0xA434u16.to_le_bytes()); // LensModel
        tiff.extend_from_slice(&2u16.to_le_bytes()); // ASCII
        tiff.extend_from_slice(&(lb.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(off as u32).to_le_bytes());
    }

    tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD
    tiff.extend_from_slice(&ascii_bytes);
    if let Some(lb) = &lens_bytes {
        tiff.extend_from_slice(lb);
    }
    // Focal rational was collected into after_exif — but order must match cursor.
    // Cursor order: datetime, lens, focal. We already wrote datetime+lens into tiff;
    // write focal rational next when present.
    if opts.focal_num.is_some() {
        // after_exif holds focal bytes when we built the entry above.
        tiff.extend_from_slice(&after_exif);
    }

    if let Some(mb) = make_bytes {
        tiff.extend_from_slice(&mb);
    }
    if let Some(mb) = model_bytes {
        tiff.extend_from_slice(&mb);
    }

    let mut app1 = Vec::new();
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    let app1_len = (app1.len() + 2) as u16;

    let mut jpeg = Vec::new();
    jpeg.extend_from_slice(&[0xFF, 0xD8]); // SOI
    jpeg.extend_from_slice(&[0xFF, 0xE1]);
    jpeg.extend_from_slice(&app1_len.to_be_bytes());
    jpeg.extend_from_slice(&app1);
    jpeg.extend_from_slice(&[0xFF, 0xD9]);
    jpeg
}

#[cfg(test)]
fn pad_ascii(s: &str) -> Vec<u8> {
    let mut b = s.as_bytes().to_vec();
    b.push(0);
    while !b.len().is_multiple_of(2) {
        b.push(0);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exif_ascii_as_utc() {
        assert_eq!(
            parse_exif_datetime("2020:01:15 12:30:00"),
            Some(1_579_091_400)
        );
        assert_eq!(parse_exif_datetime("not a date"), None);
        assert_eq!(parse_exif_datetime(""), None);
    }

    #[test]
    fn fixture_jpeg_gps_from_mock_pssd() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mock-pssd");
        let sample = root.join("Photos/Vacation - Yosemite/2022-yosemite-01.jpg");
        if !sample.is_file() {
            eprintln!("mock PSSD fixtures missing — run: make mock-pssd-photos");
            return;
        }
        let meta = capture_meta(&sample).expect("read fixture exif");
        assert!(meta.taken_at.is_some(), "DateTimeOriginal missing");
        assert!(
            meta.lat.is_some() && meta.lon.is_some(),
            "GPS missing: {meta:?}"
        );
    }

    #[test]
    fn jpeg_exif_fixture_uses_capture_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("phone.jpg");
        std::fs::write(&path, jpeg_with_datetime_original("2018:06:01 08:09:10")).unwrap();
        assert_eq!(
            capture_unix(&path),
            parse_exif_datetime("2018:06:01 08:09:10")
        );
    }

    #[test]
    fn jpeg_exif_reads_camera_make_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cam.jpg");
        std::fs::write(
            &path,
            jpeg_with_exif("2019:03:04 05:06:07", Some("Canon"), Some("EOS R5")),
        )
        .unwrap();
        let meta = capture_meta(&path).expect("read camera exif");
        assert_eq!(meta.camera_make.as_deref(), Some("Canon"));
        assert_eq!(meta.camera_model.as_deref(), Some("EOS R5"));
        assert_eq!(meta.taken_at, parse_exif_datetime("2019:03:04 05:06:07"));
    }

    #[test]
    fn jpeg_exif_reads_lens_iso_focal_flash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rich.jpg");
        std::fs::write(
            &path,
            jpeg_with_rich_exif(RichExifOpts {
                datetime: "2021:07:08 09:10:11",
                make: Some("Canon"),
                model: Some("EOS R5"),
                lens: Some("RF24-105mm F4 L IS USM"),
                iso: Some(400),
                focal_num: Some(50),
                focal_den: Some(1),
                flash: Some(1), // fired
            }),
        )
        .unwrap();
        let meta = capture_meta(&path).expect("read rich exif");
        assert_eq!(meta.camera_make.as_deref(), Some("Canon"));
        assert_eq!(meta.lens.as_deref(), Some("RF24-105mm F4 L IS USM"));
        assert_eq!(meta.iso, Some(400));
        assert_eq!(meta.focal_mm, Some(50.0));
        assert_eq!(meta.flash, Some(true));
    }
}
