//! EuroOffice save-download URL allowlist.
//!
//! Document Server posts a download URL to the public office callback. After
//! the usual localhost→configured-origin rewrite, only that origin may be
//! fetched — otherwise the token-gated callback is an open SSRF primitive.

/// Configured Document Server base URL (`LUNA_DOCUMENT_SERVER_URL`, default
/// `http://127.0.0.1:8088`), without a trailing slash.
pub(crate) fn document_server_origin() -> String {
    std::env::var("LUNA_DOCUMENT_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8088".into())
        .trim()
        .trim_end_matches('/')
        .to_string()
}

/// Map common Document Server localhost URLs onto [`document_server_origin`].
pub(crate) fn rewrite_document_server_url(raw: &str) -> String {
    let configured = document_server_origin();
    for prefix in [
        "http://localhost/",
        "https://localhost/",
        "http://127.0.0.1/",
        "https://127.0.0.1/",
        "http://localhost:80/",
        "http://127.0.0.1:80/",
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return format!("{configured}/{rest}");
        }
    }
    if let Some(rest) = raw.strip_prefix("http://localhost:8088/") {
        return format!("{configured}/{rest}");
    }
    raw.to_string()
}

/// After localhost rewrite, only fetch save bodies from the configured Document
/// Server origin. The public callback is token-gated, but the token is also
/// embedded in `document_url` / `callback_url` returned to the browser — so the
/// download URL must not be an open SSRF primitive.
pub(crate) fn allowed_office_save_url(raw: &str) -> Result<String, &'static str> {
    let rewritten = rewrite_document_server_url(raw.trim());
    let Ok(candidate) = rewritten.parse::<axum::http::Uri>() else {
        return Err("unparseable save URL");
    };
    if !matches!(candidate.scheme_str(), Some("http") | Some("https")) {
        return Err("save URL scheme must be http or https");
    }
    let Some(cand_auth) = candidate.authority() else {
        return Err("save URL missing host");
    };
    // Reject userinfo (`http://user@host/...`) — Document Server never needs it,
    // and authority string compares would otherwise miss the credential part.
    if cand_auth.as_str().contains('@') {
        return Err("save URL must not include userinfo");
    }
    let allowed_origin = document_server_origin();
    let Ok(allowed) = allowed_origin.parse::<axum::http::Uri>() else {
        return Err("configured Document Server origin is invalid");
    };
    let Some(allowed_auth) = allowed.authority() else {
        return Err("configured Document Server origin missing host");
    };
    if candidate.scheme_str() != allowed.scheme_str() {
        return Err("save URL scheme does not match Document Server");
    }
    if !cand_auth.as_str().eq_ignore_ascii_case(allowed_auth.as_str()) {
        return Err("save URL host is outside Document Server");
    }
    let path = candidate.path();
    if path.is_empty() || path == "/" {
        return Err("save URL path is empty");
    }
    Ok(rewritten)
}

/// Validate + fetch a Document Server save body (no redirects).
pub(crate) fn download_office_save(raw_url: &str) -> Result<Vec<u8>, String> {
    let download_url = allowed_office_save_url(raw_url).map_err(|e| e.to_string())?;
    let mut response = ureq::get(&download_url)
        .config()
        .max_redirects(0)
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .build()
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    response
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("read failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_maps_localhost_to_host_ds() {
        let got = rewrite_document_server_url("http://localhost/cache/files/abc/output.xlsx");
        assert_eq!(got, "http://127.0.0.1:8088/cache/files/abc/output.xlsx");
    }

    #[test]
    fn allowed_office_save_url_accepts_rewritten_localhost() {
        let got = allowed_office_save_url("http://localhost/cache/files/abc/output.xlsx")
            .expect("localhost rewrite should be allowed");
        assert_eq!(got, "http://127.0.0.1:8088/cache/files/abc/output.xlsx");
    }

    #[test]
    fn allowed_office_save_url_accepts_configured_origin() {
        let got = allowed_office_save_url("http://127.0.0.1:8088/cache/files/doc.docx?md5=abc")
            .expect("configured DS origin should be allowed");
        assert!(got.starts_with("http://127.0.0.1:8088/"));
    }

    #[test]
    fn allowed_office_save_url_rejects_foreign_hosts() {
        for raw in [
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/secret",
            "https://evil.example/payload",
            "http://127.0.0.1:8088@evil.example/x",
            "file:///etc/passwd",
            "http://127.0.0.1:8088/",
        ] {
            assert!(
                allowed_office_save_url(raw).is_err(),
                "expected reject for {raw}"
            );
        }
    }
}
