(function () {
    const injectedConfig = window.__MEETINGBOT_RECORDER_CONFIG__ || {};
    const config = {
        wsUrl: injectedConfig.wsUrl || "ws://transcription:6666/ws",
        sessionId: injectedConfig.sessionId || "unknown-session",
        chunkMs: Number(injectedConfig.chunkMs || 1000),
        mimeType: injectedConfig.mimeType || "audio/webm",
        language: injectedConfig.language || undefined,
        prompt: injectedConfig.prompt || undefined,
    };

    function log(message, extra) {
        if (extra === undefined) {
            console.log("[Recorder Script]:", message);
            return;
        }
        console.log("[Recorder Script]:", message, extra);
    }

    let audioContext;
    let mediaRecorder;
    let destination;
    let socket;
    let nextSequence = 1;
    const pendingBlobs = [];

    function createSocket() {
        socket = new WebSocket(config.wsUrl);

        socket.addEventListener("open", function () {
            log("websocket connected", config.wsUrl);
            socket.send(JSON.stringify({
                type: "start",
                sessionId: config.sessionId,
                mimeType: config.mimeType,
                language: config.language,
                prompt: config.prompt,
            }));
            flushPendingBlobs();
        });

        socket.addEventListener("close", function () {
            log("websocket closed");
        });

        socket.addEventListener("error", function (event) {
            log("websocket error", event);
        });

        socket.addEventListener("message", function (event) {
            log("websocket message", event.data);
        });
    }

    function flushPendingBlobs() {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        while (pendingBlobs.length > 0) {
            const blob = pendingBlobs.shift();
            if (!blob) {
                continue;
            }
            sendBlob(blob);
        }
    }

    function queueBlob(blob) {
        pendingBlobs.push(blob);
        if (pendingBlobs.length > 30) {
            pendingBlobs.shift();
        }
    }

    function sendBlob(blob) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            queueBlob(blob);
            return;
        }

        socket.send(blob);
        log("sent blob", {
            sequence: nextSequence++,
            size: blob.size,
            type: blob.type || config.mimeType,
        });
    }

    function findMediaElements() {
        try {
            const elements = Array.from(document.querySelectorAll("audio"));
            log("found media elements", elements.length);
            if (elements.length === 0) {
                return [];
            }
            return elements;
        } catch (error) {
            log("failed to query media elements", error);
            return [];
        }
    }

    function mergeMediaElements(mediaElements) {
        try {
            audioContext = new AudioContext();
            destination = audioContext.createMediaStreamDestination();

            mediaElements.forEach(function (element) {
                const mediaStream = element.srcObject;
                if (mediaStream instanceof MediaStream && mediaStream.getAudioTracks().length > 0) {
                    log("adding media source");
                    const source = audioContext.createMediaStreamSource(mediaStream);
                    source.connect(destination);
                }
            });
        } catch (error) {
            log("failed to merge media elements", error);
        }
    }

    function canRecordMimeType(mimeType) {
        return typeof MediaRecorder !== "undefined"
            && typeof MediaRecorder.isTypeSupported === "function"
            && MediaRecorder.isTypeSupported(mimeType);
    }

    function resolveRecorderOptions() {
        if (canRecordMimeType(config.mimeType)) {
            return { mimeType: config.mimeType };
        }
        return undefined;
    }

    function startRecordAudio() {
        const mediaElements = findMediaElements();
        if (mediaElements.length === 0) {
            log("could not find media element, retrying");
            window.setTimeout(startRecordAudio, 1000);
            return;
        }

        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            log("recorder already running");
            return;
        }

        mergeMediaElements(mediaElements);
        if (!destination) {
            log("destination stream was not created");
            return;
        }

        createSocket();

        const recorderOptions = resolveRecorderOptions();
        mediaRecorder = recorderOptions
            ? new MediaRecorder(destination.stream, recorderOptions)
            : new MediaRecorder(destination.stream);

        mediaRecorder.addEventListener("dataavailable", function (event) {
            if (!event.data || event.data.size === 0) {
                return;
            }
            sendBlob(event.data);
        });

        mediaRecorder.addEventListener("start", function () {
            log("recorder started");
        });

        mediaRecorder.addEventListener("stop", function () {
            log("recorder stopped");
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: "end",
                    sessionId: config.sessionId,
                }));
            }
        });

        mediaRecorder.start(config.chunkMs);
    }

    window.startRecordAudio = startRecordAudio;
    startRecordAudio();
})();