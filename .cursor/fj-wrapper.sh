#!/usr/bin/env bash
# Pin fj to LibreServ on Forgejo without touching git remotes.
# Cursor's default remote stays whatever host the agent spawned from.
set -euo pipefail

REAL="${FJ_REAL:-/usr/local/libexec/fj}"
HOST="gt.plainskill.net"
REPO="LibreLoom/LibreServ"
export FJ_FALLBACK_HOST="https://${HOST}"

if [ ! -x "$REAL" ]; then
  echo "fj: real binary not found at ${REAL}" >&2
  exit 127
fi

has_flag() {
  local needle="$1"
  shift
  local a
  for a in "$@"; do
    case "$a" in
      "${needle}" | "${needle}"=*) return 0 ;;
    esac
  done
  return 1
}

args=("$@")
extra=()
if ! has_flag -H "${args[@]+"${args[@]}"}" && ! has_flag --host "${args[@]+"${args[@]}"}"; then
  extra+=(-H "${HOST}")
fi

cmd=""
for a in "${args[@]+"${args[@]}"}"; do
  case "$a" in
    -*) continue ;;
    *)
      cmd="$a"
      break
      ;;
  esac
done

inject_repo=0
case "${cmd}" in
  issue | pr | release | tag | actions | wiki) inject_repo=1 ;;
esac

if [ "${inject_repo}" -eq 1 ] &&
  ! has_flag -r "${args[@]+"${args[@]}"}" &&
  ! has_flag --repo "${args[@]+"${args[@]}"}" &&
  ! has_flag -R "${args[@]+"${args[@]}"}" &&
  ! has_flag --remote "${args[@]+"${args[@]}"}"; then
  rebuilt=()
  nonopt=0
  inserted=0
  i=0
  n=${#args[@]}
  while [ "${i}" -lt "${n}" ]; do
    a="${args[$i]}"
    rebuilt+=("${a}")
    case "${a}" in
      -*) ;;
      *)
        nonopt=$((nonopt + 1))
        if [ "${inserted}" -eq 0 ]; then
          next=""
          next_i=$((i + 1))
          if [ "${next_i}" -lt "${n}" ]; then
            next="${args[$next_i]}"
          fi
          if [ -n "${next}" ] && [ "${next#-}" = "${next}" ]; then
            if [ "${nonopt}" -ge 2 ]; then
              rebuilt+=(-r "${REPO}")
              inserted=1
            fi
          else
            rebuilt+=(-r "${REPO}")
            inserted=1
          fi
        fi
        ;;
    esac
    i=$((i + 1))
  done
  if [ "${inserted}" -eq 0 ]; then
    rebuilt+=(-r "${REPO}")
  fi
  exec "${REAL}" "${extra[@]}" "${rebuilt[@]}"
fi

exec "${REAL}" "${extra[@]}" "${args[@]+"${args[@]}"}"
