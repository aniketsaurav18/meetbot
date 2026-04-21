  
**Deadline**: 4 days  
**Submission**: Push to a public GitHub repo and share the link. Include a README with setup instructions and any decisions you made.

**The Problem:** Google Meet Transcription Bot

Build a system where a user submits a Google Meet link, a bot joins the meeting, captures audio, and streams a live transcription to the frontend in real-time.

**Part 1: Backend (NestJS \+ TypeScript)**

Use **Redis** for the job queue. Use **WebSocket** (Socket.IO or native) for real-time communication.

**Features**:

1. **Bot Session AP**I: an endpoint that accepts a Google Meet URL and a bot display name. Creates a session with a unique ID and queues a job to join the meeting.  
2. **Job Queue**: use BullMQ. When a session is created, push a job to the queue. A worker picks it up and launches the Playwright bot. Handle retries (up to 2\) if the bot fails to join.  
3. **Session Status**: track the session lifecycle: QUEUED → JOINING → RECORDING → DONE or FAILED. Provide an endpoint to check the current status of a session.  
4. **Audio Processing**: receive audio chunks from the Playwright bot via WebSocket. Forward each chunk to a transcription service (Groq Whisper API, Deepgram, or AssemblyAI pick one, free tier is fine). Receive the transcribed text back.  
5. **Live Transcript Streaming**: push each transcribed text chunk to the frontend via WebSocket in real-time as it arrives. The frontend should see words appearing as the meeting is happening.

**Part 2: Playwright Bot**

The bot is a Playwright-based browser automation script that:

1. Open the Google Meet link in a Chromium browser.  
2. Handles the pre-join screen \- enters the bot display name, dismisses any popups or permission dialogs.  
3. Click the "Ask to join" or "Join now" button.  
4. Once in the meeting, capture tab audio using the browser's MediaRecorder API.  
5. Sends audio chunks to the backend via WebSocket as they are recorded (not after the meeting ends \- must be real-time).

**Notes**:

- Use headless or headed mode \- your choice. Document which and why.  
- Audio capture from a browser tab in Playwright is non-trivial. Research and document your approach in the README.

**Part 3: Frontend (React \+ TypeScript)**

1. **Submit Form**: input field for Google Meet URL, input for bot display name, submit button.

2. **Session View**: after submitting, show the current session status (JOINING, RECORDING, DONE, FAILED) with visual indicators.

3. **Live Transcript**: a scrollable text area that updates in real-time as transcription chunks arrive via WebSocket. New text should appear as the bot hears speech in the meeting. Auto-scroll to the bottom as new text arrives.

The UI does not need to look fancy. Clean and functional.

**Part 4: DevOps**

1. Dockerfile for the backend (multi-stage build).  
2. docker-compose.yml that starts the backend, Redis, and the frontend. Everything should work with a single "docker compose up" (Playwright/Chromium dependencies should be handled in the Dockerfile).  
3. .env.example with all required variables.

Tell us what you completed and what you skipped in the README.