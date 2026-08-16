use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};

/// Plain-language JSON error. API consumers and the UI both render `error`.
pub fn json_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}
