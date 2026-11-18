//! TinyCLIP for photo search: the text tokenizer and image preparation in
//! Rust, and the `luna-clip` worker that runs the two encoders.
//!
//! lunad is a static binary and can't load ONNX Runtime, so each encoder
//! runs in its own `luna-clip` process (os/clip/luna-clip.cpp), sandboxed as
//! `nobody` with a memory cap, fed fixed-size tensors over a pipe. The image
//! encoder runs while photos are being indexed and stops soon after; the
//! text encoder stays up for a few minutes after a search so typing stays
//! quick. Any failure turns photo search off for a while; ordinary search
//! never notices.
//!
//! Model: TinyCLIP-ViT-8M-16-Text-3M-YFCC15M (MIT), community ONNX export
//! revision 9463a9c: float32 image encoder, int8 text encoder, extracted at
//! build time (see scripts/build-models-pack.sh).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::clip_tok::Tokenizer;
use crate::sandbox::{self, SandboxIo};

/// Embedding width.
pub const DIM: usize = 512;
/// Input side of the image encoder.
pub const SIDE: u32 = 224;
/// Model folder under `<pack root>/models/`.
pub const MODEL_DIR: &str = "tinyclip";
const IMAGE_MODEL: &str = "image.onnx";
const TEXT_MODEL: &str = "text.onnx";
const TOKENIZER: &str = "tokenizer.json";

/// CLIP's normalization (OpenAI's mean and std, as in the export's
/// preprocessor_config.json).
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];

/// Memory cap for one worker (address space, so well above its ~70 MiB
/// resident peak: ONNX Runtime maps its library and reserves stacks).
const WORKER_MEMORY: u64 = 768 * 1024 * 1024;
/// Free memory needed to start a worker.
const START_FREE_BYTES: u64 = 256 * 1024 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// After this many failures in a row, photo search rests for a while.
const MAX_FAILURES: u32 = 3;
const REST: Duration = Duration::from_secs(30 * 60);

pub fn model_dir() -> PathBuf {
    crate::packs::models_dir().join(MODEL_DIR)
}

/// The worker program: `LUNA_CLIP_BIN`, else `/usr/local/bin/luna-clip`,
/// else `luna-clip` on PATH.
fn worker_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LUNA_CLIP_BIN") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let fixed = PathBuf::from("/usr/local/bin/luna-clip");
    if fixed.is_file() {
        return Some(fixed);
    }
    sandbox::which("luna-clip")
}

/// Is everything photo search needs installed?
pub fn installed() -> bool {
    let dir = model_dir();
    worker_bin().is_some()
        && dir.join(IMAGE_MODEL).is_file()
        && dir.join(TEXT_MODEL).is_file()
        && dir.join(TOKENIZER).is_file()
}

// ---------------------------------------------------------------------------
// Images

/// Turn a photos thumbnail into the encoder's input: shortest side to 224
/// (bicubic), center crop 224 × 224, CLIP-normalized, channels first.
pub fn image_tensor(jpeg: &Path) -> anyhow::Result<Vec<f32>> {
    let bytes = std::fs::read(jpeg)?;
    anyhow::ensure!(bytes.len() < 16 * 1024 * 1024, "thumbnail too large");
    let img = image::load_from_memory(&bytes)?.to_rgb8();
    let (w, h) = img.dimensions();
    anyhow::ensure!(w > 0 && h > 0, "empty image");
    let (nw, nh) = if w <= h {
        (
            SIDE,
            ((h as u64 * SIDE as u64) / w as u64).max(SIDE as u64) as u32,
        )
    } else {
        (
            ((w as u64 * SIDE as u64) / h as u64).max(SIDE as u64) as u32,
            SIDE,
        )
    };
    let resized = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::CatmullRom);
    let left = (nw - SIDE) / 2;
    let top = (nh - SIDE) / 2;
    let side = SIDE as usize;
    let mut out = vec![0f32; 3 * side * side];
    for y in 0..side {
        for x in 0..side {
            let px = resized.get_pixel(left + x as u32, top + y as u32);
            for c in 0..3 {
                out[c * side * side + y * side + x] = (px[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Workers

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Image,
    Text,
}

impl Mode {
    fn arg(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Text => "text",
        }
    }

    fn model(self) -> &'static str {
        match self {
            Self::Image => IMAGE_MODEL,
            Self::Text => TEXT_MODEL,
        }
    }

    /// How long an idle worker stays up.
    fn idle(self) -> Duration {
        match self {
            Self::Image => Duration::from_secs(60),
            Self::Text => Duration::from_secs(5 * 60),
        }
    }
}

struct Running {
    child: Child,
    // Keeps the model's descriptor open for the child's lifetime.
    _io: SandboxIo,
    last_used: Instant,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    failures: u32,
    resting_until: Option<Instant>,
    last_error: Option<String>,
}

/// One encoder worker, started on demand and stopped when idle.
pub struct Encoder {
    mode: Mode,
    state: Mutex<State>,
}

/// Why a photo-search step didn't happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    LowMemory,
    Resting,
    Failed(String),
}

impl Encoder {
    fn new(mode: Mode) -> Self {
        Self {
            mode,
            state: Mutex::new(State::default()),
        }
    }

    /// Run one request. `payload` is the raw request body the worker reads.
    fn request(&self, payload: &[u8]) -> Result<[f32; DIM], Unavailable> {
        let mut st = self.state.lock().unwrap();
        if let Some(until) = st.resting_until {
            if Instant::now() < until {
                return Err(Unavailable::Resting);
            }
            st.resting_until = None;
            st.failures = 0;
        }
        if st.running.is_none() {
            match self.start() {
                Ok(r) => {
                    st.running = Some(r);
                    // The reaper sleeps while no worker runs.
                    if let Some(reaper) = REAPER.get() {
                        reaper.unpark();
                    }
                }
                Err(e) => return Err(self.failed(&mut st, e)),
            }
        }
        let run = st.running.as_mut().unwrap();
        run.last_used = Instant::now();
        match exchange(&mut run.child, payload) {
            Ok(v) => {
                st.failures = 0;
                Ok(v)
            }
            Err(e) => {
                if let Some(mut r) = st.running.take() {
                    let _ = r.child.kill();
                    let _ = r.child.wait();
                }
                Err(self.failed(&mut st, Unavailable::Failed(e.to_string())))
            }
        }
    }

    fn failed(&self, st: &mut State, why: Unavailable) -> Unavailable {
        if let Unavailable::Failed(msg) = &why {
            st.failures += 1;
            st.last_error = Some(msg.clone());
            tracing::warn!(mode = self.mode.arg(), error = %msg, "photo search worker failed");
            if st.failures >= MAX_FAILURES {
                st.resting_until = Some(Instant::now() + REST);
            }
        }
        why
    }

    fn start(&self) -> Result<Running, Unavailable> {
        let bin = worker_bin().ok_or(Unavailable::NotInstalled)?;
        let model = model_dir().join(self.mode.model());
        if !model.is_file() {
            return Err(Unavailable::NotInstalled);
        }
        if crate::budget::meminfo().available_bytes < START_FREE_BYTES {
            return Err(Unavailable::LowMemory);
        }
        let fail = |e: std::io::Error| Unavailable::Failed(e.to_string());
        let mut io = SandboxIo::new().map_err(fail)?;
        io.limit_memory(WORKER_MEMORY);
        let model_arg = io.input_path(&model).map_err(fail)?;
        let mut cmd = std::process::Command::new(bin);
        cmd.arg(model_arg)
            .arg(self.mode.arg())
            .stderr(std::process::Stdio::null());
        let mut child = sandbox::spawn_piped(&mut cmd, &io).map_err(fail)?;
        let mut ready = [0u8; 1];
        let ok =
            read_with_timeout(&mut child, &mut ready, START_TIMEOUT).is_ok() && ready[0] == b'R';
        if !ok {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Unavailable::Failed("the worker did not start".into()));
        }
        Ok(Running {
            child,
            _io: io,
            last_used: Instant::now(),
        })
    }

    fn is_running(&self) -> bool {
        self.state.lock().unwrap().running.is_some()
    }

    /// Stop the worker if it has been idle long enough.
    fn reap(&self) {
        let mut st = self.state.lock().unwrap();
        let idle = st
            .running
            .as_ref()
            .is_some_and(|r| r.last_used.elapsed() >= self.mode.idle());
        if idle && let Some(mut r) = st.running.take() {
            drop(r.child.stdin.take());
            let _ = r.child.wait();
        }
    }

    /// The last failure, for diagnostics.
    fn status(&self) -> (bool, Option<String>) {
        let st = self.state.lock().unwrap();
        let resting = st.resting_until.is_some_and(|u| Instant::now() < u);
        (resting, st.last_error.clone())
    }
}

fn exchange(child: &mut Child, payload: &[u8]) -> std::io::Result<[f32; DIM]> {
    child
        .stdin
        .as_mut()
        .ok_or_else(|| std::io::Error::other("no stdin"))?
        .write_all(payload)?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| std::io::Error::other("no stdin"))?
        .flush()?;
    let mut raw = [0u8; DIM * 4];
    read_with_timeout(child, &mut raw, REQUEST_TIMEOUT)?;
    let mut out = [0f32; DIM];
    for (i, v) in out.iter_mut().enumerate() {
        *v = f32::from_le_bytes(raw[i * 4..i * 4 + 4].try_into().unwrap());
    }
    Ok(out)
}

/// Fill `buf` from the child's stdout, giving up after `timeout`.
fn read_with_timeout(child: &mut Child, buf: &mut [u8], timeout: Duration) -> std::io::Result<()> {
    let out = child
        .stdout
        .as_mut()
        .ok_or_else(|| std::io::Error::other("no stdout"))?;
    let deadline = Instant::now() + timeout;
    let mut got = 0;
    while got < buf.len() {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "worker timed out",
                ));
            }
            let mut pfd = libc::pollfd {
                fd: out.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ms = left.as_millis().min(i32::MAX as u128) as i32;
            let r = unsafe { libc::poll(&mut pfd, 1, ms) };
            if r < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            if r == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "worker timed out",
                ));
            }
        }
        let n = out.read(&mut buf[got..])?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "worker stopped",
            ));
        }
        got += n;
    }
    Ok(())
}

struct Workers {
    image: Encoder,
    text: Encoder,
    tokenizer: Mutex<Option<Arc<Tokenizer>>>,
}

/// The reaper thread, unparked when a worker starts.
static REAPER: OnceLock<std::thread::Thread> = OnceLock::new();

fn workers() -> &'static Workers {
    static WORKERS: OnceLock<Workers> = OnceLock::new();
    WORKERS.get_or_init(|| {
        let reaper = std::thread::Builder::new()
            .name("luna-clip-reaper".into())
            .spawn(|| {
                loop {
                    let w = workers();
                    // No worker to stop: sleep until one starts.
                    if !w.image.is_running() && !w.text.is_running() {
                        std::thread::park();
                        continue;
                    }
                    std::thread::sleep(Duration::from_secs(15));
                    w.image.reap();
                    w.text.reap();
                }
            });
        if let Ok(handle) = reaper {
            let _ = REAPER.set(handle.thread().clone());
        }
        Workers {
            image: Encoder::new(Mode::Image),
            text: Encoder::new(Mode::Text),
            tokenizer: Mutex::new(None),
        }
    })
}

fn tokenizer() -> Result<Arc<Tokenizer>, Unavailable> {
    let w = workers();
    let mut slot = w.tokenizer.lock().unwrap();
    if let Some(t) = slot.as_ref() {
        return Ok(t.clone());
    }
    let path = model_dir().join(TOKENIZER);
    if !path.is_file() {
        return Err(Unavailable::NotInstalled);
    }
    let t = Arc::new(Tokenizer::load(&path).map_err(|e| Unavailable::Failed(e.to_string()))?);
    *slot = Some(t.clone());
    Ok(t)
}

/// A unit vector for a thumbnail.
pub fn embed_image(thumb: &Path) -> Result<Option<[f32; DIM]>, Unavailable> {
    let Ok(tensor) = image_tensor(thumb) else {
        // A broken thumbnail is that photo's problem, not the worker's.
        return Ok(None);
    };
    let payload: Vec<u8> = tensor.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut v = workers().image.request(&payload)?;
    Ok(super::m2v::normalize(&mut v).then_some(v))
}

/// A unit vector for a text.
pub fn embed_text(text: &str) -> Result<Option<[f32; DIM]>, Unavailable> {
    let ids = tokenizer()?.encode(text);
    let mut payload = Vec::with_capacity(4 + ids.len() * 8);
    payload.extend((ids.len() as u32).to_le_bytes());
    for id in ids {
        payload.extend((id as i64).to_le_bytes());
    }
    let mut v = workers().text.request(&payload)?;
    Ok(super::m2v::normalize(&mut v).then_some(v))
}

/// Why photo search is off right now, or `None` when it's on.
pub fn off_reason() -> Option<&'static str> {
    if !installed() {
        return Some("not_installed");
    }
    let w = workers();
    if w.image.status().0 || w.text.status().0 {
        return Some("failing");
    }
    if crate::budget::meminfo().total_bytes < 1536 * 1024 * 1024 {
        return Some("low_memory");
    }
    None
}

/// The last worker failure, for diagnostics.
pub fn last_error() -> Option<String> {
    let w = workers();
    w.image.status().1.or_else(|| w.text.status().1)
}

/// Quantize a unit vector to int8 for storage.
pub fn to_i8(v: &[f32; DIM]) -> Vec<u8> {
    v.iter()
        .map(|x| (x * 127.0).round().clamp(-127.0, 127.0) as i8 as u8)
        .collect()
}

/// Cosine of a query vector and a stored int8 vector.
pub fn cosine_i8(q: &[f32; DIM], stored: &[u8]) -> f32 {
    if stored.len() != DIM {
        return -1.0;
    }
    let mut dot = 0f32;
    let mut norm = 0f32;
    for (a, b) in q.iter().zip(stored) {
        let b = *b as i8 as f32;
        dot += a * b;
        norm += b * b;
    }
    if norm <= 0.0 { -1.0 } else { dot / norm.sqrt() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_tensor_is_224_square_and_normalized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jpg");
        image::RgbImage::from_pixel(640, 480, image::Rgb([255, 255, 255]))
            .save(&path)
            .unwrap();
        let t = image_tensor(&path).unwrap();
        assert_eq!(t.len(), 3 * 224 * 224);
        let white_r = (1.0 - MEAN[0]) / STD[0];
        assert!((t[0] - white_r).abs() < 0.02);
    }
}
