#!/bin/bash
# Unit tests for deploy.sh ref resolution (no root / systemctl required).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy.sh
source "$SCRIPT_DIR/deploy.sh"

pass=0
fail=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass=$((pass + 1))
        echo "  ok  $desc"
    else
        fail=$((fail + 1))
        echo "  FAIL $desc"
        echo "       expected: $expected"
        echo "       actual:   $actual"
    fi
}

assert_fail() {
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        fail=$((fail + 1))
        echo "  FAIL $desc (expected failure)"
    else
        pass=$((pass + 1))
        echo "  ok  $desc"
    fi
}

setup_repo() {
    local tmp
    tmp="$(mktemp -d)"
    (
        cd "$tmp"
        git init -q
        git config user.email "test@example.com"
        git config user.name "Test"
        echo "v1" >README.md
        git add README.md
        git commit -q -m "init"
        git branch -M main
        git tag luna-connect-v0.2.15
        echo "v2" >>README.md
        git add README.md
        git commit -q -m "ahead on main"
        git tag luna-connect-v0.2.17
    )
    echo "$tmp"
}

run_tests() {
    local repo
    repo="$(setup_repo)"
    # shellcheck disable=SC2164
    cd "$repo"

    echo "resolve_deploy_mode on main (default → head)"
    assert_eq "main default" "head" "$(resolve_deploy_mode "" 0)"
    assert_eq "--head" "head" "$(resolve_deploy_mode "HEAD" 0)"
    assert_eq "--tag explicit" "tag:luna-connect-v0.2.15" "$(resolve_deploy_mode "luna-connect-v0.2.15" 0)"
    assert_eq "--latest-tag" "tag:luna-connect-v0.2.17" "$(resolve_deploy_mode "" 1)"

    git checkout -q luna-connect-v0.2.15
    echo "resolve_deploy_mode on detached tag (no flags → error)"
    assert_fail "detached HEAD refuses" resolve_deploy_mode "" 0

    git checkout -q -b feature
    echo "resolve_deploy_mode on feature branch (no flags → error)"
    assert_fail "feature branch refuses" resolve_deploy_mode "" 0
    assert_eq "feature --head" "head" "$(resolve_deploy_mode "HEAD" 0)"

    echo ""
    echo "Results: ${pass} passed, ${fail} failed"
    rm -rf "$repo"
    [ "$fail" -eq 0 ]
}

run_tests
