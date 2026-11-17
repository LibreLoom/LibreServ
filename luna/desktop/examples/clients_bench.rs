//! Headless Luna Desktop engine bench (journeys K3, K4, K5 in luna/perf/budgets.json).
//!
//! Drives the real sync and backup engines against a running lunad, without GTK.
//! Driver script and recipe: luna/perf/clients/desktop.sh, luna/perf/README.md.
//!
//! ```text
//! clients_bench sync   <base_url> <token> <drive_id> <remote_path> <local_parent> [idle_passes] [edits]
//! clients_bench backup <base_url> <token> <drive_id> <remote_path> <local_dir>
//! ```
//! Set LUNA_DESKTOP_DATA to a scratch dir: ledgers and job files land there.
//! Prints one JSON object per line.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use luna_desktop::{backup, luna, sync};

/// utime + stime of this whole process, in ms (100 Hz ticks).
fn cpu_ms() -> u64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let after = s.rsplit_once(')').map(|(_, r)| r).unwrap_or("");
    let f: Vec<&str> = after.split_whitespace().collect();
    let ticks: u64 = f.get(11).and_then(|v| v.parse().ok()).unwrap_or(0)
        + f.get(12).and_then(|v| v.parse().ok()).unwrap_or(0);
    ticks * 10
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("VmRSS:"))
        .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        .unwrap_or(0)
}

type SyncMap = Arc<Mutex<HashMap<String, sync::SyncProgress>>>;

fn phase(p: &SyncMap) -> String {
    p.lock()
        .unwrap()
        .get("bench")
        .map(|s| s.phase.clone())
        .unwrap_or_default()
}

fn wait_phase(p: &SyncMap, want: &str, limit: Duration) -> Option<Duration> {
    let t = Instant::now();
    while t.elapsed() < limit {
        if phase(p) == want {
            return Some(t.elapsed());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

fn full_passes(p: &SyncMap) -> u64 {
    p.lock()
        .unwrap()
        .get("bench")
        .map(|s| s.full_passes)
        .unwrap_or(0)
}

/// Wait until the engine finishes a full pass after the `seen`-th.
fn wait_full_pass(p: &SyncMap, seen: u64, limit: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < limit {
        if full_passes(p) > seen {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

fn remote_size(base: &str, tok: &str, drive: &str, remote: &str, rel: &str) -> Option<u64> {
    let full = format!("{remote}/{rel}");
    let (dir, name) = full.rsplit_once('/')?;
    luna::list_files(base, tok, drive, dir)
        .ok()?
        .into_iter()
        .find(|e| e.name == name)
        .map(|e| e.size)
}

/// Append to `path` and wait until Luna reports the new size.
fn edit_and_wait(args: &[String], local: &Path, rel: &str, limit: Duration) -> Option<Duration> {
    let path = local.join(rel);
    let mut f = std::fs::OpenOptions::new().append(true).open(&path).ok()?;
    f.write_all(b"edited by clients_bench\n").ok()?;
    drop(f);
    let want = std::fs::metadata(&path).ok()?.len();
    let t = Instant::now();
    while t.elapsed() < limit {
        if remote_size(&args[2], &args[3], &args[4], &args[5], rel) == Some(want) {
            return Some(t.elapsed());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

fn pick_files(root: &Path, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if std::fs::metadata(&p).is_ok_and(|m| m.len() < 64 * 1024) {
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
                if out.len() >= n {
                    return out;
                }
            }
        }
    }
    out
}

fn ms(d: Option<Duration>) -> serde_json::Value {
    d.map(|d| serde_json::json!(d.as_millis() as u64))
        .unwrap_or(serde_json::Value::Null)
}

fn run_sync(args: &[String]) {
    let idle_passes: usize = args.get(7).and_then(|v| v.parse().ok()).unwrap_or(2);
    let edits: usize = args.get(8).and_then(|v| v.parse().ok()).unwrap_or(5);
    let remote = args[5].clone();
    let name = remote.rsplit('/').next().unwrap_or("sync").to_string();
    let local = PathBuf::from(&args[6]).join(&name);
    let pair = sync::SyncPair {
        id: "bench".into(),
        drive_id: args[4].clone(),
        remote_path: remote,
        local_parent: args[6].clone(),
        local_path: local.to_string_lossy().into_owned(),
        running: true,
    };
    let progress: SyncMap = Arc::new(Mutex::new(HashMap::new()));
    let t0 = Instant::now();
    let c0 = cpu_ms();
    let handle =
        sync::start_pair(args[2].clone(), args[3].clone(), pair, progress.clone()).expect("start");
    // First pass: from start to the first full pass done (startup to synced state).
    let first = wait_full_pass(&progress, 0, Duration::from_secs(3600)).then(|| t0.elapsed());
    println!(
        "{}",
        serde_json::json!({"journey":"K-first-pass","wall_ms":ms(first),"cpu_ms":cpu_ms()-c0,
            "rss_kb":rss_kb(),"error":progress.lock().unwrap().get("bench").map(|p|p.error.clone())})
    );
    // K3: one whole idle cycle per sample, from the end of one full pass to
    // the end of the next (30 s of waiting plus a pass that finds nothing).
    for i in 0..idle_passes {
        let n = full_passes(&progress);
        let c = cpu_ms();
        let t = Instant::now();
        let done = wait_full_pass(&progress, n, Duration::from_secs(180));
        println!(
            "{}",
            serde_json::json!({"journey":"K3","pass":i,"cycle_ms":ms(done.then(|| t.elapsed())),
                "cpu_ms":cpu_ms()-c,"rss_kb":rss_kb()})
        );
    }
    let files = pick_files(&local, edits * 2);
    // K4 idle: edit while the engine waits.
    for rel in files.iter().take(edits) {
        wait_phase(&progress, "Waiting", Duration::from_secs(600));
        std::thread::sleep(Duration::from_millis(300));
        let c = cpu_ms();
        let d = edit_and_wait(args, &local, rel, Duration::from_secs(120));
        println!(
            "{}",
            serde_json::json!({"journey":"K4","when":"idle","ms":ms(d),"cpu_ms":cpu_ms()-c})
        );
    }
    // K4 mid-pass: edit while a full pass walks both sides. The next full
    // pass starts 30 s after the last one ended.
    for rel in files.iter().skip(edits) {
        let n = full_passes(&progress);
        if !wait_full_pass(&progress, n, Duration::from_secs(180)) {
            continue;
        }
        std::thread::sleep(Duration::from_millis(30_500));
        let d = edit_and_wait(args, &local, rel, Duration::from_secs(120));
        println!(
            "{}",
            serde_json::json!({"journey":"K4","when":"mid-pass","ms":ms(d)})
        );
    }
    handle.stop();
}

fn run_backup(args: &[String]) {
    let job = backup::BackupJob {
        id: "bench".into(),
        name: "bench".into(),
        sources: vec![args[6].clone()],
        drive_id: args[4].clone(),
        remote_path: args[5].clone(),
        running: true,
    };
    let bytes_total: u64 = walk_bytes(Path::new(&args[6]));
    let progress = Arc::new(Mutex::new(HashMap::new()));
    let c0 = cpu_ms();
    let t0 = Instant::now();
    let handle =
        backup::start_job(args[2].clone(), args[3].clone(), job, progress.clone()).expect("start");
    loop {
        std::thread::sleep(Duration::from_millis(20));
        let p: Option<backup::BackupProgress> = progress.lock().unwrap().get("bench").cloned();
        if let Some(p) = p
            && p.phase == "Watching"
        {
            let wall = t0.elapsed().as_secs_f64();
            let cpu = (cpu_ms() - c0) as f64 / 1000.0;
            println!(
                "{}",
                serde_json::json!({"journey":"K5","files":p.uploaded,"bytes":bytes_total,
                "wall_s":wall,"cpu_s":cpu,"mbit_s":bytes_total as f64*8.0/wall/1e6,
                "cpu_bound_mbit_s":bytes_total as f64*8.0/cpu.max(0.001)/1e6,
                "failed":p.failed,"error":p.error,"rss_kb":rss_kb()})
            );
            break;
        }
    }
    handle.stop();
}

/// One remote walk on its own, five times: where an idle pass's CPU goes.
fn run_walk(args: &[String]) {
    for i in 0..5 {
        let c = cpu_ms();
        let t = Instant::now();
        let n = luna::walk_remote_files(&args[2], &args[3], &args[4], &args[5])
            .map(|v| v.len())
            .unwrap_or(0);
        println!(
            "{}",
            serde_json::json!({"op":"remote_walk","run":i,"files":n,
                "wall_ms":t.elapsed().as_millis() as u64,"cpu_ms":cpu_ms()-c})
        );
    }
}

fn walk_bytes(dir: &Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += walk_bytes(&p);
            } else if let Ok(m) = p.metadata() {
                n += m.len();
            }
        }
    }
    n
}

fn main() {
    // v = ["", "", base_url, token, drive_id, remote_path, local, extra...]
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut v = vec![String::new(), String::new()];
    v.extend(std::env::args().skip(2));
    match (mode.as_str(), v.len() >= 7) {
        ("sync", true) => run_sync(&v),
        ("backup", true) => run_backup(&v),
        ("walk", true) => run_walk(&v),
        _ => eprintln!(
            "usage: clients_bench sync|backup <base_url> <token> <drive_id> <remote_path> <local> [idle_passes] [edits]"
        ),
    }
}
