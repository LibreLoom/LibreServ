//! Ranking for file search.
//!
//! The index hands back candidates (anything sharing letters with the query);
//! this module decides which really match and in what order. Names are
//! compared after folding case, accents, and separators (`IMG_19`, `img-19`
//! and `IMG 19` are the same words), and a name that is only a typo away
//! still matches, ranked below every real match.

/// How a name matched, best first. Folders sort ahead of files within a tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    /// The whole name is the query.
    Exact,
    /// The name starts with the query.
    Prefix,
    /// A word in the name starts with the query.
    WordPrefix,
    /// The query appears inside the name.
    Substring,
    /// Every query word appears in the name, in any order.
    AllWords,
    /// Every query word is within a typo or two of a word in the name.
    Close,
}

#[derive(Debug, Clone)]
pub struct Query {
    /// Folded query: lowercase, accents removed, words joined by one space.
    pub norm: String,
    pub words: Vec<String>,
}

impl Query {
    pub fn new(raw: &str) -> Self {
        let norm = normalize(raw);
        let words = norm
            .split(' ')
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect();
        Self { norm, words }
    }

    pub fn is_empty(&self) -> bool {
        self.norm.is_empty()
    }
}

/// Rank key — lower sorts first.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Rank {
    pub tier: Tier,
    /// Typos spent (only non-zero for [`Tier::Close`]).
    pub typos: u32,
    /// 0 for folders, 1 for files.
    pub file: u8,
    /// Shorter names are closer to what was typed.
    pub len: usize,
}

/// Lowercase, strip common accents, and turn every run of non-letters into
/// one space.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = true;
    for ch in s.chars() {
        let folded = fold(ch);
        if folded.is_alphanumeric() {
            for lower in folded.to_lowercase() {
                out.push(lower);
            }
            gap = false;
        } else if !gap {
            out.push(' ');
            gap = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn fold(ch: char) -> char {
    match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => 'A',
        'ç' | 'ć' | 'č' => 'c',
        'Ç' | 'Ć' | 'Č' => 'C',
        'ď' => 'd',
        'Ď' => 'D',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ę' | 'Ě' => 'E',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' => 'I',
        'ł' => 'l',
        'Ł' => 'L',
        'ñ' | 'ń' | 'ň' => 'n',
        'Ñ' | 'Ń' | 'Ň' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => 'O',
        'ř' => 'r',
        'Ř' => 'R',
        'ś' | 'š' | 'ş' => 's',
        'Ś' | 'Š' | 'Ş' => 'S',
        'ť' => 't',
        'Ť' => 'T',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' => 'U',
        'ý' | 'ÿ' => 'y',
        'Ý' | 'Ÿ' => 'Y',
        'ź' | 'ż' | 'ž' => 'z',
        'Ź' | 'Ż' | 'Ž' => 'Z',
        other => other,
    }
}

/// Typos allowed for a query word of this many letters.
pub fn typo_budget(len: usize) -> u32 {
    match len {
        0..=3 => 0,
        4..=7 => 1,
        _ => 2,
    }
}

/// Rank one entry for `query`, or `None` when it doesn't match at all.
pub fn rank(query: &Query, name: &str, is_dir: bool) -> Option<Rank> {
    if query.is_empty() {
        return None;
    }
    let name_n = normalize(name);
    let file = if is_dir { 0 } else { 1 };
    let make = |tier, typos| Rank {
        tier,
        typos,
        file,
        len: name_n.len(),
    };

    if name_n == query.norm {
        return Some(make(Tier::Exact, 0));
    }
    if name_n.starts_with(&query.norm) {
        return Some(make(Tier::Prefix, 0));
    }
    if name_n.contains(&format!(" {}", query.norm)) {
        return Some(make(Tier::WordPrefix, 0));
    }
    if name_n.contains(&query.norm) {
        return Some(make(Tier::Substring, 0));
    }
    if query.words.iter().all(|w| name_n.contains(w.as_str())) {
        return Some(make(Tier::AllWords, 0));
    }
    close_match(query, &name_n).map(|typos| make(Tier::Close, typos))
}

/// Total typos if every query word is near some word of the name.
fn close_match(query: &Query, name_n: &str) -> Option<u32> {
    let name_words: Vec<Vec<char>> = name_n.split(' ').map(|w| w.chars().collect()).collect();
    let mut total = 0;
    for word in &query.words {
        let q: Vec<char> = word.chars().collect();
        let budget = typo_budget(q.len());
        let best = name_words
            .iter()
            .filter_map(|w| word_distance(&q, w, budget))
            .min()?;
        total += best;
    }
    Some(total)
}

/// Distance from `q` to a word, or to the start of a longer word (so
/// "passp" still finds "passport"), within `budget` typos.
fn word_distance(q: &[char], w: &[char], budget: u32) -> Option<u32> {
    let mut best = osa(q, w, budget);
    if w.len() > q.len() {
        let cut = &w[..q.len()];
        if let Some(d) = osa(q, cut, budget) {
            best = Some(best.map_or(d, |b| b.min(d)));
        }
    }
    best
}

/// Optimal-string-alignment distance (a swapped pair counts as one typo),
/// or `None` once it exceeds `max`.
pub fn osa(a: &[char], b: &[char], max: u32) -> Option<u32> {
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) as u32 > max {
        return None;
    }
    let mut prev2 = vec![0u32; m + 1];
    let mut prev: Vec<u32> = (0..=m as u32).collect();
    let mut cur = vec![0u32; m + 1];
    for i in 1..=n {
        cur[0] = i as u32;
        let mut row_min = cur[0];
        for j in 1..=m {
            let cost = u32::from(a[i - 1] != b[j - 1]);
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            row_min = row_min.min(v);
        }
        if row_min > max {
            return None;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    let d = prev[m];
    (d <= max).then_some(d)
}

/// FTS5 MATCH string for the letters-in-common lookup, plus whether any
/// word was long enough (3+ letters) to use the index at all.
///
/// `exact`: every word must appear (AND). Otherwise any 3-letter piece of any
/// word may match (OR), which is how a typo still finds its target.
pub fn fts_match(query: &Query, exact: bool) -> Option<String> {
    const MAX_PIECES: usize = 48;
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    if exact {
        let words: Vec<String> = query
            .words
            .iter()
            .filter(|w| w.chars().count() >= 3)
            .map(|w| quote(w))
            .collect();
        return (!words.is_empty()).then(|| words.join(" AND "));
    }
    let mut pieces: Vec<String> = Vec::new();
    for word in &query.words {
        let chars: Vec<char> = word.chars().collect();
        for win in chars.windows(3) {
            let piece: String = win.iter().collect();
            if !pieces.contains(&piece) {
                pieces.push(piece);
            }
        }
    }
    pieces.truncate(MAX_PIECES);
    (!pieces.is_empty()).then(|| {
        pieces
            .iter()
            .map(|p| quote(p))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(query: &str, name: &str, dir: bool) -> Option<Rank> {
        rank(&Query::new(query), name, dir)
    }

    #[test]
    fn normalizes_case_accents_and_separators() {
        assert_eq!(normalize("IMG_0019.JPG"), "img 0019 jpg");
        assert_eq!(normalize("  Café--Menü "), "cafe menu");
        assert_eq!(normalize("___"), "");
    }

    #[test]
    fn tiers_run_from_exact_to_close() {
        let tier = |q, n| r(q, n, false).unwrap().tier;
        assert_eq!(tier("report", "Report"), Tier::Exact);
        assert_eq!(tier("report", "report final.pdf"), Tier::Prefix);
        assert_eq!(tier("final", "report final.pdf"), Tier::WordPrefix);
        assert_eq!(tier("inal", "report final.pdf"), Tier::Substring);
        assert_eq!(tier("final report", "report final.pdf"), Tier::AllWords);
        assert_eq!(tier("pasport", "passport.pdf"), Tier::Close);
        assert!(r("zebra", "report.pdf", false).is_none());
    }

    #[test]
    fn folder_names_never_match_the_files_inside_them() {
        // Only the name is searched; there is no folder path to match.
        assert!(r("taxes", "return 2024.pdf", false).is_none());
        assert!(r("taxes 2024", "scan.pdf", false).is_none());
    }

    #[test]
    fn separators_are_interchangeable() {
        assert!(r("img 19", "IMG_19.jpg", false).is_some());
        assert!(r("img-19", "img 19.jpg", false).is_some());
    }

    #[test]
    fn typos_cover_swaps_missing_and_extra_letters() {
        assert!(r("pasport", "passport.pdf", false).is_some());
        assert!(r("pasaport", "passport.pdf", false).is_some());
        assert!(r("passpotr", "passport.pdf", false).is_some());
        assert!(r("recieve", "receive.txt", false).is_some());
        // A partly typed word with a typo still lands.
        assert!(r("passpr", "passport.pdf", false).is_some());
    }

    #[test]
    fn short_words_get_no_typo_slack() {
        assert!(r("cat", "cut.txt", false).is_none());
        assert!(r("tset", "test.txt", false).is_some());
    }

    #[test]
    fn every_word_must_be_close() {
        assert!(r("pasport zebra", "passport.pdf", false).is_none());
    }

    #[test]
    fn folders_sort_ahead_of_files_in_the_same_tier() {
        let dir = r("report", "report", true).unwrap();
        let file = r("report", "report", false).unwrap();
        assert!(dir < file);
        let exact_file = r("report", "report", false).unwrap();
        let prefix_dir = r("report", "reports", true).unwrap();
        assert!(
            exact_file < prefix_dir,
            "a better tier beats being a folder"
        );
    }

    #[test]
    fn close_matches_never_outrank_real_ones() {
        let real = r("pasport", "my pasport scan.pdf", false).unwrap();
        let close = r("pasport", "passport.pdf", false).unwrap();
        assert!(real < close);
    }

    #[test]
    fn osa_counts_a_swap_as_one() {
        let a: Vec<char> = "teh".chars().collect();
        let b: Vec<char> = "the".chars().collect();
        assert_eq!(osa(&a, &b, 2), Some(1));
        let c: Vec<char> = "xyz".chars().collect();
        assert_eq!(osa(&a, &c, 2), None);
    }

    #[test]
    fn fts_match_builds_and_or_expressions() {
        let q = Query::new("tax 2024");
        assert_eq!(fts_match(&q, true).unwrap(), "\"tax\" AND \"2024\"");
        assert_eq!(
            fts_match(&q, false).unwrap(),
            "\"tax\" OR \"202\" OR \"024\""
        );
        assert!(fts_match(&Query::new("ab"), true).is_none());
        assert!(fts_match(&Query::new("ab"), false).is_none());
    }
}
