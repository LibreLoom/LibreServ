//! Private items: files and folders only their owner (and anyone they
//! share them with) can reach through Luna.
//!
//! This is access control, not encryption. A private item lives on disk as
//! `.luna-<drive-uuid>-<id>` inside the drive's own namespace, so Luna's
//! existing rules already hide it from listings, indexes and zips. The drive
//! database's `private_items` table says which real name each one has, who
//! owns it, and where it sits. Everything else keeps keying on real paths.
//!
//! A path segment whose real path has a row is stored under its private
//! name; everything below keeps real names until the next private item.
//! An entry with no row is hidden from everyone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use rusqlite::params;

/// One private file or folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub owner: String,
    /// Real drive-relative path, no leading slash.
    pub path: String,
}

impl Item {
    pub fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// A drive's private items, indexed by real path.
#[derive(Debug, Default)]
pub struct Rows {
    prefix: String,
    /// Canonical mount point, to place absolute paths on this drive.
    canon: PathBuf,
    by_path: HashMap<String, Item>,
}

type Shared = Arc<RwLock<Rows>>;

fn registry() -> &'static RwLock<HashMap<PathBuf, Shared>> {
    static REG: OnceLock<RwLock<HashMap<PathBuf, Shared>>> = OnceLock::new();
    REG.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Random on-drive id: 26 lowercase base32 characters (130 bits).
pub fn new_id() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 26];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    bytes
        .iter()
        .map(|b| ALPHABET[(*b & 31) as usize] as char)
        .collect()
}

/// The `.luna-<uuid>-<id>` name an item has on disk.
pub fn disk_name(prefix: &str, id: &str) -> String {
    format!("{prefix}-{id}")
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Is `path` equal to `base` or inside it?
fn within(path: &str, base: &str) -> bool {
    base.is_empty()
        || path == base
        || path
            .strip_prefix(base)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn load(root: &Path) -> Option<Rows> {
    let prefix = crate::drives::drive_db::prefix_for(root)?;
    let conn = crate::drives::drive_db::open(root).ok()?;
    let mut stmt = conn
        .prepare("SELECT id, owner_user_id, path FROM private_items")
        .ok()?;
    let items = stmt
        .query_map([], |r| {
            Ok(Item {
                id: r.get(0)?,
                owner: r.get(1)?,
                path: r.get(2)?,
            })
        })
        .ok()?
        .filter_map(Result::ok);
    let mut rows = Rows {
        prefix,
        canon: root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        by_path: HashMap::new(),
    };
    for item in items {
        rows.by_path.insert(item.path.clone(), item);
    }
    reconcile(&conn, &mut rows);
    Some(rows)
}

/// Put rows back in step with the drive. A drive edited elsewhere can have
/// private entries moved or removed; paths are recomputed from where each
/// `.luna-` entry now sits, and rows with no entry are dropped. Costs a walk
/// only when some row's entry is not where its row says.
fn reconcile(conn: &rusqlite::Connection, rows: &mut Rows) {
    let lost = |r: &Rows| {
        r.by_path.values().any(|i| {
            let disk = disk_in(&r.by_path, &r.prefix, &i.path);
            std::fs::symlink_metadata(r.canon.join(disk)).is_err()
        })
    };
    if rows.by_path.is_empty() || !lost(rows) {
        return;
    }
    let ids: std::collections::HashSet<String> =
        rows.by_path.values().map(|i| i.id.clone()).collect();
    let lead = format!("{}-", rows.prefix);
    // id -> disk-relative folder it was found in
    let mut found: HashMap<String, String> = HashMap::new();
    let mut stack = vec![String::new()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(rows.canon.join(&dir)) else {
            continue;
        };
        for entry in read.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let id = name.strip_prefix(&lead).filter(|id| ids.contains(*id));
            if let Some(id) = id {
                found.insert(id.to_string(), dir.clone());
            } else if crate::drives::layout::Layout::is_luna_name(&name)
                && name != format!("{}-trash", rows.prefix)
            {
                continue;
            }
            if meta.is_dir() {
                stack.push(join(&dir, &name));
            }
        }
    }
    // Resolve shallow entries first: a folder's real path needs the real
    // paths of the private folders above it.
    let mut pending: Vec<Item> = rows.by_path.values().cloned().collect();
    let mut resolved: HashMap<String, Item> = HashMap::new();
    for _ in 0..64 {
        let before = pending.len();
        pending.retain(|item| {
            let Some(parent_disk) = found.get(&item.id) else {
                return true;
            };
            let by_id: HashMap<&str, &Item> =
                resolved.values().map(|i| (i.id.as_str(), i)).collect();
            let mut parent = String::new();
            for seg in parent_disk.split('/').filter(|s| !s.is_empty()) {
                match seg.strip_prefix(&lead).and_then(|id| by_id.get(id)) {
                    Some(up) => parent = up.path.clone(),
                    None if seg.starts_with(&lead) => return true,
                    None => parent = join(&parent, seg),
                }
            }
            let path = join(&parent, item.name());
            resolved.insert(
                path.clone(),
                Item {
                    path,
                    ..item.clone()
                },
            );
            false
        });
        if pending.len() == before {
            break;
        }
    }
    for item in &pending {
        let _ = conn.execute("DELETE FROM private_items WHERE id = ?1", params![item.id]);
    }
    for item in resolved.values() {
        let _ = conn.execute(
            "UPDATE private_items SET path = ?1 WHERE id = ?2",
            params![item.path, item.id],
        );
    }
    rows.by_path = resolved;
}

/// The loaded rows for the drive mounted at `root` (loaded on first use).
/// `None` for a drive without a Luna marker.
fn shared(root: &Path) -> Option<Shared> {
    if let Ok(map) = registry().read()
        && let Some(s) = map.get(root)
    {
        return Some(s.clone());
    }
    let fresh = Arc::new(RwLock::new(load(root)?));
    let mut map = registry().write().ok()?;
    Some(map.entry(root.to_path_buf()).or_insert(fresh).clone())
}

/// Forget a drive's rows (unmount, eject).
pub fn forget(root: &Path) {
    if let Ok(mut map) = registry().write() {
        map.remove(root);
    }
}

fn read<T>(root: &Path, f: impl FnOnce(&Rows) -> T) -> Option<T> {
    let s = shared(root)?;
    let g = s.read().ok()?;
    Some(f(&g))
}

/// The row for a real path, if that exact path is private.
pub fn item_at(root: &Path, path: &str) -> Option<Item> {
    read(root, |r| r.by_path.get(path.trim_matches('/')).cloned()).flatten()
}

/// Translate a real path into its on-disk path by swapping every private
/// segment for its `.luna-<uuid>-<id>` name. Paths with no private segment
/// come back unchanged.
pub fn disk_rel(root: &Path, rel: &str) -> String {
    read(root, |r| {
        if r.by_path.is_empty() {
            rel.to_string()
        } else {
            disk_in(&r.by_path, &r.prefix, rel)
        }
    })
    .unwrap_or_else(|| rel.to_string())
}

/// Owner of a boundary that nobody may cross: a path that spells out an
/// item's `.luna-` disk name instead of its real one.
pub const SEALED: &str = "\u{0}";

/// Is `id` shaped like one of our 26-character base32 item ids?
fn is_disk_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// The nearest private item at or above a path, for the access rule.
#[derive(Debug, Clone)]
pub struct Boundary {
    /// Real path of the private item.
    pub path: String,
    /// The user who owns it.
    pub owner: String,
}

/// The deepest private item at or above `rel` (a real path, trash paths
/// included).
pub fn boundary_for(root: &Path, rel: &str) -> Option<Boundary> {
    read(root, |r| boundary_in(r, rel)).flatten()
}

fn boundary_in(r: &Rows, rel: &str) -> Option<Boundary> {
    if r.by_path.is_empty() {
        return None;
    }
    let lead = format!("{}-", r.prefix);
    let mut logical = String::new();
    let mut found = None;
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        // A path that names the disk entry itself is not how anyone reaches
        // a private item: it belongs to nobody.
        if seg.strip_prefix(&lead).is_some_and(is_disk_id) {
            return Some(Boundary {
                path: join(&logical, seg),
                owner: SEALED.to_string(),
            });
        }
        logical = join(&logical, seg);
        if let Some(item) = r.by_path.get(&logical) {
            found = Some(Boundary {
                path: item.path.clone(),
                owner: item.owner.clone(),
            });
        }
    }
    found
}

/// A request resolved through a symlink may stand for its path only if the
/// link's target sits in the same private boundary as the path asked for —
/// a link must not carry a request into (or out of) a private item.
fn resolved_ok(root: &Path, rel: &str, resolved: &Path) -> bool {
    read(root, |r| {
        if r.by_path.is_empty() {
            return true;
        }
        let Ok(tail) = resolved.strip_prefix(&r.canon) else {
            return true;
        };
        let Some(disk) = tail.to_str() else {
            return false;
        };
        let target = logical_in(r, disk);
        let a = boundary_in(r, rel).map(|b| b.path);
        let b = boundary_in(r, &target).map(|b| b.path);
        a == b
    })
    .unwrap_or(true)
}

/// The on-disk name of the private item called `name` in the folder at
/// absolute path `dir`, if there is one. Private items sit under `.luna-`
/// names, so the filesystem alone cannot say a real name is taken.
pub fn entry_in(dir: &Path, name: &str) -> Option<String> {
    let reg = registry().read().ok()?;
    reg.values().find_map(|s| {
        let r = s.read().ok()?;
        r.by_path.values().find_map(|i| {
            let parent = i.path.rsplit_once('/').map_or("", |(p, _)| p);
            (i.name() == name && r.canon.join(disk_in(&r.by_path, &r.prefix, parent)) == dir)
                .then(|| disk_name(&r.prefix, &i.id))
        })
    })
}

/// Would placing a plain entry at the absolute path `dest` give a folder two
/// items with one real name — because a private item already has it?
pub fn sibling_clash(dest: &Path) -> bool {
    match (dest.file_name().and_then(|n| n.to_str()), dest.parent()) {
        (Some(name), Some(dir)) => entry_in(dir, name).is_some(),
        _ => false,
    }
}

/// Swap private segments of `rel` for their disk names.
fn disk_in(by_path: &HashMap<String, Item>, prefix: &str, rel: &str) -> String {
    let mut logical = String::new();
    let mut disk = String::new();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        logical = join(&logical, seg);
        let on_disk = match by_path.get(&logical) {
            Some(item) => disk_name(prefix, &item.id),
            None => seg.to_string(),
        };
        disk = join(&disk, &on_disk);
    }
    disk
}

/// [`disk_rel`] for the path jail: `None` when nothing changes.
fn rel_mapper(root: &Path, rel: &str) -> Option<String> {
    let disk = disk_rel(root, rel);
    (disk != rel).then_some(disk)
}

/// Teach the path jail about private items. Call before any drive is
/// touched; repeat calls do nothing.
pub fn install() {
    luna_core::path::set_rel_mapper(rel_mapper);
    luna_core::path::set_resolved_check(resolved_ok);
}

/// The real name of the private item stored under on-disk name `seg`, on
/// any mounted drive.
pub fn name_for_disk(seg: &str) -> Option<String> {
    let reg = registry().read().ok()?;
    reg.values().find_map(|s| {
        let r = s.read().ok()?;
        let id = seg.strip_prefix(&format!("{}-", r.prefix))?;
        r.by_path
            .values()
            .find(|i| i.id == id)
            .map(|i| i.name().to_string())
    })
}

/// Is `seg` the on-disk name of a private item on any mounted drive?
pub fn is_private_disk_name(seg: &str) -> bool {
    let Ok(reg) = registry().read() else {
        return false;
    };
    reg.values().any(|s| {
        let Ok(r) = s.read() else { return false };
        seg.strip_prefix(&format!("{}-", r.prefix))
            .is_some_and(|id| r.by_path.values().any(|i| i.id == id))
    })
}

/// The real path for an on-disk path (as file watchers report them):
/// each `.luna-<uuid>-<id>` segment with a row stands for that item's real
/// path. Segments with no row stay as they are.
pub fn logical_rel(root: &Path, disk: &str) -> String {
    read(root, |r| logical_in(r, disk)).unwrap_or_else(|| disk.to_string())
}

fn logical_in(r: &Rows, disk: &str) -> String {
    if r.by_path.is_empty() {
        return disk.to_string();
    }
    let by_id: HashMap<&str, &Item> = r.by_path.values().map(|i| (i.id.as_str(), i)).collect();
    let lead = format!("{}-", r.prefix);
    let mut out = String::new();
    for seg in disk.split('/').filter(|s| !s.is_empty()) {
        let item = seg.strip_prefix(&lead).and_then(|id| by_id.get(id));
        out = match item {
            Some(item) => item.path.clone(),
            None => join(&out, seg),
        };
    }
    out
}

/// The on-disk name of the private item at exactly `path`.
pub fn disk_leaf(root: &Path, path: &str) -> Option<String> {
    read(root, |r| {
        r.by_path
            .get(path.trim_matches('/'))
            .map(|i| disk_name(&r.prefix, &i.id))
    })
    .flatten()
}

/// Does a `.luna-` name on disk belong to a private item with a row?
pub fn owns_disk_name(root: &Path, name: &str) -> bool {
    read(root, |r| {
        name.strip_prefix(&format!("{}-", r.prefix))
            .is_some_and(|id| r.by_path.values().any(|i| i.id == id))
    })
    .unwrap_or(false)
}

/// This drive's `.luna-<uuid>` prefix.
pub fn prefix_of(root: &Path) -> Option<String> {
    read(root, |r| r.prefix.clone())
}

/// Real names of the private entries sitting directly in directory
/// `parent`, keyed by their on-disk name.
pub fn children_of(root: &Path, parent: &str) -> HashMap<String, Item> {
    let parent = parent.trim_matches('/');
    read(root, |r| {
        r.by_path
            .values()
            .filter(|i| i.path.rsplit_once('/').map_or("", |(p, _)| p) == parent)
            .map(|i| (disk_name(&r.prefix, &i.id), i.clone()))
            .collect()
    })
    .unwrap_or_default()
}

/// Every private item at or below `path` (a folder and what it holds).
pub fn under(root: &Path, path: &str) -> Vec<Item> {
    let path = path.trim_matches('/');
    read(root, |r| {
        r.by_path
            .values()
            .filter(|i| within(&i.path, path))
            .cloned()
            .collect()
    })
    .unwrap_or_default()
}

/// How many private items a user owns on this drive.
pub fn count_owned(root: &Path, user_id: &str) -> usize {
    read(root, |r| {
        r.by_path.values().filter(|i| i.owner == user_id).count()
    })
    .unwrap_or(0)
}

/// File name for the private-item manifest that travels with a folder
/// backed up without its drive's database: `<prefix>-private.json`.
pub fn manifest_name(root: &Path) -> Option<String> {
    prefix_of(root).map(|p| format!("{p}-private.json"))
}

/// What a backup of the folder at real path `rel` needs to put names back on
/// the `.luna-` entries inside it: id, name, owner and real path of each
/// private item. `None` when the folder holds none.
pub fn manifest_json(root: &Path, rel: &str) -> Option<String> {
    let mut items = under(root, rel);
    if items.is_empty() {
        return None;
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    let list: Vec<serde_json::Value> = items
        .iter()
        .map(|i| {
            serde_json::json!({
                "id": i.id,
                "name": i.name(),
                "owner": i.owner,
                "path": i.path,
            })
        })
        .collect();
    serde_json::to_string_pretty(&list).ok()
}

/// Mount points of every drive Luna can currently read.
fn mounted_roots(conn: &rusqlite::Connection) -> Vec<PathBuf> {
    crate::db::list_drives(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|d| !d.mount_point.is_empty() && (d.state == "as_is" || d.state == "readonly"))
        .map(|d| PathBuf::from(d.mount_point))
        .collect()
}

/// Private items a person owns, across every mounted drive.
pub fn owned_total(conn: &rusqlite::Connection, user_id: &str) -> usize {
    mounted_roots(conn)
        .iter()
        .map(|root| count_owned(root, user_id))
        .sum()
}

/// Does this Luna know a person with this id?
pub fn owner_known(conn: &rusqlite::Connection, owner: &str) -> bool {
    owner_state(conn, owner) != OwnerState::Foreign
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerState {
    Active,
    Deleted,
    Foreign,
}

pub fn owner_state(conn: &rusqlite::Connection, owner: &str) -> OwnerState {
    if owner == SEALED {
        return OwnerState::Deleted;
    }
    match crate::db::get_user(conn, owner) {
        Ok(Some(_)) => return OwnerState::Active,
        Err(_) => return OwnerState::Deleted,
        Ok(None) => {}
    }
    match conn
        .prepare("SELECT 1 FROM deleted_users WHERE id = ?1")
        .and_then(|mut s| s.exists(params![owner]))
    {
        Ok(false) => OwnerState::Foreign,
        _ => OwnerState::Deleted,
    }
}

pub fn owner_states(conn: &rusqlite::Connection) -> anyhow::Result<HashMap<String, OwnerState>> {
    let mut states = HashMap::from([(SEALED.to_string(), OwnerState::Deleted)]);
    for user in crate::db::list_users(conn)? {
        states.insert(user.id, OwnerState::Active);
    }
    let mut stmt = conn.prepare("SELECT id FROM deleted_users")?;
    for id in stmt.query_map([], |r| r.get::<_, String>(0))? {
        states.insert(id?, OwnerState::Deleted);
    }
    Ok(states)
}

/// Private items whose owner this Luna has never heard of: they came with a
/// drive from another Luna.
fn ownerless(conn: &rusqlite::Connection) -> Vec<(PathBuf, Item)> {
    mounted_roots(conn)
        .into_iter()
        .flat_map(|root| {
            under(&root, "")
                .into_iter()
                .filter(|i| !owner_known(conn, &i.owner))
                .map(move |i| (root.clone(), i))
                .collect::<Vec<_>>()
        })
        .collect()
}

pub fn ownerless_total(conn: &rusqlite::Connection) -> usize {
    ownerless(conn).len()
}

/// Give every ownerless private item to `user_id`. Returns how many moved.
pub fn adopt_ownerless(conn: &rusqlite::Connection, user_id: &str) -> usize {
    ownerless(conn)
        .into_iter()
        .filter(|(root, item)| set_owner(root, &item.path, user_id).unwrap_or(false))
        .count()
}

/// One drive's share of a deleted person's private items. Kept near
/// [`orphaned`]; deleted people's items are never purged implicitly — the
/// Admin cleanup list calls [`purge_orphan`] explicitly.
pub struct OrphanDrive {
    pub drive_id: String,
    pub drive_label: String,
    pub count: usize,
    pub trash_count: usize,
    /// A read-only mount cannot be cleaned until it is writable again.
    pub readonly: bool,
}

/// A deleted person who still owns private items on mounted drives.
pub struct OrphanOwner {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub deleted_at: i64,
    pub drives: Vec<OrphanDrive>,
}

/// What the Admin cleanup list shows: each deleted person with private
/// items on a mounted drive, plus labels of drives that are not readable
/// right now — their contents cannot be counted, so any totals are partial.
pub struct OrphanReport {
    pub owners: Vec<OrphanOwner>,
    pub offline_drives: Vec<String>,
}

/// Group private items whose owner is in `deleted_users`, by owner and drive.
/// Nothing here is reachable by anyone — deleted people hold no sessions.
pub fn orphaned(conn: &rusqlite::Connection) -> OrphanReport {
    let gone: HashMap<String, (String, String, i64)> = conn
        .prepare("SELECT id, username, display_name, deleted_at FROM deleted_users")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
                .map(|it| it.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    let mut owners: HashMap<String, OrphanOwner> = HashMap::new();
    let mut offline = Vec::new();
    for drive in crate::db::list_drives(conn).unwrap_or_default() {
        let mounted =
            !drive.mount_point.is_empty() && (drive.state == "as_is" || drive.state == "readonly");
        if !mounted {
            offline.push(drive.label);
            continue;
        }
        let root = PathBuf::from(&drive.mount_point);
        let mut by_owner: HashMap<String, usize> = HashMap::new();
        for item in under(&root, "") {
            if gone.contains_key(&item.owner) {
                *by_owner.entry(item.owner).or_default() += 1;
            }
        }
        let mut trash_counts = HashMap::<String, usize>::new();
        if let Some(layout) = crate::drives::layout::Layout::detect(&root) {
            for (entry, meta) in crate::files::trash_meta_map(&root) {
                let path = join(&layout.trash_name(), &entry);
                if gone.contains_key(&meta.private_owner) && item_at(&root, &path).is_none() {
                    *by_owner.entry(meta.private_owner.clone()).or_default() += 1;
                    *trash_counts.entry(meta.private_owner).or_default() += 1;
                }
            }
        }
        for (owner, count) in by_owner {
            let Some((username, display_name, deleted_at)) = gone.get(&owner) else {
                continue;
            };
            owners
                .entry(owner.clone())
                .or_insert_with(|| OrphanOwner {
                    user_id: owner.clone(),
                    username: username.clone(),
                    display_name: display_name.clone(),
                    deleted_at: *deleted_at,
                    drives: Vec::new(),
                })
                .drives
                .push(OrphanDrive {
                    drive_id: drive.id.clone(),
                    drive_label: drive.label.clone(),
                    count,
                    trash_count: trash_counts.get(&owner).copied().unwrap_or(0),
                    readonly: drive.state == "readonly",
                });
        }
    }
    let mut owners: Vec<OrphanOwner> = owners.into_values().collect();
    owners.sort_by(|a, b| {
        a.display_name
            .cmp(&b.display_name)
            .then(a.user_id.cmp(&b.user_id))
    });
    offline.sort();
    OrphanReport {
        owners,
        offline_drives: offline,
    }
}

/// Permanently delete every private item a deleted person owns, wherever it
/// is mounted and writable. Read-only drives are reported, not cleaned —
/// their items reappear here once they mount writable again.
pub fn purge_orphan(conn: &rusqlite::Connection, user_id: &str) -> anyhow::Result<CleanupReport> {
    let mut report = CleanupReport::default();
    for drive in crate::db::list_drives(conn)? {
        if drive.mount_point.is_empty() || !matches!(drive.state.as_str(), "as_is" | "readonly") {
            report.offline_drives.push(drive.label);
            continue;
        }
        let root = Path::new(&drive.mount_point);
        let paths = owned_paths(root, user_id);
        if drive.state == "readonly" {
            if !paths.is_empty() {
                report.skipped_readonly.push(drive.label);
            }
            continue;
        }
        let mut moved = |from: &str, to: &str| {
            let tx = conn.unchecked_transaction()?;
            crate::access::repath_subjects(
                &tx,
                &drive.id,
                &api_path(root, from),
                &api_path(root, to),
            )?;
            tx.commit()?;
            Ok(())
        };
        let mut failed = false;
        let mut attempted = std::collections::HashSet::new();
        while let Some(path) = owned_paths(root, user_id)
            .into_iter()
            .find(|p| !attempted.contains(p))
        {
            attempted.insert(path.clone());
            if purge_owned_path(root, &path, user_id, &mut moved).is_err() {
                failed = true;
                continue;
            }
            crate::files::forget_trash_entry(conn, &drive.id, &path);
            crate::access::drop_subjects_under(conn, &drive.id, &api_path(root, &path))?;
        }
        crate::files::note_write(conn, &drive.id, "");
        if failed {
            report.failed_drives.push(drive.label);
        }
    }
    Ok(report)
}

#[derive(Default)]
pub struct CleanupReport {
    pub skipped_readonly: Vec<String>,
    pub failed_drives: Vec<String>,
    pub offline_drives: Vec<String>,
}

fn api_path(root: &Path, path: &str) -> String {
    crate::drives::layout::Layout::detect(root)
        .and_then(|layout| {
            path.strip_prefix(&format!("{}/", layout.trash_name()))
                .map(|tail| join(crate::files::TRASH_API_ALIAS, tail))
        })
        .unwrap_or_else(|| path.to_string())
}

fn owned_paths(root: &Path, user_id: &str) -> Vec<String> {
    let mut paths: std::collections::BTreeSet<String> = under(root, "")
        .into_iter()
        .filter(|i| i.owner == user_id)
        .map(|i| i.path)
        .collect();
    if let Some(layout) = crate::drives::layout::Layout::detect(root) {
        for (entry, meta) in crate::files::trash_meta_map(root) {
            if meta.private_owner == user_id {
                paths.insert(join(&layout.trash_name(), &entry));
            }
        }
    }
    let mut paths: Vec<_> = paths.into_iter().collect();
    paths.sort_by_key(|p| p.matches('/').count());
    paths
}

/// Delete one person's private items from a drive. Someone else's private
/// item inside one of them is lifted out first, into the folder the item
/// sat in, so nothing of theirs goes. A row goes only once its files are
/// really gone.
#[cfg(test)]
fn purge_owner_on(root: &Path, user_id: &str) {
    for path in owned_paths(root, user_id) {
        let _ = purge_owned_path(root, &path, user_id, &mut |_, _| Ok(()));
    }
}

fn purge_owned_path(
    root: &Path,
    path: &str,
    user_id: &str,
    moved: &mut dyn FnMut(&str, &str) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let parent = if crate::files::is_trash_rel(path) {
        ""
    } else {
        path.rsplit_once('/').map_or("", |(p, _)| p)
    }
    .to_string();
    // Someone else's items inside, outermost first.
    let mut keep: Vec<Item> = under(root, path)
        .into_iter()
        .filter(|i| i.owner != user_id)
        .collect();
    keep.sort_by_key(|i| i.path.matches('/').count());
    let mut lifted: Vec<String> = Vec::new();
    for f in keep {
        if lifted.iter().any(|l| within(&f.path, l)) {
            continue;
        }
        lift_out(root, &f, &parent, moved)?;
        lifted.push(f.path.clone());
    }
    let disk = luna_core::path::resolve_for_create_nofollow(root, path)?;
    match std::fs::symlink_metadata(&disk) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&disk)?,
        Ok(_) => std::fs::remove_file(&disk)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    remove_under(root, path)
}

#[cfg(test)]
pub fn purge_owner_for_test(root: &Path, user_id: &str) {
    purge_owner_on(root, user_id);
}

/// Move private item `f` into folder `dir` (a real path), under a free name.
fn lift_out(
    root: &Path,
    f: &Item,
    dir: &str,
    moved: &mut dyn FnMut(&str, &str) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let src = luna_core::path::resolve_child_nofollow(root, &f.path)?;
    let dest_dir = luna_core::path::resolve_child_nofollow(root, dir)?;
    let leaf = disk_leaf(root, &f.path).ok_or_else(|| anyhow::anyhow!("no row"))?;
    let mut name = f.name().to_string();
    let mut n = 1;
    while entry_in(&dest_dir, &name).is_some() || dest_dir.join(&name).symlink_metadata().is_ok() {
        name = format!("{} ({n})", f.name());
        n += 1;
    }
    let dest = dest_dir.join(&leaf);
    let new_path = join(dir, &name);
    crate::files::rename_noreplace(&src, &dest)?;
    if let Err(e) = repath(root, &f.path, &new_path).and_then(|()| moved(&f.path, &new_path)) {
        let _ = repath(root, &new_path, &f.path);
        let _ = crate::files::rename_noreplace(&dest, &src);
        return Err(e);
    }
    Ok(())
}

/// Lexical guard for callers that build disk paths with `join`: only
/// ordinary `a/b/c` rel paths may reach the filesystem here.
fn plain_rel(path: &str) -> anyhow::Result<&str> {
    let path = path.trim_matches('/');
    if path.is_empty()
        || path.contains('\\')
        || path.split('/').any(|part| part.is_empty() || part == ".")
        || crate::files::is_internal_temp(path)
        || crate::files::is_trash_api(path)
        || !std::path::Path::new(path)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        anyhow::bail!("invalid path");
    }
    Ok(path)
}

/// Turn the ordinary folder at `path` into a private item owned by `owner`:
/// a row appears and the directory takes its `.luna-` disk name. Private
/// items already inside keep their rows — paths stay real above each
/// boundary.
pub fn privatize(root: &Path, path: &str, owner: &str) -> anyhow::Result<Item> {
    let path = plain_rel(path)?;
    if item_at(root, path).is_some() {
        anyhow::bail!("already private");
    }
    let src = luna_core::path::resolve_child_nofollow(root, path)?;
    match std::fs::symlink_metadata(&src) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(_) => anyhow::bail!("only folders can be private"),
        Err(e) => return Err(e.into()),
    }
    // Row first: if the rename never happens, reconcile drops the orphan row.
    let item = create(root, path, owner)?;
    let dest = src.with_file_name(disk_name(
        &read(root, |r| r.prefix.clone()).unwrap_or_default(),
        &item.id,
    ));
    if let Err(e) = std::fs::rename(&src, &dest) {
        let _ = remove(root, path);
        return Err(e.into());
    }
    if let Ok(dir) = std::fs::File::open(dest.parent().unwrap_or(root)) {
        let _ = dir.sync_all();
    }
    Ok(item)
}

/// Turn the private folder at `path` back into an ordinary folder: its
/// `.luna-` entry takes the real name and the row goes. Private items
/// nested inside keep their rows — one boundary's removal never crosses
/// another.
pub fn unprivatize(root: &Path, path: &str) -> anyhow::Result<()> {
    let path = plain_rel(path)?;
    let Some(item) = item_at(root, path) else {
        anyhow::bail!("not a private folder");
    };
    let src = luna_core::path::resolve_child_nofollow(root, path)?;
    let parent = path.rsplit_once('/').map_or("", |(p, _)| p);
    let dest = luna_core::path::resolve_child_nofollow(root, parent)?.join(item.name());
    if std::fs::symlink_metadata(&dest).is_ok() {
        anyhow::bail!("a folder already has that name");
    }
    // Rename first, then drop the row: if the row outlives the rename,
    // reconcile finds no `.luna-` entry and drops it — the folder reappears
    // ordinary, never stranded hidden.
    std::fs::rename(&src, &dest)?;
    if let Err(e) = remove(root, path) {
        let _ = std::fs::rename(&dest, &src);
        return Err(e);
    }
    if let Ok(dir) = std::fs::File::open(dest.parent().unwrap_or(root)) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Record a new private item at real path `path` before its disk entry is
/// created. Returns the row.
pub fn create(root: &Path, path: &str, owner: &str) -> anyhow::Result<Item> {
    create_with_id(root, path, owner, &new_id())
}

/// [`create`] with the id chosen by the caller, who names the disk entry
/// after it.
pub fn create_with_id(root: &Path, path: &str, owner: &str, id: &str) -> anyhow::Result<Item> {
    let path = path.trim_matches('/').to_string();
    let s = shared(root).ok_or_else(|| anyhow::anyhow!("drive has no Luna marker"))?;
    let item = Item {
        id: id.to_string(),
        owner: owner.to_string(),
        path,
    };
    let conn = crate::drives::drive_db::open(root)?;
    conn.execute(
        "INSERT INTO private_items (id, name, owner_user_id, path) VALUES (?1, ?2, ?3, ?4)",
        params![item.id, item.name(), item.owner, item.path],
    )?;
    s.write()
        .map_err(|_| anyhow::anyhow!("private items lock poisoned"))?
        .by_path
        .insert(item.path.clone(), item.clone());
    Ok(item)
}

/// Remove the row at `path` (after its disk entry is gone).
pub fn remove(root: &Path, path: &str) -> anyhow::Result<()> {
    let path = path.trim_matches('/');
    let Some(s) = shared(root) else { return Ok(()) };
    let conn = crate::drives::drive_db::open(root)?;
    let id = s
        .read()
        .map_err(|_| anyhow::anyhow!("private items lock poisoned"))?
        .by_path
        .get(path)
        .map(|i| i.id.clone());
    if let Some(id) = id {
        conn.execute("DELETE FROM private_items WHERE id = ?1", params![id])?;
        s.write()
            .map_err(|_| anyhow::anyhow!("private items lock poisoned"))?
            .by_path
            .remove(path);
    }
    Ok(())
}

/// Remove every row at or below `path`.
pub fn remove_under(root: &Path, path: &str) -> anyhow::Result<()> {
    for item in under(root, path) {
        remove(root, &item.path)?;
    }
    Ok(())
}

/// Give an ownerless private item (or any, for an Admin) a new owner.
pub fn set_owner(root: &Path, path: &str, owner: &str) -> anyhow::Result<bool> {
    let path = path.trim_matches('/');
    let Some(s) = shared(root) else {
        return Ok(false);
    };
    let mut g = s
        .write()
        .map_err(|_| anyhow::anyhow!("private items lock poisoned"))?;
    let Some(item) = g.by_path.get_mut(path) else {
        return Ok(false);
    };
    let conn = crate::drives::drive_db::open(root)?;
    conn.execute(
        "UPDATE private_items SET owner_user_id = ?1 WHERE id = ?2",
        params![owner, item.id],
    )?;
    item.owner = owner.to_string();
    Ok(true)
}

/// Re-key rows after `from` moved or was renamed to `to` (a folder carries
/// everything inside it). Disk entries keep their ids; only paths change.
pub fn repath(root: &Path, from: &str, to: &str) -> anyhow::Result<()> {
    let (from, to) = (from.trim_matches('/'), to.trim_matches('/'));
    if from == to {
        return Ok(());
    }
    let Some(s) = shared(root) else { return Ok(()) };
    let mut conn = crate::drives::drive_db::open(root)?;
    let mut g = s
        .write()
        .map_err(|_| anyhow::anyhow!("private items lock poisoned"))?;
    let moved: Vec<Item> = g
        .by_path
        .values()
        .filter(|i| within(&i.path, from))
        .cloned()
        .collect();
    if moved.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut next = Vec::with_capacity(moved.len());
    for item in &moved {
        let path = format!("{to}{}", &item.path[from.len()..]);
        let moved_item = Item {
            path,
            ..item.clone()
        };
        tx.execute(
            "UPDATE private_items SET path = ?1, name = ?2 WHERE id = ?3",
            params![moved_item.path, moved_item.name(), moved_item.id],
        )?;
        next.push(moved_item);
    }
    tx.commit()?;
    for item in &moved {
        g.by_path.remove(&item.path);
    }
    for item in next {
        g.by_path.insert(item.path.clone(), item);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(prefix: &str, items: &[(&str, &str)]) -> Rows {
        let mut r = Rows {
            prefix: prefix.into(),
            canon: PathBuf::new(),
            by_path: HashMap::new(),
        };
        for (id, path) in items {
            r.by_path.insert(
                (*path).into(),
                Item {
                    id: (*id).into(),
                    owner: "u".into(),
                    path: (*path).into(),
                },
            );
        }
        r
    }

    fn translate(r: &Rows, rel: &str) -> String {
        disk_in(&r.by_path, &r.prefix, rel)
    }

    #[test]
    fn ids_are_26_base32() {
        let id = new_id();
        assert_eq!(id.len(), 26);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
        );
    }

    #[test]
    fn nested_private_items_each_get_their_own_name() {
        let r = rows(".luna-x", &[("aaa", "Docs"), ("bbb", "Docs/Taxes/2024")]);
        assert_eq!(translate(&r, "Docs"), ".luna-x-aaa");
        assert_eq!(translate(&r, "Docs/a.txt"), ".luna-x-aaa/a.txt");
        assert_eq!(
            translate(&r, "Docs/Taxes/2024/f.pdf"),
            ".luna-x-aaa/Taxes/.luna-x-bbb/f.pdf"
        );
        assert_eq!(translate(&r, "Other/Docs"), "Other/Docs");
    }

    #[test]
    fn within_respects_segment_boundaries() {
        assert!(within("a/b", "a"));
        assert!(within("a", "a"));
        assert!(!within("ab", "a"));
    }

    fn fixture() -> (tempfile::TempDir, crate::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        for id in ["a", "b"] {
            let root = dir.path().join(id);
            std::fs::create_dir(&root).unwrap();
            let prefix = luna_core::marker::pick_prefix(&root).unwrap();
            crate::drives::drive_db::create(
                &root,
                &luna_core::marker::Marker::new(id, id),
                &prefix,
            )
            .unwrap();
            crate::db::upsert_drive(&conn, id, id, "as_is", "ext4", id, root.to_str().unwrap())
                .unwrap();
        }
        for (id, role) in [
            ("alice", "user"),
            ("bob", "user"),
            ("carol", "user"),
            ("admin", "admin"),
        ] {
            crate::db::insert_user(&conn, id, id, id, "unused", role).unwrap();
        }
        let manager = Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = crate::AppState::new(conn, manager, dir.path());
        (dir, state)
    }

    fn actor(id: &str) -> crate::auth::CurrentUser {
        crate::auth::CurrentUser {
            id: id.into(),
            username: id.into(),
            role: if id == "admin" { "admin" } else { "user" }.into(),
        }
    }

    fn grant(conn: &rusqlite::Connection, id: &str, user: &str, path: &str, caps: i64) {
        crate::db::insert_access_member(
            conn,
            &crate::db::AccessMemberRow {
                id: id.into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "a".into(),
                path: path.into(),
                album_id: String::new(),
                user_id: user.into(),
                caps,
                created_by: "alice".into(),
            },
        )
        .unwrap();
    }

    async fn request(
        state: &crate::AppState,
        id: &str,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> (u16, serde_json::Value) {
        use tower::ServiceExt;
        let app = crate::api::router()
            .layer(axum::extract::Extension(actor(id)))
            .with_state(state.clone());
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    #[test]
    fn privacy_changes_reject_symlink_parents_and_reserved_paths() {
        let (dir, state) = fixture();
        let root = dir.path().join("a");
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(outside.join("Victim")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Shortcut")).unwrap();
        assert!(privatize(&root, "Shortcut/Victim", "alice").is_err());
        assert!(outside.join("Victim").is_dir());
        let layout = crate::drives::layout::Layout::detect(&root).unwrap();
        assert!(privatize(&root, &layout.trash_name(), "alice").is_err());
        assert!(privatize(&root, "../outside/Victim", "alice").is_err());
        let conn = state.db.lock().unwrap();
        crate::files::mkdir(&conn, "a", "Parent").unwrap();
        crate::files::mkdir_as(&conn, "a", "Parent/Private", Some("alice")).unwrap();
        std::fs::rename(root.join("Parent"), outside.join("Parent")).unwrap();
        std::os::unix::fs::symlink(outside.join("Parent"), root.join("Parent")).unwrap();
        assert!(unprivatize(&root, "Parent/Private").is_err());
        assert!(item_at(&root, "Parent/Private").is_some());
    }

    #[tokio::test]
    async fn deleted_owner_denies_recipients_and_admin_over_rest_and_dav() {
        use tower::ServiceExt;
        let (dir, state) = fixture();
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir_as(&conn, "a", "Private", Some("alice")).unwrap();
            crate::files::create(&conn, "a", "Private/secret.txt").unwrap();
            crate::files::mkdir_as(&conn, "a", "Private/Bobs", Some("bob")).unwrap();
            grant(
                &conn,
                "recipient",
                "bob",
                "Private",
                crate::access::CAP_MANAGE,
            );
            grant(
                &conn,
                "deep",
                "carol",
                "Private/secret.txt",
                crate::access::CAP_VIEW,
            );
            crate::db::delete_user(&conn, "alice").unwrap();
            assert_eq!(
                crate::auth::caps_on_path(&actor("bob"), &conn, "a", "Private/secret.txt"),
                0
            );
            assert!(crate::auth::can_access(
                &actor("bob"),
                &conn,
                "a",
                "Private/Bobs",
                true
            ));
            assert!(!crate::auth::can_browse_path(
                &actor("carol"),
                &conn,
                "a",
                "Private"
            ));
            assert!(!crate::auth::can_inspect_path(
                &actor("carol"),
                &conn,
                "a",
                "Private/secret.txt"
            ));
        }
        let (status, roots) = request(
            &state,
            "bob",
            "GET",
            "/api/v1/me/access",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert!(!roots.to_string().contains("Private"));
        for id in ["admin", "bob"] {
            let (status, _) = request(
                &state,
                id,
                "GET",
                "/api/v1/drives/a/files/content?path=Private/secret.txt",
                serde_json::json!({}),
            )
            .await;
            assert_ne!(status, 200);
            let token = state
                .auth
                .issue(&state.auth.user(id).unwrap().unwrap())
                .unwrap();
            let app = crate::files::dav::router().with_state(state.clone());
            let res = app
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/dav/a/Private/secret.txt")
                        .header("authorization", format!("Bearer {token}"))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_ne!(res.status(), 200);
        }
        assert!(
            dir.path()
                .join("a")
                .join(disk_rel(&dir.path().join("a"), "Private/secret.txt"))
                .exists()
        );
    }

    #[test]
    fn guest_file_resolution_stops_at_private_boundaries_and_deleted_owners() {
        let (_dir, state) = fixture();
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir_as(&conn, "a", "Private", Some("alice")).unwrap();
            crate::files::create(&conn, "a", "Private/file.txt").unwrap();
        }
        let mut link = crate::db::AccessLinkRow {
            id: "link".into(),
            token_hash: String::new(),
            token: String::new(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "a".into(),
            path: String::new(),
            album_id: String::new(),
            caps: crate::access::CAP_VIEW,
            password_hash: String::new(),
            expires_at: None,
            created_by: "bob".into(),
            created_at: 0,
        };
        assert!(crate::api::access::link_file(&state, &link, "Private/file.txt").is_err());
        link.path = "Private".into();
        assert!(crate::api::access::link_file(&state, &link, "file.txt").is_ok());
        {
            let conn = state.db.lock().unwrap();
            crate::db::delete_user(&conn, "alice").unwrap();
        }
        assert!(crate::api::access::link_file(&state, &link, "file.txt").is_err());
    }

    #[tokio::test]
    async fn cleanup_includes_private_trash_and_preserves_nested_shares() {
        let (dir, state) = fixture();
        let root = dir.path().join("a");
        let trashed;
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir_as(&conn, "a", "Private", Some("alice")).unwrap();
            crate::files::create(&conn, "a", "Private/child.txt").unwrap();
            crate::files::mkdir_as(&conn, "a", "Private/Bobs", Some("bob")).unwrap();
            crate::files::mkdir_as(&conn, "a", "Private/Bobs/AliceAgain", Some("alice")).unwrap();
            crate::files::mkdir_as(&conn, "a", "Private/Bobs/AliceAgain/Carols", Some("carol"))
                .unwrap();
            grant(
                &conn,
                "nested",
                "carol",
                "Private/Bobs",
                crate::access::CAP_VIEW,
            );
            trashed = crate::files::delete_to_trash(&conn, "a", "Private/child.txt").unwrap();
            crate::db::delete_user(&conn, "alice").unwrap();
        }
        let (status, report) = request(
            &state,
            "admin",
            "GET",
            "/api/v1/private/orphans",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(report["owners"][0]["total"], 3);
        let (status, _) = request(
            &state,
            "admin",
            "DELETE",
            "/api/v1/private/orphans/alice",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let conn = state.db.lock().unwrap();
        assert!(crate::files::resolve_any_including_trash(&conn, "a", &trashed).is_err());
        assert!(
            crate::files::trash_private_meta(&conn, "a", &trashed)
                .unwrap()
                .is_none()
        );
        assert_eq!(item_at(&root, "Bobs").unwrap().owner, "bob");
        assert!(item_at(&root, "Bobs/AliceAgain").is_none());
        assert_eq!(item_at(&root, "Bobs/Carols").unwrap().owner, "carol");
        assert!(crate::auth::can_access(
            &actor("carol"),
            &conn,
            "a",
            "Bobs",
            false
        ));
        assert!(orphaned(&conn).owners.is_empty());
    }

    async fn finished_job(state: &crate::AppState, id: &str) -> crate::db::JobRow {
        for _ in 0..500 {
            let job = state.job_manager.get(id).unwrap().unwrap();
            if job.state != "running" {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("job did not finish");
    }

    #[tokio::test]
    async fn cross_drive_move_carries_unreadable_boundaries_without_counting_them() {
        let (dir, state) = fixture();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir(&conn, "a", "Container").unwrap();
            crate::files::mkdir_as(&conn, "a", "Container/Bobs", Some("bob")).unwrap();
            crate::files::create(&conn, "a", "Container/Bobs/secret.txt").unwrap();
            std::fs::write(a.join(disk_rel(&a, "Container/Bobs/secret.txt")), b"secret").unwrap();
            grant(
                &conn,
                "carol",
                "carol",
                "Container/Bobs",
                crate::access::CAP_VIEW,
            );
        }
        let job = state
            .job_manager
            .enqueue("move", "a", "Container", "b", "", "admin")
            .await
            .unwrap();
        assert_eq!(job.total, 0);
        let done = finished_job(&state, &job.id).await;
        assert_eq!(done.state, "done", "{}", done.error);
        assert_eq!(done.progress, 0);
        assert_eq!(item_at(&b, "Container/Bobs").unwrap().owner, "bob");
        assert_eq!(
            std::fs::read(b.join(disk_rel(&b, "Container/Bobs/secret.txt"))).unwrap(),
            b"secret"
        );
        let conn = state.db.lock().unwrap();
        assert!(crate::auth::can_access(
            &actor("carol"),
            &conn,
            "b",
            "Container/Bobs/secret.txt",
            false
        ));
        assert!(!crate::auth::can_access(
            &actor("admin"),
            &conn,
            "b",
            "Container/Bobs/secret.txt",
            false
        ));
    }

    #[tokio::test]
    async fn private_job_paths_stay_hidden_after_the_source_moves() {
        let (_dir, state) = fixture();
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir_as(&conn, "a", "SecretFolder", Some("bob")).unwrap();
            crate::files::mkdir_as(&conn, "a", "SecretFolder/Inner", Some("bob")).unwrap();
            grant(&conn, "bob-root", "bob", "", crate::access::CAP_MANAGE);
        }
        let job = state
            .job_manager
            .enqueue("move", "a", "SecretFolder/Inner", "a", "", "bob")
            .await
            .unwrap();
        assert_eq!(finished_job(&state, &job.id).await.state, "done");
        let (status, body) = request(
            &state,
            "admin",
            "GET",
            &format!("/api/v1/jobs/{}", job.id),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["from_path"], "private");
        let (status, body) = request(
            &state,
            "admin",
            "GET",
            "/api/v1/jobs",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert!(!body.to_string().contains("SecretFolder"));
    }

    #[tokio::test]
    async fn restore_outside_private_origin_requires_confirmation() {
        let (_dir, state) = fixture();
        let trash;
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir_as(&conn, "a", "Private", Some("bob")).unwrap();
            crate::files::create(&conn, "a", "Private/file.txt").unwrap();
            grant(&conn, "bob-root", "bob", "", crate::access::CAP_MANAGE);
            trash = crate::files::delete_to_trash(&conn, "a", "Private/file.txt").unwrap();
        }
        let mut body = serde_json::json!({"path":trash, "dest":"file.txt"});
        let (status, error) = request(
            &state,
            "bob",
            "POST",
            "/api/v1/drives/a/files/restore",
            body.clone(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(error["code"], "broadens_access");
        body["confirm_broaden"] = serde_json::json!(true);
        let (status, _) = request(
            &state,
            "bob",
            "POST",
            "/api/v1/drives/a/files/restore",
            body,
        )
        .await;
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn sharing_and_gallery_use_effective_private_access() {
        let (dir, state) = fixture();
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir(&conn, "a", "Family").unwrap();
            crate::files::mkdir_as(&conn, "a", "Family/Private", Some("admin")).unwrap();
            grant(&conn, "wide", "bob", "Family", crate::access::CAP_MANAGE);
            grant(
                &conn,
                "narrow",
                "bob",
                "Family/Private",
                crate::access::CAP_VIEW,
            );
            crate::files::mkdir_as(&conn, "b", "Photos", Some("carol")).unwrap();
        }
        let (status, body) = request(
            &state,
            "admin",
            "GET",
            "/api/v1/access/subject?kind=path&drive_id=a&path=Family/Private",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["members"][0]["effective_caps"], "view");
        let dconn = crate::gallery::open_drive_db(&dir.path().join("b")).unwrap();
        dconn.execute("INSERT INTO photos (path,name,size,mtime,camera_make,camera_model) VALUES ('Photos/a.jpg','a.jpg',1,1,'TestCamera','Owned')", []).unwrap();
        let (status, body) = request(
            &state,
            "carol",
            "GET",
            "/api/v1/gallery/cameras",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["cameras"][0]["make"], "TestCamera");
    }

    #[tokio::test]
    async fn privacy_transition_roundtrip_keeps_nested_boundaries() {
        let (dir, state) = fixture();
        {
            let conn = state.db.lock().unwrap();
            crate::files::mkdir(&conn, "a", "Folder").unwrap();
            crate::files::mkdir_as(&conn, "a", "Folder/Bobs", Some("bob")).unwrap();
        }
        for private in [true, false] {
            let (status, _) = request(
                &state,
                "admin",
                "POST",
                "/api/v1/drives/a/files/privacy",
                serde_json::json!({"path":"Folder", "private":private}),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(item_at(&dir.path().join("a"), "Folder").is_some(), private);
            assert_eq!(
                item_at(&dir.path().join("a"), "Folder/Bobs").unwrap().owner,
                "bob"
            );
        }
    }
}
