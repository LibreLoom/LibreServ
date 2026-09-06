//! Normalize user-typed Luna addresses into a canonical base URL (origin).
//!
//! Rules (also mirrored in Luna Mobile `LunaUrl.kt`):
//! 1. Trim leading/trailing whitespace; collapse internal whitespace from messy pastes.
//! 2. Repair common scheme typos (`HTTP://`, `http:/`, `https//`, `http:host`, …).
//! 3. If no scheme: use `http` for localhost / loopback / private LAN / `.local` (and
//!    `.lan` / `.home`); use `https` for public hosts.
//! 4. Lowercase the host; keep an explicit port when present.
//! 5. Drop path, query, and fragment — companions talk to the Luna origin only.
//! 6. No trailing slash.

/// Hint shown in the empty Luna address field (desktop + mobile).
pub const LUNA_ADDRESS_PLACEHOLDER: &str = "kitchen.luna.servers.libreloom.org";

/// Turn messy user input into `scheme://host[:port]` or an empty string if blank.
pub fn normalize_luna_base_url(raw: &str) -> Result<String, String> {
    let collapsed = collapse_whitespace(raw);
    if collapsed.is_empty() {
        return Err(empty_address_message());
    }

    let (scheme, after_scheme) = take_scheme(&collapsed);
    let authority = authority_only(&after_scheme);
    if authority.is_empty() {
        return Err(bad_address_message());
    }

    let (host_raw, port) = split_host_port(&authority)?;
    let host = normalize_host(&host_raw);
    if host.is_empty() {
        return Err(bad_address_message());
    }

    let scheme = match scheme {
        Some(s) => s,
        None => default_scheme_for_host(&host),
    };

    let mut out = format!("{scheme}://{host}");
    if let Some(p) = port {
        out.push(':');
        out.push_str(&p);
    }
    Ok(out)
}

pub fn empty_address_message() -> String {
    format!("Enter your Luna address (for example {LUNA_ADDRESS_PLACEHOLDER}).")
}

fn bad_address_message() -> String {
    format!(
        "That Luna address does not look right. Try something like {LUNA_ADDRESS_PLACEHOLDER}."
    )
}

fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join("")
}

/// Returns `(scheme, rest_after_://)` when a scheme is present or repaired.
fn take_scheme(input: &str) -> (Option<&'static str>, String) {
    let lower = input.to_ascii_lowercase();

    // http(s) with optional colon and 0–3 slashes, or "http:host" / "https:host".
    for (name, const_scheme) in [("https", "https"), ("http", "http")] {
        if let Some(rest) = lower.strip_prefix(name) {
            let original_rest = &input[name.len()..];
            // Accept: "://", "//", ":/", ":/", ":", "/","", with optional extra slashes.
            let mut i = 0;
            let bytes = rest.as_bytes();
            let mut saw_colon = false;
            let mut slash_count = 0u8;
            if bytes.first() == Some(&b':') {
                saw_colon = true;
                i = 1;
            }
            while i < bytes.len() && bytes[i] == b'/' {
                slash_count = slash_count.saturating_add(1);
                i += 1;
            }
            // Only treat as a scheme if we saw a colon and/or slashes, or the
            // remainder looks like an authority (not a bare hostname starting
            // with "http" — already matched prefix).
            // "http://…", "http:/…", "http//…", "http:host", "https/host"
            if saw_colon || slash_count > 0 {
                let rest_orig = &original_rest[i..];
                return (Some(const_scheme), rest_orig.to_string());
            }
        }
    }

    (None, input.to_string())
}

fn authority_only(after_scheme: &str) -> String {
    let mut s = after_scheme;
    // Extra leading slashes after a broken scheme repair.
    while s.starts_with('/') {
        s = &s[1..];
    }
    let end = s
        .find(['/', '?', '#'])
        .unwrap_or(s.len());
    s[..end].to_string()
}

fn split_host_port(authority: &str) -> Result<(String, Option<String>), String> {
    // userinfo@host — rare; drop userinfo if pasted.
    let auth = match authority.rsplit_once('@') {
        Some((_, hostport)) => hostport,
        None => authority,
    };

    if auth.starts_with('[') {
        let close = auth
            .find(']')
            .ok_or_else(bad_address_message)?;
        let host = auth[..=close].to_string();
        let rest = &auth[close + 1..];
        if rest.is_empty() {
            return Ok((host, None));
        }
        if let Some(port) = rest.strip_prefix(':') {
            return Ok((host, Some(validate_port(port)?)));
        }
        return Err(bad_address_message());
    }

    // hostname:port or IPv4:port — only one colon for non-IPv6.
    if let Some((host, port)) = auth.rsplit_once(':') {
        // Bare IPv6 without brackets is ambiguous; reject.
        if host.contains(':') {
            return Err(bad_address_message());
        }
        if port.is_empty() {
            return Err(bad_address_message());
        }
        // Distinguish "host:port" from accidental "host:" — already empty-checked.
        // If port is non-numeric, treat whole thing as host (e.g. unlikely).
        if port.chars().all(|c| c.is_ascii_digit()) {
            return Ok((host.to_string(), Some(validate_port(port)?)));
        }
    }

    Ok((auth.to_string(), None))
}

fn validate_port(port: &str) -> Result<String, String> {
    let n: u32 = port.parse().map_err(|_| bad_address_message())?;
    if (1..=65535).contains(&n) {
        Ok(port.to_string())
    } else {
        Err(bad_address_message())
    }
}

fn normalize_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.starts_with('[') {
        let inner = trimmed
            .trim_matches(|c| c == '[' || c == ']')
            .to_ascii_lowercase();
        if inner.is_empty() {
            return String::new();
        }
        format!("[{inner}]")
    } else {
        let h = trimmed.to_ascii_lowercase();
        // Reject leftovers like ":" from ":///" after authority parsing.
        if h.is_empty() || h == ":" || !h.chars().any(|c| c.is_ascii_alphanumeric()) {
            return String::new();
        }
        h
    }
}

fn default_scheme_for_host(host: &str) -> &'static str {
    let bare = host.trim_matches(|c| c == '[' || c == ']');
    if allows_cleartext(bare) {
        "http"
    } else {
        "https"
    }
}

/// Match Luna Mobile `PrivateLan.allowsCleartext` — LAN / loopback may use HTTP.
fn allows_cleartext(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if h == "localhost" || h == "::1" || h.ends_with(".local") || h.ends_with(".lan") || h.ends_with(".home")
    {
        return true;
    }
    let parts: Vec<_> = h.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let nums: Option<Vec<u8>> = parts.iter().map(|p| p.parse().ok()).collect();
    let Some(n) = nums else {
        return false;
    };
    let (a, b, _c, _d) = (n[0], n[1], n[2], n[3]);
    if a == 10 || a == 127 {
        return true;
    }
    if a == 169 && b == 254 {
        return true;
    }
    if a == 192 && b == 168 {
        return true;
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> String {
        normalize_luna_base_url(raw).expect(raw)
    }

    #[test]
    fn placeholder_constant() {
        assert_eq!(
            LUNA_ADDRESS_PLACEHOLDER,
            "kitchen.luna.servers.libreloom.org"
        );
    }

    #[test]
    fn empty_and_whitespace() {
        assert!(normalize_luna_base_url("").is_err());
        assert!(normalize_luna_base_url("   ").is_err());
        assert!(normalize_luna_base_url("\t\n").is_err());
    }

    #[test]
    fn trims_and_strips_path_query_fragment() {
        assert_eq!(
            ok("  https://Kitchen.luna.servers.libreloom.org/setup?x=1#y  "),
            "https://kitchen.luna.servers.libreloom.org"
        );
        assert_eq!(
            ok("http://luna.local/"),
            "http://luna.local"
        );
        assert_eq!(
            ok("http://luna.local///files/"),
            "http://luna.local"
        );
    }

    #[test]
    fn adds_https_for_public_hosts() {
        assert_eq!(
            ok("kitchen.luna.servers.libreloom.org"),
            "https://kitchen.luna.servers.libreloom.org"
        );
        assert_eq!(
            ok("KITCHEN.LUNA.SERVERS.LIBRELOOM.ORG"),
            "https://kitchen.luna.servers.libreloom.org"
        );
    }

    #[test]
    fn adds_http_for_lan_and_loopback() {
        assert_eq!(ok("localhost"), "http://localhost");
        assert_eq!(ok("localhost:8090"), "http://localhost:8090");
        assert_eq!(ok("127.0.0.1"), "http://127.0.0.1");
        assert_eq!(ok("127.0.0.1:8090"), "http://127.0.0.1:8090");
        assert_eq!(ok("luna.local"), "http://luna.local");
        assert_eq!(ok("192.168.1.20:8090"), "http://192.168.1.20:8090");
        assert_eq!(ok("10.0.0.5"), "http://10.0.0.5");
        assert_eq!(ok("172.16.0.2"), "http://172.16.0.2");
        assert_eq!(ok("nas.lan"), "http://nas.lan");
    }

    #[test]
    fn keeps_explicit_scheme() {
        assert_eq!(
            ok("http://kitchen.luna.servers.libreloom.org"),
            "http://kitchen.luna.servers.libreloom.org"
        );
        assert_eq!(
            ok("https://192.168.1.20:8090"),
            "https://192.168.1.20:8090"
        );
    }

    #[test]
    fn repairs_scheme_typos() {
        assert_eq!(ok("HTTP://Luna.Local"), "http://luna.local");
        assert_eq!(ok("http:/luna.local"), "http://luna.local");
        assert_eq!(ok("https:/kitchen.luna.servers.libreloom.org"), "https://kitchen.luna.servers.libreloom.org");
        assert_eq!(ok("http//127.0.0.1:8090"), "http://127.0.0.1:8090");
        assert_eq!(ok("https//kitchen.luna.servers.libreloom.org"), "https://kitchen.luna.servers.libreloom.org");
        assert_eq!(ok("http:192.168.1.20:8090"), "http://192.168.1.20:8090");
        assert_eq!(ok("https:kitchen.luna.servers.libreloom.org"), "https://kitchen.luna.servers.libreloom.org");
    }

    #[test]
    fn collapses_spaces_in_paste() {
        assert_eq!(
            ok("https:// kitchen.luna.servers.libreloom.org "),
            "https://kitchen.luna.servers.libreloom.org"
        );
        assert_eq!(
            ok("kitchen . luna . servers . libreloom . org"),
            "https://kitchen.luna.servers.libreloom.org"
        );
    }

    #[test]
    fn ipv6_loopback() {
        assert_eq!(ok("[::1]"), "http://[::1]");
        assert_eq!(ok("[::1]:8090"), "http://[::1]:8090");
        assert_eq!(ok("http://[::1]:8090/"), "http://[::1]:8090");
    }

    #[test]
    fn public_ip_defaults_to_https() {
        assert_eq!(ok("8.8.8.8"), "https://8.8.8.8");
    }

    #[test]
    fn rejects_garbage() {
        assert!(normalize_luna_base_url(":///").is_err());
        assert!(normalize_luna_base_url("http://").is_err());
        assert!(normalize_luna_base_url("http://host:99999").is_err());
    }
}
