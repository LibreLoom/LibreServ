//! Public bytes: single files, album pages and photos, and zip downloads for
//! folder and album links.

use super::*;

/// `GET /s/{token}/file?path=&download=` — bytes of a file inside the link.
pub(super) async fn public_file(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_PATH || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let rel = scoped_child(
            &link,
            query.path.as_deref().unwrap_or(""),
            json_error(
                StatusCode::BAD_REQUEST,
                "That file isn't part of this shared link.",
            ),
        )?;
        let is_file = {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_read(
                &conn,
                &link,
                &rel,
                &json_error(
                    StatusCode::NOT_FOUND,
                    "The shared file isn't available right now.",
                ),
            )
            .map(|(_, m)| m.is_file())?
        };
        if !is_file {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That's a folder. Use Download to save it as a zip file.",
            ));
        }
        serve_file(
            &state,
            &link.drive_id,
            &rel,
            query.download.unwrap_or(0) != 0,
        )
        .await
    })
    .await
}

// --- Album public surface --------------------------------------------------

pub(super) fn album_media_urls(
    token: &str,
    drive_id: &str,
    path: &str,
) -> (String, String, String) {
    let enc = urlencoding_lite(path);
    let base = format!("/s/{token}/media?drive_id={drive_id}&path={enc}");
    (
        format!("{base}&variant=thumb"),
        format!("{base}&variant=content"),
        format!("{base}&variant=download"),
    )
}

pub(super) fn urlencoding_lite(input: &str) -> String {
    let mut out = String::new();
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Resolve the album a link points at: (home drive root, album).
pub(super) fn album_for_link(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
) -> Result<(PathBuf, crate::gallery::Album), ApiError> {
    let (root, album) = resolve_album(conn, &link.drive_id, &link.album_id)?;
    album.map(|a| (root, a)).ok_or_else(gone)
}

#[derive(Deserialize)]
pub(super) struct PublicItemsQuery {
    #[serde(default)]
    pub(super) limit: Option<u32>,
    #[serde(default)]
    pub(super) offset: Option<u32>,
}

/// `GET /s/{token}/items` — album photo page for the public gallery view.
pub(super) async fn public_items(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicItemsQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_ALBUM || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let (mounts, album) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let (_root, album) = album_for_link(&conn, &link)?;
            let mounts = mounted_drives(&conn);
            (mounts, album)
        };
        let limit = query.limit.unwrap_or(80).clamp(1, 200);
        let offset = query.offset.unwrap_or(0);
        let filter = crate::gallery::ListFilter {
            album_id: Some(album.id.clone()),
            album_home_drive: Some(link.drive_id.clone()),
            ..Default::default()
        };
        let page =
            crate::gallery::list_photos(&mounts, None, &filter, limit, offset).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't load photos for this album.",
                )
            })?;
        let items: Vec<Value> = page
            .items
            .into_iter()
            .map(|mut p| {
                let (thumb, content, download) = album_media_urls(&token, &p.drive_id, &p.path);
                p.thumb = thumb;
                let mut v = json!(p);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("content".into(), json!(content));
                    obj.insert("download".into(), json!(download));
                }
                v
            })
            .collect();
        Ok(Json(json!({
            "kind": "album",
            "name": album.name,
            "item_count": album.item_count,
            "caps": caps_to_str(link.caps),
            "items": items,
            "has_more": page.has_more,
            "next_offset": page.next_offset,
        }))
        .into_response())
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PublicMediaQuery {
    pub(super) drive_id: String,
    pub(super) path: String,
    #[serde(default)]
    pub(super) variant: Option<String>,
}

/// `GET /s/{token}/media?drive_id&path&variant=thumb|content|download`.
pub(super) async fn public_media(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicMediaQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_ALBUM || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let (home_root, album) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            album_for_link(&conn, &link)?
        };
        if !crate::api::gallery::album_item_allowed(
            &link.drive_id,
            &home_root,
            &album,
            &query.drive_id,
            &query.path,
        ) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "That photo is not part of this shared album.",
            ));
        }
        let mount = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let drive = db::get_drive(&conn, &query.drive_id)
                .map_err(|_| busy())?
                .filter(|d| !d.mount_point.is_empty())
                .ok_or_else(|| {
                    json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo.")
                })?;
            PathBuf::from(&drive.mount_point)
        };
        match query.variant.as_deref().unwrap_or("content") {
            "thumb" => {
                let Some(thumb_path) =
                    crate::gallery::thumb_path(&mount, &query.drive_id, &query.path)
                else {
                    return Err(json_error(
                        StatusCode::NOT_FOUND,
                        "That photo is not part of this shared album.",
                    ));
                };
                if !thumb_path.exists() {
                    let drive_id = query.drive_id.clone();
                    let path = query.path.clone();
                    let mount2 = mount.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let src = luna_core::path::resolve_child(&mount2, &path).ok()?;
                        let dest = crate::gallery::thumb_path(&mount2, &drive_id, &path)?;
                        let kind = if crate::gallery::is_video(&src) {
                            "video"
                        } else {
                            "image"
                        };
                        crate::gallery::ensure_thumb(&src, &dest, kind).ok()
                    })
                    .await;
                }
                crate::api::gallery::serve_thumb(thumb_path).await
            }
            "download" => {
                let abs = luna_core::path::resolve_child(&mount, &query.path).map_err(|_| {
                    json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo.")
                })?;
                let name = files::leaf_of(&abs).unwrap_or_else(|| "download".into());
                let mime = mime_guess::from_path(&name)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string();
                crate::api::gallery::serve_media_path(abs, &mime, &name, "attachment", &headers)
                    .await
            }
            _ => {
                let (abs, content_type, filename) = crate::api::gallery::resolve_browser_safe_file(
                    &mount,
                    &query.drive_id,
                    &query.path,
                )
                .await?;
                crate::api::gallery::serve_media_path(
                    abs,
                    &content_type,
                    &filename,
                    "inline",
                    &headers,
                )
                .await
            }
        }
    })
    .await
}

/// `GET /s/{token}/zip` — folder link → folder zip; album link → album zip;
/// file link → the file itself.
pub(super) async fn public_zip(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        if link.subject_kind == KIND_ALBUM {
            return album_zip_response(&state, &link).await;
        }
        let rel = scoped_child(
            &link,
            query.path.as_deref().unwrap_or(""),
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ),
        )?;
        // Confined here, before the walk: the zip walker skips symlinked
        // children itself, but the walked root must also be verified inside
        // the canonical link root or a symlinked folder would zip the outside.
        let is_dir = {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_read(
                &conn,
                &link,
                &rel,
                &json_error(
                    StatusCode::NOT_FOUND,
                    "The shared files aren't available right now.",
                ),
            )
            .map(|(_, m)| m.is_dir())?
        };
        if !is_dir {
            return serve_file(&state, &link.drive_id, &rel, true).await;
        }
        folder_zip_response(&state, &link, &rel).await
    })
    .await
}

pub(super) async fn folder_zip_response(
    state: &AppState,
    link: &AccessLinkRow,
    rel: &str,
) -> Result<Response, ApiError> {
    let zip_name = {
        let conn = state.db.lock().map_err(|_| busy())?;
        let base = if rel == files::TRASH_API_ALIAS {
            "trash".to_string()
        } else {
            files::trash_api_leaf(&conn, &link.drive_id, rel)
                .ok()
                .flatten()
                .unwrap_or_else(|| files::zip_archive_basename(rel))
        };
        format!("{base}.zip")
    };
    let drive_id = link.drive_id.clone();
    let scope = link.path.clone();
    let link = link.clone();
    let rel_owned = rel.to_string();
    let state = state.clone();
    crate::api::gallery::stream_zip_response(&zip_name, move |tmp_path| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(tmp_path)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that folder download. Try again.",
                )
            })?;
        let conn = state.db.lock().map_err(|_| busy())?;
        files::write_folder_zip_including_trash(&conn, &drive_id, &rel_owned, &mut file, |child| {
            path_contains(&scope, child) && link_reaches(&conn, &link, child)
        })
        .map(|_| ())
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("folder too large") {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder has too many files to download as one zip. Download smaller folders instead.",
                )
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that folder download. Try again.",
                )
            }
        })
    })
    .await
}

pub(super) async fn album_zip_response(
    state: &AppState,
    link: &AccessLinkRow,
) -> Result<Response, ApiError> {
    let (home_root, album) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        album_for_link(&conn, link)?
    };
    let refs = crate::gallery::list_album_item_refs(&home_root, &album.id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that album.",
        )
    })?;
    if refs.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This album has no photos to download yet.",
        ));
    }
    if refs.len() > PUBLIC_ALBUM_ZIP_MAX {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "This album has too many photos to download as one zip (limit {PUBLIC_ALBUM_ZIP_MAX})."
            ),
        ));
    }
    let mut entries: Vec<(String, PathBuf)> = Vec::with_capacity(refs.len());
    {
        let conn = state.db.lock().map_err(|_| busy())?;
        for (drive_id, path) in refs {
            if !crate::api::gallery::album_item_allowed(
                &link.drive_id,
                &home_root,
                &album,
                &drive_id,
                &path,
            ) {
                continue;
            }
            let Ok(Some(drive)) = db::get_drive(&conn, &drive_id) else {
                continue;
            };
            if drive.mount_point.is_empty() {
                continue;
            }
            let mount = PathBuf::from(&drive.mount_point);
            let Ok(abs) = luna_core::path::resolve_child(&mount, &path) else {
                continue;
            };
            if !abs.is_file() {
                continue;
            }
            entries.push((crate::api::gallery::zip_entry_name(&drive_id, &path), abs));
        }
    }
    if entries.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This album has no photos to download yet.",
        ));
    }
    let zip_name = {
        let base = files::content_disposition_filename(&album.name);
        if base == "download" || base.is_empty() {
            "album.zip".into()
        } else {
            format!("{base}.zip")
        }
    };
    crate::api::gallery::stream_zip_response(&zip_name, move |tmp_path| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(tmp_path)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that download. Try again.",
                )
            })?;
        crate::gallery::write_items_zip(&entries, &mut file, PUBLIC_ALBUM_ZIP_MAX).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("too many files") {
                json_error(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "This album has too many photos to download as one zip (limit {PUBLIC_ALBUM_ZIP_MAX})."
                    ),
                )
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that download. Try again.",
                )
            }
        })?;
        Ok(())
    })
    .await
}

pub(super) async fn serve_file(
    state: &AppState,
    drive_id: &str,
    rel: &str,
    download: bool,
) -> Result<Response, ApiError> {
    // Open against a re-verified descriptor so a mid-request symlink swap on
    // the drive cannot read outside the jail.
    let (file, path) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        let drive = db::get_drive(&conn, drive_id)
            .map_err(|_| busy())?
            .filter(|d| !d.mount_point.is_empty())
            .ok_or_else(|| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "The shared file isn't available right now.",
                )
            })?;
        let root = PathBuf::from(&drive.mount_point);
        luna_core::path::open_verified(&root, rel).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared file isn't available right now.",
            )
        })?
    };
    let file = tokio::fs::File::from_std(file);
    let meta = std::fs::metadata(&path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared file isn't available right now.",
        )
    })?;
    let name = files::leaf_of(&path).unwrap_or_else(|| "download".into());
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let disposition = if !download && files::inline_safe(mime.as_ref()) {
        "inline"
    } else {
        "attachment"
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                files::content_disposition_filename(&name)
            ),
        )
        .body(Body::from_stream(stream))
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this link.",
            )
        })
}
