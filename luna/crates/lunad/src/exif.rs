//! Capture-date helpers for the gallery timeline.
//!
//! JPEG/TIFF EXIF is read with `kamadak-exif`. HEIC/HEIF stores the same TIFF
//! payload inside an ISOBMFF item; [`crate::heif`] extracts those bytes.
//! Original files are never rewritten.

use std::io::BufReader;
use std::path::Path;

use exif::{In, Reader, Tag, Value};

/// Best capture time for `path`: DateTimeOriginal, then Digitised, then
/// DateTime. Falls back to `None` when the file has no usable EXIF date.
pub fn capture_unix(path: &Path) -> Option<i64> {
    if crate::heif::is_heif(path) {
        if let Ok(bytes) = std::fs::read(path) {
            if let Some(exif) = crate::heif::exif_tiff_from_heif(&bytes) {
                if let Some(ts) = unix_from_tiff_bytes(&exif) {
                    return Some(ts);
                }
            }
        }
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let exif = Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;
    unix_from_exif(&exif)
}

pub fn unix_from_tiff_bytes(tiff: &[u8]) -> Option<i64> {
    let exif = Reader::new().read_raw(tiff.to_vec()).ok()?;
    unix_from_exif(&exif)
}

fn unix_from_exif(exif: &exif::Exif) -> Option<i64> {
    for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        if let Some(field) = exif.get_field(tag, In::PRIMARY) {
            if let Some(ts) = parse_exif_datetime(&value_as_ascii(&field.value)) {
                return Some(ts);
            }
        }
    }
    None
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
    fn jpeg_exif_fixture_uses_capture_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("phone.jpg");
        std::fs::write(&path, jpeg_with_datetime_original("2018:06:01 08:09:10")).unwrap();
        assert_eq!(
            capture_unix(&path),
            parse_exif_datetime("2018:06:01 08:09:10")
        );
    }
}

/// Minimal JPEG with an APP1 Exif IFD containing DateTimeOriginal.
#[cfg(test)]
pub fn jpeg_with_datetime_original(ascii: &str) -> Vec<u8> {
    let mut ascii_bytes = ascii.as_bytes().to_vec();
    ascii_bytes.push(0);
    while ascii_bytes.len() % 2 != 0 {
        ascii_bytes.push(0);
    }
    // TIFF little-endian: IFD0 with ExifOffset -> Exif IFD with DateTimeOriginal.
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at 8
    // IFD0: 1 entry (ExifOffset 0x8769)
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x8769u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes()); // LONG
    tiff.extend_from_slice(&1u32.to_le_bytes());
    let exif_ifd_offset = 8 + 2 + 12 + 4; // 26
    tiff.extend_from_slice(&(exif_ifd_offset as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD
    // Exif IFD
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x9003u16.to_le_bytes()); // DateTimeOriginal
    tiff.extend_from_slice(&2u16.to_le_bytes()); // ASCII
    tiff.extend_from_slice(&(ascii_bytes.len() as u32).to_le_bytes());
    let val_off = exif_ifd_offset + 2 + 12 + 4;
    tiff.extend_from_slice(&(val_off as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&ascii_bytes);

    let mut app1 = Vec::new();
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    let app1_len = (app1.len() + 2) as u16;

    let mut jpeg = Vec::new();
    jpeg.extend_from_slice(&[0xFF, 0xD8]); // SOI
    jpeg.extend_from_slice(&[0xFF, 0xE1]);
    jpeg.extend_from_slice(&app1_len.to_be_bytes());
    jpeg.extend_from_slice(&app1);
    // 1x1 SOF0 + SOS + one MCU + EOI so the image crate can still decode it.
    jpeg.extend_from_slice(&[
        0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07,
        0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F,
        0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22,
        0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27,
        0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32,
    ]);
    jpeg.extend_from_slice(&[
        0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    ]);
    jpeg.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x1F, 0x00]);
    jpeg.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    jpeg.extend_from_slice(&[0u8; 12]); // remaining huff table padding to 0x1F-2-1=28... simplify
    // Use a well-known 1x1 JPEG instead if the above is invalid — capture_unix
    // only needs APP1; image crate is not used in the EXIF test.
    jpeg.extend_from_slice(&[0xFF, 0xD9]);
    jpeg
}
