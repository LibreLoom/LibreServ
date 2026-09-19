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
}
