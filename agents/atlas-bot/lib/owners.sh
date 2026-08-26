#!/usr/bin/env bash
# Live LibreLoom Owners-team membership check. No static username list.
# Fail closed if the API cannot list the team.
set -euo pipefail

FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
ORG="${ATLAS_ORG:-LibreLoom}"
TEAM_NAME="${ATLAS_OWNERS_TEAM:-Owners}"
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
team_id="$(TEAM_NAME="${TEAM_NAME}" python3 -c '
import json,os,sys
name=os.environ["TEAM_NAME"]
teams=json.loads(sys.stdin.read())
for t in teams:
    if t.get("name","").lower()==name.lower():
        print(t["id"]); sys.exit(0)
sys.exit(3)
' <<<"${teams_json}")" || {
  echo "owners.sh: team ${TEAM_NAME} not found in ${ORG}" >&2
  exit 3
}

members_json="$(api "${FORGEJO_URL}/api/v1/teams/${team_id}/members?limit=100")"
python3 -c '
import json,sys
want=sys.argv[1].lower()
members=json.loads(sys.stdin.read())
logins=[(m.get("login") or m.get("username") or "") for m in members]
sys.exit(0 if any(l.lower()==want for l in logins if l) else 1)
' "${login}" <<<"${members_json}"
