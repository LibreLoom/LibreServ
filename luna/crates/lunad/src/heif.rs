//! HEIC/HEIF helpers that stay musl-friendly.
//!
//! Decode does **not** link libheif into lunad (Alpine/musl static builds stay
//! pure Rust). Thumbnails for HEVC-coded iPhone photos use the distro
//! `heif-dec` / `heif-convert` binary from Alpine's `libheif-tools` package
//! when it is installed. EXIF is parsed from the ISOBMFF `Exif` item in
//! process. Originals are never modified.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

pub fn is_heif(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "heic" | "heif" | "hif"))
        .unwrap_or(false)
}

/// TIFF payload of the first `Exif` item, if present.
pub fn exif_tiff_from_heif(bytes: &[u8]) -> Option<Vec<u8>> {
    let (items, idat) = parse_items(bytes)?;
    let exif = items.into_iter().find(|i| i.item_type == *b"Exif")?;
    let data = read_item(bytes, &idat, &exif)?;
    Some(strip_heif_exif_header(&data))
}

/// Embedded JPEG item (some HEIF files store a JPEG preview / primary).
pub fn jpeg_item_from_heif(bytes: &[u8]) -> Option<Vec<u8>> {
    let (items, idat) = parse_items(bytes)?;
    let jpeg = items
        .into_iter()
        .find(|i| i.item_type == *b"jpeg" || i.item_type == *b"jpg " || i.item_type == *b"mjpg")?;
    let data = read_item(bytes, &idat, &jpeg)?;
    if data.starts_with(&[0xFF, 0xD8]) {
        Some(data)
    } else {
        None
    }
}

fn strip_heif_exif_header(data: &[u8]) -> Vec<u8> {
    if data.len() >= 8 {
        let skip = u32::from_be_bytes(data[0..4].try_into().unwrap()) as usize;
        if skip <= data.len() && skip + 4 <= data.len() {
            let rest = &data[skip..];
            if rest.starts_with(b"II") || rest.starts_with(b"MM") {
                return rest.to_vec();
            }
        }
    }
    if let Some(pos) = data.windows(2).position(|w| w == b"II" || w == b"MM") {
        return data[pos..].to_vec();
    }
    data.to_vec()
}

struct HeifItem {
    item_id: u32,
    item_type: [u8; 4],
    method: u8,
    offset: u64,
    length: u64,
}

struct ParseCtx {
    items: Vec<HeifItem>,
    idat: Vec<u8>,
}

fn parse_items(bytes: &[u8]) -> Option<(Vec<HeifItem>, Vec<u8>)> {
    let mut ctx = ParseCtx {
        items: Vec::new(),
        idat: Vec::new(),
    };
    walk_top(bytes, &mut ctx)?;
    Some((ctx.items, ctx.idat))
}

fn walk_top(bytes: &[u8], ctx: &mut ParseCtx) -> Option<()> {
    let mut pos = 0usize;
    while pos + 8 <= bytes.len() {
        let (size, typ, header, payload_end) = read_box(bytes, pos)?;
        if &typ == b"meta" {
            // full box
            if header + 4 <= payload_end {
                walk_meta(&bytes[header + 4..payload_end], ctx);
            }
        }
        pos = if size == 0 { bytes.len() } else { payload_end };
    }
    Some(())
}

fn walk_meta(meta: &[u8], ctx: &mut ParseCtx) {
    let mut pos = 0usize;
    while pos + 8 <= meta.len() {
        let Some((size, typ, header, payload_end)) = read_box(meta, pos) else {
            break;
        };
        let payload = &meta[header..payload_end];
        match &typ {
            b"iinf" => parse_iinf(payload, ctx),
            b"iloc" => parse_iloc(payload, ctx),
            b"idat" => ctx.idat = payload.to_vec(),
            _ => {}
        }
        pos = if size == 0 { meta.len() } else { payload_end };
    }
}

fn parse_iinf(payload: &[u8], ctx: &mut ParseCtx) {
    // full box already included in payload start: version/flags at [0..4]
    if payload.len() < 6 {
        return;
    }
    let version = payload[0];
    let mut off = 4;
    let count = if version == 0 {
        if payload.len() < 6 {
            return;
        }
        let c = u16::from_be_bytes(payload[4..6].try_into().unwrap()) as usize;
        off = 6;
        c
    } else {
        if payload.len() < 8 {
            return;
        }
        let c = u32::from_be_bytes(payload[4..8].try_into().unwrap()) as usize;
        off = 8;
        c
    };
    for _ in 0..count {
        if off + 8 > payload.len() {
            break;
        }
        let Some((_, typ, header, end)) = read_box(&payload[off..], 0) else {
            break;
        };
        if &typ == b"infe" {
            parse_infe(&payload[off + header..off + end], ctx);
        }
        off += end;
        if off > payload.len() {
            break;
        }
    }
}

fn parse_infe(payload: &[u8], ctx: &mut ParseCtx) {
    if payload.len() < 8 {
        return;
    }
    let version = payload[0];
    if version < 2 || payload.len() < 12 {
        return;
    }
    let (item_id, mut p) = if version >= 3 {
        if payload.len() < 14 {
            return;
        }
        (u32::from_be_bytes(payload[4..8].try_into().unwrap()), 8)
    } else {
        (
            u16::from_be_bytes(payload[4..6].try_into().unwrap()) as u32,
            6,
        )
    };
    // skip protection_index u16
    p += 2;
    if p + 4 > payload.len() {
        return;
    }
    let mut item_type = [0u8; 4];
    item_type.copy_from_slice(&payload[p..p + 4]);
    if let Some(existing) = ctx.items.iter_mut().find(|i| i.item_id == item_id) {
        existing.item_type = item_type;
    } else {
        ctx.items.push(HeifItem {
            item_id,
            item_type,
            method: 0,
            offset: 0,
            length: 0,
        });
    }
}

fn parse_iloc(payload: &[u8], ctx: &mut ParseCtx) {
    if payload.len() < 6 {
        return;
    }
    let version = payload[0];
    let offset_size = payload[4] >> 4;
    let length_size = payload[4] & 0x0f;
    let base_offset_size = payload[5] >> 4;
    let index_size = if version == 1 || version == 2 {
        payload[5] & 0x0f
    } else {
        0
    };
    let mut p = 6;
    let item_count = if version < 2 {
        if p + 2 > payload.len() {
            return;
        }
        let c = u16::from_be_bytes(payload[p..p + 2].try_into().unwrap()) as usize;
        p += 2;
        c
    } else {
        if p + 4 > payload.len() {
            return;
        }
        let c = u32::from_be_bytes(payload[p..p + 4].try_into().unwrap()) as usize;
        p += 4;
        c
    };
    for _ in 0..item_count {
        let item_id = if version < 2 {
            if p + 2 > payload.len() {
                return;
            }
            let id = u16::from_be_bytes(payload[p..p + 2].try_into().unwrap()) as u32;
            p += 2;
            id
        } else {
            if p + 4 > payload.len() {
                return;
            }
            let id = u32::from_be_bytes(payload[p..p + 4].try_into().unwrap());
            p += 4;
            id
        };
        let mut method = 0u8;
        if version == 1 || version == 2 {
            if p + 2 > payload.len() {
                return;
            }
            method = (u16::from_be_bytes(payload[p..p + 2].try_into().unwrap()) & 0x0f) as u8;
            p += 2;
        }
        if p + 2 > payload.len() {
            return;
        }
        p += 2; // data_reference_index
        let base = read_sized(&payload, &mut p, base_offset_size).unwrap_or(0);
        if p + 2 > payload.len() {
            return;
        }
        let extent_count = u16::from_be_bytes(payload[p..p + 2].try_into().unwrap());
        p += 2;
        let mut offset = base;
        let mut length = 0u64;
        for _ in 0..extent_count {
            if index_size > 0 {
                let _ = read_sized(&payload, &mut p, index_size);
            }
            offset = base + read_sized(&payload, &mut p, offset_size).unwrap_or(0);
            length = read_sized(&payload, &mut p, length_size).unwrap_or(0);
        }
        if let Some(existing) = ctx.items.iter_mut().find(|i| i.item_id == item_id) {
            existing.method = method;
            existing.offset = offset;
            existing.length = length;
        } else {
            ctx.items.push(HeifItem {
                item_id,
                item_type: *b"    ",
                method,
                offset,
                length,
            });
        }
    }
}

fn read_sized(buf: &[u8], p: &mut usize, size: u8) -> Option<u64> {
    let n = size as usize;
    if n == 0 {
        return Some(0);
    }
    if *p + n > buf.len() {
        return None;
    }
    let mut v = 0u64;
    for _ in 0..n {
        v = (v << 8) | buf[*p] as u64;
        *p += 1;
    }
    Some(v)
}

fn read_item(file: &[u8], idat: &[u8], item: &HeifItem) -> Option<Vec<u8>> {
    let len = item.length as usize;
    if len == 0 {
        return None;
    }
    let src = if item.method == 1 { idat } else { file };
    let start = item.offset as usize;
    let end = start.checked_add(len)?;
    if end > src.len() {
        return None;
    }
    Some(src[start..end].to_vec())
}

fn read_box(buf: &[u8], pos: usize) -> Option<(u64, [u8; 4], usize, usize)> {
    if pos + 8 > buf.len() {
        return None;
    }
    let mut size = u32::from_be_bytes(buf[pos..pos + 4].try_into().ok()?) as u64;
    let mut typ = [0u8; 4];
    typ.copy_from_slice(&buf[pos + 4..pos + 8]);
    let mut header = 8usize;
    if size == 1 {
        if pos + 16 > buf.len() {
            return None;
        }
        size = u64::from_be_bytes(buf[pos + 8..pos + 16].try_into().ok()?);
        header = 16;
    } else if size == 0 {
        size = (buf.len() - pos) as u64;
    }
    if size < header as u64 {
        return None;
    }
    let end = pos.checked_add(size as usize)?;
    if end > buf.len() {
        return None;
    }
    Some((size, typ, pos + header, end))
}

/// Decode a HEIC file to `jpeg_out` using Alpine `libheif-tools` when present.
/// Never writes next to the original photo.
pub fn decode_heif_to_jpeg(src: &Path, jpeg_out: &Path) -> anyhow::Result<()> {
    if let Some(parent) = jpeg_out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dest_tmp = jpeg_out.with_extension("jpg.tmp");
    let tools = ["heif-dec", "heif-convert"];
    let mut last_err = anyhow::anyhow!("HEIC decoder is not installed on this Luna.");
    for bin in tools {
        if which(bin).is_none() {
            continue;
        }
        let mut cmd = Command::new(bin);
        cmd.arg(src)
            .arg(&dest_tmp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        match run_limited(cmd, Duration::from_secs(30)) {
            Ok(()) if dest_tmp.exists() => {
                std::fs::rename(&dest_tmp, jpeg_out)?;
                return Ok(());
            }
            Ok(()) => {
                last_err = anyhow::anyhow!("{bin} produced no JPEG");
            }
            Err(e) => last_err = e,
        }
        let _ = std::fs::remove_file(&dest_tmp);
    }
    Err(last_err)
}

fn which(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(bin);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run_limited(mut cmd: Command, timeout: Duration) -> anyhow::Result<()> {
    let mut child = cmd.spawn()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => anyhow::bail!("heif tool exited {status}"),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                anyhow::bail!("heif tool timed out");
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Build a tiny HEIF with an Exif item (tests).
#[cfg(test)]
pub fn fixture_heif_with_exif(tiff: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&6u32.to_be_bytes()); // offset to TIFF
    payload.extend_from_slice(tiff);

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let size = 8 + body.len() as u32;
        let mut v = Vec::new();
        v.extend_from_slice(&size.to_be_bytes());
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }
    fn full(typ: &[u8; 4], version: u8, body: &[u8]) -> Vec<u8> {
        let mut inner = vec![version, 0, 0, 0];
        inner.extend_from_slice(body);
        bx(typ, &inner)
    }

    let mut ftyp_body = Vec::new();
    ftyp_body.extend_from_slice(b"mif1");
    ftyp_body.extend_from_slice(&0u32.to_be_bytes());
    ftyp_body.extend_from_slice(b"mif1");
    ftyp_body.extend_from_slice(b"heic");
    let ftyp = bx(b"ftyp", &ftyp_body);

    let mut hdlr_body = vec![0u8; 4]; // predefined
    hdlr_body.extend_from_slice(b"pict");
    hdlr_body.extend_from_slice(&[0u8; 12]);
    hdlr_body.push(0);
    let hdlr = full(b"hdlr", 0, &hdlr_body);

    let mut pitm_body = Vec::new();
    pitm_body.extend_from_slice(&1u16.to_be_bytes());
    let pitm = full(b"pitm", 0, &pitm_body);

    // infe v2
    let mut infe_body = Vec::new();
    infe_body.extend_from_slice(&1u16.to_be_bytes()); // item_id
    infe_body.extend_from_slice(&0u16.to_be_bytes()); // protection
    infe_body.extend_from_slice(b"Exif");
    infe_body.push(0); // name
    let infe = full(b"infe", 2, &infe_body);
    let mut iinf_body = Vec::new();
    iinf_body.extend_from_slice(&1u16.to_be_bytes());
    iinf_body.extend_from_slice(&infe);
    let iinf = full(b"iinf", 0, &iinf_body);

    // Placeholders: we'll patch iloc offsets after laying out mdat.
    // Layout: ftyp | meta(hdlr pitm iinf iloc) | mdat
    let mdat_header = 8;
    let build = |iloc: &[u8]| {
        let mut meta_inner = Vec::new();
        meta_inner.extend_from_slice(&hdlr);
        meta_inner.extend_from_slice(&pitm);
        meta_inner.extend_from_slice(&iinf);
        meta_inner.extend_from_slice(iloc);
        full(b"meta", 0, &meta_inner)
    };

    let dummy_iloc = full(b"iloc", 0, &[0u8; 18]);
    let meta_guess = build(&dummy_iloc);
    let mdat_offset = ftyp.len() + meta_guess.len();
    let extent_offset = (mdat_offset + mdat_header) as u32;
    let mut iloc_body = Vec::new();
    iloc_body.push((4 << 4) | 4);
    iloc_body.push(0);
    iloc_body.extend_from_slice(&1u16.to_be_bytes());
    iloc_body.extend_from_slice(&1u16.to_be_bytes());
    iloc_body.extend_from_slice(&0u16.to_be_bytes());
    iloc_body.extend_from_slice(&1u16.to_be_bytes());
    iloc_body.extend_from_slice(&extent_offset.to_be_bytes());
    iloc_body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    let iloc = full(b"iloc", 0, &iloc_body);
    let meta = build(&iloc);

    let mut mdat = Vec::new();
    mdat.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
    mdat.extend_from_slice(b"mdat");
    mdat.extend_from_slice(&payload);

    let mut file = Vec::new();
    file.extend_from_slice(&ftyp);
    file.extend_from_slice(&meta);
    file.extend_from_slice(&mdat);
    file
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exif::{parse_exif_datetime, unix_from_tiff_bytes};

    fn tiff_datetime(ascii: &str) -> Vec<u8> {
        let mut ascii_bytes = ascii.as_bytes().to_vec();
        ascii_bytes.push(0);
        if ascii_bytes.len() % 2 == 1 {
            ascii_bytes.push(0);
        }
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x8769u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        let exif_ifd = 26u32;
        tiff.extend_from_slice(&exif_ifd.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x9003u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&(ascii_bytes.len() as u32).to_le_bytes());
        let val_off = exif_ifd + 2 + 12 + 4;
        tiff.extend_from_slice(&val_off.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(&ascii_bytes);
        tiff
    }

    #[test]
    fn heif_fixture_exposes_capture_date() {
        let ascii = "2021:03:04 05:06:07";
        let tiff = tiff_datetime(ascii);
        let heif = fixture_heif_with_exif(&tiff);
        let extracted = exif_tiff_from_heif(&heif).expect("exif item");
        assert_eq!(unix_from_tiff_bytes(&extracted), parse_exif_datetime(ascii));
    }

    #[test]
    fn heif_extensions() {
        assert!(is_heif(Path::new("IMG_0001.HEIC")));
        assert!(is_heif(Path::new("a.heif")));
        assert!(!is_heif(Path::new("a.jpg")));
    }
}
