// SideCap Offscreen Document
// Handles Web Speech API recognition from tab audio capture
// Uses Chrome 133+ MediaStreamTrack support for SpeechRecognition

let recognition = null;
let mediaStream = null;
let isRecognizing = false;

// Initialize speech recognition with MediaStreamTrack support (Chrome 133+)
function createRecognition(audioTrack, language = 'auto') {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    console.error("[SideCap Offscreen] Speech recognition not supported");
    chrome.runtime.sendMessage({
      type: "SPEECH_ERROR",
      error: "Speech recognition not supported in this browser"
    });
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  // Set language if explicitly provided
  if (language && language !== 'auto') {
    rec.lang = language;
    console.log("[SideCap Offscreen] Using explicit language:", language);
  } else {
    console.log("[SideCap Offscreen] Using browser auto-detection for language");
  }

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        console.log("[SideCap Offscreen] Final:", transcript);
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_UPDATE",
          transcript: transcript.trim(),
          isFinal: true
        });
      } else {
        // Send interim results for live display
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_UPDATE",
          transcript: transcript,
          isFinal: false
        });
      }
    }
  };

  rec.onerror = (event) => {
    console.error("[SideCap Offscreen] Recognition error:", event.error);

    // Don't report "no-speech" as an error - it's normal during silence
    if (event.error !== "no-speech" && event.error !== "aborted") {
      chrome.runtime.sendMessage({
        type: "SPEECH_ERROR",
        error: event.error
      });
    }

    // Restart on recoverable errors
    if (event.error === "no-speech" || event.error === "audio-capture" || event.error === "network") {
      if (isRecognizing && audioTrack) {
        setTimeout(() => {
          if (isRecognizing && recognition) {
            try {
              // Use the new Chrome 133+ API with MediaStreamTrack
              recognition.start(audioTrack);
            } catch (e) {
              console.log("[SideCap Offscreen] Restart failed:", e);
            }
          }
        }, 500);
      }
    }
  };

  rec.onend = () => {
    console.log("[SideCap Offscreen] Recognition ended");

    // Auto-restart if we should still be recognizing
    if (isRecognizing && audioTrack) {
      setTimeout(() => {
        if (isRecognizing && recognition) {
          try {
            recognition.start(audioTrack);
            console.log("[SideCap Offscreen] Recognition restarted");
          } catch (e) {
            console.log("[SideCap Offscreen] Restart failed:", e);
          }
        }
      }, 100);
    }
  };

  rec.onstart = () => {
    console.log("[SideCap Offscreen] Recognition started with MediaStreamTrack");
  };

  return rec;
}

// Start recognition with tab audio stream (Chrome 133+ MediaStreamTrack API)
async function startRecognition(streamId, language = 'auto') {
  console.log("[SideCap Offscreen] Starting recognition with stream ID:", streamId);

  // Validate stream ID
  if (!streamId || typeof streamId !== 'string') {
    const error = new Error("Invalid stream ID");
    console.error("[SideCap Offscreen]", error.message);
    chrome.runtime.sendMessage({
      type: "SPEECH_ERROR",
      error: error.message
    });
    return;
  }

  try {
    // Get the media stream from the tab using the streamId
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    console.log("[SideCap Offscreen] Got media stream from tab");

    // Validate media stream
    if (!mediaStream || !mediaStream.active) {
      throw new Error("Failed to get active media stream");
    }

    // Get and validate audio track
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("No audio track in media stream");
    }

    // Select the best audio track (prefer enabled, live tracks with good sample rate)
    const audioTrack = audioTracks.find(track =>
      track.enabled &&
      track.readyState === 'live' &&
      track.getSettings().sampleRate >= 16000  // Speech recognition needs decent quality
    ) || audioTracks[0];

    if (!audioTrack) {
      throw new Error("No suitable audio track found");
    }

    const trackSettings = audioTrack.getSettings();
    console.log("[SideCap Offscreen] Using audio track:", {
      label: audioTrack.label,
      sampleRate: trackSettings.sampleRate,
      channelCount: trackSettings.channelCount,
      readyState: audioTrack.readyState
    });

    // Create recognition with the audio track and language
    recognition = createRecognition(audioTrack, language);
    if (!recognition) {
      throw new Error("Could not create speech recognition");
    }

    isRecognizing = true;

    // Start recognition with MediaStreamTrack (Chrome 133+ feature!)
    try {
      recognition.start(audioTrack);
      console.log("[SideCap Offscreen] Started with MediaStreamTrack API (Chrome 133+)");
    } catch (e) {
      // Fallback: maybe older Chrome without MediaStreamTrack support
      console.warn("[SideCap Offscreen] MediaStreamTrack not supported, trying standard start():", e);
      recognition.start();
    }

    chrome.runtime.sendMessage({
      type: "SPEECH_STARTED"
    });

  } catch (error) {
    console.error("[SideCap Offscreen] Failed to start recognition:", error);
    chrome.runtime.sendMessage({
      type: "SPEECH_ERROR",
      error: error.message
    });
  }
}

// Stop recognition
function stopRecognition() {
  console.log("[SideCap Offscreen] Stopping recognition");

  isRecognizing = false;

  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      // Ignore
    }
    recognition = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  chrome.runtime.sendMessage({
    type: "SPEECH_STOPPED"
  });
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[SideCap Offscreen] Received message:", message.type);

  switch (message.type) {
    case "START_RECOGNITION":
      startRecognition(message.streamId, message.language);
      break;

    case "STOP_RECOGNITION":
      stopRecognition();
      break;

    case "SET_LANGUAGE":
      if (recognition) {
        recognition.lang = message.language;
        console.log("[SideCap Offscreen] Language set to:", message.language);
      }
      break;
  }
});

console.log("[SideCap Offscreen] Offscreen document loaded (Chrome 133+ MediaStreamTrack API)");
