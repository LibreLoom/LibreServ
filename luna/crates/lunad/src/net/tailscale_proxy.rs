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
/// If it cannot be reused, turn off the old proxy before selecting a new port.
/// The file box must still boot when optional remote access needs repair.
pub async fn bind(data_dir: &Path) -> std::io::Result<tokio::net::TcpListener> {
    let path = data_dir.join("tailscale-proxy-port");
    let port = match std::fs::read_to_string(&path) {
        Ok(value) => value.trim().parse::<u16>().ok().filter(|p| *p != 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(0),
        Err(e) => {
            tracing::warn!(%e, "Could not read Tailscale's saved proxy port");
            None
        }
    };
    let listener = if let Some(port) = port {
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .ok()
    } else {
        None
    };
    let listener = match listener {
        Some(listener) => listener,
        None => {
            tracing::warn!(
                "Tailscale's saved proxy port is invalid or busy; turning off remote access before choosing a new port"
            );
            let data = data_dir.to_path_buf();
            tokio::task::spawn_blocking(move || super::tailscale::prepare_proxy_move(&data))
                .await
                .map_err(std::io::Error::other)?
                .map_err(std::io::Error::other)?;
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?
        }
    };
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
        tracing::warn!(
            "Rejected a request on Tailscale's proxy listener without exactly one valid client address"
        );
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

    #[tokio::test]
    async fn invalid_or_occupied_saved_ports_do_not_block_luna() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tailscale-proxy-port"), "broken").unwrap();
        let listener = bind(dir.path()).await.unwrap();
        let address = listener.local_addr().unwrap();
        let replacement = bind(dir.path()).await.unwrap();
        assert_ne!(replacement.local_addr().unwrap(), address);
        assert!(replacement.local_addr().unwrap().ip().is_loopback());
    }
}
