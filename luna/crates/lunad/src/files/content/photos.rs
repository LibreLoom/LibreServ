//! Photo search: finding photos (and videos, by their thumbnail) by what
//! they show.
//!
//! Each gallery thumbnail gets a TinyCLIP image vector, stored as 512 bytes
//! in the drive's `photo_vecs`, keyed by the photo's path and checked
//! against the gallery's size and time. A search embeds its words with the
//! text encoder and keeps photos that are both close enough on their own
//! and close to the best match on that drive.
//!
//! The same vectors say whether a camera photo shows a document (receipt,
//! letter, screenshot), which decides whether OCR reads it.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, params};

use super::clip::{self, DIM, Unavailable};
use crate::files::search::{KindFilter, SearchHit};

/// Bump with the model, its preprocessing, or the thumbnail recipe.
pub const PHOTO_VERSION: i64 = 1 + 1000 * crate::gallery::THUMB_RECIPE as i64;
/// A photo counts when its cosine with the query reaches this...
pub const MIN_SIMILARITY: f32 = 0.36;
/// ...and is within this much of the drive's best match. Measured on the
/// 1,000-photo / 5,000-caption Flickr8k set (float32 images, int8 text):
/// the captioned photo is kept for 91% of captions, with about 23 photos
/// per 1,000 returned.
pub const NEAR_BEST: f32 = 0.07;
/// Most photos one drive returns.
const MAX_PHOTOS: usize = 120;
/// "Shows a document" margin: best document prompt minus best ordinary
/// prompt. On Flickr8k (no documents) 99% of photos scored at most 0.02;
/// synthetic receipts, pages and screenshots scored 0.063–0.082.
const DOC_MARGIN: f32 = 0.03;

type Vector = [f32; DIM];
/// (document prompts, plain-photo prompts).
type Prompts = (Vec<Vector>, Vec<Vector>);
/// Query text → (when embedded, vector).
type QueryCache = Mutex<HashMap<String, (Instant, Vector)>>;

const DOC_PROMPTS: &[&str] = &[
    "a photo of a receipt",
    "a scanned document",
    "a screenshot of a phone",
    "a page of printed text",
    "a letter on paper",
    "a form with text",
    "a whiteboard with handwriting",
];
const PLAIN_PROMPTS: &[&str] = &[
    "a photo of people",
    "a photo of a landscape",
    "a photo of an animal",
    "a photo of food",
    "a photo of a building",
    "a photo of a street",
    "a photo of a child playing",
];

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_vecs (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            version INTEGER NOT NULL,
            -- NULL when the thumbnail could not be read.
            vec BLOB,
            -- How much more it looks like a document than a plain photo.
            doc REAL
         );",
    )?;
    Ok(())
}

/// Is photo search on? (Installed, enough memory, worker not failing.)
pub fn enabled() -> bool {
    clip::off_reason().is_none()
}

/// Whether photo search judged this photo to show a document (receipt,
/// letter, screenshot). `None` until it has looked.
pub fn shows_document(conn: &Connection, rel: &str) -> Option<bool> {
    let doc: Option<Option<f64>> = conn
        .query_row(
            "SELECT doc FROM photo_vecs WHERE path = ?1 AND version = ?2",
            params![rel, PHOTO_VERSION],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    match doc {
        Some(Some(score)) => Some(score as f32 > DOC_MARGIN),
        // Looked, but the thumbnail couldn't be read: don't wait forever.
        Some(None) => Some(false),
        None => None,
    }
}

/// Photos that waited for photo search get another look once it has
/// looked at them.
pub fn requeue_ocr_deferred(conn: &Connection, drive_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE content_docs SET version = 0
         WHERE drive_id = ?1 AND state = 'deferred' AND detail = 'photo search'
           AND EXISTS (SELECT 1 FROM photo_vecs v
                       WHERE v.version = ?2
                         AND v.path = CASE WHEN content_docs.parent = '' THEN content_docs.name
                                      ELSE content_docs.parent || '/' || content_docs.name END)",
        params![drive_id, PHOTO_VERSION],
    )?;
    Ok(())
}

/// Photos with a thumbnail whose vector is missing or out of date.
fn pending(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<(String, i64, i64)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT p.path, p.size, p.mtime FROM photos p
         LEFT JOIN photo_vecs v ON v.path = p.path
         WHERE p.has_thumb = 1
           AND (v.path IS NULL OR v.size != p.size OR v.mtime != p.mtime OR v.version != ?1)
         ORDER BY p.taken_at DESC
         LIMIT ?2",
    )?;
    stmt.query_map(params![PHOTO_VERSION, limit as i64], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })?
    .collect()
}

pub fn pending_count(conn: &Connection) -> u64 {
    if !enabled() {
        return 0;
    }
    conn.query_row(
        "SELECT COUNT(*) FROM photos p
         LEFT JOIN photo_vecs v ON v.path = p.path
         WHERE p.has_thumb = 1
           AND (v.path IS NULL OR v.size != p.size OR v.mtime != p.mtime OR v.version != ?1)",
        params![PHOTO_VERSION],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u64)
    .unwrap_or(0)
}

/// The document and plain-photo prompt vectors, embedded once.
fn prompts() -> Result<&'static Prompts, Unavailable> {
    static PROMPTS: OnceLock<Prompts> = OnceLock::new();
    if let Some(p) = PROMPTS.get() {
        return Ok(p);
    }
    let embed = |list: &[&str]| -> Result<Vec<[f32; DIM]>, Unavailable> {
        list.iter()
            .filter_map(|t| clip::embed_text(t).transpose())
            .collect()
    };
    let p = (embed(DOC_PROMPTS)?, embed(PLAIN_PROMPTS)?);
    Ok(PROMPTS.get_or_init(|| p))
}

fn dot(a: &[f32; DIM], b: &[f32; DIM]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn doc_score(v: &[f32; DIM]) -> Result<f32, Unavailable> {
    let (docs, plain) = prompts()?;
    let best = |list: &[[f32; DIM]]| list.iter().map(|p| dot(v, p)).fold(f32::MIN, f32::max);
    Ok(best(docs) - best(plain))
}

/// Give up to `budget` photos their vectors. Returns how many were done;
/// zero when photo search is off or there is nothing left.
pub fn backfill(
    conn: &Connection,
    drive_id: &str,
    root: &Path,
    budget: usize,
    still_mounted: &dyn Fn() -> bool,
) -> anyhow::Result<usize> {
    if !enabled() {
        return Ok(0);
    }
    let todo = pending(conn, budget)?;
    let mut done = 0;
    for (path, size, mtime) in todo {
        if !still_mounted() {
            break;
        }
        let Some(thumb) = crate::gallery::thumb_path(root, drive_id, &path) else {
            break;
        };
        let (vec, doc) = match clip::embed_image(&thumb) {
            Ok(Some(v)) => {
                let doc = match doc_score(&v) {
                    Ok(d) => Some(d as f64),
                    Err(_) => return Ok(done),
                };
                (Some(clip::to_i8(&v)), doc)
            }
            Ok(None) => (None, None),
            // The worker is unavailable: stop, and try again next pass.
            Err(_) => return Ok(done),
        };
        conn.execute(
            "INSERT INTO photo_vecs (path, size, mtime, version, vec, doc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
               version = excluded.version, vec = excluded.vec, doc = excluded.doc",
            params![path, size, mtime, PHOTO_VERSION, vec, doc],
        )?;
        done += 1;
    }
    Ok(done)
}

/// Drop vectors of photos the gallery no longer has.
pub fn sweep(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM photo_vecs WHERE path NOT IN (SELECT path FROM photos)",
        [],
    )?;
    Ok(())
}

/// The query's text vector, cached briefly so typing and paging the gallery
/// don't re-run the encoder for the same words.
pub fn query_vector(text: &str) -> Option<[f32; DIM]> {
    let text = text.trim().to_lowercase();
    if text.chars().filter(|c| c.is_alphabetic()).count() < 3 || !enabled() {
        return None;
    }
    static CACHE: OnceLock<QueryCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, v)) = cache.lock().unwrap().get(&text)
        && at.elapsed() < Duration::from_secs(600)
    {
        return Some(*v);
    }
    let v = clip::embed_text(&text).ok().flatten()?;
    let mut c = cache.lock().unwrap();
    if c.len() > 64 {
        c.clear();
    }
    c.insert(text, (Instant::now(), v));
    Some(v)
}

/// Photos on this drive that show `q`: (path, similarity), best first.
/// Only photos whose vector matches the gallery's current file count.
pub fn matching_paths(conn: &Connection, q: &[f32; DIM]) -> rusqlite::Result<Vec<(String, f32)>> {
    let mut found: Vec<(String, f32)> = Vec::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT v.path, v.vec FROM photo_vecs v JOIN photos p ON p.path = v.path
             WHERE v.version = ?1 AND v.vec IS NOT NULL
               AND v.size = p.size AND v.mtime = p.mtime",
        )?;
        let mut rows = stmt.query(params![PHOTO_VERSION])?;
        while let Some(row) = rows.next()? {
            let sim = clip::cosine_i8(q, row.get_ref(1)?.as_blob()?);
            if sim >= MIN_SIMILARITY {
                found.push((row.get(0)?, sim));
            }
        }
    }
    let best = found.iter().map(|(_, s)| *s).fold(f32::MIN, f32::max);
    found.retain(|(_, s)| *s >= best - NEAR_BEST);
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found.truncate(MAX_PHOTOS);
    Ok(found)
}

/// Photo matches as file-search hits: still in the file index, not hidden.
pub fn candidates(
    conn: &Connection,
    drive_id: &str,
    q: &[f32; DIM],
    kind: KindFilter,
) -> rusqlite::Result<Vec<(SearchHit, f32)>> {
    if kind == KindFilter::Folders {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut entry = conn.prepare_cached(
        "SELECT kind, size, modified FROM index_entries
         WHERE drive_id = ?1 AND parent = ?2 AND name = ?3 AND hidden = 0",
    )?;
    for (path, sim) in matching_paths(conn, q)? {
        let (parent, name) = match path.rsplit_once('/') {
            Some((p, n)) => (p.to_string(), n.to_string()),
            None => (String::new(), path.clone()),
        };
        let row = entry
            .query_row(params![drive_id, parent, name], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .optional()?;
        if let Some((kind, size, modified)) = row {
            out.push((
                SearchHit {
                    drive_id: drive_id.to_string(),
                    parent,
                    name,
                    kind,
                    size,
                    modified,
                },
                sim,
            ));
        }
    }
    Ok(out)
}

/// For the gallery: photos on this drive that show `q`, or whose words
/// (OCR) contain it. The gallery keeps its own filters and order; this only
/// widens which photos its free-text words match.
pub fn gallery_matches(conn: &Connection, drive_id: &str, q: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Some(v) = query_vector(q)
        && let Ok(found) = matching_paths(conn, &v)
    {
        out.extend(found.into_iter().map(|(p, _)| p));
    }
    // Text read from the photo (receipts, signs, screenshots).
    let query = crate::files::search_rank::Query::new(q);
    if let Some(expr) = super::query::fts_expr(&query)
        && let Ok(hits) = super::query::candidates(conn, drive_id, &expr, KindFilter::Files, 500)
    {
        out.extend(hits.into_iter().map(|h| {
            if h.hit.parent.is_empty() {
                h.hit.name
            } else {
                format!("{}/{}", h.hit.parent, h.hit.name)
            }
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(seed: usize) -> [f32; DIM] {
        let mut v = [0f32; DIM];
        v[seed] = 1.0;
        v
    }

    #[test]
    fn keeps_close_photos_near_the_best_and_ignores_stale_ones() {
        let dir = tempfile::tempdir().unwrap();
        let conn = super::super::store::tests::drive_conn(dir.path());
        let mut q = [0f32; DIM];
        q[0] = 1.0;
        let photos = [
            ("beach.jpg", 0.9f32, 1),
            ("dunes.jpg", 0.86, 1),
            ("far.jpg", 0.7, 1),
            ("stale.jpg", 0.95, 2),
        ];
        for (name, sim, gallery_mtime) in photos {
            conn.execute(
                "INSERT INTO photos (path, name, size, mtime, has_thumb) VALUES (?1, ?1, 5, ?2, 1)",
                params![name, gallery_mtime],
            )
            .unwrap();
            let mut v = unit(1);
            v[0] = sim;
            v[1] = (1.0 - sim * sim).sqrt();
            conn.execute(
                "INSERT INTO photo_vecs (path, size, mtime, version, vec, doc) VALUES (?1, 5, 1, ?2, ?3, 0)",
                params![name, PHOTO_VERSION, clip::to_i8(&v)],
            )
            .unwrap();
        }
        let got: Vec<String> = matching_paths(&conn, &q)
            .unwrap()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        // stale.jpg changed since its vector was made; far.jpg is too far
        // from the best match.
        assert_eq!(got, ["beach.jpg", "dunes.jpg"]);
    }

    #[test]
    fn document_judgement_needs_a_current_vector() {
        let dir = tempfile::tempdir().unwrap();
        let conn = super::super::store::tests::drive_conn(dir.path());
        assert_eq!(shows_document(&conn, "r.jpg"), None);
        conn.execute(
            "INSERT INTO photo_vecs (path, size, mtime, version, vec, doc) VALUES ('r.jpg', 1, 1, ?1, NULL, 0.08)",
            params![PHOTO_VERSION],
        )
        .unwrap();
        assert_eq!(shows_document(&conn, "r.jpg"), Some(true));
        conn.execute("UPDATE photo_vecs SET doc = 0.0", []).unwrap();
        assert_eq!(shows_document(&conn, "r.jpg"), Some(false));
    }
}
