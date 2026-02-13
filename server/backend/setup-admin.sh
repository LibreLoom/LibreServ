#!/bin/bash
# Complete initial setup for LibreServ

cd /workspaces/LibreServ/server/backend

# Kill any existing server
pkill -f "libreserv serve" 2>/dev/null || true
sleep 2

# Start server in background
LIBRESERV_INSECURE_DEV=true ./bin/libreserv serve --config ./configs/libreserv.yaml &
SERVER_PID=$!
echo "Server started (PID: $SERVER_PID)"
sleep 4

echo ""
echo "=== Step 1: Check setup status ==="
curl -s http://localhost:8080/api/v1/setup/status | python3 -m json.tool 2>/dev/null || curl -s http://localhost:8080/api/v1/setup/status

echo ""
echo ""
echo "=== Step 2: Complete setup (create admin user) ==="
curl -s -X POST http://localhost:8080/api/v1/setup/complete \
  -H "Content-Type: application/json" \
  -d '{
    "admin_username": "admin",
    "admin_password": "hunter2",
    "admin_email": "admin@example.com"
  }' | python3 -m json.tool 2>/dev/null || curl -s -X POST http://localhost:8080/api/v1/setup/complete \
  -H "Content-Type: application/json" \
  -d '{"admin_username":"admin","admin_password":"hunter2","admin_email":"admin@example.com"}'

echo ""
echo ""
echo "=== Step 3: Test login ==="
LOGIN_RESULT=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"hunter2"}')
echo "$LOGIN_RESULT" | python3 -m json.tool 2>/dev/null || echo "$LOGIN_RESULT"

echo ""
echo ""
echo "=== Done! ==="
echo "You can now log in with:"
echo "  Username: admin"
echo "  Password: hunter2"
echo ""

# Keep server running
wait $SERVER_PID
