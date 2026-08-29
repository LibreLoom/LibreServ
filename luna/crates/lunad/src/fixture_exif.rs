//! Kamadak-compatible EXIF writer for mock PSSD photo fixtures.

use std::io::Cursor;
use std::path::Path;

use exif::experimental::Writer;
use exif::{Field, In, Rational, Tag, Value};

fn decimal_to_dms_rationals(dec: f64) -> Vec<Rational> {
    let dec = dec.abs();
    let degrees = dec.floor() as u32;
    let minutes_float = (dec - f64::from(degrees)) * 60.0;
    let minutes = minutes_float.floor() as u32;
    let seconds = ((minutes_float - f64::from(minutes)) * 60.0 * 100.0).round() as u32;
    vec![
        (degrees, 1).into(),
        (minutes, 1).into(),
        (seconds.min(5999), 100).into(),
    ]
}

pub fn build_exif_app1(datetime: &str, gps: Option<(f64, f64)>) -> anyhow::Result<Vec<u8>> {
    let mut fields = vec![
        Field {
            tag: Tag::ImageDescription,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![b"Luna mock PSSD".to_vec()]),
        },
        Field {
            tag: Tag::DateTimeOriginal,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![datetime.as_bytes().to_vec()]),
        },
    ];

    if let Some((lat, lon)) = gps {
        let lat_ref = if lat >= 0.0 { "N" } else { "S" };
        let lon_ref = if lon >= 0.0 { "E" } else { "W" };
        fields.push(Field {
            tag: Tag::GPSLatitudeRef,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![lat_ref.as_bytes().to_vec()]),
        });
        fields.push(Field {
            tag: Tag::GPSLatitude,
            ifd_num: In::PRIMARY,
            value: Value::Rational(decimal_to_dms_rationals(lat)),
        });
        fields.push(Field {
            tag: Tag::GPSLongitudeRef,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![lon_ref.as_bytes().to_vec()]),
        });
        fields.push(Field {
            tag: Tag::GPSLongitude,
            ifd_num: In::PRIMARY,
            value: Value::Rational(decimal_to_dms_rationals(lon)),
        });
    }

    let mut writer = Writer::new();
    for field in &fields {
        writer.push_field(field);
    }
    let mut tiff = Cursor::new(Vec::new());
    writer.write(&mut tiff, true)?;
    let mut app1 = Vec::from(b"Exif\0\0");
    app1.extend_from_slice(tiff.get_ref());
    Ok(app1)
}

pub fn inject_exif_jpeg(
    path: &Path,
    datetime: &str,
    gps: Option<(f64, f64)>,
) -> anyhow::Result<()> {
    let mut data = std::fs::read(path)?;
    anyhow::ensure!(data.starts_with(&[0xFF, 0xD8]), "not a JPEG");
    let mut pos = 2usize;
    while pos + 4 <= data.len() {
        if data[pos] != 0xFF {
            break;
        }
        let marker = data[pos + 1];
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let len = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > data.len() {
            break;
        }
        let segment = &data[pos + 2..pos + 2 + len];
        if marker == 0xE1 && segment.starts_with(b"Exif\0\0") {
            data.drain(pos..pos + 2 + len);
            continue;
        }
        pos += 2 + len;
    }
    let app1 = build_exif_app1(datetime, gps)?;
    let mut segment = Vec::with_capacity(4 + app1.len());
    segment.extend_from_slice(&[0xFF, 0xE1]);
    segment.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    segment.extend_from_slice(&app1);
    data.splice(2..2, segment);
    std::fs::write(path, data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn injected_fixture_exif_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.jpg");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            let jpeg = [
                0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
                0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C,
                0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
                0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30,
                0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34,
                0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
                0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7F, 0xFF, 0xD9,
            ];
            f.write_all(&jpeg).unwrap();
        }
        inject_exif_jpeg(&path, "2023:07:14 09:15:22", Some((37.8651, -119.5383))).unwrap();
        let meta = crate::exif::capture_meta(&path).expect("read injected exif");
        assert!(meta.0.is_some());
        assert!(meta.1.is_some() && meta.2.is_some(), "{meta:?}");
    }
}
