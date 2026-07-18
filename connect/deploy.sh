#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="pscA"
REMOTE_DIR="/stack/compose/connect"
GO="${GO:-go}"

echo ">> Building customer frontend..."
cd "$ROOT/web/customer"
npm install --silent
npm run build

echo ">> Building admin frontend..."
cd "$ROOT/web/admin"
npm install --silent
npm run build

echo ">> Copying frontend builds to embed dirs..."
cp -r "$ROOT/web/admin/dist/"* "$ROOT/internal/api/admin/dist/"
cp -r "$ROOT/web/customer/dist/"* "$ROOT/internal/api/customer/dist/"

echo ">> Building Go binary (CGO for sqlite3)..."
cd "$ROOT"
CGO_ENABLED=1 $GO build -o bin/connect-server -ldflags="-s -w" ./cmd/server

echo ">> Deploying to pscA..."
scp bin/connect-server "$REMOTE:$REMOTE_DIR/connect-server"
scp Dockerfile "$REMOTE:$REMOTE_DIR/Dockerfile"
scp docker-compose.yml "$REMOTE:$REMOTE_DIR/docker-compose.yml"
rm -f bin/connect-server

echo ">> Building image + pushing to registry + recreating container..."
ssh "$REMOTE" "chmod 755 $REMOTE_DIR/connect-server && cd $REMOTE_DIR && docker build -t localhost:5000/atlas/connect:rootless . && docker push localhost:5000/atlas/connect:rootless && docker compose up -d --force-recreate"

echo ">> Verifying..."
sleep 3
STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://connect.serv.libreloom.org/healthz || echo "000")
if [ "$STATUS" = "200" ]; then
    echo ">> Live. Health check returned 200."
else
    echo ">> WARNING: health check returned $STATUS"
    ssh "$REMOTE" "docker logs connect --tail 10"
    exit 1
fi
