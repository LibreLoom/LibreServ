use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};

/// Plain-language JSON error. API consumers and the UI both render `error`.
pub fn json_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

/// Plain-language JSON error with a stable machine-readable `code`.
/// UI routing can key off `code` without parsing the human `error` string.
pub fn json_error_code(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "error": message.into(), "code": code })),
    )
}
