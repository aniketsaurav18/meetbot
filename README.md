# Meetingbot

A small stack for joining video meetings, recording audio, and streaming transcripts.

## Apps at a glance

- **bot** — Playwright-based process that joins a meeting, captures audio, and talks to the transcription service over WebSockets.
- **backend** — NestJS API that owns session state, exposes HTTP for the UI, and enqueues join work on Redis/BullMQ.
- **frontend** — Vite + React dashboard to start a session from a meet URL and watch status plus live transcript chunks.
- **worker** — BullMQ worker that pulls join jobs and runs the bot (typically in Docker) with the right env and volumes.
- **transcription** — Standalone HTTP/WebSocket service that accepts audio streams and turns them into text (e.g. via Groq), with optional debug audio dumps.

## Build and run with Docker Compose

You need [Docker](https://docs.docker.com/get-docker/) and the [Compose plugin](https://docs.docker.com/compose/install/) (`docker compose`).

1. From the repo root, create env file and set at least **Groq** for transcription:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set `GROQ_API_KEY`.

2. Build images and start every service:

   ```bash
   docker compose up --build
   ```

   Add `-d` if you want containers in the background.

3. **URLs:** UI at [http://localhost:5173](http://localhost:5173) (nginx proxies `/sessions` and `/health` to the API). Backend directly: [http://localhost:3000](http://localhost:3000). Transcription HTTP/WebSocket: port **6666**. Redis: **6379**.

## How the bot captures audio in the browser

The **bot** (`apps/bot`) does not capture the system speaker; it records **what the meeting page plays** inside Chromium.

1. **Join and inject** — After Playwright joins the Meet and the room is ready, the bot injects `apps/bot/src/scripts/recorder.js` into the page and registers a Playwright binding `__meetingbotRecorderBridge`. That binding forwards messages from the page to a Node WebSocket client, which streams them to the transcription service.

2. **Find remote audio** — The script selects every `<audio>` element in the document. In Meet, participant audio is typically attached as a `MediaStream` on `audio.srcObject`. If none exist yet, it retries on an interval until elements appear.

3. **Mix with Web Audio** — It creates an `AudioContext` to merge all mediastream that we get from `<audio>` element.

4. **Chunked `MediaRecorder`** — The Media recorder starts, records the defined duration sends the chunks to transcription service and gets destroyed. A new recorder instance is created to record next chunk.

5. **Out of the browser** — On each `dataavailable` blob, the script base64-encodes the data and calls the bridge with a `chunk` payload (session id, sequence, mime type). The transcription service receives those chunks over the WebSocket and transcribes them.

## Why headed Chrome instead of Playwright headless

The bot **Docker image** defaults to **headed** Chrome (`HEADLESS=false` in `apps/bot/Dockerfile`). The container entrypoint starts **Xvfb** on `:99` and **PulseAudio** (`apps/bot/docker-entrypoint.sh`) so Chromium still has a normal display and audio stack—there is no physical monitor, only a virtual framebuffer.

**Reason:** Google Meet leans on **WebRTC** and in-tab media playback. Chromium’s classic **headless** mode has often been stricter or flakier for that stack. Also **headless** browser instance are more prone to be detected by anti bot measures then **headed** browsers. Running **headed** Chrome on Xvfb is much closer to a desktop browser, which tends to keep remote participant audio and the recorder script’s Web Audio / `MediaRecorder` path working more predictably.

**Downsides:** Headed Chrome on Xvfb is heavier than true headless—more CPU, RAM, and image size because you run a full UI stack plus **Xvfb** and **PulseAudio**. Startup is slower. Scaling many parallel bots on one host costs more than headless workers.


## Why I seprated Transcription Service

In the assingnment I was asked to stream the audio directly back to backend service, I felt it was not right from a system design perspective. seprating the Transcription service, seprates the concern from User specific sevice to the background service. 

It also gives us freeway to scale-up or scale-down different component of the system independently.

One more thing I did differently was to stream the transcribed chunks via redis, it gives us buffer and reliabliby that all chunks will be delivered to the client. It is also helpful when user reconnects to the streaming endpoint and we want to flush all the older transcript to the client.

## Future Scopes

This is a very janky and POC verion of what these system could be. 

Things I would love to add/improve if I had time. 

1. Adding timestamp to the transcript, I am already using 30sec interval to send audo for transcription. We can add a timestamp when the audio was started getting recorded, and when it was sent for processing.
2. Call end indicator. It would be better if the bot checks the number of participants every few seconds, if its only 1. then it can safely leave the call with a 60 sec timeout, and it can notify the transcription or other service that the meet has ended.
3. Video + Audio recording feature that gets saved into S3.
4. Improve the websocket layer between Bot and Transcription service, by using sticky sessions, retry, ping, ack. That could help when system scales.
5. Bot health system. The job of the worker (service that starts bot) should not be to only run the bot containers but rather orchertraste them. Crash recovery when the Bot container does not respond to ping from the worker.
6. The session information are stored in memory in this implementation, adding a DB would be necessay.