use std::fs;
use std::path::Path;

fn main() {
    // `luna/VERSION` is the single source of truth for lunad's version. It must
    // be strict semver (no leading `v`, no leading zeros) or the build stops.
    // The release build sets LUNA_VERSION_PATCH: the version is then written
    // into the finished binary (see lib.rs), so this crate must not depend on
    // the file, or every new version would recompile it.
    println!("cargo:rerun-if-env-changed=LUNA_VERSION_PATCH");
    let patched = std::env::var_os("LUNA_VERSION_PATCH").is_some_and(|v| !v.is_empty());
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    if patched {
        println!("cargo:rustc-env=LUNA_VERSION=");
    } else {
        let version_file = Path::new(&manifest_dir)
            .join("..")
            .join("..")
            .join("VERSION");
        println!("cargo:rerun-if-changed={}", version_file.display());
        let raw = fs::read_to_string(&version_file)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", version_file.display()));
        let version = raw.trim_end_matches(['\n', '\r']);
        if version.len() != version.trim().len() || semver::Version::parse(version).is_err() {
            panic!(
                "luna/VERSION must hold one strict semver version (like 0.4.0 or 0.4.0-beta.1), got {raw:?}"
            );
        }
        println!("cargo:rustc-env=LUNA_VERSION={version}");
    }

    // Read at runtime, not env!(): the compile-time path is baked into the
    // cached binary and goes stale when the workspace is built under a
    // different root (e.g. distrobox mounts the tree at /repo).
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
