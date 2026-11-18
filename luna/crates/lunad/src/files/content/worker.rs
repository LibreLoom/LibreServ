//! Running extraction in a sandbox.
//!
//! lunad re-runs itself as `lunad __extract <format> <input> <output>`
//! through [`crate::sandbox`]: the child is `nobody`, reads the file through
//! an inherited descriptor, writes plain text into a staging file, and has
//! memory and CPU caps. A parser bug or a hostile document can crash or hang
//! only that child. PDFs go to `pdftotext` the same way; images and scanned
//! pages go to Tesseract ([`super::ocr`]).

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use super::extract::{self, ExtractError, MAX_TEXT_BYTES};
use super::formats::Format;
use crate::sandbox::{self, SandboxIo};

/// The hidden subcommand lunad's `main` hands to [`worker_main`].
pub const SUBCOMMAND: &str = "__extract";

/// Exit codes the worker uses to say why it stopped.
const EXIT_PROTECTED: i32 = 3;
const EXIT_UNREADABLE: i32 = 4;

/// Wall-clock and CPU limits for one file.
#[cfg_attr(test, allow(dead_code))]
const WORKER_TIMEOUT: Duration = Duration::from_secs(90);
const WORKER_CPU_SECS: u64 = 60;
/// Address space for the Rust parsers: the static binary, a capped input
/// buffer for spreadsheets, and the parse itself.
#[cfg_attr(test, allow(dead_code))]
const WORKER_MEMORY: u64 = 384 * 1024 * 1024;
/// pdftotext keeps one page's layout at a time, but fonts and images in
/// big PDFs push it up.
const PDF_MEMORY: u64 = 512 * 1024 * 1024;
/// Pages pdftotext reads from one PDF. Long manuals still get their first
/// few hundred pages, which is where people search.
pub const PDF_MAX_PAGES: u32 = 300;

/// What reading one file produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The file's words (may be empty when it had none).
    Text(String),
    /// Password-protected; nothing to read.
    Protected,
    /// Over the size limit for its kind.
    TooBig,
    /// The worker failed, timed out, or hit its memory cap. The reason is
    /// for diagnostics, not for people.
    Failed(String),
    /// The tool this format needs isn't installed (dev machines).
    Unavailable,
}

/// Entry point of the `__extract` subcommand, running inside the sandbox.
/// Returns the process exit code.
pub fn worker_main(args: &[String]) -> i32 {
    let [format, input, output] = args else {
        eprintln!("usage: lunad {SUBCOMMAND} <format> <input> <output>");
        return 2;
    };
    let Some(format) = Format::parse(format) else {
        eprintln!("unknown format");
        return 2;
    };
    let file = match std::fs::File::open(input) {
        Ok(f) => std::io::BufReader::new(f),
        Err(e) => {
            eprintln!("open input: {e}");
            return EXIT_UNREADABLE;
        }
    };
    match extract::extract(format, file) {
        Ok(text) => match std::fs::write(output, text) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("write output: {e}");
                1
            }
        },
        Err(ExtractError::Protected) => EXIT_PROTECTED,
        Err(ExtractError::Unreadable(why)) => {
            eprintln!("{why}");
            EXIT_UNREADABLE
        }
    }
}

/// Read `path`'s text with the right tool, sandboxed. Blocking; call from a
/// background thread.
pub fn extract_file(path: &Path, format: Format, size: u64) -> Outcome {
    if size > format.max_input_bytes() {
        return Outcome::TooBig;
    }
    let result = match format {
        Format::Pdf => run_pdftotext(path),
        Format::Image => super::ocr::ocr_image(path),
        _ => run_worker(path, format),
    };
    result.unwrap_or_else(|e| Outcome::Failed(e.to_string()))
}

/// Tests can't re-run the test binary as `lunad __extract`, so they parse
/// in-process; the sandbox itself has its own tests.
#[cfg(test)]
fn run_worker(path: &Path, format: Format) -> std::io::Result<Outcome> {
    let file = std::io::BufReader::new(std::fs::File::open(path)?);
    Ok(match extract::extract(format, file) {
        Ok(text) => Outcome::Text(text),
        Err(ExtractError::Protected) => Outcome::Protected,
        Err(ExtractError::Unreadable(why)) => Outcome::Failed(why),
    })
}

#[cfg(not(test))]
fn run_worker(path: &Path, format: Format) -> std::io::Result<Outcome> {
    let exe = std::env::current_exe()?;
    let mut io = SandboxIo::new()?;
    io.limit_memory(WORKER_MEMORY).limit_cpu(WORKER_CPU_SECS);
    let input = io.input_path(path)?;
    let out = io.out_path("text.txt")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg(SUBCOMMAND)
        .arg(format.as_str())
        .arg(&input)
        .arg(&out)
        .stderr(std::process::Stdio::piped());
    let result = sandbox::output(&mut cmd, &io, WORKER_TIMEOUT)?;
    match result.status.code() {
        Some(0) => Ok(Outcome::Text(read_output(&mut io, "text.txt")?)),
        Some(EXIT_PROTECTED) => Ok(Outcome::Protected),
        Some(EXIT_UNREADABLE) => Ok(Outcome::Failed(stderr_line(&result.stderr))),
        Some(code) => Ok(Outcome::Failed(format!(
            "worker exited {code}: {}",
            stderr_line(&result.stderr)
        ))),
        None => Ok(Outcome::Failed(
            "worker was stopped (time or memory limit)".into(),
        )),
    }
}

fn run_pdftotext(path: &Path) -> std::io::Result<Outcome> {
    let Some(tool) = sandbox::which("pdftotext") else {
        return Ok(Outcome::Unavailable);
    };
    let mut io = SandboxIo::new()?;
    io.limit_memory(PDF_MEMORY).limit_cpu(WORKER_CPU_SECS);
    let input = io.input_path(path)?;
    let out = io.out_path("text.txt")?;
    let mut cmd = std::process::Command::new(tool);
    cmd.args(["-q", "-enc", "UTF-8", "-l"])
        .arg(PDF_MAX_PAGES.to_string())
        .arg(&input)
        .arg(&out)
        .stderr(std::process::Stdio::piped());
    let result = sandbox::output(&mut cmd, &io, WORKER_TIMEOUT)?;
    match result.status.code() {
        Some(0) => {
            let raw = read_output(&mut io, "text.txt")?;
            let mut sink = extract::TextSink::new();
            sink.push(&raw.replace('\u{0C}', "\n\n"));
            let text = sink.finish();
            if needs_ocr(&raw) {
                // No text layer (a scan): read the pages instead.
                return Ok(super::ocr::ocr_pdf(path).unwrap_or_else(|e| {
                    if text.is_empty() {
                        Outcome::Failed(e.to_string())
                    } else {
                        Outcome::Text(text.clone())
                    }
                }));
            }
            Ok(Outcome::Text(text))
        }
        // poppler: 1 = can't open (damaged or encrypted), 3 = permissions.
        Some(1) if is_encrypted_pdf(&result.stderr, path) => Ok(Outcome::Protected),
        Some(3) => Ok(Outcome::Protected),
        Some(code) => Ok(Outcome::Failed(format!(
            "pdftotext exited {code}: {}",
            stderr_line(&result.stderr)
        ))),
        None => Ok(Outcome::Failed(
            "pdftotext was stopped (time or memory limit)".into(),
        )),
    }
}

/// A PDF whose pages carry (almost) no text was scanned or photographed.
/// pdftotext separates pages with form feeds; fewer than ~20 letters per
/// page on average means there is no real text layer.
pub fn needs_ocr(raw: &str) -> bool {
    let pages = raw.matches('\u{0C}').count().max(1);
    let letters = raw.chars().filter(|c| c.is_alphanumeric()).count();
    letters < pages * 20
}

fn is_encrypted_pdf(stderr: &[u8], path: &Path) -> bool {
    let msg = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if msg.contains("password") || msg.contains("encrypt") {
        return true;
    }
    // `-q` silences the message; look for the /Encrypt key near the end
    // (trailer) of the file instead. Read only a small tail.
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)));
    let mut tail = Vec::new();
    let _ = f.take(64 * 1024).read_to_end(&mut tail);
    tail.windows(8).any(|w| w == b"/Encrypt")
}

/// The child's output, capped (text over the cap is cut at a character).
pub(super) fn read_output(io: &mut SandboxIo, name: &str) -> std::io::Result<String> {
    let file = io.open_out(name)?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 * 4)
        .read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut sink = extract::TextSink::new();
    sink.push(&text);
    Ok(sink.finish())
}

/// The child's output as-is (TSV and the like), capped.
pub(super) fn read_raw(io: &mut SandboxIo, name: &str) -> std::io::Result<String> {
    let file = io.open_out(name)?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 * 8)
        .read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) fn stderr_line(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    let line = s
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    line.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanned_pdf_text_is_detected() {
        assert!(needs_ocr(""));
        assert!(needs_ocr("\u{0C}\u{0C}\u{0C}"));
        assert!(needs_ocr("p 1\u{0C}p 2\u{0C}"));
        assert!(!needs_ocr(
            "This lease is made between the landlord and the tenant.\u{0C}"
        ));
    }

    #[test]
    fn worker_main_reports_protected_and_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.docx");
        let output = dir.path().join("out.txt");
        std::fs::write(&input, b"not a zip").unwrap();
        let args = |f: &str| {
            vec![
                f.to_string(),
                input.to_string_lossy().into_owned(),
                output.to_string_lossy().into_owned(),
            ]
        };
        assert_eq!(worker_main(&args("docx")), EXIT_UNREADABLE);
        std::fs::write(&input, "plain words").unwrap();
        assert_eq!(worker_main(&args("text")), 0);
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "plain words");
        assert_eq!(worker_main(&args("nope")), 2);
    }

    #[test]
    fn oversized_files_are_not_opened() {
        assert_eq!(
            extract_file(Path::new("/nonexistent.txt"), Format::Text, u64::MAX),
            Outcome::TooBig
        );
    }
}
