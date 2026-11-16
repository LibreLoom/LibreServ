//! `luna-bench gen`: the datasets named in `perf/budgets.json`.
//!
//! Writes one mock drive, `<out>/luna-perf/`, holding `folder_small/`,
//! `folder_large/`, `library/` and `photos/`, plus the `.drive.json` that
//! makes lunad's dev mock drives pick it up (`LUNA_MOCK_DRIVES_PATH=<out>`:
//! every folder there becomes a drive, so `<out>` holds drives only).
//! Output is deterministic for one `--seed`.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::Context;

use crate::args::Args;
use crate::exif_write;

const HELP: &str = "\
luna-bench gen: write perf datasets (a mock drive) under perf/data

OPTIONS:
  --out DIR              parent dir for the drive (default: luna/perf/data/drives)
  --drive NAME           drive folder name (default: luna-perf)
  --preset quick|full    sizes below; full matches budgets.json (default: quick)
  --only LIST            comma list of folder_small,folder_large,library,photos
  --small N              items in folder_small            (quick 200,  full 200)
  --large N              items in folder_large            (quick 2000, full 10000)
  --library N            files in library                 (quick 5000, full 100000)
  --photos N             photos                           (quick 200,  full 50000)
  --photo-size WxH       photo pixels                     (quick 1024x768, full 4032x3024)
  --heic-fraction F      share of photos made HEIC        (default 0.2; needs heif-enc or ImageMagick)
  --dense-max-kb N       files above this are sparse (size without disk use; default 64)
  --threads N            photo encoder threads (default: all cores)
  --seed N               random seed (default 1)
  --force                write into a drive folder that already has data
";

pub fn main(raw: &[String]) -> anyhow::Result<()> {
    let a = Args::parse(
        raw,
        &[
            "out",
            "drive",
            "preset",
            "only",
            "small",
            "large",
            "library",
            "photos",
            "photo-size",
            "heic-fraction",
            "dense-max-kb",
            "threads",
            "seed",
            "force",
        ],
    )?;
    if a.help() {
        print!("{HELP}");
        return Ok(());
    }
    let full = match a.str_or("preset", "quick") {
        "quick" => false,
        "full" => true,
        other => anyhow::bail!("--preset must be quick or full, not {other:?}"),
    };
    let (w, h) = parse_size(a.str_or("photo-size", if full { "4032x3024" } else { "1024x768" }))?;
    let cfg = Config {
        small: a.num("small", 200)?,
        large: a.num("large", if full { 10_000 } else { 2_000 })?,
        library: a.num("library", if full { 100_000 } else { 5_000 })?,
        photos: a.num("photos", if full { 50_000 } else { 200 })?,
        photo_w: w,
        photo_h: h,
        heic_fraction: a.num("heic-fraction", 0.2f64)?.clamp(0.0, 1.0),
        dense_max: a.num("dense-max-kb", 64u64)? * 1024,
        threads: a.num(
            "threads",
            std::thread::available_parallelism().map_or(2, |n| n.get()),
        )?,
        seed: a.num("seed", 1u64)?,
    };
    let only: Vec<&str> = a
        .str_or("only", "folder_small,folder_large,library,photos")
        .split(',')
        .map(str::trim)
        .collect();
    let out = a
        .str("out")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::perf_dir().join("data").join("drives"));
    let drive = out.join(a.str_or("drive", "luna-perf"));
    if drive.exists() && fs::read_dir(&drive)?.next().is_some() && !a.flag("force") {
        anyhow::bail!(
            "{} already has data; delete it or pass --force",
            drive.display()
        );
    }
    fs::create_dir_all(&drive)?;
    write_drive_json(&drive)?;

    for name in only {
        let t = std::time::Instant::now();
        let n = match name {
            "folder_small" => gen_folder(&drive.join("folder_small"), cfg.small, &cfg, 11)?,
            "folder_large" => gen_folder(&drive.join("folder_large"), cfg.large, &cfg, 12)?,
            "library" => gen_library(&drive.join("library"), &cfg)?,
            "photos" => gen_photos(&drive.join("photos"), &cfg)?,
            other => anyhow::bail!("unknown dataset {other:?}"),
        };
        println!("{name}: {n} items in {:.1}s", t.elapsed().as_secs_f64());
    }
    println!("drive ready: {}", drive.display());
    Ok(())
}

struct Config {
    small: usize,
    large: usize,
    library: usize,
    photos: usize,
    photo_w: u32,
    photo_h: u32,
    heic_fraction: f64,
    dense_max: u64,
    threads: usize,
    seed: u64,
}

fn parse_size(s: &str) -> anyhow::Result<(u32, u32)> {
    let (w, h) = s
        .split_once('x')
        .with_context(|| format!("--photo-size {s:?}: expected WxH"))?;
    Ok((w.parse()?, h.parse()?))
}

fn write_drive_json(drive: &Path) -> anyhow::Result<()> {
    let name = drive
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "luna-perf".into());
    // lunad only offers devices named like block devices for adoption
    // (`is_storage_candidate`); mock drives must look like `sdmock*`.
    let device = format!("sdmock{}", name.replace(|c: char| !c.is_ascii_alphanumeric(), ""));
    // Reported as ext4, the usual format for a drive Luna keeps; mock
    // drives otherwise default to exFAT.
    let config = serde_json::json!({
        "name": device,
        "model": "Luna perf fixtures",
        "size_bytes": 2_000_000_000_000u64,
        "fs_type": "ext4",
        "removable": true,
        "usb": true,
        "mount_readonly": false,
    });
    fs::write(
        drive.join(".drive.json"),
        serde_json::to_string_pretty(&config)? + "\n",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Random numbers (SplitMix64: small, deterministic, no dependency)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `lo..hi` (`hi` exclusive; `lo` when the range is empty).
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next_u64() % (hi - lo)
    }

    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Log-uniform in `lo..hi`: many small values, a few large ones, like
    /// real file sizes.
    pub fn log_range(&mut self, lo: u64, hi: u64) -> u64 {
        let (l, h) = ((lo.max(1) as f64).ln(), (hi.max(2) as f64).ln());
        (l + (h - l) * self.f64()).exp() as u64
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.range(0, items.len() as u64) as usize]
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const WORDS: &[&str] = &[
    "budget",
    "garden",
    "invoice",
    "holiday",
    "report",
    "school",
    "recipe",
    "meeting",
    "notes",
    "summer",
    "winter",
    "family",
    "house",
    "insurance",
    "taxes",
    "project",
    "draft",
    "final",
    "letter",
    "plan",
    "photos",
    "music",
    "trip",
    "receipt",
    "contract",
    "lesson",
    "birthday",
    "renovation",
    "car",
    "doctor",
    "bank",
    "travel",
    "kitchen",
    "piano",
    "football",
    "club",
];

/// One file kind: extension, size range in bytes, and whether its body is
/// readable text (the content indexer reads those).
struct Kind {
    ext: &'static str,
    lo: u64,
    hi: u64,
    text: bool,
}

/// Library mix by count. No photo or video extensions: Photos would try to
/// thumbnail filler bytes. Real photos live in the `photos` dataset.
const KINDS: &[(u32, Kind)] = &[
    (
        22,
        Kind {
            ext: "txt",
            lo: 200,
            hi: 24 << 10,
            text: true,
        },
    ),
    (
        12,
        Kind {
            ext: "md",
            lo: 300,
            hi: 32 << 10,
            text: true,
        },
    ),
    (
        6,
        Kind {
            ext: "csv",
            lo: 1 << 10,
            hi: 512 << 10,
            text: true,
        },
    ),
    (
        14,
        Kind {
            ext: "pdf",
            lo: 30 << 10,
            hi: 8 << 20,
            text: false,
        },
    ),
    (
        10,
        Kind {
            ext: "docx",
            lo: 12 << 10,
            hi: 2 << 20,
            text: false,
        },
    ),
    (
        6,
        Kind {
            ext: "xlsx",
            lo: 8 << 10,
            hi: 1 << 20,
            text: false,
        },
    ),
    (
        3,
        Kind {
            ext: "odt",
            lo: 10 << 10,
            hi: 1 << 20,
            text: false,
        },
    ),
    (
        12,
        Kind {
            ext: "mp3",
            lo: 2 << 20,
            hi: 12 << 20,
            text: false,
        },
    ),
    (
        3,
        Kind {
            ext: "flac",
            lo: 15 << 20,
            hi: 45 << 20,
            text: false,
        },
    ),
    (
        5,
        Kind {
            ext: "zip",
            lo: 50 << 10,
            hi: 300 << 20,
            text: false,
        },
    ),
    (
        4,
        Kind {
            ext: "epub",
            lo: 200 << 10,
            hi: 5 << 20,
            text: false,
        },
    ),
    (
        3,
        Kind {
            ext: "log",
            lo: 1 << 10,
            hi: 4 << 20,
            text: true,
        },
    ),
];

fn pick_kind(rng: &mut Rng) -> &'static Kind {
    let total: u32 = KINDS.iter().map(|(w, _)| w).sum();
    let mut roll = rng.range(0, total as u64) as u32;
    for (w, k) in KINDS {
        if roll < *w {
            return k;
        }
        roll -= w;
    }
    &KINDS[0].1
}

fn file_name(rng: &mut Rng, i: usize, ext: &str) -> String {
    let a = rng.pick(WORDS);
    let b = rng.pick(WORDS);
    match rng.range(0, 4) {
        0 => format!("{a}-{b}-{i}.{ext}"),
        1 => format!("{a} {b} {} ({i}).{ext}", 2010 + rng.range(0, 16)),
        2 => format!("{}_{a}_{i:05}.{ext}", capitalize(b)),
        _ => format!("{a}{i}.{ext}"),
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// Write `size` bytes: real bytes up to `dense_max`, beyond that a sparse
/// file (right size, no disk use; reads back as zeros).
fn write_file(
    path: &Path,
    size: u64,
    text: bool,
    cfg: &Config,
    rng: &mut Rng,
) -> anyhow::Result<()> {
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    if size > cfg.dense_max {
        f.set_len(size)?;
        return Ok(());
    }
    let mut buf = Vec::with_capacity(size as usize);
    if text {
        while (buf.len() as u64) < size {
            let line_words = rng.range(4, 14);
            for _ in 0..line_words {
                buf.extend_from_slice(rng.pick(WORDS).as_bytes());
                buf.push(b' ');
            }
            buf.push(b'\n');
        }
        buf.truncate(size as usize);
    } else {
        while (buf.len() as u64) < size {
            buf.extend_from_slice(&rng.next_u64().to_le_bytes());
        }
        buf.truncate(size as usize);
    }
    f.write_all(&buf)?;
    Ok(())
}

/// One folder with `items` entries: 90% files, 10% subfolders.
fn gen_folder(dir: &Path, items: usize, cfg: &Config, salt: u64) -> anyhow::Result<usize> {
    fs::create_dir_all(dir)?;
    let mut rng = Rng::new(cfg.seed.wrapping_mul(1000) + salt);
    let folders = items / 10;
    for i in 0..folders {
        fs::create_dir_all(dir.join(format!("{} {i}", capitalize(rng.pick(WORDS)))))?;
    }
    for i in 0..items - folders {
        let kind = pick_kind(&mut rng);
        let size = rng.log_range(kind.lo, kind.hi.min(cfg.dense_max.max(kind.lo + 1)));
        write_file(
            &dir.join(file_name(&mut rng, i, kind.ext)),
            size,
            kind.text,
            cfg,
            &mut rng,
        )?;
    }
    Ok(items)
}

/// A household-like tree: a few top folders, 3–5 levels deep, 5–60 files
/// per folder, sizes log-uniform per kind.
fn gen_library(dir: &Path, cfg: &Config) -> anyhow::Result<usize> {
    const TOP: &[&str] = &[
        "Documents",
        "Music",
        "Projects",
        "Archive",
        "School",
        "Taxes",
        "Recipes",
        "Downloads",
        "Work",
        "Family",
    ];
    let mut rng = Rng::new(cfg.seed.wrapping_mul(1000) + 13);
    let mut queue: std::collections::VecDeque<(PathBuf, u32)> =
        TOP.iter().map(|t| (dir.join(t), 0)).collect();
    let mut written = 0usize;
    while written < cfg.library {
        let Some((folder, depth)) = queue.pop_front() else {
            // Out of folders before the count: start another top folder.
            queue.push_back((dir.join(format!("More {written}")), 0));
            continue;
        };
        fs::create_dir_all(&folder)?;
        let files = (rng.range(5, 61) as usize).min(cfg.library - written);
        for _ in 0..files {
            let kind = pick_kind(&mut rng);
            let size = rng.log_range(kind.lo, kind.hi);
            let name = file_name(&mut rng, written, kind.ext);
            write_file(&folder.join(name), size, kind.text, cfg, &mut rng)?;
            written += 1;
        }
        if depth < 4 {
            let subs = rng.range(if depth == 0 { 3 } else { 0 }, 7);
            for s in 0..subs {
                let name = match rng.range(0, 3) {
                    0 => format!("{}", 2010 + rng.range(0, 16)),
                    1 => format!("{} {s}", capitalize(rng.pick(WORDS))),
                    _ => format!("{} {}", capitalize(rng.pick(WORDS)), rng.pick(WORDS)),
                };
                queue.push_back((folder.join(name), depth + 1));
            }
        }
    }
    Ok(written)
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/// Places photos cluster around (lat, lon), so Places has real groups.
const PLACES: &[(f64, f64)] = &[
    (52.5200, 13.4050),   // Berlin
    (48.8566, 2.3522),    // Paris
    (41.9028, 12.4964),   // Rome
    (40.7128, -74.0060),  // New York
    (35.6762, 139.6503),  // Tokyo
    (-33.8688, 151.2093), // Sydney
    (46.5197, 6.6323),    // Lausanne
];

const CAMERAS: &[(&str, &str)] = &[
    ("Apple", "iPhone 13"),
    ("Google", "Pixel 7"),
    ("samsung", "SM-G991B"),
    ("Canon", "Canon EOS 250D"),
    ("FUJIFILM", "X-T30"),
];

/// Find a HEIC encoder: `heif-enc` (libheif) first, then ImageMagick.
fn heic_encoder() -> Option<Vec<String>> {
    let found = |bin: &str| {
        Command::new(bin)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    };
    if found("heif-enc") {
        return Some(vec!["heif-enc".into(), "-q".into(), "60".into()]);
    }
    for bin in ["magick", "convert"] {
        let heic = Command::new(bin)
            .args(["-list", "format"])
            .output()
            .ok()
            .is_some_and(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .any(|l| l.trim_start().starts_with("HEIC") && l.contains("rw"))
            });
        if heic {
            return Some(vec![bin.into()]);
        }
    }
    None
}

fn to_heic(encoder: &[String], jpg: &Path, heic: &Path) -> bool {
    let mut cmd = Command::new(&encoder[0]);
    cmd.args(&encoder[1..]);
    if encoder[0] == "heif-enc" {
        cmd.arg(jpg).arg("-o").arg(heic);
    } else {
        cmd.arg(jpg).arg(heic);
    }
    cmd.output().is_ok_and(|o| o.status.success()) && heic.is_file()
}

fn gen_photos(dir: &Path, cfg: &Config) -> anyhow::Result<usize> {
    fs::create_dir_all(dir)?;
    let heic = if cfg.heic_fraction > 0.0 {
        let enc = heic_encoder();
        if enc.is_none() {
            eprintln!(
                "photos: no HEIC encoder (heif-enc, or ImageMagick with HEIC); writing JPEG only"
            );
        }
        enc
    } else {
        None
    };
    let next = AtomicUsize::new(0);
    let heic_made = AtomicUsize::new(0);
    let threads = cfg.threads.max(1);
    std::thread::scope(|scope| -> anyhow::Result<()> {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| -> anyhow::Result<()> {
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= cfg.photos {
                            return Ok(());
                        }
                        if write_photo(dir, i, cfg, heic.as_deref())? {
                            heic_made.fetch_add(1, Ordering::Relaxed);
                        }
                        if i > 0 && i.is_multiple_of(1000) {
                            eprintln!("photos: {i}/{}", cfg.photos);
                        }
                    }
                })
            })
            .collect();
        for w in workers {
            w.join()
                .map_err(|_| anyhow::anyhow!("photo worker panicked"))??;
        }
        Ok(())
    })?;
    println!(
        "photos: {} HEIC of {}",
        heic_made.load(Ordering::Relaxed),
        cfg.photos
    );
    Ok(cfg.photos)
}

/// Write photo `i`. True when it was written as HEIC.
fn write_photo(
    dir: &Path,
    i: usize,
    cfg: &Config,
    heic: Option<&[String]>,
) -> anyhow::Result<bool> {
    let mut rng = Rng::new(cfg.seed.wrapping_mul(1_000_003) ^ (i as u64).wrapping_mul(0x2545_F491));
    // Taken 2012–2025; camera-roll layout photos/<year>/<month>/.
    let year = 2012 + rng.range(0, 14);
    let month = 1 + rng.range(0, 12);
    let day = 1 + rng.range(0, 28);
    let (hh, mm, ss) = (rng.range(6, 23), rng.range(0, 60), rng.range(0, 60));
    let taken = format!("{year:04}:{month:02}:{day:02} {hh:02}:{mm:02}:{ss:02}");
    let gps = (rng.f64() < 0.7).then(|| {
        let (lat, lon) = *rng.pick(PLACES);
        (lat + (rng.f64() - 0.5) * 0.2, lon + (rng.f64() - 0.5) * 0.2)
    });
    let (make, model) = *rng.pick(CAMERAS);
    let folder = dir.join(format!("{year}")).join(format!("{month:02}"));
    fs::create_dir_all(&folder)?;
    let stem = format!("IMG_{year}{month:02}{day:02}_{hh:02}{mm:02}{ss:02}_{i:06}");

    // Smooth gradients plus a little noise: compresses like a photo, not
    // like a flat test card (thumbnail cost follows pixels and entropy).
    let (w, h) = (cfg.photo_w, cfg.photo_h);
    let (r0, g0, b0) = (
        rng.range(0, 256) as f32,
        rng.range(0, 256) as f32,
        rng.range(0, 256) as f32,
    );
    let mut noise = rng.clone();
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        let n = (noise.next_u64() & 0x1F) as f32;
        image::Rgb([
            (r0 * (1.0 - fx) + 255.0 * fx * fy + n) as u8,
            (g0 * fy + 128.0 * (1.0 - fy) + n) as u8,
            (b0 * (1.0 - fy) * fx + 64.0 + n) as u8,
        ])
    });
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&img)?;
    let app1 = exif_write::app1(&exif_write::Meta {
        make,
        model,
        taken: &taken,
        gps,
        width: w,
        height: h,
    });
    let jpeg = exif_write::insert_after_soi(&jpeg, &app1);
    let jpg_path = folder.join(format!("{stem}.jpg"));
    fs::write(&jpg_path, &jpeg)?;

    if let Some(enc) = heic
        && rng.f64() < cfg.heic_fraction
    {
        let heic_path = folder.join(format!("{stem}.heic"));
        if to_heic(enc, &jpg_path, &heic_path) {
            fs::remove_file(&jpg_path)?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_reads_back() {
        let seg = exif_write::app1(&exif_write::Meta {
            make: "Canon",
            model: "EOS",
            taken: "2020:05:17 12:30:00",
            gps: Some((48.8566, -2.3522)),
            width: 64,
            height: 48,
        });
        let img = image::RgbImage::new(64, 48);
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .encode_image(&img)
            .unwrap();
        let jpeg = exif_write::insert_after_soi(&jpeg, &seg);
        let data = ::exif::Reader::new()
            .read_from_container(&mut std::io::Cursor::new(&jpeg))
            .unwrap();
        let taken = data
            .get_field(::exif::Tag::DateTimeOriginal, ::exif::In::PRIMARY)
            .unwrap();
        assert!(taken.display_value().to_string().contains("2020-05-17"));
        assert!(
            data.get_field(::exif::Tag::GPSLatitude, ::exif::In::PRIMARY)
                .is_some()
        );
        let lon_ref = data
            .get_field(::exif::Tag::GPSLongitudeRef, ::exif::In::PRIMARY)
            .unwrap();
        assert!(lon_ref.display_value().to_string().contains('W'));
    }
}
