#!/bin/sh
# Report source files that have no tests next to them. Informational only:
# it always exits 0, so a missing test never fails CI — it just shows up in the log.
#
#   Rust: a file counts as tested when it holds a `#[cfg(test)]` module or has a
#         `<name>/tests.rs`-style test module beside it.
#   Web:  a file counts as tested when `<name>.test.<ext>` sits next to it.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

missing_rust=0
echo "==> Rust files without tests (crates/lunad, crates/luna-core)"
for f in $(find crates -name '*.rs' -path '*/src/*' ! -path '*/bin/*' ! -name 'main.rs' ! -name 'tests.rs' ! -name '*_tests.rs' | sort); do
	base="${f%.rs}"
	if grep -q '#\[cfg(test)\]' "$f" 2>/dev/null; then continue; fi
	# `foo.rs` with `foo/tests.rs` or `foo/*_tests.rs`; `foo/mod.rs` with `foo/tests.rs`.
	dir="$base"
	[ "$(basename "$f")" = "mod.rs" ] && dir="$(dirname "$f")"
	if [ -f "$dir/tests.rs" ] || ls "$dir"/*_tests.rs >/dev/null 2>&1; then continue; fi
	# Re-export-only and tiny files are not worth listing.
	[ "$(wc -l <"$f")" -lt 25 ] && continue
	echo "    $f"
	missing_rust=$((missing_rust + 1))
done
echo "    ($missing_rust without tests)"

missing_web=0
echo "==> Web files without tests (web/src lib, hooks, components)"
for f in $(find web/src/lib web/src/hooks web/src/components web/src/pages -type f \( -name '*.js' -o -name '*.jsx' \) ! -name '*.test.*' | sort); do
	ext="${f##*.}"
	[ -f "${f%.$ext}.test.$ext" ] && continue
	[ -f "${f%.$ext}.test.js" ] && continue
	[ -f "${f%.$ext}.test.jsx" ] && continue
	[ "$(wc -l <"$f")" -lt 25 ] && continue
	echo "    $f"
	missing_web=$((missing_web + 1))
done
echo "    ($missing_web without tests)"
exit 0
