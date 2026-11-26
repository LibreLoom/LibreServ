use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::files::search::{Candidate, KindFilter, indexable_drives, search_all_with};
use crate::files::search_rank::{Query as NameQuery, Tier};

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    /// `dir` or `file` to show only folders or only files.
    kind: Option<String>,
    limit: Option<usize>,
    /// `1`: names and text only, without the neural passes (the web asks
    /// this while someone is still typing).
    quick: Option<u8>,
}

const DEFAULT_LIMIT: usize = 60;
const MAX_LIMIT: usize = 200;

#[derive(Deserialize)]
struct FactoryResetBody {
    #[serde(default)]
    confirm: bool,
    #[serde(default)]
    password: String,
    /// Factory reset always asks whether to keep or disconnect Connect.
    connect: ConnectChoice,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
enum ConnectChoice {
    Keep,
    /// The UI calls this choice Disconnect. Its reset flow may report that an
    /// earlier unbind already succeeded (`unbound`) or remains owed (`pending`).
    #[serde(alias = "unbound", alias = "pending")]
    Disconnect,
}

fn reset_failed() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't finish the reset. Try again.",
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/search", get(search))
        .route("/api/v1/system/factory-reset", post(factory_reset))
}

/// Search file and folder names across every drive the caller can open.
///
/// Results are ranked before access is checked and trimmed to `limit` after,
/// so the limit counts only what the caller can see. `scan` says whether
/// drives are still being read; the page asks again while it is, and results
/// that were already searchable stay put.
/// `incomplete` warns when a drive fails or its search work limit is reached.
async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let raw = query.q.trim().to_string();
    let quick = query.quick;
    if raw.chars().count() < 2 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type at least 2 letters to search.",
        ));
    }
    let kind = KindFilter::parse(query.kind.as_deref());
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let busy = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish this search. Try again.",
        )
    };

    let work_state = state.clone();
    let work_user = user.clone();
    let (hits, truncated, incomplete) = tokio::task::spawn_blocking(move || {
        // Name search (W10) and neural search (W11) share this endpoint; the
        // neural passes are timed separately at debug.
        let mut perf = crate::perf::Timer::new("W10|W11", "search");
        let parsed = NameQuery::new(&raw);
        if parsed.is_empty() {
            return Ok((Vec::new(), false, false));
        }
        let drives = {
            let conn = work_state.db.lock().map_err(|_| ())?;
            indexable_drives(&conn, false)
        };
        let neural = quick != Some(1);
        perf.field("neural", neural);
        // When names alone fill the answer, nothing after them can change it.
        let mut names_only = false;
        let (candidates, incomplete) = search_all_with(&drives, &parsed, kind, neural, |names| {
            names_only = work_state
                .db
                .lock()
                .is_ok_and(|conn| names_fill_answer(&conn, &work_user, names, limit));
            names_only
        })
        .map_err(|e| {
            tracing::warn!(error = %e, "search failed");
        })?;
        perf.field("names_only", names_only);
        let expr = crate::files::content::query::fts_expr(&parsed);
        let conn = work_state.db.lock().map_err(|_| ())?;
        let (hits, truncated) = visible_hits(&conn, &work_user, candidates, limit, expr.as_deref());
        perf.field("drives", drives.len());
        perf.field("hits", hits.len());
        perf.field("incomplete", incomplete);
        Ok::<_, ()>((hits, truncated, incomplete))
    })
    .await
    .map_err(|_| busy())?
    .map_err(|_| busy())?;

    let close_only = !hits.is_empty() && hits.iter().all(|h| h["match"] == "close");
    let status = state.search_index.status();
    let content = state.search_index.content_status();
    let admin = user.role == "admin";
    Ok(Json(json!({
        "hits": hits,
        "close_only": close_only,
        // More visible matches exist than `limit` returned.
        "truncated": truncated,
        "incomplete": incomplete,
        "scan": {
            "scanning": status.scanning,
            "drives_total": status.drives_total,
            "drives_done": status.drives_done,
            "drives_failed": status.drives_failed,
            // Folder counts across every drive are for Admins.
            "dirs_indexed": if admin { Some(status.dirs_indexed) } else { None },
            // Files whose words aren't searchable yet. A count, like the
            // folder count, says how big the drives are: Admins only.
            "contents_reading": content.reading,
            "contents_left": if admin { Some(content.files_left) } else { None },
        },
    })))
}

/// Whether `full` is itself a private item, and whether it is an ordinary
/// item protected by a private parent's boundary. `root` is the drive's mount
/// point, or `None` when the drive is not readable.
fn private_flags(root: Option<&std::path::Path>, full: &str) -> (bool, bool) {
    match root {
        Some(root) => (
            crate::private::item_at(root, full).is_some(),
            crate::private::boundary_for(root, full).is_some_and(|b| b.path != full),
        ),
        None => (false, false),
    }
}

/// The drive's mount point, the same lookup `caps_on_path_rows` does per call.
fn mount_of(conn: &rusqlite::Connection, drive_id: &str) -> Option<String> {
    crate::db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point)
}

/// Who may open which hit, with the caller's grants and each drive's mount
/// looked up once per search rather than per candidate.
struct Visibility<'a> {
    conn: &'a rusqlite::Connection,
    user: &'a crate::auth::CurrentUser,
    // Admins also need explicit grants inside another user's private folder.
    grants: Vec<crate::db::AccessMemberRow>,
    mounts: HashMap<String, Option<String>>,
}

impl<'a> Visibility<'a> {
    fn new(conn: &'a rusqlite::Connection, user: &'a crate::auth::CurrentUser) -> Self {
        Self {
            conn,
            user,
            grants: crate::db::list_access_members_for_user(conn, &user.id).unwrap_or_default(),
            mounts: HashMap::new(),
        }
    }

    /// The hit's path on its drive when the caller may open it.
    fn path(&mut self, hit: &crate::files::search::SearchHit) -> Option<String> {
        let full = if hit.parent.is_empty() {
            hit.name.clone()
        } else {
            format!("{}/{}", hit.parent, hit.name)
        };
        // Anything inside a hidden folder is hidden too.
        if full.split('/').any(|part| part.starts_with('.'))
            || crate::files::is_internal_temp(&full)
        {
            return None;
        }
        let conn = self.conn;
        let mount = self
            .mounts
            .entry(hit.drive_id.clone())
            .or_insert_with(|| mount_of(conn, &hit.drive_id))
            .as_deref();
        let caps = crate::auth::caps_on_path_rows_at(
            self.user,
            conn,
            &hit.drive_id,
            &full,
            &self.grants,
            mount,
        );
        (caps & crate::access::CAP_VIEW == crate::access::CAP_VIEW).then_some(full)
    }
}

/// Whether name matches alone decide the answer: at least `limit + 1` that
/// `user` may open rank above every name a typo away and every match from
/// inside a file (or by meaning, or in a photo). Then [`visible_hits`]
/// returns the same hits and the same `truncated` whatever the later passes
/// would add.
fn names_fill_answer(
    conn: &rusqlite::Connection,
    user: &crate::auth::CurrentUser,
    names: &[Candidate],
    limit: usize,
) -> bool {
    let mut visibility = Visibility::new(conn, user);
    names
        .iter()
        .take_while(|c| c.rank.tier < Tier::Content)
        .filter(|c| visibility.path(&c.hit).is_some())
        .take(limit + 1)
        .count()
        > limit
}

/// The first `limit` candidates, in rank order, that `user` may open. Access
/// is checked here, after ranking, so the limit counts only visible hits.
/// The flag says a further visible hit was left out. Content snippets are
/// read from the drive only for hits that passed the check (`expr` is the
/// query's content-search expression).
fn visible_hits(
    conn: &rusqlite::Connection,
    user: &crate::auth::CurrentUser,
    candidates: Vec<Candidate>,
    limit: usize,
    expr: Option<&str>,
) -> (Vec<Value>, bool) {
    let mut drive_dbs: HashMap<String, Option<rusqlite::Connection>> = HashMap::new();
    let mut visibility = Visibility::new(conn, user);
    let mut roots: HashMap<String, Option<PathBuf>> = HashMap::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let hit = candidate.hit;
        let Some(full) = visibility.path(&hit) else {
            continue;
        };
        if out.len() >= limit {
            return (out, true);
        }
        let root = roots
            .entry(hit.drive_id.clone())
            .or_insert_with(|| {
                crate::files::drive_root(conn, &hit.drive_id)
                    .ok()
                    .map(|d| PathBuf::from(d.mount_point))
            })
            .as_deref();
        let (private, in_private) = private_flags(root, &full);
        // Snippets are read here, after the access check, never before.
        let snippet = match (candidate.doc, root) {
            (Some(doc), Some(root)) => drive_dbs
                .entry(hit.drive_id.clone())
                .or_insert_with(|| crate::drives::drive_db::open(root).ok())
                .as_ref()
                .and_then(|db| match candidate.passage {
                    Some(passage) => {
                        crate::files::content::meaning::passage_snippet(db, doc, passage)
                            .map(|text| vec![(text, false)])
                    }
                    None => {
                        expr.and_then(|expr| crate::files::content::query::snippet(db, doc, expr))
                    }
                })
                .map(|parts| {
                    parts
                        .into_iter()
                        .map(|(text, hit)| json!({ "text": text, "hit": hit }))
                        .collect::<Vec<_>>()
                }),
            _ => None,
        };
        out.push(json!({
            "drive_id": hit.drive_id,
            "path": full,
            "parent": hit.parent,
            "name": hit.name,
            "kind": hit.kind,
            "size": hit.size,
            "modified": hit.modified,
            "match": match_label(candidate.rank.tier),
            "private": private,
            "in_private": in_private,
            "snippet": snippet,
        }));
    }
    (out, false)
}

/// How a hit matched, for the page: by its name, a near miss (a typo away),
/// words inside the file, a passage about the same thing, or what a photo
/// shows.
fn match_label(tier: Tier) -> &'static str {
    match tier {
        Tier::Close => "close",
        Tier::Content => "content",
        Tier::Meaning => "meaning",
        Tier::Photo => "photo",
        _ => "name",
    }
}

/// Wipe all accounts, shares, and settings and return the box to first-run,
/// leaving the actual files on the drives untouched. The body always chooses
/// Keep Connect or Disconnect; a failed disconnect remains pending.
async fn factory_reset(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<FactoryResetBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can reset this Luna.",
        ));
    }
    if !body.confirm {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Confirm that you want to reset this Luna. Everyone is signed out and backups stop. Files on your drives are not deleted.",
        ));
    }
    if body.password.trim().is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type your current password to confirm this reset.",
        ));
    }
    crate::api::auth::confirm_password(
        &state,
        &user,
        &body.password,
        "That password is wrong. Reset was not started.",
    )
    .await?;
    // Keep Connect leaves its rolling credential and bound configuration alone.
    // Disconnect revokes first; an unavailable Connect leaves a durable pending
    // marker, so the local reset may finish without deleting the only credential.
    let disconnect = body.connect == ConnectChoice::Disconnect;
    let connect = state.connect.clone();
    tokio::task::spawn_blocking(move || connect.prepare_factory_reset(disconnect))
        .await
        .map_err(|_| reset_failed())?
        .map_err(|_| reset_failed())?;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // Un-adopt every drive (remove this Luna's `.luna-*` marker and unmount
    // Luna-owned mounts) so the data is left intact but no longer owned by
    // Luna.
    let drives = crate::db::list_drives(&conn).unwrap_or_default();
    for drive in drives {
        if !drive.mount_point.is_empty() {
            let _ = luna_core::marker::remove_marker(
                std::path::Path::new(&drive.mount_point),
                &drive.id,
            );
            let _ = state.drive_manager.eject(&conn, &drive.id);
        }
    }
    crate::db::factory_reset(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the reset. Try again.",
        )
    })?;
    // The reset dropped the stored update source with the rest of `meta`;
    // stop following the previous owner's feed and keys right away, not at
    // the next restart.
    let source = crate::system::updates::effective_settings(&conn);
    drop(conn);
    state
        .updates
        .reconfigure(source.feed_url, source.channel, source.keys);
    let new_secret = crate::secrets::rotate_jwt_secret(&state.data_dir).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the reset. Try again.",
        )
    })?;
    state.auth.reload_secret(new_secret);
    Ok(Json(
        json!({ "ok": true, "message": "Luna has been reset. Set it up again from the start." }),
    ))
}

#[cfg(test)]
mod tests {
    use super::{Candidate, Tier, match_label, names_fill_answer, visible_hits};
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    fn test_state(dir: &std::path::Path) -> crate::AppState {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir));
        let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
            dir,
            Some("http://127.0.0.1:1".into()),
        ));
        crate::AppState::new(conn, drive_manager, dir).with_connect(connect)
    }

    fn test_app(dir: &std::path::Path) -> axum::Router {
        app_for(test_state(dir))
    }

    fn app_for(state: crate::AppState) -> axum::Router {
        api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state)
    }

    fn req(
        method: Method,
        uri: &str,
        body: &str,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        if let Some(t) = csrf {
            builder = builder.header("x-csrf-token", t);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn auth_cookies(res: &axum::response::Response) -> (String, String) {
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (session, csrf)
    }

    fn cookie_header(session: &str, csrf: &str) -> String {
        format!("{session}; luna_csrf={csrf}")
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    fn candidate(drive: &str, parent: &str, name: &str, kind: &str, tier: Tier) -> Candidate {
        Candidate {
            hit: crate::files::search::SearchHit {
                drive_id: drive.into(),
                parent: parent.into(),
                name: name.into(),
                kind: kind.into(),
                size: 1,
                modified: 1,
            },
            doc: None,
            passage: None,
            rank: crate::files::search_rank::Rank {
                tier,
                score: 0,
                typos: 0,
                file: u8::from(kind != "dir"),
                len: name.len(),
            },
        }
    }

    fn member_setup() -> (
        tempfile::TempDir,
        rusqlite::Connection,
        crate::auth::CurrentUser,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let root = crate::testutil::mount_drive(&conn, dir.path(), "d1");
        for folder in ["docs", "shared"] {
            std::fs::create_dir(root.join(folder)).unwrap();
        }
        let user = crate::auth::CurrentUser {
            id: "u1".into(),
            username: "sam".into(),
            role: "member".into(),
        };
        (dir, conn, user)
    }

    #[test]
    fn the_limit_counts_only_hits_the_member_can_open() {
        let (_dir, conn, member) = member_setup();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: "shared".into(),
                album_id: String::new(),
                user_id: "u1".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "a".into(),
            },
        )
        .unwrap();
        // Ten better-ranked names in a private folder, then two in the shared one.
        let mut ranked: Vec<Candidate> = (0..10)
            .map(|i| {
                candidate(
                    "d1",
                    "private",
                    &format!("budget {i}"),
                    "file",
                    Tier::Prefix,
                )
            })
            .collect();
        ranked.push(candidate(
            "d1",
            "shared",
            "budget a",
            "file",
            Tier::Substring,
        ));
        ranked.push(candidate(
            "d1",
            "shared",
            "budget b",
            "file",
            Tier::Substring,
        ));
        let (got, truncated) = visible_hits(&conn, &member, ranked, 2, None);
        let names: Vec<&str> = got.iter().map(|h| h["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["budget a", "budget b"]);
        // No third visible hit exists, so nothing was cut off.
        assert!(!truncated);
    }

    #[test]
    fn the_limit_reports_when_more_visible_hits_were_left_out() {
        let (_dir, conn, _) = member_setup();
        let admin = crate::auth::CurrentUser {
            id: "a".into(),
            username: "max".into(),
            role: "admin".into(),
        };
        let ranked = vec![
            candidate("d1", "docs", "a.txt", "file", Tier::Prefix),
            candidate("d1", "docs", "b.txt", "file", Tier::Prefix),
            candidate("d1", "docs", "c.txt", "file", Tier::Prefix),
        ];
        let (got, truncated) = visible_hits(&conn, &admin, ranked.clone(), 2, None);
        assert_eq!(got.len(), 2);
        assert!(truncated);
        let (got, truncated) = visible_hits(&conn, &admin, ranked, 3, None);
        assert_eq!(got.len(), 3);
        assert!(!truncated);
    }

    #[test]
    fn member_finds_granted_match_beyond_old_candidate_limits() {
        use crate::files::search::{DriveRef, KindFilter, search_all};
        use crate::files::search_rank::Query;
        let (dir, conn, member) = member_setup();
        let root = dir.path().join("d1");
        let drive = crate::drives::drive_db::open(&root).unwrap();
        // Insert the inaccessible matches first, so the granted row crosses
        // both the old 300-candidate and 1500-row cutoffs.
        for i in 0..1601 {
            let parent = if i == 1600 { "shared" } else { "hidden-area" };
            drive.execute("INSERT INTO index_entries (drive_id,parent,name,kind,size,modified,hidden) VALUES ('d1',?1,?2,'file',1,1,0)", rusqlite::params![parent, format!("budget {i:04}.txt")]).unwrap();
        }
        drop(drive);
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: "shared".into(),
                album_id: String::new(),
                user_id: "u1".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "a".into(),
            },
        )
        .unwrap();
        let drives = [DriveRef {
            id: "d1".into(),
            mount: root,
        }];
        let (candidates, incomplete) =
            search_all(&drives, &Query::new("budget"), KindFilter::All).unwrap();
        let (hits, truncated) = visible_hits(&conn, &member, candidates, 60, None);
        assert!(!incomplete);
        assert!(!truncated);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "shared/budget 1600.txt");
    }

    #[test]
    fn admin_sees_only_private_items_they_are_granted() {
        let (dir, conn, _) = member_setup();
        let root = dir.path().join("d1");
        crate::db::insert_user(&conn, "owner", "owner", "owner", "unused", "user").unwrap();
        crate::db::insert_user(&conn, "a", "admin", "admin", "unused", "admin").unwrap();
        std::fs::create_dir(root.join("Private")).unwrap();
        crate::private::privatize(&root, "Private", "owner").unwrap();
        let admin = crate::auth::CurrentUser {
            id: "a".into(),
            username: "admin".into(),
            role: "admin".into(),
        };
        let hits = vec![candidate(
            "d1",
            "Private",
            "notes.txt",
            "file",
            Tier::Prefix,
        )];
        assert!(
            visible_hits(&conn, &admin, hits.clone(), 10, None)
                .0
                .is_empty()
        );
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: "Private/notes.txt".into(),
                album_id: String::new(),
                user_id: "a".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "owner".into(),
            },
        )
        .unwrap();
        assert_eq!(visible_hits(&conn, &admin, hits, 10, None).0.len(), 1);
    }

    #[test]
    fn hidden_folders_and_luna_files_never_show_up() {
        let (_dir, conn, _) = member_setup();
        let admin = crate::auth::CurrentUser {
            id: "a".into(),
            username: "max".into(),
            role: "admin".into(),
        };
        let ranked = vec![
            candidate("d1", ".config", "settings.json", "file", Tier::Prefix),
            candidate("d1", "", ".luna-1234-trash", "dir", Tier::Prefix),
            candidate("d1", "docs", "settings.txt", "file", Tier::Prefix),
        ];
        let (got, _) = visible_hits(&conn, &admin, ranked, 10, None);
        let paths: Vec<&str> = got.iter().map(|h| h["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["docs/settings.txt"]);
    }

    #[test]
    fn names_fill_the_answer_only_with_enough_visible_name_matches() {
        let (_dir, conn, member) = member_setup();
        let admin = crate::auth::CurrentUser {
            id: "a".into(),
            username: "max".into(),
            role: "admin".into(),
        };
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: "shared".into(),
                album_id: String::new(),
                user_id: "u1".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "a".into(),
            },
        )
        .unwrap();
        let names = vec![
            candidate("d1", "private", "budget 1", "file", Tier::Prefix),
            candidate("d1", "shared", "budget 2", "file", Tier::Prefix),
            candidate("d1", "shared", "budget 3", "file", Tier::Substring),
            // A near miss ranks below matches inside files: it can't count.
            candidate("d1", "shared", "budgte", "file", Tier::Close),
        ];
        // Two visible names fill a limit of one (and show it was cut off).
        assert!(names_fill_answer(&conn, &member, &names, 1));
        // The member sees only two of the three name matches.
        assert!(!names_fill_answer(&conn, &member, &names, 2));
        assert!(names_fill_answer(&conn, &admin, &names, 2));
        assert!(!names_fill_answer(&conn, &admin, &names, 3));
        assert!(!names_fill_answer(&conn, &admin, &[], 1));
    }

    #[test]
    fn match_labels_tell_names_from_near_misses() {
        assert_eq!(match_label(Tier::Exact), "name");
        assert_eq!(match_label(Tier::AllWords), "name");
        assert_eq!(match_label(Tier::Close), "close");
    }

    #[tokio::test]
    async fn factory_reset_requires_a_connect_choice() {
        let dir = tempfile::tempdir().unwrap();
        linked(dir.path());
        assert!(dir.path().join("connect.json").exists());
        let app = test_app(dir.path());

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let cookie = cookie_header(&session, &csrf);

        let denied = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":false,"connect":"keep"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(denied.status(), 400);
        assert!(dir.path().join("connect.json").exists());

        let missing_choice = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(missing_choice.status(), 422);
        assert!(dir.path().join("connect.json").exists());

        let ok = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1","connect":"keep"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(ok.status(), 200, "reset failed");
        assert!(
            dir.path().join("connect.json").exists(),
            "Keep Connect leaves the bound configuration in place"
        );
        assert!(
            dir.path()
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE)
                .exists(),
            "Keep Connect retains the rolling credential"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(crate::net::connect::DEVICE_TOKEN_FILE))
                .unwrap()
                .trim(),
            "7K4M2Q9XR8N36T5W1PZH"
        );
    }

    #[tokio::test]
    async fn factory_reset_puts_updates_back_on_the_built_in_source() {
        use crate::system::updates::{UpdateSettings, default_settings, save_settings};
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        // The previous owner's own feed and signing key, stored and live.
        let custom = UpdateSettings {
            feed_url: "https://feeds.example.test/luna".into(),
            channel: "beta".into(),
            keys: vec![
                minisign::KeyPair::generate_unencrypted_keypair()
                    .unwrap()
                    .pk
                    .to_base64(),
            ],
        };
        save_settings(&state.db.lock().unwrap(), &custom).unwrap();
        state.updates.reconfigure(
            custom.feed_url.clone(),
            custom.channel.clone(),
            custom.keys.clone(),
        );
        assert!(!state.updates.using_default_keys());
        let app = app_for(state.clone());

        let body = r#"{"username":"max","password":"hunter22hunter1"}"#;
        let res = call(
            &app,
            req(Method::POST, "/api/v1/auth/register", body, None, None),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            req(Method::POST, "/api/v1/auth/login", body, None, None),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let cookie = cookie_header(&session, &csrf);
        let ok = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1","connect":"keep"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(ok.status(), 200, "reset failed");

        let live = state.updates.settings();
        let defaults = default_settings();
        assert_eq!(live.feed_url, defaults.feed_url);
        assert_eq!(live.channel, defaults.channel);
        assert!(state.updates.using_default_keys());
    }

    /// Registers and signs in the first Admin; returns the cookie header and CSRF token.
    async fn sign_in(app: &axum::Router) -> (String, String) {
        let body = r#"{"username":"max","password":"hunter22hunter1"}"#;
        let res = call(
            app,
            req(Method::POST, "/api/v1/auth/register", body, None, None),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            app,
            req(Method::POST, "/api/v1/auth/login", body, None, None),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        (cookie_header(&session, &csrf), csrf)
    }

    fn linked(dir: &std::path::Path) {
        std::fs::write(
            dir.join(crate::net::connect::DEVICE_TOKEN_FILE),
            "7K4M2Q9XR8N36T5W1PZH\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
        )
        .unwrap();
        let connect =
            crate::net::connect::ConnectService::new(dir, Some("http://127.0.0.1:1".into()));
        connect
            .save(&serde_json::json!({
                "state": "bound",
                "bound": true,
                "paired": true,
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock-token",
                "tunnel_active": true,
            }))
            .unwrap();
    }

    #[tokio::test]
    async fn factory_reset_that_stays_linked_leaves_connect_alone() {
        let dir = tempfile::tempdir().unwrap();
        linked(dir.path());
        let app = test_app(dir.path());
        let (cookie, csrf) = sign_in(&app).await;
        let ok = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1","connect":"keep"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(ok.status(), 200, "reset failed");
        assert!(dir.path().join("connect.json").exists(), "the link stays");
        assert!(
            dir.path()
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE)
                .exists(),
            "the rolling credential stays"
        );
        assert!(
            !dir.path()
                .join(crate::net::connect::UNBIND_PENDING_FILE)
                .exists()
        );
    }

    #[tokio::test]
    async fn factory_reset_disconnect_refuses_to_finish_while_unbind_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        linked(dir.path());
        let state = test_state(dir.path());
        let app = app_for(state.clone());
        let (cookie, csrf) = sign_in(&app).await;
        let failed = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"hunter22hunter1","connect":"disconnect"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(failed.status(), 500);
        assert_eq!(
            state.auth.count_users().unwrap(),
            1,
            "the reset did not finish"
        );
        assert!(state.connect.unbind_pending(), "the unbind is owed");
        assert!(
            dir.path()
                .join(crate::net::connect::UNBIND_PENDING_FILE)
                .exists()
        );
        assert!(dir.path().join("connect.json").exists());
        assert!(
            dir.path()
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE)
                .exists(),
            "the only revocation credential is retained while Connect may still be bound"
        );
        assert_eq!(
            state.connect.device_token().unwrap(),
            "7K4M2Q9XR8N36T5W1PZH"
        );

        // The first account still exists, and a pending disconnect does not
        // open anonymous registration off Luna's network.
        let mut remote = req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"eve","password":"hunter22hunter1","device_token":"7K4M2Q9XR8N36T5W1PZH"}"#,
            None,
            None,
        );
        remote
            .extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7)),
                40000,
            )));
        let res = call(&app, remote).await;
        assert_eq!(res.status(), 401);
    }

    #[tokio::test]
    async fn factory_reset_with_a_wrong_password_leaves_connect_alone() {
        let dir = tempfile::tempdir().unwrap();
        linked(dir.path());
        let app = test_app(dir.path());
        let (cookie, csrf) = sign_in(&app).await;
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/system/factory-reset",
                r#"{"confirm":true,"password":"wrong-password-1","connect":"disconnect"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 401);
        assert!(dir.path().join("connect.json").exists());
        assert!(
            !dir.path()
                .join(crate::net::connect::UNBIND_PENDING_FILE)
                .exists()
        );
    }
}
