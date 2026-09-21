#!/usr/bin/env bash
# Live membership check: LibreLoom Owners or atlas-bot team.
# No static username list. Fail closed if the API cannot list teams.
set -euo pipefail

FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
ORG="${ATLAS_ORG:-LibreLoom}"
TEAM_NAMES="${ATLAS_ACCESS_TEAMS:-${ATLAS_OWNERS_TEAM:-Owners},atlas-bot}"
if [[ -z "${ATLAS_BOT_TOKEN:-}" ]]; then
  echo "owners.sh: ATLAS_BOT_TOKEN is required (will not fall back to FORGEJO_TOKEN)" >&2
  exit 2
fi
TOKEN="${ATLAS_BOT_TOKEN}"

api() {
  curl -fsS -H "Authorization: token ${TOKEN}" -H "Accept: application/json" "$@"
}

login="${1:-}"
if [[ -z "${login}" ]]; then
  echo "usage: owners.sh <forgejo-login>" >&2
  exit 2
fi

teams_json="$(api "${FORGEJO_URL}/api/v1/orgs/${ORG}/teams?limit=50")"
mapfile -t TEAM_IDS < <(TEAM_NAMES="${TEAM_NAMES}" python3 -c '
import json, os, sys
wanted = [n.strip().lower() for n in os.environ["TEAM_NAMES"].split(",") if n.strip()]
teams = json.loads(sys.stdin.read())
found = []
for t in teams:
    name = (t.get("name") or "").lower()
    if name in wanted and t.get("id") is not None:
        found.append(str(t["id"]))
if not found:
    sys.exit(3)
print("\n".join(found))
' <<<"${teams_json}") || {
  echo "owners.sh: none of [${TEAM_NAMES}] found in ${ORG}" >&2
  exit 3
}

for team_id in "${TEAM_IDS[@]}"; do
  members_json="$(api "${FORGEJO_URL}/api/v1/teams/${team_id}/members?limit=100")"
  if python3 -c '
import json,sys
want=sys.argv[1].lower()
members=json.loads(sys.stdin.read())
logins=[(m.get("login") or m.get("username") or "") for m in members]
sys.exit(0 if any(l.lower()==want for l in logins if l) else 1)
' "${login}" <<<"${members_json}"; then
    exit 0
  fi
done
exit 1
