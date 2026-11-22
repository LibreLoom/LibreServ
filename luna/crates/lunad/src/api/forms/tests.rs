use super::*;

#[test]
fn form_path_match_is_case_insensitive() {
    assert!(is_form_path("forms/rsvp.lunaform"));
    assert!(is_form_path("RSVP.LUNAFORM"));
    assert!(!is_form_path("forms/rsvp.json"));
    assert!(!is_form_path("forms"));
}

#[test]
fn answers_db_swaps_the_extension() {
    let dir = tempfile::tempdir().unwrap();
    let form = dir.path().join("rsvp.lunaform");
    std::fs::write(&form, b"{}").unwrap();
    assert_eq!(
        store::db_path_for(&form).unwrap(),
        dir.path().join(".rsvp.lunaform.responses.sqlite")
    );
    // A private form keeps a Luna-owned sidecar name.
    let private = dir
        .path()
        .join(".luna-123e4567-e89b-12d3-a456-426614174000-rsvp");
    assert_eq!(
        store::db_path_for(&private).unwrap(),
        dir.path()
            .join(".luna-123e4567-e89b-12d3-a456-426614174000-rsvp.responses.sqlite")
    );
    assert!(store::db_path_for(&dir.path().join("rsvp.json")).is_none());
}

#[test]
fn allow_edits_defaults_to_allowed() {
    // Missing settings or flag → allowed (old forms predate it).
    assert!(form_allows_edits(&Map::new()));
    let doc: Map<String, Value> =
        serde_json::from_value(json!({ "settings": { "collecting": true } })).unwrap();
    assert!(form_allows_edits(&doc));
    let doc: Map<String, Value> =
        serde_json::from_value(json!({ "settings": { "allowEdits": false } })).unwrap();
    assert!(!form_allows_edits(&doc));
}

#[test]
fn answers_accept_flat_values_only() {
    assert!(answer_value_ok(&json!("Yes")));
    assert!(answer_value_ok(&json!(3)));
    assert!(answer_value_ok(&json!(true)));
    assert!(answer_value_ok(&json!(null)));
    assert!(answer_value_ok(&json!(["a", "b"])));
    assert!(!answer_value_ok(&json!({"nested": 1})));
    assert!(!answer_value_ok(&json!([{"nested": 1}])));
}

fn doc() -> Map<String, Value> {
    serde_json::from_value(json!({
        "version": 1,
        "questions": [
            { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
              "config": { "options": ["Yes", "No"] } },
            { "id": "q_2", "type": "multi_choice", "label": "Sides",
              "config": { "options": ["Slaw", "Beans"] } },
            { "id": "q_3", "type": "short_text", "label": "Name" },
            { "id": "q_4", "type": "yes_no", "label": "Kids?" },
            { "id": "q_5", "type": "future_widget", "label": "Future" }
        ]
    }))
    .unwrap()
}

#[test]
fn validation_enforces_required_types_and_known_ids() {
    let doc = doc();
    // Required question missing → refused.
    let answers = Map::new();
    assert!(validate_answers(&doc, &answers, None).is_err());
    // Required answered + optional empty → fine.
    let answers: Map<String, Value> = serde_json::from_value(json!({ "q_1": "Yes" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    // Unknown question id (removed mid-answer) → dropped, not refused.
    let mut answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_99": "x" })).unwrap();
    keep_known_answers(&doc, &mut answers);
    assert!(!answers.contains_key("q_99"));
    assert!(validate_answers(&doc, &answers, None).is_ok());
    // An option nobody offered → refused.
    let answers: Map<String, Value> = serde_json::from_value(json!({ "q_1": "Maybe" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    // multi_choice needs an array of offered strings.
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_2": "Slaw" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_2": ["Slaw", "Beans"] })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_2": ["Slaw", "Pasta"] })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    // yes_no is the two strings only.
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_4": "yes" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_4": "maybe" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    // A type this build doesn't know accepts any flat value.
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_5": {"anything": "goes-ish"} })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err()); // nested → no
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_5": 42 })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
}

#[test]
fn email_number_other_and_skip_are_enforced() {
    let doc: Map<String, Value> = serde_json::from_value(json!({
        "questions": [
            { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
              "config": { "options": ["Yes", "No"] } },
            { "id": "q_2", "type": "email", "label": "Email", "required": true },
            { "id": "q_3", "type": "number", "label": "Guests",
              "config": { "min": 1, "max": 8 } },
            { "id": "q_4", "type": "short_text", "label": "Meal", "required": true,
              "logic": { "questionId": "q_1", "equals": "No" } },
            { "id": "q_5", "type": "choice", "label": "Dish",
              "config": { "options": ["Salad"], "allowOther": true } }
        ]
    }))
    .unwrap();
    // A skipped required question doesn't block a "No".
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "No", "q_2": "a@b.co" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    // A value sent for that hidden question still has to match its type.
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_1": "No", "q_2": "a@b.co", "q_4": ["not text"]
    }))
    .unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_1": "No", "q_2": "a@b.co", "q_4": "Fish"
    }))
    .unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    // Coming Yes makes the meal required.
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "Yes", "q_2": "a@b.co" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    // Bad email, out-of-range number, and a free-text Other.
    let answers: Map<String, Value> =
        serde_json::from_value(json!({ "q_1": "No", "q_2": "not-an-email" })).unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_1": "Yes", "q_2": "a@b.co", "q_3": 9, "q_4": "Fish"
    }))
    .unwrap();
    assert!(validate_answers(&doc, &answers, None).is_err());
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_1": "Yes", "q_2": "a@b.co", "q_3": 2, "q_4": "Fish", "q_5": "My stew"
    }))
    .unwrap();
    assert!(validate_answers(&doc, &answers, None).is_ok());
    assert!(upload_name_ok("0123456789abcdef.pdf"));
    assert!(!upload_name_ok("photo.pdf"));
    assert!(!upload_name_ok("0123456789abcdef.exe"));
}

#[test]
fn close_date_and_cap_are_separate_from_edits() {
    let open: Map<String, Value> =
        serde_json::from_value(json!({ "settings": { "closeOn": "1999-01-01" } })).unwrap();
    assert!(hard_closed_message(&open).is_some());
    let future: Map<String, Value> =
        serde_json::from_value(json!({ "settings": { "closeOn": "2999-01-01" } })).unwrap();
    assert!(hard_closed_message(&future).is_none());
    let capped: Map<String, Value> =
        serde_json::from_value(json!({ "settings": { "maxResponses": 2 } })).unwrap();
    assert_eq!(form_max_responses(&capped), Some(2));
}
#[test]
fn content_must_match_the_extension() {
    assert!(content_matches("pdf", b"%PDF-1.7 ..."));
    assert!(!content_matches("pdf", b"<html><script>"));
    assert!(content_matches(
        "png",
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]
    ));
    assert!(content_matches("jpg", &[0xFF, 0xD8, 0xFF, 0xE0]));
    assert!(content_matches("webp", b"RIFF\0\0\0\0WEBPVP8 "));
    assert!(!content_matches("gif", b"GIF00"));
    assert_eq!(picture_ext("a.PDF"), None);
    assert_eq!(picture_ext("a.JPEG"), Some("jpg"));
}
#[test]
fn answer_text_limits_are_bytes_and_form_characters() {
    let plain: Value = json!({ "label": "Essay" });
    assert!(!answer_text_too_long(
        &plain,
        &"x".repeat(MAX_ANSWER_TEXT_BYTES)
    ));
    assert!(answer_text_too_long(
        &plain,
        &"x".repeat(MAX_ANSWER_TEXT_BYTES + 1)
    ));
    let short: Value = json!({ "label": "Nickname", "config": { "maxLength": 3 } });
    assert!(!answer_text_too_long(&short, "abc"));
    assert!(answer_text_too_long(&short, "abcd"));
    // A form's limit counts characters, not bytes.
    assert!(!answer_text_too_long(&short, "ééé"));
    // A larger form limit cannot lift the server cap.
    let loose: Value = json!({ "config": { "maxLength": 10_000_000 } });
    assert!(answer_text_too_long(
        &loose,
        &"x".repeat(MAX_ANSWER_TEXT_BYTES + 1)
    ));
}

#[test]
fn too_long_answers_name_the_question_or_say_it_generally() {
    let doc: Map<String, Value> = serde_json::from_value(json!({
        "questions": [
            { "id": "q_1", "type": "long_text", "label": "Your story" },
            { "id": "q_2", "type": "long_text" }
        ]
    }))
    .unwrap();
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_1": "x".repeat(MAX_ANSWER_TEXT_BYTES + 1)
    }))
    .unwrap();
    let err = validate_answers(&doc, &answers, None).unwrap_err();
    assert_eq!(err.0, StatusCode::BAD_REQUEST);
    assert!(
        err.1.0["error"].as_str().unwrap().contains("Your story"),
        "{err:?}"
    );
    let answers: Map<String, Value> = serde_json::from_value(json!({
        "q_2": "x".repeat(MAX_ANSWER_TEXT_BYTES + 1)
    }))
    .unwrap();
    let err = validate_answers(&doc, &answers, None).unwrap_err();
    assert_eq!(err.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        err.1.0["error"],
        "One answer is too long to save. Shorten it and try again."
    );
}

#[test]
fn every_answer_together_must_fit_the_payload_cap() {
    let mut answers = Map::new();
    for i in 0..5 {
        answers.insert(format!("q_{i}"), Value::String("y".repeat(30 * 1024)));
    }
    assert!(answers_payload_len(&answers) > MAX_ANSWER_PAYLOAD_BYTES);
    let small: Map<String, Value> = serde_json::from_value(json!({ "q_1": "hello" })).unwrap();
    assert!(answers_payload_len(&small) <= MAX_ANSWER_PAYLOAD_BYTES);
}

#[test]
fn a_form_bucket_bounds_submissions_from_every_address() {
    let dir = tempfile::tempdir().unwrap();
    let db = std::sync::Arc::new(crate::Db::new(
        crate::db::open(&dir.path().join("luna.db")).unwrap(),
    ));
    let max = crate::api::form_limits::submit_per_minute();
    let limiter = crate::rate_limit::RateLimiter::new(db, std::time::Duration::from_secs(60), max);
    let key = form_key("photos", "rsvp.lunaform");
    for _ in 0..max {
        assert!(limiter.allow(&key));
    }
    assert!(!limiter.allow(&key), "the form's budget is spent");
    // Another form is untouched, and the key never carries the path.
    assert!(limiter.allow(&form_key("photos", "potluck.lunaform")));
    assert!(!key.contains("rsvp"), "{key}");
    // The per-IP submit bucket is separate from the per-form one.
    assert!(limiter.allow(&respond_key("submit", "203.0.113.7")));
}
