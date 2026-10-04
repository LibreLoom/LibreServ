use super::*;

/// Give a test drive root a `.luna-<uuid>` marker so drive_db opens.
/// Idempotent — reuses the existing prefix when already adopted.
fn adopt(root: &Path, id: &str) {
    if crate::drives::drive_db::prefix_for(root).is_none() {
        let prefix = luna_core::marker::pick_prefix(root).unwrap();
        crate::drives::drive_db::create(root, &luna_core::marker::Marker::new(id, "Test"), &prefix)
            .unwrap();
    }
}

/// Adopt-then-scan shorthand for tests.
fn scan(drive_id: &str, root: &Path) -> anyhow::Result<ScanReport> {
    adopt(root, drive_id);
    scan_drive(drive_id, root)
}

#[test]
fn thumbnails_png_and_reuses_cached() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("photo.png");
    let img = image::RgbaImage::from_pixel(800, 600, image::Rgba([120, 120, 120, 255]));
    img.save(&src).unwrap();
    let dest = dir.path().join("thumb.jpg");

    let (w, h, made) = ensure_thumb(&src, &dest, "image").unwrap();
    assert_eq!((w, h), (800, 600));
    assert!(made && dest.exists());

    let (_, _, made_again) = ensure_thumb(&src, &dest, "image").unwrap();
    assert!(!made_again, "cached thumbs are not regenerated");
}

#[test]
fn image_and_video_extension_detection() {
    assert!(is_image(Path::new("photo.JPG")));
    assert!(is_image(Path::new("a/b/photo.png")));
    assert!(is_image(Path::new("IMG_0001.HEIC")));
    assert!(is_video(Path::new("clip.mp4")));
    assert!(is_media(Path::new("clip.MOV")));
    assert!(!is_image(Path::new("video.mp4")));
    assert!(!is_media(Path::new("notes.txt")));
}

#[test]
fn video_thumb_temp_path_uses_jpg_extension() {
    let dest = PathBuf::from("/drive/.luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-thumbs/abc.jpg");
    let tmp = dest.with_extension("vidtmp.jpg");
    assert_eq!(
        tmp.extension().and_then(|e| e.to_str()),
        Some("jpg"),
        "ffmpeg needs a real image extension to pick a muxer"
    );
    // The old `with_extension("vid.jpg.tmp")` produced `abc.vid.jpg.tmp`.
    let broken = dest.with_extension("vid.jpg.tmp");
    assert_eq!(
        broken.extension().and_then(|e| e.to_str()),
        Some("tmp"),
        "regression guard: .tmp must not be the final extension"
    );
}

#[test]
fn thumbnails_video_with_ffmpeg_when_available() {
    let Some(ffmpeg) = which_ffmpeg() else {
        eprintln!("skip: ffmpeg not on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("clip.mp4");
    let status = std::process::Command::new(&ffmpeg)
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x240:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&src)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("spawn ffmpeg to build fixture");
    if !status.success() || !src.exists() {
        eprintln!("skip: could not encode fixture mp4 with this ffmpeg");
        return;
    }

    let dest = dir.path().join("thumb.jpg");
    let (_w, _h, made) = ensure_thumb(&src, &dest, "video").expect("video thumb");
    assert!(made && dest.exists());
    let bytes = std::fs::read(&dest).unwrap();
    assert!(
        bytes.len() > 32,
        "expected a non-trivial JPEG preview, got {} bytes",
        bytes.len()
    );
    // JPEG SOI marker
    assert_eq!(&bytes[0..2], &[0xff, 0xd8]);

    let (_, _, made_again) = ensure_thumb(&src, &dest, "video").unwrap();
    assert!(!made_again, "cached video thumbs are not regenerated");
}

#[test]
fn scan_writes_index_on_drive_not_emmc() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    let os_data = dir.path().join("os-data");
    std::fs::create_dir(&photos_dir).unwrap();
    std::fs::create_dir(&os_data).unwrap();
    let src = photos_dir.join("same.png");
    let png = image::RgbaImage::from_pixel(16, 16, image::Rgba([9, 9, 9, 255]));
    png.save(&src).unwrap();

    let prefix = luna_core::marker::pick_prefix(&photos_dir).unwrap();
    crate::drives::drive_db::create(
        &photos_dir,
        &luna_core::marker::Marker::new("d1", "Photos"),
        &prefix,
    )
    .unwrap();

    let first = scan("d1", &photos_dir).unwrap();
    assert_eq!(first.found, 1);
    assert_eq!(first.thumbnailed, 1);
    assert!(gallery_db_path(&photos_dir).is_some());
    assert!(
        thumbs_dir(&photos_dir)
            .unwrap()
            .read_dir()
            .unwrap()
            .next()
            .is_some(),
        "thumbs must land under the photo drive's .luna-<uuid>-thumbs"
    );
    assert!(
        std::fs::read_dir(&os_data).unwrap().next().is_none(),
        "gallery DB must not land under OS data dir"
    );

    let second = scan("d1", &photos_dir).unwrap();
    assert_eq!(second.found, 1);
    assert_eq!(second.thumbnailed, 0);

    let mounts = vec![("d1".into(), photos_dir.clone())];
    let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(!page.has_more);
}

#[test]
fn scan_sorts_by_exif_not_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let recent = photos_dir.join("recent.png");
    let dated = photos_dir.join("from-phone.jpg");
    std::fs::write(
        &dated,
        crate::gallery::exif::jpeg_with_datetime_original("2010:01:01 00:00:00"),
    )
    .unwrap();
    let png = image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]));
    png.save(&recent).unwrap();

    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir)];
    let page = list_photos(&mounts, Some("d1"), &ListFilter::default(), 10, 0).unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].name, "recent.png");
    assert_eq!(page.items[1].name, "from-phone.jpg");
    assert_eq!(
        page.items[1].taken_at,
        crate::gallery::exif::parse_exif_datetime("2010:01:01 00:00:00").unwrap()
    );
}

#[test]
fn prune_removes_deleted_files() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let a = photos_dir.join("a.png");
    let b = photos_dir.join("b.png");
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 1, 1, 255]));
    png.save(&a).unwrap();
    png.save(&b).unwrap();
    scan("d1", &photos_dir).unwrap();
    std::fs::remove_file(&b).unwrap();
    let report = scan("d1", &photos_dir).unwrap();
    assert_eq!(report.pruned, 1);
    let mounts = vec![("d1".into(), photos_dir)];
    let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].name, "a.png");
}

#[test]
fn favorites_and_albums_live_on_drive() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
    png.save(photos_dir.join("x.png")).unwrap();
    scan("d1", &photos_dir).unwrap();

    set_favorite(&photos_dir, "u1", "x.png", true).unwrap();
    let mounts = vec![("d1".into(), photos_dir.clone())];
    let filter = ListFilter {
        favorites_user: Some("u1".into()),
        user_id: Some("u1".into()),
        ..Default::default()
    };
    let page = list_photos(&mounts, None, &filter, 10, 0).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].favorited);

    let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
    add_album_items(&photos_dir, &album.id, &[("d1".into(), "x.png".into())]).unwrap();
    let empty_members = std::collections::HashMap::new();
    let albums = list_albums(&mounts, "u1", &empty_members, false).unwrap();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0].item_count, 1);

    let in_album = list_photos(
        &mounts,
        None,
        &ListFilter {
            album_membership: Some("any".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(in_album.items.len(), 1);
    assert_eq!(in_album.items[0].path, "x.png");

    let not_in_album = list_photos(
        &mounts,
        None,
        &ListFilter {
            album_membership: Some("none".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert!(not_in_album.items.is_empty());
}

#[test]
fn list_duplicates_groups_same_name_and_size() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
    png.save(photos_dir.join("copy.png")).unwrap();
    std::fs::create_dir(photos_dir.join("other")).unwrap();
    png.save(photos_dir.join("other/copy.png")).unwrap();
    let other = image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]));
    other.save(photos_dir.join("unique.png")).unwrap();
    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir)];
    let groups = list_duplicates(&mounts, 50).unwrap();
    assert!(
        groups
            .iter()
            .any(|g| g.name == "copy.png" && g.items.len() == 2),
        "expected copy.png duplicate group, got {:?}",
        groups
    );
    assert!(!groups.iter().any(|g| g.name == "unique.png"));
}

#[test]
fn oversized_source_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("huge.bin.jpg");
    std::fs::write(&src, vec![0u8; 64]).unwrap();
    assert!(read_capped(&src, 10).is_err());
    assert!(read_capped(&src, 64).is_ok());
}

#[test]
fn merge_lists_across_drives() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
    png.save(a.join("a.png")).unwrap();
    png.save(b.join("b.png")).unwrap();
    scan("da", &a).unwrap();
    scan("db", &b).unwrap();
    let mounts = vec![("da".into(), a), ("db".into(), b)];
    let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
    assert_eq!(page.items.len(), 2);
}

#[test]
fn camera_make_model_indexed_and_filtered() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    std::fs::write(
        photos_dir.join("canon.jpg"),
        crate::gallery::exif::jpeg_with_exif("2020:01:02 03:04:05", Some("Canon"), Some("EOS R5")),
    )
    .unwrap();
    std::fs::write(
        photos_dir.join("nikon.jpg"),
        crate::gallery::exif::jpeg_with_exif(
            "2020:02:03 04:05:06",
            Some("NIKON CORPORATION"),
            Some("NIKON D850"),
        ),
    )
    .unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([4, 4, 4, 255]));
    png.save(photos_dir.join("plain.png")).unwrap();
    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir.clone())];

    let cameras = list_cameras(&mounts, None, &|_, _| true).unwrap();
    assert!(
        cameras
            .iter()
            .any(|c| c.make == "Canon" && c.model == "EOS R5" && c.count >= 1),
        "expected Canon EOS R5 in {cameras:?}"
    );
    assert!(
        cameras
            .iter()
            .any(|c| c.make == "NIKON CORPORATION" && c.model == "NIKON D850" && c.count >= 1),
        "expected Nikon in {cameras:?}"
    );

    let filtered = list_photos(
        &mounts,
        None,
        &ListFilter {
            camera_make: Some("canon".into()),
            camera_model: Some("eos r5".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(filtered.items.len(), 1);
    assert_eq!(filtered.items[0].name, "canon.jpg");
    assert_eq!(filtered.items[0].camera_make, "Canon");
    assert_eq!(filtered.items[0].camera_model, "EOS R5");

    let by_q = list_photos(
        &mounts,
        None,
        &ListFilter {
            q: Some("nikon".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(by_q.items.len(), 1);
    assert_eq!(by_q.items[0].name, "nikon.jpg");
}

#[test]
fn list_cameras_respects_path_grants() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir_all(photos_dir.join("shared")).unwrap();
    std::fs::create_dir_all(photos_dir.join("secret")).unwrap();
    std::fs::write(
        photos_dir.join("shared/canon.jpg"),
        crate::gallery::exif::jpeg_with_exif("2020:01:02 03:04:05", Some("Canon"), Some("EOS R5")),
    )
    .unwrap();
    std::fs::write(
        photos_dir.join("secret/nikon.jpg"),
        crate::gallery::exif::jpeg_with_exif(
            "2020:02:03 04:05:06",
            Some("NIKON CORPORATION"),
            Some("NIKON D850"),
        ),
    )
    .unwrap();
    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir.clone())];
    let mut grants = std::collections::HashMap::new();
    grants.insert("d1".into(), vec!["shared".into()]);
    let cameras = list_cameras(&mounts, Some(&grants), &|_, _| true).unwrap();
    assert!(
        cameras
            .iter()
            .any(|c| c.make == "Canon" && c.model == "EOS R5"),
        "expected Canon under grant: {cameras:?}"
    );
    assert!(
        cameras
            .iter()
            .all(|c| !(c.make == "NIKON CORPORATION" && c.model == "NIKON D850")),
        "Nikon outside grant must not appear: {cameras:?}"
    );
}

#[test]
fn list_cameras_member_missing_drive_key_denies_all() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    std::fs::write(
        photos_dir.join("canon.jpg"),
        crate::gallery::exif::jpeg_with_exif("2020:01:02 03:04:05", Some("Canon"), Some("EOS R5")),
    )
    .unwrap();
    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir)];
    // Member map present but this drive has no entry — must not equal Admin None.
    let grants = std::collections::HashMap::new();
    let cameras = list_cameras(&mounts, Some(&grants), &|_, _| true).unwrap();
    assert!(
        cameras.is_empty(),
        "missing drive key under Some(grants) must deny: {cameras:?}"
    );
    let admin = list_cameras(&mounts, None, &|_, _| true).unwrap();
    assert!(
        admin
            .iter()
            .any(|c| c.make == "Canon" && c.model == "EOS R5"),
        "Admin None still sees cameras: {admin:?}"
    );
}

#[test]
fn list_albums_include_all_returns_every_album() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "home");
    let a = create_album(root, "home", "u1", "Mine").unwrap();
    let b = create_album(root, "home", "u2", "Theirs").unwrap();
    let mounts = vec![("home".into(), root.to_path_buf())];
    let empty = std::collections::HashMap::new();
    let member_view = list_albums(&mounts, "u1", &empty, false).unwrap();
    assert_eq!(member_view.len(), 1);
    assert_eq!(member_view[0].id, a.id);
    let admin_view = list_albums(&mounts, "u1", &empty, true).unwrap();
    assert_eq!(admin_view.len(), 2);
    assert!(admin_view.iter().any(|x| x.id == a.id));
    assert!(admin_view.iter().any(|x| x.id == b.id));

    // An access-member row on the other album makes it visible to u1.
    let mut member_ids = std::collections::HashMap::new();
    member_ids.insert(
        "home".to_string(),
        std::collections::HashSet::from([b.id.clone()]),
    );
    let joined = list_albums(&mounts, "u1", &member_ids, false).unwrap();
    assert_eq!(joined.len(), 2);
}

#[test]
fn list_photos_album_id_without_home_does_not_list_library() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
    png.save(photos_dir.join("private.png")).unwrap();
    png.save(photos_dir.join("shared.png")).unwrap();
    scan("d1", &photos_dir).unwrap();
    let album = create_album(&photos_dir, "d1", "owner", "Shared").unwrap();
    add_album_items(
        &photos_dir,
        &album.id,
        &[("d1".into(), "shared.png".into())],
    )
    .unwrap();
    let mounts = vec![("d1".into(), photos_dir)];

    let leaked = list_photos(
        &mounts,
        None,
        &ListFilter {
            album_id: Some(album.id.clone()),
            album_home_drive: None,
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert!(
        leaked.items.is_empty(),
        "album_id without album home must not return the unfiltered library"
    );

    let scoped = list_photos(
        &mounts,
        None,
        &ListFilter {
            album_id: Some(album.id.clone()),
            album_home_drive: Some("d1".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(scoped.items.len(), 1);
    assert_eq!(scoped.items[0].path, "shared.png");
}

#[test]
fn rich_exif_filters_and_facets() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    std::fs::write(
        photos_dir.join("canon.jpg"),
        crate::gallery::exif::jpeg_with_rich_exif(crate::gallery::exif::RichExifOpts {
            datetime: "2020:01:02 15:04:05",
            make: Some("Canon"),
            model: Some("EOS R5"),
            lens: Some("RF50mm F1.2 L USM"),
            iso: Some(800),
            focal_num: Some(50),
            focal_den: Some(1),
            flash: Some(1),
        }),
    )
    .unwrap();
    std::fs::write(
        photos_dir.join("phone.jpg"),
        crate::gallery::exif::jpeg_with_exif("2020:03:04 05:06:07", Some("Apple"), Some("iPhone")),
    )
    .unwrap();
    let wide = image::RgbaImage::from_pixel(200, 100, image::Rgba([5, 5, 5, 255]));
    wide.save(photos_dir.join("wide.png")).unwrap();

    scan("d1", &photos_dir).unwrap();
    let mounts = vec![("d1".into(), photos_dir.clone())];

    let facets = list_filter_facets(&mounts, None, &|_, _| true).unwrap();
    assert!(
        facets
            .lenses
            .iter()
            .any(|l| l.lens.contains("RF50mm") && l.count >= 1),
        "expected lens facet in {:?}",
        facets.lenses
    );
    assert!(
        facets
            .formats
            .iter()
            .any(|f| f.ext == "jpg" && f.count >= 1),
        "expected jpg format in {:?}",
        facets.formats
    );
    assert!(
        facets
            .formats
            .iter()
            .any(|f| f.ext == "png" && f.count >= 1),
        "expected png format in {:?}",
        facets.formats
    );
    let iso = facets.iso_range.expect("iso_range");
    assert!(iso.min <= 800.0 && iso.max >= 800.0);
    let focal = facets.focal_range.expect("focal_range");
    assert!((focal.min - 50.0).abs() < 0.01);

    let by_lens = list_photos(
        &mounts,
        None,
        &ListFilter {
            lens: Some("RF50mm F1.2 L USM".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(by_lens.items.len(), 1);
    assert_eq!(by_lens.items[0].iso, 800);
    assert!((by_lens.items[0].focal_mm - 50.0).abs() < 0.01);
    assert_eq!(by_lens.items[0].flash, 1);

    let by_iso = list_photos(
        &mounts,
        None,
        &ListFilter {
            iso_min: Some(400),
            iso_max: Some(1600),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(by_iso.items.len(), 1);

    let by_flash = list_photos(
        &mounts,
        None,
        &ListFilter {
            flash: Some(1),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(by_flash.items.len(), 1);

    let landscape = list_photos(
        &mounts,
        None,
        &ListFilter {
            orientation: Some("landscape".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert!(
        landscape.items.iter().any(|p| p.name == "wide.png"),
        "landscape filter missed wide.png: {:?}",
        landscape.items.iter().map(|p| &p.name).collect::<Vec<_>>()
    );

    let pngs = list_photos(
        &mounts,
        None,
        &ListFilter {
            format: Some("png".into()),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert_eq!(pngs.items.len(), 1);
    assert_eq!(pngs.items[0].name, "wide.png");

    let afternoon = list_photos(
        &mounts,
        None,
        &ListFilter {
            hour_from: Some(14),
            hour_to: Some(16),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert!(
        afternoon.items.iter().any(|p| p.name == "canon.jpg"),
        "hour filter missed canon.jpg"
    );

    let undated = list_photos(
        &mounts,
        None,
        &ListFilter {
            undated: Some(true),
            ..Default::default()
        },
        10,
        0,
    )
    .unwrap();
    assert!(
        undated.items.iter().any(|p| p.name == "wide.png"),
        "undated should include PNG without EXIF date"
    );
}

#[test]
fn allocate_contrib_dir_avoids_collisions_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    let album1 = create_album(root, "d1", "user1", "Trip to Paris").unwrap();
    assert!(album1.contrib_path.is_empty(), "starts empty");

    // 1. Initial allocation creates "Shared Photos/Trip to Paris"
    let p1 = allocate_contrib_dir(root, &album1.id, &album1.name).unwrap();
    assert_eq!(p1, "Shared Photos/Trip to Paris");
    assert!(root.join(&p1).is_dir());

    // Calling again reuses the existing path
    let p1_again = allocate_contrib_dir(root, &album1.id, &album1.name).unwrap();
    assert_eq!(p1_again, p1);

    // 2. Pre-create a folder "Shared Photos/Summer Fun" by a user before album2 allocates it
    std::fs::create_dir_all(root.join("Shared Photos/Summer Fun")).unwrap();
    let album2 = create_album(root, "d1", "user1", "Summer Fun").unwrap();
    let p2 = allocate_contrib_dir(root, &album2.id, &album2.name).unwrap();
    assert_eq!(
        p2, "Shared Photos/Summer Fun (2)",
        "must not hijack pre-existing user folder"
    );
    assert!(root.join(&p2).is_dir());

    // 3. Pre-create modifier (3), so album3 jumps to (4)
    std::fs::create_dir_all(root.join("Shared Photos/Summer Fun (3)")).unwrap();
    let album3 = create_album(root, "d1", "user1", "Summer Fun").unwrap();
    let p3 = allocate_contrib_dir(root, &album3.id, &album3.name).unwrap();
    assert_eq!(p3, "Shared Photos/Summer Fun (4)");
    assert!(root.join(&p3).is_dir());
}

#[test]
#[cfg(unix)]
fn allocate_contrib_dir_never_writes_through_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    let album = create_album(root, "d1", "user1", "Trip").unwrap();

    // A planted symlink where a path component should be: "Shared
    // Photos" points outside the contrib namespace. Allocation must
    // refuse to create inside the target rather than follow the link.
    let outside = dir.path().join("elsewhere");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("Shared Photos")).unwrap();
    let err = allocate_contrib_dir(root, &album.id, &album.name)
        .expect_err("symlinked contrib parent must not be followed");
    let _ = err; // any refusal is correct — the target must stay empty
    assert!(
        std::fs::read_dir(&outside).unwrap().next().is_none(),
        "nothing may be created through the planted symlink"
    );

    // A stored contrib path later replaced by a symlink is refused too.
    std::fs::remove_file(root.join("Shared Photos")).unwrap();
    let path = allocate_contrib_dir(root, &album.id, &album.name).unwrap();
    let legit = root.join(&path);
    std::fs::remove_dir_all(&legit).unwrap();
    let hijack = dir.path().join("hijack");
    std::fs::create_dir_all(&hijack).unwrap();
    std::os::unix::fs::symlink(&hijack, &legit).unwrap();
    assert!(
        allocate_contrib_dir(root, &album.id, &album.name).is_err(),
        "contrib dir swapped for a symlink must not be reused"
    );
}

#[test]
fn sniff_media_file_tells_real_media_from_markup() {
    let dir = tempfile::tempdir().unwrap();
    let jpg = dir.path().join("a.jpg");
    std::fs::write(&jpg, [0xFF, 0xD8, 0xFF, 0xE0, 0x00]).unwrap();
    assert!(sniff_media_file(&jpg));

    // HTML bytes named like a photo — the extension lies.
    let fake = dir.path().join("party.jpg");
    std::fs::write(&fake, b"<html><body>not a photo</body></html>").unwrap();
    assert!(!sniff_media_file(&fake));

    let mp4 = dir.path().join("clip.mp4");
    std::fs::write(&mp4, b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00").unwrap();
    assert!(sniff_media_file(&mp4));

    assert!(!sniff_media_file(&dir.path().join("missing.jpg")));
}

#[test]
fn index_one_rejects_markup_named_as_media() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    // A contribution upload that is really markup must not index.
    std::fs::write(root.join("party.jpg"), b"<html><body>x</body></html>").unwrap();
    assert!(
        index_one("d1", root, "party.jpg").unwrap().is_none(),
        "renamed markup must not be accepted as a photo"
    );
    // A real image still indexes.
    let img = image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]));
    img.save(root.join("ok.jpg")).unwrap();
    assert!(index_one("d1", root, "ok.jpg").unwrap().is_some());
}

#[test]
fn write_items_zip_dedupes_names_and_skips_luna_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let a = root.join("a");
    let b = root.join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join("same.jpg"), b"aaa").unwrap();
    std::fs::write(b.join("same.jpg"), b"bbbb").unwrap();
    // A file sitting inside Luna's namespace — never pack it.
    let prefix = luna_core::marker::pick_prefix(root).unwrap();
    let internal_dir = root.join(format!("{prefix}-trash/entry"));
    std::fs::create_dir_all(&internal_dir).unwrap();
    let private = internal_dir.join("private.jpg");
    std::fs::write(&private, b"secret").unwrap();

    let zip_path = root.join("out.zip");
    let file = std::fs::File::create(&zip_path).unwrap();
    let n = write_items_zip(
        &[
            ("same.jpg".into(), a.join("same.jpg")),
            ("same.jpg".into(), b.join("same.jpg")),
            ("private.jpg".into(), private),
        ],
        file,
        10,
    )
    .unwrap();
    assert_eq!(n, 2, "the file inside Luna's namespace must be skipped");

    let archive = std::fs::File::open(&zip_path).unwrap();
    let mut zip = zip::ZipArchive::new(archive).unwrap();
    let names: Vec<String> = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(names.contains(&"same.jpg".to_string()));
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("same (") && n.ends_with(").jpg")),
        "duplicate basename must be made unique, got {names:?}"
    );
    assert!(
        !names.iter().any(|n| n.contains("private")),
        "Luna-internal file must not appear in the zip"
    );
}

#[test]
fn place_label_for_nearest_city_or_coords() {
    assert_eq!(place_label_for(48.86, 2.35), "Paris");
    assert_eq!(place_label_for(40.71, -74.01), "New York City");
    let remote = place_label_for(0.0, 0.0);
    assert!(
        remote.contains('°'),
        "expected coordinate fallback, got {remote}"
    );
}

#[test]
fn q_resolves_places_dates_kinds_and_albums() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    {
        let conn = open_drive_db(root).unwrap();
        // (path, taken_at, kind, lat, lon, city, region, country)
        type PhotoRow = (
            &'static str,
            i64,
            &'static str,
            Option<f64>,
            Option<f64>,
            &'static str,
            &'static str,
            &'static str,
        );
        let rows: &[PhotoRow] = &[
            (
                "seattle.jpg",
                1_694_736_000,
                "image",
                Some(47.61),
                Some(-122.33),
                "Seattle",
                "Washington",
                "United States",
            ),
            (
                "bend.jpg",
                1_665_792_000,
                "image",
                Some(44.06),
                Some(-121.31),
                "Bend",
                "Oregon",
                "United States",
            ),
            (
                "bkk.jpg",
                1_703_462_400,
                "image",
                Some(13.75),
                Some(100.50),
                "Bangkok",
                "Bangkok",
                "Thailand",
            ),
            ("clip.mp4", 1_694_736_000, "video", None, None, "", "", ""),
            ("plain.jpg", 1_694_736_000, "image", None, None, "", "", ""),
        ];
        for (path, taken, kind, lat, lon, city, region, country) in rows {
            conn.execute(
                "INSERT INTO photos
                 (path, name, size, mtime, taken_at, kind, lat, lon,
                  place_label, place_city, place_region, place_country)
                 VALUES (?1, ?1, 100, ?2, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
                params![path, taken, kind, lat, lon, city, region, country],
            )
            .unwrap();
        }
    }
    let album = create_album(root, "d1", "u1", "Camping Trip").unwrap();
    add_album_items(root, &album.id, &[("d1".into(), "seattle.jpg".into())]).unwrap();

    let mounts = vec![("d1".into(), root.to_path_buf())];
    let names = |q: &str| -> Vec<String> {
        list_photos(
            &mounts,
            None,
            &ListFilter {
                q: Some(q.into()),
                ..Default::default()
            },
            50,
            0,
        )
        .unwrap()
        .items
        .iter()
        .map(|p| p.path.clone())
        .collect()
    };

    assert_eq!(names("seattle"), ["seattle.jpg"]);
    assert_eq!(names("oregon"), ["bend.jpg"]);
    assert_eq!(names("thailand"), ["bkk.jpg"]);
    assert_eq!(names("videos"), ["clip.mp4"]);
    assert_eq!(names("christmas"), ["bkk.jpg"]);
    assert_eq!(names("september"), ["clip.mp4", "plain.jpg", "seattle.jpg"]);
    assert_eq!(names("2022"), ["bend.jpg"]);
    assert_eq!(names("no location"), ["clip.mp4", "plain.jpg"]);
    assert_eq!(names("camping trip"), ["seattle.jpg"]);
    // A resolved place keeps its text fallback: files named after a place
    // match even with no GPS.
    assert_eq!(names("bend"), ["bend.jpg"]);
    assert_eq!(names("nowhereville"), Vec::<String>::new());
}

#[test]
fn q_parses_natural_language_dates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    {
        let conn = open_drive_db(root).unwrap();
        let rows: &[(&str, i64)] = &[
            ("sep19-2023.jpg", 1_695_081_600),  // 2023-09-19 UTC
            ("sep19-2024.jpg", 1_726_704_000),  // 2024-09-19 UTC
            ("sep20-2024.jpg", 1_726_790_400),  // 2024-09-20 UTC
            ("easter-2024.jpg", 1_711_843_200), // 2024-03-31 UTC
        ];
        for (path, taken) in rows {
            conn.execute(
                "INSERT INTO photos (path, name, size, mtime, taken_at, kind)
                 VALUES (?1, ?1, 100, ?2, ?2, 'image')",
                params![path, taken],
            )
            .unwrap();
        }
    }
    let mounts = vec![("d1".into(), root.to_path_buf())];
    let names = |q: &str| -> Vec<String> {
        let mut v: Vec<String> = list_photos(
            &mounts,
            None,
            &ListFilter {
                q: Some(q.into()),
                ..Default::default()
            },
            50,
            0,
        )
        .unwrap()
        .items
        .iter()
        .map(|p| p.path.clone())
        .collect();
        v.sort();
        v
    };

    // "september 19" is month+day, not a filename substring — every
    // year's Sep 19 matches.
    let sep19 = ["sep19-2023.jpg", "sep19-2024.jpg"];
    assert_eq!(names("september 19"), sep19);
    assert_eq!(names("sep 19th"), sep19);
    assert_eq!(names("the 19th of september"), sep19);
    assert_eq!(names("the 19th"), sep19);
    assert_eq!(names("9/19"), sep19);
    // With a year it narrows to one date.
    assert_eq!(names("september 19 2024"), ["sep19-2024.jpg"]);
    assert_eq!(names("19/9/2024"), ["sep19-2024.jpg"]);
    assert_eq!(names("easter 2024"), ["easter-2024.jpg"]);
}

#[test]
fn month_day_matches_same_day_across_years() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    adopt(root, "d1");
    {
        let conn = open_drive_db(root).unwrap();
        // (path, mtime, taken_at) — same UTC month-day across years, one
        // neighbor day, and an undated row whose mtime falls on the day.
        let rows: &[(&str, i64, i64)] = &[
            ("pi-2022.jpg", 1_647_216_000, 1_647_216_000), // 2022-03-14 UTC
            ("pi-2024.jpg", 1_710_417_600, 1_710_417_600), // 2024-03-14 12:00 UTC
            ("other.jpg", 1_678_838_400, 1_678_838_400),   // 2023-03-15 UTC
            ("undated.png", 1_710_374_400, 0),             // mtime 2024-03-14
        ];
        for (path, mtime, taken) in rows {
            conn.execute(
                "INSERT INTO photos (path, name, size, mtime, taken_at, kind)
                 VALUES (?1, ?1, 100, ?2, ?3, 'image')",
                params![path, mtime, taken],
            )
            .unwrap();
        }
    }
    let mounts = vec![("d1".into(), root.to_path_buf())];
    let paths = |month_day: Option<&str>| -> Vec<String> {
        let mut v: Vec<String> = list_photos(
            &mounts,
            None,
            &ListFilter {
                month_day: month_day.map(str::to_string),
                ..Default::default()
            },
            50,
            0,
        )
        .unwrap()
        .items
        .iter()
        .map(|p| p.path.clone())
        .collect();
        v.sort();
        v
    };

    assert_eq!(
        paths(Some("03-14")),
        ["pi-2022.jpg", "pi-2024.jpg", "undated.png"]
    );
    assert_eq!(paths(Some("03-15")), ["other.jpg"]);
    // Garbage is ignored rather than narrowing the list to nothing.
    assert_eq!(
        paths(Some("3-14")).len(),
        4,
        "invalid month_day must not filter"
    );
    assert_eq!(paths(Some("13-40")).len(), 4);
    assert_eq!(paths(None).len(), 4);
}

#[test]
fn add_album_items_sets_cover_drive_id() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
    png.save(photos_dir.join("x.png")).unwrap();
    scan("d1", &photos_dir).unwrap();
    let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
    add_album_items(&photos_dir, &album.id, &[("d1".into(), "x.png".into())]).unwrap();
    let got = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
    assert_eq!(got.cover_path, "x.png");
    assert_eq!(got.cover_drive_id, "d1");
    assert!(!got.cover_thumb.is_empty());
    remove_album_item(&photos_dir, &album.id, "d1", "x.png").unwrap();
    let cleared = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
    assert!(cleared.cover_path.is_empty());
    assert!(cleared.cover_drive_id.is_empty());
}

#[test]
fn update_album_sets_cover() {
    let dir = tempfile::tempdir().unwrap();
    let photos_dir = dir.path().join("photos");
    std::fs::create_dir(&photos_dir).unwrap();
    let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
    png.save(photos_dir.join("cover.png")).unwrap();
    scan("d1", &photos_dir).unwrap();
    let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
    add_album_items(&photos_dir, &album.id, &[("d1".into(), "cover.png".into())]).unwrap();
    update_album(
        &photos_dir,
        &album.id,
        None,
        None,
        Some(("d1".into(), "cover.png".into())),
    )
    .unwrap();
    let got = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
    assert_eq!(got.cover_path, "cover.png");
    assert_eq!(got.cover_drive_id, "d1");
}
