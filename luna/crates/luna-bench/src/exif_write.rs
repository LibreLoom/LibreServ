//! A minimal EXIF writer: camera make/model, DateTimeOriginal and GPS, as a
//! JPEG APP1 segment. The `image` crate writes no EXIF and lunad's photo
//! index reads exactly these tags, so fixtures need them to look real.

const ASCII: u16 = 2;
const SHORT: u16 = 3;
const LONG: u16 = 4;
const RATIONAL: u16 = 5;
const BYTE: u16 = 1;

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    data: Vec<u8>,
}

fn ascii(tag: u16, s: &str) -> Entry {
    let mut data = s.as_bytes().to_vec();
    data.push(0);
    Entry {
        tag,
        kind: ASCII,
        count: data.len() as u32,
        data,
    }
}

fn long(tag: u16, v: u32) -> Entry {
    Entry {
        tag,
        kind: LONG,
        count: 1,
        data: v.to_le_bytes().to_vec(),
    }
}

fn short(tag: u16, v: u16) -> Entry {
    Entry {
        tag,
        kind: SHORT,
        count: 1,
        data: v.to_le_bytes().to_vec(),
    }
}

/// Degrees as three rationals: degrees, minutes, seconds × 100.
fn dms(tag: u16, deg: f64) -> Entry {
    let deg = deg.abs();
    let d = deg.floor();
    let m = ((deg - d) * 60.0).floor();
    let s = ((deg - d) * 60.0 - m) * 60.0;
    let mut data = Vec::with_capacity(24);
    for (num, den) in [(d as u32, 1u32), (m as u32, 1), ((s * 100.0) as u32, 100)] {
        data.extend_from_slice(&num.to_le_bytes());
        data.extend_from_slice(&den.to_le_bytes());
    }
    Entry {
        tag,
        kind: RATIONAL,
        count: 3,
        data,
    }
}

/// Bytes one IFD takes: header, entries, next pointer, then any value
/// longer than 4 bytes (word-aligned).
fn ifd_len(entries: &[Entry]) -> usize {
    2 + entries.len() * 12
        + 4
        + entries
            .iter()
            .filter(|e| e.data.len() > 4)
            .map(|e| e.data.len().next_multiple_of(2))
            .sum::<usize>()
}

/// Append one IFD at `tiff.len()` (offsets count from the TIFF header).
fn write_ifd(tiff: &mut Vec<u8>, mut entries: Vec<Entry>) {
    entries.sort_by_key(|e| e.tag);
    let start = tiff.len();
    let mut extra_at = start + 2 + entries.len() * 12 + 4;
    let mut extra = Vec::new();
    tiff.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in &entries {
        tiff.extend_from_slice(&e.tag.to_le_bytes());
        tiff.extend_from_slice(&e.kind.to_le_bytes());
        tiff.extend_from_slice(&e.count.to_le_bytes());
        if e.data.len() <= 4 {
            let mut inline = e.data.clone();
            inline.resize(4, 0);
            tiff.extend_from_slice(&inline);
        } else {
            tiff.extend_from_slice(&(extra_at as u32).to_le_bytes());
            let padded = e.data.len().next_multiple_of(2);
            extra.extend_from_slice(&e.data);
            extra.resize(extra.len() + padded - e.data.len(), 0);
            extra_at += padded;
        }
    }
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&extra);
}

/// What one photo's EXIF says.
pub struct Meta<'a> {
    pub make: &'a str,
    pub model: &'a str,
    /// `YYYY:MM:DD HH:MM:SS`
    pub taken: &'a str,
    pub gps: Option<(f64, f64)>,
    pub width: u32,
    pub height: u32,
}

/// The APP1 segment (marker included) carrying `meta`.
pub fn app1(meta: &Meta) -> Vec<u8> {
    let exif_entries = || {
        vec![
            ascii(0x9003, meta.taken), // DateTimeOriginal
            ascii(0x9004, meta.taken), // DateTimeDigitized
            long(0xA002, meta.width),  // PixelXDimension
            long(0xA003, meta.height), // PixelYDimension
            short(0x8827, 100),        // ISO
        ]
    };
    let gps_entries = || {
        meta.gps.map(|(lat, lon)| {
            vec![
                Entry {
                    tag: 0x0000, // GPSVersionID
                    kind: BYTE,
                    count: 4,
                    data: vec![2, 2, 0, 0],
                },
                ascii(0x0001, if lat >= 0.0 { "N" } else { "S" }),
                dms(0x0002, lat),
                ascii(0x0003, if lon >= 0.0 { "E" } else { "W" }),
                dms(0x0004, lon),
            ]
        })
    };
    let ifd0_entries = |exif_at: u32, gps_at: Option<u32>| {
        let mut v = vec![
            ascii(0x010F, meta.make),
            ascii(0x0110, meta.model),
            ascii(0x0132, meta.taken), // DateTime
            short(0x0112, 1),          // Orientation
            long(0x8769, exif_at),     // ExifIFDPointer
        ];
        if let Some(at) = gps_at {
            v.push(long(0x8825, at)); // GPSInfoIFDPointer
        }
        v
    };
    // Lay out IFD0, the Exif IFD, then the GPS IFD; pointers need the sizes.
    let ifd0_size = ifd_len(&ifd0_entries(0, meta.gps.map(|_| 0)));
    let exif_at = 8 + ifd0_size;
    let gps_at = exif_at + ifd_len(&exif_entries());

    let mut tiff = Vec::with_capacity(512);
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes());
    write_ifd(
        &mut tiff,
        ifd0_entries(exif_at as u32, meta.gps.map(|_| gps_at as u32)),
    );
    debug_assert_eq!(tiff.len(), exif_at);
    write_ifd(&mut tiff, exif_entries());
    if let Some(gps) = gps_entries() {
        debug_assert_eq!(tiff.len(), gps_at);
        write_ifd(&mut tiff, gps);
    }

    let mut seg = Vec::with_capacity(tiff.len() + 10);
    seg.extend_from_slice(&[0xFF, 0xE1]);
    seg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(&tiff);
    seg
}

/// `jpeg` with `segment` inserted right after the SOI marker.
pub fn insert_after_soi(jpeg: &[u8], segment: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(jpeg.len() + segment.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(segment);
    out.extend_from_slice(&jpeg[2..]);
    out
}
