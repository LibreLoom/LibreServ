use std::fs;
use std::path::Path;

fn main() {
    let out = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("web")
        .join("dist");
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
