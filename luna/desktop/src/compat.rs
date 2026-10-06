//! Does this app work with the Luna it talks to?
//!
//! Luna reports its API on `GET /api/v1/health` as
//! `"api": {"version": n, "oldest_supported": n}`. Same rule as Luna Android
//! (`Compat.kt`): the app is written against one API version, [`CLIENT_API`].

use serde::Deserialize;

/// The Luna API version this app was written against. Defined once, here.
pub const CLIENT_API: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ApiInfo {
    pub version: u64,
    pub oldest_supported: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compat {
    Ok,
    LunaTooOld,
    AppTooOld,
}

/// A missing or unreadable `api` block means Luna predates the check.
pub fn check(api: Option<ApiInfo>, client_api: u64) -> Compat {
    match api {
        None => Compat::LunaTooOld,
        Some(a) if client_api > a.version => Compat::LunaTooOld,
        Some(a) if client_api < a.oldest_supported => Compat::AppTooOld,
        Some(_) => Compat::Ok,
    }
}

/// Reads `"api": {"version": n, "oldest_supported": n}` out of a health reply;
/// `None` if absent or malformed (both numbers must be whole and at least 1).
pub fn parse_api(health_body: &str) -> Option<ApiInfo> {
    let value: serde_json::Value = serde_json::from_str(health_body).ok()?;
    let api: ApiInfo = serde_json::from_value(value.get("api")?.clone()).ok()?;
    if api.version < 1 || api.oldest_supported < 1 {
        return None;
    }
    Some(api)
}

const LUNA_TOO_OLD: &str = "This Luna is too old for this app. Update Luna in Settings \u{2192} About \u{2192} System updates.";
const APP_TOO_OLD_LINUX: &str =
    "This app is too old for your Luna. Update Luna Desktop from your software center.";
const APP_TOO_OLD_OTHER: &str =
    "This app is too old for your Luna. Install the latest Luna Desktop.";

/// What to tell the person; `None` when everything is fine. `linux` picks the
/// way this platform updates (the software center there, a fresh install
/// elsewhere).
pub fn message_for(compat: Compat, linux: bool) -> Option<&'static str> {
    match compat {
        Compat::Ok => None,
        Compat::LunaTooOld => Some(LUNA_TOO_OLD),
        Compat::AppTooOld if linux => Some(APP_TOO_OLD_LINUX),
        Compat::AppTooOld => Some(APP_TOO_OLD_OTHER),
    }
}

/// [`message_for`] for the platform this build runs on.
pub fn message(compat: Compat) -> Option<&'static str> {
    message_for(compat, cfg!(all(unix, not(target_os = "macos"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(version: u64, oldest_supported: u64) -> Option<ApiInfo> {
        Some(ApiInfo {
            version,
            oldest_supported,
        })
    }

    #[test]
    fn current_pair_is_ok() {
        assert_eq!(check(api(1, 1), 1), Compat::Ok);
        assert_eq!(check(api(3, 1), 2), Compat::Ok);
        assert_eq!(check(api(3, 2), 3), Compat::Ok);
    }

    #[test]
    fn missing_api_means_luna_too_old() {
        assert_eq!(check(None, CLIENT_API), Compat::LunaTooOld);
    }

    #[test]
    fn newer_client_than_luna_means_luna_too_old() {
        assert_eq!(check(api(1, 1), 2), Compat::LunaTooOld);
    }

    #[test]
    fn client_below_oldest_supported_means_app_too_old() {
        assert_eq!(check(api(3, 2), 1), Compat::AppTooOld);
    }

    #[test]
    fn parses_the_health_reply() {
        let body = r#"{"status":"ok","api":{"version":1,"oldest_supported":1},"x":2}"#;
        assert_eq!(parse_api(body), api(1, 1));
    }

    #[test]
    fn rejects_missing_or_malformed_api() {
        assert_eq!(parse_api(r#"{"status":"ok"}"#), None);
        assert_eq!(parse_api("not json"), None);
        assert_eq!(parse_api(r#"{"api":null}"#), None);
        assert_eq!(parse_api(r#"{"api":{"version":1}}"#), None);
        assert_eq!(
            parse_api(r#"{"api":{"version":"1","oldest_supported":1}}"#),
            None
        );
        assert_eq!(
            parse_api(r#"{"api":{"version":1.5,"oldest_supported":1}}"#),
            None
        );
        assert_eq!(
            parse_api(r#"{"api":{"version":0,"oldest_supported":1}}"#),
            None
        );
        assert_eq!(
            parse_api(r#"{"api":{"version":1,"oldest_supported":-1}}"#),
            None
        );
    }

    #[test]
    fn messages_match_the_platform() {
        assert_eq!(message_for(Compat::Ok, true), None);
        assert_eq!(
            message_for(Compat::LunaTooOld, true),
            Some(
                "This Luna is too old for this app. Update Luna in Settings \u{2192} About \u{2192} System updates."
            )
        );
        assert_eq!(
            message_for(Compat::AppTooOld, true),
            Some(
                "This app is too old for your Luna. Update Luna Desktop from your software center."
            )
        );
        assert_eq!(
            message_for(Compat::AppTooOld, false),
            Some("This app is too old for your Luna. Install the latest Luna Desktop.")
        );
    }
}
