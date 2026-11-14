//! Searching inside files: the words in documents, text in images and
//! scans (OCR), what passages mean (meaning search), and what photos show
//! (photo search).
//!
//! Everything a file yields is stored in its drive's own database next to
//! the file index, read in the background by [`indexer::ContentIndexer`],
//! and found through the same search bars as names. Results pass the same
//! access checks as name results; snippets are made only for files the
//! person may open.

pub mod extract;
pub mod formats;
pub mod indexer;
pub mod m2v;
pub mod meaning;
pub mod ocr;
pub mod photos;
pub mod query;
pub mod store;
pub mod worker;
