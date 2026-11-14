# TinyCLIP feasibility investigation

Date: 2026-11-13. Research only; no search implementation or production model installation.

## Recommendation

Keep visual search in scope. TinyCLIP can run at a substantially smaller memory footprint than the earlier illustrative 400 MiB MobileCLIP configuration. Recommend `TinyCLIP-ViT-8M-16-Text-3M-YFCC15M` with a float32 image encoder for background indexing and an int8 text encoder for queries. Load them separately and unload the worker when unused. This combination retains nearly all of the float32 model's retrieval quality in this investigation. A fully int8 pair is a smaller fallback with a measurable quality cost.

This supports useful photo discovery, not a claim of excellent precision. With 1,000 candidate photos the recommended pair returned the designated image first for 39.4% of captions, within five results for 68.0%, and within twenty for 88.2%. Image search should supplement filenames, metadata, and the independently approved OCR pipeline. Low-memory systems continue ordinary search with capability status in the health check and no disruptive failure messages.

## What was measured

- Model: community ONNX conversion of the author's smallest TinyCLIP; revision `9463a9c508a344c837ffefe9d724f3827bf2dc79`.
- Corpus: all 1,000 rows of `jxie/flickr8k`, configuration `default`, split `test`; five captions per image, producing 5,000 text queries. Captions and images were not selected based on model results. Dataset revision was recorded as `56f58c967835f7c508d684f36bd7897cca9d7634`.
- Retrieval: normalize 512-dimensional embeddings, cosine similarity against every image, and rank the caption's designated source image. No prompt tuning, reranker, OCR, or metadata boost.
- Image preparation: cached JPEGs (maximum dimension 500 pixels), RGB conversion, EXIF orientation, bicubic resize of the shortest edge to 224, center crop to 224 × 224, and the export's mean/std normalization. Text uses the supplied tokenizer with special tokens and truncation to 77 tokens.
- Host: Intel Core i7-1185G7, Linux x86_64, Python 3.12.3, ONNX Runtime 1.32.0 CPU provider. One intra-op and inter-op thread; sequential execution; CPU arena and memory-pattern allocation disabled; worker spinning disabled. No GPU.
- Each encoder used a fresh process. Python workers streamed output vectors to disk rather than retaining the corpus. Resource maxima include model startup. Native workers ran one prepared input 20 times; they are a narrow encoder-only measurement, not a corpus-wide memory bound.
- Model preparation, the 100-photo exploratory probe, the 1,000-photo probe, and native probes ran separately. Every completed probe log ended with `EXIT:0`. No Luna application test suite was run.

## Retrieval results

| Image encoder | Text encoder | Recall@1 | Recall@5 | Recall@10 | Recall@20 |
|---|---|---:|---:|---:|---:|
| Float32 | Float32 | 40.04% | 68.74% | 79.98% | 88.58% |
| Int8 | Int8 | 37.28% | 66.08% | 77.54% | 87.30% |
| **Float32** | **Int8** | **39.40%** | **68.04%** | **79.42%** | **88.18%** |
| Int8 | Float32 | 37.72% | 66.62% | 78.40% | 87.82% |

Recall@K means the designated source image appears in the first K results. Other semantically relevant images receive no credit. Five captions share each image, so 5,000 queries are not 5,000 independent scenes. These results are specific to this caption dataset and are not interchangeable with the paper's Flickr30k/MSCOCO results. Training-data overlap with Flickr/YFCC was not audited. Queries in other languages, personal names, household receipts, and complex negative/relational descriptions were not evaluated.

Quantizing the image branch caused most of the observed quality loss. The recommended mixed pair loses only 0.64 percentage points at rank 1 and 0.70 points at rank 5 against float32. This is a descriptive difference on one corpus, not a statistical confidence claim. The first 100-photo subset was much easier (69.4% rank-1 recall for both fully float32 and fully int8); use the complete 1,000-photo results when making decisions.

## Memory and deployment

The ONNX graph exposes `image_embeds` and `text_embeds`. `onnx.utils.extract_model` successfully produced independent encoders. File sizes:

| Encoder | Float32 ONNX | Int8 ONNX |
|---|---:|---:|
| Image | 31.8 MiB | 8.5 MiB |
| Text | 58.0 MiB | 14.7 MiB |

Measured maximum resident memory, including runtime and process overhead:

| Encoder | Python corpus worker | Native encoder-only worker |
|---|---:|---:|
| Float32 image | 124.7 MiB | 87.6 MiB |
| Int8 image | 96.4 MiB | 55.1 MiB |
| Float32 text | 172.9 MiB | 137.2 MiB |
| Int8 text | 127.0 MiB | 58.2 MiB |

The native worker uses ONNX Runtime's C API from a small C++ executable; Python is unnecessary for production inference. Its input tensors were prepared before process startup: it excludes original-image decoding, resizing, text tokenization, and index retrieval. The Python image worker includes preparation of the cached 500-pixel JPEGs, not full-resolution originals; its text worker includes tokenizer loading and execution. Tokenizer representation matters: the 14.7 MiB text model is not the whole text-search working set.

For implementation, feed the image encoder from Luna's existing aspect-preserving gallery thumbnails (`THUMB_MAX = 640`) when available, then apply the model's resize/crop/normalization. Queue missing thumbnails through the existing bounded gallery pipeline first. This avoids independently decoding full-resolution originals inside the inference worker. The source thumbnail recipe and model preprocessing should be versioned together; equivalence of gallery thumbnails to this dataset's cached JPEGs has not been measured.

These are observed maxima, not safe hard limits. Do not subtract a baseline and present the remainder as a complete production budget. Do not add the two encoder peaks when the workers run separately. A 128 MiB worker target looks plausible but is not established for production inputs. Admission control still needs headroom for decoding, tokenization, index pages, Luna, and the OS; an OS-enforced worker limit and silent fallback remain appropriate.

On this host, mean Python per-item times were 45.9 ms for float32 images, 25.1 ms for int8 images, 1.26 ms for float32 text, and 0.98 ms for int8 text. These are wall times with one runtime thread, not single-core Wyse timings or throughput promises. No CPU affinity, total-machine memory limit, or production traffic contention was applied. Older CPU instruction paths may affect both speed and quantized numerics.

Luna's OS build uses Alpine/musl. The native experiment used the host's glibc ONNX library, so the binary is not a deployment artifact. A matching musl build/package, baseline CPU compatibility, and native tokenizer integration remain implementation work. Alpine distributes ONNX Runtime, but its package version is not automatically equivalent to the runtime used here. Build-time tooling can use Python; Luna should ship only the native worker, pinned model files, and tokenizer data. Preserve model/license provenance and include preprocessing plus the chosen encoder pair in the index version.

## Evidence and reproduction

`results.json` records exact metrics, file hashes, versions, and a corpus hash. `probe.py` is the sequential Python corpus probe, with the cache selected through `LUNA_TINYCLIP_CACHE` (default `/tmp/luna-tinyclip-research`). `native-probe.cpp` is the native encoder probe. They are standalone investigation tools, not CI tests or Luna features. Original images, captions, downloaded libraries, and model weights are not committed.

Acquisition and preparation used:

1. Download `onnx/model.onnx`, `onnx/model_int8.onnx`, `tokenizer.json`, and `preprocessor_config.json` from the pinned model revision into the cache. Preserve basenames.
2. Request the dataset viewer's `/rows` endpoint for `jxie/flickr8k`, `config=default`, `split=test`, offsets 0 through 900 in batches of 100. Save `{"rows": [...]}` as `evaluation-rows.json`; download each row's `image.src` to `images/<row_idx padded to four digits>.jpg`. Confirm the dataset revision and corpus hash in the results; viewer URLs are temporary and are not themselves immutable evidence.
3. For each `model` and `model_int8`, use `onnx.utils.extract_model` to write `<model>-image.onnx` with input `pixel_values` and output `image_embeds`, and `<model>-text.onnx` with inputs `input_ids`, `attention_mask` and output `text_embeds`. Extraction used ONNX 1.23.2. Other probe dependencies: NumPy 2.5.4, Pillow 13.0.0, Tokenizers 0.23.3, ONNX Runtime 1.32.0.
4. Run the corpus probe as a background job and inspect its log's final exit status. Mixed-pair metrics are obtained by pairing the float32 image vectors with int8 text vectors and vice versa, normalizing and ranking with the same cosine-similarity calculation. No extra inference is needed for these pairings.
5. For the native probe, compile against ONNX Runtime 1.32.0's `onnxruntime_c_api.h` (plus its error-code and EP headers) and shared library. Arguments are the encoder ONNX path, `image` or `text`, and the cache directory. Input files are the first corpus image preprocessed to contiguous float32 CHW (`input-image.bin`) and its first caption's int64 token IDs (`input-text.bin`). The native program generates an all-one attention mask. Its output can be compared with the first vector of the corresponding Python worker.

Combined-graph versus extracted-encoder outputs matched exactly on the first image/caption for both precisions. Native versus Python int8 outputs also matched exactly on that prepared input. These checks establish wiring parity for that input, not universal equivalence or cross-CPU numerical parity.

Sources:

- [Author's model and license](https://huggingface.co/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M)
- [Pinned community ONNX export](https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX/tree/9463a9c508a344c837ffefe9d724f3827bf2dc79)
- [Flickr8k dataset mirror](https://huggingface.co/datasets/jxie/flickr8k)
- [ONNX Runtime quantization considerations](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
- [ONNX Runtime thread management](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)
- [Alpine's musl ONNX Runtime package, version 3.23](https://pkgs.alpinelinux.org/package/v3.23/community/x86_64/onnxruntime)
