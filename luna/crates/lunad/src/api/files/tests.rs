use super::*;

#[test]
fn range_parsing() {
    assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
    assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
    assert_eq!(parse_range("bytes=-10", 1000), Some((990, 999)));
    assert_eq!(parse_range("bytes=999-1000", 1000), Some((999, 999)));
    assert_eq!(parse_range("bytes=5-2", 1000), None);
    assert_eq!(parse_range("bytes=1000-", 1000), None);
}

#[test]
fn disposition_header_cannot_split() {
    let name = files::content_disposition_filename("a\r\nContent-Type: text/html");
    assert!(!name.contains('\r'));
    assert!(!name.contains('\n'));
    assert!(!name.contains(':'));
}
