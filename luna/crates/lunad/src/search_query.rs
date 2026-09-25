//! Query parsing for the gallery `q` parameter.
//!
//! The free-text box doubles as a natural-language query: tokens that look
//! like dates ("september", "september 19", "9/19/2024", "last week",
//! "3 days ago", "christmas", "easter", "the 19th"), places ("seattle",
//! "oregon", "thailand"), media words ("videos", "heic", "landscape",
//! "flash"), or library state ("favorites", "no location") become filter
//! clauses; everything left over stays a substring match on
//! name/path/camera/lens/place/album.
//!
//! All predicates are evaluated in SQL or the existing post-filters — no
//! extra indexing work per query.

use std::collections::BTreeSet;

use crate::gallery::places;

const MAX_TEXT_TERMS: usize = 8;

/// A month/day window, optionally restricted to one weekday (SQLite %w,
/// Sunday = 0). Covers fixed holidays ("christmas" -> Dec 24..26) and movable
/// ones cheaply ("thanksgiving" -> Nov 22..28 Thursday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayWindow {
    pub month: u32,
    pub day_lo: u32,
    pub day_hi: u32,
    pub weekday: Option<u32>,
}

/// One token (or phrase) that resolved to a gazetteer place.
#[derive(Debug, Clone, Default)]
pub struct PlaceTerm {
    /// The phrase as typed (normalized) — still allowed to match text cols.
    pub raw: String,
    /// Canonical city/region/country names to compare against place columns.
    pub names: Vec<String>,
    /// City centers for "photos near X" radius matches.
    pub centers: Vec<(f64, f64)>,
}

#[derive(Debug, Default)]
pub struct ParsedQuery {
    /// Leftover substring terms — each is AND'd across the text columns.
    pub like_terms: Vec<String>,
    /// Resolved place phrases — each gets its own AND'd clause.
    pub places: Vec<PlaceTerm>,
    pub months: BTreeSet<u32>,
    pub weekdays: BTreeSet<u32>,
    pub years: BTreeSet<i32>,
    pub day_windows: Vec<DayWindow>,
    /// `[lo, hi)` epoch ranges on the effective capture time (AND'd).
    pub ranges: Vec<(i64, i64)>,
    /// One OR'd group of `[lo, hi)` epoch ranges — movable feasts ("easter",
    /// "advent") and ambiguous numeric dates ("3/4") land here.
    pub any_ranges: Vec<(i64, i64)>,
    /// Month+day ranges from "between X and Y" — ((start month, day),
    /// (end month, day)), OR'd. Wrapped ranges (nov → feb) are split when
    /// the SQL is built.
    pub md_ranges: Vec<((u32, u32), (u32, u32))>,
    /// Day-of-month set from bare ordinals ("the 19th", "on the 4th").
    pub days: BTreeSet<u32>,
    /// Inclusive UTC hour ranges; `lo > hi` wraps past midnight.
    pub hours: Vec<(u32, u32)>,
    pub kind: Option<&'static str>,
    /// Conflicting kind words seen ("photos and videos") — no kind filter,
    /// but the query did parse, so it must not fall back to a whole-`q` LIKE.
    pub kind_any: bool,
    pub formats: BTreeSet<String>,
    pub orientation: Option<&'static str>,
    pub flash: Option<i64>,
    pub favorites_only: bool,
    pub favorites_none: bool,
    pub undated: bool,
    pub no_gps: bool,
    pub has_gps: bool,
}

impl ParsedQuery {
    /// Nothing parsed — the caller should fall back to whole-`q` LIKE.
    pub fn is_empty(&self) -> bool {
        self.like_terms.is_empty()
            && self.places.is_empty()
            && self.months.is_empty()
            && self.weekdays.is_empty()
            && self.years.is_empty()
            && self.day_windows.is_empty()
            && self.ranges.is_empty()
            && self.any_ranges.is_empty()
            && self.md_ranges.is_empty()
            && self.days.is_empty()
            && self.hours.is_empty()
            && self.kind.is_none()
            && !self.kind_any
            && self.formats.is_empty()
            && self.orientation.is_none()
            && self.flash.is_none()
            && !self.favorites_only
            && !self.favorites_none
            && !self.undated
            && !self.no_gps
            && !self.has_gps
    }
}

const MONTHS: &[(&str, u32)] = &[
    ("january", 1),
    ("jan", 1),
    ("february", 2),
    ("feb", 2),
    ("march", 3),
    ("mar", 3),
    ("april", 4),
    ("apr", 4),
    ("may", 5),
    ("june", 6),
    ("jun", 6),
    ("july", 7),
    ("jul", 7),
    ("august", 8),
    ("aug", 8),
    ("september", 9),
    ("sept", 9),
    ("sep", 9),
    ("october", 10),
    ("oct", 10),
    ("november", 11),
    ("nov", 11),
    ("december", 12),
    ("dec", 12),
];

const WEEKDAYS: &[(&str, u32)] = &[
    ("sunday", 0),
    ("sun", 0),
    ("monday", 1),
    ("mon", 1),
    ("tuesday", 2),
    ("tue", 2),
    ("tues", 2),
    ("wednesday", 3),
    ("wed", 3),
    ("thursday", 4),
    ("thu", 4),
    ("thur", 4),
    ("thurs", 4),
    ("friday", 5),
    ("fri", 5),
    ("saturday", 6),
    ("sat", 6),
];

const SEASONS: &[(&str, &[u32])] = &[
    ("spring", &[3, 4, 5]),
    ("summer", &[6, 7, 8]),
    ("fall", &[9, 10, 11]),
    ("autumn", &[9, 10, 11]),
    ("winter", &[12, 1, 2]),
];

const IMAGE_FORMATS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "dng", "cr2",
    "cr3", "nef", "arw", "orf", "rw2",
];
const VIDEO_FORMATS: &[&str] = &["mp4", "mov", "webm", "avi", "mkv", "m4v", "3gp", "mts"];
const RAW_FORMATS: &[&str] = &["raw", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2"];

/// Words that carry no signal on their own — fillers, chatty command verbs
/// ("show me photos from…"), pronouns, auxiliaries, and linkers. A query of
/// only stop words still falls back to whole-`q` LIKE, so listing a word here
/// can never make things worse than a `%word%` substring match.
const STOP_WORDS: &[&str] = &[
    "a",
    "an",
    "the",
    "in",
    "at",
    "on",
    "of",
    "from",
    "for",
    "during",
    "taken",
    "took",
    "made",
    "captured",
    "my",
    "mine",
    "our",
    "ours",
    "your",
    "yours",
    "his",
    "her",
    "its",
    "their",
    "and",
    "or",
    "to",
    "with",
    "by",
    "me",
    "i",
    "we",
    "you",
    "they",
    "them",
    "he",
    "she",
    "it",
    // photo/image-family words are vocabulary (kind=image), not stop words.
    "snap",
    "snaps",
    "shot",
    "shots",
    "media",
    "albums",
    "library",
    // Chatty phrasing: "show me all my pictures", "find the ones near oslo".
    "show",
    "find",
    "get",
    "got",
    "see",
    "display",
    "list",
    "look",
    "looking",
    "search",
    "searching",
    "want",
    "need",
    "give",
    "please",
    "all",
    "every",
    "each",
    "any",
    "some",
    "just",
    "over",
    "near",
    "around",
    "about",
    "ago",
    "between",
    "can",
    "could",
    "would",
    "do",
    "does",
    "did",
    "is",
    "are",
    "was",
    "were",
    "have",
    "has",
    "had",
    "be",
    "been",
    "where",
    "what",
    "which",
    "who",
    "when",
    "how",
    "there",
    "here",
    // Unit nouns alone carry no signal — the relative/count arms consume
    // them as units, so a bare "month" only ever came from phrasing like
    // "the 19th of every month".
    "day",
    "days",
    "week",
    "weeks",
    "month",
    "months",
    "year",
    "years",
    "time",
    "times",
    // Negators only matter as a prefix to a vocab word; alone they are
    // useless LIKE terms ("no flash" -> flash=0, not a %no% substring match).
    "no",
    "not",
    "without",
    "non",
    "plus",
    // Generated by protect_digit_separators — a dash or colon between digits
    // survives normalize() as a marker token. Unconsumed markers must never
    // leak into like_terms.
    "dashrange",
    "clocksep",
];

/// Parse `q` against the bundled gazetteer and date vocabulary. `now` is the
/// current epoch second (UTC) for relative dates.
pub fn parse(q: &str, now: i64) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    let norm = places::normalize(&protect_digit_separators(q));
    let tokens: Vec<String> = norm
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    let n = tokens.len();
    let mut consumed = vec![false; n];
    let mut i = 0;
    let gaz = places::index();

    while i < n {
        if consumed[i] {
            i += 1;
            continue;
        }

        // Multi-word vocabulary phrases first ("new years eve", "last week",
        // "st patricks day", "no location") so city names can't steal them.
        if let Some(len) = match_vocab_phrase(&tokens, i, &mut out, now) {
            i += len;
            continue;
        }

        // Gazetteer n-grams, longest first ("new york" beats "new" + "york").
        let mut hit = false;
        for len in (2..=4).rev() {
            if i + len > n || consumed[i..i + len].iter().any(|c| *c) {
                continue;
            }
            let phrase = tokens[i..i + len].join(" ");
            let matches = gaz.lookup(&phrase);
            if !matches.is_empty() {
                out.places.push(place_term(&phrase, matches));
                for c in consumed.iter_mut().take(i + len).skip(i) {
                    *c = true;
                }
                i += len;
                hit = true;
                break;
            }
        }
        if hit {
            continue;
        }

        // Single-token vocabulary.
        let tok = tokens[i].as_str();
        // Negated when a negator appears within the last three tokens with
        // only stop words in between ("no flash", "not a flash").
        let negated = (1..=3).any(|back| {
            i >= back
                && matches!(tokens[i - back].as_str(), "no" | "without" | "not" | "non")
                && tokens[i - back + 1..i]
                    .iter()
                    .all(|t| STOP_WORDS.contains(&t.as_str()))
        });
        if match_vocab_word(&tokens, i, negated, &mut out, now) {
            consumed[i] = true;
            i += 1;
            continue;
        }

        // Single-token place names — guarded against ordinary words.
        let matches = if tok.len() >= 3 && !places::Places::is_ambiguous_city_word(tok) {
            gaz.lookup(tok)
        } else {
            &[]
        };
        if !matches.is_empty() {
            out.places.push(place_term(tok, matches));
            consumed[i] = true;
            i += 1;
            continue;
        }

        if !STOP_WORDS.contains(&tok) && out.like_terms.len() < MAX_TEXT_TERMS {
            out.like_terms.push(tok.to_string());
        }
        consumed[i] = true;
        i += 1;
    }

    // AND'd ranges collapse to their intersection ("last week last month");
    // an empty intersection stays empty — an impossible query should return
    // nothing rather than widen.
    if !out.ranges.is_empty() {
        let lo = out.ranges.iter().map(|r| r.0).max().unwrap();
        let hi = out.ranges.iter().map(|r| r.1).min().unwrap();
        out.ranges = vec![(lo, hi.max(lo))];
    }
    // Merge overlapping OR'd ranges — feast windows for the same year often
    // abut ("good friday" + "easter"), and each surviving range is one SQL
    // comparison pair per row.
    if out.any_ranges.len() > 1 {
        out.any_ranges.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::with_capacity(out.any_ranges.len());
        for &(lo, hi) in &out.any_ranges {
            match merged.last_mut() {
                Some(last) if lo <= last.1 => last.1 = last.1.max(hi),
                _ => merged.push((lo, hi)),
            }
        }
        out.any_ranges = merged;
    }
    out
}

/// Preserve digit separators that normalization erases: `a-b`/`a–b` becomes
/// `a dashrange b` (a range or date, not a stray year) and `h:mm` becomes
/// `h clocksep mm` (a clock time, not a date). Dots stay spaces — dotted
/// dates are more common than decimals in a photo query.
fn protect_digit_separators(q: &str) -> String {
    let chars: Vec<char> = q.chars().collect();
    let mut out = String::with_capacity(q.len() + 8);
    for (idx, &c) in chars.iter().enumerate() {
        let digit_pair = idx > 0
            && chars[idx - 1].is_ascii_digit()
            && chars.get(idx + 1).is_some_and(|n| n.is_ascii_digit());
        if digit_pair && matches!(c, '-' | '–' | '—') {
            out.push_str(" dashrange ");
        } else if digit_pair && c == ':' {
            out.push_str(" clocksep ");
        } else {
            out.push(c);
        }
    }
    out
}

/// Push an epoch range. "and" between two range phrases means union —
/// "last week and this week" can't intersect — so it moves the existing
/// AND'd ranges into the OR'd group instead.
fn push_range(out: &mut ParsedQuery, tokens: &[String], i: usize, r: (i64, i64)) {
    if i > 0 && tokens[i - 1] == "and" && !out.ranges.is_empty() {
        out.any_ranges.append(&mut out.ranges);
        out.any_ranges.push(r);
    } else {
        out.ranges.push(r);
    }
}

fn place_term(raw: &str, matches: &[places::PlaceMatch]) -> PlaceTerm {
    let mut names: Vec<String> = Vec::new();
    let mut centers: Vec<(f64, f64)> = Vec::new();
    for m in matches {
        if !names.iter().any(|n| n.eq_ignore_ascii_case(&m.name)) {
            names.push(m.name.clone());
        }
        if m.kind == places::PlaceKind::City && !centers.contains(&(m.lat, m.lon)) {
            centers.push((m.lat, m.lon));
        }
    }
    PlaceTerm {
        raw: raw.to_string(),
        names,
        centers,
    }
}

const fn dw(month: u32, lo: u32, hi: u32, wd: Option<u32>) -> DayWindow {
    DayWindow {
        month,
        day_lo: lo,
        day_hi: hi,
        weekday: wd,
    }
}

/// Holidays keyed by normalized phrase ("patrick's" normalizes to
/// "patrick s" — apostrophes become token boundaries).
const HOLIDAYS: &[(&str, &[DayWindow])] = &[
    ("new years eve", &[dw(12, 31, 31, None)]),
    ("new year s eve", &[dw(12, 31, 31, None)]),
    ("new years day", &[dw(1, 1, 1, None)]),
    ("new year s day", &[dw(1, 1, 1, None)]),
    ("new year", &[dw(12, 31, 31, None), dw(1, 1, 1, None)]),
    ("new years", &[dw(12, 31, 31, None), dw(1, 1, 1, None)]),
    ("new year s", &[dw(12, 31, 31, None), dw(1, 1, 1, None)]),
    ("christmas", &[dw(12, 24, 26, None)]),
    ("christmas eve", &[dw(12, 24, 24, None)]),
    ("christmas day", &[dw(12, 25, 25, None)]),
    ("xmas", &[dw(12, 24, 26, None)]),
    ("boxing day", &[dw(12, 26, 26, None)]),
    ("halloween", &[dw(10, 31, 31, None)]),
    ("thanksgiving", &[dw(11, 22, 28, Some(4))]),
    ("independence day", &[dw(7, 4, 4, None)]),
    ("july 4", &[dw(7, 4, 4, None)]),
    ("july 4th", &[dw(7, 4, 4, None)]),
    ("4th of july", &[dw(7, 4, 4, None)]),
    ("fourth of july", &[dw(7, 4, 4, None)]),
    ("4th july", &[dw(7, 4, 4, None)]),
    ("valentines day", &[dw(2, 14, 14, None)]),
    ("valentine s day", &[dw(2, 14, 14, None)]),
    ("valentines", &[dw(2, 14, 14, None)]),
    ("valentine s", &[dw(2, 14, 14, None)]),
    ("st patricks day", &[dw(3, 17, 17, None)]),
    ("st patrick s day", &[dw(3, 17, 17, None)]),
    ("saint patricks day", &[dw(3, 17, 17, None)]),
    ("saint patrick s day", &[dw(3, 17, 17, None)]),
    ("st patricks", &[dw(3, 17, 17, None)]),
    ("st patrick s", &[dw(3, 17, 17, None)]),
    ("cinco de mayo", &[dw(5, 5, 5, None)]),
    ("april fools day", &[dw(4, 1, 1, None)]),
    ("april fool s day", &[dw(4, 1, 1, None)]),
    ("april fools", &[dw(4, 1, 1, None)]),
    ("april fool s", &[dw(4, 1, 1, None)]),
    ("epiphany", &[dw(1, 6, 6, None)]),
    ("three kings day", &[dw(1, 6, 6, None)]),
    ("twelfth night", &[dw(1, 5, 5, None)]),
    ("groundhog day", &[dw(2, 2, 2, None)]),
    ("pi day", &[dw(3, 14, 14, None)]),
    ("earth day", &[dw(4, 22, 22, None)]),
    ("star wars day", &[dw(5, 4, 4, None)]),
    ("may the fourth", &[dw(5, 4, 4, None)]),
    ("bastille day", &[dw(7, 14, 14, None)]),
    ("canada day", &[dw(7, 1, 1, None)]),
    ("burns night", &[dw(1, 25, 25, None)]),
    ("st davids day", &[dw(3, 1, 1, None)]),
    ("st david s day", &[dw(3, 1, 1, None)]),
    ("st georges day", &[dw(4, 23, 23, None)]),
    ("st george s day", &[dw(4, 23, 23, None)]),
    ("st andrews day", &[dw(11, 30, 30, None)]),
    ("st andrew s day", &[dw(11, 30, 30, None)]),
    ("veterans day", &[dw(11, 11, 11, None)]),
    ("veteran s day", &[dw(11, 11, 11, None)]),
    ("remembrance day", &[dw(11, 11, 11, None)]),
    ("armistice day", &[dw(11, 11, 11, None)]),
    ("bonfire night", &[dw(11, 5, 5, None)]),
    ("guy fawkes", &[dw(11, 5, 5, None)]),
    ("guy fawkes night", &[dw(11, 5, 5, None)]),
    ("all saints day", &[dw(11, 1, 1, None)]),
    ("all souls day", &[dw(11, 2, 2, None)]),
    ("dia de los muertos", &[dw(11, 1, 2, None)]),
    ("day of the dead", &[dw(11, 1, 2, None)]),
    ("summer solstice", &[dw(6, 20, 21, None)]),
    ("winter solstice", &[dw(12, 21, 22, None)]),
    ("spring equinox", &[dw(3, 19, 20, None)]),
    ("vernal equinox", &[dw(3, 19, 20, None)]),
    ("fall equinox", &[dw(9, 22, 23, None)]),
    ("autumnal equinox", &[dw(9, 22, 23, None)]),
    // Nth-weekday holidays — the DayWindow weekday constraint picks the
    // one matching day inside the possible-date window.
    ("mlk day", &[dw(1, 15, 21, Some(1))]),
    ("martin luther king day", &[dw(1, 15, 21, Some(1))]),
    ("martin luther king jr day", &[dw(1, 15, 21, Some(1))]),
    ("presidents day", &[dw(2, 15, 21, Some(1))]),
    ("president s day", &[dw(2, 15, 21, Some(1))]),
    ("washington s birthday", &[dw(2, 15, 21, Some(1))]),
    ("mothers day", &[dw(5, 8, 14, Some(0))]),
    ("mother s day", &[dw(5, 8, 14, Some(0))]),
    ("fathers day", &[dw(6, 15, 21, Some(0))]),
    ("father s day", &[dw(6, 15, 21, Some(0))]),
    ("memorial day", &[dw(5, 25, 31, Some(1))]),
    ("labor day", &[dw(9, 1, 7, Some(1))]),
    ("labour day", &[dw(9, 1, 7, Some(1))]),
    ("columbus day", &[dw(10, 8, 14, Some(1))]),
    ("indigenous peoples day", &[dw(10, 8, 14, Some(1))]),
    ("indigenous people s day", &[dw(10, 8, 14, Some(1))]),
    ("black friday", &[dw(11, 23, 29, Some(5))]),
    (
        "cyber monday",
        &[dw(11, 26, 30, Some(1)), dw(12, 1, 2, Some(1))],
    ),
    ("super bowl", &[dw(2, 1, 14, Some(0))]),
    ("super bowl sunday", &[dw(2, 1, 14, Some(0))]),
    ("superbowl", &[dw(2, 1, 14, Some(0))]),
    // Lunisolar festivals drift against the Gregorian calendar; these
    // windows cover their full historical range rather than exact dates.
    ("oktoberfest", &[dw(9, 16, 30, None), dw(10, 1, 7, None)]),
    ("hanukkah", &[dw(11, 27, 30, None), dw(12, 1, 26, None)]),
    ("chanukah", &[dw(11, 27, 30, None), dw(12, 1, 26, None)]),
    ("hanukah", &[dw(11, 27, 30, None), dw(12, 1, 26, None)]),
    ("chanukkah", &[dw(11, 27, 30, None), dw(12, 1, 26, None)]),
    ("diwali", &[dw(10, 15, 31, None), dw(11, 1, 15, None)]),
    ("deepavali", &[dw(10, 15, 31, None), dw(11, 1, 15, None)]),
    (
        "chinese new year",
        &[dw(1, 21, 31, None), dw(2, 1, 20, None)],
    ),
    ("lunar new year", &[dw(1, 21, 31, None), dw(2, 1, 20, None)]),
];

/// Movable feasts as inclusive day offsets from Easter Sunday.
const EASTER_OFFSETS: &[(&str, i64, i64)] = &[
    ("easter", 0, 0),
    ("easter sunday", 0, 0),
    ("easter weekend", -2, 1),
    ("easter monday", 1, 1),
    ("easter saturday", -1, -1),
    ("holy saturday", -1, -1),
    ("good friday", -2, -2),
    ("maundy thursday", -3, -3),
    ("holy thursday", -3, -3),
    ("palm sunday", -7, -7),
    ("holy week", -7, 0),
    ("lent", -46, -1),
    ("ash wednesday", -46, -46),
    ("mardi gras", -47, -47),
    ("fat tuesday", -47, -47),
    ("shrove tuesday", -47, -47),
    ("pancake day", -47, -47),
    ("mothering sunday", -21, -21),
    ("ascension day", 39, 39),
    ("pentecost", 49, 49),
    ("whit sunday", 49, 49),
    ("whitsun", 49, 49),
    ("whit monday", 50, 50),
    ("pentecost monday", 50, 50),
    ("trinity sunday", 56, 56),
    ("corpus christi", 60, 60),
];

/// Time-of-day vocabulary as inclusive UTC hour windows; `hi <= lo` wraps
/// past midnight. Shared by single words ("evening") and relative phrases
/// ("last night", "this morning").
const TIME_OF_DAY: &[(&str, u32, u32)] = &[
    ("morning", 5, 11),
    ("sunrise", 5, 8),
    ("dawn", 5, 8),
    ("midday", 11, 14),
    ("noon", 11, 14),
    ("afternoon", 12, 16),
    ("evening", 17, 20),
    ("dusk", 17, 20),
    ("sunset", 17, 20),
    ("night", 20, 4),
    ("midnight", 23, 1),
    ("daytime", 7, 19),
    ("nighttime", 19, 7),
];

/// Single-word ordinals ("first" .. "thirtieth"). Composites like "twenty
/// first" are assembled in [`match_day_num`].
const ORDINAL_WORDS: &[(&str, u32)] = &[
    ("first", 1),
    ("second", 2),
    ("third", 3),
    ("fourth", 4),
    ("fifth", 5),
    ("sixth", 6),
    ("seventh", 7),
    ("eighth", 8),
    ("ninth", 9),
    ("tenth", 10),
    ("eleventh", 11),
    ("twelfth", 12),
    ("thirteenth", 13),
    ("fourteenth", 14),
    ("fifteenth", 15),
    ("sixteenth", 16),
    ("seventeenth", 17),
    ("eighteenth", 18),
    ("nineteenth", 19),
    ("twentieth", 20),
    ("thirtieth", 30),
];

/// Count words for "N units ago" / "last N units" — digits are handled
/// separately; these cover "a week ago", "a couple of days", "two years".
const COUNT_WORDS: &[(&str, u64)] = &[
    ("one", 1),
    ("single", 1),
    ("two", 2),
    ("three", 3),
    ("four", 4),
    ("five", 5),
    ("six", 6),
    ("seven", 7),
    ("eight", 8),
    ("nine", 9),
    ("ten", 10),
    ("eleven", 11),
    ("twelve", 12),
];

/// Connectors for ranges: "march to june", "september 19 through 21".
/// "dashrange" is generated for a dash between two digits ("19-21") before
/// normalize() erases it — dashes mean ranges, spaces mean years.
const RANGE_CONNECTORS: &[&str] = &["to", "through", "thru", "until", "til", "till", "dashrange"];

/// Relative-word direction for "last/this/next X" phrases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rel {
    Last,
    This,
    Next,
}

/// Units for "N ago" / "last N" ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Fortnight,
    Month,
    Year,
}

fn unit_of(tok: &str) -> Option<Unit> {
    Some(match tok {
        "second" | "seconds" | "sec" | "secs" => Unit::Second,
        "minute" | "minutes" | "min" | "mins" => Unit::Minute,
        "hour" | "hours" | "hr" | "hrs" => Unit::Hour,
        "day" | "days" => Unit::Day,
        "week" | "weeks" => Unit::Week,
        "fortnight" | "fortnights" => Unit::Fortnight,
        "month" | "months" => Unit::Month,
        "year" | "years" => Unit::Year,
        _ => return None,
    })
}

/// Try vocab phrases starting at `tokens[i]`. Returns words consumed.
fn match_vocab_phrase(
    tokens: &[String],
    i: usize,
    out: &mut ParsedQuery,
    now: i64,
) -> Option<usize> {
    let t = |k: usize| tokens.get(i + k).map(String::as_str).unwrap_or("");
    let (y, mo, _d, _h, dow) = civil_from_unix(now);
    let day0 = now - (now % 86400); // today 00:00 UTC

    // Holidays / named days — longest phrase first.
    for len in (1..=4).rev() {
        if i + len > tokens.len() {
            continue;
        }
        let phrase = tokens[i..i + len].join(" ");
        if let Some((_, windows)) = HOLIDAYS.iter().find(|(p, _)| *p == phrase) {
            out.day_windows.extend_from_slice(windows);
            return Some(len);
        }
    }

    // Movable feasts — Easter-relative and Advent resolved per year into
    // one OR'd group, so "easter" means every Easter in the library.
    for len in (1..=4).rev() {
        if i + len > tokens.len() {
            continue;
        }
        let phrase = tokens[i..i + len].join(" ");
        if let Some(&(.., lo, hi)) = EASTER_OFFSETS.iter().find(|(p, ..)| *p == phrase) {
            for yy in 1970..=(y + 1) {
                out.any_ranges.push(easter_range(yy, lo, hi));
            }
            return Some(len);
        }
        if phrase == "advent" || phrase == "advent season" {
            for yy in 1970..=(y + 1) {
                out.any_ranges.push(advent_range(yy));
            }
            return Some(len);
        }
    }

    match format!("{} {}", t(0), t(1)).as_str() {
        "golden hour" => {
            out.hours.push((17, 19));
            return Some(2);
        }
        "blue hour" => {
            out.hours.extend([(5, 7), (19, 21)]);
            return Some(2);
        }
        "with location" | "with gps" | "geotagged" | "has location" => {
            out.has_gps = true;
            return Some(2);
        }
        "no location" | "no gps" | "without location" | "not located" | "no place" => {
            out.no_gps = true;
            return Some(2);
        }
        "no date" | "no dates" | "without date" | "not dated" => {
            out.undated = true;
            return Some(2);
        }
        "no videos" | "without videos" => {
            set_kind(out, "image");
            return Some(2);
        }
        "no photos" | "without photos" => {
            set_kind(out, "video");
            return Some(2);
        }
        "other day" => {
            // "the other day" — sometime in the last week.
            push_range(out, tokens, i, (day0 - 7 * 86400, day0));
            return Some(2);
        }
        "while ago" | "while back" => {
            // "a while ago" — weeks to months back, not just now.
            push_range(out, tokens, i, (now - 120 * 86400, day0 - 86400));
            return Some(2);
        }
        "near me" | "close by" | "around me" => {
            out.has_gps = true;
            return Some(2);
        }
        _ => {}
    }

    // Three-word misc phrases.
    match format!("{} {} {}", t(0), t(1), t(2)).as_str() {
        "day after tomorrow" => {
            push_range(out, tokens, i, (day0 + 2 * 86400, day0 + 3 * 86400));
            return Some(3);
        }
        "day before yesterday" => {
            push_range(out, tokens, i, (day0 - 2 * 86400, day0 - 86400));
            return Some(3);
        }
        "week before last" => {
            let monday0 = day0 - ((dow + 6) % 7) as i64 * 86400;
            push_range(out, tokens, i, (monday0 - 14 * 86400, monday0 - 7 * 86400));
            return Some(3);
        }
        _ => {}
    }

    // "second sunday of may", "first monday of september" — an nth-weekday
    // window. "last friday of june" is handled in the relative block below.
    if let Some(&(_, nth)) = ORDINAL_WORDS.iter().find(|(w, _)| *w == t(0))
        && (1..=5).contains(&nth)
        && let Some(wd) = weekday_of(t(1))
        && t(2) == "of"
        && let Some(m) = month_of(t(3))
    {
        let lo = 1 + 7 * (nth - 1);
        let hi = (7 * nth).min(days_in_month(2024, m));
        out.day_windows.push(dw(m, lo, hi, Some(wd)));
        return Some(4);
    }

    // "week of march 3", "month of july", "year of 2024" — most recent
    // occurrence of the named period.
    if t(1) == "of" {
        match t(0) {
            "week" => {
                if let Some((Some(m), d, len)) = match_md(tokens, i + 2)
                    && d <= days_in_month(2024, m)
                {
                    // The week containing the most recent occurrence.
                    let pick = if days_from_civil(y, m, d) * 86400 <= now {
                        y
                    } else {
                        y - 1
                    };
                    let d0 = days_from_civil(pick, m, d);
                    let wd = (d0 + 4).rem_euclid(7);
                    let monday0 = (d0 - (wd + 6) % 7) * 86400;
                    push_range(out, tokens, i, (monday0, monday0 + 7 * 86400));
                    return Some(2 + len);
                }
            }
            "month" => {
                if let Some(m) = month_of(t(2)) {
                    let pick = if m > mo { y - 1 } else { y };
                    let (ny, nm) = add_months(pick, m, 1);
                    push_range(
                        out,
                        tokens,
                        i,
                        (
                            days_from_civil(pick, m, 1) * 86400,
                            days_from_civil(ny, nm, 1) * 86400,
                        ),
                    );
                    return Some(3);
                }
            }
            "year" => {
                if let Some(yy) = year_of(t(2)) {
                    push_range(
                        out,
                        tokens,
                        i,
                        (
                            days_from_civil(yy, 1, 1) * 86400,
                            days_from_civil(yy + 1, 1, 1) * 86400,
                        ),
                    );
                    return Some(3);
                }
            }
            _ => {}
        }
    }

    // Clock times: "9:30" survives normalization as "9 clocksep 30".
    if t(1) == "clocksep"
        && let (Some(h), Some(mn)) = (digits(t(0)), digits(t(2)))
        && h <= 23
        && mn <= 59
    {
        let (mut h, mut len) = (h, 3);
        match t(3) {
            "pm" if h != 12 => {
                h += 12;
                len = 4;
            }
            "am" => {
                h %= 12;
                len = 4;
            }
            _ => {}
        }
        out.hours.push((h, h));
        return Some(len);
    }

    // "3pm", "10am" — compact clock times.
    if let Some(h) = ampm_hour(t(0)) {
        out.hours.push((h, h));
        return Some(1);
    }

    // "in 3 days" / "in a week" — a forward range.
    if t(0) == "in"
        && let Some((cnt, cl)) = match_count(tokens, i + 1)
        && let Some(unit) = unit_of(t(1 + cl))
    {
        push_range(out, tokens, i, in_range(cnt, unit, now, y, mo, day0));
        return Some(1 + cl + 1);
    }

    // "last X" / "this X" / "next X" / "past X" — also "this past X".
    let rel = match t(0) {
        "last" | "past" | "previous" => Some(Rel::Last),
        "this" => Some(Rel::This),
        "next" => Some(Rel::Next),
        _ => None,
    };
    if let Some(mut rel) = rel {
        let mut base = 1;
        if t(1) == "past" && rel != Rel::Next {
            rel = Rel::Last;
            base = 2;
        }
        let u = |k: usize| t(base + k);
        // "last 3 days", "the past couple of weeks"
        if let Some((cnt, cl)) = match_count(tokens, i + base)
            && let Some(unit) = unit_of(u(cl))
            && let Some(r) = trailing_range(cnt, unit, rel, now, y, mo, day0)
        {
            push_range(out, tokens, i, r);
            return Some(base + cl + 1);
        }
        match u(0) {
            "week" => {
                let monday0 = day0 - ((dow + 6) % 7) as i64 * 86400;
                let (lo, hi) = match rel {
                    Rel::Last => (monday0 - 7 * 86400, monday0),
                    Rel::This => (monday0, monday0 + 7 * 86400),
                    Rel::Next => (monday0 + 7 * 86400, monday0 + 14 * 86400),
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "weekend" => {
                // sat0 is the most recent Saturday (today when it's Saturday).
                // Midweek, "this weekend" is the upcoming one; on the weekend
                // itself it's the one containing today.
                let sat0 = day0 - ((dow + 1) % 7) as i64 * 86400;
                let midweek = (1..=5).contains(&dow);
                let (lo, hi) = match rel {
                    Rel::Last => (sat0 - 7 * 86400, sat0 - 5 * 86400),
                    Rel::This if midweek => (sat0 + 7 * 86400, sat0 + 9 * 86400),
                    Rel::This => (sat0, sat0 + 2 * 86400),
                    Rel::Next if midweek => (sat0 + 14 * 86400, sat0 + 16 * 86400),
                    Rel::Next => (sat0 + 7 * 86400, sat0 + 9 * 86400),
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "month" => {
                let m0 = days_from_civil(y, mo, 1) * 86400;
                let (nm_y, nm_m) = if mo == 12 { (y + 1, 1) } else { (y, mo + 1) };
                let m1 = days_from_civil(nm_y, nm_m, 1) * 86400;
                let (py, pm) = if mo == 1 { (y - 1, 12) } else { (y, mo - 1) };
                let pm0 = days_from_civil(py, pm, 1) * 86400;
                let (lo, hi) = match rel {
                    Rel::Last => (pm0, m0),
                    Rel::This => (m0, m1),
                    Rel::Next => {
                        let (nyy, nnm) = if nm_m == 12 {
                            (nm_y + 1, 1)
                        } else {
                            (nm_y, nm_m + 1)
                        };
                        (m1, days_from_civil(nyy, nnm, 1) * 86400)
                    }
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "year" => {
                let (lo, hi) = match rel {
                    Rel::Last => (
                        days_from_civil(y - 1, 1, 1) * 86400,
                        days_from_civil(y, 1, 1) * 86400,
                    ),
                    Rel::This => (
                        days_from_civil(y, 1, 1) * 86400,
                        days_from_civil(y + 1, 1, 1) * 86400,
                    ),
                    Rel::Next => (
                        days_from_civil(y + 1, 1, 1) * 86400,
                        days_from_civil(y + 2, 1, 1) * 86400,
                    ),
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "day" => {
                let s = match rel {
                    Rel::Last => day0 - 86400,
                    Rel::This => day0,
                    Rel::Next => day0 + 86400,
                };
                push_range(out, tokens, i, (s, s + 86400));
                return Some(base + 1);
            }
            "hour" => {
                let h0 = now - now.rem_euclid(3600);
                let (lo, hi) = match rel {
                    Rel::Last => (h0 - 3600, h0),
                    Rel::This => (h0, h0 + 3600),
                    Rel::Next => (h0 + 3600, h0 + 7200),
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "fortnight" => {
                let (lo, hi) = match rel {
                    Rel::Last => (day0 - 14 * 86400, day0),
                    Rel::This => (day0 - 13 * 86400, day0 + 86400),
                    Rel::Next => (day0 + 86400, day0 + 15 * 86400),
                };
                push_range(out, tokens, i, (lo, hi));
                return Some(base + 1);
            }
            "summer" | "winter" | "spring" | "fall" | "autumn" => {
                let months = SEASONS.iter().find(|(n, _)| *n == u(0)).map(|(_, m)| *m)?;
                out.months.extend(months.iter());
                // most recent (last), current-year (this), or upcoming (next)
                let start_month = months[0];
                let end_month = *months.iter().max().unwrap();
                let year = match rel {
                    Rel::Last if mo <= end_month => y - 1,
                    Rel::Next if mo >= start_month => y + 1,
                    _ => y,
                };
                push_range(
                    out,
                    tokens,
                    i,
                    (
                        days_from_civil(year, 1, 1) * 86400,
                        days_from_civil(year + 1, 1, 1) * 86400,
                    ),
                );
                return Some(base + 1);
            }
            month_word => {
                if let Some(m) = month_of(month_word) {
                    out.months.insert(m);
                    let year = match rel {
                        Rel::Last if m >= mo => y - 1,
                        Rel::Next if m <= mo => y + 1,
                        _ => y,
                    };
                    push_range(
                        out,
                        tokens,
                        i,
                        (
                            days_from_civil(year, 1, 1) * 86400,
                            days_from_civil(year + 1, 1, 1) * 86400,
                        ),
                    );
                    return Some(base + 1);
                }
                // "last friday", "this sunday", "next monday"
                if let Some(wd) = weekday_of(month_word) {
                    // "last sunday of may" — the month's final such weekday.
                    if rel == Rel::Last
                        && u(1) == "of"
                        && let Some(m) = month_of(u(2))
                    {
                        let dim = days_in_month(2024, m);
                        out.day_windows.push(dw(m, dim - 6, dim, Some(wd)));
                        return Some(base + 3);
                    }
                    let target = match rel {
                        Rel::Last => {
                            let back = ((dow + 7 - wd) % 7) as i64;
                            day0 - (if back == 0 { 7 } else { back }) * 86400
                        }
                        Rel::This => {
                            let monday0 = day0 - ((dow + 6) % 7) as i64 * 86400;
                            monday0 + ((wd + 6) % 7) as i64 * 86400
                        }
                        Rel::Next => {
                            let fwd = ((wd + 7 - dow) % 7) as i64;
                            day0 + (if fwd == 0 { 7 } else { fwd }) * 86400
                        }
                    };
                    push_range(out, tokens, i, (target, target + 86400));
                    return Some(base + 1);
                }
                // "last night", "this morning", "next evening"
                if let Some(&(_, lo, hi)) = TIME_OF_DAY.iter().find(|(n, ..)| *n == month_word) {
                    let base0 = match rel {
                        Rel::Last => day0 - 86400,
                        Rel::This => day0,
                        Rel::Next => day0 + 86400,
                    };
                    let hi = if hi <= lo { hi + 24 } else { hi };
                    out.ranges
                        .push((base0 + lo as i64 * 3600, base0 + hi as i64 * 3600));
                    return Some(base + 1);
                }
                // "last christmas", "this easter", "next halloween"
                for len in (1..=3).rev() {
                    if i + base + len > tokens.len() {
                        continue;
                    }
                    let phrase = tokens[i + base..i + base + len].join(" ");
                    if let Some((_, windows)) = HOLIDAYS.iter().find(|(p, _)| *p == phrase) {
                        // Multi-window holidays ("new year" = Dec 31 + Jan 1)
                        // OR into one group — pushing each as an AND'd range
                        // would always match nothing.
                        for w in windows.iter() {
                            let pick = pick_year(|yy| window_range(w, yy), rel, now, y);
                            out.any_ranges.push(window_range(w, pick));
                        }
                        return Some(base + len);
                    }
                    if let Some(&(.., lo, hi)) = EASTER_OFFSETS.iter().find(|(p, ..)| *p == phrase)
                    {
                        let pick = pick_year(|yy| easter_range(yy, lo, hi), rel, now, y);
                        out.any_ranges.push(easter_range(pick, lo, hi));
                        return Some(base + len);
                    }
                    if phrase == "advent" || phrase == "advent season" {
                        let pick = pick_year(advent_range, rel, now, y);
                        out.any_ranges.push(advent_range(pick));
                        return Some(base + len);
                    }
                }
            }
        }
    }

    // "N units ago/back" — "2 days ago", "a couple of weeks back".
    if let Some((cnt, cl)) = match_count(tokens, i)
        && let Some(unit) = unit_of(t(cl))
        && matches!(t(cl + 1), "ago" | "back")
    {
        push_range(out, tokens, i, ago_range(cnt, unit, now, y, mo, day0));
        return Some(cl + 2);
    }

    // "between X and Y" — year spans, month spans, month+year spans, and
    // month+day bounds ("between sep 19 and 21", "between the 19th and 21st").
    if t(0) == "between" {
        if t(2) == "and" {
            if let (Some(a), Some(b)) = (year_of(t(1)), year_of(t(3))) {
                push_year_span(&mut out.years, a, b);
                return Some(4);
            }
            if let (Some(a), Some(b)) = (month_of(t(1)), month_of(t(3))) {
                push_month_span(&mut out.months, a, b);
                return Some(4);
            }
        }
        // "between march 2020 and june 2022" — a contiguous epoch range.
        if t(3) == "and"
            && let (Some(ma), Some(ya), Some(mb), Some(yb)) =
                (month_of(t(1)), year_of(t(2)), month_of(t(4)), year_of(t(5)))
        {
            let (ey, em) = add_months(yb, mb, 1);
            push_range(
                out,
                tokens,
                i,
                (
                    days_from_civil(ya, ma, 1) * 86400,
                    days_from_civil(ey, em, 1) * 86400,
                ),
            );
            return Some(6);
        }
        // Month+day bounds — scan for the "and" split since each side can
        // be "sep 19", "the 19th", or a bare day.
        for split in (i + 2)..=(i + 6).min(tokens.len().saturating_sub(1)) {
            if tokens.get(split).map(String::as_str) != Some("and") {
                continue;
            }
            let Some((am, ad, alen)) = match_md(tokens, i + 1) else {
                break;
            };
            if i + 1 + alen != split {
                break;
            }
            let Some((bm, bd, blen)) = match_md(tokens, split + 1) else {
                break;
            };
            let mut end = split + 1 + blen;
            match (am, bm) {
                (None, None) => out.days.extend(ad.min(bd)..=ad.max(bd)),
                _ => {
                    // A month-less bound inherits the other side's month.
                    let m1 = am.or(bm).unwrap();
                    let m2 = bm.or(am).unwrap();
                    if ad > days_in_month(2024, m1) || bd > days_in_month(2024, m2) {
                        break;
                    }
                    out.md_ranges.push(((m1, ad), (m2, bd)));
                }
            }
            if let Some(yy) = year_of(t(end - i)).or_else(|| short_year_of(t(end - i), y)) {
                out.years.insert(yy);
                end += 1;
            }
            return Some(end - i);
        }
    }

    // "march to june", "2020 through 2023" — contiguous ranges.
    if RANGE_CONNECTORS.contains(&t(1)) {
        if let (Some(a), Some(b)) = (month_of(t(0)), month_of(t(2))) {
            push_month_span(&mut out.months, a, b);
            return Some(3);
        }
        if let (Some(a), Some(b)) = (year_of(t(0)), year_of(t(2))) {
            push_year_span(&mut out.years, a, b);
            return Some(3);
        }
    }

    // "september 19", "september the 19th", "sep 19th 2024", "sep 19-21",
    // "sep 19 and 20". A bare trailing number is a year ("sep 19 21" ->
    // 2021); a connector makes it a day range ("sep 19 to 21", "sep 19-21").
    if let Some(m) = month_of(t(0)) {
        let mut j = 1;
        if t(j) == "the" {
            j += 1;
        }
        if let Some((list, dl)) = match_day_list(tokens, i + j)
            && list.iter().all(|&(_, hi)| hi <= days_in_month(2024, m))
        {
            j += dl;
            if let Some(yy) = year_of(t(j)).or_else(|| short_year_of(t(j), y)) {
                out.years.insert(yy);
                j += 1;
            }
            for (lo, hi) in list {
                out.day_windows.push(dw(m, lo, hi, None));
            }
            return Some(j);
        }
    }

    // Day-first: "19 september", "19th of september", "19 to 21 september",
    // "19th and 20th of sep 2024".
    if let Some((list, dl)) = match_day_list(tokens, i) {
        let mut j = dl;
        if t(j) == "of" || t(j) == "the" {
            j += 1;
        }
        if let Some(m) = month_of(t(j))
            && list.iter().all(|&(_, hi)| hi <= days_in_month(2024, m))
        {
            j += 1;
            if let Some(yy) = year_of(t(j)).or_else(|| short_year_of(t(j), y)) {
                out.years.insert(yy);
                j += 1;
            }
            for (lo, hi) in list {
                out.day_windows.push(dw(m, lo, hi, None));
            }
            return Some(j);
        }
    }

    // Numeric dates — normalization turned "9/19" and "2024.09.19" into
    // digit runs, and dashes survive as "dashrange" markers ("9-19-2024").
    if let Some(nd) = numeric_date(tokens, i, y) {
        match nd {
            NumericDate::My { month, year, len } => {
                out.months.insert(month);
                out.years.insert(year);
                return Some(len);
            }
            NumericDate::Md {
                month_days,
                year,
                len,
            } => {
                match year {
                    // Ambiguous pairs ("3 4 2024") get an OR'd range each.
                    Some(yy) => {
                        for (m, d) in &month_days {
                            let s = days_from_civil(yy, *m, *d) * 86400;
                            if month_days.len() == 1 {
                                push_range(out, tokens, i, (s, s + 86400));
                            } else {
                                out.any_ranges.push((s, s + 86400));
                            }
                        }
                    }
                    None => {
                        for (m, d) in month_days {
                            out.day_windows.push(dw(m, d, d, None));
                        }
                    }
                }
                return Some(len);
            }
        }
    }
    if let Some((cy, cm, cd)) = compact_date(t(0)) {
        let s = days_from_civil(cy, cm, cd) * 86400;
        push_range(out, tokens, i, (s, s + 86400));
        return Some(1);
    }

    // Bare day list, no month: "the 19th and 21st", "photos 19-21" — a
    // day-of-month set across all months. Single numbers stay LIKE terms.
    if let Some((list, dl)) = match_day_list(tokens, i)
        && dl > 1
    {
        for (lo, hi) in list {
            out.days.extend(lo.min(hi)..=lo.max(hi));
        }
        return Some(dl);
    }
    None
}

/// Single-token vocabulary. `negated` when preceded by no/without/not.
fn match_vocab_word(
    tokens: &[String],
    i: usize,
    negated: bool,
    out: &mut ParsedQuery,
    now: i64,
) -> bool {
    let tok = tokens[i].as_str();
    if let Some(m) = month_of(tok) {
        out.months.insert(m);
        return true;
    }
    // Seasons are exact matches only — plural-stripping made "falls",
    // "springs", "marches", and "aprils" hijack ordinary words.
    if let Some(&(_, months)) = SEASONS.iter().find(|(n, _)| *n == tok) {
        out.months.extend(months.iter());
        return true;
    }
    if tok == "weekend" || tok == "weekends" {
        out.weekdays.extend([0, 6]);
        return true;
    }
    if tok == "weekday" || tok == "weekdays" {
        out.weekdays.extend([1, 2, 3, 4, 5]);
        return true;
    }
    if let Some(d) = weekday_of(tok) {
        out.weekdays.insert(d);
        return true;
    }
    if let Some(y) = year_of(tok) {
        out.years.insert(y);
        return true;
    }
    if let Some(&(_, lo, hi)) = TIME_OF_DAY.iter().find(|(n, ..)| *n == tok) {
        out.hours.push((lo, hi));
        return true;
    }
    match tok {
        "today" => {
            let day0 = now - (now % 86400);
            push_range(out, tokens, i, (day0, day0 + 86400));
            true
        }
        "yesterday" => {
            let day0 = now - (now % 86400);
            push_range(out, tokens, i, (day0 - 86400, day0));
            true
        }
        "tomorrow" => {
            let day0 = now - (now % 86400);
            push_range(out, tokens, i, (day0 + 86400, day0 + 2 * 86400));
            true
        }
        "tonight" => {
            // This evening into the small hours: today 17:00 -> 04:00 UTC.
            let day0 = now - (now % 86400);
            push_range(out, tokens, i, (day0 + 17 * 3600, day0 + 28 * 3600));
            true
        }
        "recent" | "recently" | "lately" | "latest" | "newest" => {
            push_range(out, tokens, i, (now - 30 * 86400, now + 1));
            true
        }
        "video" | "videos" | "clip" | "clips" | "movie" | "movies" => {
            set_kind(out, if negated { "image" } else { "video" });
            true
        }
        "photo" | "photos" | "photograph" | "photographs" | "picture" | "pictures" | "pic"
        | "pics" | "image" | "images" => {
            set_kind(out, if negated { "video" } else { "image" });
            true
        }
        "landscape" | "portrait" | "square" | "vertical" | "horizontal" | "wide" | "tall"
        | "pano" | "panorama" | "panoramic" => {
            out.orientation = Some(match tok {
                "landscape" | "horizontal" | "wide" => "landscape",
                "portrait" | "vertical" | "tall" => "portrait",
                "square" => "square",
                _ => "pano",
            });
            true
        }
        "flash" => {
            out.flash = Some(if negated { 0 } else { 1 });
            true
        }
        "favorite" | "favorites" | "favourite" | "favourites" | "fav" | "favs" | "starred"
        | "liked" => {
            if negated {
                out.favorites_none = true;
            } else {
                out.favorites_only = true;
            }
            true
        }
        "undated" => {
            out.undated = true;
            true
        }
        "untagged" | "unlabeled" => {
            // nearest useful meaning: no place data
            out.no_gps = true;
            true
        }
        "geotagged" | "located" | "nearby" => {
            if negated {
                out.no_gps = true;
            } else {
                out.has_gps = true;
            }
            true
        }
        "screenshot" | "screenshots" => {
            set_kind(out, "image");
            if out.like_terms.len() < MAX_TEXT_TERMS {
                out.like_terms.push("screenshot".into());
            }
            true
        }
        _ => {
            let ext = tok.trim_start_matches('.');
            if tok == "raw" {
                out.formats
                    .extend(RAW_FORMATS.iter().map(|s| s.to_string()));
                true
            } else if IMAGE_FORMATS.contains(&ext) || VIDEO_FORMATS.contains(&ext) {
                out.formats.insert(normalize_ext(ext));
                true
            } else if let Some(d) = ordinal_digits(tok) {
                // Bare ordinal: "the 19th" -> day-of-month in any month.
                out.days.insert(d);
                true
            } else {
                false
            }
        }
    }
}

/// Month name lookup: exact names and abbreviations plus unambiguous
/// prefixes of full names ("septem" -> September) for typo tolerance.
/// Plurals are NOT stripped — "marches" and "aprils" are ordinary words.
fn month_of(tok: &str) -> Option<u32> {
    if let Some(&m) = MONTHS.iter().find(|(n, _)| *n == tok).map(|(_, m)| m) {
        return Some(m);
    }
    unique_prefix(tok, MONTHS)
}

/// Weekday lookup with plurals ("sundays") and unambiguous prefixes
/// ("wednes" -> wednesday).
fn weekday_of(tok: &str) -> Option<u32> {
    if let Some(&d) = WEEKDAYS.iter().find(|(n, _)| *n == tok).map(|(_, d)| d) {
        return Some(d);
    }
    let stem = tok.strip_suffix('s').unwrap_or(tok);
    if stem != tok
        && let Some(&d) = WEEKDAYS.iter().find(|(n, _)| *n == stem).map(|(_, d)| d)
    {
        return Some(d);
    }
    unique_prefix(tok, WEEKDAYS)
}

/// `tok` is a strict prefix of exactly one full name in `table` — short
/// abbreviations don't count, and ambiguity resolves to nothing ("ju" could
/// be june or july, but it's below the length floor anyway).
fn unique_prefix(tok: &str, table: &[(&str, u32)]) -> Option<u32> {
    if tok.len() < 4 {
        return None;
    }
    let mut hit = None;
    for (n, m) in table {
        if n.len() > 3 && n.starts_with(tok) {
            if hit.is_some_and(|h| h != *m) {
                return None;
            }
            hit = Some(*m);
        }
    }
    hit
}

/// A 4-digit year token, bounded to the plausible photo era.
fn year_of(tok: &str) -> Option<i32> {
    if tok.len() == 4
        && tok.bytes().all(|b| b.is_ascii_digit())
        && let Ok(y) = tok.parse::<i32>()
        && (1970..=2100).contains(&y)
    {
        Some(y)
    } else {
        None
    }
}

/// A 1-2 digit trailing year ("sep 19 24" -> 2024, "sep 19 89" -> 1989).
/// At/below the current year's last two digits reads as 20xx — photos can't
/// be future-dated — above it reads as 19xx.
fn short_year_of(tok: &str, cur_y: i32) -> Option<i32> {
    let v = digits(tok)?;
    (v <= 99).then(|| pivot_year(v, cur_y))
}

fn pivot_year(v: u32, cur_y: i32) -> i32 {
    let pivot = (cur_y % 100) as u32;
    if v <= pivot {
        2000 + v as i32
    } else {
        1900 + v as i32
    }
}

/// A token of up to 4 digits, as a number.
fn digits(tok: &str) -> Option<u32> {
    if !tok.is_empty() && tok.len() <= 4 && tok.bytes().all(|b| b.is_ascii_digit()) {
        tok.parse().ok()
    } else {
        None
    }
}

/// A day-of-month token: "19", "19th", "2nd", "first", "twenty first",
/// "thirty first". Returns (day, tokens consumed).
fn match_day_num(tokens: &[String], i: usize) -> Option<(u32, usize)> {
    let tok = tokens.get(i)?.as_str();
    if let Some(d) = day_digits(tok) {
        return Some((d, 1));
    }
    if matches!(tok, "twenty" | "thirty")
        && let Some(&(_, n)) = ORDINAL_WORDS
            .iter()
            .take(9)
            .find(|(w, _)| *w == tokens.get(i + 1).map(String::as_str).unwrap_or(""))
    {
        let d = if tok == "twenty" { 20 + n } else { 30 + n };
        return (d <= 31).then_some((d, 2));
    }
    ORDINAL_WORDS
        .iter()
        .find(|(w, _)| *w == tok)
        .map(|&(_, d)| (d, 1))
}

/// One or more day-of-month numbers: "19", "19 to 21", "19-21" (dash),
/// "19 and 20". Returns ((lo, hi) day ranges, tokens consumed) — a connector
/// extends the current range, "and"/"or"/"plus" starts a new one.
fn match_day_list(tokens: &[String], i: usize) -> Option<(Vec<(u32, u32)>, usize)> {
    let (d1, dl) = match_day_num(tokens, i)?;
    let mut list = vec![(d1, d1)];
    let mut j = dl;
    loop {
        let sep = tokens.get(i + j).map(String::as_str).unwrap_or("");
        if RANGE_CONNECTORS.contains(&sep) {
            if let Some((d2, dl2)) = match_day_num(tokens, i + j + 1) {
                let last = list.last_mut().unwrap();
                last.1 = last.1.max(d2);
                j += 1 + dl2;
                continue;
            }
        } else if matches!(sep, "and" | "or" | "plus")
            && let Some((d2, dl2)) = match_day_num(tokens, i + j + 1)
        {
            list.push((d2, d2));
            j += 1 + dl2;
            continue;
        }
        break;
    }
    Some((list, j))
}

/// A month+day or a lone day for "between X and Y": "sep 19" -> (Some(9),
/// 19, 2), "the 19th" -> (None, 19, 2). Returns (month, day, consumed).
fn match_md(tokens: &[String], i: usize) -> Option<(Option<u32>, u32, usize)> {
    let mut j = i;
    if tokens.get(j).map(String::as_str) == Some("the") {
        j += 1;
    }
    if let Some(m) = month_of(tokens.get(j).map(String::as_str)?) {
        let mut k = j + 1;
        if tokens.get(k).map(String::as_str) == Some("the") {
            k += 1;
        }
        let (d, dl) = match_day_num(tokens, k)?;
        return Some((Some(m), d, k + dl - i));
    }
    let (d, dl) = match_day_num(tokens, j)?;
    Some((None, d, j + dl - i))
}

/// "3pm"/"10am" compact clock times -> a 24h hour.
fn ampm_hour(tok: &str) -> Option<u32> {
    let (num, am) = tok
        .strip_suffix("pm")
        .map(|s| (s, false))
        .or_else(|| tok.strip_suffix("am").map(|s| (s, true)))?;
    let h = digits(num).filter(|h| (1..=12).contains(h))?;
    Some(if am { h % 12 } else { h % 12 + 12 })
}

/// Set the media kind — conflicting kinds ("photos and videos") cancel to
/// no filter rather than taking the last word.
fn set_kind(out: &mut ParsedQuery, k: &'static str) {
    match out.kind {
        Some(existing) if existing != k => {
            out.kind = None;
            out.kind_any = true;
        }
        None if out.kind_any => {}
        _ => out.kind = Some(k),
    }
}

/// "19", "19th", "2nd" — 1-2 digits with an optional ordinal suffix.
fn day_digits(tok: &str) -> Option<u32> {
    let (d, suffix) = split_day(tok)?;
    matches!(suffix, "" | "st" | "nd" | "rd" | "th").then_some(d)
}

/// Digit+suffix ordinals only ("19th", "4th") — bare numbers stay LIKE
/// terms so "IMG_19" searches still work.
fn ordinal_digits(tok: &str) -> Option<u32> {
    let (d, suffix) = split_day(tok)?;
    matches!(suffix, "st" | "nd" | "rd" | "th").then_some(d)
}

fn split_day(tok: &str) -> Option<(u32, &str)> {
    let num_len = tok.bytes().take_while(|b| b.is_ascii_digit()).count();
    if num_len == 0 || num_len > 2 {
        return None;
    }
    let d: u32 = tok[..num_len].parse().ok()?;
    (1..=31).contains(&d).then(|| (d, &tok[num_len..]))
}

/// A count token: "2", "two", "a", "a couple of", "a few", "several".
/// Returns (value, tokens consumed).
fn match_count(tokens: &[String], i: usize) -> Option<(u64, usize)> {
    let tok = tokens.get(i)?.as_str();
    if tok.len() <= 3
        && tok.bytes().all(|b| b.is_ascii_digit())
        && let Ok(n) = tok.parse::<u64>()
        && (1..=400).contains(&n)
    {
        return Some((n, 1));
    }
    let t1 = tokens.get(i + 1).map(String::as_str).unwrap_or("");
    let t2 = tokens.get(i + 2).map(String::as_str).unwrap_or("");
    match tok {
        "a" | "an" => match t1 {
            "couple" => Some((2, if t2 == "of" { 3 } else { 2 })),
            "few" => Some((3, if t2 == "of" { 3 } else { 2 })),
            _ => Some((1, 1)),
        },
        "couple" => Some((2, if t1 == "of" { 2 } else { 1 })),
        "few" => Some((3, if t1 == "of" { 2 } else { 1 })),
        "several" => Some((4, 1)),
        _ => COUNT_WORDS
            .iter()
            .find(|(w, _)| *w == tok)
            .map(|&(_, n)| (n, 1)),
    }
}

/// A numeric date reading.
enum NumericDate {
    /// (month, day) interpretations — two when both orders are valid —
    /// plus an optional year and the token count.
    Md {
        month_days: Vec<(u32, u32)>,
        year: Option<i32>,
        len: usize,
    },
    /// A month+year pair ("9/2024", "2024 09").
    My { month: u32, year: i32, len: usize },
}

/// Digit runs as dates: "9 19" (any year), "9 19 2024", "19 9 24",
/// "2024 09 19". "dashrange" markers are transparent separators, so
/// "9-19-2024" reads exactly like "9 19 2024".
fn numeric_date(tokens: &[String], i: usize, cur_y: i32) -> Option<NumericDate> {
    // Up to three digit runs; dashes between digits count as separators.
    let mut vals = [0u32; 3];
    let mut pos = [0usize; 3];
    let mut cnt = 0;
    let mut j = i;
    while cnt < 3 {
        match tokens.get(j).map(String::as_str) {
            Some("dashrange") => j += 1,
            Some(tok) => match digits(tok) {
                Some(v) => {
                    vals[cnt] = v;
                    pos[cnt] = j;
                    cnt += 1;
                    j += 1;
                }
                None => break,
            },
            None => break,
        }
    }
    if cnt < 2 {
        return None;
    }
    let len = |last: usize| pos[last] - i + 1;
    let (a, b) = (vals[0], vals[1]);
    if cnt == 3 {
        let c = vals[2];
        // "2024 09 19"
        if (1900..=2100).contains(&a) {
            let month_days = month_day_orders(b, c, a as i32);
            return (!month_days.is_empty()).then_some(NumericDate::Md {
                month_days,
                year: Some(a as i32),
                len: len(2),
            });
        }
        // "9 19 2024" / "19 9 24"
        let yy = if (1900..=2100).contains(&c) {
            Some(c as i32)
        } else if c <= 99 {
            Some(pivot_year(c, cur_y))
        } else {
            None
        };
        if let Some(yy) = yy {
            let month_days = month_day_orders(a, b, yy);
            return (!month_days.is_empty()).then_some(NumericDate::Md {
                month_days,
                year: Some(yy),
                len: len(2),
            });
        }
        // c isn't a year — the pair can still be a date on its own.
    }
    // "9/2024", "2024 09" — a month+year pair, not a day.
    if (1900..=2100).contains(&a) && (1..=12).contains(&b) {
        return Some(NumericDate::My {
            month: b,
            year: a as i32,
            len: len(1),
        });
    }
    if (1900..=2100).contains(&b) && (1..=12).contains(&a) {
        return Some(NumericDate::My {
            month: a,
            year: b as i32,
            len: len(1),
        });
    }
    let month_days = month_day_orders(a, b, 2024);
    (!month_days.is_empty()).then_some(NumericDate::Md {
        month_days,
        year: None,
        len: len(1),
    })
}

/// Interpret two day-sized numbers as (month, day): month-first unless the
/// first can't be a month ("19 9" -> Sep 19). Ambiguous pairs ("3 4")
/// return both orders so the OR'd window group matches either reading.
/// Days are validated against `year` — use a leap year (2024) when the date
/// is year-agnostic so "2/29" still parses.
fn month_day_orders(a: u32, b: u32, year: i32) -> Vec<(u32, u32)> {
    let valid = |m: u32, d: u32| (1..=12).contains(&m) && d >= 1 && d <= days_in_month(year, m);
    match (valid(a, b), valid(b, a)) {
        (true, false) => vec![(a, b)],
        (false, true) => vec![(b, a)],
        (true, true) => vec![(a, b), (b, a)],
        _ => vec![],
    }
}

/// "20240919" — one 8-digit token read as yyyymmdd.
fn compact_date(tok: &str) -> Option<(i32, u32, u32)> {
    if tok.len() != 8 || !tok.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let y: i32 = tok[..4].parse().ok()?;
    let m: u32 = tok[4..6].parse().ok()?;
    let d: u32 = tok[6..8].parse().ok()?;
    if (1970..=2100).contains(&y) && d >= 1 && d <= days_in_month(y, m) {
        Some((y, m, d))
    } else {
        None
    }
}

/// A contiguous month span; wraps the year boundary ("november to
/// february" -> nov, dec, jan, feb).
fn push_month_span(months: &mut BTreeSet<u32>, a: u32, b: u32) {
    if a <= b {
        months.extend(a..=b);
    } else {
        months.extend(a..=12);
        months.extend(1..=b);
    }
}

fn push_year_span(years: &mut BTreeSet<i32>, a: i32, b: i32) {
    years.extend(a.min(b)..=a.max(b));
}

/// Year/month shifted by `delta` months.
fn add_months(y: i32, m: u32, delta: i64) -> (i32, u32) {
    let idx = y as i64 * 12 + (m as i64 - 1) + delta;
    (idx.div_euclid(12) as i32, (idx.rem_euclid(12) + 1) as u32)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// "last/past N units" — a trailing window ending now ("last 3 days"
/// covers today and the two days before it). `None` for non-sensical
/// "next N" units.
fn trailing_range(
    n: u64,
    unit: Unit,
    rel: Rel,
    now: i64,
    y: i32,
    mo: u32,
    day0: i64,
) -> Option<(i64, i64)> {
    let n = n as i64;
    Some(match (rel, unit) {
        (Rel::Next, Unit::Day) => (day0 + 86400, day0 + (n + 1) * 86400),
        (Rel::Next, Unit::Week) => (day0 + 86400, day0 + (7 * n + 1) * 86400),
        (Rel::Next, Unit::Fortnight) => (day0 + 86400, day0 + (14 * n + 1) * 86400),
        (Rel::Next, Unit::Month) => {
            let (sy, sm) = add_months(y, mo, 1);
            let (ey, em) = add_months(y, mo, n + 1);
            (
                days_from_civil(sy, sm, 1) * 86400,
                days_from_civil(ey, em, 1) * 86400,
            )
        }
        (Rel::Next, Unit::Year) => (
            days_from_civil(y + 1, 1, 1) * 86400,
            days_from_civil(y + 1 + n as i32, 1, 1) * 86400,
        ),
        (Rel::Next, _) => return None,
        (_, Unit::Second) => (now - n, now + 1),
        (_, Unit::Minute) => (now - n * 60, now + 1),
        (_, Unit::Hour) => (now - n * 3600, now + 1),
        (_, Unit::Day) => (day0 - (n - 1) * 86400, day0 + 86400),
        (_, Unit::Week) => (day0 - (7 * n - 1) * 86400, day0 + 86400),
        (_, Unit::Fortnight) => (day0 - (14 * n - 1) * 86400, day0 + 86400),
        (_, Unit::Month) => {
            let (sy, sm) = add_months(y, mo, -(n - 1));
            (days_from_civil(sy, sm, 1) * 86400, day0 + 86400)
        }
        (_, Unit::Year) => (
            days_from_civil(y - n as i32 + 1, 1, 1) * 86400,
            day0 + 86400,
        ),
    })
}

/// "in N units" — the future period that point lands in ("in 3 days" is
/// the whole day three days out, "in 2 months" is that calendar month).
fn in_range(n: u64, unit: Unit, now: i64, y: i32, mo: u32, day0: i64) -> (i64, i64) {
    let n = n as i64;
    match unit {
        Unit::Second => (now + n, now + n + 1),
        Unit::Minute => {
            let m0 = (now + n * 60).div_euclid(60) * 60;
            (m0, m0 + 60)
        }
        Unit::Hour => {
            let h0 = (now + n * 3600).div_euclid(3600) * 3600;
            (h0, h0 + 3600)
        }
        Unit::Day => (day0 + n * 86400, day0 + (n + 1) * 86400),
        Unit::Week => (day0 + 7 * n * 86400, day0 + (7 * n + 1) * 86400),
        Unit::Fortnight => (day0 + 14 * n * 86400, day0 + (14 * n + 1) * 86400),
        Unit::Month => {
            let (sy, sm) = add_months(y, mo, n);
            let (ey, em) = add_months(y, mo, n + 1);
            (
                days_from_civil(sy, sm, 1) * 86400,
                days_from_civil(ey, em, 1) * 86400,
            )
        }
        Unit::Year => (
            days_from_civil(y + n as i32, 1, 1) * 86400,
            days_from_civil(y + n as i32 + 1, 1, 1) * 86400,
        ),
    }
}

/// "N units ago" — the period around that point in the past.
fn ago_range(n: u64, unit: Unit, now: i64, y: i32, mo: u32, day0: i64) -> (i64, i64) {
    let n = n as i64;
    match unit {
        Unit::Second => (now - n - 30, now - n + 30),
        Unit::Minute => {
            let m0 = (now - n * 60).div_euclid(60) * 60;
            (m0, m0 + 60)
        }
        Unit::Hour => {
            let h0 = (now - n * 3600).div_euclid(3600) * 3600;
            (h0, h0 + 3600)
        }
        Unit::Day => (day0 - n * 86400, day0 - (n - 1) * 86400),
        // Weeks/fortnights are loose: the day itself plus a day of slack.
        Unit::Week => (day0 - (7 * n + 1) * 86400, day0 - (7 * n - 2) * 86400),
        Unit::Fortnight => (day0 - (14 * n + 1) * 86400, day0 - (14 * n - 2) * 86400),
        Unit::Month => {
            let (sy, sm) = add_months(y, mo, -n);
            let (ey, em) = add_months(y, mo, -n + 1);
            (
                days_from_civil(sy, sm, 1) * 86400,
                days_from_civil(ey, em, 1) * 86400,
            )
        }
        Unit::Year => (
            days_from_civil(y - n as i32, 1, 1) * 86400,
            days_from_civil(y - n as i32 + 1, 1, 1) * 86400,
        ),
    }
}

/// Concrete `[lo, hi)` epoch span of a day window in one year — weekday-
/// constrained windows ("thanksgiving" = Nov 22..28 Thursday) collapse to
/// the single matching day.
fn window_range(w: &DayWindow, y: i32) -> (i64, i64) {
    if let Some(wd) = w.weekday {
        for d in w.day_lo..=w.day_hi {
            let days = days_from_civil(y, w.month, d);
            if (days + 4).rem_euclid(7) as u32 == wd {
                return (days * 86400, (days + 1) * 86400);
            }
        }
    }
    (
        days_from_civil(y, w.month, w.day_lo) * 86400,
        (days_from_civil(y, w.month, w.day_hi) + 1) * 86400,
    )
}

/// Gregorian Easter Sunday (Meeus/Jones/Butcher) as days since epoch.
fn easter_day(y: i32) -> i64 {
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = ((h + l - 7 * m + 114) / 31) as u32;
    let day = ((h + l - 7 * m + 114) % 31 + 1) as u32;
    days_from_civil(y, month, day)
}

fn easter_range(y: i32, lo: i64, hi: i64) -> (i64, i64) {
    let e = easter_day(y);
    ((e + lo) * 86400, (e + hi + 1) * 86400)
}

/// Advent: the Sunday between Nov 27 and Dec 3 through Christmas Eve.
fn advent_range(y: i32) -> (i64, i64) {
    let nov27 = days_from_civil(y, 11, 27);
    // First Sunday (%w = 0) on or after Nov 27.
    let start = nov27 + (7 - (nov27 + 4).rem_euclid(7)) % 7;
    (start * 86400, days_from_civil(y, 12, 25) * 86400)
}

/// Pick the year for "last/this/next <dated thing>": `range_for` gives the
/// [lo, hi) span of one year's occurrence.
fn pick_year(range_for: impl Fn(i32) -> (i64, i64), rel: Rel, now: i64, y: i32) -> i32 {
    match rel {
        Rel::This => y,
        Rel::Last => {
            if range_for(y).1 <= now {
                y
            } else {
                y - 1
            }
        }
        Rel::Next => {
            if range_for(y).0 >= now {
                y
            } else {
                y + 1
            }
        }
    }
}

fn normalize_ext(e: &str) -> String {
    if e == "jpeg" { "jpg".into() } else { e.into() }
}

/// unix seconds -> (year, month, day, hour, weekday-with-Sunday=0), UTC.
fn civil_from_unix(ts: i64) -> (i32, u32, u32, u32, u32) {
    let days = ts.div_euclid(86400);
    let secs = ts.rem_euclid(86400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y } as i32;
    let dow = ((days + 4).rem_euclid(7)) as u32; // 1970-01-01 was Thursday(4)
    (year, m, d, (secs / 3600) as u32, dow)
}

/// days since epoch for year-month-day, UTC (Hinnant days_from_civil).
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u32;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146097 + doe as i64 - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000; // 2027-01-15-ish UTC

    #[test]
    fn months_seasons_years() {
        let p = parse("september", NOW);
        assert!(p.months.contains(&9));
        let p = parse("fall", NOW);
        assert!(p.months.contains(&9) && p.months.contains(&10) && p.months.contains(&11));
        let p = parse("videos from thailand 2023", NOW);
        assert_eq!(p.kind, Some("video"));
        assert!(p.years.contains(&2023));
        assert_eq!(p.places.len(), 1);
        assert!(p.places[0].names.iter().any(|n| n == "Thailand"));
        assert!(p.like_terms.is_empty());
    }

    #[test]
    fn multiword_place_and_leftover() {
        let p = parse("new york wedding", NOW);
        assert_eq!(p.places.len(), 1);
        assert!(p.places[0].names.iter().any(|n| n == "New York"));
        assert_eq!(p.like_terms, vec!["wedding".to_string()]);
    }

    #[test]
    fn holidays_and_weekend() {
        let p = parse("christmas", NOW);
        assert_eq!(p.day_windows[0].month, 12);
        let p = parse("weekend hikes", NOW);
        assert!(p.weekdays.contains(&0) && p.weekdays.contains(&6));
        assert_eq!(p.like_terms, vec!["hikes".to_string()]);
    }

    #[test]
    fn relative_ranges() {
        let p = parse("last week", NOW);
        assert_eq!(p.ranges.len(), 1);
        assert_eq!(p.ranges[0].1 - p.ranges[0].0, 7 * 86400);
        let p = parse("last september", NOW);
        assert!(p.months.contains(&9));
        // Jan 2027 -> last September is 2026.
        let (y0, _, _, _, _) = civil_from_unix(p.ranges[0].0);
        assert_eq!(y0, 2026);
    }

    #[test]
    fn month_and_day() {
        let p = parse("september 19", NOW);
        assert!(p.day_windows.contains(&dw(9, 19, 19, None)));
        assert!(p.like_terms.is_empty());
        for q in [
            "sep 19th 2024",
            "19 september",
            "the 19th of september",
            "september the nineteenth",
            "september nineteenth",
        ] {
            let p = parse(q, NOW);
            assert!(
                p.day_windows.contains(&dw(9, 19, 19, None)),
                "{q} -> {:?}",
                p.day_windows
            );
        }
        let p = parse("sep 19th 2024", NOW);
        assert!(p.years.contains(&2024));
        // Day ranges, dashed or spelled out.
        for q in [
            "september 19-21",
            "september 19 to 21",
            "sept 19th through 21st",
        ] {
            let p = parse(q, NOW);
            assert!(
                p.day_windows.contains(&dw(9, 19, 21, None)),
                "{q} -> {:?}",
                p.day_windows
            );
        }
        // A year alone after a month stays a month+year query.
        let p = parse("march 2024", NOW);
        assert!(p.months.contains(&3) && p.years.contains(&2024) && p.day_windows.is_empty());
    }

    #[test]
    fn numeric_dates() {
        let p = parse("9/19", NOW);
        assert_eq!(p.day_windows, vec![dw(9, 19, 19, None)]);
        for q in ["19/9/2024", "2024-09-19", "20240919", "9.19.24"] {
            let p = parse(q, NOW);
            assert_eq!(p.ranges.len(), 1, "{q}");
            let (y, m, d, _, _) = civil_from_unix(p.ranges[0].0);
            assert_eq!((y, m, d), (2024, 9, 19), "{q}");
        }
        // Ambiguous day/month order matches both readings.
        let p = parse("3/4", NOW);
        assert_eq!(p.day_windows.len(), 2);
        assert!(p.day_windows.contains(&dw(3, 4, 4, None)));
        assert!(p.day_windows.contains(&dw(4, 3, 3, None)));
    }

    #[test]
    fn relative_counts_and_ago() {
        let day0 = NOW - (NOW % 86400);
        let p = parse("last 3 days", NOW);
        assert_eq!(p.ranges, vec![(day0 - 2 * 86400, day0 + 86400)]);
        let p = parse("2 days ago", NOW);
        assert_eq!(p.ranges, vec![(day0 - 2 * 86400, day0 - 86400)]);
        let p = parse("a couple of weeks ago", NOW);
        assert_eq!(p.ranges.len(), 1);
        assert_eq!(p.ranges[0].1 - p.ranges[0].0, 3 * 86400);
        let p = parse("photos from 6 months ago", NOW);
        assert_eq!(p.ranges.len(), 1);
        assert!(p.like_terms.is_empty());
        let p = parse("this past week", NOW);
        assert_eq!(p.ranges.len(), 1);
        assert_eq!(p.ranges[0].1 - p.ranges[0].0, 7 * 86400);
    }

    #[test]
    fn relative_named_days() {
        // "last friday" lands on a Friday strictly before today.
        let p = parse("last friday", NOW);
        let (_, _, _, _, dow) = civil_from_unix(p.ranges[0].0);
        assert_eq!(dow, 5);
        assert!(p.ranges[0].0 < NOW - (NOW % 86400));
        // "last christmas" -> Dec 24 of the most recent Christmas (2026).
        let p = parse("last christmas", NOW);
        assert!(p.like_terms.is_empty());
        assert_eq!(p.any_ranges.len(), 1);
        let (y, m, d, _, _) = civil_from_unix(p.any_ranges[0].0);
        assert_eq!((y, m, d), (2026, 12, 24));
        // "last thanksgiving" resolves to a Thursday in November.
        let p = parse("last thanksgiving", NOW);
        let (_, m, _, _, dow) = civil_from_unix(p.any_ranges[0].0);
        assert_eq!((m, dow), (11, 4));
        // "last night" is yesterday evening into this morning.
        let day0 = NOW - (NOW % 86400);
        let p = parse("last night", NOW);
        assert_eq!(p.ranges, vec![(day0 - 4 * 3600, day0 + 4 * 3600)]);
    }

    #[test]
    fn movable_feasts_and_misc() {
        // Easter Sunday 2024 was March 31.
        let (y, m, d, _, _) = civil_from_unix(easter_day(2024) * 86400);
        assert_eq!((y, m, d), (2024, 3, 31));
        let p = parse("easter", NOW);
        assert!(!p.any_ranges.is_empty());
        let p = parse("easter 2024", NOW);
        assert!(p.years.contains(&2024));
        let p = parse("advent", NOW);
        assert!(!p.any_ranges.is_empty());
        let p = parse("the other day", NOW);
        assert_eq!(p.ranges.len(), 1);
        let p = parse("the 19th", NOW);
        assert!(p.days.contains(&19));
        let p = parse("photos near seattle", NOW);
        assert!(p.like_terms.is_empty() && p.places.len() == 1);
    }

    #[test]
    fn vocab_extensions() {
        let p = parse("sundays", NOW);
        assert!(p.weekdays.contains(&0));
        let p = parse("weekdays", NOW);
        assert_eq!(p.weekdays.len(), 5);
        let p = parse("march to june", NOW);
        assert!(p.months.contains(&3) && p.months.contains(&5) && p.months.contains(&6));
        let p = parse("november to february", NOW);
        assert!(p.months.contains(&11) && p.months.contains(&12) && p.months.contains(&2));
        let p = parse("between 2020 and 2022", NOW);
        assert_eq!(p.years.len(), 3);
        let p = parse("vertical", NOW);
        assert_eq!(p.orientation, Some("portrait"));
        // Unambiguous month prefix is a typo-tolerant match.
        let p = parse("septem", NOW);
        assert!(p.months.contains(&9));
    }

    #[test]
    fn review_regressions() {
        // Multi-window holidays under last/this/next OR into one group —
        // pushing them as AND'd ranges would always match nothing. The
        // windows abut, so they merge into one contiguous span.
        let p = parse("last new year", NOW);
        assert_eq!(
            p.any_ranges,
            vec![(
                days_from_civil(2026, 12, 31) * 86400,
                days_from_civil(2027, 1, 2) * 86400
            )]
        );
        let p = parse("this oktoberfest", NOW);
        assert_eq!(
            p.any_ranges,
            vec![(
                days_from_civil(2027, 9, 16) * 86400,
                days_from_civil(2027, 10, 8) * 86400
            )]
        );

        // "this weekend" on a Sunday covers the weekend containing today;
        // "next weekend" is the one after.
        let sun = days_from_civil(2027, 1, 17) * 86400; // a Sunday
        assert_eq!(civil_from_unix(sun).4, 0);
        let p = parse("this weekend", sun);
        assert_eq!(
            p.ranges,
            vec![(
                days_from_civil(2027, 1, 16) * 86400,
                days_from_civil(2027, 1, 18) * 86400
            )]
        );
        let p = parse("next weekend", sun);
        assert_eq!(
            p.ranges,
            vec![(
                days_from_civil(2027, 1, 23) * 86400,
                days_from_civil(2027, 1, 25) * 86400
            )]
        );

        // A space after month+day reads as a year; a dash reads as a range.
        let p = parse("sep 19 24", NOW);
        assert_eq!(p.day_windows, vec![dw(9, 19, 19, None)]);
        assert!(p.years.contains(&2024));
        let p = parse("sep 19-21", NOW);
        assert_eq!(p.day_windows, vec![dw(9, 19, 21, None)]);

        // Ordinary words are not months or seasons.
        for q in ["multnomah falls", "wedding marches", "the winters family"] {
            let p = parse(q, NOW);
            assert!(p.months.is_empty(), "{q}");
        }

        // Both kinds cancel the filter rather than taking the last word.
        let p = parse("photos and videos", NOW);
        assert!(p.kind.is_none() && p.kind_any && !p.is_empty());
        let p = parse("photos", NOW);
        assert_eq!(p.kind, Some("image"));

        // Clock times are hour filters, not dates.
        let p = parse("9:30", NOW);
        assert_eq!(p.hours, vec![(9, 9)]);
        assert!(p.day_windows.is_empty() && p.like_terms.is_empty());
        let p = parse("9:30 pm", NOW);
        assert_eq!(p.hours, vec![(21, 21)]);
        let p = parse("3pm", NOW);
        assert_eq!(p.hours, vec![(15, 15)]);

        // Feb 29 only parses in a leap year — never wraps to March 1.
        let p = parse("2/29/2024", NOW);
        assert_eq!(p.ranges.len(), 1);
        let p = parse("2/29/2023", NOW);
        assert!(p.ranges.is_empty() && p.day_windows.is_empty());

        // Negation reaches across stop words.
        let p = parse("not a flash", NOW);
        assert_eq!(p.flash, Some(0));

        // Day lists OR instead of AND.
        let p = parse("september 19th and 20th", NOW);
        assert!(p.day_windows.contains(&dw(9, 19, 19, None)));
        assert!(p.day_windows.contains(&dw(9, 20, 20, None)));

        // "between sep 19 and 21" -> one month+day range; a month-less
        // bound inherits the other's month.
        let p = parse("between sep 19 and 21", NOW);
        assert_eq!(p.md_ranges, vec![((9, 19), (9, 21))]);
        let p = parse("between nov 20 and feb 10", NOW);
        assert_eq!(p.md_ranges, vec![((11, 20), (2, 10))]);

        // Month+year pairs.
        let p = parse("9/2024", NOW);
        assert!(p.months.contains(&9) && p.years.contains(&2024));
        assert!(p.day_windows.is_empty());

        // A day that doesn't exist in the month falls back to month + text
        // instead of silently matching nothing.
        let p = parse("april 31", NOW);
        assert!(p.day_windows.is_empty() && p.months.contains(&4));

        // "near me" means photos with a place attached.
        let p = parse("photos near me", NOW);
        assert!(p.has_gps);

        // Nth weekday of a month.
        let p = parse("second sunday of may", NOW);
        assert!(p.day_windows.contains(&dw(5, 8, 14, Some(0))));
        let p = parse("last sunday of may", NOW);
        assert!(p.day_windows.contains(&dw(5, 25, 31, Some(0))));

        // "in N units", "day after tomorrow", "week of <date>".
        let day0 = NOW - NOW % 86400;
        let p = parse("in 3 days", NOW);
        assert_eq!(p.ranges, vec![(day0 + 3 * 86400, day0 + 4 * 86400)]);
        let p = parse("day after tomorrow", NOW);
        assert_eq!(p.ranges, vec![(day0 + 2 * 86400, day0 + 3 * 86400)]);
        let p = parse("week of march 3", NOW);
        let mar3 = days_from_civil(2026, 3, 3) * 86400; // most recent Mar 3
        assert_eq!(p.ranges.len(), 1);
        assert_eq!(p.ranges[0].1 - p.ranges[0].0, 7 * 86400);
        assert!(p.ranges[0].0 <= mar3 && mar3 < p.ranges[0].1);
    }

    #[test]
    fn combinations() {
        let day0 = NOW - NOW % 86400;
        // Unit nouns alone carry no signal — "every month" adds nothing.
        let p = parse("the 19th of every month", NOW);
        assert_eq!(p.days.iter().copied().collect::<Vec<_>>(), vec![19]);
        assert!(p.like_terms.is_empty());

        // "and" between two ranges means union — no photo can be in both,
        // so an intersection would always be empty.
        let p = parse("videos last week and this week", NOW);
        assert!(p.ranges.is_empty());
        assert_eq!(p.any_ranges.len(), 1); // contiguous, merged
        assert_eq!(p.any_ranges[0].1 - p.any_ranges[0].0, 14 * 86400);
        let p = parse("yesterday and today", NOW);
        assert_eq!(p.any_ranges, vec![(day0 - 86400, day0 + 86400)]);

        // Compound queries AND across predicate kinds.
        let p = parse("videos from last summer in portland", NOW);
        assert_eq!(p.kind, Some("video"));
        assert!(p.months.contains(&6) && p.months.contains(&8));
        assert_eq!(p.places.len(), 1);
        assert!(p.like_terms.is_empty());
        let p = parse("saturdays in may 2024", NOW);
        assert!(p.weekdays.contains(&6) && p.months.contains(&5) && p.years.contains(&2024));
        let p = parse("sep 19 evening landscape", NOW);
        assert!(p.day_windows.contains(&dw(9, 19, 19, None)));
        assert_eq!(p.hours, vec![(17, 20)]);
        assert_eq!(p.orientation, Some("landscape"));
        let p = parse("no flash christmas photos", NOW);
        assert_eq!(p.flash, Some(0));
        assert_eq!(p.kind, Some("image"));
        // Multiple places resolve to one OR'd group (SQL side unions them).
        let p = parse("paris london", NOW);
        assert_eq!(p.places.len(), 2);
        assert!(p.like_terms.is_empty());
    }

    #[test]
    fn negation_and_state_words() {
        let p = parse("no location", NOW);
        assert!(p.no_gps);
        let p = parse("favorites", NOW);
        assert!(p.favorites_only);
    }

    #[test]
    fn civil_round_trip() {
        let (y, m, d, _, _) = civil_from_unix(86400);
        assert_eq!((y, m, d), (1970, 1, 2));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(
            days_from_civil(2020, 2, 29) - days_from_civil(2020, 2, 28),
            1
        );
    }
}
