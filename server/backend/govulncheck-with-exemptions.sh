#!/usr/bin/env bash
set -euo pipefail

EXCLUDE_FILE=".govulncheck-exemptions"
EXEMPTIONS=""

if [ -f "$EXCLUDE_FILE" ]; then
  EXEMPTIONS=$(grep -v '^#' "$EXCLUDE_FILE" | grep -v '^$' | tr '\n' '|' | sed 's/|$//')
fi

text_output=$(govulncheck "$@" 2>&1) || true
printf '%s\n' "$text_output"

if ! echo "$text_output" | grep -q "Vulnerability"; then
  exit 0
fi

if [ -z "$EXEMPTIONS" ]; then
  exit 3
fi

vuln_ids=$(echo "$text_output" | grep -oP 'Vulnerability #\d+: \KGO-\d+-\d+' | sort -u)

has_unexempted=false
for v in $vuln_ids; do
  if ! echo "$v" | grep -qE "^($EXEMPTIONS)$"; then
    has_unexempted=true
    break
  fi
done

if [ "$has_unexempted" = true ]; then
  exit 3
fi

exit 0
