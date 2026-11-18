#!/bin/sh
# Build os/dist/models-pack.tar.zst — the search models baked into the OS
# image. The rootfs step unpacks it to /usr/share/luna/models, where lunad
# looks for them (crates/lunad/src/files/content/{meaning,clip}.rs).
#
#   models/potion-base-8M/  Model2Vec static embeddings (meaning search), MIT
#   models/tinyclip/        TinyCLIP-ViT-8M-16-Text-3M-YFCC15M (photo search), MIT:
#                           image.onnx (float32 image encoder), text.onnx (int8
#                           text encoder), tokenizer.json
#
# Every download is pinned by revision and sha256. The two TinyCLIP encoders
# are cut out of the community ONNX export with onnx.utils.extract_model
# (onnx 1.23.2, which is deterministic: the results are checked by sha256
# too). That step needs Python with onnx==1.23.2: the release image
# (infra/release/images/luna-models) has it; elsewhere it runs in a pinned
# python container through podman.
#
# PACK_OUT_DIR / PACK_WORK_DIR move the output and scratch dirs (the release
# tool builds from a read-only source export and sets both).
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT="${PACK_OUT_DIR:-$ROOT/os/dist}"
WORK="${PACK_WORK_DIR:-$ROOT/os/work/models-pack}"
TARBALL="$OUT/models-pack.tar.zst"
STAMP="$TARBALL.sha256"

HF="https://huggingface.co"
M2V_REV="bf8b056651a2c21b8d2565580b8569da283cab23"
CLIP_REV="9463a9c508a344c837ffefe9d724f3827bf2dc79"
CLIP_REPO="onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX"
ONNX_VERSION="1.23.2"
PYTHON_IMAGE="docker.io/library/python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b"

# name|url|sha256
DOWNLOADS="
potion-base-8M/model.safetensors|$HF/minishlab/potion-base-8M/resolve/$M2V_REV/model.safetensors|f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2
potion-base-8M/tokenizer.json|$HF/minishlab/potion-base-8M/resolve/$M2V_REV/tokenizer.json|e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50
src/model.onnx|$HF/$CLIP_REPO/resolve/$CLIP_REV/onnx/model.onnx|31d28cb07209533d10fc4fef73ac324ce17de6741a2372e7e1531a4ac8fdaeb2
src/model_int8.onnx|$HF/$CLIP_REPO/resolve/$CLIP_REV/onnx/model_int8.onnx|844d1a46ab18acf50c989e541b12fe3b6dc7f8d6004725b4e992d142788e0600
tinyclip/tokenizer.json|$HF/$CLIP_REPO/resolve/$CLIP_REV/tokenizer.json|6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35
"
# Extracted encoders: name|sha256
EXTRACTED="
tinyclip/image.onnx|0c0dc84f851b55901cfaadf18b52c77338c530cf2fb22d0409eeebb33b488ea5
tinyclip/text.onnx|c4d75ebae0ae45b699a5bc9cceee1edffd73f60e465d4a6f64b56fd5f06c9a8c
"

check_sum() {
	[ "$(sha256sum "$1" | awk '{print $1}')" = "$2" ]
}

DL="$WORK/download"
STAGE="$WORK/stage/models"
mkdir -p "$DL"
rm -rf "$WORK/stage"
mkdir -p "$STAGE/potion-base-8M" "$STAGE/tinyclip"

echo "$DOWNLOADS" | while IFS='|' read -r name url sum; do
	[ -n "$name" ] || continue
	dest="$DL/$name"
	mkdir -p "$(dirname "$dest")"
	if [ -f "$dest" ] && check_sum "$dest" "$sum"; then
		continue
	fi
	echo "Fetching $name …"
	curl -fsSL --retry 3 -o "$dest.part" "$url"
	check_sum "$dest.part" "$sum" || { echo "ERROR: $name does not match its pinned sha256" >&2; rm -f "$dest.part"; exit 1; }
	mv "$dest.part" "$dest"
done

cp "$DL/potion-base-8M/model.safetensors" "$DL/potion-base-8M/tokenizer.json" "$STAGE/potion-base-8M/"
cp "$DL/tinyclip/tokenizer.json" "$STAGE/tinyclip/"

EXTRACT_PY='
import sys, onnx.utils as u
src, out = sys.argv[1], sys.argv[2]
u.extract_model(src + "/model.onnx", out + "/image.onnx", ["pixel_values"], ["image_embeds"])
u.extract_model(src + "/model_int8.onnx", out + "/text.onnx", ["input_ids", "attention_mask"], ["text_embeds"])
'
if python3 -c "import onnx, sys; sys.exit(0 if onnx.__version__ == '$ONNX_VERSION' else 1)" 2>/dev/null; then
	python3 -I -c "$EXTRACT_PY" "$DL/src" "$STAGE/tinyclip"
elif command -v podman >/dev/null 2>&1; then
	echo "Extracting the TinyCLIP encoders in $PYTHON_IMAGE …"
	podman run --rm --network=host --security-opt label=disable \
		-v "$DL/src:/src:ro" -v "$STAGE/tinyclip:/out" "$PYTHON_IMAGE" \
		sh -c "pip install -q --no-cache-dir onnx==$ONNX_VERSION && python -I -c '$EXTRACT_PY' /src /out"
else
	echo "ERROR: extracting the encoders needs python3 with onnx==$ONNX_VERSION, or podman" >&2
	exit 1
fi

echo "$EXTRACTED" | while IFS='|' read -r name sum; do
	[ -n "$name" ] || continue
	check_sum "$STAGE/$name" "$sum" || { echo "ERROR: extracted $name does not match its pinned sha256" >&2; exit 1; }
done

cat > "$STAGE/SOURCES.txt" <<EOF
Search models in this folder (both MIT licensed by their authors):

potion-base-8M — Model2Vec static embeddings by Minish Lab
  $HF/minishlab/potion-base-8M (revision $M2V_REV)

tinyclip — TinyCLIP-ViT-8M-16-Text-3M-YFCC15M by the TinyCLIP authors
  $HF/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M
  ONNX export: $HF/$CLIP_REPO (revision $CLIP_REV)
  image.onnx and text.onnx are the image and text encoders cut out of
  onnx/model.onnx and onnx/model_int8.onnx with onnx $ONNX_VERSION.
EOF

mkdir -p "$OUT"
echo "Packing $STAGE → $TARBALL …"
tmp="$TARBALL.tmp"
tar -C "$WORK/stage" -cf - models | zstd -19 -T0 -q -o "$tmp"
mv "$tmp" "$TARBALL"
( cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$STAMP")" )

_size="$(du -h "$TARBALL" | awk '{print $1}')"
echo "built $TARBALL ($_size)"
echo "checksum: $(cat "$STAMP")"
