//! A Model2Vec static embedding model (potion-base-8M), in plain Rust.
//!
//! Model2Vec has no neural network at query time: a text's vector is the
//! mean of its WordPiece tokens' rows in one table, normalized. So it runs
//! in-process, fast, with no ONNX runtime. The table is stored here as int8
//! with one scale per row (7.5 MB instead of 30 MB of float32).
//!
//! Matches `model2vec.StaticModel.encode` for this model: BERT normalizer
//! (clean text, CJK spacing, lowercase with accents stripped), BERT
//! pre-tokenizer (whitespace and punctuation), WordPiece with `##`
//! continuations, no special tokens, `[UNK]` dropped, mean, L2-normalize.

use std::collections::HashMap;
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

/// Vector width of potion-base-8M.
pub const DIM: usize = 256;
/// Tokens per text, as `model2vec` truncates.
const MAX_TOKENS: usize = 512;
const MAX_WORD_CHARS: usize = 100;

pub struct Model {
    vocab: HashMap<String, u32>,
    unk: Option<u32>,
    rows: Vec<i8>,
    scales: Vec<f32>,
}

impl Model {
    /// Load from a model folder holding `tokenizer.json` and
    /// `model.safetensors` (one F32 tensor `embeddings`, [vocab, 256]).
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let tokenizer: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("tokenizer.json"))?)?;
        let vocab_json = tokenizer["model"]["vocab"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("tokenizer.json has no WordPiece vocab"))?;
        let mut vocab = HashMap::with_capacity(vocab_json.len());
        for (token, id) in vocab_json {
            let id = id.as_u64().ok_or_else(|| anyhow::anyhow!("bad token id"))?;
            vocab.insert(token.clone(), id as u32);
        }
        let unk = tokenizer["model"]["unk_token"]
            .as_str()
            .and_then(|t| vocab.get(t).copied());

        let bytes = std::fs::read(dir.join("model.safetensors"))?;
        let header_len = u64::from_le_bytes(
            bytes
                .get(..8)
                .ok_or_else(|| anyhow::anyhow!("short safetensors"))?
                .try_into()?,
        ) as usize;
        let header: serde_json::Value = serde_json::from_slice(
            bytes
                .get(8..8 + header_len)
                .ok_or_else(|| anyhow::anyhow!("short safetensors header"))?,
        )?;
        let tensor = &header["embeddings"];
        anyhow::ensure!(tensor["dtype"] == "F32", "embeddings are not F32");
        let shape: Vec<usize> = tensor["shape"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("no shape"))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as usize))
            .collect();
        anyhow::ensure!(
            shape.len() == 2 && shape[1] == DIM,
            "unexpected embedding shape"
        );
        let rows_n = shape[0];
        let offsets: Vec<usize> = tensor["data_offsets"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("no offsets"))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as usize))
            .collect();
        anyhow::ensure!(offsets.len() == 2, "bad offsets");
        let data = bytes
            .get(8 + header_len + offsets[0]..8 + header_len + offsets[1])
            .ok_or_else(|| anyhow::anyhow!("tensor out of range"))?;
        anyhow::ensure!(data.len() == rows_n * DIM * 4, "tensor size mismatch");

        let mut rows = Vec::with_capacity(rows_n * DIM);
        let mut scales = Vec::with_capacity(rows_n);
        for r in 0..rows_n {
            let row: Vec<f32> = (0..DIM)
                .map(|c| {
                    let at = (r * DIM + c) * 4;
                    f32::from_le_bytes(data[at..at + 4].try_into().unwrap())
                })
                .collect();
            let max = row.iter().fold(0f32, |m, v| m.max(v.abs()));
            let scale = if max > 0.0 { max / 127.0 } else { 1.0 };
            scales.push(scale);
            rows.extend(
                row.iter()
                    .map(|v| (v / scale).round().clamp(-127.0, 127.0) as i8),
            );
        }
        anyhow::ensure!(
            vocab.values().all(|id| (*id as usize) < rows_n),
            "vocab larger than the embedding table"
        );
        Ok(Self {
            vocab,
            unk,
            rows,
            scales,
        })
    }

    /// The text's unit vector, or `None` when no token is known.
    pub fn embed(&self, text: &str) -> Option<[f32; DIM]> {
        let ids = self.token_ids(text);
        if ids.is_empty() {
            return None;
        }
        let mut sum = [0f32; DIM];
        for id in &ids {
            let id = *id as usize;
            let scale = self.scales[id];
            let row = &self.rows[id * DIM..(id + 1) * DIM];
            for (s, v) in sum.iter_mut().zip(row) {
                *s += *v as f32 * scale;
            }
        }
        let n = ids.len() as f32;
        for s in &mut sum {
            *s /= n;
        }
        normalize(&mut sum).then_some(sum)
    }

    /// WordPiece ids, `[UNK]` removed, at most [`MAX_TOKENS`].
    pub fn token_ids(&self, text: &str) -> Vec<u32> {
        let mut ids = Vec::new();
        for word in pre_tokenize(&normalize_text(text)) {
            self.wordpiece(&word, &mut ids);
            if ids.len() >= MAX_TOKENS {
                ids.truncate(MAX_TOKENS);
                break;
            }
        }
        if let Some(unk) = self.unk {
            ids.retain(|id| *id != unk);
        }
        ids
    }

    fn wordpiece(&self, word: &str, out: &mut Vec<u32>) {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() > MAX_WORD_CHARS {
            if let Some(unk) = self.unk {
                out.push(unk);
            }
            return;
        }
        let mut pieces = Vec::new();
        let mut start = 0;
        while start < chars.len() {
            let mut end = chars.len();
            let mut found = None;
            while start < end {
                let mut piece: String = chars[start..end].iter().collect();
                if start > 0 {
                    piece.insert_str(0, "##");
                }
                if let Some(id) = self.vocab.get(&piece) {
                    found = Some(*id);
                    break;
                }
                end -= 1;
            }
            match found {
                Some(id) => {
                    pieces.push(id);
                    start = end;
                }
                None => {
                    // The whole word is unknown.
                    if let Some(unk) = self.unk {
                        out.push(unk);
                    }
                    return;
                }
            }
        }
        out.extend(pieces);
    }
}

/// Scale to unit length. False for a zero vector.
pub fn normalize(v: &mut [f32]) -> bool {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= f32::EPSILON {
        return false;
    }
    for x in v {
        *x /= norm;
    }
    true
}

/// BERT normalizer: drop control characters, whitespace to spaces, space
/// out CJK ideographs, lowercase, and strip accents.
pub fn normalize_text(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch == '\0' || ch == '\u{FFFD}' || (ch.is_control() && !ch.is_whitespace()) {
            continue;
        }
        if ch.is_whitespace() {
            cleaned.push(' ');
        } else if is_cjk(ch) {
            cleaned.push(' ');
            cleaned.push(ch);
            cleaned.push(' ');
        } else {
            cleaned.push(ch);
        }
    }
    cleaned
        .to_lowercase()
        .nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect()
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F
        | 0x2B740..=0x2B81F | 0x2B820..=0x2CEAF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

/// BERT punctuation: ASCII symbols plus Unicode punctuation.
fn is_punct(c: char) -> bool {
    let u = c as u32;
    if (33..=47).contains(&u)
        || (58..=64).contains(&u)
        || (91..=96).contains(&u)
        || (123..=126).contains(&u)
    {
        return true;
    }
    !c.is_ascii() && is_unicode_punct(c)
}

/// General-category P* for the common blocks (General Punctuation, CJK
/// symbols, Latin-1 punctuation). Close enough for search text.
fn is_unicode_punct(c: char) -> bool {
    matches!(c as u32,
        0x00A1 | 0x00A7 | 0x00AB | 0x00B6 | 0x00B7 | 0x00BB | 0x00BF
        | 0x2010..=0x2027 | 0x2030..=0x205E | 0x3001..=0x3003 | 0x3008..=0x3011
        | 0x3014..=0x301F | 0xFF01..=0xFF0F | 0xFF1A..=0xFF20 | 0xFF3B..=0xFF40
        | 0xFF5B..=0xFF65)
}

/// BERT pre-tokenizer: split on whitespace, and make every punctuation
/// character its own word.
pub fn pre_tokenize(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
        } else if is_punct(ch) {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            words.push(ch.to_string());
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Quantize a unit vector to int8 for storage (one byte per dimension).
pub fn to_i8(v: &[f32; DIM]) -> Vec<u8> {
    v.iter()
        .map(|x| (x * 127.0).round().clamp(-127.0, 127.0) as i8 as u8)
        .collect()
}

/// Cosine of a query (unit, float) and a stored int8 vector.
pub fn cosine_i8(q: &[f32; DIM], stored: &[u8]) -> f32 {
    if stored.len() != DIM {
        return -1.0;
    }
    let mut dot = 0f32;
    let mut norm = 0f32;
    for (a, b) in q.iter().zip(stored) {
        let b = *b as i8 as f32;
        dot += a * b;
        norm += b * b;
    }
    if norm <= 0.0 { -1.0 } else { dot / norm.sqrt() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Model {
        let tokens = [
            "[UNK]", "lease", "agree", "##ment", "cafe", "!", "un", "##believ", "##ably",
        ];
        let vocab: HashMap<String, u32> = tokens
            .iter()
            .enumerate()
            .map(|(i, t)| (t.to_string(), i as u32))
            .collect();
        let mut rows = Vec::new();
        let mut scales = Vec::new();
        for i in 0..tokens.len() {
            let mut row = vec![0i8; DIM];
            row[i] = 127;
            rows.extend(row);
            scales.push(1.0 / 127.0);
        }
        Model {
            vocab,
            unk: Some(0),
            rows,
            scales,
        }
    }

    #[test]
    fn normalizer_lowercases_and_strips_accents() {
        assert_eq!(normalize_text("Café Crème\tNAÏVE"), "cafe creme naive");
        assert_eq!(
            pre_tokenize("lease, agreement!"),
            ["lease", ",", "agreement", "!"]
        );
        assert_eq!(pre_tokenize("中文"), ["中文"]);
        assert_eq!(pre_tokenize(&normalize_text("中文")), ["中", "文"]);
    }

    #[test]
    fn wordpiece_splits_greedily_and_drops_unknown_words() {
        let m = tiny();
        assert_eq!(m.token_ids("Lease agreement!"), [1, 2, 3, 5]);
        assert_eq!(m.token_ids("unbelievably"), [6, 7, 8]);
        // "zebra" can't be built from the vocab: the whole word is [UNK],
        // and [UNK] is left out of the mean.
        assert_eq!(m.token_ids("zebra café"), [4]);
        assert!(m.embed("zebra").is_none());
    }

    #[test]
    fn embedding_is_the_normalized_mean() {
        let m = tiny();
        let v = m.embed("lease agree").unwrap();
        let half = 1.0 / 2f32.sqrt();
        assert!((v[1] - half).abs() < 1e-4 && (v[2] - half).abs() < 1e-4);
        let stored = to_i8(&v);
        assert!((cosine_i8(&v, &stored) - 1.0).abs() < 1e-3);
    }

    /// Parity with `model2vec` on the real model, when it is installed
    /// (`LUNA_PACK_ROOT/models/potion-base-8M`). Reference values were
    /// computed with model2vec 0.x on revision bf8b056.
    #[test]
    fn matches_model2vec_on_the_real_model() {
        let dir = crate::packs::root()
            .join("models")
            .join(super::super::meaning::MODEL_DIR);
        if !dir.join("model.safetensors").exists() {
            return;
        }
        let m = Model::load(&dir).unwrap();
        let cases: [(&str, [f32; 6]); 3] = [
            (
                "Lease agreement",
                [0.021465, 0.238377, -0.06475, -0.160599, -0.01668, -0.040811],
            ),
            (
                "Café crème, naïve résumé!",
                [
                    -0.021104, 0.031915, -0.218805, -0.037683, -0.08273, 0.072407,
                ],
            ),
            (
                "unbelievably supercalifragilistic",
                [
                    -0.065869, -0.23926, -0.215369, -0.142963, 0.172937, 0.167533,
                ],
            ),
        ];
        for (text, want) in cases {
            let got = m.embed(text).unwrap();
            for (g, w) in got.iter().zip(want) {
                // int8 storage costs a little precision.
                assert!((g - w).abs() < 0.01, "{text}: {g} vs {w}");
            }
        }
    }
}
