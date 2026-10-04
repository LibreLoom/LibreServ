use super::THUMB_CACHE_CONTROL;
use crate::drives::DriveManager;
use crate::drives::mount::shared_mock;
use crate::{AppState, db, gallery};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use tower::ServiceExt;

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thumb_revalidation_does_not_read_the_file() {
    // A FIFO read only returns when the writer closes, so a read-first
    // 304 path waits out the writer's hold; a metadata-only 304 returns
    // at once. The elapsed-time assertion is the signal — a hanging read
    // would otherwise still *eventually* answer.
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = std::sync::Arc::new(AppState::new(conn, drive_manager, dir.path()));
    let fifo = dir.path().join("thumb.fifo");
    let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) },
        0,
        "mkfifo failed"
    );
    let meta = std::fs::metadata(&fifo).unwrap();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = crate::drives::ram_cache::thumb_etag(meta.len(), mtime_secs);

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    // The writer keeps the fifo open (so a read would block) until the test
    // is done with it — released by dropping the sender, not by a timer.
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let writer_fifo = fifo.clone();
    let writer = std::thread::spawn(move || {
        let _held = std::fs::OpenOptions::new()
            .write(true)
            .open(&writer_fifo)
            .expect("open fifo for writing");
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv();
    });

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(axum::http::header::IF_NONE_MATCH, etag.parse().unwrap());
    let t0 = std::time::Instant::now();
    let revalidated = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        super::serve_thumb_file(&state, "d1", "a.jpg", fifo.clone(), &headers),
    )
    .await
    .expect("304 must be answered without reading the file")
    .unwrap();
    let elapsed = t0.elapsed();
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
    assert!(
        revalidated
            .headers()
            .get(axum::http::header::ETAG)
            .is_some()
    );
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "revalidation must not read the file (took {elapsed:?})"
    );
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("watchdog writer must open");
    // Let the writer go and make sure it exits cleanly.
    drop(release_tx);
    writer.join().unwrap();
}

#[test]
fn thumbs_are_private() {
    assert!(THUMB_CACHE_CONTROL.starts_with("private"));
    assert!(!THUMB_CACHE_CONTROL.contains("public"));
    assert!(THUMB_CACHE_CONTROL.contains("max-age="));
    assert!(THUMB_CACHE_CONTROL.contains("must-revalidate"));
}

#[tokio::test]
async fn status_includes_phase_and_compat_busy_fields() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = AppState::new(conn, drive_manager, dir.path());
    let auth = state.auth.clone();
    let user = auth
        .register("Gale", "Gale", "hunter22hunter1", "admin")
        .unwrap();
    let token = auth.issue(&user).unwrap();
    let router = axum::Router::new()
        .merge(super::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state);
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/v1/gallery/status")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["busy"].is_boolean());
    assert!(v["scanning"].is_boolean());
    assert!(v["pending"].is_number());
    assert_eq!(v["phase"], "idle");
    assert!(v.get("found_count").is_some());
    assert!(v.get("drive_id").is_some());
    assert!(v.get("drive_label").is_some());
    assert!(v.get("last_error").is_some());
}

#[tokio::test]
async fn status_names_the_failing_drive_in_last_error() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    db::upsert_drive(
        &conn,
        "d-photos",
        "Family Photos",
        "as_is",
        "ext4",
        "sdz",
        "/mnt/d-photos",
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = AppState::new(conn, drive_manager, dir.path());
    let auth = state.auth.clone();
    let user = auth
        .register("Err", "Err", "hunter22hunter1", "admin")
        .unwrap();
    let token = auth.issue(&user).unwrap();
    state.gallery.debug_set_error(
        "d-photos",
        "Luna couldn't finish looking through {drive}. Try looking through it again, or unplug the drive and plug it back in.",
    );
    let make_router = || {
        axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone())
    };
    let get_status = |router: axum::Router| {
        let token = token.clone();
        async move {
            let response = router
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/gallery/status")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        }
    };

    let v = get_status(make_router()).await;
    let msg = v["last_error"].as_str().unwrap();
    assert!(
        msg.contains("\"Family Photos\""),
        "last_error should name the drive, got: {msg}"
    );
    assert!(!msg.contains("{drive}"));

    // A drive the caller cannot resolve falls back to a generic reference.
    state
        .gallery
        .debug_set_error("d-gone", "Luna couldn't finish looking through {drive}.");
    let v = get_status(make_router()).await;
    let msg = v["last_error"].as_str().unwrap();
    assert!(msg.contains("this drive"), "got: {msg}");
    assert!(!msg.contains("{drive}"));
}

#[tokio::test]
async fn rescan_queues_accessible_mounts() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let mount = dir.path().join("photos-vol");
    std::fs::create_dir_all(&mount).unwrap();
    db::upsert_drive(
        &conn,
        "d-photos",
        "Family Photos",
        "as_is",
        "ext4",
        "sdz",
        mount.to_str().unwrap(),
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = AppState::new(conn, drive_manager, dir.path());
    let auth = state.auth.clone();
    let user = auth
        .register("Rescan", "Rescan", "hunter22hunter1", "admin")
        .unwrap();
    let token = auth.issue(&user).unwrap();
    let router = axum::Router::new()
        .merge(super::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state.clone());
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gallery/rescan")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["queued"], 1);
    assert!(state.gallery.is_watching("d-photos"));
    assert!(state.gallery.pending() || state.gallery.status().busy);
}

#[test]
fn album_item_allowed_matches_items_and_contrib() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    crate::drives::drive_db::create(
        root,
        &luna_core::marker::Marker::new("home", "Home"),
        &luna_core::marker::pick_prefix(root).unwrap(),
    )
    .unwrap();
    // The contrib branch resolves on the filesystem — a lexical prefix
    // match is not enough; the folder and file must really exist, and
    // the content must sniff as media (JPEG magic bytes here).
    let contrib = root.join("Shared Photos/Shared");
    std::fs::create_dir_all(&contrib).unwrap();
    std::fs::write(contrib.join("guest.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
    let album = crate::gallery::create_album(root, "home", "u1", "Shared").unwrap();
    crate::gallery::add_album_items(root, &album.id, &[("d1".into(), "a.jpg".into())]).unwrap();
    let mut album = crate::gallery::get_album(root, "home", &album.id)
        .unwrap()
        .unwrap();
    album.contrib_path = "Shared Photos/Shared".into();
    assert!(super::album_item_allowed(
        "home", root, &album, "d1", "a.jpg"
    ));
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "d1",
        "other.jpg"
    ));
    assert!(super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "Shared Photos/Shared/guest.jpg"
    ));
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "other",
        "Shared Photos/Shared/guest.jpg"
    ));
}

#[test]
fn album_item_allowed_denies_non_media_and_contrib_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    crate::drives::drive_db::create(
        root,
        &luna_core::marker::Marker::new("home", "Home"),
        &luna_core::marker::pick_prefix(root).unwrap(),
    )
    .unwrap();
    let contrib = root.join("Shared Photos/Shared");
    std::fs::create_dir_all(&contrib).unwrap();
    std::fs::write(contrib.join("guest.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
    // A real media file outside the contrib folder on the same drive.
    std::fs::write(root.join("outside.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
    let album = crate::gallery::create_album(root, "home", "u1", "Shared").unwrap();
    // A pre-existing bad row: a non-media file already in album_items.
    crate::gallery::add_album_items(root, &album.id, &[("home".into(), "evil.html".into())])
        .unwrap();
    let mut album = crate::gallery::get_album(root, "home", &album.id)
        .unwrap()
        .unwrap();
    album.contrib_path = "Shared Photos/Shared".into();

    // The media gate covers rows added before the add-time check existed.
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "evil.html"
    ));
    // A non-media file sitting inside the contrib folder is denied too.
    std::fs::write(contrib.join("page.html"), b"<html>").unwrap();
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "Shared Photos/Shared/page.html"
    ));

    // A symlink inside contrib pointing elsewhere on the drive must not
    // widen the album's scope — the canonical target leaves the folder.
    std::os::unix::fs::symlink(root.join("outside.jpg"), contrib.join("escape.jpg")).unwrap();
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "Shared Photos/Shared/escape.jpg"
    ));
    // A symlinked contrib *directory* is refused the same way.
    let real = root.join("real-contrib");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("shot.jpg"), b"x").unwrap();
    std::fs::remove_dir_all(&contrib).unwrap();
    std::os::unix::fs::symlink(&real, &contrib).unwrap();
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "Shared Photos/Shared/shot.jpg"
    ));
}

#[test]
fn album_item_allowed_denies_markup_named_as_media() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    crate::drives::drive_db::create(
        root,
        &luna_core::marker::Marker::new("home", "Home"),
        &luna_core::marker::pick_prefix(root).unwrap(),
    )
    .unwrap();
    let contrib = root.join("Shared Photos/Shared");
    std::fs::create_dir_all(&contrib).unwrap();
    // An HTML document dropped in under a photo's name must not serve —
    // extension checks alone let it through.
    std::fs::write(
        contrib.join("party.jpg"),
        b"<html><body>not a photo</body></html>",
    )
    .unwrap();
    let album = crate::gallery::create_album(root, "home", "u1", "Shared").unwrap();
    let mut album = crate::gallery::get_album(root, "home", &album.id)
        .unwrap()
        .unwrap();
    album.contrib_path = "Shared Photos/Shared".into();
    assert!(!super::album_item_allowed(
        "home",
        root,
        &album,
        "home",
        "Shared Photos/Shared/party.jpg"
    ));
}

#[test]
fn album_item_allowed_denies_symlinked_and_internal_items() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let prefix = luna_core::marker::pick_prefix(root).unwrap();
    crate::drives::drive_db::create(
        root,
        &luna_core::marker::Marker::new("home", "Home"),
        &prefix,
    )
    .unwrap();
    // A photo inside Luna's own namespace.
    let internal_dir = root.join(format!("{prefix}-trash/entry"));
    std::fs::create_dir_all(&internal_dir).unwrap();
    std::fs::write(internal_dir.join("private.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
    let internal_rel = format!("{prefix}-trash/entry/private.jpg");
    // A `.jpg` whose leaf is a symlink — whether the target is inside
    // Luna's namespace or a path outside the drive, serving it would
    // leak bytes the album was never granted.
    std::os::unix::fs::symlink(internal_dir.join("private.jpg"), root.join("link.jpg")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", root.join("escape.jpg")).unwrap();
    // The real photo, as a control.
    std::fs::write(root.join("real.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
    let album = crate::gallery::create_album(root, "home", "u1", "Trip").unwrap();
    crate::gallery::add_album_items(
        root,
        &album.id,
        &[
            ("home".into(), internal_rel.clone()),
            ("home".into(), "link.jpg".into()),
            ("home".into(), "escape.jpg".into()),
            ("home".into(), "real.jpg".into()),
        ],
    )
    .unwrap();
    let album = crate::gallery::get_album(root, "home", &album.id)
        .unwrap()
        .unwrap();

    assert!(
        !super::album_item_allowed("home", root, &album, "home", &internal_rel),
        "Luna-internal paths must never be album content"
    );
    assert!(
        !super::album_item_allowed("home", root, &album, "home", "link.jpg"),
        "a symlinked item aliasing Luna's namespace must not serve"
    );
    assert!(
        !super::album_item_allowed("home", root, &album, "home", "escape.jpg"),
        "a symlinked item escaping the drive must not serve"
    );
    assert!(
        super::album_item_allowed("home", root, &album, "home", "real.jpg"),
        "a genuine photo row must still serve"
    );
}

#[test]
fn zip_entry_name_uses_only_the_display_name() {
    assert_eq!(super::zip_entry_name("d1", "a/b/photo.jpg"), "photo.jpg");
    assert_eq!(super::zip_entry_name("d1", "photo.jpg"), "photo.jpg");
    assert_eq!(super::zip_entry_name("d1", "a\\b\\photo.jpg"), "photo.jpg");
    assert_eq!(super::zip_entry_name("d1", ""), "file");
}

#[tokio::test]
async fn serve_media_path_never_serves_markup_inline() {
    let dir = tempfile::tempdir().unwrap();
    let page = dir.path().join("page.html");
    std::fs::write(&page, b"<html><body>x</body></html>").unwrap();
    let response = super::serve_media_path(
        page,
        "text/html",
        "page.html",
        "inline",
        &axum::http::HeaderMap::new(),
    )
    .await
    .unwrap();
    let disposition = response
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        disposition.starts_with("attachment"),
        "markup must download, never render inline — got {disposition}"
    );
}

#[test]
fn write_items_zip_packs_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.jpg");
    let b = dir.path().join("b.png");
    std::fs::write(&a, b"aaa").unwrap();
    std::fs::write(&b, b"bbbb").unwrap();
    let zip_path = dir.path().join("out.zip");
    let file = std::fs::File::create(&zip_path).unwrap();
    let n = crate::gallery::write_items_zip(
        &[("d1/a.jpg".into(), a), ("d1/b.png".into(), b)],
        file,
        10,
    )
    .unwrap();
    assert_eq!(n, 2);
    assert!(zip_path.metadata().unwrap().len() > 20);
}

#[tokio::test]
async fn member_album_id_without_home_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let mount = dir.path().join("photos-vol");
    std::fs::create_dir_all(&mount).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]));
    png.save(mount.join("secret.png")).unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("d-photos", "Family Photos"),
        &prefix,
    )
    .unwrap();
    crate::gallery::scan_drive("d-photos", &mount).unwrap();
    let album = crate::gallery::create_album(&mount, "d-photos", "owner", "Private").unwrap();
    crate::gallery::add_album_items(
        &mount,
        &album.id,
        &[("d-photos".into(), "secret.png".into())],
    )
    .unwrap();
    db::upsert_drive(
        &conn,
        "d-photos",
        "Family Photos",
        "as_is",
        "ext4",
        "sdz",
        mount.to_str().unwrap(),
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = AppState::new(conn, drive_manager, dir.path());
    let auth = state.auth.clone();
    // First account is always Admin; Member must be the second user.
    let _admin = auth
        .register("Admin", "Admin", "hunter22hunter1", "admin")
        .unwrap();
    let member = auth
        .register("Member", "Member", "hunter22hunter1", "user")
        .unwrap();
    assert_eq!(member.role, "user");
    let token = auth.issue(&member).unwrap();
    let router = axum::Router::new()
        .merge(super::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state);

    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/gallery?album_id={}", album.id))
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "album_id alone must not open the full library"
    );

    let response = router
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/gallery?album_id={}&album_home=d-photos",
                    album.id
                ))
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "non-members must not view albums they were not invited to"
    );
}

/// An admin + an album-contributor member, one mounted drive with a real
/// file tree, one album owned by the admin. Returns everything a test
/// needs to drive the album items endpoints.
struct AlbumFixture {
    _dir: tempfile::TempDir,
    state: AppState,
    router: axum::Router,
    admin_token: String,
    member_token: String,
    album: gallery::Album,
    mount: PathBuf,
}

async fn album_fixture() -> AlbumFixture {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let mount = dir.path().join("photos-vol");
    std::fs::create_dir_all(&mount).unwrap();
    // Real media bytes — item acceptance sniffs content, not names.
    let img = image::RgbImage::from_pixel(4, 4, image::Rgb([3, 6, 9]));
    img.save(mount.join("pic.jpg")).unwrap();
    std::fs::write(
        mount.join("clip.mp4"),
        b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00",
    )
    .unwrap();
    std::fs::write(mount.join("evil.html"), b"<script>alert(1)</script>").unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("d-photos", "Family Photos"),
        &luna_core::marker::pick_prefix(&mount).unwrap(),
    )
    .unwrap();
    db::upsert_drive(
        &conn,
        "d-photos",
        "Family Photos",
        "as_is",
        "ext4",
        "sdz",
        mount.to_str().unwrap(),
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = AppState::new(conn, drive_manager, dir.path());
    let auth = state.auth.clone();
    let admin = auth
        .register("Admin", "Admin", "hunter22hunter1", "admin")
        .unwrap();
    let member = auth
        .register("Member", "Member", "hunter22hunter1", "user")
        .unwrap();
    let album = gallery::create_album(&mount, "d-photos", &admin.id, "Trip").unwrap();
    {
        let conn = state.db.lock().unwrap();
        // Contributor on the album…
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "m-album".into(),
                subject_kind: crate::access::KIND_ALBUM.into(),
                drive_id: "d-photos".into(),
                path: String::new(),
                album_id: album.id.clone(),
                user_id: member.id.clone(),
                caps: crate::access::CAP_VIEW | crate::access::CAP_UPLOAD,
                created_by: admin.id.clone(),
            },
        )
        .unwrap();
        // …and a whole-drive view+share grant so the file paths resolve
        // and republishing into albums is permitted for them.
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "m-drive".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d-photos".into(),
                path: String::new(),
                album_id: String::new(),
                user_id: member.id.clone(),
                caps: crate::access::CAP_VIEW | crate::access::CAP_SHARE,
                created_by: admin.id.clone(),
            },
        )
        .unwrap();
    }
    let router = axum::Router::new()
        .merge(super::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state.clone());
    AlbumFixture {
        _dir: dir,
        state,
        router,
        admin_token: auth.issue(&admin).unwrap(),
        member_token: auth.issue(&member).unwrap(),
        album,
        mount,
    }
}

fn json_req(method: &str, uri: &str, token: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn call(router: &axum::Router, req: Request<Body>) -> axum::response::Response {
    router.clone().oneshot(req).await.unwrap()
}

async fn call_json(router: &axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = call(router, req).await;
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn add_items_rejects_non_media() {
    let f = album_fixture().await;
    let base = format!("/api/v1/gallery/albums/d-photos/{}/items", f.album.id);
    // A contributor cannot drop an HTML file into the album — inline
    // preview of it would be stored XSS on this origin.
    let (status, _) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &f.member_token,
            r#"{"items":[{"drive_id":"d-photos","path":"evil.html"}]}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Mixed batches keep the media and report the rest skipped.
    let (status, v) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &f.member_token,
            r#"{"items":[
                {"drive_id":"d-photos","path":"pic.jpg"},
                {"drive_id":"d-photos","path":"clip.mp4"},
                {"drive_id":"d-photos","path":"evil.html"}
            ]}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["added"], 2);
    assert_eq!(v["skipped_not_media"], 1);
    let refs = gallery::list_album_item_refs(&f.mount, &f.album.id).unwrap();
    assert_eq!(refs.len(), 2);
    assert!(refs.iter().all(|(_, p)| p != "evil.html"));
}

#[tokio::test]
async fn add_items_rejects_fake_media_and_needs_share() {
    let f = album_fixture().await;
    // HTML bytes wearing a photo's name — extension checks alone would
    // publish it to every album viewer.
    std::fs::write(f.mount.join("party.jpg"), b"<html><body>x</body></html>").unwrap();
    let base = format!("/api/v1/gallery/albums/d-photos/{}/items", f.album.id);
    let (status, v) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &f.member_token,
            r#"{"items":[{"drive_id":"d-photos","path":"party.jpg"}]}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let _ = v;

    // A view-only contributor can see the file but must not republish
    // it into a shared album — adding is a sharing act.
    let auth = f.state.auth.clone();
    let viewer = auth
        .register("Viewer", "Viewer", "hunter22hunter1", "user")
        .unwrap();
    let viewer_token = auth.issue(&viewer).unwrap();
    {
        let conn = f.state.db.lock().unwrap();
        let admin = crate::db::list_users(&conn).unwrap()[0].id.clone();
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "v-album".into(),
                subject_kind: crate::access::KIND_ALBUM.into(),
                drive_id: "d-photos".into(),
                path: String::new(),
                album_id: f.album.id.clone(),
                user_id: viewer.id.clone(),
                caps: crate::access::CAP_VIEW | crate::access::CAP_UPLOAD,
                created_by: admin.clone(),
            },
        )
        .unwrap();
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "v-drive".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d-photos".into(),
                path: String::new(),
                album_id: String::new(),
                user_id: viewer.id.clone(),
                caps: crate::access::CAP_VIEW, // view only — no share
                created_by: admin,
            },
        )
        .unwrap();
    }
    let (status, _) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &viewer_token,
            r#"{"items":[{"drive_id":"d-photos","path":"pic.jpg"}]}"#,
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a view-only member must not republish photos into the album"
    );
    assert!(
        gallery::list_album_item_refs(&f.mount, &f.album.id)
            .unwrap()
            .is_empty()
    );

    // Grant share and the same request succeeds.
    {
        let conn = f.state.db.lock().unwrap();
        let admin = crate::db::list_users(&conn).unwrap()[0].id.clone();
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "v-drive-share".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d-photos".into(),
                path: String::new(),
                album_id: String::new(),
                user_id: viewer.id.clone(),
                caps: crate::access::CAP_VIEW | crate::access::CAP_SHARE,
                created_by: admin,
            },
        )
        .unwrap();
    }
    let (status, v) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &viewer_token,
            r#"{"items":[{"drive_id":"d-photos","path":"pic.jpg"}]}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["added"], 1);
}

#[tokio::test]
async fn status_hides_global_count_from_members() {
    let f = album_fixture().await;
    let uri = "/api/v1/gallery/status";
    let (_, v) = call_json(&f.router, json_req("GET", uri, &f.admin_token, "")).await;
    assert!(
        v["found_count"].is_number(),
        "admins keep the full-index count"
    );
    let (_, v) = call_json(&f.router, json_req("GET", uri, &f.member_token, "")).await;
    assert!(
        v["found_count"].is_null(),
        "members must not learn the global photo count"
    );
}

#[tokio::test]
async fn member_view_gets_opaque_cover_url_and_item_ids() {
    let f = album_fixture().await;
    gallery::add_album_items(
        &f.mount,
        &f.album.id,
        &[("d-photos".into(), "pic.jpg".into())],
    )
    .unwrap();
    gallery::update_album(
        &f.mount,
        &f.album.id,
        None,
        None,
        Some(("d-photos".into(), "pic.jpg".into())),
    )
    .unwrap();

    // Member-facing album JSON carries an album-scoped cover URL — no
    // drive path inside it.
    let (status, v) = call_json(
        &f.router,
        json_req(
            "GET",
            &format!("/api/v1/gallery/albums/d-photos/{}", f.album.id),
            &f.member_token,
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cover = v["cover_thumb"].as_str().unwrap_or("");
    assert_eq!(
        cover,
        format!("/api/v1/gallery/albums/d-photos/{}/cover", f.album.id)
    );
    assert!(!cover.contains("pic.jpg"));

    // The cover route serves the thumbnail through that opaque URL.
    let res = call(&f.router, json_req("GET", cover, &f.member_token, "")).await;
    assert_eq!(res.status(), StatusCode::OK);
    let ctype = res
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(ctype, "image/jpeg");

    // Admin full view still shows the real coordinates.
    let (status, v) = call_json(
        &f.router,
        json_req(
            "GET",
            &format!("/api/v1/gallery/albums/d-photos/{}", f.album.id),
            &f.admin_token,
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["cover_path"], "pic.jpg");

    // Item listing carries an opaque id + display name per item, and
    // rows that could never serve are dropped.
    let (status, v) = call_json(
        &f.router,
        json_req(
            "GET",
            &format!("/api/v1/gallery/albums/d-photos/{}/items", f.album.id),
            &f.member_token,
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let items = v.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "pic.jpg");
    assert!(items[0]["id"].as_str().unwrap().len() > 20);
}

#[tokio::test]
async fn list_items_drops_symlinked_rows() {
    let f = album_fixture().await;
    // Row pointing through a symlink — could never serve, so it must
    // not be advertised to album members either.
    std::os::unix::fs::symlink("/etc/passwd", f.mount.join("escape.jpg")).unwrap();
    gallery::add_album_items(
        &f.mount,
        &f.album.id,
        &[
            ("d-photos".into(), "pic.jpg".into()),
            ("d-photos".into(), "escape.jpg".into()),
        ],
    )
    .unwrap();
    let (status, v) = call_json(
        &f.router,
        json_req(
            "GET",
            &format!("/api/v1/gallery/albums/d-photos/{}/items", f.album.id),
            &f.member_token,
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let items = v.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["path"], "pic.jpg");
}

#[tokio::test]
async fn remove_item_needs_a_manager_and_locked_blocks_changes() {
    let f = album_fixture().await;
    gallery::add_album_items(
        &f.mount,
        &f.album.id,
        &[("d-photos".into(), "pic.jpg".into())],
    )
    .unwrap();
    let base = format!("/api/v1/gallery/albums/d-photos/{}/items", f.album.id);

    // A contributor (CAP_UPLOAD) must not remove anyone's items.
    let (status, _) = call_json(
        &f.router,
        json_req(
            "DELETE",
            &base,
            &f.member_token,
            r#"{"drive_id":"d-photos","path":"pic.jpg"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        gallery::list_album_item_refs(&f.mount, &f.album.id)
            .unwrap()
            .len(),
        1
    );

    // Locking freezes the album for everyone, managers included.
    let (status, _) = call_json(
        &f.router,
        json_req(
            "PATCH",
            &format!("/api/v1/gallery/albums/d-photos/{}", f.album.id),
            &f.admin_token,
            r#"{"locked":true}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call_json(
        &f.router,
        json_req(
            "POST",
            &base,
            &f.admin_token,
            r#"{"items":[{"drive_id":"d-photos","path":"clip.mp4"}]}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "locked album refuses adds");
    let (status, _) = call_json(
        &f.router,
        json_req(
            "DELETE",
            &base,
            &f.admin_token,
            r#"{"drive_id":"d-photos","path":"pic.jpg"}"#,
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "locked album refuses removes"
    );

    // Unlock, then the owner can remove again.
    let (status, _) = call_json(
        &f.router,
        json_req(
            "PATCH",
            &format!("/api/v1/gallery/albums/d-photos/{}", f.album.id),
            &f.admin_token,
            r#"{"locked":false}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call_json(
        &f.router,
        json_req(
            "DELETE",
            &base,
            &f.admin_token,
            r#"{"drive_id":"d-photos","path":"pic.jpg"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        gallery::list_album_item_refs(&f.mount, &f.album.id)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn album_json_hides_layout_from_non_managers() {
    let f = album_fixture().await;
    // Give the album the internals a viewer must never see.
    gallery::allocate_contrib_dir(&f.mount, &f.album.id, &f.album.name).unwrap();
    gallery::update_album(
        &f.mount,
        &f.album.id,
        None,
        None,
        Some(("d-photos".into(), "pic.jpg".into())),
    )
    .unwrap();
    let album_uri = format!("/api/v1/gallery/albums/d-photos/{}", f.album.id);

    let (status, v) = call_json(&f.router, json_req("GET", &album_uri, &f.member_token, "")).await;
    assert_eq!(status, StatusCode::OK);
    for leaked in [
        "contrib_path",
        "cover_path",
        "cover_drive_id",
        "owner_user_id",
    ] {
        assert!(
            v.get(leaked).is_none(),
            "member view must not leak {leaked}: {v}"
        );
    }
    for kept in [
        "id",
        "home_drive_id",
        "name",
        "cover_thumb",
        "locked",
        "item_count",
    ] {
        assert!(v.get(kept).is_some(), "member view needs {kept}: {v}");
    }

    // list_albums applies the same projection.
    let (status, v) = call_json(
        &f.router,
        json_req("GET", "/api/v1/gallery/albums", &f.member_token, ""),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list = v.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].get("contrib_path").is_none());
    assert!(list[0].get("owner_user_id").is_none());

    // The owner still gets the full row.
    let (status, v) = call_json(&f.router, json_req("GET", &album_uri, &f.admin_token, "")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(v["owner_user_id"].is_string());
    assert!(v["contrib_path"].is_string());
    assert_eq!(v["cover_path"], "pic.jpg");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_thumb_serves_dont_stall_workers() {
    // Mirrors the production runtime (2 workers): 16 concurrent
    // cold-thumb serves must all finish. The file reads run on the
    // blocking pool, never on the async workers.
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = std::sync::Arc::new(AppState::new(conn, drive_manager, dir.path()));
    let thumb_path = dir.path().join("thumb.jpg");
    let body = vec![0xFFu8; 256 * 1024];
    std::fs::write(&thumb_path, &body).unwrap();

    let futs: Vec<_> = (0..16)
        .map(|_| {
            let state = state.clone();
            let path = thumb_path.clone();
            let headers = axum::http::HeaderMap::new();
            tokio::spawn(async move {
                super::serve_thumb_file(&state, "d1", "a.jpg", path, &headers).await
            })
        })
        .collect();
    // Smoke test, not a stall detector: local tempfile reads finish
    // microseconds after a worker is parked, so this passes even if the
    // read runs inline. `slow_thumb_read_does_not_stall_workers` is the
    // test that actually fails on a parked worker.
    let resps = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut out = Vec::new();
        for f in futs {
            out.push(f.await.unwrap());
        }
        out
    })
    .await
    .expect("16 concurrent thumb serves must finish with 2 workers");
    for r in &resps {
        assert_eq!(r.as_ref().unwrap().status(), StatusCode::OK);
    }
    // Served bytes match the file; the cache holds the shared copy.
    let cached = state.ram_cache.get_thumb("d1", "a.jpg").unwrap();
    assert_eq!(&cached.bytes[..], &body[..]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_thumb_read_does_not_stall_workers() {
    // A FIFO read only returns when the writer closes, so this is the one
    // honest way to hold a read open. Two concurrent serves park both
    // async workers if the read runs inline, and a heartbeat task then
    // never gets a worker. The writer is an OS thread; the blocking pool
    // — not the async runtime — is what waits.
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = std::sync::Arc::new(AppState::new(conn, drive_manager, dir.path()));
    let fifo = dir.path().join("thumb.fifo");
    let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) },
        0,
        "mkfifo failed"
    );
    let fifo_for_writer = fifo.clone();
    // The writer holds both reads open until the test releases it, so a parked
    // worker cannot hide behind a timer: the data only arrives on the signal.
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&fifo_for_writer)
            .expect("open fifo for writing");
        release_rx.recv().unwrap();
        std::io::Write::write_all(&mut writer, b"thumb").unwrap();
    });

    let (serves_tx, mut serves_rx) = tokio::sync::mpsc::channel(2);
    for _ in 0..2 {
        let (state, path) = (state.clone(), fifo.clone());
        let serves_tx = serves_tx.clone();
        tokio::spawn(async move {
            let headers = axum::http::HeaderMap::new();
            let result = super::serve_thumb_file(&state, "d1", "a.jpg", path, &headers)
                .await
                .map(|r| r.status())
                .map_err(|e| e.0);
            serves_tx.send(result).await.unwrap();
        });
    }
    drop(serves_tx);

    // `sleep` reaching its timer is the heartbeat: on a parked runtime no
    // worker runs it, and the 3s timeout fails the test.
    let heartbeat = tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        heartbeat.is_finished(),
        "async workers were parked on the slow read"
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), heartbeat)
        .await
        .expect("async workers were parked on the slow read")
        .unwrap();

    // The async runtime stayed free while both reads were parked; let the data through.
    release_tx.send(()).unwrap();
    for _ in 0..2 {
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), serves_rx.recv())
            .await
            .expect("parked reads must finish once the writer closes")
            .expect("serve task must report a status");
        assert_eq!(status, Ok(StatusCode::OK));
    }
    watchdog.join().unwrap();
}
