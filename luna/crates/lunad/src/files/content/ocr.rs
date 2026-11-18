//! Reading printed text in images and scanned PDFs with Tesseract.
//!
//! Tesseract runs sandboxed like every other parser, one image at a time
//! and single-threaded, so a 2 GiB box keeps serving files while it works.
//! Only English is installed. Words Tesseract is unsure of are dropped: a
//! holiday photo should come back empty, not as a line of `~ | _ ii`.

use std::path::Path;
use std::time::Duration;

use super::extract::TextSink;
use super::worker::{Outcome, stderr_line};
use crate::sandbox::{self, SandboxIo};

const OCR_TIMEOUT: Duration = Duration::from_secs(120);
const OCR_CPU_SECS: u64 = 100;
/// Tesseract holds the decoded image (a 24 MP photo is ~100 MiB in RGBA)
/// plus its own buffers.
const OCR_MEMORY: u64 = 768 * 1024 * 1024;
/// Scanned PDFs: pages read, and their resolution. 200 dpi is enough for
/// printed text and keeps a page PNG small enough for the 32 MB `/tmp`.
const OCR_PDF_MAX_PAGES: u32 = 30;
const OCR_PDF_DPI: u32 = 200;
/// Tesseract word confidence (0–100) below which a word is dropped.
const MIN_CONFIDENCE: f32 = 60.0;
/// Fewer real words than this on an image means it had no text worth
/// keeping (a photo of a street sign is still found by its sign).
const MIN_WORDS: usize = 2;

/// Is Tesseract installed?
pub fn available() -> bool {
    sandbox::which("tesseract").is_some()
}

/// OCR one image file. HEIC is decoded to JPEG first (sandboxed).
pub fn ocr_image(path: &Path) -> std::io::Result<Outcome> {
    let Some(tesseract) = sandbox::which("tesseract") else {
        return Ok(Outcome::Unavailable);
    };
    if crate::photos::heif::is_heif(path) {
        let tmp = tempfile::Builder::new().prefix("luna-ocr-").tempdir()?;
        let jpeg = tmp.path().join("decoded.jpg");
        if let Err(e) = crate::photos::heif::decode_heif_to_jpeg(path, &jpeg) {
            return Ok(Outcome::Failed(format!("HEIC decode: {e}")));
        }
        return run_tesseract(&tesseract, &jpeg);
    }
    run_tesseract(&tesseract, path)
}

/// OCR the first pages of a PDF that has no text layer, one page at a time.
pub fn ocr_pdf(path: &Path) -> std::io::Result<Outcome> {
    let (Some(tesseract), Some(pdftoppm)) =
        (sandbox::which("tesseract"), sandbox::which("pdftoppm"))
    else {
        return Ok(Outcome::Unavailable);
    };
    let mut sink = TextSink::new();
    for (pages_read, page) in (1..=OCR_PDF_MAX_PAGES).enumerate() {
        let mut io = SandboxIo::new()?;
        io.limit_memory(OCR_MEMORY).limit_cpu(OCR_CPU_SECS);
        let input = io.input_path(path)?;
        let base = io.out_path("page")?;
        let mut cmd = std::process::Command::new(&pdftoppm);
        cmd.args(["-q", "-gray", "-png", "-singlefile", "-r"])
            .arg(OCR_PDF_DPI.to_string())
            .args(["-f", &page.to_string(), "-l", &page.to_string()])
            .arg(&input)
            .arg(&base)
            .stderr(std::process::Stdio::piped());
        let status = sandbox::output(&mut cmd, &io, OCR_TIMEOUT)?;
        let png = io.out_path("page.png")?;
        if !status.status.success() || !png.exists() {
            // Past the last page (or a page poppler can't draw): stop.
            if page == 1 {
                return Ok(Outcome::Failed(format!(
                    "pdftoppm: {}",
                    stderr_line(&status.stderr)
                )));
            }
            break;
        }
        // Tesseract reads the page through its own sandbox; hand it a copy
        // in a directory we own, so it never touches the first child's dir.
        let tmp = tempfile::Builder::new().prefix("luna-ocr-").tempdir()?;
        let local = tmp.path().join("page.png");
        {
            let mut src = io.open_out("page.png")?;
            let mut dst = std::fs::File::create(&local)?;
            std::io::copy(&mut src, &mut dst)?;
        }
        drop(io);
        match run_tesseract(&tesseract, &local)? {
            Outcome::Text(text) => {
                if !text.is_empty() {
                    sink.push(&text);
                    sink.newline();
                }
            }
            Outcome::Failed(why) if pages_read == 0 => return Ok(Outcome::Failed(why)),
            _ => {}
        }
        if sink.is_full() {
            break;
        }
    }
    Ok(Outcome::Text(sink.finish()))
}

fn run_tesseract(tesseract: &Path, image: &Path) -> std::io::Result<Outcome> {
    let mut io = SandboxIo::new()?;
    io.limit_memory(OCR_MEMORY).limit_cpu(OCR_CPU_SECS);
    let input = io.input_path(image)?;
    let base = io.out_path("ocr")?;
    let mut cmd = std::process::Command::new(tesseract);
    cmd.arg(&input)
        .arg(&base)
        .args(["-l", "eng", "--psm", "3", "tsv"])
        .stderr(std::process::Stdio::piped());
    // Single-threaded: OpenMP would otherwise take every core.
    cmd.env("OMP_THREAD_LIMIT", "1");
    let result = sandbox::output(&mut cmd, &io, OCR_TIMEOUT)?;
    if !result.status.success() {
        return Ok(Outcome::Failed(match result.status.code() {
            Some(code) => format!("tesseract exited {code}: {}", stderr_line(&result.stderr)),
            None => "tesseract was stopped (time or memory limit)".into(),
        }));
    }
    let tsv = super::worker::read_raw(&mut io, "ocr.tsv")?;
    Ok(Outcome::Text(confident_text(&tsv)))
}

/// Rebuild lines from Tesseract's TSV, keeping only confident words that
/// look like words. Columns: level page block par line word left top width
/// height conf text.
pub fn confident_text(tsv: &str) -> String {
    let mut sink = TextSink::new();
    let mut last_line: Option<(u32, u32, u32)> = None;
    let mut last_block: Option<u32> = None;
    let mut words = 0usize;
    for row in tsv.lines().skip(1) {
        let cols: Vec<&str> = row.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let conf: f32 = cols[10].parse().unwrap_or(-1.0);
        let text = cols[11].trim();
        if conf < MIN_CONFIDENCE || !looks_like_word(text) {
            continue;
        }
        let num = |i: usize| cols[i].parse::<u32>().unwrap_or(0);
        let line = (num(2), num(3), num(4));
        if last_block.is_some_and(|b| b != line.0) {
            sink.newline();
        } else if last_line.is_some_and(|l| l != line) {
            sink.push_char('\n');
        } else if last_line.is_some() {
            sink.space();
        }
        last_line = Some(line);
        last_block = Some(line.0);
        sink.push(text);
        if text.chars().filter(|c| c.is_alphanumeric()).count() >= 3 {
            words += 1;
        }
    }
    if words < MIN_WORDS {
        return String::new();
    }
    sink.finish()
}

/// At least two letters or digits, and mostly letters or digits.
fn looks_like_word(s: &str) -> bool {
    let total = s.chars().count();
    let alnum = s.chars().filter(|c| c.is_alphanumeric()).count();
    alnum >= 2 && alnum * 2 >= total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(block: u32, line: u32, word: u32, conf: f32, text: &str) -> String {
        format!("5\t1\t{block}\t1\t{line}\t{word}\t0\t0\t10\t10\t{conf}\t{text}")
    }

    #[test]
    fn keeps_confident_words_and_rebuilds_lines() {
        let tsv = [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext".to_string(),
            row(1, 1, 1, 95.0, "TOTAL"),
            row(1, 1, 2, 91.0, "12.50"),
            row(1, 2, 1, 30.0, "smudge"),
            row(1, 2, 2, 88.0, "Thank"),
            row(1, 2, 3, 88.0, "you"),
            row(2, 1, 1, 90.0, "~|"),
            row(2, 1, 2, 90.0, "Grocer"),
        ]
        .join("\n");
        assert_eq!(confident_text(&tsv), "TOTAL 12.50\nThank you\n\nGrocer");
    }

    #[test]
    fn a_photo_with_noise_only_reads_as_empty() {
        let tsv = [
            "header".to_string(),
            row(1, 1, 1, 70.0, "ii"),
            row(1, 1, 2, 40.0, "Mountain"),
            row(1, 1, 3, 80.0, "—"),
        ]
        .join("\n");
        assert_eq!(confident_text(&tsv), "");
    }
}
