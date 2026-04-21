# Meeting Bot

This repository is being built step by step.

## Current Scope

Implemented:
- project/workspace scaffolding
- NestJS backend bootstrap
- headed Playwright Google Meet join bot
- manual join API endpoint
- manual join CLI command

Not implemented yet:
- recorder service
- transcription service
- Redis queue
- Redis Streams
- frontend
- Docker

## Requirements

- Node.js 22+
- Google Chrome installed at `/usr/bin/google-chrome`, or set `BROWSER_EXECUTABLE_PATH`

## Install

```bash
npm install
```

Create a `.env` file from `.env.example` and set:

```bash
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
HEADLESS=true
DEBUG_SCREENSHOT_ROOT=debug-screenshots
PORT=3000
```

## Run Backend

```bash
npm run dev:backend
```

The backend starts on `http://localhost:3000`.

## Manual Test Via CLI

```bash
npm run test:join -- --url "https://meet.google.com/your-meeting-code" --name "Meeting Bot" --join-timeout-ms 45000 --stay-ms 10000
```

## Manual Test Via API

```bash
curl -X POST http://localhost:3000/bot/join \
  -H "Content-Type: application/json" \
  -d '{
    "meetUrl": "https://meet.google.com/your-meeting-code",
    "botDisplayName": "Meeting Bot",
    "joinTimeoutMs": 45000,
    "stayInMeetingMs": 10000
  }'
```

## Docker Bot Image

Build the bot image:

```bash
docker build -f apps/bot/Dockerfile -t meetingbot-bot .
```

Run it in headed mode inside a virtual display:

```bash
docker run --rm \
  --shm-size=1g \
  -e BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
  -e HEADLESS=false \
  -e DEBUG_SCREENSHOT_ROOT=debug-screenshots \
  -v "$(pwd)/debug-screenshots:/app/debug-screenshots" \
  meetingbot-bot \
  --url "https://meet.google.com/your-meeting-code" \
  --name "Meeting Bot" \
  --join-timeout-ms 45000 \
  --stay-ms 10000
```

## Notes

- Chromium runs in headless mode by default. Set `HEADLESS=false` if you want to watch the browser.
- The current bot only handles the meeting join flow.
- The bot goes directly to the Meet link and attempts a guest join.
- The join flow uses attribute/CSS selectors for the pre-join name, mic, camera, and join actions.
- Debug screenshots are saved for both headed and headless runs under `debug-screenshots/<timestamp-mode-sessionId>/`.
- The Docker image includes `xvfb`, so `HEADLESS=false` still works inside the container through a virtual display.
- Google Meet UI changes may require selector updates over time.
