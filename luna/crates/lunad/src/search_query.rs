//! Query parsing for the gallery `q` parameter.
//!
//! The free-text box doubles as a light structured query: tokens that look
//! like dates ("september", "fall", "2023", "last week", "christmas",
//! "weekend"), places ("seattle", "oregon", "thailand"), media words
//! ("videos", "heic", "landscape", "flash"), or library state ("favorites",
//! "archived", "no location") become filter clauses; everything left over
//! stays a substring match on name/path/camera/lens/place/album.
//!
//! All predicates are evaluated in SQL or the existing post-filters — no
//! extra indexing work per query.

use std::collections::BTreeSet;

use crate::places;

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
    /// `[lo, hi)` epoch ranges on the effective capture time.
    pub ranges: Vec<(i64, i64)>,
    /// Inclusive UTC hour ranges; `lo > hi` wraps past midnight.
    pub hours: Vec<(u32, u32)>,
    pub kind: Option<&'static str>,
    pub formats: BTreeSet<String>,
    pub orientation: Option<&'static str>,
    pub flash: Option<i64>,
    pub favorites_only: bool,
    pub favorites_none: bool,
    pub archived_only: bool,
    pub archived_none: bool,
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
            && self.hours.is_empty()
            && self.kind.is_none()
            && self.formats.is_empty()
            && self.orientation.is_none()
            && self.flash.is_none()
            && !self.favorites_only
            && !self.favorites_none
            && !self.archived_only
            && !self.archived_none
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

/// Words that carry no signal on their own.
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
    "my",
    "mine",
    "our",
    "and",
    "to",
    "with",
    "by",
    "me",
    "photo",
    "photos",
    "photograph",
    "photographs",
    "picture",
    "pictures",
    "pic",
    "pics",
    "image",
    "images",
    "snap",
    "snaps",
    "shot",
    "shots",
    "media",
    "albums",
    "library",
    // Negators only matter as a prefix to a vocab word; alone they are
    // useless LIKE terms ("no flash" -> flash=0, not a %no% substring match).
    "no",
    "not",
    "without",
    "non",
];

/// Parse `q` against the bundled gazetteer and date vocabulary. `now` is the
/// current epoch second (UTC) for relative dates.
pub fn parse(q: &str, now: i64) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    let norm = places::normalize(q);
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
        // Negated when the previous token is a negator (negators never
        // resolve to places and are stop words).
        let negated = i > 0 && matches!(tokens[i - 1].as_str(), "no" | "without" | "not" | "non");
        if match_vocab_word(tok, negated, &mut out, now) {
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
    out
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
];

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

    match format!("{} {}", t(0), t(1)).as_str() {
        "golden hour" => {
            out.hours.push((17, 19));
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
            out.kind = Some("image");
            return Some(2);
        }
        "no photos" | "without photos" => {
            out.kind = Some("video");
            return Some(2);
        }
        _ => {}
    }

    // "last X" / "this X" / "past X" ranges.
    if matches!(t(0), "last" | "past" | "previous" | "this") {
        let rel_last = matches!(t(0), "last" | "past" | "previous");
        match t(1) {
            "week" => {
                let monday0 = day0 - ((dow + 6) % 7) as i64 * 86400;
                let (lo, hi) = if rel_last {
                    (monday0 - 7 * 86400, monday0)
                } else {
                    (monday0, monday0 + 7 * 86400)
                };
                out.ranges.push((lo, hi));
                return Some(2);
            }
            "weekend" => {
                // most recent Saturday..Monday
                let sat0 = day0 - ((dow + 1) % 7) as i64 * 86400;
                let (lo, hi) = if rel_last || dow < 6 {
                    (sat0 - 7 * 86400, sat0 - 5 * 86400)
                } else {
                    (sat0, sat0 + 2 * 86400)
                };
                out.ranges.push((lo, hi));
                return Some(2);
            }
            "month" => {
                let m0 = days_from_civil(y, mo, 1) * 86400;
                let (nm_y, nm_m) = if mo == 12 { (y + 1, 1) } else { (y, mo + 1) };
                let m1 = days_from_civil(nm_y, nm_m, 1) * 86400;
                let (py, pm) = if mo == 1 { (y - 1, 12) } else { (y, mo - 1) };
                let pm0 = days_from_civil(py, pm, 1) * 86400;
                let (lo, hi) = if rel_last { (pm0, m0) } else { (m0, m1) };
                out.ranges.push((lo, hi));
                return Some(2);
            }
            "year" => {
                let (lo, hi) = if rel_last {
                    (
                        days_from_civil(y - 1, 1, 1) * 86400,
                        days_from_civil(y, 1, 1) * 86400,
                    )
                } else {
                    (
                        days_from_civil(y, 1, 1) * 86400,
                        days_from_civil(y + 1, 1, 1) * 86400,
                    )
                };
                out.ranges.push((lo, hi));
                return Some(2);
            }
            "summer" | "winter" | "spring" | "fall" | "autumn" => {
                let months = SEASONS.iter().find(|(n, _)| *n == t(1)).map(|(_, m)| *m)?;
                out.months.extend(months.iter());
                // most recent (last) or current-year (this) season
                let end_month = *months.iter().max().unwrap();
                let year = if rel_last && mo <= end_month {
                    y - 1
                } else {
                    y
                };
                out.ranges.push((
                    days_from_civil(year, 1, 1) * 86400,
                    days_from_civil(year + 1, 1, 1) * 86400,
                ));
                return Some(2);
            }
            month_word => {
                if let Some(&m) = MONTHS
                    .iter()
                    .find(|(n, _)| *n == month_word)
                    .map(|(_, m)| m)
                {
                    out.months.insert(m);
                    let year = if rel_last && m >= mo { y - 1 } else { y };
                    out.ranges.push((
                        days_from_civil(year, 1, 1) * 86400,
                        days_from_civil(year + 1, 1, 1) * 86400,
                    ));
                    return Some(2);
                }
            }
        }
    }
    None
}

/// Single-token vocabulary. `negated` when preceded by no/without/not.
fn match_vocab_word(tok: &str, negated: bool, out: &mut ParsedQuery, now: i64) -> bool {
    if let Some(&m) = MONTHS.iter().find(|(n, _)| *n == tok).map(|(_, m)| m) {
        out.months.insert(m);
        return true;
    }
    if let Some(&(_, months)) = SEASONS.iter().find(|(n, _)| *n == tok) {
        out.months.extend(months.iter());
        return true;
    }
    if tok == "weekend" {
        out.weekdays.extend([0, 6]);
        return true;
    }
    if let Some(&d) = WEEKDAYS.iter().find(|(n, _)| *n == tok).map(|(_, d)| d) {
        out.weekdays.insert(d);
        return true;
    }
    if tok.len() == 4
        && tok.bytes().all(|b| b.is_ascii_digit())
        && let Ok(y) = tok.parse::<i32>()
        && (1970..=2100).contains(&y)
    {
        out.years.insert(y);
        return true;
    }
    match tok {
        "today" => {
            let day0 = now - (now % 86400);
            out.ranges.push((day0, day0 + 86400));
            true
        }
        "yesterday" => {
            let day0 = now - (now % 86400);
            out.ranges.push((day0 - 86400, day0));
            true
        }
        "video" | "videos" | "clip" | "clips" | "movie" | "movies" => {
            out.kind = Some(if negated { "image" } else { "video" });
            true
        }
        "landscape" | "portrait" | "square" => {
            out.orientation = Some(if tok == "landscape" {
                "landscape"
            } else if tok == "portrait" {
                "portrait"
            } else {
                "square"
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
        "archived" => {
            if negated {
                out.archived_none = true;
            } else {
                out.archived_only = true;
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
        "geotagged" | "located" => {
            if negated {
                out.no_gps = true;
            } else {
                out.has_gps = true;
            }
            true
        }
        "screenshot" | "screenshots" => {
            out.kind = Some("image");
            if out.like_terms.len() < MAX_TEXT_TERMS {
                out.like_terms.push("screenshot".into());
            }
            true
        }
        "morning" => {
            out.hours.push((5, 11));
            true
        }
        "sunrise" | "dawn" => {
            out.hours.push((5, 8));
            true
        }
        "midday" | "noon" => {
            out.hours.push((11, 14));
            true
        }
        "afternoon" => {
            out.hours.push((12, 16));
            true
        }
        "evening" | "dusk" => {
            out.hours.push((17, 20));
            true
        }
        "sunset" => {
            out.hours.push((17, 20));
            true
        }
        "night" => {
            out.hours.push((20, 4));
            true
        }
        "midnight" => {
            out.hours.push((23, 1));
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
            } else {
                false
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
    fn negation_and_state_words() {
        let p = parse("no location", NOW);
        assert!(p.no_gps);
        let p = parse("favorites", NOW);
        assert!(p.favorites_only);
        let p = parse("archived", NOW);
        assert!(p.archived_only);
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
