//! Signed-in side of the access API: who a subject is shared with, member and
//! link changes, and the "mine" dashboard lists.

use super::*;

// ---------------------------------------------------------------------------
// Signed-in handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct SubjectQuery {
    pub(super) kind: String,
    pub(super) drive_id: String,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) album_id: Option<String>,
}

/// Everything the share sheet needs for one subject: its shape, the caller's
/// capabilities, current members, and current links.
pub(super) async fn subject_state(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<SubjectQuery>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let subj = resolve_subject(
        &conn,
        &q.kind,
        &q.drive_id,
        q.path.as_deref().unwrap_or(""),
        q.album_id.as_deref().unwrap_or(""),
    )?;
    let mine = my_caps(&conn, &user, &subj);
    if mine == 0 {
        return Err(refuse(&subj, mine, "You don't have access to share this."));
    }
    // Who-has-what is share-management detail: a member without the share
    // capability sees that sharing exists (counts), never the roster or link
    // URLs — a plain member must not enumerate identities or minted tokens.
    let can_manage_roster = mine & CAP_SHARE != 0;
    let subject_owner = is_subject_owner(&user, &subj);
    let names = user_names(&conn);
    let labels = drive_labels(&conn);
    let all_members = db::list_all_access_members(&conn).map_err(|_| busy())?;
    let member_rows = db::list_access_members_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?;
    let members = if can_manage_roster {
        member_rows
            .iter()
            .map(|r| {
                let mut v = member_json(r, &names);
                // Mirror update_member/remove_member: your own row is always
                // yours to leave or narrow; touching someone else's needs
                // strict superiority (or subject ownership) — equal-cap
                // members can't retune or kick each other.
                v["can_manage"] = json!(if r.user_id == user.id {
                    caps_cover(mine, r.caps)
                } else {
                    subject_owner || (mine & CAP_SHARE != 0 && caps_strictly_cover(mine, r.caps))
                });
                v["can_remove"] = json!(
                    r.user_id == user.id
                        || subject_owner
                        || (mine & CAP_SHARE != 0 && caps_strictly_cover(mine, r.caps))
                );
                let mut effective = r.caps;
                if subj.kind == KIND_PATH {
                    for other in &all_members {
                        if other.user_id == r.user_id
                            && other.subject_kind == KIND_PATH
                            && other.drive_id == subj.drive_id
                            && path_contains(&other.path, &subj.path)
                            && reaches_in(&subj, &other.path)
                            // Ancestor grants the caller can't inspect stay
                            // hidden — don't OR them into what we show.
                            && resolve_subject(&conn, KIND_PATH, &subj.drive_id, &other.path, "")
                                .map(|p| {
                                    p.exists && my_caps(&conn, &user, &p) & CAP_VIEW != 0
                                })
                                .unwrap_or(false)
                        {
                            effective |= other.caps;
                        }
                    }
                }
                v["effective_caps"] = json!(caps_to_str(effective));
                v
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let link_rows = db::list_access_links_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?;
    let links = if can_manage_roster {
        link_rows
            .iter()
            .map(|l| link_json(&conn, &user, l))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let inherited_from = |drive_id: &str, path: &str| {
        // Identity detail only flows when the caller can actually see the
        // parent — an upload-only member gets counts, never names.
        let can_inspect = resolve_subject(&conn, KIND_PATH, drive_id, path, "")
            .map(|parent| parent.exists && my_caps(&conn, &user, &parent) & CAP_VIEW != 0)
            .unwrap_or(false);
        if !can_inspect {
            // A parent the caller can't see yields nothing — emitting the
            // path or leaf name here would leak folder names the caller may
            // not see.
            return json!({
                "kind": KIND_PATH,
                "drive_id": drive_id,
                "can_inspect": false,
            });
        }
        json!({
            "kind": KIND_PATH,
            "drive_id": drive_id,
            "path": path,
            "name": if path.is_empty() {
                labels.get(drive_id).cloned().unwrap_or_else(|| drive_id.to_string())
            } else {
                path.rsplit('/').next().unwrap_or(path).to_string()
            },
            "can_inspect": true,
        })
    };
    let inherited_members = all_members
        .iter()
        .filter(|r| {
            subj.kind == KIND_PATH
                && r.subject_kind == KIND_PATH
                && r.drive_id == subj.drive_id
                && r.path != subj.path
                && path_contains(&r.path, &subj.path)
                && reaches_in(&subj, &r.path)
        })
        .map(|r| {
            let from = inherited_from(&r.drive_id, &r.path);
            // A parent the caller can't inspect yields counts only — the row
            // still exists (the sheet renders "N people shared through X"),
            // but names, caps, and who granted them stay hidden.
            if from["can_inspect"].as_bool().unwrap_or(false) {
                let mut v = member_json(r, &names);
                v["inherited_from"] = from;
                v
            } else {
                json!({ "inherited_from": from })
            }
        })
        .collect::<Vec<_>>();
    let inherited_links = db::list_access_links(&conn)
        .map_err(|_| busy())?
        .iter()
        .filter(|l| {
            subj.kind == KIND_PATH
                && reaches_in(&subj, &l.path)
                && l.subject_kind == KIND_PATH
                && l.drive_id == subj.drive_id
                && l.path != subj.path
                && path_contains(&l.path, &subj.path)
                && may_manage_link(&conn, &user, l)
        })
        .map(|l| {
            let mut v = link_json(&conn, &user, l);
            v["inherited_from"] = inherited_from(&l.drive_id, &l.path);
            v
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "subject": subject_json(&subj),
        "private": subj.private,
        "my_caps": caps_to_str(mine),
        "members": members,
        "member_count": member_rows.len(),
        "links": links,
        "link_count": link_rows.len(),
        "inherited_members": inherited_members,
        "inherited_links": inherited_links,
    })))
}

#[derive(Deserialize)]
pub(super) struct MemberBody {
    pub(super) kind: String,
    pub(super) drive_id: String,
    #[serde(default)]
    pub(super) path: String,
    #[serde(default)]
    pub(super) album_id: String,
    pub(super) user_id: String,
    pub(super) caps: String,
}

/// Share a subject with a Luna user. Subset rule: you can only hand out
/// capabilities you hold yourself on that subject.
pub(super) async fn add_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<MemberBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    // A self-grant would seed a revocation-proof row — the member could keep
    // re-scoping their own access even after an admin removed it.
    if body.user_id == user.id {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "You can't share something with yourself.",
        ));
    }
    // Reject `..` in the stored path — normalize_subject_path keeps it, so a
    // raw body could otherwise persist a row outside any real subject.
    let path = clean_subject_path(&body.path)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That item can't be shared."))?;
    let subj = resolve_subject(&conn, &body.kind, &body.drive_id, &path, &body.album_id)?;
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    let mine = my_caps(&conn, &user, &subj);
    let subject_owner = is_subject_owner(&user, &subj);
    // Authorization before existence: a 404-vs-403 split would let a member
    // probe which folders exist on the drive.
    if mine & CAP_SHARE == 0 && !subject_owner {
        return Err(refuse(
            &subj,
            mine,
            "You don't have permission to share this.",
        ));
    }
    if !subj.exists {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that to share it.",
        ));
    }
    if !caps_valid_for(caps, subj.kind, subj.is_file) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    // Delegated authority can't clone itself: a member only mints access
    // strictly narrower than what they hold. Owners and admins are the
    // superior class — they can grant anything up to full+share.
    if !subject_owner && !caps_strictly_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can only share access narrower than your own.",
        ));
    }
    if subject_owner && !caps_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can only share access you already have.",
        ));
    }
    let target = db::get_user(&conn, &body.user_id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that person."))?;
    // Admins already hold everything — a member row for one is dead weight
    // that only confuses the roster.
    if target.role == "admin" && !subj.private {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Admins can already open everything.",
        ));
    }

    // Same-user row on this subject → just retune it.
    let existing = db::list_access_members_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?
    .into_iter()
    .find(|r| r.user_id == body.user_id);
    let names = user_names(&conn);
    if let Some(row) = existing {
        // Retuning another person's row is a manage-level action —
        // equal-cap members must not rewrite each other's access.
        // (Self-grants are rejected above, so the row is always someone
        // else's here.)
        if !subject_owner
            && (mine & CAP_SHARE == 0
                || !caps_strictly_cover(mine, row.caps)
                || !caps_strictly_cover(mine, caps))
        {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can't change access at or above your own level.",
            ));
        }
        db::update_access_member_caps(&conn, &row.id, caps).map_err(|_| busy())?;
        return Ok(Json(member_json(&AccessMemberRow { caps, ..row }, &names)));
    }

    let row = AccessMemberRow {
        id: Uuid::new_v4().to_string(),
        subject_kind: subj.kind.to_string(),
        drive_id: subj.drive_id.clone(),
        path: subj.path.clone(),
        album_id: subj.album_id.clone(),
        user_id: target.id.clone(),
        caps,
        created_by: user.id.clone(),
    };
    access::create_member(&conn, &row).map_err(|_| busy())?;
    Ok(Json(member_json(&row, &names)))
}

#[derive(Deserialize)]
pub(super) struct UpdateMemberBody {
    pub(super) caps: String,
}

pub(super) async fn update_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateMemberBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let row = db::get_access_member(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this share."))?;
    let subj = resolve_subject(
        &conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    )?;
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    if !caps_valid_for(caps, subj.kind, subj.is_file) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    let mine = my_caps(&conn, &user, &subj);
    let allowed = if row.user_id == user.id {
        // Your own row narrows only — never past what you currently hold.
        caps_cover(mine, row.caps) && caps_cover(mine, caps)
    } else {
        // Someone else's row needs the superior class or strict
        // superiority over both the old and the new level — equal-cap
        // members must not retune each other.
        is_subject_owner(&user, &subj)
            || (mine & CAP_SHARE != 0
                && caps_strictly_cover(mine, row.caps)
                && caps_strictly_cover(mine, caps))
    };
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't change access at or above your own level.",
        ));
    }
    db::update_access_member_caps(&conn, &id, caps).map_err(|_| busy())?;
    let names = user_names(&conn);
    Ok(Json(member_json(&AccessMemberRow { caps, ..row }, &names)))
}

pub(super) async fn remove_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let row = db::get_access_member(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this share."))?;
    let mine = my_caps_on_row(&conn, &user, &row);
    // Members can always remove themselves ("leave" a share); removing
    // someone else's row needs the superior class or strict superiority —
    // equal-cap members must not kick each other.
    let allowed = row.user_id == user.id
        || (user.role == "admin"
            && !(row.subject_kind == KIND_PATH
                && path_is_private(&conn, &row.drive_id, &row.path)))
        || (row.subject_kind == KIND_PATH
            && private_owner(&conn, &row.drive_id, &row.path).as_deref() == Some(user.id.as_str()))
        || (mine & CAP_SHARE != 0 && caps_strictly_cover(mine, row.caps));
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't remove access wider than your own.",
        ));
    }
    db::delete_access_member(&conn, &id).map_err(|_| busy())?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub(super) struct CreateLinkBody {
    pub(super) kind: String,
    pub(super) drive_id: String,
    #[serde(default)]
    pub(super) path: String,
    #[serde(default)]
    pub(super) album_id: String,
    pub(super) caps: String,
    pub(super) password: Option<String>,
    pub(super) expires_in_days: Option<u32>,
}

pub(super) fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Mint a public link. The raw token is stored on the row so the owner can
/// always come back and copy the address again; lookups still use the hash.
pub(super) async fn create_link(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateLinkBody>,
) -> Result<Json<Value>, ApiError> {
    // Keyed on the member, not the address — behind the Connect tunnel
    // every member shares one peer IP, so address-keyed budgets would
    // either lock everyone out or let one member burn everyone's quota.
    if !state.share_limiter.allow(&format!("link:{}", user.id)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many new links just now. Wait a minute and try again.",
        ));
    }
    let conn = state.db.lock().map_err(|_| busy())?;
    let subj = resolve_subject(
        &conn,
        &body.kind,
        &body.drive_id,
        &body.path,
        &body.album_id,
    )?;
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    let mine = my_caps(&conn, &user, &subj);
    // Minting a public link is a manage-level action — a member with
    // content access but no share capability must not publish the subject
    // to anonymous guests. Authorization runs before the existence check
    // so a 404-vs-403 split can't probe which folders exist.
    if mine & CAP_SHARE == 0 {
        return Err(refuse(
            &subj,
            mine,
            "You don't have permission to share this.",
        ));
    }
    if !subj.exists {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that to share it.",
        ));
    }
    let is_form = subj.is_file && is_form_path(&subj.path);
    if !caps_valid_for_link(caps, subj.kind, subj.is_file, is_form) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    if caps == CAP_RESPOND {
        // A respond link lets strangers append to the responses file — the
        // creator needs upload or edit access to allow that.
        if mine & (CAP_UPLOAD | CAP_EDIT) == 0 {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can only share access you already have.",
            ));
        }
    } else if !caps_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can only share access you already have.",
        ));
    }
    let token = generate_token();
    let password_hash = match body.password.as_deref().map(str::trim) {
        Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(|_| busy())?,
        _ => String::new(),
    };
    let expires_at = body
        .expires_in_days
        .map(|days| db::now_unix() + days.clamp(1, 3650) as i64 * 86400);
    let row = AccessLinkRow {
        id: Uuid::new_v4().to_string(),
        token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
        token: token.clone(),
        subject_kind: subj.kind.to_string(),
        drive_id: subj.drive_id.clone(),
        path: subj.path.clone(),
        album_id: subj.album_id.clone(),
        caps,
        password_hash,
        expires_at,
        created_by: user.id.clone(),
        created_at: db::now_unix(),
    };
    db::insert_access_link(&conn, &row).map_err(|_| busy())?;
    Ok(Json(json!({
        "id": row.id,
        "url": format!("/s/{token}"),
        "token": token,
        "caps": caps_to_str(caps),
        "expires_at": row.expires_at,
    })))
}

pub(super) fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub(super) struct UpdateLinkBody {
    #[serde(default)]
    pub(super) caps: Option<String>,
    /// Absent = keep, null = clear, string = set a new password.
    #[serde(default, deserialize_with = "present_nullable")]
    pub(super) password: Option<Option<String>>,
    /// Absent = keep, null = never expires, number = days from now.
    #[serde(default, deserialize_with = "present_nullable")]
    pub(super) expires_in_days: Option<Option<u32>>,
}

pub(super) fn may_manage_link(
    conn: &rusqlite::Connection,
    user: &CurrentUser,
    link: &AccessLinkRow,
) -> bool {
    if user.role == "admin"
        && !(link.subject_kind == KIND_PATH && path_is_private(conn, &link.drive_id, &link.path))
    {
        return true;
    }
    let mine = my_caps_on_link(conn, user, link);
    // "respond" isn't a capability anyone holds — managing a form's answer
    // link rides on write access to the form, same rule as creating one.
    let covers = if link.caps == CAP_RESPOND {
        mine & (CAP_UPLOAD | CAP_EDIT) != 0
    } else {
        caps_cover(mine, link.caps)
    };
    // Creating the row is not a lifetime grant — creator or not, the caller
    // must still hold share-management rights and cover the link's caps, or
    // a revoked member could keep recovering the raw URL and mutating
    // password/expiry on shares they minted.
    mine & CAP_SHARE != 0 && covers
}

pub(super) async fn update_link(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateLinkBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let mut link = db::get_access_link(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if !may_manage_link(&conn, &user, &link) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't change this link.",
        ));
    }
    let subj = resolve_subject(
        &conn,
        &link.subject_kind,
        &link.drive_id,
        &link.path,
        &link.album_id,
    )?;
    if let Some(raw) = body.caps.as_deref() {
        let caps = caps_from_str(raw).ok_or_else(|| {
            json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist.")
        })?;
        let is_form = subj.is_file && is_form_path(&subj.path);
        if !caps_valid_for_link(caps, subj.kind, subj.is_file, is_form) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That access level doesn't apply here.",
            ));
        }
        let mine = my_caps(&conn, &user, &subj);
        // "respond" isn't a subset of anyone's held caps — it needs write
        // access to the form instead, matching create_link's rule.
        let allowed = if caps == CAP_RESPOND {
            mine & (CAP_UPLOAD | CAP_EDIT) != 0
        } else {
            caps_cover(mine, caps)
        };
        if !allowed {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can't widen a link past your own access.",
            ));
        }
        link.caps = caps;
    }
    if let Some(pw) = &body.password {
        link.password_hash = match pw.as_deref().map(str::trim) {
            Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(|_| busy())?,
            _ => String::new(),
        };
    }
    if let Some(days) = body.expires_in_days {
        link.expires_at = days.map(|d| db::now_unix() + d.clamp(1, 3650) as i64 * 86400);
    }
    db::update_access_link(&conn, &link).map_err(|_| busy())?;
    Ok(Json(link_json(&conn, &user, &link)))
}

pub(super) async fn remove_link(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let link = db::get_access_link(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if !may_manage_link(&conn, &user, &link) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't remove this link.",
        ));
    }
    db::delete_access_link(&conn, &id).map_err(|_| busy())?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) fn drive_labels(
    conn: &rusqlite::Connection,
) -> std::collections::HashMap<String, String> {
    db::list_drives(conn)
        .unwrap_or_default()
        .into_iter()
        .map(|d| (d.id, d.label))
        .collect()
}

/// Human name for a member row: album name, folder basename, or drive label.
pub(super) fn member_row_name(
    conn: &rusqlite::Connection,
    row: &AccessMemberRow,
    labels: &std::collections::HashMap<String, String>,
) -> String {
    if row.subject_kind == KIND_ALBUM {
        if let Ok((_, Some(album))) = resolve_album(conn, &row.drive_id, &row.album_id) {
            return album.name;
        }
        return "Album".into();
    }
    if row.path.is_empty() {
        return labels
            .get(&row.drive_id)
            .cloned()
            .unwrap_or_else(|| row.drive_id.clone());
    }
    row.path.rsplit('/').next().unwrap_or(&row.path).to_string()
}

pub(super) fn member_row_json(
    conn: &rusqlite::Connection,
    row: &AccessMemberRow,
    labels: &std::collections::HashMap<String, String>,
    names: &std::collections::HashMap<String, String>,
) -> Value {
    let resolved = resolve_subject(
        conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    )
    .ok();
    let is_file = resolved.as_ref().map(|s| s.is_file).unwrap_or(false);
    let exists = resolved.as_ref().map(|s| s.exists).unwrap_or(false);
    json!({
        "id": row.id,
        "kind": row.subject_kind,
        "drive_id": row.drive_id,
        "drive_label": labels.get(&row.drive_id).cloned().unwrap_or_default(),
        "path": row.path,
        "album_id": row.album_id,
        "name": member_row_name(conn, row, labels),
        "is_file": is_file,
        "exists": exists,
        "caps": caps_to_str(row.caps),
        "created_by": row.created_by,
        "shared_by": names.get(&row.created_by).cloned().unwrap_or_default(),
    })
}

/// Things shared with the signed-in user, reduced to access roots.
pub(super) async fn me_access(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let rows = db::list_access_members_for_user(&conn, &user.id).map_err(|_| busy())?;
    let labels = drive_labels(&conn);
    let names = user_names(&conn);
    let rows = rows
        .into_iter()
        .filter(|row| {
            row.subject_kind != KIND_PATH
                || crate::auth::caps_on_path(&user, &conn, &row.drive_id, &row.path) != 0
        })
        .collect();
    let roots = access::member_access_roots(rows);
    let out: Vec<Value> = roots
        .iter()
        .map(|r| member_row_json(&conn, r, &labels, &names))
        .collect();
    Ok(Json(out))
}

/// Sharing inventory: subjects the caller created access rows on (admins see
/// everything), plus everything shared *with* the caller.
pub(super) async fn mine(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let is_admin = user.role == "admin";
    let members = db::list_all_access_members(&conn).map_err(|_| busy())?;
    let links = db::list_access_links(&conn).map_err(|_| busy())?;
    let labels = drive_labels(&conn);
    let names = user_names(&conn);

    // Group rows by subject key, keeping only groups the caller controls:
    // admin sees all; members see subjects where they created a row or hold
    // covering caps on at least one row.
    let mut order: Vec<(String, String, String, String)> = Vec::new();
    let mut group_members: std::collections::HashMap<
        (String, String, String, String),
        Vec<&AccessMemberRow>,
    > = std::collections::HashMap::new();
    let mut group_links: std::collections::HashMap<
        (String, String, String, String),
        Vec<&AccessLinkRow>,
    > = std::collections::HashMap::new();
    let key = |kind: &str, d: &str, p: &str, a: &str| {
        (
            kind.to_string(),
            d.to_string(),
            p.to_string(),
            a.to_string(),
        )
    };
    for m in &members {
        let k = key(&m.subject_kind, &m.drive_id, &m.path, &m.album_id);
        if !group_members.contains_key(&k) {
            order.push(k.clone());
        }
        group_members.entry(k).or_default().push(m);
    }
    for l in &links {
        let k = key(&l.subject_kind, &l.drive_id, &l.path, &l.album_id);
        if !group_links.contains_key(&k) && !group_members.contains_key(&k) {
            order.push(k.clone());
        }
        group_links.entry(k).or_default().push(l);
    }

    let mut sharing: Vec<Value> = Vec::new();
    for k in order {
        let ms = group_members.get(&k).cloned().unwrap_or_default();
        let ls = group_links.get(&k).cloned().unwrap_or_default();
        let controls = (is_admin && !(k.0 == KIND_PATH && path_is_private(&conn, &k.1, &k.2))) || {
            let mine = match resolve_subject(&conn, &k.0, &k.1, &k.2, &k.3) {
                Ok(subj) => my_caps(&conn, &user, &subj),
                Err(_) => 0,
            };
            // The roster only surfaces to share-managers — content access
            // alone (or a stale created_by) never reveals who else is here.
            mine & CAP_SHARE != 0
                && (ms
                    .iter()
                    .any(|m| m.created_by == user.id || caps_cover(mine, m.caps))
                    || ls
                        .iter()
                        .any(|l| l.created_by == user.id || caps_cover(mine, l.caps)))
        };
        if !controls {
            continue;
        }
        let subj = resolve_subject(&conn, &k.0, &k.1, &k.2, &k.3).ok();
        let (name, exists, is_file, item_count) = match &subj {
            Some(s) => (s.name.clone(), s.exists, s.is_file, s.item_count),
            None => (
                if k.0 == KIND_ALBUM {
                    "Album".into()
                } else if k.2.is_empty() {
                    labels.get(&k.1).cloned().unwrap_or_else(|| k.1.clone())
                } else {
                    k.2.rsplit('/').next().unwrap_or(&k.2).to_string()
                },
                false,
                false,
                0,
            ),
        };
        let mine_caps = subj
            .as_ref()
            .map(|s| my_caps(&conn, &user, s))
            .unwrap_or(if is_admin { access::CAP_MANAGE } else { 0 });
        sharing.push(json!({
            "kind": k.0,
            "drive_id": k.1,
            "drive_label": labels.get(&k.1).cloned().unwrap_or_default(),
            "path": k.2,
            "album_id": k.3,
            "name": name,
            "exists": exists,
            "is_file": is_file,
            "item_count": item_count,
            "my_caps": caps_to_str(mine_caps),
            "members": ms.iter().map(|m| member_json(m, &names)).collect::<Vec<_>>(),
            "links": ls.iter().map(|l| link_json(&conn, &user, l)).collect::<Vec<_>>(),
        }));
    }

    // Every explicit row the caller holds — nested grants stay visible so
    // "leave" can never hide access retained through a child.
    let my_rows = db::list_access_members_for_user(&conn, &user.id).map_err(|_| busy())?;
    let with_me: Vec<Value> = my_rows
        .iter()
        .filter(|row| {
            row.subject_kind != KIND_PATH
                || crate::auth::caps_on_path(&user, &conn, &row.drive_id, &row.path) != 0
        })
        .map(|r| member_row_json(&conn, r, &labels, &names))
        .collect();
    Ok(Json(json!({ "sharing": sharing, "with_me": with_me })))
}
