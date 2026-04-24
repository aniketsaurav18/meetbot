(function () {
    const injectedConfig = window.__MEETINGBOT_RECORDER_CONFIG__ || {};
    const config = {
        sessionId: injectedConfig.sessionId || "unknown-session",
        chunkMs: Number(injectedConfig.chunkMs || 1000),
        mimeType: injectedConfig.mimeType || "audio/webm",
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
    let segmentTimer;
    let shouldContinueRecording = false;
    let destination;
    let nextSequence = 1;
    const pendingBlobs = [];

    function getBridge() {
        if (typeof window.__meetingbotRecorderBridge !== "function") {
            throw new Error("Recorder bridge is not available on window.");
        }
        return window.__meetingbotRecorderBridge;
    }

    async function flushPendingBlobs() {
        while (pendingBlobs.length > 0) {
            const blob = pendingBlobs.shift();
            if (!blob) {
                continue;
            }
            await sendBlob(blob);
        }
    }

    function queueBlob(blob) {
        pendingBlobs.push(blob);
        if (pendingBlobs.length > 30) {
            pendingBlobs.shift();
        }
    }

    async function blobToBase64(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";

        for (let index = 0; index < bytes.length; index += 0x8000) {
            const chunk = bytes.subarray(index, index + 0x8000);
            binary += String.fromCharCode.apply(null, chunk);
        }

        return btoa(binary);
    }

    async function sendBlob(blob) {
        const sequence = nextSequence++;
        const bridge = getBridge();
        const data = await blobToBase64(blob);

        await bridge({
            type: "chunk",
            sessionId: config.sessionId,
            sequence: sequence,
            mimeType: blob.type || config.mimeType,
            data: data,
        });

        log("sent blob", {
            sequence: sequence,
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

    function createMediaRecorder() {
        const recorderOptions = resolveRecorderOptions();
        const recorder = recorderOptions
            ? new MediaRecorder(destination.stream, recorderOptions)
            : new MediaRecorder(destination.stream);

        recorder.addEventListener("dataavailable", function (event) {
            if (!event.data || event.data.size === 0) {
                return;
            }

            queueBlob(event.data);
            flushPendingBlobs().catch(function (error) {
                log("failed to flush audio blobs", error);
            });
        });

        recorder.addEventListener("start", function () {
            log("recorder segment started");
        });

        recorder.addEventListener("stop", function () {
            log("recorder segment stopped");
            mediaRecorder = undefined;
            if (shouldContinueRecording) {
                window.setTimeout(startRecorderSegment, 0);
            }
        });

        return recorder;
    }

    function startRecorderSegment() {
        if (!shouldContinueRecording || !destination) {
            return;
        }

        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            log("recorder segment already running");
            return;
        }

        mediaRecorder = createMediaRecorder();
        mediaRecorder.start();

        segmentTimer = window.setTimeout(function () {
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
            }
        }, config.chunkMs);
    }

    function stopRecordAudio() {
        shouldContinueRecording = false;
        if (segmentTimer) {
            window.clearTimeout(segmentTimer);
            segmentTimer = undefined;
        }
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
        getBridge()({
            type: "end",
            sessionId: config.sessionId,
        }).catch(function (error) {
            log("failed to signal recorder end", error);
        });
    }

    async function startRecordAudio() {
        const mediaElements = findMediaElements();
        if (mediaElements.length === 0) {
            log("could not find media element, retrying");
            window.setTimeout(startRecordAudio, 1000);
            return;
        }

        if (shouldContinueRecording || (mediaRecorder && mediaRecorder.state !== "inactive")) {
            log("recorder already running");
            return;
        }

        mergeMediaElements(mediaElements);
        if (!destination) {
            log("destination stream was not created");
            return;
        }

        shouldContinueRecording = true;
        startRecorderSegment();
    }

    window.startRecordAudio = startRecordAudio;
    window.stopRecordAudio = stopRecordAudio;
})();