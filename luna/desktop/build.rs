//! Build script: embeds the app icon as a Windows resource so the exe —
//! and every shortcut/taskbar entry made from it — shows the Luna icon
//! instead of the generic application icon.

fn main() {
    println!("cargo:rerun-if-changed=resources/icon.png");
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() != Ok("windows") {
        return;
    }

    let out = std::env::var("OUT_DIR").unwrap();
    let png = include_bytes!("resources/icon.png");

    // .ico = ICONDIR + one ICONDIRENTRY + the PNG payload (PNG-in-ICO is the
    // modern format Windows itself uses for large icons).
    let ico_path = format!("{out}/icon.ico");
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // reserved, type=icon, count=1
    ico.extend_from_slice(&[0, 0]); // width=256, height=256 (0 encodes 256)
    ico.extend_from_slice(&[0, 0]); // colors, reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // planes
    ico.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes()); // offset of the image data
    ico.extend_from_slice(png);
    std::fs::write(&ico_path, &ico).unwrap();

    let rc_path = format!("{out}/icon.rc");
    std::fs::write(&rc_path, "1 ICON \"icon.ico\"\n").unwrap();
    let obj_path = format!("{out}/icon.o");

    let windres = ["x86_64-w64-mingw32-windres", "windres"]
        .iter()
        .find(|name| {
            std::process::Command::new(name)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied()
        .expect("windres not found — install binutils-mingw-w64 to embed the Windows icon");

    let status = std::process::Command::new(windres)
        .arg("-i")
        .arg(&rc_path)
        .args(["-O", "coff", "-o"])
        .arg(&obj_path)
        .current_dir(&out)
        .status()
        .expect("failed to run windres");
    assert!(status.success(), "windres failed on icon.rc");

    println!("cargo:rustc-link-arg={obj_path}");
}
