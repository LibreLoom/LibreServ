#!/usr/bin/env bash
# Checks watch.sh's semver functions against infra/feed-testdata/cases.json.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CASES=${CASES:-$HERE/../feed-testdata/cases.json}
# shellcheck source=watch.sh
source "$HERE/watch.sh"
fail=0
mapfile -t asc < <(jq -r '.semver.ascending[]' "$CASES")
for v in "${asc[@]}"; do
	semver_valid "$v" || { echo "FAIL valid: $v"; fail=1; }
done
for ((i = 0; i + 1 < ${#asc[@]}; i++)); do
	[[ $(semver_cmp "${asc[i]}" "${asc[i + 1]}") == -1 ]] || { echo "FAIL ${asc[i]} < ${asc[i + 1]}"; fail=1; }
	[[ $(semver_cmp "${asc[i + 1]}" "${asc[i]}") == 1 ]] || { echo "FAIL ${asc[i + 1]} > ${asc[i]}"; fail=1; }
	[[ $(semver_cmp "${asc[i]}" "${asc[i]}") == 0 ]] || { echo "FAIL ${asc[i]} == self"; fail=1; }
done
while IFS= read -r v; do
	if semver_valid "$v"; then echo "FAIL should be invalid: '$v'"; fail=1; fi
done < <(jq -r '.semver.invalid[]' "$CASES")
((fail == 0)) && echo "semver ok (${#asc[@]} ascending, $(jq '.semver.invalid|length' "$CASES") invalid)"
exit "$fail"
