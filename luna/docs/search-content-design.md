# Searching document contents and photos

Luna's current per-drive index stores names and file metadata. Search does not read document contents or recognize text in photos. Photo results are image files matched by name, not a separate photo library search.

Content search needs a bounded extraction pipeline integrated with the existing drive indexer. Extract text from supported plain text and office formats in isolated workers with limits on file size, time, memory, and extracted text. Store extracted text in each drive's index, update it when files change, and remove it when files disappear. Show extraction failures and progress separately from the existing directory scan. Query results must pass the same current path permission checks as name results, including after permissions change; snippets must never be generated for inaccessible paths. Decide how encrypted documents, removable and read-only drives, and indexing on limited hardware behave before enabling it. Test permission changes, malicious documents, stale indexes, and resource limits with real drives.

OCR is approved for the search design. Extracted text should feed both ordinary content search and static text embeddings when available. Start with printed text in scans, receipts, and screenshots; the engine and language coverage remain to be selected. Use bounded, isolated workers and the same per-drive lifecycle and access checks as document extraction. This is a design decision, not an implemented feature or a measured memory guarantee.

Neural search is optional and should enable only when memory is sufficient. When unavailable or when a worker fails, ordinary search continues without disruptive errors; the health check reports whether neural search is on and why it is off. Keep processing failures available in diagnostics. No image data should leave Luna without a separate user choice. Visual photo search remains a model-selection decision.

## TinyCLIP investigation

`wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M` is a smaller visual-search candidate, not a selected model. The paper excludes the text token embedding table from its parameter counts. Inspecting the published safetensors header at revision `a2a8c6e` gives approximately 8.28 million image parameters and 15.17 million text parameters including the table. The token table alone contains 49,408 × 256 = 12,648,448 parameters.

| Component | Float32 tensor storage | Ideal int8 weight storage |
|---|---:|---:|
| Image encoder and projection | 31.6 MiB | 7.9 MiB |
| Text encoder and projection | 57.9 MiB | 14.5 MiB |
| Both | 89.4 MiB | 22.4 MiB |

The int8 column is arithmetic, not a measured export or working set. A community ONNX export already provides a 24.3 MB (about 23.2 MiB) int8 file. Neither checkpoint size nor these weight calculations include inference runtime, image decoding, activations, tokenizer, or retrieval-index memory. Compatibility and quantized retrieval quality have not been evaluated here. The published config uses 224-pixel image inputs and 512-dimensional output vectors; its 256-wide text hidden state is not the output dimension.

The smallest model's published text-to-image recall at rank 1 is 42.3% on Flickr30k and 21.5% on MSCOCO. The paper's larger TinyCLIP ViT-22M/32 variant reaches 52.0% and 28.3%, respectively. These are benchmark retrieval rates, not estimates of household photo-search success. The published throughput uses a V100 GPU and batch size 1,024, so it says nothing directly about Wyse CPU latency. The model card declares MIT licensing.

The recommendation is to retain TinyCLIP as a low-memory candidate while leaving the final image model open. Load image and text encoders separately where the deployment format permits; a combined ONNX export does not establish that capability. OCR approval does not depend on adopting image embeddings. No inference or performance benchmark was run for this investigation.

Sources:

- [TinyCLIP paper, evaluation settings and Table 1](https://arxiv.org/pdf/2309.12314)
- [Author's checkpoint](https://huggingface.co/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M/tree/a2a8c6e)
- [Community ONNX exports](https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX/tree/9463a9c/onnx)
