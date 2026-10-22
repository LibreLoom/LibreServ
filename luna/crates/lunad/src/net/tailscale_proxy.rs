//! A separate loopback listener identifies Tailscale traffic by its route into
//! lunad, never by a header that a Connect visitor could supply.
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::IpAddr;
use std::path::Path;

#[derive(Clone, Copy)]
pub(crate) struct TailscalePeer;

/// Preserve the port across lunad restarts because Serve stores its target.
/// Failure to reserve that port must not redirect an existing public listener
/// to a different process.
pub async fn bind(data_dir: &Path) -> std::io::Result<tokio::net::TcpListener> {
    let path = data_dir.join("tailscale-proxy-port");
    let port = match std::fs::read_to_string(&path) {
        Ok(value) => value.trim().parse::<u16>().map_err(std::io::Error::other)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e),
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    std::fs::write(path, listener.local_addr()?.port().to_string())?;
    Ok(listener)
}

fn sanitize(headers: &mut HeaderMap) -> Option<()> {
    // The pinned Serve proxy replaces X-Forwarded-For with exactly one source
    // address. Never turn a malformed or absent address into loopback trust.
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

pub async fn boundary(mut request: Request, next: Next) -> Response {
    if sanitize(request.headers_mut()).is_none() {
        return (
            StatusCode::BAD_GATEWAY,
            "Tailscale did not provide a valid client address.",
        )
            .into_response();
    }
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
    async fn loopback_port_is_persistent() {
        let dir = tempfile::tempdir().unwrap();
        let listener = bind(dir.path()).await.unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        drop(listener);
        assert_eq!(bind(dir.path()).await.unwrap().local_addr().unwrap(), addr);
    }
}
