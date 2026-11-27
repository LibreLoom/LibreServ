//! Meaning search: finding a file whose text is *about* what was typed, in
//! other words ("lease" finds a tenancy agreement that never says lease).
//!
//! Each file's text is cut into passages of a few sentences; each passage
//! gets a Model2Vec vector ([`super::m2v`]) stored as 256 bytes in the
//! drive's `content_vecs`. A query is embedded the same way and compared
//! with every passage on the drive; a file counts when its best passage is
//! close enough. It runs in-process (a 7.5 MB table, no neural network), so
//! it is on wherever the model file is installed.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use rusqlite::{Connection, OptionalExtension, params};

use super::m2v::{self, DIM, Model};
use crate::files::search::{KindFilter, SearchHit};

/// Model folder name under `<pack root>/models/`.
pub const MODEL_DIR: &str = "potion-base-8M";
/// Bump when chunking or the model changes, to re-embed every file.
pub const MEANING_VERSION: i64 = 1;
/// Cosine at which a passage counts as being about the query. Measured on
/// household-style passages: right matches scored 0.42–0.59, the closest
/// wrong ones up to 0.32.
pub const MIN_SIMILARITY: f32 = 0.38;
/// Words per passage, and passages kept per file. A long file keeps
/// passages spread over its length rather than only its start.
const PASSAGE_WORDS: usize = 60;
const MAX_PASSAGES: usize = 48;
/// Files returned per drive.
const MAX_FILES: usize = 40;

static MODEL: OnceLock<Option<Arc<Model>>> = OnceLock::new();

fn model_dir() -> PathBuf {
    crate::packs::models_dir().join(MODEL_DIR)
}

/// The loaded model, or `None` when it isn't installed (dev machines
/// without the OS image's model files) or failed to load.
pub fn model() -> Option<Arc<Model>> {
    MODEL
        .get_or_init(|| {
            let dir = model_dir();
            if !dir.join("model.safetensors").exists() {
                return None;
            }
            match Model::load(&dir) {
                Ok(m) => Some(Arc::new(m)),
                Err(e) => {
                    tracing::warn!(error = %e, "meaning search model could not load");
                    None
                }
            }
        })
        .clone()
}

/// Why meaning search is off, or `None` when it's on.
pub fn off_reason() -> Option<&'static str> {
    if !model_dir().join("model.safetensors").exists() {
        return Some("model_missing");
    }
    if model().is_none() {
        return Some("model_failed");
    }
    None
}

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS content_meaning (
            doc_id INTEGER PRIMARY KEY,
            version INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

/// A passage of a file's text: char offset and length in the stored text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passage {
    pub start: usize,
    pub len: usize,
}

/// Cut text into passages of about [`PASSAGE_WORDS`] words, breaking at
/// paragraph or sentence ends when one is near. Offsets are in chars.
pub fn passages(text: &str) -> Vec<Passage> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut words = 0usize;
    let mut in_word = false;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            if in_word {
                words += 1;
            }
            in_word = false;
        } else {
            in_word = true;
        }
        let paragraph = c == '\n' && chars.get(i + 1) == Some(&'\n');
        let sentence =
            matches!(c, '.' | '!' | '?') && chars.get(i + 1).is_none_or(|n| n.is_whitespace());
        let long_enough = words >= PASSAGE_WORDS / 2;
        if (paragraph && words >= 8) || (sentence && long_enough) || words >= PASSAGE_WORDS * 3 / 2
        {
            out.push(Passage {
                start,
                len: i + 1 - start,
            });
            start = i + 1;
            words = 0;
        }
        i += 1;
    }
    if chars[start..].iter().any(|c| !c.is_whitespace()) {
        out.push(Passage {
            start,
            len: chars.len() - start,
        });
    }
    // Trim leading whitespace off each passage.
    for p in &mut out {
        while p.len > 0 && chars[p.start].is_whitespace() {
            p.start += 1;
            p.len -= 1;
        }
    }
    out.retain(|p| p.len > 0);
    if out.len() > MAX_PASSAGES {
        // Spread the kept passages evenly over the file.
        let step = out.len() as f64 / MAX_PASSAGES as f64;
        out = (0..MAX_PASSAGES)
            .map(|k| out[(k as f64 * step) as usize].clone())
            .collect();
    }
    out
}

#[cfg(test)]
fn slice_chars(text: &str, p: &Passage) -> String {
    text.chars().skip(p.start).take(p.len).collect()
}

/// Embed the passages of every file whose text has no current vectors.
/// Returns how many files were done; stops after `budget` files so the
/// caller can keep reading new files in between.
pub fn backfill(conn: &Connection, drive_id: &str, budget: usize) -> anyhow::Result<usize> {
    let Some(model) = model() else {
        return Ok(0);
    };
    let todo: Vec<(i64, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT c.id, f.body FROM content_docs c
             JOIN content_fts f ON f.rowid = c.id
             LEFT JOIN content_meaning m ON m.doc_id = c.id
             WHERE c.drive_id = ?1 AND c.state = 'text'
               AND (m.doc_id IS NULL OR m.version != ?2)
             LIMIT ?3",
        )?;
        stmt.query_map(params![drive_id, MEANING_VERSION, budget as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    for (doc, body) in &todo {
        // Selected passages are ordered and do not overlap. Borrow their
        // UTF-8 slices without copying or rescanning preceding passages.
        let mut remaining = body.chars();
        let mut previous_end = 0;
        let vecs: Vec<(usize, Passage, Vec<u8>)> = passages(body)
            .into_iter()
            .enumerate()
            .filter_map(|(i, p)| {
                for _ in 0..p.start - previous_end {
                    remaining.next();
                }
                let tail = remaining.as_str();
                for _ in 0..p.len {
                    remaining.next();
                }
                previous_end = p.start + p.len;
                let passage = &tail[..tail.len() - remaining.as_str().len()];
                let v = model.embed(passage)?;
                Some((i, p, m2v::to_i8(&v)))
            })
            .collect();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM content_vecs WHERE doc_id = ?1", params![doc])?;
        {
            let mut ins = tx.prepare_cached(
                "INSERT INTO content_vecs (doc_id, chunk, start, len, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (i, p, v) in &vecs {
                ins.execute(params![doc, *i as i64, p.start as i64, p.len as i64, v])?;
            }
        }
        tx.execute(
            "INSERT INTO content_meaning (doc_id, version) VALUES (?1, ?2)
             ON CONFLICT (doc_id) DO UPDATE SET version = excluded.version",
            params![doc, MEANING_VERSION],
        )?;
        tx.commit()?;
    }
    Ok(todo.len())
}

/// Files whose meaning still needs embedding on this drive.
pub fn backfill_left(conn: &Connection, drive_id: &str) -> anyhow::Result<u64> {
    if model().is_none() {
        return Ok(0);
    }
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM content_docs c
         LEFT JOIN content_meaning m ON m.doc_id = c.id
         WHERE c.drive_id = ?1 AND c.state = 'text'
           AND (m.doc_id IS NULL OR m.version != ?2)",
        params![drive_id, MEANING_VERSION],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u64)
}

/// The query's vector, when meaning search is on and the query has a real
/// word in it (two letters say too little to mean anything).
pub fn query_vector(words: &[String]) -> Option<[f32; DIM]> {
    if !words
        .iter()
        .any(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 3)
    {
        return None;
    }
    model()?.embed(&words.join(" "))
}

/// One meaning match: the file, its best passage, and how close it was.
#[derive(Debug, Clone)]
pub struct MeaningHit {
    pub doc: i64,
    pub hit: SearchHit,
    pub passage: (i64, i64),
    pub similarity: f32,
}

/// Files on this drive with a passage about `q`, best first. Reads every
/// stored passage vector of current files once (256 bytes each).
pub fn candidates(
    conn: &Connection,
    drive_id: &str,
    q: &[f32; DIM],
    kind: KindFilter,
) -> rusqlite::Result<Vec<MeaningHit>> {
    if kind == KindFilter::Folders {
        return Ok(Vec::new());
    }
    let mut best: std::collections::HashMap<i64, (f32, i64, i64)> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT v.doc_id, v.start, v.len, v.vec FROM content_vecs v
             JOIN content_docs c ON c.id = v.doc_id
             WHERE c.drive_id = ?1 AND c.state = 'text'",
        )?;
        let mut rows = stmt.query(params![drive_id])?;
        while let Some(row) = rows.next()? {
            let vec = row.get_ref(3)?.as_blob()?;
            let sim = m2v::cosine_i8(q, vec);
            if sim < MIN_SIMILARITY {
                continue;
            }
            let doc: i64 = row.get(0)?;
            let entry = best.entry(doc).or_insert((f32::MIN, 0, 0));
            if sim > entry.0 {
                *entry = (sim, row.get(1)?, row.get(2)?);
            }
        }
    }
    let mut ranked: Vec<(i64, f32, i64, i64)> = best
        .into_iter()
        .map(|(doc, (sim, start, len))| (doc, sim, start, len))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(MAX_FILES * 2);
    let mut out = Vec::new();
    let mut file = conn.prepare_cached(
        "SELECT e.parent, e.name, e.kind, e.size, e.modified
         FROM content_docs c JOIN index_entries e
           ON e.drive_id = c.drive_id AND e.parent = c.parent AND e.name = c.name
          AND e.size = c.size AND e.modified = c.modified
         WHERE c.id = ?1 AND e.hidden = 0",
    )?;
    for (doc, sim, start, len) in ranked {
        let found = file
            .query_row(params![doc], |r| {
                Ok(SearchHit {
                    drive_id: drive_id.to_string(),
                    parent: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    size: r.get(3)?,
                    modified: r.get(4)?,
                })
            })
            .optional()?;
        if let Some(hit) = found {
            out.push(MeaningHit {
                doc,
                hit,
                passage: (start, len),
                similarity: sim,
            });
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    Ok(out)
}

/// The passage a meaning match came from, shortened for the result row.
/// Call only for a file the person may open.
pub fn passage_snippet(conn: &Connection, doc: i64, passage: (i64, i64)) -> Option<String> {
    let text: String = conn
        .query_row(
            "SELECT substr(body, ?2, ?3) FROM content_fts WHERE rowid = ?1",
            params![doc, passage.0 + 1, passage.1],
            |r| r.get(0),
        )
        .ok()?;
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 160;
    if flat.chars().count() <= MAX_CHARS {
        return Some(flat);
    }
    let cut: String = flat.chars().take(MAX_CHARS).collect();
    let at_word = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!("{at_word}…"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passages_break_at_sentences_and_cover_the_text() {
        let sentence = "The tenant pays rent on the first day of every month to the landlord. ";
        let text = sentence.repeat(10);
        let ps = passages(&text);
        assert!(ps.len() >= 2, "{ps:?}");
        for p in &ps {
            let s = slice_chars(&text, p);
            assert!(s.starts_with("The tenant"), "{s}");
            assert!(s.trim_end().ends_with('.'), "{s}");
        }
    }

    #[test]
    fn a_long_file_keeps_passages_spread_over_its_length() {
        let text = (0..2000)
            .map(|i| format!("Line number {i} of the long manual is here."))
            .collect::<Vec<_>>()
            .join(" ");
        let ps = passages(&text);
        assert_eq!(ps.len(), MAX_PASSAGES);
        let last = slice_chars(&text, ps.last().unwrap());
        assert!(
            !last.contains("Line number 0 "),
            "the end of the file is represented"
        );
    }

    #[test]
    fn short_and_empty_texts() {
        assert!(passages("").is_empty());
        assert!(passages("   \n\n ").is_empty());
        let ps = passages("Buy milk.");
        assert_eq!(ps, vec![Passage { start: 0, len: 9 }]);
    }
}
