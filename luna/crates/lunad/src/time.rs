//! Local wall-clock time, for the few places that need the box's own date or
//! hour (nightly scrub window, form close dates).

/// The broken-down local time for `unix` seconds, or `None` if the C library
/// can't convert it.
pub fn local_tm(unix: i64) -> Option<libc::tm> {
    let t = unix as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let p = unsafe { libc::localtime_r(&t, &mut tm) };
    if p.is_null() { None } else { Some(tm) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_a_known_instant() {
        // Noon UTC on 2001-09-09 is the 9th or 10th in every timezone.
        let tm = local_tm(1_000_000_000 + 12 * 3600).unwrap();
        assert_eq!(tm.tm_year + 1900, 2001);
        assert_eq!(tm.tm_mon, 8);
        assert!((9..=10).contains(&tm.tm_mday));
        assert!((0..24).contains(&tm.tm_hour));
    }
}
