//! The public share surface (`/s/{token}`): proof cookies, root and list
//! pages, public uploads, and the guest file operations a link allows.

use super::*;

// ---------------------------------------------------------------------------
// Public surface (/s/{token})
// ---------------------------------------------------------------------------

pub(super) fn link_cookie_name(link_id: &str) -> String {
    format!("luna_link_{link_id}")
}

pub(super) fn link_proof_subject(link: &AccessLinkRow) -> String {
    format!(
        "{}:{}",
        link.id,
        blake3::hash(link.password_hash.as_bytes()).to_hex()
    )
}

pub(super) fn proof_from_cookie(headers: &HeaderMap, link_id: &str) -> Option<String> {
    let want = format!("{}=", link_cookie_name(link_id));
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(&want).map(str::to_string))
}

pub(super) fn gone() -> ApiError {
    json_error(StatusCode::GONE, "This link has expired or been removed.")
}

pub(super) fn needs_password() -> ApiError {
    json_error(StatusCode::UNAUTHORIZED, "This link needs its password.")
}

/// Look up a link by raw token, enforce expiry, and check the password via
/// `X-Share-Password` or the proof cookie. Returns the row plus a fresh proof
/// JWT to set as a cookie when the password arrived by header.
pub(crate) fn resolve_public_link(
    state: &AppState,
    ip: &SocketAddr,
    token: &str,
    headers: &HeaderMap,
) -> Result<(AccessLinkRow, Option<String>), ApiError> {
    let link = {
        let conn = state.db.lock().map_err(|_| busy())?;
        db::get_access_link_by_token_hash(&conn, blake3::hash(token.as_bytes()).to_hex().as_ref())
            .map_err(|_| busy())?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "This link doesn't exist."))?
    };
    if access::link_expired(&link) {
        return Err(gone());
    }
    if link.subject_kind == KIND_PATH {
        let conn = state.db.lock().map_err(|_| busy())?;
        if private_wall(&conn, &link.drive_id, &link.path).is_some_and(|b| {
            crate::private::owner_state(&conn, &b.owner) == crate::private::OwnerState::Deleted
        }) {
            return Err(gone());
        }
    }
    if link.password_hash.is_empty() {
        return Ok((link, None));
    }
    if let Some(proof) = proof_from_cookie(headers, &link.id)
        && state
            .auth
            .verify_link_proof(&link_proof_subject(&link), &proof)
    {
        return Ok((link, None));
    }
    let ip = crate::api::auth::client_ip(ip, headers).to_string();
    if state.share_auth.is_locked(&link.id, &ip) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong passwords. Wait a few minutes and try again.",
        ));
    }
    let provided = headers
        .get("x-share-password")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty());
    let Some(password) = provided else {
        return Err(needs_password());
    };
    let parsed = argon2::password_hash::PasswordHash::new(&link.password_hash).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open this link.",
        )
    })?;
    if auth::verify_password_hash(password, &parsed).is_err() {
        state.share_auth.record_failure(&link.id, &ip);
        return Err(needs_password());
    }
    state.share_auth.clear_success(&link.id, &ip);
    let proof = state
        .auth
        .issue_link_proof(&link_proof_subject(&link), LINK_PROOF_TTL)
        .ok();
    Ok((link, proof))
}

/// Attach the proof cookie (when a header password just verified) and the
/// link-wide no-referrer policy to a public response. `link_id` names the
/// cookie; it is unused when `proof` is `None`.
pub(crate) fn finish_public(
    res: Result<Response, ApiError>,
    link_id: &str,
    proof: Option<String>,
    headers: &HeaderMap,
) -> Response {
    let mut res = match res {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    if let Some(proof) = proof {
        let mut cookie = format!(
            "{}={}; Path=/s; HttpOnly; SameSite=Lax; Max-Age={LINK_PROOF_TTL}",
            link_cookie_name(link_id),
            proof
        );
        if auth::request_is_https(headers) {
            cookie.push_str("; Secure");
        }
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // Shared contents must not outlive a permission downgrade in a cache.
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Every public handler follows the same shape: resolve + authenticate the
/// link, run the body, wrap with the proof cookie and no-referrer policy.
pub(crate) async fn run_public<F, Fut>(
    state: &AppState,
    addr: &SocketAddr,
    token: &str,
    headers: &HeaderMap,
    body: F,
) -> Response
where
    F: FnOnce(AppState, AccessLinkRow) -> Fut,
    Fut: std::future::Future<Output = Result<Response, ApiError>>,
{
    match resolve_public_link(state, addr, token, headers) {
        Err(e) => finish_public(Err(e), "", None, headers),
        Ok((link, proof)) => {
            let id = link.id.clone();
            finish_public(body(state.clone(), link).await, &id, proof, headers)
        }
    }
}

pub(super) fn prefers_html(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let html = accept.find("text/html");
    let json = accept.find("application/json");
    match (html, json) {
        (Some(h), Some(j)) => h < j,
        (Some(_), None) => true,
        _ => false,
    }
}

pub(super) fn accept_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("application/json"))
}

/// Join a path under the link's root. Rejects `..` and absolute paths so a
/// public link cannot walk the rest of the drive.
pub(super) fn child_under_link(link_path: &str, rel: &str) -> Option<String> {
    let extra = rel.trim();
    if extra.starts_with('/') {
        return None;
    }
    if extra.is_empty() {
        return Some(link_path.trim_start_matches('/').to_string());
    }
    let requested = FsPath::new(extra);
    if requested.is_absolute() {
        return None;
    }
    for component in requested.components() {
        // CurDir slips through too: `path/./` would resolve back to the link
        // root, and callers must never see the root as a mutable child.
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir | Component::CurDir
        ) {
            return None;
        }
    }
    if link_path.is_empty() {
        Some(extra.to_string())
    } else {
        Some(format!("{}/{}", link_path.trim_end_matches('/'), extra))
    }
}

/// The rejection every confinement failure shares — a 404, same as a path
/// that simply doesn't exist, so a guest cannot probe beyond the link scope.
pub(super) fn not_in_share() -> ApiError {
    json_error(
        StatusCode::NOT_FOUND,
        "That item isn't part of this shared link.",
    )
}

/// `child_under_link` plus the privacy boundaries: a link whose own subject
/// is not inside `.luna-trash` must never reach into it — a whole-drive view
/// link could otherwise list and zip every deleted file on the drive. The
/// lexical-join error keeps the caller's message (`lexical_err`); boundary
/// hits answer 404.
pub(super) fn scoped_child(
    link: &AccessLinkRow,
    rel: &str,
    lexical_err: ApiError,
) -> Result<String, ApiError> {
    let joined = child_under_link(&link.path, rel).ok_or(lexical_err)?;
    if files::is_trash_api(&joined) && !files::is_trash_api(&link.path) {
        return Err(not_in_share());
    }
    Ok(joined)
}

#[derive(Deserialize)]
pub(super) struct PublicRootQuery {
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) download: Option<u8>,
    #[serde(default)]
    pub(super) meta: Option<u8>,
}

pub(super) async fn public_root(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicRootQuery>,
    headers: HeaderMap,
) -> Response {
    if prefers_html(&headers) && query.download.unwrap_or(0) == 0 && query.meta.unwrap_or(0) == 0 {
        return crate::system::staticweb::handle("");
    }
    run_public(&state, &addr, &token, &headers, async |state, link| {
        public_root_inner(&state, &link, &query, &headers).await
    })
    .await
}

pub(super) async fn public_root_inner(
    state: &AppState,
    link: &AccessLinkRow,
    query: &PublicRootQuery,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    if link.caps & CAP_RESPOND != 0 {
        return crate::api::forms::public_form_document(state, &link.drive_id, &link.path);
    }
    if link.subject_kind == KIND_ALBUM {
        let conn = state.db.lock().map_err(|_| busy())?;
        let (_root, album) = resolve_album(&conn, &link.drive_id, &link.album_id)?;
        let album = album.ok_or_else(gone)?;
        return Ok(Json(json!({
            "kind": "album",
            "name": album.name,
            "item_count": album.item_count,
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    // Path subjects: upload-only links are drop boxes — never reveal names.
    if link.caps & CAP_VIEW == 0 {
        if query.path.as_deref().is_some_and(|p| !p.trim().is_empty()) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ));
        }
        return Ok(Json(json!({
            "kind": "dropbox",
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    let (meta, rel, name) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        let rel = scoped_child(
            link,
            query.path.as_deref().unwrap_or(""),
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ),
        )?;
        // Canonical confinement: a symlink inside the share cannot point a
        // guest outside the link root.
        let (_resolved, meta) = confined_read(
            &conn,
            link,
            &rel,
            &json_error(
                StatusCode::NOT_FOUND,
                "The shared files aren't available right now.",
            ),
        )?;
        // Trash entries carry generated `{nonce}-` names on disk — the link
        // page shows the same clean name members see.
        let name = if rel == files::TRASH_API_ALIAS {
            "Trash".to_string()
        } else {
            files::trash_api_leaf(&conn, &link.drive_id, &rel)
                .ok()
                .flatten()
                .or_else(|| {
                    rel.rsplit('/')
                        .next()
                        .filter(|n| !n.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "download".to_string())
        };
        (meta, rel, name)
    };
    if meta.is_dir() {
        return Ok(Json(json!({
            "kind": "folder",
            "name": name,
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    if query.meta.unwrap_or(0) != 0 || accept_json(headers) {
        return Ok(Json(json!({
            "kind": "file",
            "name": name,
            "size": meta.len(),
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    serve_file(
        state,
        &link.drive_id,
        &rel,
        query.download.unwrap_or(0) != 0,
    )
    .await
}

#[derive(Deserialize)]
pub(super) struct PublicListQuery {
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) download: Option<u8>,
}

/// `GET /s/{token}/list?path=` — entries of a folder inside a viewable link.
pub(super) async fn public_list(
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
        let conn = state.db.lock().map_err(|_| busy())?;
        let rel = scoped_child(
            &link,
            query.path.as_deref().unwrap_or(""),
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ),
        )?;
        let (_resolved, meta) = confined_read(
            &conn,
            &link,
            &rel,
            &json_error(
                StatusCode::NOT_FOUND,
                "The shared folder isn't available right now.",
            ),
        )?;
        if !meta.is_dir() {
            // A file link's "folder" is the file itself — the guest file
            // browser lists a one-entry root so the shared file renders like
            // any other row and opens in the real viewer.
            if rel == link.path {
                let mut entry = files::stat(&conn, &link.drive_id, &rel).map_err(|_| {
                    json_error(
                        StatusCode::NOT_FOUND,
                        "The shared file isn't available right now.",
                    )
                })?;
                // A symlinked shared file must not leak its absolute host
                // path to the guest.
                entry.link_target = None;
                return Ok(Json(json!({ "entries": [entry] })).into_response());
            }
            return Err(json_error(StatusCode::BAD_REQUEST, "That isn't a folder."));
        }
        let mut entries = if files::is_trash_api(&rel) {
            files::list_trash_dir(&conn, &link.drive_id, &rel).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this folder.",
                )
            })?
        } else {
            files::list_dir(&conn, &link.drive_id, &rel).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this folder.",
                )
            })?
        };
        retain_reachable(&conn, &link, &rel, &mut entries);
        // Guests never see where a symlink points — it can be an absolute
        // host path — and have no use for the private flag.
        for entry in &mut entries {
            entry.link_target = None;
            entry.private = false;
        }
        if rel == files::TRASH_API_ALIAS {
            // Same clean names members get — the on-disk `{nonce}-` prefix
            // is storage noise, never a label.
            let root = files::drive_root(&conn, &link.drive_id)
                .map(|d| std::path::PathBuf::from(d.mount_point))
                .unwrap_or_default();
            let meta_map = files::trash_meta_map(&root);
            for entry in &mut entries {
                entry.original_name = Some(match meta_map.get(&entry.name) {
                    Some(meta) => meta
                        .original_path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&meta.original_path)
                        .to_string(),
                    None => files::original_name_from_trash(&entry.name),
                });
            }
        }
        Ok(Json(json!({
            "entries": entries
                .into_iter()
                .filter(|e| !e.hidden && !files::is_internal_temp(&e.name))
                .collect::<Vec<_>>(),
        }))
        .into_response())
    })
    .await
}

// --- Public uploads ---------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct PublicUploadCreate {
    pub(super) name: String,
    pub(super) size: u64,
    /// Subfolder inside a folder link; ignored for drop boxes and albums.
    #[serde(default)]
    pub(super) path: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct PublicUploadCompleteQuery {
    pub(super) overwrite: Option<String>,
    pub(super) hash: Option<String>,
    /// Diagram saves name the last live edit in the file. See `UploadQuery`.
    pub(super) coverage: Option<String>,
}

pub(crate) fn require_link_view(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_VIEW != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link is for dropping files off — it doesn't open what others have added.",
        ))
    }
}

pub(crate) fn require_link_edit(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_EDIT != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link doesn't allow changes. Ask for a link that allows editing.",
        ))
    }
}

pub(super) fn require_link_upload(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_UPLOAD != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link is view-only, so it can't receive files. Ask for a link that allows uploads.",
        ))
    }
}

pub(super) fn mounted_drives(conn: &rusqlite::Connection) -> Vec<(String, PathBuf)> {
    db::list_drives(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
        .map(|d| (d.id, PathBuf::from(d.mount_point)))
        .collect()
}

/// Where an upload through `link` lands. Folder links: inside the shared
/// folder (or a subfolder the guest browsed to). File links: replace the
/// shared file. Album links: the album's contribution folder. Returns
/// `(drive_id, dest_dir, name_override)`.
pub(super) fn upload_dest(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    rel: Option<&str>,
) -> Result<(String, String, Option<String>), ApiError> {
    if link.subject_kind == KIND_ALBUM {
        let (root, album) = album_for_link(conn, link)?;
        let contrib = if album.contrib_path.trim().is_empty() {
            crate::gallery::allocate_contrib_dir(&root, &album.id, &album.name).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare the upload folder.",
                )
            })?
        } else {
            album.contrib_path.clone()
        };
        std::fs::create_dir_all(root.join(&contrib)).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare the upload folder.",
            )
        })?;
        return Ok((link.drive_id.clone(), contrib, None));
    }
    let (link_root_abs, meta) =
        files::resolve_any(conn, &link.drive_id, &link.path).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared folder isn't available right now.",
            )
        })?;
    if meta.is_dir() {
        // Drop boxes always land at the share root — letting a blind uploader
        // name a subfolder would let them probe which folders exist.
        let rel = if link.caps & CAP_VIEW == 0 { None } else { rel };
        let dest = scoped_child(
            link,
            rel.unwrap_or(""),
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ),
        )?;
        let (dest_abs, dest_meta) =
            files::resolve_any(conn, &link.drive_id, &dest).map_err(|_| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "That folder isn't part of this shared link.",
                )
            })?;
        if !dest_meta.is_dir() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Uploads can only go into a folder.",
            ));
        }
        // Canonical confinement: a symlinked folder inside the share must
        // never receive an upload that lands outside the link root, and a
        // folder link stops at a private item inside it.
        if !inside_link_root(&link_root_abs, true, &dest_abs) || !link_reaches(conn, link, &dest) {
            return Err(not_in_share());
        }
        Ok((link.drive_id.clone(), dest, None))
    } else {
        // Full-access link to a single file: uploading replaces that file.
        let parent = link
            .path
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();
        let name = link
            .path
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "Luna can't work out which file this link points at.",
                )
            })?
            .to_string();
        // The replacement must land exactly on the shared file — a symlinked
        // parent directory would redirect the write outside the share.
        let (parent_abs, parent_meta) =
            files::resolve_any(conn, &link.drive_id, &parent).map_err(|_| not_in_share())?;
        if !parent_meta.is_dir() || link_root_abs.parent() != Some(parent_abs.as_path()) {
            return Err(not_in_share());
        }
        Ok((link.drive_id.clone(), parent, Some(name)))
    }
}

/// An upload session belongs to a link when it lands in the link's scope:
/// inside the shared folder tree, replacing the shared file, or in the
/// album's contribution folder.
pub(super) fn upload_in_link_scope(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    drive_id: &str,
    dest_path: &str,
    name: &str,
) -> bool {
    if link.drive_id != drive_id {
        return false;
    }
    if link.subject_kind == KIND_ALBUM {
        return album_for_link(conn, link)
            .map(|(_, album)| !album.contrib_path.is_empty() && dest_path == album.contrib_path)
            .unwrap_or(false);
    }
    let lexical_ok = if link.path.is_empty() {
        true // whole-drive link covers every folder
    } else {
        let base = link.path.trim_end_matches('/');
        if dest_path == base || dest_path.starts_with(&format!("{base}/")) {
            true
        } else {
            // File link: the upload lands in the parent dir under the shared name.
            let joined = if dest_path.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", dest_path.trim_end_matches('/'), name)
            };
            joined == base
        }
    };
    if !lexical_ok {
        return false;
    }
    // Canonical confinement: a symlinked folder inside the share must never
    // receive an upload that lands outside the link root.
    let Ok(drive) = files::drive_root(conn, drive_id) else {
        return false;
    };
    let drive_root = PathBuf::from(&drive.mount_point);
    let Ok((root, root_meta)) =
        files::resolve_any_including_trash(conn, &link.drive_id, &link.path)
    else {
        return false;
    };
    let Ok(real_dest) = files::real_rel_path(conn, drive_id, dest_path) else {
        return false;
    };
    let Ok(dest_abs) = luna_core::path::resolve_child_nofollow(&drive_root, &real_dest) else {
        return false;
    };
    if root_meta.is_dir() {
        inside_link_root(&root, true, &dest_abs) && link_reaches(conn, link, dest_path)
    } else {
        // File link: the destination dir must be the shared file's real
        // parent — anything else lands the bytes on a different file.
        root.parent().is_some_and(|p| dest_abs == p)
    }
}

pub(super) async fn public_upload_create(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicUploadCreate>,
) -> Response {
    // Guest uploads open writable sessions on real drives; cap how many one
    // client can start so a drop box can't fill the disk with half-uploads.
    // `client_ip` resolves the real guest behind trusted proxies only.
    if !state.share_limiter.allow(&format!(
        "upload:{}",
        crate::api::auth::client_ip(&addr, &headers)
    )) {
        return finish_public(
            Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many uploads from this address just now. Wait a minute and try again.",
            )),
            "",
            None,
            &headers,
        );
    }
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        if body.size > MAX_FILE_BYTES {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Luna can't accept files larger than 1 TB.",
            ));
        }
        let name = files::safe_name(&body.name).map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "That file name can't be used. Try renaming it.",
            )
        })?;
        let (drive_id, dest, name_override) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let (drive_id, dest, name_override) = upload_dest(&conn, &link, body.path.as_deref())?;
            if link.subject_kind == KIND_ALBUM
                && !crate::gallery::is_media(std::path::Path::new(&name))
            {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    "Only photos and videos can go in this album.",
                ));
            }
            (drive_id, dest, name_override)
        };
        let upload = {
            let conn = state.db.lock().map_err(|_| busy())?;
            uploads::create_scoped(
                &conn,
                &drive_id,
                &dest,
                name_override.as_deref().unwrap_or(&name),
                body.size,
                &format!("link:{}", link.id),
            )
            .map_err(map_upload_err)?
        };
        Ok(Json(json!({
            "upload_id": upload.id,
            "received": upload.received,
            "size": upload.size,
            "name": upload.name,
        }))
        .into_response())
    })
    .await
}

/// Fetch the upload row and verify it belongs to this link.
pub(super) fn scoped_upload(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    upload_id: &str,
) -> Result<db::UploadRow, ApiError> {
    let row = uploads::get_row(conn, upload_id).map_err(map_upload_err)?;
    // The session must belong to this link — path scope alone would let one
    // link drive another's upload (or a member's) inside the same folder.
    if row.principal != format!("link:{}", link.id) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    if !upload_in_link_scope(conn, link, &row.drive_id, &row.path, &row.name) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    Ok(row)
}

pub(super) async fn public_upload_chunk(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?;
        }
        let spec = headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "Each chunk needs a Content-Range header (bytes start-end/total).",
                )
            })?;
        let range = spec
            .strip_prefix("bytes ")
            .and_then(|rest| rest.split('/').next())
            .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
        let (start, end) = crate::api::files::parse_range(&format!("bytes={range}"), MAX_FILE_BYTES)
            .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
        let expected = (end - start + 1) as usize;
        if body.len() != expected {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "The chunk size doesn't match its range.",
            ));
        }
        let chunk_max = crate::budget::limits().upload_chunk_bytes;
        if body.len() > chunk_max {
            return Err(json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "That upload chunk is too large for the free memory on this Luna. Try a smaller piece, or free some space and try again.",
            ));
        }
        let received = uploads::write_chunk(&state.db, &id, start, &body).map_err(map_upload_err)?;
        Ok(Json(json!({ "upload_id": id, "received": received })).into_response())
    })
    .await
}

pub(super) async fn public_upload_complete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    Query(query): Query<PublicUploadCompleteQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        let row = {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?
        };
        // Full-access links may overwrite (that's how "replace this file"
        // works). View-blind links (drop boxes, album contribution) never
        // overwrite silently — a name clash auto-renames, because the guest
        // can't see which names are taken and a bare error would leak one.
        let overwrite = query.overwrite.as_deref() == Some("1") && link.caps & CAP_EDIT != 0;
        let rename_on_conflict = link.caps & CAP_VIEW == 0;
        let entry = uploads::complete(
            &state.db,
            &id,
            overwrite,
            rename_on_conflict,
            query.hash.as_deref(),
        )
        .map_err(map_upload_err)?;
        let rel = crate::gallery::gallery_indexer::join_rel(&row.path, &entry.name);
        invalidate_guest_listing(&state, &row.drive_id, &rel);
        if link.subject_kind == KIND_ALBUM {
            // Album contributions: index the file and attach it to the album.
            let (root, album) = {
                let conn = state.db.lock().map_err(|_| busy())?;
                album_for_link(&conn, &link)?
            };
            match crate::gallery::index_one(&link.drive_id, &root, &rel) {
                Ok(Some(_)) => {
                    let _ = crate::gallery::add_album_items(
                        &root,
                        &album.id,
                        &[(link.drive_id.clone(), rel.clone())],
                    );
                }
                _ => {
                    let _ = std::fs::remove_file(root.join(crate::private::disk_rel(&root, &rel)));
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "Only photos and videos can go in this album.",
                    ));
                }
            }
        } else {
            state.gallery.upsert(&row.drive_id, &rel);
        }
        state.touch_io_activity();
        crate::api::collab::note_diagram_saved(
            &state,
            &row.drive_id,
            &rel,
            &format!("guest:{}", link.id),
            query.coverage.as_deref(),
        )
        .await;
        Ok(Json(entry).into_response())
    })
    .await
}

pub(super) async fn public_upload_cancel(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?;
        }
        uploads::cancel(&state.db, &id).map_err(map_upload_err)?;
        Ok(Json(json!({ "ok": true })).into_response())
    })
    .await
}

// ---------------------------------------------------------------------------
// Guest file operations — the same verbs the signed-in browser has, resolved
// through the link. CAP_VIEW reads, CAP_UPLOAD creates, CAP_EDIT mutates.
// Every path is scoped to the link root: a link can never touch the file or
// folder it points at (renaming or deleting the root would orphan the token).
// ---------------------------------------------------------------------------

/// Resolve the link's subject once, canonically: the real filesystem path it
/// points at plus whether that's a directory. Every guest-visible target
/// must stay inside this root — a symlink planted inside a shared folder
/// must never lead a guest outside it.
pub(super) fn link_root(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
) -> Result<(PathBuf, bool), ApiError> {
    let (root, meta) = files::resolve_any_including_trash(conn, &link.drive_id, &link.path)
        .map_err(map_guest_files_err)?;
    Ok((root, meta.is_dir()))
}

/// True when `target` (canonical) is the link root or sits beneath it. A
/// link on a single file admits only the file itself.
pub(super) fn inside_link_root(root: &FsPath, root_is_dir: bool, target: &FsPath) -> bool {
    if root_is_dir {
        target.starts_with(root)
    } else {
        target == root
    }
}

/// Canonical confinement for a read path: `rel` must already have passed
/// `scoped_child`. Resolves `rel` canonically and requires the target to sit
/// inside the canonical link root — a symlink inside the share pointing
/// outside it is refused. `missing` is the caller's not-available error for
/// either resolve step. Returns the canonical target plus its metadata.
pub(super) fn confined_read(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    rel: &str,
    missing: &ApiError,
) -> Result<(PathBuf, std::fs::Metadata), ApiError> {
    let (root, root_is_dir) = link_root(conn, link).map_err(|_| missing.clone())?;
    let (target, meta) = files::resolve_any_including_trash(conn, &link.drive_id, rel)
        .map_err(|_| missing.clone())?;
    if !inside_link_root(&root, root_is_dir, &target) || !link_reaches(conn, link, rel) {
        return Err(not_in_share());
    }
    Ok((target, meta))
}

/// The private-item boundary rule for links: a link reaches a private item
/// only when the link itself sits on that item or inside it. A folder link
/// above a private item stops at it (the item and everything in it is
/// invisible to that link); a link on or under it works.
pub(super) fn link_reaches(conn: &rusqlite::Connection, link: &AccessLinkRow, rel: &str) -> bool {
    let Ok(drive) = files::drive_root(conn, &link.drive_id) else {
        return true;
    };
    let root = FsPath::new(&drive.mount_point);
    let real = files::real_rel(root, &normalize_subject_path(rel)).into_owned();
    let link_real = files::real_rel(root, &normalize_subject_path(&link.path)).into_owned();
    match crate::private::boundary_for(root, &real) {
        None => true,
        Some(b) => {
            crate::private::owner_state(conn, &b.owner) != crate::private::OwnerState::Deleted
                && path_contains(&b.path, &link_real)
        }
    }
}

/// Drop listing rows a link may not reach (private items above the link).
pub(super) fn retain_reachable(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    dir_rel: &str,
    entries: &mut Vec<files::FileEntry>,
) {
    entries.retain(|e| {
        link_reaches(
            conn,
            link,
            &crate::gallery::gallery_indexer::join_rel(dir_rel, &e.name),
        )
    });
}

/// Canonical confinement for a mutation: intermediate components resolve
/// without following symlinks — `for_create` allows a missing tail
/// (`resolve_for_create_nofollow`), existing targets use
/// `resolve_child_nofollow`, which also refuses a symlink leaf — so a link
/// planted inside the share cannot steer a rename/delete/move/create
/// outside the link root.
pub(super) fn confined_write(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    rel: &str,
    for_create: bool,
) -> Result<(), ApiError> {
    let drive = files::drive_root(conn, &link.drive_id).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared files aren't available right now.",
        )
    })?;
    let drive_root = PathBuf::from(&drive.mount_point);
    let (root, root_is_dir) = link_root(conn, link)?;
    let real = files::real_rel_path(conn, &link.drive_id, rel).map_err(map_guest_files_err)?;
    let resolved = if for_create {
        luna_core::path::resolve_for_create_nofollow(&drive_root, &real)
    } else {
        luna_core::path::resolve_child_nofollow(&drive_root, &real)
    };
    let target = resolved.map_err(|e| match e {
        luna_core::path::PathError::Absolute | luna_core::path::PathError::Escape => not_in_share(),
        other => map_guest_files_err(other.into()),
    })?;
    if !inside_link_root(&root, root_is_dir, &target) || !link_reaches(conn, link, rel) {
        return Err(not_in_share());
    }
    Ok(())
}

/// Resolve a guest-facing `rel` (relative to the link root) to a drive path
/// inside the link. The root itself is a valid read target. A link that
/// isn't itself trash-scoped can never reach `.luna-trash`.
pub(crate) fn readable_child(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    scoped_child(
        link,
        rel.trim(),
        json_error(
            StatusCode::BAD_REQUEST,
            "That path isn't inside this share.",
        ),
    )
}

/// Resolve a guest-facing `relative` path to the drive path of an existing
/// file inside `link` — view capability required, non-path subjects refused,
/// and the canonical target must stay inside the canonical link root.
/// Returns the drive-relative path.
pub(crate) fn link_file(
    state: &AppState,
    link: &AccessLinkRow,
    relative: &str,
) -> Result<String, ApiError> {
    require_link_view(link)?;
    if link.subject_kind != KIND_PATH {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This link does not open files.",
        ));
    }
    let path = readable_child(link, relative)?;
    let conn = state.db.lock().map_err(|_| busy())?;
    let (root, root_is_dir) = link_root(&conn, link)?;
    // A file link only ever opens itself — children of a file are refused
    // before the filesystem gets a chance to confuse "file/child" with a
    // sibling path.
    if !root_is_dir && path != link.path {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That file is not inside this share.",
        ));
    }
    let (target, _) = files::file_path_including_trash(&conn, &link.drive_id, &path)
        .map_err(map_guest_files_err)?;
    if !inside_link_root(&root, root_is_dir, &target) || !link_reaches(&conn, link, &path) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That file is not inside this share.",
        ));
    }
    Ok(path)
}

/// `readable_child` for mutations: the link root itself is never mutable.
pub(super) fn mutable_child(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    let trimmed = rel.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The shared item itself can't be changed through this link.",
        ));
    }
    let joined = readable_child(link, trimmed)?;
    if joined == link.path.trim_end_matches('/') {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The shared item itself can't be changed through this link.",
        ));
    }
    Ok(joined)
}

/// For upload-only links (no view), a guest can name one item at the shared
/// root but can't navigate — nested paths would leak the drop box's layout.
pub(super) fn guest_child_for_create(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    let trimmed = rel.trim().trim_matches('/');
    if link.caps & CAP_VIEW == 0 && trimmed.contains('/') {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This link only accepts items at the top level.",
        ));
    }
    mutable_child(link, trimmed)
}

pub(super) fn map_guest_files_err(err: files::FilesError) -> ApiError {
    use std::io::ErrorKind;
    match err {
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "An item with this name is already here. Choose another name.",
        ),
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that anymore. Refresh and try again.",
        ),
        files::FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that anymore. Refresh and try again.",
        ),
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::NotADirectory => {
            json_error(StatusCode::BAD_REQUEST, "That destination isn't a folder.")
        }
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::InvalidInput => {
            json_error(StatusCode::BAD_REQUEST, "That name isn't allowed here.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't do that. Check the drive and try again.",
        ),
    }
}

pub(super) fn invalidate_guest_listing(state: &AppState, drive_id: &str, rel: &str) {
    crate::api::files::invalidate_parent_listing(state, drive_id, rel);
}

pub(super) async fn public_stat(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_view(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        let rel = readable_child(&link, query.path.as_deref().unwrap_or(""))?;
        let stat = {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_read(
                &conn,
                &link,
                &rel,
                &json_error(
                    StatusCode::NOT_FOUND,
                    "Luna can't find that anymore. Refresh and try again.",
                ),
            )?;
            files::stat(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?
        };
        Ok(Json(json!({
            "name": stat.name,
            "kind": stat.kind,
            "size": stat.size,
            "modified": stat.modified,
            "created": stat.created,
            "hidden": stat.hidden,
            "writable": link.caps & CAP_EDIT != 0 && rel != link.path.trim_end_matches('/'),
            "children": stat.children,
            "totals": stat.totals,
        }))
        .into_response())
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PublicWriteBody {
    pub(super) path: String,
}

pub(super) async fn public_mkdir(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicWriteBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        let rel = guest_child_for_create(&link, &body.path)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_write(&conn, &link, &rel, true)?;
            files::mkdir(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?;
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "path": rel })).into_response())
    })
    .await
}

pub(super) async fn public_create(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicWriteBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        let rel = guest_child_for_create(&link, &body.path)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_write(&conn, &link, &rel, true)?;
            files::create(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?;
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "path": rel })).into_response())
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PublicRenameBody {
    pub(super) path: String,
    pub(super) new_name: String,
}

pub(super) async fn public_rename(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicRenameBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        let rel = mutable_child(&link, &body.path)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_write(&conn, &link, &rel, false)?;
        }
        let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let new_rel = crate::gallery::gallery_indexer::join_rel(parent, &body.new_name);
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::rename(&conn, &link.drive_id, &rel, &body.new_name)
                .map_err(map_guest_files_err)?;
        }
        // Folder renames move many gallery rows; rescan is the safe path.
        let renamed_dir = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::drive_root(&conn, &link.drive_id)
                .map(|d| PathBuf::from(&d.mount_point).join(&new_rel).is_dir())
                .unwrap_or(false)
        };
        if renamed_dir {
            state.gallery.rescan(&link.drive_id);
        } else {
            state.gallery.rename(&link.drive_id, &rel, &new_rel);
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        invalidate_guest_listing(&state, &link.drive_id, &new_rel);
        state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true })).into_response())
    })
    .await
}

pub(super) async fn public_delete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        let rel = mutable_child(&link, query.path.as_deref().unwrap_or(""))?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_write(&conn, &link, &rel, false)?;
        }
        let trash_path = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::delete_to_trash(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?
        };
        state.gallery.remove(&link.drive_id, &rel);
        // Eagerly drop album refs so shared albums update without the indexer.
        if let Ok(conn) = state.db.lock()
            && let Ok(drives) = db::list_drives(&conn)
        {
            let mounts: Vec<(String, PathBuf)> = drives
                .into_iter()
                .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
                .map(|d| (d.id, PathBuf::from(d.mount_point)))
                .collect();
            crate::gallery::purge_album_item_refs_on_mounts(&mounts, &link.drive_id, &rel);
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
        state.ram_cache.remove_dirty(&link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "trash_path": trash_path })).into_response())
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PublicMoveBody {
    pub(super) paths: Vec<String>,
    pub(super) dest: Option<String>,
}

pub(super) async fn public_move(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicMoveBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        if link.subject_kind != KIND_PATH {
            return Err(gone());
        }
        if body.paths.is_empty() {
            return Err(json_error(StatusCode::BAD_REQUEST, "Nothing to move."));
        }
        let dest_dir = readable_child(&link, body.dest.as_deref().unwrap_or(""))?;
        {
            // The destination must be a real folder inside the link root —
            // a symlinked folder would land the move outside the share.
            let conn = state.db.lock().map_err(|_| busy())?;
            confined_write(&conn, &link, &dest_dir, false)?;
        }
        let mut results = Vec::new();
        for rel_guest in &body.paths {
            let rel = mutable_child(&link, rel_guest)?;
            {
                let conn = state.db.lock().map_err(|_| busy())?;
                confined_write(&conn, &link, &rel, false)?;
            }
            let leaf = rel.rsplit('/').next().unwrap_or(&rel);
            let to_rel = crate::gallery::gallery_indexer::join_rel(&dest_dir, leaf);
            let outcome = {
                let conn = state.db.lock().map_err(|_| busy())?;
                files::move_rel(&conn, &link.drive_id, &rel, &to_rel)
            };
            match outcome {
                Ok(()) => {
                    let moved_dir = {
                        let conn = state.db.lock().map_err(|_| busy())?;
                        files::drive_root(&conn, &link.drive_id)
                            .map(|d| PathBuf::from(&d.mount_point).join(&to_rel).is_dir())
                            .unwrap_or(false)
                    };
                    if moved_dir {
                        state.gallery.rescan(&link.drive_id);
                    } else {
                        state.gallery.rename(&link.drive_id, &rel, &to_rel);
                    }
                    invalidate_guest_listing(&state, &link.drive_id, &rel);
                    invalidate_guest_listing(&state, &link.drive_id, &to_rel);
                    state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
                    results.push(json!({ "path": rel_guest, "ok": true }));
                }
                Err(e) => {
                    let (status, Json(err)) = map_guest_files_err(e);
                    results.push(json!({
                        "path": rel_guest,
                        "ok": false,
                        "status": status.as_u16(),
                        "error": err.get("error").cloned().unwrap_or(json!("Luna couldn't move that.")),
                    }));
                }
            }
        }
        state.touch_io_activity();
        let all_ok = results.iter().all(|r| r["ok"] == true);
        let status = if all_ok {
            StatusCode::OK
        } else {
            StatusCode::MULTI_STATUS
        };
        Ok((status, Json(json!({ "results": results }))).into_response())
    })
    .await
}

pub(super) fn map_upload_err(err: uploads::UploadError) -> ApiError {
    use std::io::ErrorKind;
    match err {
        uploads::UploadError::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this upload.")
        }
        uploads::UploadError::NotActive => json_error(
            StatusCode::CONFLICT,
            "This upload is already finished or cancelled.",
        ),
        uploads::UploadError::SizeMismatch => json_error(
            StatusCode::BAD_REQUEST,
            "The upload isn't complete yet. Check the connection and try again.",
        ),
        uploads::UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::AlreadyExists =>
        {
            json_error(
                StatusCode::CONFLICT,
                "A file with this name is already here. Rename it or choose another.",
            )
        }
        uploads::UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::NotADirectory =>
        {
            json_error(StatusCode::BAD_REQUEST, "That destination is not a folder.")
        }
        uploads::UploadError::Io(e) if e.kind() == ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Rename it or choose another.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that upload. Check the drive and try again.",
        ),
    }
}
