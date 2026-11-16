//! D5 micro-bench: one photo thumbnail, before and after scaled decoding.
//!
//! `thumb_split <out-dir> <jpeg>...` times the old recipe (full decode,
//! Lanczos3 over every pixel, JPEG q85) against `lunad::photos::ensure_thumb`
//! and prints the average ms per photo. Run it pinned to one slow core to
//! approximate a Wyse 3040 (see luna/perf/README.md).
use std::path::Path;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("usage: thumb_split <out-dir> <jpeg>...");
    let files: Vec<String> = args.collect();
    std::fs::create_dir_all(&out).unwrap();
    let (mut old_ms, mut new_ms) = (0.0, 0.0);
    for (i, f) in files.iter().enumerate() {
        let t = Instant::now();
        let img = image::ImageReader::open(f).unwrap().decode().unwrap();
        let thumb = img.resize(640, 640, image::imageops::FilterType::Lanczos3);
        let mut buf = std::io::BufWriter::new(
            std::fs::File::create(Path::new(&out).join(format!("{i}-old.jpg"))).unwrap(),
        );
        thumb
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut buf, 85,
            ))
            .unwrap();
        drop(buf);
        old_ms += t.elapsed().as_secs_f64() * 1e3;

        let t = Instant::now();
        let dest = Path::new(&out).join(format!("{i}-new.jpg"));
        let (w, h, _) = lunad::photos::ensure_thumb(Path::new(f), &dest, "image").unwrap();
        new_ms += t.elapsed().as_secs_f64() * 1e3;
        assert_eq!(
            (w, h),
            (img.width(), img.height()),
            "original size must be reported"
        );
    }
    let n = files.len() as f64;
    println!(
        "n={} old={:.0}ms new={:.0}ms per photo ({:.1}x)",
        files.len(),
        old_ms / n,
        new_ms / n,
        old_ms / new_ms
    );
}
