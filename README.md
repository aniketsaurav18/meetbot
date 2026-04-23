# Meeting Bot

This repository contains a Google Meet bot flow with:

- an Express backend that queues sessions in BullMQ/Redis
- a separate worker service that consumes the queue and launches one bot container per meeting
- a Playwright bot container that joins the meeting and streams audio chunks
- a transcription service that receives chunks over WebSocket and writes transcript updates to Redis Streams

## Current Scope

Implemented:
- Express backend API
- BullMQ + Redis job queue
- Playwright Google Meet join bot
- transcription service with Redis Streams
- Dockerfiles for all apps
- `docker-compose.yml` for local startup

Not implemented yet:
- frontend

## Requirements

- Node.js 22+
- Google Chrome installed at `/usr/bin/google-chrome`, or set `BROWSER_EXECUTABLE_PATH`

## Install

```bash
npm install
```

Create a `.env` file from `.env.example` and set:

```bash
PORT=3000
REDIS_URL=redis://redis:6379
GROQ_API_KEY=your-groq-api-key
TRANSCRIPTION_WS_URL=ws://transcription:6666/ws
INTERNAL_API_TOKEN=
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
HEADLESS=true
DEBUG_SCREENSHOT_ROOT=debug-screenshots
DEBUG_VIDEO_ROOT=debug-videos
```

## Run With Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Services:

- backend: `http://localhost:3000`
- worker: consumes BullMQ jobs and launches per-request bot containers
- transcription: `http://localhost:6666`
- redis: `localhost:6379`

## Run Backend Only

```bash
npm run dev:backend
```

## Manual Test Via CLI

```bash
npm run test:join -- --url "https://meet.google.com/your-meeting-code" --name "Meeting Bot" --join-timeout-ms 45000 --stay-ms 10000
```

## Manual Test Via API

```bash
curl -X POST http://localhost:3000/sessions \
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
- The backend container stays slim and only enqueues jobs plus serves session state.
- The worker service talks to Docker and launches a fresh bot container for each queued meeting request.
- Google Meet UI changes may require selector updates over time.
