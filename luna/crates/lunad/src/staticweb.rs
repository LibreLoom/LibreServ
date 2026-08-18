use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use include_dir::{Dir, include_dir};

static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

/// Serve the embedded Vite build with SPA fallback.
///
/// `/assets/*` files are immutable (hashed filenames) and cached for a year.
/// `index.html` and everything else is no-cache so updates are visible.
pub fn handle(path: &str) -> Response<Body> {
    let path = path.trim_start_matches('/');
    let asset = if path.is_empty() {
        DIST.get_file("index.html")
    } else {
        DIST.get_file(path)
    };
    let Some(file) = asset else {
        let Some(index) = DIST.get_file("index.html") else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(Body::from("Luna web app not built"))
                .unwrap();
        };
        return html(index);
    };

    let mime = if path.is_empty() {
        "text/html; charset=utf-8".to_string()
    } else {
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string()
    };
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::X_FRAME_OPTIONS, "DENY")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(file.contents()))
        .unwrap()
}

fn html(file: &'static include_dir::File<'static>) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::X_FRAME_OPTIONS, "DENY")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(file.contents()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    #[test]
    fn serves_index_at_root() {
        let res = super::handle("");
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        assert!(
            res.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
    }
}
