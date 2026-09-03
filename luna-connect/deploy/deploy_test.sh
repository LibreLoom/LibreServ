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

assert_true() {
    local desc="$1"
    shift
    if "$@"; then
        pass=$((pass + 1))
        echo "  ok  $desc"
    else
        fail=$((fail + 1))
        echo "  FAIL $desc"
    fi
}

setup_repo() {
    local tmp bare
    tmp="$(mktemp -d)"
    bare="$(mktemp -d)"
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
        git init --bare -q "$bare"
        git remote add origin "$bare"
        git push -q origin main
        git push -q origin --tags
        git fetch -q origin
    )
    echo "$tmp"
}

run_tests() {
    local repo
    repo="$(setup_repo)"
    # shellcheck disable=SC2164
    cd "$repo"

    echo "resolve_deploy_mode on main (default → latest tag)"
    assert_eq "main default" "tag:luna-connect-v0.2.17" "$(resolve_deploy_mode "" 0)"
    assert_eq "--head" "head" "$(resolve_deploy_mode "HEAD" 0)"
    assert_eq "--tag explicit" "tag:luna-connect-v0.2.15" "$(resolve_deploy_mode "luna-connect-v0.2.15" 0)"
    assert_eq "--latest-tag" "tag:luna-connect-v0.2.17" "$(resolve_deploy_mode "" 1)"

    git checkout -q luna-connect-v0.2.15
    echo "resolve_deploy_mode on detached tag (no flags → latest tag)"
    assert_eq "detached default" "tag:luna-connect-v0.2.17" "$(resolve_deploy_mode "" 0)"

    git checkout -q -b feature
    echo "resolve_deploy_mode on feature branch (no flags → latest tag)"
    assert_eq "feature default" "tag:luna-connect-v0.2.17" "$(resolve_deploy_mode "" 0)"
    assert_eq "feature --head" "head" "$(resolve_deploy_mode "HEAD" 0)"
    assert_eq "feature --no-pull" "head" "$(resolve_deploy_mode "HEAD" 0)"

    git checkout -q main
    echo "sync_head_checkout --head checks out main"
    git checkout -q -b other
    sync_head_checkout 0 1 ""
    assert_eq "after --head sync" "main" "$(current_branch_name)"

    echo "sync_head_checkout clobbers divergent local commits and dirt"
    local origin_tip
    origin_tip="$(git rev-parse origin/main)"
    echo "local-only" >>README.md
    git add README.md
    git commit -q -m "divergent local commit"
    echo "untracked-junk" >junk.txt
    echo "more-dirt" >>README.md
    sync_head_checkout 0 1 ""
    assert_eq "still on main after clobber" "main" "$(current_branch_name)"
    assert_eq "HEAD matches origin/main" "$origin_tip" "$(git rev-parse HEAD)"
    assert_true "untracked junk cleaned" test ! -e junk.txt
    assert_true "working tree clean" test -z "$(git status --porcelain)"

    echo "checkout_deploy_ref --tag clobbers to tag"
    echo "tag-dirt" >tag-dirt.txt
    checkout_deploy_ref "tag" "luna-connect-v0.2.15"
    assert_eq "tag HEAD" "$(git rev-parse luna-connect-v0.2.15^{commit})" "$(git rev-parse HEAD)"
    assert_true "tag dirt cleaned" test ! -e tag-dirt.txt

    echo ""
    echo "Results: ${pass} passed, ${fail} failed"
    rm -rf "$repo"
    [ "$fail" -eq 0 ]
}

run_tests
