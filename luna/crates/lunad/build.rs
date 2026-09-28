use std::fs;
use std::path::Path;

fn main() {
    // Read at runtime, not env!(): the compile-time path is baked into the
    // cached binary and goes stale when the workspace is built under a
    // different root (e.g. distrobox mounts the tree at /repo).
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out = Path::new(&manifest_dir).join("web").join("dist");
    if !out.exists() {
        fs::create_dir_all(&out).expect("create web dist dir");
        fs::write(
            out.join("index.html"),
            "<!doctype html><title>Luna</title>build the web app first",
        )
        .unwrap();
    }
    println!("cargo:rerun-if-changed=web/dist");

    // Floor for the system clock check: a clock earlier than this build is
    // certainly wrong. Only reruns with the rest of build.rs, so the value can
    // lag behind the real build — that only makes the floor more lenient.
    let build_unix = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        });
    println!("cargo:rustc-env=LUNA_BUILD_UNIX={build_unix}");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
}
