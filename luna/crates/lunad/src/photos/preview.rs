//! Stage one of a photo's thumbnail: the smaller picture a camera or phone
//! already stores inside the file. Decoding it takes milliseconds where the
//! full photo takes seconds on a Wyse 3040 (D5), so a first scan fills the
//! timeline from these and a background pass swaps in full-quality
//! thumbnails afterwards (see `upgrade_pending_thumbs`).
//!
//! Sources, best first:
//! - JPEG: a Multi-Picture (MPF, APP2) "large thumbnail", which many
//!   cameras store at 1–2 MP; then the EXIF thumbnail (IFD1), which is
//!   usually 160×120 and so too small for the grid.
//! - HEIC: the `thmb` item (320×240 on iPhones), decoded by `heif-thumbnailer`.

use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageReader};

/// Shortest edge an embedded picture needs to stand in on the timeline. Its
/// square tiles are about 130–240 CSS px (3 columns on a phone, 6 on a
/// desktop), so 240 px covers a tile at 1x and is soft only until the
/// upgrade. 160×120 EXIF thumbnails fall straight through to the full decode.
pub(crate) const MIN_SHORT_EDGE: u32 = 240;

/// An embedded picture found in a photo.
pub(crate) struct Embedded {
    /// The picture, upright.
    pub image: DynamicImage,
    /// The photo's own size as it shows (after EXIF rotation or `irot`),
    /// the same the full decode reports.
    pub width: u32,
    pub height: u32,
}

fn big_enough(w: u32, h: u32) -> bool {
    w.min(h) >= MIN_SHORT_EDGE
}

fn decode_limited(bytes: &[u8]) -> Option<DynamicImage> {
    let limits = crate::budget::limits();
    let mut img_limits = image::Limits::default();
    img_limits.max_image_width = Some(limits.max_image_dim);
    img_limits.max_image_height = Some(limits.max_image_dim);
    img_limits.max_alloc = Some(limits.decode_max_bytes);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.limits(img_limits);
    reader.decode().ok()
}

/// The embedded preview of a JPEG, when it is big enough for the grid.
pub(crate) fn jpeg_preview(bytes: &[u8]) -> Option<Embedded> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let (width, height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok();
    let orientation = exif
        .as_ref()
        .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY))
        .and_then(|f| f.value.get_uint(0))
        .and_then(|v| u8::try_from(v).ok())
        .and_then(image::metadata::Orientation::from_exif)
        .unwrap_or(image::metadata::Orientation::NoTransforms);

    let candidate =
        mpf_large_thumbnail(bytes).or_else(|| exif.as_ref().and_then(|e| exif_thumbnail(e)))?;
    // The stored size can lie; check the frame before decoding it.
    let (pw, ph) = ImageReader::new(Cursor::new(candidate))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    if !big_enough(pw, ph) || pw > width || ph > height {
        return None;
    }
    let mut image = decode_limited(candidate)?;
    // Embedded pictures follow the main picture's EXIF orientation.
    image.apply_orientation(orientation);
    let (width, height) = crate::photos::displayed_size(width, height, orientation);
    Some(Embedded {
        image,
        width,
        height,
    })
}

/// The EXIF (IFD1) thumbnail's JPEG bytes.
fn exif_thumbnail(exif: &exif::Exif) -> Option<&[u8]> {
    let at = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let len = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let thumb = exif.buf().get(at..at.checked_add(len)?)?;
    thumb.starts_with(&[0xFF, 0xD8]).then_some(thumb)
}

/// The largest MPF "large thumbnail" (CIPA DC-007 types 0x010001 / 0x010002)
/// stored after the main picture. Other MPF pictures (an iPhone's HDR gain
/// map, stereo pairs, panorama frames) are never used.
fn mpf_large_thumbnail(bytes: &[u8]) -> Option<&[u8]> {
    // Walk the markers before the scan data for an APP2 "MPF\0".
    let mut pos = 2usize;
    let (header_at, tiff) = loop {
        let marker = bytes.get(pos..pos + 4)?;
        if marker[0] != 0xFF || marker[1] == 0xDA || marker[1] == 0xD9 {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([marker[2], marker[3]]));
        let body = bytes.get(pos + 4..pos + 2 + len)?;
        if marker[1] == 0xE2 && body.starts_with(b"MPF\0") {
            break (pos + 8, &body[4..]);
        }
        pos += 2 + len;
    };
    let le = match tiff.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let u16_at = |b: &[u8], at: usize| -> Option<u16> {
        let s: [u8; 2] = b.get(at..at + 2)?.try_into().ok()?;
        Some(if le {
            u16::from_le_bytes(s)
        } else {
            u16::from_be_bytes(s)
        })
    };
    let u32_at = |b: &[u8], at: usize| -> Option<u32> {
        let s: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
        Some(if le {
            u32::from_le_bytes(s)
        } else {
            u32::from_be_bytes(s)
        })
    };
    let ifd = u32_at(tiff, 4)? as usize;
    let count = usize::from(u16_at(tiff, ifd)?);
    let (mut entries_at, mut entries) = (0usize, 0usize);
    for k in 0..count {
        let e = ifd + 2 + k * 12;
        if u16_at(tiff, e)? == 0xB002 {
            entries = u32_at(tiff, e + 4)? as usize / 16;
            entries_at = u32_at(tiff, e + 8)? as usize;
        }
    }
    let mut best: Option<&[u8]> = None;
    for k in 0..entries.min(16) {
        let e = entries_at + k * 16;
        let kind = u32_at(tiff, e)? & 0x00FF_FFFF;
        if kind != 0x01_0001 && kind != 0x01_0002 {
            continue;
        }
        let size = u32_at(tiff, e + 4)? as usize;
        // Offsets count from the MPF header; the first picture's is 0.
        let offset = u32_at(tiff, e + 8)? as usize;
        if offset == 0 {
            continue;
        }
        let start = header_at.checked_add(offset)?;
        let Some(pic) = bytes.get(start..start.checked_add(size)?) else {
            continue;
        };
        if pic.starts_with(&[0xFF, 0xD8]) && best.is_none_or(|b| pic.len() > b.len()) {
            best = Some(pic);
        }
    }
    best
}

/// The stored thumbnail of a HEIC, when there is one big enough for the grid.
pub(crate) fn heif_preview(src: &Path, bytes: &[u8], work: &Path) -> Option<Embedded> {
    let layout = crate::photos::heif::layout(bytes)?;
    let (tw, th) = layout.thumb?;
    if !big_enough(tw, th) {
        return None;
    }
    // Named `.jpg` (it holds a PNG) so a scan sweeps one left by a crash.
    let png = work.with_extension("heic-thumb.jpg");
    let decoded = {
        let _permit = crate::budget::acquire_heif_slot_blocking();
        crate::photos::heif::decode_heif_thumbnail_png(src, tw.max(th), &png)
    };
    let image = decoded
        .ok()
        .and_then(|()| std::fs::read(&png).ok())
        .and_then(|b| decode_limited(&b));
    let _ = std::fs::remove_file(&png);
    Some(Embedded {
        image: image?,
        width: layout.width,
        height: layout.height,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn jpeg(w: u32, h: u32) -> Vec<u8> {
        // Left half dark, right half light: shows which way a picture turned.
        let img = image::RgbImage::from_fn(w, h, |x, _| {
            if x < w / 2 {
                image::Rgb([20, 20, 20])
            } else {
                image::Rgb([235, 235, 235])
            }
        });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&img)
            .unwrap();
        out
    }

    fn entry(t: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32) {
        t.extend_from_slice(&tag.to_le_bytes());
        t.extend_from_slice(&kind.to_le_bytes());
        t.extend_from_slice(&count.to_le_bytes());
        t.extend_from_slice(&value.to_le_bytes());
    }

    /// `main` with an EXIF APP1 (orientation, and an IFD1 thumbnail when
    /// given) and, when given, an MPF large-thumbnail `preview` after it.
    pub(crate) fn photo(
        main: &[u8],
        orientation: u16,
        exif_thumb: Option<&[u8]>,
        preview: Option<&[u8]>,
    ) -> Vec<u8> {
        // EXIF: IFD0 { Orientation } -> IFD1 { Compression, offset, length } + bytes.
        let mut t = b"II*\0".to_vec();
        t.extend_from_slice(&8u32.to_le_bytes());
        t.extend_from_slice(&1u16.to_le_bytes());
        entry(&mut t, 0x0112, 3, 1, u32::from(orientation));
        let ifd1_at = t.len() as u32 + 4;
        t.extend_from_slice(&(if exif_thumb.is_some() { ifd1_at } else { 0 }).to_le_bytes());
        if let Some(thumb) = exif_thumb {
            let data_at = ifd1_at + 2 + 3 * 12 + 4;
            t.extend_from_slice(&3u16.to_le_bytes());
            entry(&mut t, 0x0103, 3, 1, 6);
            entry(&mut t, 0x0201, 4, 1, data_at);
            entry(&mut t, 0x0202, 4, 1, thumb.len() as u32);
            t.extend_from_slice(&0u32.to_le_bytes());
            t.extend_from_slice(thumb);
        }
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((t.len() + 8) as u16).to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&t);

        let mut segs = app1;
        let app2_len = 2 + 4 + 8 + (2 + 12 + 4) + 2 * 16;
        let total = main.len() + segs.len() + if preview.is_some() { 2 + app2_len } else { 0 };
        if let Some(preview) = preview {
            // MPF: header right after "MPF\0"; offsets count from it.
            let header_at = 2 + segs.len() + 2 + 2 + 4;
            let mut m = b"II*\0".to_vec();
            m.extend_from_slice(&8u32.to_le_bytes());
            m.extend_from_slice(&1u16.to_le_bytes());
            entry(&mut m, 0xB002, 7, 32, 8 + 2 + 12 + 4);
            m.extend_from_slice(&0u32.to_le_bytes());
            for v in [0x2003_0000u32, total as u32, 0, 0] {
                m.extend_from_slice(&v.to_le_bytes());
            }
            for v in [
                0x0001_0002u32,
                preview.len() as u32,
                (total - header_at) as u32,
                0,
            ] {
                m.extend_from_slice(&v.to_le_bytes());
            }
            segs.extend_from_slice(&[0xFF, 0xE2]);
            segs.extend_from_slice(&(app2_len as u16).to_be_bytes());
            segs.extend_from_slice(b"MPF\0");
            segs.extend_from_slice(&m);
        }
        let mut out = main[..2].to_vec();
        out.extend_from_slice(&segs);
        out.extend_from_slice(&main[2..]);
        assert_eq!(out.len(), total);
        if let Some(preview) = preview {
            out.extend_from_slice(preview);
        }
        out
    }

    #[test]
    fn a_camera_preview_stands_in_with_the_photos_own_size() {
        let file = photo(
            &jpeg(1600, 1200),
            1,
            Some(&jpeg(160, 120)),
            Some(&jpeg(800, 600)),
        );
        let found = jpeg_preview(&file).expect("MPF preview is used");
        assert_eq!((found.width, found.height), (1600, 1200));
        assert_eq!((found.image.width(), found.image.height()), (800, 600));
        // The file still decodes as the main picture.
        let main = image::load_from_memory(&file).unwrap();
        assert_eq!((main.width(), main.height()), (1600, 1200));
    }

    #[test]
    fn a_sideways_phone_photo_turns_its_preview_and_its_size() {
        let file = photo(&jpeg(1600, 1200), 6, None, Some(&jpeg(800, 600)));
        let found = jpeg_preview(&file).expect("MPF preview is used");
        assert_eq!((found.width, found.height), (1200, 1600));
        let img = found.image.to_rgb8();
        assert_eq!(img.dimensions(), (600, 800));
        // Orientation 6 turns clockwise: the dark left half ends up on top.
        assert!(img.get_pixel(300, 50)[0] < 128, "top is dark");
        assert!(img.get_pixel(300, 750)[0] > 128, "bottom is light");
    }

    #[test]
    fn a_small_exif_thumbnail_falls_through_to_the_full_decode() {
        let file = photo(&jpeg(1600, 1200), 1, Some(&jpeg(160, 120)), None);
        assert!(jpeg_preview(&file).is_none());
        let no_exif_thumb = photo(&jpeg(1600, 1200), 1, None, None);
        assert!(jpeg_preview(&no_exif_thumb).is_none());
    }

    #[test]
    fn a_big_enough_exif_thumbnail_is_used() {
        let file = photo(&jpeg(1600, 1200), 1, Some(&jpeg(320, 240)), None);
        let found = jpeg_preview(&file).expect("EXIF thumbnail is used");
        assert_eq!((found.image.width(), found.image.height()), (320, 240));
        assert_eq!((found.width, found.height), (1600, 1200));
    }

    #[test]
    fn a_preview_bigger_than_the_photo_is_not_trusted() {
        let file = photo(&jpeg(400, 300), 1, None, Some(&jpeg(800, 600)));
        assert!(jpeg_preview(&file).is_none());
    }
}
