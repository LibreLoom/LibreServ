//! Camera RAW files: the JPEG picture every camera stores inside them.
//!
//! Luna never develops a raw (demosaicing a 24 MP file takes minutes on a
//! Wyse 3040 and needs far more memory than the budget allows). It reads the
//! embedded preview instead (usually 1–2 MP, often full size), which is what
//! the grid, the viewer and photo search need. Nothing here loads the whole
//! file: it reads the small TIFF directories with positioned reads, then only
//! the one preview picture it picked. The originals are never modified.
//!
//! Layouts handled:
//! - TIFF-based (DNG, CR2, NEF, NRW, ARW, SR2, SRF, PEF, SRW, ORF, RW2): the
//!   directory tree (IFD0, IFD1, SubIFDs) lists the pictures.
//! - RAF (Fujifilm): a fixed header names the JPEG's offset and length.
//! - CR3 (Canon) and anything else: the first few MiB are scanned for JPEG
//!   pictures (CR3 keeps its preview in the header boxes, ORF in its
//!   maker note).
//!
//! Among the pictures found, the biggest baseline/progressive JPEG wins.
//! Lossless JPEG (the sensor data inside DNG and CR2) is skipped.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use image::metadata::Orientation;

/// How far into a file the fallback scan looks for pictures.
const SCAN_BYTES: u64 = 4 * 1024 * 1024;
/// Header bytes read to learn a candidate's size (all markers before the
/// frame header; an EXIF segment alone can take 64 KiB).
const HEADER_PEEK: usize = 256 * 1024;
/// A preview bigger than this is not a preview.
const PREVIEW_MAX: u64 = 24 * 1024 * 1024;
/// Directories read per file, so a looping file cannot keep us busy.
const MAX_IFDS: usize = 24;
const MAX_ENTRIES: usize = 512;
/// Pictures a scan will consider.
const MAX_CANDIDATES: usize = 24;

/// Positioned reads from a file or from bytes already in memory.
pub(crate) trait ReadAt {
    fn len(&self) -> u64;
    /// Up to `len` bytes at `off`; short at the end of the data.
    fn read_at(&self, off: u64, len: usize) -> Option<Vec<u8>>;
}

impl ReadAt for File {
    fn len(&self) -> u64 {
        self.metadata().map(|m| m.len()).unwrap_or(0)
    }

    fn read_at(&self, off: u64, len: usize) -> Option<Vec<u8>> {
        let mut file = self;
        file.seek(SeekFrom::Start(off)).ok()?;
        let mut buf = Vec::new();
        file.take(len as u64).read_to_end(&mut buf).ok()?;
        Some(buf)
    }
}

impl ReadAt for [u8] {
    fn len(&self) -> u64 {
        <[u8]>::len(self) as u64
    }

    fn read_at(&self, off: u64, len: usize) -> Option<Vec<u8>> {
        let start = usize::try_from(off).ok()?;
        let end = start.saturating_add(len).min(<[u8]>::len(self));
        self.get(start..end).map(<[u8]>::to_vec)
    }
}

/// A raw's embedded picture.
pub(crate) struct RawPreview {
    pub jpeg: Vec<u8>,
    /// The raw's own EXIF turn, for pictures that carry none themselves.
    pub orientation: Orientation,
}

/// True for the camera RAW extensions.
pub fn is_raw(path: &Path) -> bool {
    crate::photos::formats::for_path(path)
        .is_some_and(|f| f.decode == crate::photos::formats::Decode::Raw)
}

/// The first `n` bytes of a file.
pub(crate) fn head(path: &Path, n: usize) -> Option<Vec<u8>> {
    File::open(path).ok()?.read_at(0, n)
}

/// Magic-byte check for the RAW containers that are not plain TIFF or
/// ISO-BMFF (those two are recognised elsewhere): ORF (`IIRO`, `IIRS`,
/// `MMOR`), RW2 (`IIU\0`) and RAF.
pub(crate) fn sniff_raw_bytes(head: &[u8]) -> bool {
    head.starts_with(b"IIRO")
        || head.starts_with(b"IIRS")
        || head.starts_with(b"MMOR")
        || head.starts_with(&[b'I', b'I', 0x55, 0x00])
        || head.starts_with(b"FUJIFILMCCD-RAW")
}

/// The embedded preview of the raw at `path`, upright information included.
pub(crate) fn preview_from_file(path: &Path, max_bytes: u64) -> Option<RawPreview> {
    let file = File::open(path).ok()?;
    preview_from(&file, max_bytes)
}

pub(crate) fn preview_from<R: ReadAt + ?Sized>(src: &R, max_bytes: u64) -> Option<RawPreview> {
    let size = src.len();
    let head = src.read_at(0, 128)?;
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut orientation = Orientation::NoTransforms;

    if head.starts_with(b"FUJIFILMCCD-RAW") && head.len() >= 92 {
        let off = u64::from(u32::from_be_bytes(head[84..88].try_into().ok()?));
        let len = u64::from(u32::from_be_bytes(head[88..92].try_into().ok()?));
        candidates.push(Candidate::sized(off, len));
    } else if let Some(walk) = walk_tiff(src, 0) {
        candidates = walk.candidates;
        orientation = walk.orientation;
    }

    let mut best = best_candidate(src, &candidates, size);
    if best.is_none() {
        // CR3, ORF and odd files: look for pictures at the start of the file.
        let scanned = scan_candidates(src, size);
        best = best_candidate(src, &scanned, size);
        if orientation == Orientation::NoTransforms {
            orientation = cr3_orientation(src).unwrap_or(orientation);
        }
    }
    let (cand, _dims) = best?;
    let len = cand.len.min(PREVIEW_MAX).min(max_bytes);
    let jpeg = src.read_at(cand.off, usize::try_from(len).ok()?)?;
    jpeg.starts_with(&[0xFF, 0xD8])
        .then_some(RawPreview { jpeg, orientation })
}

#[derive(Debug, Clone, Copy)]
struct Candidate {
    off: u64,
    /// Bytes to read; the scan's guess when the file does not say.
    len: u64,
}

impl Candidate {
    fn sized(off: u64, len: u64) -> Self {
        Self { off, len }
    }
}

/// The candidate with the most pixels that is a decodable kind of JPEG.
fn best_candidate<R: ReadAt + ?Sized>(
    src: &R,
    candidates: &[Candidate],
    size: u64,
) -> Option<(Candidate, (u32, u32))> {
    let mut best: Option<(Candidate, (u32, u32))> = None;
    for cand in candidates.iter().take(MAX_CANDIDATES) {
        if cand.len < 4 || cand.off >= size {
            continue;
        }
        let Some(dims) = jpeg_dimensions(src, cand.off, cand.len) else {
            continue;
        };
        let area = u64::from(dims.0) * u64::from(dims.1);
        if best.is_none_or(|(_, d)| area > u64::from(d.0) * u64::from(d.1)) {
            let len = cand.len.min(size - cand.off);
            best = Some((Candidate { off: cand.off, len }, dims));
        }
    }
    best
}

/// Width and height from a JPEG's frame header, when it is baseline,
/// extended-sequential or progressive. Lossless (SOF3) and arithmetic-coded
/// frames return `None`, as does anything that is not a JPEG.
fn jpeg_dimensions<R: ReadAt + ?Sized>(src: &R, off: u64, len: u64) -> Option<(u32, u32)> {
    let peek = usize::try_from(len).ok()?.min(HEADER_PEEK);
    let buf = src.read_at(off, peek)?;
    if !buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return None;
    }
    let mut pos = 2usize;
    loop {
        // Skip fill bytes up to the marker's code.
        while *buf.get(pos)? == 0xFF && *buf.get(pos + 1)? == 0xFF {
            pos += 1;
        }
        if *buf.get(pos)? != 0xFF {
            return None;
        }
        let marker = *buf.get(pos + 1)?;
        match marker {
            // Start of scan or end of image before any frame header.
            0xDA | 0xD9 => return None,
            0xC0..=0xC2 => {
                let h = u16::from_be_bytes([*buf.get(pos + 5)?, *buf.get(pos + 6)?]);
                let w = u16::from_be_bytes([*buf.get(pos + 7)?, *buf.get(pos + 8)?]);
                return (w > 0 && h > 0).then_some((u32::from(w), u32::from(h)));
            }
            // Lossless, differential and arithmetic frames: not for us.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            // Standalone markers have no length.
            0x01 | 0xD0..=0xD8 => pos += 2,
            _ => {
                let seg = usize::from(u16::from_be_bytes([*buf.get(pos + 2)?, *buf.get(pos + 3)?]));
                pos = pos.checked_add(2 + seg)?;
            }
        }
    }
}

/// Every `FF D8 FF` in the first few MiB, each a picture that runs until
/// the next one (or [`PREVIEW_MAX`]).
fn scan_candidates<R: ReadAt + ?Sized>(src: &R, size: u64) -> Vec<Candidate> {
    let window = usize::try_from(size.min(SCAN_BYTES)).unwrap_or(0);
    let Some(buf) = src.read_at(0, window) else {
        return Vec::new();
    };
    let mut starts = Vec::new();
    let mut i = 0usize;
    while i + 3 <= buf.len() && starts.len() < MAX_CANDIDATES {
        match buf[i..].iter().position(|&b| b == 0xFF) {
            Some(p) if buf.get(i + p + 1) == Some(&0xD8) && buf.get(i + p + 2) == Some(&0xFF) => {
                starts.push(i + p);
                i += p + 3;
            }
            Some(p) => i += p + 1,
            None => break,
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let end = starts.get(n + 1).map_or(size, |&next| next as u64);
            Candidate::sized(start as u64, (end - start as u64).min(PREVIEW_MAX))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// TIFF directories

struct Walk {
    candidates: Vec<Candidate>,
    orientation: Orientation,
}

struct Order(bool);

impl Order {
    fn u16(&self, b: &[u8]) -> u16 {
        let a = [b[0], b[1]];
        if self.0 {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        }
    }

    fn u32(&self, b: &[u8]) -> u32 {
        let a = [b[0], b[1], b[2], b[3]];
        if self.0 {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        }
    }
}

/// Read the TIFF structure that starts at `base`, collecting every JPEG
/// picture it points to. `None` when `base` does not hold a TIFF header.
/// The magic number is not checked: ORF and RW2 use their own.
fn walk_tiff<R: ReadAt + ?Sized>(src: &R, base: u64) -> Option<Walk> {
    let head = src.read_at(base, 8)?;
    if head.len() < 8 {
        return None;
    }
    let order = match &head[..2] {
        b"II" => Order(true),
        b"MM" => Order(false),
        _ => return None,
    };
    let mut queue = vec![u64::from(order.u32(&head[4..8]))];
    let mut seen: Vec<u64> = Vec::new();
    let mut walk = Walk {
        candidates: Vec::new(),
        orientation: Orientation::NoTransforms,
    };
    let size = src.len();
    let mut first = true;
    while let Some(ifd) = queue.pop() {
        if ifd < 8 || seen.contains(&ifd) || seen.len() >= MAX_IFDS {
            continue;
        }
        seen.push(ifd);
        let Some(count) = src.read_at(base + ifd, 2).filter(|c| c.len() == 2) else {
            continue;
        };
        let n = usize::from(order.u16(&count)).min(MAX_ENTRIES);
        let Some(body) = src.read_at(base + ifd + 2, n * 12 + 4) else {
            continue;
        };
        if body.len() < n * 12 + 4 {
            continue;
        }
        let (mut compression, mut strip_at, mut strip_len) = (0u16, None, None);
        let (mut jpeg_at, mut jpeg_len) = (None, None);
        for e in body[..n * 12].as_chunks::<12>().0 {
            let (tag, typ) = (order.u16(&e[0..2]), order.u16(&e[2..4]));
            let cnt = u64::from(order.u32(&e[4..8]));
            let val = u64::from(order.u32(&e[8..12]));
            let short = |v: &[u8]| u64::from(order.u16(v));
            match tag {
                0x112 if first && typ == 3 => {
                    walk.orientation = u8::try_from(short(&e[8..10]))
                        .ok()
                        .and_then(Orientation::from_exif)
                        .unwrap_or(Orientation::NoTransforms);
                }
                0x103 => compression = order.u16(&e[8..10]),
                0x111 if cnt == 1 => strip_at = Some(if typ == 3 { short(&e[8..10]) } else { val }),
                0x117 if cnt == 1 => {
                    strip_len = Some(if typ == 3 { short(&e[8..10]) } else { val })
                }
                0x201 => jpeg_at = Some(val),
                0x202 => jpeg_len = Some(val),
                // RW2: the full JPEG is a blob of its own.
                0x2E if typ == 7 && cnt > 1024 => {
                    walk.candidates.push(Candidate::sized(base + val, cnt));
                }
                // SubIFDs: reduced-size pictures live here (DNG, NEF, ARW).
                0x14A if cnt == 1 => queue.push(val),
                0x14A if cnt > 1 => {
                    let want = usize::try_from(cnt.min(16)).unwrap_or(0) * 4;
                    if let Some(offs) = src.read_at(base + val, want) {
                        queue.extend(
                            offs.as_chunks::<4>()
                                .0
                                .iter()
                                .map(|c| u64::from(order.u32(c))),
                        );
                    }
                }
                _ => {}
            }
        }
        if let (Some(at), Some(len)) = (jpeg_at, jpeg_len) {
            walk.candidates.push(Candidate::sized(base + at, len));
        }
        if matches!(compression, 6 | 7)
            && let (Some(at), Some(len)) = (strip_at, strip_len)
        {
            walk.candidates.push(Candidate::sized(base + at, len));
        }
        let next = u64::from(order.u32(&body[n * 12..n * 12 + 4]));
        if next != 0 && next < size {
            queue.insert(0, next);
        }
        first = false;
    }
    Some(walk)
}

// ---------------------------------------------------------------------------
// Canon CR3

/// The TIFF blocks of a CR3's `CMT1`–`CMT4` boxes: IFD0 (maker, model),
/// the Exif IFD (date, ISO, lens), the maker note, and the GPS IFD. Each is a
/// complete little TIFF whose directory holds those tags directly.
pub(crate) fn cr3_blocks(head: &[u8]) -> [Option<Vec<u8>>; 4] {
    let mut out: [Option<Vec<u8>>; 4] = Default::default();
    if head.get(4..12) != Some(b"ftypcrx ") {
        return out;
    }
    for (n, slot) in out.iter_mut().enumerate() {
        let name = [b'C', b'M', b'T', b'1' + n as u8];
        let Some(at) = head.windows(4).position(|w| w == name) else {
            continue;
        };
        let Some(size) = at
            .checked_sub(4)
            .and_then(|s| head.get(s..at))
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
        else {
            continue;
        };
        if size > 8
            && let Some(block) = head.get(at + 4..at - 4 + size)
        {
            *slot = Some(block.to_vec());
        }
    }
    out
}

fn cr3_orientation<R: ReadAt + ?Sized>(src: &R) -> Option<Orientation> {
    let head = src.read_at(0, usize::try_from(src.len().min(SCAN_BYTES)).ok()?)?;
    let block = cr3_blocks(&head).into_iter().next()??;
    Some(walk_tiff(block.as_slice(), 0)?.orientation)
}

/// Everything a TIFF-based raw's EXIF needs, from its first bytes. Reading
/// only a prefix keeps a 50 MB file out of memory; ORF and RW2 carry their
/// own magic number, which is swapped for TIFF's on the copy.
pub(crate) fn exif_prefix(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let want = usize::try_from(file.len().min(SCAN_BYTES).min(max_bytes)).ok()?;
    let mut buf = file.read_at(0, want)?;
    if buf.len() < 8 {
        return None;
    }
    match &buf[..2] {
        b"II" => buf[2..4].copy_from_slice(&[0x2A, 0x00]),
        b"MM" => buf[2..4].copy_from_slice(&[0x00, 0x2A]),
        _ => return None,
    }
    Some(buf)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A baseline JPEG header-only stub: SOI, one APPn pad, SOF0, SOS.
    fn jpeg_stub(w: u16, h: u16, sof: u8, pad: usize) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE1];
        j.extend_from_slice(&((pad + 2) as u16).to_be_bytes());
        j.extend(std::iter::repeat_n(0u8, pad));
        j.extend_from_slice(&[0xFF, sof, 0x00, 0x0B, 8]);
        j.extend_from_slice(&h.to_be_bytes());
        j.extend_from_slice(&w.to_be_bytes());
        j.extend_from_slice(&[1, 1, 0x11, 0]);
        j.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0xAA, 0xBB, 0xFF, 0xD9]);
        j
    }

    /// A little-endian TIFF: IFD0 with an orientation, then a SubIFD that
    /// points at `sub_jpeg`, then IFD1 pointing at `thumb`.
    pub(crate) fn tiff_with_previews(
        magic: [u8; 2],
        orientation: u16,
        sub_jpeg: &[u8],
        thumb: &[u8],
    ) -> Vec<u8> {
        let mut t = vec![b'I', b'I', magic[0], magic[1], 8, 0, 0, 0];
        // IFD0 at 8: 2 entries (Orientation, SubIFDs), next = IFD1.
        let ifd0 = 8usize;
        let ifd1 = ifd0 + 2 + 2 * 12 + 4;
        let sub = ifd1 + 2 + 2 * 12 + 4;
        let sub_data = sub + 2 + 3 * 12 + 4;
        let thumb_data = sub_data + sub_jpeg.len();
        let entry = |t: &mut Vec<u8>, tag: u16, typ: u16, cnt: u32, val: u32| {
            t.extend_from_slice(&tag.to_le_bytes());
            t.extend_from_slice(&typ.to_le_bytes());
            t.extend_from_slice(&cnt.to_le_bytes());
            t.extend_from_slice(&val.to_le_bytes());
        };
        t.extend_from_slice(&2u16.to_le_bytes());
        entry(&mut t, 0x112, 3, 1, u32::from(orientation));
        entry(&mut t, 0x14A, 4, 1, sub as u32);
        t.extend_from_slice(&(ifd1 as u32).to_le_bytes());
        // IFD1: JPEG thumbnail.
        t.extend_from_slice(&2u16.to_le_bytes());
        entry(&mut t, 0x201, 4, 1, thumb_data as u32);
        entry(&mut t, 0x202, 4, 1, thumb.len() as u32);
        t.extend_from_slice(&0u32.to_le_bytes());
        // SubIFD: a JPEG-compressed strip.
        t.extend_from_slice(&3u16.to_le_bytes());
        entry(&mut t, 0x103, 3, 1, 7);
        entry(&mut t, 0x111, 4, 1, sub_data as u32);
        entry(&mut t, 0x117, 4, 1, sub_jpeg.len() as u32);
        t.extend_from_slice(&0u32.to_le_bytes());
        t.extend_from_slice(sub_jpeg);
        t.extend_from_slice(thumb);
        t
    }

    #[test]
    fn takes_the_biggest_preview_from_the_directory_tree() {
        let big = jpeg_stub(1600, 1066, 0xC0, 40);
        let small = jpeg_stub(160, 120, 0xC0, 10);
        let raw = tiff_with_previews([0x2A, 0], 6, &big, &small);
        let got = preview_from(raw.as_slice(), 1 << 20).unwrap();
        assert_eq!(got.jpeg, big);
        assert_eq!(got.orientation, Orientation::Rotate90);
    }

    #[test]
    fn works_with_the_other_makers_header_magic() {
        let big = jpeg_stub(1200, 800, 0xC2, 4);
        for magic in [*b"RO", [0x55, 0x00]] {
            let raw = tiff_with_previews(magic, 1, &big, &jpeg_stub(80, 60, 0xC0, 2));
            assert_eq!(preview_from(raw.as_slice(), 1 << 20).unwrap().jpeg, big);
        }
    }

    #[test]
    fn skips_the_lossless_sensor_data() {
        // A DNG's full-size strip is lossless JPEG (SOF3): not a picture.
        let lossless = jpeg_stub(6000, 4000, 0xC3, 4);
        let preview = jpeg_stub(1024, 683, 0xC0, 4);
        let raw = tiff_with_previews([0x2A, 0], 1, &lossless, &preview);
        assert_eq!(preview_from(raw.as_slice(), 1 << 20).unwrap().jpeg, preview);
    }

    #[test]
    fn finds_a_fujifilm_raf_picture_by_its_header_offsets() {
        let jpeg = jpeg_stub(1920, 1280, 0xC0, 6);
        let mut raf = vec![0u8; 160];
        raf[..15].copy_from_slice(b"FUJIFILMCCD-RAW");
        raf[84..88].copy_from_slice(&148u32.to_be_bytes());
        raf[88..92].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        raf.truncate(148);
        raf.extend_from_slice(&jpeg);
        assert_eq!(preview_from(raf.as_slice(), 1 << 20).unwrap().jpeg, jpeg);
    }

    #[test]
    fn scans_the_start_of_a_file_with_no_directory() {
        // CR3 and others: pictures sit in header boxes.
        let small = jpeg_stub(160, 120, 0xC0, 4);
        let big = jpeg_stub(1620, 1080, 0xC0, 4);
        let mut file = vec![0u8; 64];
        file.extend_from_slice(&small);
        file.extend_from_slice(&[0u8; 32]);
        file.extend_from_slice(&big);
        let got = preview_from(file.as_slice(), 1 << 20).unwrap();
        assert!(got.jpeg.starts_with(&big));
    }

    #[test]
    fn garbage_and_empty_files_have_no_preview() {
        assert!(preview_from([0u8; 0].as_slice(), 1 << 20).is_none());
        assert!(preview_from(vec![7u8; 4096].as_slice(), 1 << 20).is_none());
        // Pointers past the end of the file are ignored, not followed.
        let mut lie = tiff_with_previews([0x2A, 0], 1, &jpeg_stub(10, 10, 0xC0, 1), &[]);
        lie.truncate(60);
        assert!(preview_from(lie.as_slice(), 1 << 20).is_none());
    }

    #[test]
    fn a_looping_directory_ends() {
        let mut t = vec![b'I', b'I', 0x2A, 0, 8, 0, 0, 0];
        t.extend_from_slice(&0u16.to_le_bytes());
        t.extend_from_slice(&8u32.to_le_bytes()); // next IFD is itself
        assert!(preview_from(t.as_slice(), 1 << 20).is_none());
    }

    #[test]
    fn sniffs_the_makers_own_headers() {
        assert!(sniff_raw_bytes(b"IIRO\x08\0\0\0"));
        assert!(sniff_raw_bytes(b"MMOR\0\0\0\x08"));
        assert!(sniff_raw_bytes(&[b'I', b'I', 0x55, 0, 8, 0, 0, 0]));
        assert!(sniff_raw_bytes(b"FUJIFILMCCD-RAW 0201"));
        assert!(!sniff_raw_bytes(b"<svg xmlns="));
    }

    #[test]
    fn reads_canons_metadata_blocks_from_a_cr3() {
        let mut head = vec![0, 0, 0, 24];
        head.extend_from_slice(b"ftypcrx ");
        head.extend_from_slice(&[0u8; 12]);
        let block = b"II*\0\x08\0\0\0\0\0\0\0\0\0";
        head.extend_from_slice(&((block.len() + 8) as u32).to_be_bytes());
        head.extend_from_slice(b"CMT1");
        head.extend_from_slice(block);
        let got = cr3_blocks(&head);
        assert_eq!(got[0].as_deref(), Some(&block[..]));
        assert!(got[1].is_none());
        assert!(cr3_blocks(b"not a cr3 at all").iter().all(Option::is_none));
    }
}
