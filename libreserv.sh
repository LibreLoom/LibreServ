#!/bin/bash

# ------------------------
# Config file for saved paths
# ------------------------
CONFIG_FILE="$HOME/.libreserv_paths"

# Load paths if config exists
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

# Defaults if not already set
BACKEND_PATH=${BACKEND_PATH:-$(pwd)}
FRONTEND_PATH=${FRONTEND_PATH:-$(pwd)/frontend}
BACKEND_PID_FILE="$BACKEND_PATH/backend.pid"

# ------------------------
# Functions
# ------------------------

save_paths() {
    echo "Saving backend/frontend paths to $CONFIG_FILE"
    cat > "$CONFIG_FILE" <<EOF
BACKEND_PATH="$BACKEND_PATH"
FRONTEND_PATH="$FRONTEND_PATH"
EOF
    echo "Paths saved!"
}


# Help message
show_help() {
    cat <<EOF
Usage: $0 <command> [backend|frontend] [backend_path] [frontend_path]

Commands:
  adduser <user> <pass> <email>    Create a new admin user
  start [backend|frontend]         Start backend and/or frontend
  stop [backend|frontend]          Stop backend and/or frontend
  status [backend|frontend]        Show status of backend and/or frontend
  restart [backend|frontend]       Restart backend and/or frontend
  help                             Show this help message

Notes:
  - If no target is specified, commands act on both backend and frontend.
  - You can specify paths after targets to override defaults:
      BACKEND_PATH defaults to current directory
      FRONTEND_PATH defaults to ./frontend
  - Examples:
      $0 start
      $0 start backend /srv/libreserv
      $0 start frontend /srv/libreserv/frontend
      $0 adduser alice supersecret alice@example.com

Security Warning:
  - Passwords passed on command line are visible in process lists and shell history
  - Consider using environment variables: LIBRESERV_USER=alice LIBRESERV_PASS=secret $0 adduser
EOF
}

# ------------------------
# User setup
# ------------------------
adduser() {
    local username=$1
    local pass=$2
    local mail=$3

    # Allow reading from environment if not provided
    [ -z "$username" ] && username="$LIBRESERV_USER"
    [ -z "$pass" ] && pass="$LIBRESERV_PASS"
    [ -z "$mail" ] && mail="$LIBRESERV_EMAIL"

    if [ -z "$username" ] || [ -z "$pass" ] || [ -z "$mail" ]; then
        echo "Error: Missing required arguments"
        echo "Usage: $0 adduser <user> <pass> <email>"
        echo "   or: LIBRESERV_USER=<user> LIBRESERV_PASS=<pass> LIBRESERV_EMAIL=<email> $0 adduser"
        return 1
    fi

    # Basic email validation
    if [[ ! "$mail" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
        echo "Error: Invalid email format"
        return 1
    fi

    # Check if backend is running
    if [ -f "$BACKEND_PID_FILE" ]; then
        PID=$(cat "$BACKEND_PID_FILE")
        if ! ps -p "$PID" > /dev/null 2>&1; then
            echo "Error: Backend is not running. Start it first with: $0 start backend"
            return 1
        fi
    else
        echo "Error: Backend is not running. Start it first with: $0 start backend"
        return 1
    fi

    # Escape JSON special characters in inputs
    username_escaped=$(echo "$username" | sed 's/\\/\\\\/g; s/"/\\"/g')
    pass_escaped=$(echo "$pass" | sed 's/\\/\\\\/g; s/"/\\"/g')
    mail_escaped=$(echo "$mail" | sed 's/\\/\\\\/g; s/"/\\"/g')

    if curl -s -f -X POST http://localhost:8080/api/v1/setup/complete \
        -H "Content-Type: application/json" \
        -d "{\"admin_username\": \"$username_escaped\", \"admin_password\": \"$pass_escaped\", \"admin_email\": \"$mail_escaped\"}" > /dev/null; then
        echo "User setup completed successfully."
        return 0
    else
        echo "Error: Failed to complete user setup. Check backend logs."
        return 1
    fi
}

# ------------------------
# Setup functions
# ------------------------

setup() {
    # ------------------------
    # Backend
    # ------------------------
    cd server/backend || { echo "Backend directory not found"; return 1; }
    if ! go build ./cmd/libreserv; then
        echo "Backend setup failed"
        return 1
    fi
    cd - > /dev/null || return 1   # return to previous directory silently

    # ------------------------
    # Frontend
    # ------------------------
    cd ../frontend || { echo "Frontend directory not found"; return 1; }
    if ! npm install; then
        echo "Frontend setup failed"
        return 1
    fi
    cd - > /dev/null || return 1   # return to previous directory silently

    echo "Setup successful. Run ./libreserv.sh help to get started."
}

# ------------------------
# Backend functions
# ------------------------
startback() {
    # Update PID file path with current BACKEND_PATH
    BACKEND_PID_FILE="$BACKEND_PATH/backend.pid"

    # Check if already running
    if [ -f "$BACKEND_PID_FILE" ]; then
        PID=$(cat "$BACKEND_PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Backend already running (PID: $PID)"
            return 1
        else
            echo "Removing stale PID file"
            rm -f "$BACKEND_PID_FILE"
        fi
    fi

    echo "Starting backend at $BACKEND_PATH..."
    cd "$BACKEND_PATH" || return 1
    ./libreserv serve &
    BACKEND_PID=$!

    # Wait a moment to ensure process started
    sleep 1

    if ps -p "$BACKEND_PID" > /dev/null 2>&1; then
        echo "$BACKEND_PID" > "$BACKEND_PID_FILE"
        echo "Backend started (PID: $BACKEND_PID)"
        return 0
    else
        echo "Error: Failed to start backend"
        return 1
    fi
}

stopback() {
    BACKEND_PID_FILE="$BACKEND_PATH/backend.pid"

    if [ -f "$BACKEND_PID_FILE" ]; then
        PID=$(cat "$BACKEND_PID_FILE")
        if kill "$PID" 2>/dev/null; then
            echo "Backend stopped (PID: $PID)"
            rm -f "$BACKEND_PID_FILE"
            return 0
        else
            echo "Backend process not running, removing stale PID file"
            rm -f "$BACKEND_PID_FILE"
            return 1
        fi
    else
        echo "Backend not running (PID file not found)"
        return 1
    fi
}		

statusback() {
    BACKEND_PID_FILE="$BACKEND_PATH/backend.pid"

    if [ -f "$BACKEND_PID_FILE" ]; then
        PID=$(cat "$BACKEND_PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Backend running (PID: $PID)"
            return 0
        else
            echo "Backend not running (stale PID file)"
            return 1
        fi
    else
        echo "Backend not running"
        return 1
    fi
}

# ------------------------
# Frontend functions
# ------------------------
startfront() {
    # Check if already running
    if [ -f "$FRONTEND_PATH/frontend.pid" ]; then
        PID=$(cat "$FRONTEND_PATH/frontend.pid")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Frontend already running (PID: $PID)"
            return 1
        else
            echo "Removing stale PID file"
            rm -f "$FRONTEND_PATH/frontend.pid"
        fi
    fi

    # Check if directory exists
    if [ ! -d "$FRONTEND_PATH" ]; then
        echo "Error: Frontend directory not found at $FRONTEND_PATH"
        return 1
    fi

    # Check if package.json exists
    if [ ! -f "$FRONTEND_PATH/package.json" ]; then
        echo "Error: package.json not found in $FRONTEND_PATH"
        return 1
    fi

    echo "Starting frontend at $FRONTEND_PATH..."
    cd "$FRONTEND_PATH" || return 1

    # Start npm and capture the process group
    setsid npm run dev > /dev/null 2>&1 &
    FRONTEND_PID=$!

    # Wait a moment to ensure process started
    sleep 1

    if ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
        echo "$FRONTEND_PID" > "$FRONTEND_PATH/frontend.pid"
        echo "Frontend started (PID: $FRONTEND_PID)"
        return 0
    else
        echo "Error: Failed to start frontend"
        return 1
    fi
}

stopfront() {
    if [ -f "$FRONTEND_PATH/frontend.pid" ]; then
        PID=$(cat "$FRONTEND_PATH/frontend.pid")

        # Kill the entire process group to stop npm and all child processes
        if ps -p "$PID" > /dev/null 2>&1; then
            # Get the process group ID
            PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')

            # Kill the process group
            if [ -n "$PGID" ]; then
                kill -- -"$PGID" 2>/dev/null
            else
                kill "$PID" 2>/dev/null
            fi

            echo "Frontend stopped (PID: $PID)"
            rm -f "$FRONTEND_PATH/frontend.pid"
            return 0
        else
            echo "Frontend process not running, removing stale PID file"
            rm -f "$FRONTEND_PATH/frontend.pid"
            return 1
        fi
    else
        echo "Frontend not running (PID file not found)"
        return 1
    fi
}

statusfront() {
    if [ -f "$FRONTEND_PATH/frontend.pid" ]; then
        PID=$(cat "$FRONTEND_PATH/frontend.pid")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Frontend running (PID: $PID)"
            return 0
        else
            echo "Frontend not running (stale PID file)"
            return 1
        fi
    else
        echo "Frontend not running"
        return 1
    fi
}

# ------------------------
# Parse command-line arguments
# ------------------------
if [ $# -lt 1 ]; then
    show_help
    exit 1
fi

command=$1
shift

# Save adduser arguments before they get consumed by path parsing
if [ "$command" = "adduser" ]; then
    ADDUSER_USERNAME="$1"
    ADDUSER_PASS="$2"
    ADDUSER_EMAIL="$3"
fi

TARGET_BACKEND=0
TARGET_FRONTEND=0

while [ $# -gt 0 ]; do
    case "$1" in
        backend)
            TARGET_BACKEND=1
            shift
            if [ $# -gt 0 ] && [[ ! "$1" =~ ^(frontend|backend)$ ]]; then
                BACKEND_PATH="$1"
                BACKEND_PID_FILE="$BACKEND_PATH/backend.pid"
                shift
                save_paths   # save paths if user overrides
            fi
            ;;
        frontend)
            TARGET_FRONTEND=1
            shift
            if [ $# -gt 0 ] && [[ ! "$1" =~ ^(frontend|backend)$ ]]; then
                FRONTEND_PATH="$1"
                shift
                save_paths   # save paths if user overrides
            fi
            ;;
        *)
            if [ "$command" = "adduser" ]; then
                break
            fi
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# Default to both if no target specified (except for adduser)
if [ "$command" != "adduser" ]; then
    [ $TARGET_BACKEND -eq 0 ] && [ $TARGET_FRONTEND -eq 0 ] && TARGET_BACKEND=1 && TARGET_FRONTEND=1
fi

# ------------------------
# Command dispatch
# ------------------------
case "$command" in
    adduser)
        adduser "$ADDUSER_USERNAME" "$ADDUSER_PASS" "$ADDUSER_EMAIL"
        exit $?
        ;;
    start)
        EXIT_CODE=0
        [ $TARGET_BACKEND -eq 1 ] && { startback || EXIT_CODE=$?; }
        [ $TARGET_FRONTEND -eq 1 ] && { startfront || EXIT_CODE=$?; }
        exit $EXIT_CODE
        ;;
    stop)
        EXIT_CODE=0
        [ $TARGET_BACKEND -eq 1 ] && { stopback || EXIT_CODE=$?; }
        [ $TARGET_FRONTEND -eq 1 ] && { stopfront || EXIT_CODE=$?; }
        exit $EXIT_CODE
        ;;
    status)
        EXIT_CODE=0
        [ $TARGET_BACKEND -eq 1 ] && { statusback || EXIT_CODE=$?; }
        [ $TARGET_FRONTEND -eq 1 ] && { statusfront || EXIT_CODE=$?; }
        exit $EXIT_CODE
        ;;
    setup)
        setup
        exit $?
        ;;
    restart)
        EXIT_CODE=0
        if [ $TARGET_BACKEND -eq 1 ]; then
            stopback
            startback || EXIT_CODE=$?
        fi
        if [ $TARGET_FRONTEND -eq 1 ]; then
            stopfront
            startfront || EXIT_CODE=$?
        fi
        exit $EXIT_CODE
        ;;
    help)
        show_help
        exit 0
        ;;
    *)
        echo "Unknown command: $command"
        echo "Use '$0 help' for usage information."
        exit 1
        ;;
esac
