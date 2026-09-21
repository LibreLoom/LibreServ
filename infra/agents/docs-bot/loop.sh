#!/usr/bin/env bash
# Thin entrypoint — body lives in infra/agents/common/loop.sh.
# Kept so deployed compose files (old and new paths) keep working.
# pwd -P resolves the root `agents` symlink so old `agents/docs-bot/...`
# invocations find the real common/ directory.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BOT_NAME=docs-bot BOT_SCHEDULE_HOUR=04 exec "${HERE}/../common/loop.sh"
