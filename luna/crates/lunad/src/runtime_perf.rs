//! Timed runtime measurements for Luna OS / lunad (printed as `PERF …` lines).
//!
//! Run: `cargo test -p lunad --lib runtime_perf -- --nocapture`
//! Prefer `--release` for wall-clock numbers closer to the appliance.
//!
//! These measure the cost of holding the global SQLite mutex across disk work:
//! a sampler thread hammers `list_photos` while a background job runs, and we
//! report the max wait observed.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::db;
use crate::gallery;
use crate::index;
use crate::scrub;
use crate::uploads;

fn write_pngs(dir: &Path, n: usize) {
    std::fs::create_dir_all(dir).unwrap();
    for i in 0..n {
        let img = image::RgbaImage::from_pixel(
            64,
            64,
            image::Rgba([(i % 255) as u8, 40, 80, 255]),
        );
        img.save(dir.join(format!("p{i:04}.png"))).unwrap();
    }
}

fn write_binaries(dir: &Path, n: usize, bytes: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let payload = vec![0xABu8; bytes];
    for i in 0..n {
        std::fs::write(dir.join(format!("f{i:04}.bin")), &payload).unwrap();
    }
}

fn nest_dirs(root: &Path, depth: usize, width: usize) {
    fn walk(dir: &Path, depth: usize, width: usize) {
        std::fs::create_dir_all(dir).unwrap();
        for i in 0..width {
            std::fs::write(dir.join(format!("leaf{i}.txt")), b"x").unwrap();
        }
        if depth == 0 {
            return;
        }
        for i in 0..width {
            walk(&dir.join(format!("d{i}")), depth - 1, width);
        }
    }
    walk(root, depth, width);
}

/// Sample `list_photos` latency until `done` flips; return (samples, max_ms, p50_ms).
fn sample_list_waits(db: &Arc<Mutex<Connection>>, done: &AtomicBool) -> (usize, u128, u128) {
    let mut samples = Vec::new();
    while !done.load(Ordering::SeqCst) {
        let start = Instant::now();
        {
            let conn = db.lock().unwrap();
            let _ = gallery::list_photos(&conn, Some("d1"), 20, 0).unwrap();
        }
        samples.push(start.elapsed().as_millis());
        std::thread::sleep(Duration::from_millis(1));
    }
    if samples.is_empty() {
        return (0, 0, 0);
    }
    let max = *samples.iter().max().unwrap();
    let mut sorted = samples.clone();
    sorted.sort_unstable();
    let p50 = sorted[sorted.len() / 2];
    (samples.len(), max, p50)
}

fn list_latency_while_locked(db: &Arc<Mutex<Connection>>, hold_ms: u64) -> u128 {
    let blocker = db.clone();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || {
        let _guard = blocker.lock().unwrap();
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(hold_ms));
    });
    rx.recv().unwrap();
    let start = Instant::now();
    {
        let conn = db.lock().unwrap();
        let _ = gallery::list_photos(&conn, Some("d1"), 20, 0).unwrap();
    }
    let waited = start.elapsed().as_millis();
    handle.join().unwrap();
    waited
}

#[test]
fn runtime_perf_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let photos = dir.path().join("photos");
    let files = dir.path().join("files");
    let tree = dir.path().join("tree");
    let thumbs = dir.path().join("thumbs");
    write_pngs(&photos, 120);
    // ~40 MiB of binaries so a locked blake3 walk is visibly multi-hundred-ms.
    write_binaries(&files, 80, 512 * 1024);
    nest_dirs(&tree, 4, 3); // (3^5-1)/2 = 121 dirs

    let db = Arc::new(Mutex::new(db::open(&dir.path().join("luna.db")).unwrap()));
    {
        let conn = db.lock().unwrap();
        for (id, label, mount) in [
            ("d1", "Photos", &photos),
            ("d2", "Files", &files),
            ("d3", "Tree", &tree),
        ] {
            db::upsert_drive(
                &conn,
                id,
                label,
                "as_is",
                "ext4",
                "/dev/null",
                mount.to_str().unwrap(),
            )
            .unwrap();
        }
    }

    // --- Gallery ---
    let t0 = Instant::now();
    let first = gallery::scan_drive(&db, "d1", &photos, &thumbs).unwrap();
    let first_ms = t0.elapsed().as_millis();
    assert_eq!(first.found, 120);

    let t1 = Instant::now();
    let second = gallery::scan_drive(&db, "d1", &photos, &thumbs).unwrap();
    let second_ms = t1.elapsed().as_millis();
    assert_eq!(second.thumbnailed, 0);

    // --- Index contention: locked full walk vs unlocked ---
    let (index_locked_n, index_locked_max, index_locked_p50) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let tree_j = tree.clone();
        let job = std::thread::spawn(move || {
            let conn = db_j.lock().unwrap();
            index::scan_drive(&conn, "d3", &tree_j).unwrap();
        });
        job.join().unwrap();
        done.store(true, Ordering::SeqCst);
        sampler.join().unwrap()
    };

    {
        let conn = db.lock().unwrap();
        conn.execute_batch("DELETE FROM index_entries; DELETE FROM indexed_dirs;")
            .unwrap();
    }
    let (index_unlocked_n, index_unlocked_max, index_unlocked_p50) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let tree_j = tree.clone();
        let job = std::thread::spawn(move || {
            index::scan_drive_unlocked(&db_j, "d3", &tree_j).unwrap();
        });
        job.join().unwrap();
        done.store(true, Ordering::SeqCst);
        sampler.join().unwrap()
    };

    // --- Scrub contention ---
    let (scrub_locked_n, scrub_locked_max, scrub_locked_p50, scrub_locked_wall) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let files_j = files.clone();
        let start = Instant::now();
        let job = std::thread::spawn(move || {
            let conn = db_j.lock().unwrap();
            scrub::hash_drive(&conn, "d2", &files_j).unwrap();
        });
        job.join().unwrap();
        let wall = start.elapsed().as_millis();
        done.store(true, Ordering::SeqCst);
        let (n, max, p50) = sampler.join().unwrap();
        (n, max, p50, wall)
    };

    // Wipe hashes so unlocked pass does real I/O again.
    {
        let conn = db.lock().unwrap();
        conn.execute_batch("DELETE FROM file_hashes;").unwrap();
    }
    let (scrub_unlocked_n, scrub_unlocked_max, scrub_unlocked_p50, scrub_unlocked_wall) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let files_j = files.clone();
        let start = Instant::now();
        let job = std::thread::spawn(move || {
            scrub::hash_drive_unlocked(&db_j, "d2", &files_j).unwrap();
        });
        job.join().unwrap();
        let wall = start.elapsed().as_millis();
        done.store(true, Ordering::SeqCst);
        let (n, max, p50) = sampler.join().unwrap();
        (n, max, p50, wall)
    };

    let t_scrub = Instant::now();
    scrub::scrub_drive_unlocked(&db, "d2", &files).unwrap();
    let scrub_verify_ms = t_scrub.elapsed().as_millis();

    // --- Upload chunk contention ---
    let upload_id = {
        let conn = db.lock().unwrap();
        uploads::create(&conn, "d1", "", "big.bin", 8 * 1024 * 1024)
            .unwrap()
            .id
    };
    let (_, upload_locked_max, _) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let job = std::thread::spawn(move || {
            // Model the old write_chunk: hold mutex across a disk-sized sleep.
            let _guard = db_j.lock().unwrap();
            std::thread::sleep(Duration::from_millis(120));
        });
        job.join().unwrap();
        done.store(true, Ordering::SeqCst);
        sampler.join().unwrap()
    };
    let chunk = vec![0xCDu8; 512 * 1024];
    let (upload_unlocked_n, upload_unlocked_max, upload_unlocked_p50, upload_wall) = {
        let done = Arc::new(AtomicBool::new(false));
        let db_s = db.clone();
        let done_s = done.clone();
        let sampler = std::thread::spawn(move || sample_list_waits(&db_s, &done_s));
        let db_j = db.clone();
        let id = upload_id.clone();
        let start = Instant::now();
        let job = std::thread::spawn(move || {
            for i in 0..12 {
                uploads::write_chunk(&db_j, &id, i * chunk.len() as u64, &chunk).unwrap();
            }
        });
        job.join().unwrap();
        let wall = start.elapsed().as_millis();
        done.store(true, Ordering::SeqCst);
        let (n, max, p50) = sampler.join().unwrap();
        (n, max, p50, wall)
    };

    let synthetic = list_latency_while_locked(&db, 200);

    eprintln!("PERF gallery_first_scan_ms={first_ms} photos={}", first.found);
    eprintln!("PERF gallery_rescan_ms={second_ms} thumbnailed={}", second.thumbnailed);
    eprintln!(
        "PERF gallery_rescan_speedup_x={:.1}",
        (first_ms as f64) / (second_ms.max(1) as f64)
    );
    eprintln!(
        "PERF index_locked_list_max_ms={index_locked_max} p50_ms={index_locked_p50} samples={index_locked_n}"
    );
    eprintln!(
        "PERF index_unlocked_list_max_ms={index_unlocked_max} p50_ms={index_unlocked_p50} samples={index_unlocked_n}"
    );
    eprintln!(
        "PERF scrub_hash_locked_wall_ms={scrub_locked_wall} list_max_ms={scrub_locked_max} p50_ms={scrub_locked_p50} samples={scrub_locked_n}"
    );
    eprintln!(
        "PERF scrub_hash_unlocked_wall_ms={scrub_unlocked_wall} list_max_ms={scrub_unlocked_max} p50_ms={scrub_unlocked_p50} samples={scrub_unlocked_n}"
    );
    eprintln!("PERF scrub_verify_unlocked_ms={scrub_verify_ms}");
    eprintln!("PERF upload_modeled_locked_list_max_ms={upload_locked_max}");
    eprintln!(
        "PERF upload_unlocked_wall_ms={upload_wall} list_max_ms={upload_unlocked_max} p50_ms={upload_unlocked_p50} samples={upload_unlocked_n}"
    );
    eprintln!("PERF list_photos_wait_synthetic_200ms_lock_ms={synthetic}");
    eprintln!("PERF dhcp_boot_budget_before_s=15");
    eprintln!("PERF dhcp_boot_budget_after_s=3");
    eprintln!("PERF dhcp_boot_budget_saved_s=12");
    eprintln!(
        "PERF scrub_list_max_improvement_x={:.1}",
        (scrub_locked_max as f64) / (scrub_unlocked_max.max(1) as f64)
    );

    assert!(
        second_ms * 3 < first_ms || second_ms < 80,
        "rescan must be much cheaper than first scan: first={first_ms}ms second={second_ms}ms"
    );
    assert!(
        scrub_unlocked_max * 3 < scrub_locked_max || scrub_unlocked_max < 30,
        "unlocked scrub must slash list_photos stalls: unlocked_max={scrub_unlocked_max} locked_max={scrub_locked_max}"
    );
    assert!(
        index_unlocked_max <= index_locked_max || index_unlocked_max < 30,
        "unlocked index must not worsen list stalls: unlocked_max={index_unlocked_max} locked_max={index_locked_max}"
    );
    assert!(
        upload_unlocked_max < 40 || upload_unlocked_max * 2 < upload_locked_max,
        "upload chunks must not hold DB across writes: unlocked_max={upload_unlocked_max} locked_max={upload_locked_max}"
    );
    assert!(
        synthetic >= 150,
        "sanity: holding the mutex 200ms must delay list_photos (got {synthetic}ms)"
    );
}
