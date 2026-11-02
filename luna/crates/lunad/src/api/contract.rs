//! Test-only: records the JSON shape of every 2xx response that passes the auth guard, keyed by
//! "METHOD /route/{pattern}". With LUNA_CONTRACT_RECORD=1 (set by luna/ci.sh) it writes
//! luna/web/src/dev/contract/lunad-responses.json, which the web contract test compares the fake lunad against.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use serde_json::{Value, json};

const OUT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../web/src/dev/contract/lunad-responses.json"
);

/// The shape of one JSON value, merged over every sample seen.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Shape {
    /// "boolean" | "null" | "number" | "string"
    leaves: BTreeSet<&'static str>,
    /// bool = optional (missing from some sample)
    object: Option<BTreeMap<String, (Shape, bool)>>,
    /// Some(None) = only empty arrays seen
    array: Option<Option<Box<Shape>>>,
}

static RECORDED: OnceLock<Mutex<BTreeMap<String, Shape>>> = OnceLock::new();

fn recorded_map() -> std::sync::MutexGuard<'static, BTreeMap<String, Shape>> {
    RECORDED
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn shape_of(v: &Value) -> Shape {
    let mut s = Shape::default();
    match v {
        Value::Null => {
            s.leaves.insert("null");
        }
        Value::Bool(_) => {
            s.leaves.insert("boolean");
        }
        Value::Number(_) => {
            s.leaves.insert("number");
        }
        Value::String(_) => {
            s.leaves.insert("string");
        }
        Value::Object(map) => {
            s.object = Some(
                map.iter()
                    .map(|(k, c)| (k.clone(), (shape_of(c), false)))
                    .collect(),
            );
        }
        Value::Array(items) => {
            let elem = items.iter().fold(None::<Box<Shape>>, |acc, item| {
                let sh = shape_of(item);
                Some(match acc {
                    None => Box::new(sh),
                    Some(mut b) => {
                        merge(&mut b, sh);
                        b
                    }
                })
            });
            s.array = Some(elem);
        }
    }
    s
}

/// Order-independent merge: leaves union, object keys union (a key missing from either side is optional),
/// array elements merged. `a` and `b` are treated the same way, so any merge order gives the same result.
pub(crate) fn merge(a: &mut Shape, b: Shape) {
    a.leaves.extend(b.leaves);
    a.object = merge_objects(a.object.take(), b.object);
    a.array = merge_arrays(a.array.take(), b.array);
}

type Object = BTreeMap<String, (Shape, bool)>;

fn merge_objects(a: Option<Object>, b: Option<Object>) -> Option<Object> {
    match (a, b) {
        (None, None) => None,
        (Some(x), None) | (None, Some(x)) => Some(x),
        (Some(mut x), Some(mut y)) => {
            let keys: BTreeSet<String> = x.keys().chain(y.keys()).cloned().collect();
            let mut out = BTreeMap::new();
            for k in keys {
                let entry = match (x.remove(&k), y.remove(&k)) {
                    (Some((sa, oa)), Some((sb, ob))) => {
                        let mut s = sa;
                        merge(&mut s, sb);
                        (s, oa || ob)
                    }
                    (Some((s, _)), None) | (None, Some((s, _))) => (s, true),
                    (None, None) => continue,
                };
                out.insert(k, entry);
            }
            Some(out)
        }
    }
}

type Array = Option<Option<Box<Shape>>>;

fn merge_arrays(a: Array, b: Array) -> Array {
    match (a, b) {
        (None, None) => None,
        (Some(x), None) | (None, Some(x)) => Some(x),
        (Some(x), Some(y)) => Some(match (x, y) {
            (None, None) => None,
            (Some(e), None) | (None, Some(e)) => Some(e),
            (Some(mut e), Some(f)) => {
                merge(&mut e, *f);
                Some(e)
            }
        }),
    }
}

pub(crate) fn to_json(s: &Shape) -> Value {
    let mut parts = Vec::new();
    if !s.leaves.is_empty() {
        let union: Vec<&str> = s.leaves.iter().copied().collect();
        parts.push(Value::String(union.join("|")));
    }
    if let Some(obj) = &s.object {
        let m: serde_json::Map<String, Value> = obj
            .iter()
            .map(|(k, (child, optional))| {
                let name = if *optional {
                    format!("{k}?")
                } else {
                    k.clone()
                };
                (name, to_json(child))
            })
            .collect();
        parts.push(Value::Object(m));
    }
    if let Some(elem) = &s.array {
        let items: Vec<Value> = elem.iter().map(|e| to_json(e)).collect();
        parts.push(Value::Array(items));
    }
    if parts.len() == 1 {
        parts.remove(0)
    } else {
        json!({ "$oneOf": parts })
    }
}

/// The key a request is recorded under, from the route pattern the router matched.
pub(crate) fn key_of(req: &Request) -> Option<String> {
    let matched = req.extensions().get::<axum::extract::MatchedPath>()?;
    Some(format!("{} {}", req.method(), matched.as_str()))
}

/// Records the body's shape when the response is a 2xx JSON answer, and always hands back the same response.
pub(crate) async fn observe(key: Option<String>, response: Response) -> Response {
    let Some(key) = key else {
        return response;
    };
    if !response.status().is_success() {
        return response;
    }
    let is_json = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if !is_json {
        return response;
    }
    let (parts, body) = response.into_parts();
    // Buffer before taking the mutex: never hold a std lock across an await.
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => return Response::from_parts(parts, Body::empty()),
    };
    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
        record(&key, &value);
    }
    Response::from_parts(parts, Body::from(bytes))
}

fn record(key: &str, value: &Value) {
    let mut map = recorded_map();
    let entry = map.entry(key.to_string()).or_default();
    let before = entry.clone();
    merge(entry, shape_of(value));
    if *entry != before && std::env::var_os("LUNA_CONTRACT_RECORD").is_some() {
        write_file(&map);
    }
}

fn write_file(map: &BTreeMap<String, Shape>) {
    let mut out = serde_json::Map::new();
    out.insert(
        "$comment".to_string(),
        Value::String(
            "Generated by lunad's API tests (crates/lunad/src/api/contract.rs). Do not edit; a full ./ci run -profile luna rewrites it."
                .to_string(),
        ),
    );
    for (key, shape) in map {
        let path = key.split_once(' ').map_or(key.as_str(), |(_, p)| p);
        if path.starts_with("/api/") || path.starts_with("/s/") || path == "/health" {
            out.insert(key.clone(), to_json(shape));
        }
    }
    let text = serde_json::to_string_pretty(&Value::Object(out))
        .expect("contract shapes serialize")
        + "\n";
    let out_path = Path::new(OUT);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .unwrap_or_else(|e| panic!("could not create {}: {e}", parent.display()));
    }
    let tmp = format!("{OUT}.tmp");
    std::fs::write(&tmp, text).unwrap_or_else(|e| panic!("could not write {tmp}: {e}"));
    std::fs::rename(&tmp, OUT).unwrap_or_else(|e| panic!("could not replace {OUT}: {e}"));
}

/// The recorded shape for one key, as the fixture would store it.
pub(crate) fn recorded(key: &str) -> Option<Value> {
    recorded_map().get(key).map(to_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Request as HttpRequest, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn merge_is_order_independent() {
        let samples = [
            json!([{"at": null, "size": 1, "mtime": 2}]),
            json!([]),
            json!([{"at": 5, "size": 1, "mtime": 2, "extra": "x"}]),
        ];
        let orders = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];
        for order in orders {
            let mut acc = Shape::default();
            for i in order {
                merge(&mut acc, shape_of(&samples[i]));
            }
            assert_eq!(
                to_json(&acc),
                json!([{
                    "at": "null|number",
                    "extra?": "string",
                    "mtime": "number",
                    "size": "number"
                }]),
                "order {order:?}"
            );
        }
    }

    #[test]
    fn one_of_for_mixed_compounds() {
        let mut acc = Shape::default();
        merge(&mut acc, shape_of(&json!(null)));
        merge(&mut acc, shape_of(&json!({"a": true})));
        assert_eq!(to_json(&acc), json!({"$oneOf": ["null", {"a": "boolean"}]}));
    }

    #[tokio::test]
    async fn guard_records_the_route_pattern() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = axum::Router::new()
            .route(
                "/contract-probe/{id}",
                axum::routing::get(|| async { axum::Json(json!({"id": "x", "n": 1})) }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let res = app
            .oneshot(
                HttpRequest::get("/contract-probe/abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, json!({"id": "x", "n": 1}));
        assert_eq!(
            recorded("GET /contract-probe/{id}"),
            Some(json!({"id": "string", "n": "number"}))
        );
    }
}
