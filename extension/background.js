// SideCap Background Service Worker
// Handles tab audio capture and offscreen document management

let offscreenDocumentCreated = false;
let activeTabId = null;
let mediaStreamId = null;
let activatedTabs = new Set(); // Tabs where extension has been invoked

// Create offscreen document for Web Speech API
async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: "extension/offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Speech recognition for video captions"
    });
    offscreenDocumentCreated = true;
    console.log("[SideCap] Offscreen document created");
  } catch (error) {
    if (error.message.includes("already exists")) {
      offscreenDocumentCreated = true;
    } else {
      console.error("[SideCap] Failed to create offscreen document:", error);
      throw error;
    }
  }
}

// Start capturing tab audio
async function startCapture(tabId) {
  console.log("[SideCap] Starting capture for tab:", tabId);

  try {
    // Get the stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    mediaStreamId = streamId;
    activeTabId = tabId;

    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // Send stream ID to offscreen document to start recognition
    chrome.runtime.sendMessage({
      type: "START_RECOGNITION",
      streamId: streamId,
      tabId: tabId
    });

    console.log("[SideCap] Capture started, stream ID sent to offscreen");
    return { success: true };
  } catch (error) {
    console.error("[SideCap] Failed to start capture:", error);
    return { success: false, error: error.message };
  }
}

// Stop capturing
async function stopCapture() {
  console.log("[SideCap] Stopping capture");

  if (offscreenDocumentCreated) {
    chrome.runtime.sendMessage({ type: "STOP_RECOGNITION" });
  }

  mediaStreamId = null;
  activeTabId = null;

  return { success: true };
}

// Listen for messages from content script and offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[SideCap Background] Received message:", message.type);

  switch (message.type) {
    case "START_SPEECH_CAPTURE":
      // NOTE: This path won't work - tabCapture requires user gesture from extension UI
      // User must use keyboard shortcut (Opt+Shift+C) or click extension icon
      console.log("[SideCap Background] START_SPEECH_CAPTURE received - this requires extension UI gesture");
      sendResponse({
        success: false,
        error: "Use keyboard shortcut Opt+Shift+C or click extension icon to start"
      });
      break;

    case "STOP_SPEECH_CAPTURE":
      stopCapture().then(sendResponse);
      return true;

    case "TRANSCRIPT_UPDATE":
      // Forward transcript from offscreen to content script
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: "TRANSCRIPT_UPDATE",
          transcript: message.transcript,
          isFinal: message.isFinal
        });
      }
      break;

    case "SPEECH_ERROR":
      // Forward error to content script
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: "SPEECH_ERROR",
          error: message.error
        });
      }
      break;

    case "GET_CAPTURE_STATUS":
      sendResponse({
        isCapturing: mediaStreamId !== null,
        tabId: activeTabId
      });
      break;
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture();
  }
});

// Clean up when tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    stopCapture();
  }
});

// Handle speech capture activation (shared logic for icon click and keyboard shortcuts)
async function activateSpeechCapture(tab) {
  console.log("[SideCap Background] Activating speech capture for tab:", tab.id, "URL:", tab.url);
  console.log("[SideCap Background] Current state - activeTabId:", activeTabId, "mediaStreamId:", mediaStreamId);

  if (tab.id) {
    activatedTabs.add(tab.id);

    // If already capturing on this tab, toggle off
    if (activeTabId === tab.id) {
      console.log("[SideCap Background] Already capturing on this tab, toggling OFF");
      await stopCapture();
      chrome.tabs.sendMessage(tab.id, {
        type: "SPEECH_STOPPED"
      });
      return;
    }

    // If already capturing on another tab, stop it first
    if (activeTabId && activeTabId !== tab.id) {
      console.log("[SideCap Background] Stopping capture on different tab:", activeTabId);
      await stopCapture();
    }

    // Start capture for this tab
    console.log("[SideCap Background] Starting capture...");
    const result = await startCapture(tab.id);
    console.log("[SideCap Background] Capture result:", result);

    // Notify the content script
    chrome.tabs.sendMessage(tab.id, {
      type: "SPEECH_CAPTURE_ACTIVATED",
      success: result.success,
      error: result.error
    });
  }
}

// Handle extension icon click
chrome.action.onClicked.addListener(activateSpeechCapture);

// Handle keyboard shortcuts (custom commands)
chrome.commands.onCommand.addListener(async (command) => {
  console.log("[SideCap Background] Command received:", command);

  if (command === "speech-capture-alt1") {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log("[SideCap Background] Alt shortcut, active tab:", tab?.id, tab?.url);
    if (tab) {
      await activateSpeechCapture(tab);
    }
  }
});

console.log("[SideCap] Background service worker loaded");
