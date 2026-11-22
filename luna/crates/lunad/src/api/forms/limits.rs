//! Rate-limit budgets, bucket keys, and upload quota for public form links.
//!
//! A respond link is open to anyone with the URL, so every request through it
//! is limited without asking anyone to sign in. The budgets here are sized
//! from the box Luna runs on: a 2 GiB thin client still takes a classroom's
//! answers, while a bigger box gets a little more headroom. They are guard
//! rails against a flood, not a throughput target.
//!
//! Storage is limited separately, per form, so one shared form cannot fill a
//! drive. Answers and attachments share the form's allowance; the drive keeps
//! a free-space reserve so filling a form can never starve the rest of Luna.
//!
//! This lives beside the form handlers but is included from `api/mod.rs`
//! while `forms` is a single file, so the policy is compiled and tested on its
//! own even as the handlers are rewritten.

use std::sync::Arc;

/// One mebibyte, for readable budget arithmetic.
const MIB: u64 = 1024 * 1024;

/// Free space Luna keeps back on a drive. A form upload is refused before it
/// would eat into this, so answers and attachments can never fill the disk
/// that holds the operating system, the index, and Luna's own database.
pub const MIN_FREE_BYTES: u64 = 256 * MIB;

/// The most one form may keep, answers and attachments together. Generous for
/// a year of a household form; small enough to matter on a 32 GiB stick.
pub const MAX_FORM_QUOTA_BYTES: u64 = 512 * MIB;

/// The smallest allowance a form gets, so a small drive still accepts real
/// answers and a few photos. `form_quota_bytes` never gives a form more than
/// half of the drive, so this floor cannot claim a tiny drive whole.
pub const MIN_FORM_QUOTA_BYTES: u64 = 48 * MIB;

/// Floor and ceiling for the per-form submission budget.
const SUBMIT_FLOOR: u64 = 30;
const SUBMIT_CEILING: u64 = 240;

/// Answers one form takes per minute from every address together.
///
/// Derived from the box: 15 per usable core plus 10 per 256 MiB of available
/// memory, clamped to 30–240. A 4-core box with 512 MiB free lands at 80 — a
/// class of 30 answering at once, with room for retries and edit re-sends.
pub fn submit_per_minute() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    submit_per_minute_from(cores, crate::budget::meminfo().available_bytes)
}

/// The pure form of [`submit_per_minute`], for tests and odd hosts.
pub fn submit_per_minute_from(cores: usize, available_bytes: u64) -> usize {
    let cores = cores.clamp(1, 16) as u64;
    let ram_units = (available_bytes / (256 * MIB)).clamp(1, 32);
    let budget = cores * 15 + ram_units * 10;
    budget.clamp(SUBMIT_FLOOR, SUBMIT_CEILING) as usize
}

/// Upload requests one form accepts per minute, from every address together.
/// Each answer may carry a few files, so this is three times the submission
/// budget; a form with several file questions still has room when a class
/// answers at once.
pub fn form_upload_per_minute() -> usize {
    (submit_per_minute() * 3).clamp(60, 360)
}

/// Upload requests one address may start per minute, across every form. One
/// person sending a form with several photos stays far below this; a whole
/// class behind one router also fits, while a script cannot upload nonstop.
pub fn form_upload_ip_per_minute() -> usize {
    (submit_per_minute() * 2).clamp(60, 240)
}

/// Response-list reads one signed-in manager may make per minute. The manager
/// view is opened by hand, so this only stops a refresh loop or a script from
/// re-reading every answers segment continuously.
pub fn response_reads_per_user_per_minute() -> usize {
    (submit_per_minute() / 2).clamp(30, 120)
}

/// Public `/s/` requests one address may make per minute: opening a form,
/// loading its pictures, the small API calls around them, and the chunks of a
/// guest upload. Ten requests a second still fits a page with dozens of images
/// and a fast upload of 8–16 MiB chunks, while a scraper runs out.
pub fn public_asset_requests_per_minute() -> usize {
    (submit_per_minute() * 8).clamp(600, 1200)
}

/// Public `/s/` requests through one link per minute, from every address
/// together. Higher than one address's budget because a whole class shares a
/// link, but still bounded so one leaked or guessed link cannot drive Luna at
/// full speed.
pub fn public_link_requests_per_minute() -> usize {
    (public_asset_requests_per_minute() * 6).clamp(2400, 7200)
}

/// The space one form may use on a drive of `total_bytes`. A tenth of the
/// drive, floored at [`MIN_FORM_QUOTA_BYTES`], capped at
/// [`MAX_FORM_QUOTA_BYTES`], and never more than half the drive.
pub fn form_quota_bytes(total_bytes: u64) -> u64 {
    (total_bytes / 10)
        .clamp(MIN_FORM_QUOTA_BYTES, MAX_FORM_QUOTA_BYTES)
        .min(total_bytes / 2)
}

/// Why a file cannot be added to a form. Each kind says what the person can do
/// next; the handlers turn it into an HTTP refusal and the message stays plain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaError {
    /// The file alone is bigger than the form's whole allowance.
    FileTooLarge,
    /// The form has used its allowance.
    FormFull,
    /// The drive would drop below Luna's free-space reserve.
    DriveLow,
}

impl QuotaError {
    /// The sentence a respondent sees. Two clauses at most, and each names the
    /// action that failed and what to try.
    pub fn message(self) -> &'static str {
        match self {
            Self::FileTooLarge => "This file is too big for this form. Try a smaller one.",
            Self::FormFull => {
                "This form has all the files and answers it can keep. Ask the person who shared it to delete some."
            }
            Self::DriveLow => {
                "This drive is almost full. Free up some space on it, then try again."
            }
        }
    }
}

impl std::fmt::Display for QuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for QuotaError {}

/// Can `incoming` more bytes join a form?
///
/// `used` is what the form already keeps, `total` its allowance from
/// [`form_quota_bytes`], and `free` the drive's free bytes right now. The
/// checks run from the most specific refusal to the widest: a single oversized
/// file, then the form's own allowance, then the drive's reserve.
pub fn room_for_upload(used: u64, incoming: u64, total: u64, free: u64) -> Result<(), QuotaError> {
    if incoming > total {
        return Err(QuotaError::FileTooLarge);
    }
    if used.saturating_add(incoming) > total {
        return Err(QuotaError::FormFull);
    }
    if free < MIN_FREE_BYTES || incoming > free - MIN_FREE_BYTES {
        return Err(QuotaError::DriveLow);
    }
    Ok(())
}

/// Bucket key for one form's upload budget. Drive and path are hashed: the
/// table never learns where a form lives, and two forms with the same file
/// name on different drives stay apart.
pub fn form_upload_key(drive_id: &str, path: &str) -> String {
    format!(
        "form_upload:{}",
        blake3::hash(format!("{drive_id}\n{path}").as_bytes()).to_hex()
    )
}

/// Bucket key for one address's upload budget, across all forms. IPv6 clients
/// are bucketed by /64.
pub fn form_upload_ip_key(ip: &str) -> String {
    crate::rate_limit::ip_key("form_upload_ip", ip)
}

/// Bucket key for one manager's response-read budget.
pub fn response_read_key(user_id: &str) -> String {
    crate::rate_limit::secret_key("form_response_read", user_id)
}

/// Bucket key for one address's public `/s/` request budget.
pub fn public_asset_ip_key(ip: &str) -> String {
    crate::rate_limit::ip_key("public_asset_ip", ip)
}

/// Bucket key for one link's public `/s/` request budget. The token is hashed.
pub fn public_link_key(token: &str) -> String {
    crate::rate_limit::secret_key("public_asset_link", token)
}

/// Drop rate-limit buckets past [`crate::db::RATE_LIMIT_BUCKET_MAX_AGE_SECS`].
/// Returns how many rows went. Best-effort: a locked database or a failed
/// delete never stops the caller, because expired buckets are only clutter.
pub fn prune_rate_limits(db: &crate::Db) -> usize {
    let Ok(conn) = db.lock() else {
        return 0;
    };
    crate::db::trim_rate_limit_buckets(&conn)
        .inspect_err(|e| tracing::warn!(error = %e, "could not prune rate-limit buckets"))
        .unwrap_or(0)
}

/// A [`RateLimiter`](crate::rate_limit::RateLimiter) over the current database
/// for one of the budgets above. `AppState` builds its limiters with this so
/// every window is one minute.
pub fn limiter(db: Arc<crate::Db>, max: usize) -> crate::rate_limit::RateLimiter {
    crate::rate_limit::RateLimiter::new(db, std::time::Duration::from_secs(60), max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_budget_has_a_floor_for_the_smallest_box() {
        assert_eq!(submit_per_minute_from(0, 0), SUBMIT_FLOOR as usize);
        assert_eq!(submit_per_minute_from(1, 64 * MIB), SUBMIT_FLOOR as usize);
    }

    #[test]
    fn submit_budget_grows_with_cores_and_memory_then_stops() {
        assert!(submit_per_minute_from(8, 256 * MIB) > submit_per_minute_from(2, 256 * MIB));
        assert!(submit_per_minute_from(2, 2 * 1024 * MIB) > submit_per_minute_from(2, 256 * MIB));
        // The documented thin-client example: 4 cores and 512 MiB free.
        assert_eq!(submit_per_minute_from(4, 512 * MIB), 80);
        let big = submit_per_minute_from(64, 128 * 1024 * MIB);
        assert_eq!(big, SUBMIT_CEILING as usize);
        let mid = submit_per_minute_from(4, 512 * MIB);
        assert!((SUBMIT_FLOOR as usize..=SUBMIT_CEILING as usize).contains(&mid));
    }

    #[test]
    fn live_submit_budget_is_inside_its_bounds() {
        let n = submit_per_minute();
        assert!(
            (SUBMIT_FLOOR as usize..=SUBMIT_CEILING as usize).contains(&n),
            "{n}"
        );
    }

    #[test]
    fn derived_budgets_stay_in_a_sane_order() {
        let submit = submit_per_minute();
        assert!(form_upload_per_minute() >= submit);
        assert!(form_upload_ip_per_minute() >= submit);
        assert!(response_reads_per_user_per_minute() <= submit);
        assert!(public_asset_requests_per_minute() >= submit);
        assert!(public_link_requests_per_minute() >= public_asset_requests_per_minute());
    }

    #[test]
    fn one_form_spending_its_upload_budget_leaves_other_budgets_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(crate::Db::new(
            crate::db::open(&dir.path().join("luna.db")).unwrap(),
        ));
        let form_budget = limiter(db.clone(), 2);
        let address_budget = limiter(db.clone(), 3);
        let rsvp = form_upload_key("photos", "rsvp.lunaform");
        assert!(form_budget.allow(&rsvp));
        assert!(form_budget.allow(&rsvp));
        assert!(!form_budget.allow(&rsvp), "the form's budget is spent");
        // Another form, and the address's cross-form budget, are untouched.
        assert!(form_budget.allow(&form_upload_key("photos", "potluck.lunaform")));
        let address = form_upload_ip_key("203.0.113.9");
        for _ in 0..3 {
            assert!(address_budget.allow(&address));
        }
        assert!(!address_budget.allow(&address));
    }

    #[test]
    fn quota_is_a_tenth_with_a_floor_and_a_ceiling() {
        assert_eq!(form_quota_bytes(32 * 1024 * MIB), MAX_FORM_QUOTA_BYTES);
        assert_eq!(form_quota_bytes(4 * 1024 * MIB), 4 * 1024 * MIB / 10);
        assert_eq!(form_quota_bytes(256 * MIB), MIN_FORM_QUOTA_BYTES);
        assert_eq!(form_quota_bytes(0), 0);
        // A tiny drive keeps half its space for everything that is not a form.
        assert_eq!(form_quota_bytes(8 * MIB), 4 * MIB);
        for total in [
            0,
            8 * MIB,
            256 * MIB,
            4 * 1024 * MIB,
            32 * 1024 * MIB,
            1024 * 1024 * MIB,
        ] {
            assert!(form_quota_bytes(total) <= total / 2 || form_quota_bytes(total) == 0);
        }
    }

    #[test]
    fn upload_needs_room_in_the_form_and_above_the_reserve() {
        let total = form_quota_bytes(4 * 1024 * MIB);
        let plenty_free = 10 * 1024 * MIB;
        assert_eq!(room_for_upload(100, 50, total, plenty_free), Ok(()));
        assert_eq!(
            room_for_upload(0, total + 1, total, plenty_free),
            Err(QuotaError::FileTooLarge)
        );
        assert_eq!(
            room_for_upload(total - 10, 11, total, plenty_free),
            Err(QuotaError::FormFull)
        );
    }

    #[test]
    fn drive_reserve_is_kept_back() {
        let total = form_quota_bytes(4 * 1024 * MIB);
        let just_enough = MIN_FREE_BYTES + 10;
        assert_eq!(room_for_upload(0, 10, total, just_enough), Ok(()));
        assert_eq!(
            room_for_upload(0, 11, total, just_enough),
            Err(QuotaError::DriveLow)
        );
        assert_eq!(
            room_for_upload(0, 1, total, MIN_FREE_BYTES - 1),
            Err(QuotaError::DriveLow)
        );
    }

    #[test]
    fn quota_errors_say_what_to_do() {
        for error in [
            QuotaError::FileTooLarge,
            QuotaError::FormFull,
            QuotaError::DriveLow,
        ] {
            assert!(error.message().ends_with('.'), "{error}");
            assert!(!error.message().contains('/'), "{error}");
        }
    }

    #[test]
    fn form_and_address_keys_are_separate_and_hide_their_inputs() {
        let rsvp = form_upload_key("photos", "rsvp.lunaform");
        let potluck = form_upload_key("photos", "potluck.lunaform");
        assert_ne!(rsvp, potluck);
        assert!(!rsvp.contains("rsvp"), "{rsvp}");
        assert!(!rsvp.contains("photos"), "{rsvp}");
        assert_ne!(rsvp, form_upload_ip_key("203.0.113.9"));
        // Two forms with the same name on different drives are different forms.
        assert_ne!(
            form_upload_key("photos", "rsvp.lunaform"),
            form_upload_key("backup", "rsvp.lunaform")
        );
    }

    #[test]
    fn link_and_read_keys_hide_tokens_and_user_ids() {
        let link = public_link_key("s3cret-token");
        assert!(link.starts_with("public_asset_link:"), "{link}");
        assert!(!link.contains("s3cret-token"), "{link}");
        let user = response_read_key("user-1234");
        assert!(!user.contains("user-1234"), "{user}");
        assert!(!public_asset_ip_key("203.0.113.9").contains("203.0.113.9"));
    }

    #[test]
    fn prune_keeps_live_buckets_and_drops_only_stale_ones() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::Db::new(crate::db::open(&dir.path().join("luna.db")).unwrap());
        {
            let conn = db.lock().unwrap();
            crate::db::rate_limit_allow(&conn, "old", 60, 5).unwrap();
            crate::db::rate_limit_allow(&conn, "live", 60, 5).unwrap();
            let stale = crate::db::now_unix() - crate::db::RATE_LIMIT_BUCKET_MAX_AGE_SECS - 1;
            conn.execute(
                "UPDATE rate_limit_buckets SET window_start = ?1 WHERE key = 'old'",
                [stale],
            )
            .unwrap();
        }
        assert_eq!(prune_rate_limits(&db), 1);
        let conn = db.lock().unwrap();
        let left: i64 = conn
            .query_row("SELECT count(*) FROM rate_limit_buckets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 1);
    }
}
