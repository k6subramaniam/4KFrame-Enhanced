#!/usr/bin/env bash
#
# Launch Chromium full-screen (kiosk) pointing at the 4KFrame display, for a dedicated
# display device such as a Raspberry Pi wired to a TV.
#
#   FRAME_URL=http://<host-ip>:9095/ 4kframe-kiosk.sh
#
# Defaults to the local server. Intended to be run from a graphical session (see
# 4kframe-kiosk.service and DEPLOY.md).
set -euo pipefail

FRAME_URL="${FRAME_URL:-http://localhost:9095/}"
export DISPLAY="${DISPLAY:-:0}"

# Keep the screen awake (best-effort; ignore if the tools are absent).
xset s off || true
xset -dpms || true
xset s noblank || true
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.1 -root &

# Use whichever Chromium/Chrome binary is installed.
BIN="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
if [ -z "$BIN" ]; then
  echo "No Chromium/Chrome found. Install it, e.g.: sudo apt install -y chromium-browser" >&2
  exit 1
fi

exec "$BIN" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --app="$FRAME_URL"
