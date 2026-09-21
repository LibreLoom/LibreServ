//! Environment for running inside a macOS `.app` bundle.
//!
//! GTK, GLib and gdk-pixbuf discover resources through env vars that the
//! packaging script cannot know at build time (the .app may live anywhere).
//! When the executable sits at `Contents/MacOS/luna-desktop`, point those
//! vars at `Contents/Resources` before GTK initializes. Running unbundled
//! (cargo run with system/Homebrew GTK) is a no-op.

use std::path::PathBuf;

fn resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Contents/MacOS/luna-desktop → Contents/Resources
    let res = exe.parent()?.parent()?.join("Resources");
    res.is_dir().then(|| res.canonicalize().unwrap_or(res))
}

fn set_var(key: &str, value: &str) {
    // GTK/GLib read these lazily; we run before any GTK init.
    unsafe { std::env::set_var(key, value) };
}

/// Generate the gdk-pixbuf loaders.cache for the bundled loaders and point
/// GDK_PIXBUF_MODULE_FILE at it. The packaging script ships a template with
/// `__RES__` placeholders; resolve them to the real (possibly moved) bundle.
fn setup_pixbuf_cache(res: &PathBuf) {
    let tmpl = res.join("lib/gdk-pixbuf-loaders.cache.tmpl");
    if !tmpl.is_file() {
        return;
    }
    let res_str = res.to_string_lossy();
    let cache = crate::session::data_dir().join("gdk-pixbuf-loaders.cache");
    let fresh = std::fs::read_to_string(&cache)
        .map(|text| !text.contains(res_str.as_ref()))
        .unwrap_or(true);
    if fresh {
        if let Ok(text) = std::fs::read_to_string(&tmpl) {
            let _ = std::fs::create_dir_all(crate::session::data_dir());
            let _ = std::fs::write(&cache, text.replace("__RES__", &res_str));
        }
    }
    if cache.is_file() {
        set_var("GDK_PIXBUF_MODULE_FILE", &cache.to_string_lossy());
    }
}

/// Set resource env vars when running from inside a .app bundle.
/// Call before GTK initializes (top of ui::run).
pub fn setup_env() {
    let Some(res) = resources_dir() else {
        return;
    };
    let share = res.join("share");
    if share.is_dir() {
        let share_str = share.to_string_lossy().into_owned();
        let data_dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
        let data_dirs = if data_dirs.is_empty() {
            share_str
        } else {
            format!("{share_str}:{data_dirs}")
        };
        set_var("XDG_DATA_DIRS", &data_dirs);
    }
    let schemas = share.join("glib-2.0/schemas");
    if schemas.is_dir() {
        set_var("GSETTINGS_SCHEMA_DIR", &schemas.to_string_lossy());
    }
    setup_pixbuf_cache(&res);
}
