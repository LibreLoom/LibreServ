use super::*;

#[test]
fn form_path_match_is_case_insensitive() {
    assert!(is_form_path("forms/rsvp.lunaform"));
    assert!(is_form_path("RSVP.LUNAFORM"));
    assert!(!is_form_path("forms/rsvp.json"));
    assert!(!is_form_path("forms"));
}

#[test]
fn responses_path_swaps_the_extension() {
    assert_eq!(
        responses_path_for(FsPath::new("/d/forms/rsvp.lunaform")).unwrap(),
        PathBuf::from("/d/forms/rsvp.lunaform.responses")
    );
    assert_eq!(
        responses_path_for(FsPath::new("/d/rsvp.LUNAFORM")).unwrap(),
        PathBuf::from("/d/rsvp.lunaform.responses")
    );
    assert!(responses_path_for(FsPath::new("/d/rsvp.json")).is_none());
}

#[test]
fn latest_record_per_id_wins() {
    let records = parse_response_records(
        r#"{"v":1,"id":"r_1","edit":"h1","at":1,"answers":{"q":"Yes"}}
not json
{"v":1,"id":"r_2","edit":"h2","at":2,"answers":{"q":"No"}}
{"v":1,"id":"r_1","edit":"h1","at":3,"answers":{"q":"Maybe"}}
{"noid":true}
"#,
    );
    assert_eq!(records.len(), 3);
    let latest = latest_by_id(&records);
    assert_eq!(latest.len(), 2);
    assert_eq!(latest["r_1"]["answers"]["q"], "Maybe");
    assert_eq!(latest["r_2"]["answers"]["q"], "No");
}

#[test]
fn editable_needs_the_secret_or_the_right_id() {
    let records = parse_response_records(
        r#"{"v":1,"id":"r_1","edit":"h1","at":1,"answers":{}}
{"v":1,"id":"r_2","edit":"h2","at":2,"answers":{}}"#,
    );
    let latest = latest_by_id(&records);
    // Known id + matching secret → same id back.
    assert_eq!(
        find_editable(&latest, Some("r_1"), "h1")
            .unwrap()
            .as_deref(),
        Some("r_1")
    );
    // Known id + wrong secret and unknown id must fail identically —
    // otherwise the endpoint is a response-id existence oracle.
    let wrong_secret = find_editable(&latest, Some("r_1"), "h2").unwrap_err();
    let unknown_id = find_editable(&latest, Some("r_9"), "h1").unwrap_err();
    assert_eq!(wrong_secret.0, StatusCode::FORBIDDEN);
    assert_eq!(unknown_id.0, wrong_secret.0);
    assert_eq!(unknown_id.1.0, wrong_secret.1.0);
    // No id: the secret alone picks the response (edit-link flow).
    assert_eq!(
        find_editable(&latest, None, "h2").unwrap().as_deref(),
        Some("r_2")
    );
    // A fresh secret matches nothing → caller mints a new id.
    assert_eq!(find_editable(&latest, None, "h9").unwrap(), None);
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
fn tombstones_remove_a_response_and_order_follows_first_send() {
    let records = parse_response_records(
        r#"{"v":1,"id":"r_b","edit":"h","at":1,"answers":{"q":"1"}}
{"v":1,"id":"r_a","edit":"h","at":2,"answers":{"q":"2"}}
{"v":1,"id":"r_b","edit":"h","at":5,"answers":{"q":"3"}}
{"v":1,"id":"r_a","deleted":true,"at":6}"#,
    );
    let live = latest_in_order(&records);
    assert_eq!(live.len(), 1);
    assert_eq!(live[0]["id"], "r_b");
    assert_eq!(live[0]["answers"]["q"], "3");
    assert_eq!(live[0]["sent_at"], 1);
    assert_eq!(live[0]["at"], 5);
    assert!(live[0].get("edit").is_none());
    assert_eq!(latest_by_id(&records).len(), 1);
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
