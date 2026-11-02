//! A separate loopback listener identifies Tailscale traffic by its route into
//! lunad, never by a header that a Connect visitor could supply.
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::IpAddr;

#[derive(Clone, Copy)]
pub(crate) struct TailscalePeer;

fn sanitize(headers: &mut HeaderMap) -> Option<()> {
    // Tailscale 1.104.2 Serve replaces X-Forwarded-For with one source IP.
    // Re-verify this through real Serve AND Funnel on every version bump:
    // shared/scripts/tailscale-verification.md. Mocks do not prove it.
    // Never turn a malformed or absent address into loopback trust.
    let source = headers
        .get("x-forwarded-for")?
        .to_str()
        .ok()?
        .parse::<IpAddr>()
        .ok()?;
    for name in [
        "cf-connecting-ip",
        "x-real-ip",
        "forwarded",
        "x-forwarded-host",
        "x-luna-tailscale",
    ] {
        headers.remove(name);
    }
    let source = HeaderValue::from_str(&source.to_string()).ok()?;
    headers.insert("cf-connecting-ip", source.clone());
    headers.insert("x-real-ip", source.clone());
    headers.insert("x-forwarded-for", source);
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    headers.insert("x-luna-tailscale", HeaderValue::from_static("1"));
    Some(())
}

pub async fn boundary(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let values = request.headers().get_all("x-forwarded-for");
    let hosts = request.headers().get_all("x-forwarded-host");
    if values.iter().count() != 1 || hosts.iter().count() != 1 {
        return (StatusCode::BAD_GATEWAY, "Invalid remote access request.").into_response();
    }
    let host = hosts
        .iter()
        .next()
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let expected = super::tailscale_socket::authority(&state.data_dir);
    if !expected
        .as_deref()
        .is_some_and(|v| host.eq_ignore_ascii_case(v))
    {
        return (StatusCode::BAD_GATEWAY, "Invalid remote access request.").into_response();
    }
    if sanitize(request.headers_mut()).is_none() {
        tracing::warn!(
            "Rejected a request on Tailscale's proxy listener without exactly one valid client address"
        );
        return (
            StatusCode::BAD_GATEWAY,
            "Tailscale did not provide a valid client address.",
        )
            .into_response();
    }
    let Ok(host) = HeaderValue::from_str(&host) else {
        return (StatusCode::BAD_GATEWAY, "Invalid remote access request.").into_response();
    };
    request.headers_mut().insert(axum::http::header::HOST, host);
    // The dedicated Unix ingress has no TCP peer. The auth guard uses this
    // synthetic peer only after the boundary has replaced forwarding headers.
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            0,
        ))));
    request.extensions_mut().insert(TailscalePeer);
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_spoofed_proxy_values_and_preserves_verified_client() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        h.insert("cf-connecting-ip", "192.168.1.2".parse().unwrap());
        h.insert("x-real-ip", "127.0.0.1".parse().unwrap());
        h.insert("forwarded", "for=127.0.0.1".parse().unwrap());
        sanitize(&mut h).unwrap();
        assert_eq!(h["cf-connecting-ip"], "203.0.113.7");
        assert_eq!(h["x-real-ip"], "203.0.113.7");
        assert_eq!(h["x-forwarded-proto"], "https");
        assert!(!h.contains_key("forwarded"));
    }

    #[test]
    fn rejects_missing_and_ambiguous_sources() {
        let mut h = HeaderMap::new();
        assert!(sanitize(&mut h).is_none());
        h.insert("x-forwarded-for", "10.0.0.1, 203.0.113.7".parse().unwrap());
        assert!(sanitize(&mut h).is_none());
    }

    #[tokio::test]
    async fn missing_saved_port_clears_old_target_before_restoring() {
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join("tailscale");
        std::fs::create_dir(&node).unwrap();
        std::fs::write(
            node.join("stop-verified"),
            std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .unwrap()
                .trim(),
        )
        .unwrap();
        std::fs::write(
            node.join("tailscaled.state"),
            r#"{"_machinekey":"a2V5","_serve/profile":"e30="}"#,
        )
        .unwrap();
        std::fs::write(node.join("enabled"), "1").unwrap();
        std::fs::write(node.join("serve-mode"), "private").unwrap();
        super::super::tailscale::prepare_proxy_move(dir.path()).unwrap();
        let state = std::fs::read_to_string(node.join("tailscaled.state")).unwrap();
        assert!(state.contains("_machinekey"));
        assert!(!state.contains("_serve/"));
        assert_eq!(
            std::fs::read_to_string(node.join("restore-serve")).unwrap(),
            "private"
        );
        assert!(node.join("enabled").exists());
    }
}
