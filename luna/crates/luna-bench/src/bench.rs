//! `luna-bench run`: time lunad's side of the journeys in `perf/budgets.json`.
//!
//! Every web journey (W*) here is server side only: request out, last body
//! byte in, over the network between this tool and lunad. The browser's
//! parsing and rendering are not in these numbers, so a web journey can only
//! be *over* budget here (the server alone uses it up), never proven within
//! it. D1 is a whole-journey number.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use serde_json::{Value, json};
use ureq::Agent;

use crate::args::Args;
use crate::stats;

const HELP: &str = "\
luna-bench run: measure lunad's side of the perf journeys

CONNECTION:
  --url URL              lunad base URL (default http://127.0.0.1:8090)
  --user NAME --password PW   sign in once (or set LUNA_BENCH_PASSWORD)
  --token TOKEN          a device token instead of signing in
  --drive ID|LABEL       drive holding the datasets (default: a drive whose
                         label contains \"perf\", else the first mounted drive)

WHAT TO RUN:
  --journeys LIST        comma list (default W4,W5,W7,W9,W10,W11,W13,W14,W15;
                         D1 runs only with --spawn)
  --iterations N         timed samples per journey (default 20)
  --warmup N             untimed requests first (default 2; 0 = include cold)
  --profile lan|remote   which budget column to compare with (default lan)

DATASET PATHS (on the drive):
  --small PATH           folder_small (default folder_small)
  --large PATH           folder_large (default folder_large)
  --search-name TEXT     W10 name query, typed one letter at a time (default report)
  --search-neural TEXT   W11 query (default \"receipts from the summer holiday\")
  --thumbs N             W7: thumbnails fetched after the timeline (default 24)
  --parallel N           W7: concurrent thumbnail requests, like a browser (default 6)

TRANSFERS (W13/W14):
  --transfer-iterations N   (default 3)
  --upload-mb N          size of each upload (default 64; the budget names 1 GB)
  --download-path PATH   file to download (default: the file W13 uploaded)
  --link-mbps N          link speed in Mbit/s, to compare with min_link_fraction
  --bench-folder PATH    where uploads go (default luna-perf-bench)

STARTUP (D1):
  --spawn CMD            start lunad with `sh -c \"exec CMD\"` (set variables with
                         `env VAR=1 lunad …`), time until /health answers,
                         stop it, repeat; the last one keeps serving the other journeys
  --spawn-iterations N   (default 3)

OUTPUT:
  --budgets FILE         (default luna/perf/budgets.json)
  --out FILE             (default luna/perf/results/bench-<unix time>.json)
";

const DEFAULT_JOURNEYS: &str = "W4,W5,W7,W9,W10,W11,W13,W14,W15";

pub fn main(raw: &[String]) -> anyhow::Result<()> {
    let a = Args::parse(
        raw,
        &[
            "url",
            "user",
            "password",
            "token",
            "drive",
            "journeys",
            "iterations",
            "warmup",
            "profile",
            "small",
            "large",
            "search-name",
            "search-neural",
            "thumbs",
            "parallel",
            "transfer-iterations",
            "upload-mb",
            "download-path",
            "link-mbps",
            "bench-folder",
            "spawn",
            "spawn-iterations",
            "budgets",
            "out",
        ],
    )?;
    if a.help() {
        print!("{HELP}");
        return Ok(());
    }
    let profile = a.str_or("profile", "lan").to_string();
    if profile != "lan" && profile != "remote" {
        bail!("--profile must be lan or remote");
    }
    let base = a
        .str_or("url", "http://127.0.0.1:8090")
        .trim_end_matches('/')
        .to_string();
    let budgets_path = a
        .str("budgets")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::perf_dir().join("budgets.json"));
    let budgets: Value = serde_json::from_str(
        &std::fs::read_to_string(&budgets_path)
            .with_context(|| format!("read {}", budgets_path.display()))?,
    )?;
    let mut journeys: Vec<String> = a
        .str_or("journeys", DEFAULT_JOURNEYS)
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .collect();
    if a.str("spawn").is_some() && !journeys.iter().any(|j| j == "D1") {
        journeys.insert(0, "D1".into());
    }

    let opts = Opts {
        iterations: a.num("iterations", 20usize)?.max(1),
        warmup: a.num("warmup", 2usize)?,
        small: a.str_or("small", "folder_small").to_string(),
        large: a.str_or("large", "folder_large").to_string(),
        search_name: a.str_or("search-name", "report").to_string(),
        search_neural: a
            .str_or("search-neural", "receipts from the summer holiday")
            .to_string(),
        thumbs: a.num("thumbs", 24usize)?,
        parallel: a.num("parallel", 6usize)?.max(1),
        transfer_iterations: a.num("transfer-iterations", 3usize)?.max(1),
        upload_bytes: a.num("upload-mb", 64u64)? * 1024 * 1024,
        download_path: a.str("download-path").map(str::to_string),
        link_mbps: a.str("link-mbps").map(|v| v.parse::<f64>()).transpose()?,
        bench_folder: a.str_or("bench-folder", "luna-perf-bench").to_string(),
    };

    let mut results: BTreeMap<String, Value> = BTreeMap::new();
    let mut spawned: Option<Child> = None;
    if journeys.iter().any(|j| j == "D1") {
        let Some(cmd) = a.str("spawn") else {
            bail!("D1 needs --spawn CMD (lunad must be started by the tool to time its start)");
        };
        let (value, child) = d1(&base, cmd, a.num("spawn-iterations", 3usize)?.max(1))?;
        results.insert("D1".into(), value);
        spawned = Some(child);
    }

    let outcome = (|| -> anyhow::Result<()> {
        let web: Vec<&String> = journeys.iter().filter(|j| *j != "D1").collect();
        if web.is_empty() {
            return Ok(());
        }
        let client = Client::connect(&base, &a)?;
        let drive = client.pick_drive(a.str("drive"))?;
        eprintln!("drive: {drive}");
        let mut ctx = Ctx {
            client,
            drive,
            opts: &opts,
            uploaded: None,
        };
        for j in web {
            eprintln!("{j} …");
            let value = match j.as_str() {
                "W4" => ctx.list_folder(&ctx.opts.small.clone()),
                "W5" => ctx.list_folder(&ctx.opts.large.clone()),
                "W7" => ctx.w7(),
                "W9" => ctx.w9(),
                "W10" => ctx.w10(),
                "W11" => ctx.w11(),
                "W13" => ctx.w13(),
                "W14" => ctx.w14(),
                "W15" => ctx.w15(),
                other => Err(anyhow::anyhow!("journey {other} has no lunad-side bench")),
            };
            let value = value.unwrap_or_else(|e| json!({ "error": format!("{e:#}") }));
            results.insert(j.clone(), value);
        }
        Ok(())
    })();
    if let Some(mut child) = spawned {
        let _ = child.kill();
        let _ = child.wait();
    }
    outcome?;

    // Compare with budgets.
    for (id, value) in results.iter_mut() {
        let budget = &budgets["journeys"][id];
        annotate(id, value, budget, &profile, opts.link_mbps);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let report = json!({
        "tool": "luna-bench",
        "format": 1,
        "started_at_unix": now,
        "base_url": base,
        "profile": profile,
        "iterations": opts.iterations,
        "warmup": opts.warmup,
        "scope": "W* journeys are server side only (request to last byte); browser work is not included. D1 is the whole journey.",
        "journeys": results,
    });
    let out = a.str("out").map(PathBuf::from).unwrap_or_else(|| {
        crate::perf_dir()
            .join("results")
            .join(format!("bench-{now}.json"))
    });
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)? + "\n")?;
    print_table(&report);
    println!("results: {}", out.display());
    Ok(())
}

struct Opts {
    iterations: usize,
    warmup: usize,
    small: String,
    large: String,
    search_name: String,
    search_neural: String,
    thumbs: usize,
    parallel: usize,
    transfer_iterations: usize,
    upload_bytes: u64,
    download_path: Option<String>,
    link_mbps: Option<f64>,
    bench_folder: String,
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/// One timed request: wall time to the last body byte, plus lunad's own
/// `Server-Timing` total when perf logging is on there.
struct Timed {
    ms: f64,
    status: u16,
    server_ms: Option<f64>,
    bytes: u64,
    body: Vec<u8>,
}

impl Timed {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    fn json(&self) -> anyhow::Result<Value> {
        serde_json::from_slice(&self.body).context("response was not JSON")
    }

    fn error_text(&self) -> String {
        let body = String::from_utf8_lossy(&self.body[..self.body.len().min(200)]).into_owned();
        format!("HTTP {}: {body}", self.status)
    }
}

#[derive(Clone)]
struct Client {
    agent: Agent,
    base: String,
    auth: Option<String>,
}

/// Bodies kept in memory up to this size; larger ones are counted and dropped.
const KEEP_BODY: usize = 16 << 20;

impl Client {
    fn agent() -> Agent {
        let config = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(600)))
            .max_redirects(0)
            .build();
        Agent::new_with_config(config)
    }

    fn connect(base: &str, a: &Args) -> anyhow::Result<Self> {
        let mut c = Self {
            agent: Self::agent(),
            base: base.to_string(),
            auth: None,
        };
        if let Some(token) = a.str("token") {
            c.auth = Some(format!("Bearer {token}"));
            return Ok(c);
        }
        let user = a
            .str("user")
            .context("pass --user and --password, or --token")?;
        let password = a
            .str("password")
            .map(str::to_string)
            .or_else(|| std::env::var("LUNA_BENCH_PASSWORD").ok())
            .context("pass --password or set LUNA_BENCH_PASSWORD")?;
        // Sign in once: lunad allows 10 attempts per 5 minutes. The session
        // JWT also works as a bearer token, which needs no CSRF header.
        let mut res = c
            .agent
            .post(format!("{base}/api/v1/auth/login"))
            .send_json(json!({ "username": user, "password": password }))?;
        if !res.status().is_success() {
            let body = res.body_mut().read_to_string().unwrap_or_default();
            bail!("sign-in failed: HTTP {} {body}", res.status());
        }
        let session = res
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find_map(|v| v.strip_prefix("luna_session="))
            .and_then(|v| v.split(';').next())
            .filter(|v| !v.is_empty())
            .context("sign-in returned no session cookie")?
            .to_string();
        c.auth = Some(format!("Bearer {session}"));
        Ok(c)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// Send and read the whole body. `auth` false sends no credentials (a guest).
    fn exec(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
        auth: bool,
    ) -> anyhow::Result<Timed> {
        let url = self.url(path);
        let start = Instant::now();
        let res = match (method, body) {
            ("GET", _) => {
                let mut r = self.agent.get(&url);
                for (k, v) in query {
                    r = r.query(*k, *v);
                }
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                if auth && let Some(h) = &self.auth {
                    r = r.header("authorization", h);
                }
                r.call()
            }
            ("DELETE", _) => {
                let mut r = self.agent.delete(&url);
                for (k, v) in query {
                    r = r.query(*k, *v);
                }
                if auth && let Some(h) = &self.auth {
                    r = r.header("authorization", h);
                }
                r.call()
            }
            (m, b) => {
                let mut r = match m {
                    "POST" => self.agent.post(&url),
                    "PUT" => self.agent.put(&url),
                    "PATCH" => self.agent.patch(&url),
                    _ => bail!("method {m}"),
                };
                for (k, v) in query {
                    r = r.query(*k, *v);
                }
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                if auth && let Some(h) = &self.auth {
                    r = r.header("authorization", h);
                }
                r.send(b.unwrap_or(&[]))
            }
        }
        .with_context(|| format!("{method} {path}"))?;
        let status = res.status().as_u16();
        let server_ms = res
            .headers()
            .get("server-timing")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_server_timing);
        let mut reader = res.into_body().into_reader();
        let mut kept = Vec::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut bytes = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if kept.len() < KEEP_BODY {
                kept.extend_from_slice(&buf[..n]);
            }
        }
        Ok(Timed {
            ms: start.elapsed().as_secs_f64() * 1000.0,
            status,
            server_ms,
            bytes,
            body: kept,
        })
    }

    fn get(&self, path: &str, query: &[(&str, &str)]) -> anyhow::Result<Timed> {
        self.exec("GET", path, query, &[], None, true)
    }

    fn post_json(&self, path: &str, body: &Value) -> anyhow::Result<Timed> {
        let bytes = serde_json::to_vec(body)?;
        self.exec(
            "POST",
            path,
            &[],
            &[("content-type", "application/json")],
            Some(&bytes),
            true,
        )
    }

    fn pick_drive(&self, want: Option<&str>) -> anyhow::Result<String> {
        let res = self.get("/api/v1/drives", &[])?;
        if !res.ok() {
            bail!("listing drives: {}", res.error_text());
        }
        let drives = res.json()?;
        let drives = drives.as_array().context("drive list")?;
        let usable = |d: &&Value| d["mounted"].as_bool().unwrap_or(false);
        let found = match want {
            Some(w) => drives
                .iter()
                .find(|d| d["id"].as_str() == Some(w) || d["label"].as_str() == Some(w)),
            None => drives
                .iter()
                .filter(usable)
                .find(|d| {
                    d["label"]
                        .as_str()
                        .is_some_and(|l| l.to_ascii_lowercase().contains("perf"))
                })
                .or_else(|| drives.iter().find(usable)),
        };
        found
            .and_then(|d| d["id"].as_str())
            .map(str::to_string)
            .context("no matching mounted drive (adopt the luna-perf drive first, or pass --drive)")
    }
}

/// `total;dur=12.3` (lunad's perf middleware) → 12.3.
fn parse_server_timing(v: &str) -> Option<f64> {
    v.split(',').find_map(|metric| {
        let mut parts = metric.split(';').map(str::trim);
        (parts.next()? == "total")
            .then(|| parts.find_map(|p| p.strip_prefix("dur=")?.parse().ok()))
            .flatten()
    })
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Samples {
    ms: Vec<f64>,
    server_ms: Vec<f64>,
    errors: usize,
    first_error: Option<String>,
}

impl Samples {
    fn push(&mut self, t: &Timed) {
        if t.ok() {
            self.ms.push(t.ms);
            if let Some(s) = t.server_ms {
                self.server_ms.push(s);
            }
        } else {
            self.error(t.error_text());
        }
    }

    fn error(&mut self, e: String) {
        self.errors += 1;
        self.first_error.get_or_insert(e);
    }

    fn to_json(&self) -> Value {
        json!({
            "samples_ms": self.ms.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>(),
            "ms": stats::summary(&self.ms),
            "server_ms": if self.server_ms.is_empty() { Value::Null } else { stats::summary(&self.server_ms) },
            "errors": self.errors,
            "first_error": self.first_error,
        })
    }
}

struct Ctx<'a> {
    client: Client,
    drive: String,
    opts: &'a Opts,
    /// Path of the file W13 uploaded, for W14.
    uploaded: Option<String>,
}

impl Ctx<'_> {
    /// Run `f` for warmup then timed rounds; `f(i)` gets the round number.
    fn rounds(&self, mut f: impl FnMut(usize) -> anyhow::Result<Timed>) -> Samples {
        let mut s = Samples::default();
        for i in 0..self.opts.warmup {
            let _ = f(i);
        }
        for i in 0..self.opts.iterations {
            match f(self.opts.warmup + i) {
                Ok(t) => s.push(&t),
                Err(e) => s.error(format!("{e:#}")),
            }
        }
        s
    }

    fn files_path(&self) -> String {
        format!("/api/v1/drives/{}/files", self.drive)
    }

    /// W4 / W5: list one folder.
    fn list_folder(&self, path: &str) -> anyhow::Result<Value> {
        let probe = self.client.get(&self.files_path(), &[("path", path)])?;
        if !probe.ok() {
            bail!("listing {path}: {}", probe.error_text());
        }
        let items = probe.json()?.as_array().map_or(0, Vec::len);
        let s = self.rounds(|_| self.client.get(&self.files_path(), &[("path", path)]));
        let mut v = s.to_json();
        v["items"] = json!(items);
        v["request"] = json!("GET /api/v1/drives/{id}/files");
        Ok(v)
    }

    /// Photos from the timeline, for W7 and W9.
    fn timeline(&self, limit: usize) -> anyhow::Result<Vec<(String, String)>> {
        let t = self
            .client
            .get("/api/v1/photos", &[("limit", &limit.to_string())])?;
        if !t.ok() {
            bail!("photo timeline: {}", t.error_text());
        }
        let v = t.json()?;
        Ok(v["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|p| {
                        Some((
                            p["drive_id"].as_str()?.to_string(),
                            p["path"].as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// W7: the timeline's first page, then the first screen of thumbnails
    /// fetched `parallel` at a time like a browser. Thumbnails are cached in
    /// RAM after the first round, so only a 0-warmup first sample is cold.
    fn w7(&self) -> anyhow::Result<Value> {
        let limit = 100usize;
        let first = self.timeline(limit)?;
        if first.is_empty() {
            bail!("the photo timeline is empty (is the photos dataset indexed?)");
        }
        let mut timeline = Samples::default();
        let mut thumbs = Samples::default();
        let mut screen = Samples::default();
        for round in 0..self.opts.warmup + self.opts.iterations {
            let timed = round >= self.opts.warmup;
            let start = Instant::now();
            let t = self
                .client
                .get("/api/v1/photos", &[("limit", &limit.to_string())])?;
            let items: Vec<(String, String)> = t
                .json()
                .ok()
                .and_then(|v| {
                    v["items"].as_array().map(|a| {
                        a.iter()
                            .filter_map(|p| {
                                Some((
                                    p["drive_id"].as_str()?.to_string(),
                                    p["path"].as_str()?.to_string(),
                                ))
                            })
                            .take(self.opts.thumbs)
                            .collect()
                    })
                })
                .unwrap_or_default();
            let thumb_results = self.parallel_thumbs(&items);
            let total = start.elapsed().as_secs_f64() * 1000.0;
            if !timed {
                continue;
            }
            timeline.push(&t);
            let mut all_ok = t.ok();
            for r in thumb_results {
                match r {
                    Ok(t) => {
                        all_ok &= t.ok();
                        thumbs.push(&t);
                    }
                    Err(e) => {
                        all_ok = false;
                        thumbs.error(format!("{e:#}"));
                    }
                }
            }
            if all_ok {
                screen.ms.push(total);
            } else {
                screen.error("a request in this round failed".into());
            }
        }
        let mut v = screen.to_json();
        v["request"] = json!(format!(
            "GET /api/v1/photos?limit={limit}, then {} thumbnails {} at a time",
            self.opts.thumbs, self.opts.parallel
        ));
        v["parts"] = json!({ "timeline": timeline.to_json(), "thumb": thumbs.to_json() });
        Ok(v)
    }

    fn parallel_thumbs(&self, items: &[(String, String)]) -> Vec<anyhow::Result<Timed>> {
        let chunk = items.len().div_ceil(self.opts.parallel).max(1);
        std::thread::scope(|scope| {
            let handles: Vec<_> = items
                .chunks(chunk)
                .map(|part| {
                    let client = self.client.clone();
                    scope.spawn(move || {
                        part.iter()
                            .map(|(d, p)| {
                                client.get("/api/v1/photos/thumb", &[("drive_id", d), ("path", p)])
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        })
    }

    /// W9: open a photo: the preview, then the original. Each round opens a
    /// different photo so the RAM cache doesn't answer every request.
    fn w9(&self) -> anyhow::Result<Value> {
        let photos = self.timeline(200)?;
        if photos.is_empty() {
            bail!("the photo timeline is empty");
        }
        let pick = |i: usize| &photos[i % photos.len()];
        let preview = self.rounds(|i| {
            let (d, p) = pick(i);
            self.client
                .get("/api/v1/photos/preview", &[("drive_id", d), ("path", p)])
        });
        let full = self.rounds(|i| {
            let (d, p) = pick(i);
            self.client
                .get(&format!("/api/v1/drives/{d}/files/content"), &[("path", p)])
        });
        let mut v = preview.to_json();
        v["request"] =
            json!("GET /api/v1/photos/preview (full: GET /api/v1/drives/{id}/files/content)");
        v["full"] = full.to_json();
        Ok(v)
    }

    /// W10: name search as typed: each round sends one more letter of the
    /// query (from 2 letters, lunad's minimum), cycling.
    fn w10(&self) -> anyhow::Result<Value> {
        let q: Vec<char> = self.opts.search_name.chars().collect();
        if q.len() < 2 {
            bail!("--search-name needs at least 2 letters");
        }
        let prefixes: Vec<String> = (2..=q.len()).map(|n| q[..n].iter().collect()).collect();
        let s = self.rounds(|i| {
            let p = &prefixes[i % prefixes.len()];
            self.client
                .get("/api/v1/search", &[("q", p), ("quick", "1")])
        });
        let mut v = s.to_json();
        v["request"] = json!("GET /api/v1/search?q=<prefix>&quick=1");
        v["note"] = json!(
            "While typing the web asks without the neural passes (quick=1); W11 times the full search."
        );
        Ok(v)
    }

    /// W11: a question-like query that only the meaning (neural) pass can match.
    fn w11(&self) -> anyhow::Result<Value> {
        let q = self.opts.search_neural.clone();
        let s = self.rounds(|_| self.client.get("/api/v1/search", &[("q", &q)]));
        let mut v = s.to_json();
        v["request"] = json!("GET /api/v1/search?q=<phrase>");
        v["note"] = json!(
            "Same endpoint as W10. Without the meaning model pack this times name search only; LUNA_PERF=debug on lunad splits out the neural pass (op=search.meaning)."
        );
        Ok(v)
    }

    /// W13: upload `upload_bytes` through lunad's chunked upload API.
    fn w13(&mut self) -> anyhow::Result<Value> {
        let folder = self.opts.bench_folder.clone();
        // Already there is fine.
        let _ = self.client.post_json(
            &format!("{}/mkdir", self.files_path()),
            &json!({ "path": folder }),
        )?;
        let size = self.opts.upload_bytes;
        let chunk = 8u64 << 20; // the web client's chunk size
        let mut data = vec![0u8; chunk as usize];
        let mut rng = crate::generate::Rng::new(7);
        for c in data.chunks_mut(8) {
            let r = rng.next_u64().to_le_bytes();
            c.copy_from_slice(&r[..c.len()]);
        }
        let name = "upload-bench.bin";
        let mut mbps = Vec::new();
        let mut s = Samples::default();
        for _ in 0..self.opts.transfer_iterations {
            let start = Instant::now();
            match self.upload_once(&folder, name, size, &data) {
                Ok(()) => {
                    let secs = start.elapsed().as_secs_f64();
                    s.ms.push(secs * 1000.0);
                    mbps.push(size as f64 * 8.0 / 1e6 / secs);
                }
                Err(e) => s.error(format!("{e:#}")),
            }
        }
        self.uploaded = Some(format!("{folder}/{name}"));
        let mut v = s.to_json();
        v["request"] = json!("POST /api/v1/uploads, PUT 8 MiB chunks, POST complete");
        v["bytes"] = json!(size);
        v["mbit_s"] = stats::summary(&mbps);
        Ok(v)
    }

    fn upload_once(&self, folder: &str, name: &str, size: u64, chunk: &[u8]) -> anyhow::Result<()> {
        let created = self.client.post_json(
            "/api/v1/uploads",
            &json!({
                "drive_id": self.drive,
                "path": folder,
                "name": name,
                "size": size,
                "on_conflict": "overwrite",
            }),
        )?;
        if !created.ok() {
            bail!("start upload: {}", created.error_text());
        }
        let id = created.json()?["upload_id"]
            .as_str()
            .context("upload_id")?
            .to_string();
        let mut sent = 0u64;
        while sent < size {
            let n = (chunk.len() as u64).min(size - sent);
            let range = format!("bytes {}-{}/{}", sent, sent + n - 1, size);
            let r = self.client.exec(
                "PUT",
                &format!("/api/v1/uploads/{id}"),
                &[],
                &[
                    ("content-range", &range),
                    ("content-type", "application/octet-stream"),
                ],
                Some(&chunk[..n as usize]),
                true,
            )?;
            if !r.ok() {
                bail!("chunk at {sent}: {}", r.error_text());
            }
            sent += n;
        }
        let done = self.client.exec(
            "POST",
            &format!("/api/v1/uploads/{id}/complete"),
            &[("overwrite", "1")],
            &[],
            None,
            true,
        )?;
        if !done.ok() {
            bail!("complete upload: {}", done.error_text());
        }
        Ok(())
    }

    /// W14: download one large file.
    fn w14(&self) -> anyhow::Result<Value> {
        let path = self
            .opts
            .download_path
            .clone()
            .or_else(|| self.uploaded.clone())
            .context("W14 needs --download-path, or W13 in the same run")?;
        let mut s = Samples::default();
        let mut mbps = Vec::new();
        let mut bytes = 0;
        for _ in 0..self.opts.transfer_iterations {
            match self.client.get(
                &format!("{}/content", self.files_path()),
                &[("path", &path), ("download", "1")],
            ) {
                Ok(t) if t.ok() => {
                    bytes = t.bytes;
                    mbps.push(t.bytes as f64 * 8.0 / 1e6 / (t.ms / 1000.0));
                    s.push(&t);
                }
                Ok(t) => s.push(&t),
                Err(e) => s.error(format!("{e:#}")),
            }
        }
        let mut v = s.to_json();
        v["request"] = json!("GET /api/v1/drives/{id}/files/content?download=1");
        v["bytes"] = json!(bytes);
        v["mbit_s"] = stats::summary(&mbps);
        Ok(v)
    }

    /// W15: a guest opens a share link: the link's metadata, then its list.
    /// One link is made for the run (lunad allows 5 new links a minute) and
    /// removed after.
    fn w15(&self) -> anyhow::Result<Value> {
        let made = self.client.post_json(
            "/api/v1/access/links",
            &json!({
                "kind": "path",
                "drive_id": self.drive,
                "path": self.opts.small,
                "caps": "view",
            }),
        )?;
        if !made.ok() {
            bail!("making a share link: {}", made.error_text());
        }
        let link = made.json()?;
        let token = link["token"].as_str().context("link token")?.to_string();
        let id = link["id"].as_str().unwrap_or_default().to_string();
        let guest = |path: &str, query: &[(&str, &str)]| {
            self.client.exec(
                "GET",
                path,
                query,
                &[("accept", "application/json")],
                None,
                false,
            )
        };
        let mut open = Samples::default();
        let mut parts_meta = Samples::default();
        let mut parts_list = Samples::default();
        for round in 0..self.opts.warmup + self.opts.iterations {
            let start = Instant::now();
            let meta = guest(&format!("/s/{token}"), &[("meta", "1")]);
            let list = guest(&format!("/s/{token}/list"), &[]);
            let total = start.elapsed().as_secs_f64() * 1000.0;
            if round < self.opts.warmup {
                continue;
            }
            match (&meta, &list) {
                (Ok(m), Ok(l)) if m.ok() && l.ok() => {
                    open.ms.push(total);
                    parts_meta.push(m);
                    parts_list.push(l);
                }
                (Ok(m), Ok(l)) => {
                    let bad = if m.ok() { l } else { m };
                    open.error(bad.error_text());
                }
                (Err(e), _) | (_, Err(e)) => open.error(format!("{e:#}")),
            }
        }
        if !id.is_empty() {
            let _ = self.client.exec(
                "DELETE",
                &format!("/api/v1/access/links/{id}"),
                &[],
                &[],
                None,
                true,
            );
        }
        let mut v = open.to_json();
        v["request"] = json!("guest GET /s/{token}?meta=1, then /s/{token}/list");
        v["parts"] = json!({ "meta": parts_meta.to_json(), "list": parts_list.to_json() });
        Ok(v)
    }
}

// ---------------------------------------------------------------------------
// D1: process start to answering requests
// ---------------------------------------------------------------------------

fn d1(base: &str, cmd: &str, iterations: usize) -> anyhow::Result<(Value, Child)> {
    let agent = Agent::new_with_config(
        Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_millis(500)))
            .build(),
    );
    let health = format!("{base}/health");
    if agent.get(&health).call().is_ok() {
        bail!("something already answers {health}; stop it before timing D1");
    }
    let mut s = Samples::default();
    let mut last = None;
    for i in 0..iterations {
        // `exec` so the child pid is lunad itself, not a shell around it:
        // SIGTERM must reach lunad.
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!("exec {cmd}"))
            .spawn()
            .with_context(|| format!("start {cmd:?}"))?;
        let start = Instant::now();
        let mut up = false;
        while start.elapsed() < Duration::from_secs(120) {
            // Check the child first: an answer after it exited came from
            // some other process on the port.
            if let Ok(Some(status)) = child.try_wait() {
                bail!("lunad exited before answering: {status}");
            }
            if let Ok(res) = agent.get(&health).call()
                && res.status().is_success()
            {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        if up {
            s.ms.push(ms);
        } else {
            s.error("no answer from /health within 120 s".into());
        }
        if i + 1 < iterations {
            stop(&mut child);
            // Let the port free up before the next start.
            let wait = Instant::now();
            while agent.get(&health).call().is_ok() {
                if wait.elapsed() > Duration::from_secs(10) {
                    bail!(
                        "{health} still answers after stopping lunad; the next start would be timed against it"
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        } else {
            last = Some(child);
        }
    }
    let mut v = s.to_json();
    v["request"] = json!("spawn, then poll GET /health every 20 ms");
    v["note"] = json!(
        "Includes the up-to-8 s wait for USB drives on a freshly booted box; lunad's own D1 log line (LUNA_PERF=1) splits it out as usb_wait_ms."
    );
    Ok((v, last.context("no lunad left running")?))
}

/// SIGTERM (graceful, like the service manager), then kill after 10 s.
fn stop(child: &mut Child) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/// Add `budget` and `verdict` to one journey's result.
fn annotate(id: &str, v: &mut Value, budget: &Value, profile: &str, link_mbps: Option<f64>) {
    if v.get("error").is_some() || budget.is_null() {
        return;
    }
    v["name"] = budget["name"].clone();
    let p95 = v["ms"]["p95"].as_f64();
    let web = id.starts_with('W');
    // Time budgets.
    let key = if profile == "remote" && budget.get("remote_ms").is_some() {
        "remote_ms"
    } else if budget.get("lan_ms").is_some() {
        "lan_ms"
    } else {
        "ms"
    };
    if let (Some(limit), Some(p95)) = (budget[key].as_f64(), p95) {
        let share = p95 / limit;
        v["budget"] = json!({ key: limit, "p95_share": (share * 100.0).round() / 100.0 });
        v["verdict"] = json!(match (web, share > 1.0) {
            (_, true) => "over budget",
            (true, false) => "server side within budget (browser time not measured here)",
            (false, false) => "within budget",
        });
    }
    // W9's original-quality budget.
    if let (Some(limit), Some(p95)) = (budget["full_ms"].as_f64(), v["full"]["ms"]["p95"].as_f64())
    {
        v["full"]["budget"] =
            json!({ "full_ms": limit, "p95_share": ((p95 / limit) * 100.0).round() / 100.0 });
        v["full"]["verdict"] = json!(if p95 > limit {
            "over budget"
        } else {
            "server side within budget (browser time not measured here)"
        });
    }
    // Throughput budgets (W13, W14): fraction of the link.
    let fraction_key = if profile == "remote" && budget.get("remote_min_link_fraction").is_some() {
        "remote_min_link_fraction"
    } else {
        "min_link_fraction"
    };
    if let Some(min) = budget[fraction_key].as_f64() {
        // p50 throughput is the steady rate; the slowest run is in "min".
        match (link_mbps, v["mbit_s"]["p50"].as_f64()) {
            (Some(link), Some(rate)) => {
                let frac = rate / link;
                v["budget"] = json!({ fraction_key: min, "link_mbit_s": link, "fraction": (frac * 100.0).round() / 100.0 });
                v["verdict"] = json!(if frac >= min {
                    "within budget"
                } else {
                    "under the link-speed goal"
                });
            }
            _ => {
                v["budget"] = json!({ fraction_key: min });
                v["verdict"] = json!("pass --link-mbps to compare with the link speed");
            }
        }
    }
}

fn print_table(report: &Value) {
    println!(
        "{:<5} {:>9} {:>9} {:>10}  verdict",
        "id", "p50 ms", "p95 ms", "server p95"
    );
    if let Some(map) = report["journeys"].as_object() {
        for (id, v) in map {
            if let Some(e) = v["error"].as_str() {
                println!("{id:<5} error: {e}");
                continue;
            }
            let f = |x: &Value| x.as_f64().map_or("-".to_string(), |n| format!("{n:.1}"));
            println!(
                "{:<5} {:>9} {:>9} {:>10}  {}",
                id,
                f(&v["ms"]["p50"]),
                f(&v["ms"]["p95"]),
                f(&v["server_ms"]["p95"]),
                v["verdict"].as_str().unwrap_or("")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_server_timing() {
        assert_eq!(parse_server_timing("total;dur=12.5"), Some(12.5));
        assert_eq!(parse_server_timing("db;dur=3, total;dur=7"), Some(7.0));
        assert_eq!(parse_server_timing("cache;desc=hit"), None);
    }

    #[test]
    fn web_journeys_are_never_called_within_on_server_time_alone() {
        let budget = json!({ "name": "x", "lan_ms": 100, "remote_ms": 300 });
        let mut v = json!({ "ms": { "p95": 50.0 } });
        annotate("W4", &mut v, &budget, "lan", None);
        assert!(
            v["verdict"]
                .as_str()
                .unwrap()
                .starts_with("server side within")
        );
        let mut v = json!({ "ms": { "p95": 150.0 } });
        annotate("W4", &mut v, &budget, "lan", None);
        assert_eq!(v["verdict"], "over budget");
        let mut v = json!({ "ms": { "p95": 150.0 } });
        annotate("W4", &mut v, &budget, "remote", None);
        assert_eq!(v["budget"]["remote_ms"], 300.0);
    }
}
