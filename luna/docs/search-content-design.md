# Searching document contents and photos

Every search bar that searches files or photos (file search, the not-found page's "Find a file", the gallery) also finds files by the words inside them, by what their text is about, and photos by what they show. Each bar keeps the scope it had: the same drives, folders, filters and access checks. There is no separate search and no new settings. Code: `crates/lunad/src/files/content/`.

## What is searched

| Part | Finds | How | Runs |
|---|---|---|---|
| Words inside files | Documents, PDFs, spreadsheets, e-books, old Office files | Rust parsers in a sandboxed `lunad __extract` worker; `pdftotext` for PDFs | Every Luna |
| Text in pictures (OCR) | Scans, screenshots, scanned PDFs, photos of documents | Tesseract, English only | Every Luna |
| Meaning | Text that's about what was typed in other words ("lease" finds a tenancy agreement) | Model2Vec potion-base-8M, in-process | Every Luna with the models pack |
| Photo content | Photos and videos (by thumbnail) that show what was typed | TinyCLIP in `luna-clip` workers | Lunas with at least 1.5 GB of memory |

Results come in tiers: names, then words inside files, then near-miss names, then meaning matches, then photo matches. Looser matches sit under their own heading in the result list ("Found in the text", "Close in meaning", "Seen in photos"). Content and meaning matches show the passage that matched. Snippets are read only after the access check passes. The gallery uses meaning and photo matches only to widen what its free-text words match; its other filters and its date order don't change.

## Storage and lifecycle

Everything is stored in each drive's own database next to the file index: `content_docs` and `content_fts` (FTS5, porter stemming) for text, `content_vecs` for passage vectors, and `photo_vecs` for photo vectors. An encrypted drive's text therefore stays inside its encryption. Rows are keyed by path and checked against the file index's (or gallery's) size and time, so changed or deleted files never match on stale text. A full drive read drops rows for files that are gone.

A background reader follows the name indexer. It reads new or changed files one at a time, documents first and newest first. It waits when free memory drops below 320 MiB and stops when a drive goes away. The "still reading" pill in file search says when contents are still being read. Read-only drives are searched but never read into. Hidden folders and Luna's own folders are never read. Password-protected files are recorded as such, not as failures. Per-file limits on input size, time, memory and output (1 MB of text) apply; zip entries inflate through caps.

OCR reads PNG/TIFF/BMP/WebP images, JPEGs without camera details, and PDF pages that have no text layer (the first 30 pages, at 200 dpi). A camera photo is read only when photo search judges that it shows a document. That uses the best of seven document prompts minus the best of seven plain-photo prompts, above 0.03. On Flickr8k, which has no documents, 99% of photos scored at most 0.02; synthetic receipts, pages and screenshots scored 0.063–0.082. This hasn't been checked on real phone photos of documents. On a Luna without photo search, camera photos are never OCR'd.

## Models and measurements

- **Meaning:** potion-base-8M (MIT, revision `bf8b056`). Rust tokenizer and int8 table; cosine against the `model2vec` library is ≥ 0.99996 on six test texts. Text is cut into passages of about 60 words (at most 48 per file). A file matches when its best passage reaches cosine 0.38. On household-style passages, right matches scored 0.42–0.59 and the closest wrong ones up to 0.32.
- **Photos:** TinyCLIP-ViT-8M-16-Text-3M-YFCC15M (MIT), community ONNX export `9463a9c`, with a float32 image encoder and an int8 text encoder. The encoders are cut out at build time; their sha256 matches the [feasibility study](research/tinyclip/README.md).
  - **Why a separate program:** lunad is a static musl binary and can't load ONNX Runtime, so the encoders run in `os/clip/luna-clip.cpp`. It is linked against Alpine 3.24's onnxruntime 1.24.4, sandboxed as `nobody` with a 768 MiB address-space cap, and fed tensors over a pipe.
  - **Parity:** that runtime reproduced the study's vectors (cosine 1.0), also on an emulated CPU without AVX. The Rust CLIP tokenizer matches Hugging Face `tokenizers` on 1,008 texts.
  - **Match rule:** a photo matches at cosine ≥ 0.36 and within 0.07 of the drive's best match. On Flickr8k that keeps the captioned photo for 91% of captions, with about 23 photos returned per 1,000.
  - **Worker lifetime:** the image worker stops 60 s after use and the text worker 5 minutes after a search. Three failures in a row pause photo search for 30 minutes.
- **Packaging:** the models ship in the OS image (`models-pack`, built by `scripts/build-models-pack.sh`, unpacked to `/usr/share/luna/models`). `luna-clip`, Tesseract, poppler and onnxruntime are part of the root filesystem. Nothing is downloaded at run time, and no file or image data leaves Luna.

## Health check

Three rows in the system check: `search_inside` (the PDF and OCR tools), `meaning_search`, and `photo_search`. A missing model or tool is a warning that says what still works. Photo search being off because the box has too little memory is reported as a pass with that explanation. A paused photo search is a warning that includes its last error.

## Not yet measured

- Speed and memory on a Wyse 3040 (Atom, 2 GB) under real libraries: extraction, OCR, meaning embedding, photo indexing, and query latency with many passages or photos per drive.
- Whether the 0.38 meaning and 0.36/0.07 photo cut-offs suit real household files (calibrated on small sets).
- Whether the "shows a document" check works on real phone photos of receipts and letters.
- Whether the OS image with the added packages and models still fits the 2,048 MiB slot. The image build reports this.
