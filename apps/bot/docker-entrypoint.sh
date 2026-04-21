#!/usr/bin/env bash
set -euo pipefail

child=""
xvfb_pid=""

trap 'echo "sending SIGABRT to child"; if [ -n "${child:-}" ]; then kill -SIGABRT "$child" 2>/dev/null || true; fi' SIGTERM SIGINT

cd /app

mkdir -p "${DEBUG_SCREENSHOT_ROOT:-debug-screenshots}" "${DEBUG_VIDEO_ROOT:-debug-videos}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
echo "Using XDG_RUNTIME_DIR: $XDG_RUNTIME_DIR"

if [ -z "${BROWSER_EXECUTABLE_PATH:-}" ] || [ ! -x "${BROWSER_EXECUTABLE_PATH:-}" ]; then
  for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$candidate" ]; then
      export BROWSER_EXECUTABLE_PATH="$candidate"
      break
    fi
  done
fi

echo "Using browser executable: ${BROWSER_EXECUTABLE_PATH:-not-found}"

Xvfb :99 -screen 0 1280x800x24 &
xvfb_pid=$!

sleep 1

echo "Initializing PulseAudio..."
pulseaudio --kill 2>/dev/null || true
sleep 1

pulseaudio -D --exit-idle-time=-1 --log-level=info 2>&1 || true
sleep 5

if pgrep -x "pulseaudio" > /dev/null; then
  echo "PulseAudio is running (PID: $(pgrep -x pulseaudio))"

  sink_id="$(pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description=Virtual_Output 2>&1 || true)"
  echo "Loaded null sink module (ID: $sink_id)"

  pactl set-default-sink virtual_output 2>&1 || true
  echo "Set virtual_output as default sink"

  if pactl list sources short | grep -q "virtual_output.monitor"; then
    echo "Monitor source virtual_output.monitor is available for ffmpeg"
  else
    echo "WARNING: Monitor source not found!"
  fi
else
  echo "ERROR: PulseAudio failed to start"
  ps aux | grep pulse || true
fi

DISPLAY=:99 npm run test:join -- "$@" &
child=$!

set +e
wait "$child"
child_exit_code=$?
set -e

tail --pid="$child" -f /dev/null || true

if [ -n "$xvfb_pid" ]; then
  kill -TERM "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" || true
fi

pulseaudio --kill 2>/dev/null || true

exit "$child_exit_code"
