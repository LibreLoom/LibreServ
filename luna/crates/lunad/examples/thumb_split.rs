//! D5 micro-bench: one photo thumbnail, full decode against the embedded
//! preview (stage one).
//!
//! `thumb_split <out-dir> <photo>...` times `lunad::photos::ensure_thumb`
//! (the full-quality thumbnail) and `ensure_thumb_first` (the embedded
//! preview when it is big enough, else the same full decode) and prints the
//! average ms per photo. Both must report the same original size. Run it
//! pinned to one slow core to approximate a Wyse 3040 (see
//! luna/perf/README.md); HEIC needs `heif-dec` and `heif-thumbnailer`.
use std::path::Path;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args
        .next()
        .expect("usage: thumb_split <out-dir> <photo>...");
    let files: Vec<String> = args.collect();
    std::fs::create_dir_all(&out).unwrap();
    let (mut full_ms, mut first_ms, mut previews) = (0.0, 0.0, 0);
    for (i, f) in files.iter().enumerate() {
        let full = Path::new(&out).join(format!("{i}-full.jpg"));
        let first = Path::new(&out).join(format!("{i}-first.jpg"));
        let _ = std::fs::remove_file(&full);
        let _ = std::fs::remove_file(&first);

        let t = Instant::now();
        let (w, h, _) = lunad::photos::ensure_thumb(Path::new(f), &full, "image").unwrap();
        full_ms += t.elapsed().as_secs_f64() * 1e3;

        let t = Instant::now();
        let (fw, fh, _, quality) =
            lunad::photos::ensure_thumb_first(Path::new(f), &first, "image").unwrap();
        first_ms += t.elapsed().as_secs_f64() * 1e3;
        previews += usize::from(quality == lunad::photos::THUMB_PREVIEW);
        assert_eq!(
            (fw, fh),
            (w, h),
            "{f}: both stages report the original size"
        );
    }
    let n = files.len() as f64;
    println!(
        "n={} full={:.0}ms first={:.0}ms per photo ({:.1}x), {} from an embedded preview",
        files.len(),
        full_ms / n,
        first_ms / n,
        full_ms / first_ms,
        previews
    );
}
