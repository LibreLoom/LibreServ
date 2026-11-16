//! Performance instrumentation for the journeys in `luna/perf/budgets.json`.
//!
//! Everything here logs at the `lunad::perf` target and is off unless the
//! daemon starts with `LUNA_PERF=1` (or `RUST_LOG` names `lunad::perf`).
//! Off, every hook costs one relaxed atomic load. Each event carries the
//! message `perf` and a `journey` field (`W4`, `D5`, …) so a log line maps
//! straight back to a budget. See `luna/perf/README.md`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Tracing target for every perf event.
pub const TARGET: &str = "lunad::perf";

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether perf instrumentation is on for this process.
#[inline]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Turn instrumentation on or off. `main` calls this once at startup.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Perf settings read from the environment at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvSettings {
    /// Instrumentation is on.
    pub enabled: bool,
    /// Directive `main` adds to the log filter (`lunad::perf=off|info|debug`),
    /// or `None` when `RUST_LOG` already names the target itself.
    pub directive: Option<String>,
}

/// Decide from `LUNA_PERF` and `RUST_LOG`. `LUNA_PERF=1|info` logs request
/// lines and job timings; `LUNA_PERF=debug` adds per-item timings
/// (each thumbnail, each drive's neural search pass).
pub fn settings_from(luna_perf: Option<&str>, rust_log: Option<&str>) -> EnvSettings {
    let level = match luna_perf.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if v == "debug" || v == "trace" => Some("debug"),
        Some(v) if !v.is_empty() && v != "0" && v != "off" && v != "false" => Some("info"),
        _ => None,
    };
    let named = rust_log.is_some_and(|r| r.contains(TARGET));
    // RUST_LOG=lunad::perf=off names the target too: respect it as "off".
    let named_off = rust_log.is_some_and(|r| {
        r.split(',')
            .any(|d| d.trim() == format!("{TARGET}=off").as_str())
    });
    let enabled = (level.is_some() || named) && !named_off;
    let directive = if named {
        None
    } else {
        Some(format!("{TARGET}={}", level.unwrap_or("off")))
    };
    EnvSettings { enabled, directive }
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    Info,
    Debug,
}

/// Times one piece of work and logs `perf journey=… op=… ms=…` when dropped,
/// so early returns and errors are timed too. While alive it also holds a
/// `perf{journey, op}` tracing span open, so other log lines from the same
/// work carry the journey. Holds a span guard: create it in sync code only,
/// never across an `.await`.
pub struct Timer {
    inner: Option<TimerInner>,
}

struct TimerInner {
    start: Instant,
    journey: &'static str,
    op: &'static str,
    level: Level,
    fields: Vec<(&'static str, String)>,
    _span: tracing::span::EnteredSpan,
}

impl Timer {
    /// A timer logged at info: whole jobs (a scan, a backup run).
    pub fn new(journey: &'static str, op: &'static str) -> Self {
        Self::with_level(journey, op, Level::Info)
    }

    /// A timer logged at debug: per-item work (one thumbnail).
    pub fn debug(journey: &'static str, op: &'static str) -> Self {
        Self::with_level(journey, op, Level::Debug)
    }

    fn with_level(journey: &'static str, op: &'static str, level: Level) -> Self {
        if !enabled() {
            return Self { inner: None };
        }
        let on = match level {
            Level::Info => tracing::enabled!(target: TARGET, tracing::Level::INFO),
            Level::Debug => tracing::enabled!(target: TARGET, tracing::Level::DEBUG),
        };
        if !on {
            return Self { inner: None };
        }
        let span = tracing::info_span!(target: TARGET, "perf", journey, op).entered();
        Self {
            inner: Some(TimerInner {
                start: Instant::now(),
                journey,
                op,
                level,
                fields: Vec::new(),
                _span: span,
            }),
        }
    }

    /// Whether this timer will log. Lets callers skip work that only feeds it.
    pub fn active(&self) -> bool {
        self.inner.is_some()
    }

    /// Attach a count or label to the final log line.
    pub fn field(&mut self, key: &'static str, value: impl std::fmt::Display) {
        if let Some(inner) = &mut self.inner {
            inner.fields.push((key, value.to_string()));
        }
    }

    /// Time since the timer started (zero when inactive).
    pub fn elapsed(&self) -> Duration {
        self.inner
            .as_ref()
            .map(|i| i.start.elapsed())
            .unwrap_or_default()
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        let ms = round1(inner.start.elapsed().as_secs_f64() * 1000.0);
        let detail = inner
            .fields
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ");
        let (journey, op) = (inner.journey, inner.op);
        match inner.level {
            Level::Info => {
                tracing::info!(target: TARGET, journey, op, ms, detail = %detail, "perf")
            }
            Level::Debug => {
                tracing::debug!(target: TARGET, journey, op, ms, detail = %detail, "perf")
            }
        }
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// Per-request timing. Logs method, matched route (never the raw path or
/// query: those carry share tokens, search text and file names), status and
/// time to response headers, and adds `Server-Timing: total;dur=…`. Body
/// streaming (downloads) is not included. Layer it last, outside the auth
/// guard, so the time includes auth.
pub async fn http_timing(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if !enabled() {
        return next.run(req).await;
    }
    let route = req
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|p| p.as_str().to_string());
    let method = req.method().clone();
    let start = Instant::now();
    let mut res = next.run(req).await;
    let elapsed = start.elapsed();
    let ms = elapsed.as_secs_f64() * 1000.0;
    if let Ok(v) = axum::http::HeaderValue::from_str(&format!("total;dur={ms:.1}")) {
        res.headers_mut().append("server-timing", v);
    }
    let route = route.as_deref().unwrap_or("static");
    tracing::info!(
        target: TARGET,
        journey = journey_for_route(method.as_str(), route),
        method = %method,
        route,
        status = res.status().as_u16(),
        ms = round1(ms),
        "perf"
    );
    res
}

/// The journey a route serves, or `-` when it maps to none. Server side only:
/// the web journeys also include network and rendering.
pub fn journey_for_route(method: &str, route: &str) -> &'static str {
    match (method, route) {
        ("POST", "/api/v1/auth/login") => "W3",
        ("GET", "/api/v1/drives/{id}/files") => "W4|W5",
        ("GET", "/api/v1/photos") => "W7",
        ("GET", "/api/v1/photos/thumb") => "W7|W8",
        ("GET", "/api/v1/photos/preview") => "W9",
        ("GET", "/api/v1/drives/{id}/files/content") => "W9|W14",
        ("GET", "/api/v1/search") => "W10|W11",
        (_, r) if r.starts_with("/api/v1/uploads") => "W13",
        (_, r) if r.starts_with("/s/{token}") => "W15",
        ("POST", "/api/v1/office/session") => "W12",
        _ => "-",
    }
}

// ---------------------------------------------------------------------------
// Resource sampling (D2, D2b, D3, M2)
// ---------------------------------------------------------------------------

/// One reading of this process's resources from `/proc`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Sample {
    pub rss_kib: u64,
    pub peak_rss_kib: u64,
    pub threads: u64,
    /// utime + stime, in clock ticks.
    pub cpu_ticks: u64,
    /// Voluntary context switches over every thread: each is a thread going
    /// to sleep, the closest `/proc` proxy for wakeups (D3).
    pub voluntary_switches: u64,
    pub mem_available_bytes: u64,
}

/// `VmRSS`, `VmHWM` and `Threads` from `/proc/<pid>/status`, in KiB.
pub fn parse_status(text: &str) -> (u64, u64, u64) {
    let mut rss = 0;
    let mut hwm = 0;
    let mut threads = 0;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(key), Some(val)) = (parts.next(), parts.next()) else {
            continue;
        };
        let val = val.parse::<u64>().unwrap_or(0);
        match key {
            "VmRSS:" => rss = val,
            "VmHWM:" => hwm = val,
            "Threads:" => threads = val,
            _ => {}
        }
    }
    (rss, hwm, threads)
}

/// utime + stime from `/proc/<pid>/stat` (fields 14 and 15). The command
/// name in field 2 may hold spaces, so fields are counted after its `)`.
pub fn parse_stat_cpu_ticks(text: &str) -> Option<u64> {
    let after = &text[text.rfind(')')? + 1..];
    let mut fields = after.split_whitespace();
    // After ')' the first field is the state (field 3); utime is field 14.
    let utime: u64 = fields.nth(11)?.parse().ok()?;
    let stime: u64 = fields.next()?.parse().ok()?;
    Some(utime + stime)
}

/// `voluntary_ctxt_switches` from one thread's `status`.
pub fn parse_voluntary_switches(text: &str) -> u64 {
    text.lines()
        .filter(|l| l.starts_with("voluntary_ctxt_switches:"))
        .filter_map(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        .sum()
}

/// Read the current process's resources. Missing files read as zero.
pub fn sample() -> Sample {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let (rss_kib, peak_rss_kib, threads) = parse_status(&status);
    let cpu_ticks = std::fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|t| parse_stat_cpu_ticks(&t))
        .unwrap_or(0);
    let voluntary_switches = std::fs::read_dir("/proc/self/task")
        .map(|dir| {
            dir.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path().join("status")).ok())
                .map(|t| parse_voluntary_switches(&t))
                .sum()
        })
        .unwrap_or(0);
    Sample {
        rss_kib,
        peak_rss_kib,
        threads,
        cpu_ticks,
        voluntary_switches,
        mem_available_bytes: crate::budget::meminfo().available_bytes,
    }
}

fn clock_ticks_per_sec() -> u64 {
    // SAFETY: sysconf has no preconditions.
    let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if v > 0 { v as u64 } else { 100 }
}

/// Sampling interval from `LUNA_PERF_SAMPLE_SECS` (default 30, at least 1).
pub fn sample_interval() -> Duration {
    let secs = std::env::var("LUNA_PERF_SAMPLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(30)
        .max(1);
    Duration::from_secs(secs)
}

/// Log one resource line every `interval` at `lunad::perf`. Only spawn this
/// when perf is enabled: the timer itself wakes the process (D3).
pub fn spawn_sampler(interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let hz = clock_ticks_per_sec();
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut prev: Option<(Instant, Sample)> = None;
        loop {
            ticker.tick().await;
            let now = Instant::now();
            let s = sample();
            let (cpu_pct, voluntary_switches_per_min) = match prev {
                Some((at, p)) => {
                    let secs = now.duration_since(at).as_secs_f64().max(0.001);
                    let cpu = s.cpu_ticks.saturating_sub(p.cpu_ticks) as f64 / hz as f64;
                    let ctx = s.voluntary_switches.saturating_sub(p.voluntary_switches) as f64;
                    (
                        format!("{:.2}", cpu / secs * 100.0),
                        format!("{:.1}", ctx / secs * 60.0),
                    )
                }
                None => ("-".to_string(), "-".to_string()),
            };
            tracing::info!(
                target: TARGET,
                journey = "D2|D2b|D3|M2",
                op = "resources",
                rss_mb = round1(s.rss_kib as f64 / 1024.0),
                peak_rss_mb = round1(s.peak_rss_kib as f64 / 1024.0),
                cpu_s = round1(s.cpu_ticks as f64 / hz as f64),
                cpu_pct = %cpu_pct,
                voluntary_switches_per_min = %voluntary_switches_per_min,
                threads = s.threads,
                mem_available_mb = s.mem_available_bytes / (1024 * 1024),
                "perf"
            );
            prev = Some((now, s));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_off() {
        let s = settings_from(None, None);
        assert!(!s.enabled);
        assert_eq!(s.directive.as_deref(), Some("lunad::perf=off"));
    }

    #[test]
    fn settings_env_switch_and_rust_log() {
        let s = settings_from(Some("1"), None);
        assert!(s.enabled);
        assert_eq!(s.directive.as_deref(), Some("lunad::perf=info"));
        let s = settings_from(Some("debug"), Some("lunad=info"));
        assert_eq!(s.directive.as_deref(), Some("lunad::perf=debug"));
        let s = settings_from(None, Some("lunad=info,lunad::perf=debug"));
        assert!(s.enabled);
        assert_eq!(s.directive, None);
        let s = settings_from(Some("1"), Some("lunad::perf=off"));
        assert!(!s.enabled);
    }

    #[test]
    fn parses_proc_files() {
        let status = "Name:\tlunad\nThreads:\t9\nVmHWM:\t  51200 kB\nVmRSS:\t  40960 kB\n\
                      voluntary_ctxt_switches:\t10\nnonvoluntary_ctxt_switches:\t2\n";
        assert_eq!(parse_status(status), (40960, 51200, 9));
        assert_eq!(parse_voluntary_switches(status), 10);
        let stat = "123 (lu na) S 1 123 123 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 9 0";
        assert_eq!(parse_stat_cpu_ticks(stat), Some(300));
    }
}
