//! CLIP's byte-level BPE tokenizer, as TinyCLIP's tokenizer.json defines
//! it. Self-contained (std, serde_json, unicode-normalization) so it can be
//! checked against Hugging Face `tokenizers` outside lunad.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use unicode_normalization::UnicodeNormalization;

/// Tokens per text, including start and end.
pub const MAX_TOKENS: usize = 77;
pub const START: u32 = 49406;
pub const END: u32 = 49407;

/// CLIP's byte-level BPE, as the export's tokenizer.json defines it: NFC,
/// whitespace runs to one space, lowercase; split into contractions, letter
/// runs, single digits, and other-symbol runs; GPT-2 byte mapping; BPE with
/// `</w>` on each word's last symbol; start and end tokens; 77 at most.
pub struct Tokenizer {
    vocab: HashMap<String, u32>,
    ranks: HashMap<(String, String), u32>,
    bytes: [char; 256],
    cache: Mutex<HashMap<String, Vec<u32>>>,
}

impl Tokenizer {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
        let model = &json["model"];
        let vocab: HashMap<String, u32> = model["vocab"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("tokenizer.json has no vocab"))?
            .iter()
            .filter_map(|(k, v)| v.as_u64().map(|id| (k.clone(), id as u32)))
            .collect();
        let mut ranks = HashMap::new();
        for (i, merge) in model["merges"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("tokenizer.json has no merges"))?
            .iter()
            .enumerate()
        {
            // Either ["a", "b"] or "a b", depending on the tokenizers version.
            let pair = match merge {
                serde_json::Value::Array(a) if a.len() == 2 => (
                    a[0].as_str().unwrap_or("").to_string(),
                    a[1].as_str().unwrap_or("").to_string(),
                ),
                serde_json::Value::String(s) => match s.split_once(' ') {
                    Some((a, b)) => (a.to_string(), b.to_string()),
                    None => continue,
                },
                _ => continue,
            };
            ranks.insert(pair, i as u32);
        }
        anyhow::ensure!(
            vocab.get("<|startoftext|>") == Some(&START),
            "unexpected start token"
        );
        anyhow::ensure!(
            vocab.get("<|endoftext|>") == Some(&END),
            "unexpected end token"
        );
        Ok(Self {
            vocab,
            ranks,
            bytes: bytes_to_unicode(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// Token ids with start and end, at most [`MAX_TOKENS`].
    pub fn encode(&self, text: &str) -> Vec<u32> {
        let mut ids = vec![START];
        for word in pre_tokenize(&normalize(text)) {
            ids.extend(self.word_ids(&word));
            if ids.len() >= MAX_TOKENS - 1 {
                ids.truncate(MAX_TOKENS - 1);
                break;
            }
        }
        ids.push(END);
        ids
    }

    fn word_ids(&self, word: &str) -> Vec<u32> {
        if let Some(hit) = self.cache.lock().unwrap().get(word) {
            return hit.clone();
        }
        let mapped: Vec<String> = word
            .bytes()
            .map(|b| self.bytes[b as usize].to_string())
            .collect();
        let mut symbols = mapped;
        if let Some(last) = symbols.last_mut() {
            last.push_str("</w>");
        }
        while symbols.len() > 1 {
            let best = symbols
                .windows(2)
                .enumerate()
                .filter_map(|(i, w)| {
                    self.ranks
                        .get(&(w[0].clone(), w[1].clone()))
                        .map(|r| (*r, i))
                })
                .min();
            let Some((_, at)) = best else { break };
            // Merge every occurrence of the best pair, left to right.
            let (a, b) = (symbols[at].clone(), symbols[at + 1].clone());
            let mut merged = Vec::with_capacity(symbols.len());
            let mut i = 0;
            while i < symbols.len() {
                if i + 1 < symbols.len() && symbols[i] == a && symbols[i + 1] == b {
                    merged.push(format!("{a}{b}"));
                    i += 2;
                } else {
                    merged.push(symbols[i].clone());
                    i += 1;
                }
            }
            symbols = merged;
        }
        let ids: Vec<u32> = symbols
            .iter()
            .map(|s| self.vocab.get(s).copied().unwrap_or(END))
            .collect();
        let mut cache = self.cache.lock().unwrap();
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(word.to_string(), ids.clone());
        ids
    }
}

fn normalize(text: &str) -> String {
    let nfc: String = text.nfc().collect();
    let mut out = String::with_capacity(nfc.len());
    let mut space = false;
    for ch in nfc.chars() {
        if ch.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(ch);
            space = false;
        }
    }
    out.to_lowercase()
}

/// `'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+`, keeping
/// the matches and dropping whitespace.
pub fn pre_tokenize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '\'' {
            let rest: String = chars[i + 1..chars.len().min(i + 3)].iter().collect();
            let found = ["re", "ve", "ll", "s", "t", "m", "d"]
                .iter()
                .find(|c| rest.starts_with(*c));
            if let Some(c) = found {
                out.push(format!("'{c}"));
                i += 1 + c.len();
                continue;
            }
        }
        if c.is_alphabetic() {
            let start = i;
            while i < chars.len() && chars[i].is_alphabetic() {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
            continue;
        }
        if c.is_numeric() {
            out.push(c.to_string());
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && !chars[i].is_whitespace()
            && !chars[i].is_alphabetic()
            && !chars[i].is_numeric()
        {
            i += 1;
        }
        if i == start {
            i += 1;
        }
        out.push(chars[start..i].iter().collect());
    }
    out
}

/// GPT-2's reversible byte-to-character table.
fn bytes_to_unicode() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut n = 0u32;
    for b in 0..256u32 {
        let printable = (b'!' as u32..=b'~' as u32).contains(&b)
            || (0xA1..=0xAC).contains(&b)
            || (0xAE..=0xFF).contains(&b);
        table[b as usize] = if printable {
            char::from_u32(b).unwrap()
        } else {
            let c = char::from_u32(256 + n).unwrap();
            n += 1;
            c
        };
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_tokenizer_follows_the_clip_pattern() {
        assert_eq!(pre_tokenize("a dog's toy"), ["a", "dog", "'s", "toy"]);
        assert_eq!(
            pre_tokenize("2024 trip!!"),
            ["2", "0", "2", "4", "trip", "!!"]
        );
        assert_eq!(pre_tokenize("rock'n'roll"), ["rock", "'", "n", "'", "roll"]);
        assert_eq!(normalize("  Dog\t ON  Beach "), " dog on beach ");
    }

    #[test]
    fn byte_table_is_a_permutation_of_256_chars() {
        let t = bytes_to_unicode();
        let set: std::collections::HashSet<char> = t.iter().copied().collect();
        assert_eq!(set.len(), 256);
        assert_eq!(t[b'a' as usize], 'a');
        assert_eq!(t[b' ' as usize], 'Ġ');
    }

    /// Parity with the export's tokenizer.json via HF tokenizers, when the
    /// model is installed (`LUNA_PACK_ROOT/models/tinyclip`).
    #[test]
    fn tokens_match_hugging_face_on_the_real_vocab() {
        let path = super::super::clip::model_dir().join("tokenizer.json");
        if !path.is_file() {
            return;
        }
        let t = Tokenizer::load(&path).unwrap();
        for (text, want) in REFERENCE_TOKENS {
            assert_eq!(t.encode(text), want.to_vec(), "{text}");
        }
    }

    /// Computed with `tokenizers` from tokenizer.json (sha256 6d9109cc…).
    const REFERENCE_TOKENS: &[(&str, &[u32])] = &[
        (
            "a dog on the beach",
            &[49406, 320, 1929, 525, 518, 2117, 49407],
        ),
        (
            "Two kids' bikes, 2024!",
            &[
                49406, 1237, 1911, 262, 9227, 267, 273, 271, 273, 275, 256, 49407,
            ],
        ),
        (
            "Grüße aus München",
            &[49406, 709, 6522, 127, 253, 324, 7630, 41235, 8983, 49407],
        ),
        (
            "rock'n'roll at 3pm",
            &[49406, 2172, 262, 333, 262, 3341, 536, 274, 990, 49407],
        ),
        ("receipt", &[49406, 30479, 49407]),
        ("  UPPER   case\ttabs ", &[49406, 7067, 2068, 29163, 49407]),
        ("emoji 🙂 café", &[49406, 16327, 14860, 15304, 49407]),
    ];

    #[test]
    fn long_texts_are_cut_to_77_tokens() {
        let path = super::super::clip::model_dir().join("tokenizer.json");
        if !path.is_file() {
            return;
        }
        let t = Tokenizer::load(&path).unwrap();
        let ids = t.encode(&"word ".repeat(200));
        assert_eq!(ids.len(), MAX_TOKENS);
        assert_eq!(ids[0], START);
        assert_eq!(*ids.last().unwrap(), END);
    }
}
