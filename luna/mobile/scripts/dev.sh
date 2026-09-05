#!/usr/bin/env bash
# Rapid-dev loop for Luna Android:
#   - requires an emulator or device on adb
#   - mints a Luna access token
#   - installDebug + relaunch on every save under app/src
#   - first launch (or LUNA_MOBILE_REPAIR=1) opens luna://pair; DEBUG auto-signs in
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_ID="${LUNA_MOBILE_APP_ID:-net.plainskill.luna}"
ACTIVITY="${LUNA_MOBILE_ACTIVITY:-.LoginActivity}"
HOST_URL="${LUNA_MOBILE_HOST_URL:-${LUNA_DESKTOP_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}}"
DEVICE_URL="${LUNA_MOBILE_URL:-}"
REPAIR="${LUNA_MOBILE_REPAIR:-0}"
DEBOUNCE_MS="${LUNA_MOBILE_DEBOUNCE_MS:-400}"

if [ -z "${ANDROID_HOME:-}" ] && [ -d /usr/local/android-sdk ]; then
  export ANDROID_HOME=/usr/local/android-sdk
  export ANDROID_SDK_ROOT=/usr/local/android-sdk
fi
if [ -n "${ANDROID_HOME:-}" ]; then
  export PATH="${ANDROID_HOME}/platform-tools:${PATH}"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f local.properties ]; then
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found. Install Android platform-tools or set ANDROID_HOME." >&2
  exit 1
fi

adb start-server >/dev/null
if ! adb get-state >/dev/null 2>&1; then
  echo "No Android device/emulator on adb." >&2
  echo "Start an emulator or plug in a phone with USB debugging, then retry." >&2
  exit 1
fi

# Device URL: explicit env wins; emulator → 10.0.2.2; physical → host LAN IP.
if [ -z "$DEVICE_URL" ]; then
  serial="$(adb get-serialno 2>/dev/null || true)"
  port_part="${HOST_URL##*:}"
  port_part="${port_part:-8090}"
  if [[ "$serial" == emulator-* ]]; then
    # Emulator loopback-to-host alias; PrivateLan allows 10.x cleartext.
    DEVICE_URL="http://10.0.2.2:${port_part}"
  else
    lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -z "$lan_ip" ] || [[ "$HOST_URL" == *127.0.0.1* ]] || [[ "$HOST_URL" == *localhost* ]]; then
      if [ -z "$lan_ip" ]; then
        echo "Set LUNA_MOBILE_URL to a URL this phone can reach (not 127.0.0.1)." >&2
        exit 1
      fi
    fi
    DEVICE_URL="http://${lan_ip}:${port_part}"
  fi
fi

export LUNA_MOBILE_HOST_URL="$HOST_URL"
bash "$ROOT/scripts/ensure-dev-token.sh"

TOKEN="$(tr -d '\n' <"$ROOT/.dev/token")"
PAIR_URI="$(DEVICE_URL="$DEVICE_URL" TOKEN="$TOKEN" python3 - <<'PY'
from urllib.parse import quote
import os
url = os.environ["DEVICE_URL"]
token = os.environ["TOKEN"]
print(f"luna://pair?url={quote(url, safe='')}&token={quote(token, safe='')}")
PY
)"

install_and_launch() {
  local mode="${1:-restart}"
  echo "==> Building + installing debug APK"
  ./gradlew installDebug --quiet

  echo "==> Relaunching $APP_ID"
  adb shell am force-stop "$APP_ID" >/dev/null || true

  if [ "$REPAIR" = "1" ] || [ "$mode" = "pair" ]; then
    echo "    Pairing via $DEVICE_URL"
    adb shell am start -a android.intent.action.VIEW -d "$PAIR_URI" "${APP_ID}/${ACTIVITY}" >/dev/null
  else
    # Session usually survives reinstall; bring the app forward.
    adb shell am start -n "${APP_ID}/${ACTIVITY}" >/dev/null \
      || adb shell am start -a android.intent.action.VIEW -d "$PAIR_URI" "${APP_ID}/${ACTIVITY}" >/dev/null
  fi
  echo "==> Ready. Save under app/src to rebuild."
}

echo "==> Luna Android rapid-dev"
echo "    device serial: $(adb get-serialno)"
echo "    host Luna:     $HOST_URL"
echo "    app Luna URL:  $DEVICE_URL"
echo "    Save Kotlin/XML under app/ to installDebug + relaunch."
echo "    LUNA_MOBILE_REPAIR=1 forces a fresh luna://pair sign-in."
echo "    Ctrl-C stops the watcher."

# First install always pairs so DEBUG auto-login can land you in Setup/Shell.
install_and_launch pair
REPAIR=0

watch_paths=(app/src app/build.gradle.kts build.gradle.kts settings.gradle.kts)
if command -v inotifywait >/dev/null 2>&1; then
  while true; do
    inotifywait -r -e modify,create,delete,move \
      --exclude '(/build/|\.gradle/|\.idea/)' \
      "${watch_paths[@]}" >/dev/null 2>&1 || true
    sleep "$(python3 -c "print(${DEBOUNCE_MS}/1000)")"
    while inotifywait -r -t 1 -e modify,create,delete,move \
      --exclude '(/build/|\.gradle/|\.idea/)' \
      "${watch_paths[@]}" >/dev/null 2>&1; do
      :
    done
    install_and_launch restart || echo "==> install failed; fix the error and save again" >&2
  done
else
  echo "==> inotifywait not found; falling back to 2s mtime polling"
  stamp() {
    find app/src app/build.gradle.kts build.gradle.kts settings.gradle.kts \
      -type f -printf '%T@ %p\n' 2>/dev/null | sort | sha256sum | awk '{print $1}'
  }
  prev="$(stamp)"
  while true; do
    sleep 2
    now="$(stamp)"
    if [ "$now" != "$prev" ]; then
      prev="$now"
      install_and_launch restart || echo "==> install failed; fix the error and save again" >&2
    fi
  done
fi
