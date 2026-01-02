(function () {
  const ROOT_ID = "captions-root";
  const OVERLAY_ID = "captions-overlay";
  const CAPTION_POLL_MS = 500;
  const REPLAY_BACK_SECONDS = 1.6;
  const STATUS_FLASH_MS = 1600;
  const DICTIONARY_API_BASE = "https://api.dictionaryapi.dev/api/v2/entries";
  const LINGVA_API_BASE = "https://lingva.lunar.icu/api/v1";
  const DICTIONARY_CACHE_TTL_MS = 60 * 60 * 1000;
  const TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const CONTROL_SEEK_SECONDS = 5;

  const defaultConfig = {
    // Mode
    mode: "learning", // "learning" or "translation"

    // Caption Location
    captionLocation: "overlay-draggable", // "sidebar", "overlay-fixed", "overlay-draggable"

    // Word Detail Density
    showPhonetics: true,
    showPartOfSpeech: true,
    showDefinitions: true,
    showExamples: true,
    showAudioPronunciation: true,
    showVideoContext: true,

    // Caption Appearance
    captionOpacity: 0.60,
    captionFontSize: 24,
    captionFontFamily: "inherit",
    captionColor: "#ffffff",
    captionBgColor: "#000000",
    captionWidth: 70, // percentage

    // Language Settings
    dictionaryLang: "en", // For learning mode
    sourceLang: "en",     // For translation mode
    targetLang: "es",     // For translation mode

    // Other Settings
    historyEnabled: true,
    autoPauseOnClick: true,
    showNativeCaptions: false, // Show YouTube's native captions alongside ours
    customPosition: null, // { top, left } for custom drag position
    popupPosition: null, // { top, left } for word popup position
    sidebarCollapsed: false,

    // Theme
    theme: "dark", // "dark" or "light"

    // Dual Subtitles
    dualSubtitles: false, // Show translation below original
  };

  const config = { ...defaultConfig };

  // Load config from storage (returns promise)
  function loadConfig() {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage) {
        chrome.storage.local.get("captionsConfig", (result) => {
          if (result.captionsConfig) {
            Object.assign(config, result.captionsConfig);
            console.log("[SideCap] Config loaded, sidebarCollapsed:", config.sidebarCollapsed);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Save config to storage
  function saveConfig() {
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.set({ captionsConfig: config });
    }
  }

  // Update native captions visibility based on config
  function updateNativeCaptionsVisibility() {
    // YouTube captions
    const ytContainer = document.querySelector(".ytp-caption-window-container");
    if (ytContainer) {
      if (config.showNativeCaptions) {
        ytContainer.classList.remove("sidecap-native-hidden");
      } else {
        ytContainer.classList.add("sidecap-native-hidden");
      }
    }

    // Bitmovin captions
    const bmpContainer = document.querySelector(".bmpui-ui-subtitle-overlay");
    if (bmpContainer) {
      if (config.showNativeCaptions) {
        bmpContainer.classList.remove("sidecap-native-hidden");
      } else {
        bmpContainer.classList.add("sidecap-native-hidden");
      }
    }
  }

  // Site detection - determine which video player we're dealing with
  function detectSite() {
    const hostname = window.location.hostname;
    if (hostname.includes("youtube.com")) {
      return "youtube";
    }
    if (hostname.includes("ina.fr")) {
      return "ina";
    }
    // Check for Bitmovin player on any site
    if (document.querySelector(".bmpui-ui-uicontainer")) {
      return "bitmovin";
    }
    return "unknown";
  }

  const currentSite = detectSite();
  console.log("[SideCap] Detected site:", currentSite);

  // Apply native captions visibility on load
  setTimeout(() => {
    updateNativeCaptionsVisibility();
  }, 500);

  if (document.getElementById(ROOT_ID)) {
    return;
  }

  const state = {
    renderedCaptionText: "",
    statusOverrideText: "",
    statusOverrideUntil: 0,
    captionContainer: null,
    captionObserver: null,
    activeWord: "",
    lookupRequestId: 0,
    captionHistory: [],
    popupOpen: false,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartTop: 0,
    dragStartLeft: 0,
    // Popup dragging state
    isPopupDragging: false,
    popupDragStartX: 0,
    popupDragStartY: 0,
    popupDragStartTop: 0,
    popupDragStartLeft: 0,
    // Track all words and flush in chunks
    allWordsEverSeen: [],     // All unique words in order seen
    lastFlushedIndex: 0,      // Words up to this index have been flushed to history
    lastFlushTime: 0,         // Video time when we last flushed
    lastCapturedText: "",     // For deduplication
    currentVideoId: null,     // Track current video to detect navigation
    maxTimeFlushed: 0,        // Highest video time we've ever flushed (for rewind detection)
    // Speech capture state
    speechCaptureActive: false,
    speechTranscript: "",      // Current interim transcript
    speechFinalText: "",       // Last finalized transcript
  };

  const dictionaryCache = new Map();
  const translationCache = new Map();

  // Speech capture functions
  // NOTE: Starting capture MUST be done via keyboard shortcut (Opt+Shift+C) or extension icon click
  // Chrome requires user gesture on extension UI for tabCapture permission

  async function stopSpeechCapture() {
    if (!state.speechCaptureActive) {
      console.log("[SideCap] stopSpeechCapture called but not active");
      return;
    }

    console.log("[SideCap] Stopping speech capture...");
    try {
      await chrome.runtime.sendMessage({ type: "STOP_SPEECH_CAPTURE" });
      state.speechCaptureActive = false;
      state.speechTranscript = "";
      state.speechFinalText = "";
      console.log("[SideCap] Speech capture stopped successfully");
    } catch (error) {
      console.error("[SideCap] Error stopping speech capture:", error);
    }
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[SideCap] Message received:", message.type, message);

    if (message.type === "TRANSCRIPT_UPDATE") {
      if (message.isFinal) {
        // Final transcript - treat like a caption
        state.speechFinalText = message.transcript;
        state.speechTranscript = "";
        console.log("[SideCap] Final transcript:", message.transcript);
      } else {
        // Interim transcript - update live display
        state.speechTranscript = message.transcript;
      }
    } else if (message.type === "SPEECH_ERROR") {
      console.error("[SideCap] Speech error:", message.error);
      flashStatus("Speech error: " + message.error);
    } else if (message.type === "SPEECH_CAPTURE_ACTIVATED") {
      // Extension icon was clicked, speech capture started
      if (message.success) {
        state.speechCaptureActive = true;
        flashStatus("Smart Captions active");
        console.log("[SideCap] Speech capture activated via extension icon");
        // Update button UI if it exists
        const scBtn = document.querySelector(".captions-speech-capture-button");
        if (scBtn) {
          scBtn.innerHTML = "";
          scBtn.appendChild(createSVGIcon("captions", 14));
          scBtn.title = "Smart Captions active - Click to stop";
          scBtn.classList.add("is-active");
        }
      } else {
        flashStatus("Failed: " + (message.error || "Unknown error"));
      }
    } else if (message.type === "SPEECH_STOPPED") {
      state.speechCaptureActive = false;
      state.speechTranscript = "";
      // Update button UI
      const scBtn = document.querySelector(".captions-speech-capture-button");
      if (scBtn) {
        scBtn.innerHTML = "";
        scBtn.appendChild(createSVGIcon("captions", 14));
        scBtn.title = "Smart Captions - Press Opt+Shift+C to start";
        scBtn.classList.remove("is-active");
      }
    }
  });

  // Translation API
  async function translateText(text, sourceLang, targetLang) {
    if (!text || !text.trim()) return "";

    const cacheKey = `${sourceLang}:${targetLang}:${text}`;
    const cached = translationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TRANSLATION_CACHE_TTL_MS) {
      return cached.translation;
    }

    try {
      const url = `${LINGVA_API_BASE}/${sourceLang}/${targetLang}/${encodeURIComponent(text)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Translation failed: ${response.status}`);

      const data = await response.json();
      const translation = data.translation || "";

      translationCache.set(cacheKey, { translation, timestamp: Date.now() });
      return translation;
    } catch (error) {
      console.warn("[Captions] Translation error:", error);
      return "(translation unavailable)";
    }
  }

  function createElement(tag, className) {
    const el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  }

  function createSVGIcon(type, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";

    // Lucide icons - clean, professional, open-source
    if (type === "copy") {
      // lucide: clipboard-copy
      svg.innerHTML = `
        <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      `;
    } else if (type === "settings") {
      // lucide: settings
      svg.innerHTML = `
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      `;
    } else if (type === "chevron-up") {
      // lucide: chevron-up
      svg.innerHTML = `<path d="m18 15-6-6-6 6"/>`;
    } else if (type === "chevron-down") {
      // lucide: chevron-down
      svg.innerHTML = `<path d="m6 9 6 6 6-6"/>`;
    } else if (type === "chevron-left") {
      // lucide: chevron-left
      svg.innerHTML = `<path d="m15 18-6-6 6-6"/>`;
    } else if (type === "chevron-right") {
      // lucide: chevron-right
      svg.innerHTML = `<path d="m9 18 6-6-6-6"/>`;
    } else if (type === "check") {
      // lucide: check
      svg.innerHTML = `<path d="M20 6 9 17l-5-5"/>`;
    } else if (type === "search") {
      // lucide: search
      svg.innerHTML = `
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.3-4.3"/>
      `;
    } else if (type === "git-compare") {
      // lucide: git-compare (for diff)
      svg.innerHTML = `
        <circle cx="18" cy="18" r="3"/>
        <circle cx="6" cy="6" r="3"/>
        <path d="M13 6h3a2 2 0 0 1 2 2v7"/>
        <path d="M11 18H8a2 2 0 0 1-2-2V9"/>
      `;
    } else if (type === "panel-right") {
      // lucide: panel-right (for sidebar toggle)
      svg.innerHTML = `
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
        <line x1="15" x2="15" y1="3" y2="21"/>
      `;
    } else if (type === "target") {
      // lucide: crosshair (for recenter)
      svg.innerHTML = `
        <circle cx="12" cy="12" r="10"/>
        <line x1="22" x2="18" y1="12" y2="12"/>
        <line x1="6" x2="2" y1="12" y2="12"/>
        <line x1="12" x2="12" y1="6" y2="2"/>
        <line x1="12" x2="12" y1="22" y2="18"/>
      `;
    } else if (type === "list") {
      // lucide: align-left (for transcript history)
      svg.innerHTML = `
        <line x1="21" x2="3" y1="6" y2="6"/>
        <line x1="15" x2="3" y1="12" y2="12"/>
        <line x1="17" x2="3" y1="18" y2="18"/>
      `;
    } else if (type === "volume") {
      // lucide: volume-2 (for speak/pronunciation)
      svg.innerHTML = `
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      `;
    } else if (type === "languages") {
      // lucide: languages (for translate)
      svg.innerHTML = `
        <path d="m5 8 6 6"/>
        <path d="m4 14 6-6 2-3"/>
        <path d="M2 5h12"/>
        <path d="M7 2h1"/>
        <path d="m22 22-5-10-5 10"/>
        <path d="M14 18h6"/>
      `;
    } else if (type === "captions") {
      // SC SideCap/Smart Caption icon
      svg.innerHTML = `
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
        <text x="5.5" y="15" font-size="8" font-weight="bold" fill="currentColor" stroke="none">SC</text>
      `;
    } else if (type === "captions-off") {
      // SC icon with slash (active state)
      svg.innerHTML = `
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
        <text x="5.5" y="15" font-size="8" font-weight="bold" fill="currentColor" stroke="none">SC</text>
        <line x1="3" x2="21" y1="3" y2="21" stroke-width="2"/>
      `;
    }

    return svg;
  }

  function normalizeWord(rawWord) {
    const trimmed = rawWord.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  function getCurrentVideoId() {
    // Extract video ID from URL (works for /watch?v=ID and /shorts/ID)
    const params = new URLSearchParams(window.location.search);
    const watchId = params.get('v');
    if (watchId) return watchId;

    // Check for shorts format: /shorts/VIDEO_ID
    const shortsMatch = window.location.pathname.match(/\/shorts\/([^/]+)/);
    if (shortsMatch) return shortsMatch[1];

    return null;
  }

  function clearTranscriptState() {
    // Clear all transcript tracking state (called when navigating to new video)
    state.captionHistory = [];
    state.allWordsEverSeen = [];
    state.lastFlushedIndex = 0;
    state.lastFlushTime = 0;
    state.lastCapturedText = "";
    state.renderedCaptionText = "";
    state.maxTimeFlushed = 0; // Reset max time for new video

    // Clear the caption overlay DOM element
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.textContent = "";
      overlay.className = "captions-overlay is-empty-state";
    }

    console.log("[Captions] 🔄 Cleared transcript state for new video");
    renderHistory();
  }

  function checkVideoChange() {
    const videoId = getCurrentVideoId();

    if (!videoId) {
      // Not on a video page
      return;
    }

    if (state.currentVideoId !== videoId) {
      // Video changed!
      if (state.currentVideoId !== null) {
        // Only clear if we had a previous video (not first load)
        clearTranscriptState();
        flashStatus("New video - history cleared");
      }
      state.currentVideoId = videoId;
      console.log(`[Captions] 📺 Video: ${videoId}`);
    }
  }

  function getCacheKey(word, language) {
    return `${language}:${word.toLowerCase()}`;
  }

  function getCachedEntry(key) {
    const cached = dictionaryCache.get(key);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp > DICTIONARY_CACHE_TTL_MS) {
      dictionaryCache.delete(key);
      return null;
    }
    return cached.data;
  }

  function setCachedEntry(key, data) {
    dictionaryCache.set(key, { data, timestamp: Date.now() });
  }

  async function fetchDictionaryEntry(word, language) {
    const url = `${DICTIONARY_API_BASE}/${language}/${encodeURIComponent(word.toLowerCase())}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Dictionary lookup failed (${response.status}).`);
    }
    return response.json();
  }

  function parseDictionaryData(data) {
    // dictionaryapi.dev returns an array of entries
    const entry = data[0];
    if (!entry) {
      return {
        word: "",
        partOfSpeech: "",
        pronunciations: [],
        definitions: [],
        examples: [],
        audioUrl: null,
      };
    }

    // Get phonetic (try multiple sources)
    const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || "";

    // Get audio URL if available
    const audioUrl = entry.phonetics?.find(p => p.audio && p.audio !== "")?.audio || null;

    // Get meanings
    const meanings = entry.meanings || [];
    const firstMeaning = meanings[0] || {};

    // Extract definitions and examples
    const defs = firstMeaning.definitions || [];
    const definitions = defs.map(d => d.definition).filter(Boolean);
    const examples = defs.map(d => d.example).filter(Boolean);

    return {
      word: entry.word || "",
      partOfSpeech: firstMeaning.partOfSpeech || "",
      pronunciations: phonetic ? [phonetic] : [],
      definitions: definitions.slice(0, 3), // Top 3 definitions
      examples: examples.slice(0, 2), // Top 2 examples
      audioUrl,
    };
  }

  function getVideo() {
    return document.querySelector("video");
  }

  function formatTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "00:00";
    }
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    const paddedMinutes = String(minutes).padStart(2, "0");
    const paddedSeconds = String(secs).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${paddedMinutes}:${paddedSeconds}`;
    }
    return `${paddedMinutes}:${paddedSeconds}`;
  }

  function flashStatus(text) {
    state.statusOverrideText = text;
    state.statusOverrideUntil = Date.now() + STATUS_FLASH_MS;
  }

  // Helper to extract and limit caption text
  function extractAndLimitText(container, fallbackSelector) {
    const MAX_CAPTION_CHARS = 150;

    if (container) {
      const allTextNodes = [];
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (text) {
          allTextNodes.push(text);
        }
      }

      const fullText = allTextNodes.join(' ');

      if (fullText.length > MAX_CAPTION_CHARS) {
        const trimmed = fullText.slice(-MAX_CAPTION_CHARS);
        const firstSpace = trimmed.indexOf(' ');
        return firstSpace > 0 ? trimmed.slice(firstSpace + 1) : trimmed;
      }

      return fullText;
    }

    // Fallback: get individual segments
    if (fallbackSelector) {
      const segments = Array.from(document.querySelectorAll(fallbackSelector));
      if (segments.length) {
        const fullText = segments
          .map((segment) => segment.textContent)
          .filter(Boolean)
          .join(" ")
          .trim();

        if (fullText.length > MAX_CAPTION_CHARS) {
          const trimmed = fullText.slice(-MAX_CAPTION_CHARS);
          const firstSpace = trimmed.indexOf(' ');
          return firstSpace > 0 ? trimmed.slice(firstSpace + 1) : trimmed;
        }

        return fullText;
      }
    }

    return "";
  }

  // Get caption text for YouTube
  function getYouTubeCaptionText() {
    const container = document.querySelector(".ytp-caption-window-container");
    return extractAndLimitText(container, ".ytp-caption-segment");
  }

  // Get caption text for Bitmovin player (INA.fr, etc.)
  function getBitmovinCaptionText() {
    // Bitmovin subtitle selectors - try multiple patterns
    const selectors = [
      ".bmpui-ui-subtitle-overlay",    // Main subtitle overlay
      ".bmpui-subtitle-region",         // Subtitle region
      ".bmpui-ui-subtitle-label",       // Subtitle label
    ];

    // Phrases to filter out (UI text, error messages, not actual captions)
    const filterPhrases = [
      "merci de réessayer",
      "réessayer ultérieurement",
      "version de navigateur",
      "télécharger",
      "modal-subtitle",
      "form-subtitle",
    ];

    for (const selector of selectors) {
      const container = document.querySelector(selector);
      if (container && container.textContent.trim()) {
        const text = extractAndLimitText(container, null);
        // Filter out UI messages
        const lowerText = text.toLowerCase();
        if (filterPhrases.some(phrase => lowerText.includes(phrase))) {
          continue;
        }
        return text;
      }
    }

    return "";
  }

  function getCaptionText() {
    // If speech capture is active, return speech transcript
    if (state.speechCaptureActive) {
      // Return interim transcript if available, otherwise the last final transcript
      return state.speechTranscript || state.speechFinalText || "";
    }

    const site = detectSite();

    if (site === "youtube") {
      return getYouTubeCaptionText();
    }

    if (site === "ina" || site === "bitmovin") {
      return getBitmovinCaptionText();
    }

    // Unknown site - try both
    return getYouTubeCaptionText() || getBitmovinCaptionText();
  }

  function getCaptionsButton() {
    const site = detectSite();
    if (site === "youtube") {
      return document.querySelector(".ytp-subtitles-button");
    }
    if (site === "ina" || site === "bitmovin") {
      // Bitmovin subtitle toggle button
      return document.querySelector(".bmpui-ui-subtitletogglebutton, [class*='subtitle'][class*='button']");
    }
    return document.querySelector(".ytp-subtitles-button");
  }

  function getCaptionAvailability() {
    if (!document.querySelector("video")) {
      return "no-video";
    }

    const site = detectSite();

    if (site === "youtube") {
      const button = getCaptionsButton();
      if (!button || button.getAttribute("aria-disabled") === "true") {
        return "unavailable";
      }
      if (button.getAttribute("aria-pressed") === "true") {
        return "enabled";
      }
      return "disabled";
    }

    if (site === "ina" || site === "bitmovin") {
      // For Bitmovin, check if subtitle overlay exists or has content
      const subtitleOverlay = document.querySelector(".bmpui-ui-subtitle-overlay, [class*='subtitle-overlay']");
      if (subtitleOverlay) {
        return "enabled"; // Subtitle container exists
      }
      // Check for subtitle button
      const button = getCaptionsButton();
      if (button) {
        return button.classList.contains("bmpui-on") ? "enabled" : "disabled";
      }
      return "unavailable";
    }

    return "unavailable";
  }

  function getSiteLabel() {
    const site = detectSite();
    if (site === "youtube") return "YouTube";
    if (site === "ina") return "INA.fr";
    if (site === "bitmovin") return "video";
    return "video";
  }

  function getOverlayState() {
    const captionText = getCaptionText();
    if (captionText) {
      return {
        text: captionText,
        status: state.speechCaptureActive ? "Smart Captions active" : "Captions active",
        variant: "active",
        isCaption: true,
        showOverlay: true,
      };
    }

    // Show waiting state when Smart Captions is on but no transcript yet
    if (state.speechCaptureActive) {
      return {
        text: "Listening...",
        status: "Smart Captions active",
        variant: "active",
        isCaption: false,
        showOverlay: true,
      };
    }

    const siteLabel = getSiteLabel();
    const site = detectSite();
    const availability = getCaptionAvailability();

    // For non-YouTube sites without embedded captions, prompt for speech capture
    if (site !== "youtube" && availability === "unavailable") {
      return {
        text: "Press Opt+Shift+C to enable Smart Captions.",
        status: "No embedded captions. Use speech capture.",
        variant: "idle",
        isCaption: false,
        showOverlay: true,
      };
    }

    if (availability === "no-video") {
      return {
        text: `Open a ${siteLabel} video to see captions.`,
        status: "No video detected.",
        variant: "idle",
        isCaption: false,
        showOverlay: true,
      };
    }
    if (availability === "unavailable") {
      return {
        text: "Captions not available for this video.",
        status: "No captions available.",
        variant: "warning",
        isCaption: false,
        showOverlay: true,
      };
    }
    if (availability === "disabled") {
      return {
        text: "Turn on CC to see captions.",
        status: "Captions available (off).",
        variant: "idle",
        isCaption: false,
        showOverlay: true,
      };
    }
    return {
      text: "",
      status: "Waiting...",
      variant: "idle",
      isCaption: false,
      showOverlay: false,
    };
  }

  // Utterance builder helper functions
  function normalizeText(text) {
    // Remove YouTube UI noise patterns - preserve spacing by replacing with space
    let cleaned = text
      .replace(/\(auto-generated\)/gi, " ")
      .replace(/Click for settings/gi, " ")
      .replace(/Click for/gi, " ")  // Remove standalone "Click for" (appears frequently)
      .replace(/\bsettings\b/gi, " ")
      // Remove standalone language names anywhere (common YouTube noise)
      .replace(/\b(English|French|Spanish|German|Italian|Portuguese|Japanese|Korean|Chinese|Russian|Arabic|Hindi|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Turkish|Greek|Hebrew|Vietnamese|Thai|Indonesian|Malay)\b/gi, " ");

    // Normalize whitespace (collapse multiple spaces into one)
    return cleaned.replace(/\s+/g, " ").trim();
  }

  function endsWithHardPunct(text) {
    return /[.!?]\s*$/.test(text);
  }

  function endsWithAnyBoundaryHint(text) {
    return /[.!?,;:—]\s*$/.test(text);
  }

  function looksLikeBoundary(text) {
    // Check if text starts with capital letter or common sentence starters
    const trimmed = text.trim();
    if (!trimmed) return false;

    // Capital letter at start suggests new sentence
    const startsWithCapital = /^[A-Z]/.test(trimmed);

    // Common transition words/phrases
    const transitionWords = /^(And|But|So|However|Therefore|Meanwhile|Then|Now|Also|Finally|First|Second|Third|Next)\b/i;

    return startsWithCapital || transitionWords.test(trimmed);
  }

  function mergeText(current, incoming) {
    if (!current) return incoming;
    if (!incoming) return current;

    const currentNorm = normalizeText(current);
    const incomingNorm = normalizeText(incoming);

    // Exact match - no change needed
    if (currentNorm === incomingNorm) {
      return currentNorm;
    }

    // If incoming extends current (superset), use incoming - it's the fuller version
    if (incomingNorm.includes(currentNorm)) {
      return incomingNorm;
    }

    // If current contains incoming (current is superset), keep current - we have more
    if (currentNorm.includes(incomingNorm)) {
      return currentNorm;
    }

    // Check for common prefix - YouTube might be correcting itself
    // If they share a significant starting portion, use the longer/more recent one
    const minLength = Math.min(currentNorm.length, incomingNorm.length);
    let commonPrefixLength = 0;
    for (let i = 0; i < minLength; i++) {
      if (currentNorm[i] === incomingNorm[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }

    // If >40% common prefix, YouTube is probably revising - use the longer one
    if (commonPrefixLength / minLength > 0.4) {
      return incomingNorm.length >= currentNorm.length ? incomingNorm : currentNorm;
    }

    // Otherwise, this is probably a new sentence - use incoming
    // (Don't append - YouTube sends full caption text each time, not deltas)
    return incomingNorm;
  }

  function getUtteranceDuration(utterance, end) {
    if (utterance.start === null || end === null) return 0;
    return end - utterance.start;
  }

  function isDuplicateOrOverlapping(newText) {
    if (!newText || state.captionHistory.length === 0) {
      return false;
    }

    const newNorm = normalizeText(newText);

    // Don't add very short entries (likely fragments)
    if (newNorm.length < 15) {
      return true;
    }

    // Check ALL entries (not just last 3) for more thorough deduplication
    for (let i = state.captionHistory.length - 1; i >= 0; i--) {
      const entry = state.captionHistory[i];
      const existingNorm = normalizeText(entry.text);

      // Exact duplicate
      if (existingNorm === newNorm) {
        return true;
      }

      // New text is contained in existing (subset)
      if (existingNorm.includes(newNorm)) {
        return true;
      }

      // Existing text is contained in new (superset) - replace it
      if (newNorm.includes(existingNorm)) {
        // Remove the subset entry
        state.captionHistory.splice(i, 1);
        // Continue checking other entries
        continue;
      }

      // Check for significant overlap (>60% similar - more aggressive)
      const overlapRatio = calculateOverlap(existingNorm, newNorm);
      if (overlapRatio > 0.6) {
        // If new text is longer, replace the old one
        if (newNorm.length > existingNorm.length) {
          state.captionHistory.splice(i, 1);
          continue;
        }
        // Otherwise skip this new text
        return true;
      }
    }

    return false;
  }

  function calculateOverlap(str1, str2) {
    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);

    let matchCount = 0;
    for (const word of words1) {
      if (words2.includes(word)) {
        matchCount++;
      }
    }

    const maxLength = Math.max(words1.length, words2.length);
    return maxLength > 0 ? matchCount / maxLength : 0;
  }

  function captureToHistory(text, videoTime) {
    const normalized = normalizeText(text);
    if (!normalized) return;

    // === REWIND DETECTION ===
    // If we're rewinding (going backwards in time), don't add to history
    // This prevents duplicates when user scrubs back in the timeline
    if (videoTime < state.maxTimeFlushed - 1) { // 1 second tolerance for minor jitter
      console.log(`[Captions] ⏪ Rewind detected (${videoTime.toFixed(1)}s < ${state.maxTimeFlushed.toFixed(1)}s) - skipping history`);
      return;
    }

    // === TUNABLE HEURISTICS ===
    // Minimum quality threshold - snippets must be this big to save
    const MIN_WORDS = 10;           // At least 10 words
    const MIN_CHARS = 50;           // AND at least 50 characters
    // ==========================

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS || normalized.length < MIN_CHARS) {
      return;
    }

    // Simple deduplication - don't add if it's a substring of what we just added
    if (state.lastCapturedText && state.lastCapturedText.includes(normalized)) {
      return;
    }

    // Or if new text is just slightly longer version of last capture
    if (state.lastCapturedText && normalized.includes(state.lastCapturedText)) {
      // Replace the last entry with this longer version
      if (state.captionHistory.length > 0) {
        state.captionHistory[state.captionHistory.length - 1] = {
          id: Date.now(),
          text: normalized,
          time: videoTime,
          timestamp: formatTimestamp(videoTime),
        };
        state.lastCapturedText = normalized;
        state.maxTimeFlushed = Math.max(state.maxTimeFlushed, videoTime); // Update max time
        renderHistory();
        return;
      }
    }

    const entry = {
      id: Date.now(),
      text: normalized,
      time: videoTime,
      timestamp: formatTimestamp(videoTime),
    };

    state.captionHistory.push(entry);
    if (state.captionHistory.length > config.historySize) {
      state.captionHistory.shift();
    }

    state.lastCapturedText = normalized;
    state.maxTimeFlushed = Math.max(state.maxTimeFlushed, videoTime); // Track highest time flushed
    renderHistory();
  }

  function shouldFlushBuffer(buffer) {
    // === TUNABLE HEURISTICS ===
    // These control when we flush the buffer (create history entry)
    const TARGET_WORDS = 25;        // Flush at ~25 words (~12s of speech)
    const TARGET_CHARS = 175;       // Or ~175 chars (roughly 2-3 lines)
    // ==========================

    const wordCount = buffer.split(/\s+/).filter(Boolean).length;
    const shouldFlush = wordCount >= TARGET_WORDS || buffer.length >= TARGET_CHARS;

    if (shouldFlush) {
      console.log(`[Captions] 📏 Size trigger: ${wordCount}w ${buffer.length}c`);
    }

    return shouldFlush;
  }

  function accumulateAllWords(text) {
    // Track ALL words we've ever seen from YouTube (for debugging)
    // Goal: Build a single continuous stream with no duplicates
    const words = text.split(/\s+/).filter(Boolean);

    if (state.allWordsEverSeen.length === 0) {
      // First words - just add them all
      state.allWordsEverSeen.push(...words);
      console.log(`[Debug] Initial: ${words.length} words`);
      return;
    }

    // Find how many words at the END of our array match the START of new text
    // This tells us where YouTube's current view overlaps with what we've seen
    let overlapCount = 0;
    const maxOverlap = Math.min(words.length, state.allWordsEverSeen.length);

    for (let i = 1; i <= maxOverlap; i++) {
      // Check if last i words of our array match first i words of new text
      const ourTail = state.allWordsEverSeen.slice(-i);
      const theirHead = words.slice(0, i);

      if (JSON.stringify(ourTail) === JSON.stringify(theirHead)) {
        overlapCount = i;
      }
    }

    // Add only the new words (skip the overlapping part)
    const newWords = words.slice(overlapCount);
    if (newWords.length > 0) {
      state.allWordsEverSeen.push(...newWords);
    }
  }

  function flushWordChunk() {
    // Flush a chunk of words from allWordsEverSeen to history
    const TARGET_WORDS = 25;  // Smaller chunks for more frequent updates
    const unflushedWords = state.allWordsEverSeen.slice(state.lastFlushedIndex);

    if (unflushedWords.length >= TARGET_WORDS) {
      const chunkWords = unflushedWords.slice(0, TARGET_WORDS);
      const chunkText = chunkWords.join(' ');

      const video = getVideo();
      const currentTime = video ? video.currentTime : 0;

      captureToHistory(chunkText, currentTime);

      state.lastFlushedIndex += TARGET_WORDS;
      state.lastFlushTime = currentTime;
    }
  }

  function onCaptionEvent(text, isCaption) {
    if (!config.historyEnabled) {
      return;
    }

    const video = getVideo();
    const currentTime = video ? video.currentTime : 0;

    // Captions turned off - flush remaining words
    if (!isCaption || !text) {
      const remaining = state.allWordsEverSeen.slice(state.lastFlushedIndex);
      if (remaining.length > 10) {
        captureToHistory(remaining.join(' '), state.lastFlushTime || currentTime);
        state.lastFlushedIndex = state.allWordsEverSeen.length;
      }
      return;
    }

    const currentText = normalizeText(text);
    if (!currentText) return;

    // Accumulate all words
    accumulateAllWords(currentText);

    // Try to flush a chunk if we have enough words
    flushWordChunk();
  }

  function updateCaptionHistory(nextText, isCaption) {
    onCaptionEvent(nextText, isCaption);
  }

  function renderHistory() {
    const historyList = document.getElementById("captions-history-list");
    if (!historyList) {
      return;
    }

    historyList.textContent = "";

    if (!config.historyEnabled || !state.captionHistory.length) {
      const empty = createElement("div", "captions-history-empty");
      empty.textContent = config.historyEnabled
        ? "Sentences will appear here..."
        : "History disabled";
      historyList.appendChild(empty);
      return;
    }

    state.captionHistory.forEach((entry) => {
      const item = createElement("div", "captions-history-item");
      item.dataset.time = String(entry.time);

      const header = createElement("div", "captions-history-item-header");

      const time = createElement("span", "captions-history-time");
      time.textContent = entry.timestamp;

      const text = createElement("span", "captions-history-text");
      text.textContent = entry.text;

      const translationRow = createElement("div", "captions-history-translation");

      // Show existing translation if already fetched
      if (entry.translation) {
        translationRow.textContent = entry.translation;
        translationRow.style.display = "block";
      } else {
        translationRow.style.display = "none";
      }

      // Only show translate button if enabled and not yet translated
      if (config.dualSubtitles && !entry.translation) {
        const translateBtn = createElement("button", "captions-history-translate-btn");
        translateBtn.type = "button";
        translateBtn.appendChild(createSVGIcon("languages", 14));
        translateBtn.title = `Translate to ${config.targetLang.toUpperCase()}`;

        // Translate button click
        translateBtn.addEventListener("click", async (e) => {
          e.stopPropagation();

          translationRow.style.display = "block";
          translationRow.textContent = "Translating...";

          const translation = await translateText(entry.text, config.sourceLang, config.targetLang);
          entry.translation = translation; // Store on entry
          translationRow.textContent = translation;

          // Remove the button after translation
          translateBtn.remove();
        });

        header.append(time, translateBtn);
      } else {
        header.append(time);
      }

      // Click item to jump to time
      item.addEventListener("click", (e) => {
        if (e.target.closest(".captions-history-translate-btn")) return;
        const video = getVideo();
        if (video) {
          video.currentTime = Math.max(0, entry.time - 0.5);
          video.play().catch(() => {});
          flashStatus(`Jumped to ${entry.timestamp}`);
        }
      });

      item.append(header, text, translationRow);
      historyList.appendChild(item);
    });

    historyList.scrollTop = historyList.scrollHeight;
  }

  function renderCaptionWords(overlay, captionText) {
    if (state.renderedCaptionText === captionText) {
      return;
    }
    state.renderedCaptionText = captionText;
    overlay.textContent = "";

    // Split by lines first to preserve YouTube's line breaks
    const lines = captionText.split('\n');

    lines.forEach((line, lineIndex) => {
      // Split each line into words and whitespace
      const parts = line.split(/(\s+)/);

      parts.forEach((part, partIndex) => {
        if (!part) return;

        if (/^\s+$/.test(part)) {
          // Preserve whitespace as-is
          overlay.appendChild(document.createTextNode(part));
        } else {
          // Make words clickable
          const word = createElement("span", "captions-word");
          word.textContent = part;
          overlay.appendChild(word);

          // Safety: Add space after word if next part isn't whitespace
          // This ensures words never run together even if YouTube's caption text is malformed
          const nextPart = parts[partIndex + 1];
          if (nextPart !== undefined && !/^\s+$/.test(nextPart)) {
            overlay.appendChild(document.createTextNode(' '));
          }
        }
      });

      // Add line break between lines (except after last line)
      if (lineIndex < lines.length - 1) {
        overlay.appendChild(document.createElement('br'));
      }
    });
  }

  function applyOverlayState(overlay, nextState) {
    if (!nextState.showOverlay) {
      overlay.classList.add("is-hidden");
      overlay.classList.remove("is-warning", "is-caption", "is-empty-state");
      state.renderedCaptionText = "";
      overlay.textContent = "";
      updateCaptionHistory("", false);
      return;
    }

    overlay.classList.remove("is-hidden");

    if (nextState.isCaption) {
      // Active captions - show clickable words
      overlay.classList.remove("is-empty-state");
      renderCaptionWords(overlay, nextState.text);
      updateCaptionHistory(nextState.text, true);
    } else {
      // Empty state - show message
      overlay.classList.add("is-empty-state");
      state.renderedCaptionText = nextState.text;
      overlay.textContent = nextState.text;
      updateCaptionHistory("", false);
    }

    overlay.classList.toggle("is-warning", nextState.variant === "warning");
    overlay.classList.toggle("is-caption", nextState.isCaption);
  }

  function attachCaptionObserver(overlay) {
    const container = document.querySelector(".ytp-caption-window-container");
    if (!container && state.captionObserver) {
      state.captionObserver.disconnect();
      state.captionObserver = null;
      state.captionContainer = null;
      return;
    }
    if (container && container !== state.captionContainer) {
      if (state.captionObserver) {
        state.captionObserver.disconnect();
      }
      state.captionContainer = container;
      state.captionObserver = new MutationObserver(() => {
        // Don't update overlay while popup is open to prevent captions from disappearing
        if (!state.popupOpen) {
          applyOverlayState(overlay, getOverlayState());
        }
      });
      state.captionObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  function speakWord(word, language, audioUrl = null) {
    if (!word) {
      return;
    }

    // Try to play native audio from API first
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.play().catch(err => {
        console.warn("Failed to play native audio, falling back to speech synthesis:", err);
        useSpeechSynthesis(word, language);
      });
    } else {
      // No audio URL available, use speech synthesis
      useSpeechSynthesis(word, language);
    }
  }

  function useSpeechSynthesis(word, language) {
    if (!("speechSynthesis" in window)) {
      flashStatus("Speech not supported");
      return;
    }
    if (!word) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = language || "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Try to pick a good voice
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const preferred = voices.find(v => /Samantha|Google|Premium/.test(v.name));
      if (preferred) {
        utterance.voice = preferred;
      }
    }

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function getPlayerRect() {
    const player = document.querySelector("#movie_player, .html5-video-player");
    if (!player) {
      return null;
    }
    return player.getBoundingClientRect();
  }

  function updateOverlayPosition() {
    const overlay = document.getElementById("captions-floating-overlay");
    if (!overlay) {
      return;
    }

    // If user has set custom position, use that instead
    if (config.customPosition) {
      overlay.style.top = `${config.customPosition.top}px`;
      overlay.style.left = `${config.customPosition.left}px`;
      overlay.style.bottom = "auto";
      overlay.style.transform = "none";
      overlay.style.width = `${config.customPosition.width || 'min(900px, 85vw)'}`;
      return;
    }

    const rect = getPlayerRect();
    if (!rect) {
      // Fallback positioning
      overlay.style.left = "50%";
      overlay.style.bottom = "15%";
      overlay.style.top = "auto";
      overlay.style.transform = "translateX(-50%)";
      overlay.style.width = "min(900px, 85vw)";
      return;
    }

    // Position overlay at bottom of video player (80% width)
    // Use 15% from bottom to avoid CC button
    const overlayWidth = rect.width * 0.8;
    const left = rect.left + (rect.width - overlayWidth) / 2;
    const bottom = window.innerHeight - rect.bottom + (rect.height * 0.15); // 15% from video bottom

    overlay.style.left = `${left}px`;
    overlay.style.bottom = `${bottom}px`;
    overlay.style.top = "auto";
    overlay.style.transform = "none";
    overlay.style.width = `${overlayWidth}px`;
  }

  function mount() {
    if (!document.body || document.getElementById(ROOT_ID)) {
      return;
    }

    const root = createElement("div");
    root.id = ROOT_ID;

    // Floating Toggle Button (top-left corner with logo)
    const floatingToggle = createElement("button", "captions-floating-toggle");
    floatingToggle.type = "button";
    floatingToggle.id = "captions-floating-toggle";
    floatingToggle.title = "Toggle SideCap Sidebar";

    // Add logo icon
    const toggleIcon = document.createElement("img");
    toggleIcon.src = chrome.runtime.getURL("icons/icon48.png");
    toggleIcon.alt = "SideCap";
    toggleIcon.style.cssText = "width: 32px; height: 32px; display: block;";
    floatingToggle.appendChild(toggleIcon);

    // Sidebar Container
    const sidebar = createElement("div", "captions-sidebar");
    sidebar.id = "captions-sidebar";

    // Title Bar with shade toggle
    const titleBar = createElement("div", "captions-titlebar");

    const titleLeft = createElement("div", "captions-titlebar-left");
    const titleText = createElement("div", "captions-titlebar-text");
    titleText.textContent = "SideCap";

    const collapseButton = createElement("button", "captions-collapse-button");
    collapseButton.type = "button";
    collapseButton.appendChild(createSVGIcon("panel-right", 16));
    collapseButton.title = "Hide Sidebar";

    titleLeft.append(titleText);

    const titleRight = createElement("div", "captions-titlebar-right");

    const settingsIcon = createElement("button", "captions-settings-icon");
    settingsIcon.type = "button";
    settingsIcon.appendChild(createSVGIcon("settings", 18));
    settingsIcon.title = "Settings";

    titleRight.append(collapseButton, settingsIcon);

    titleBar.append(titleLeft, titleRight);

    // Content area (collapsible)
    const sidebarContent = createElement("div", "captions-sidebar-content");

    // History Section (integrated into sidebar)
    const historySection = createElement("div", "captions-history-section");

    const historyHeader = createElement("div", "captions-history-header");

    const historyTitle = createElement("span", "captions-history-title");
    historyTitle.textContent = "History";

    const historyCopyButton = createElement("button", "captions-history-copy");
    historyCopyButton.type = "button";
    historyCopyButton.appendChild(createSVGIcon("copy", 16));
    historyCopyButton.title = "Copy transcript to clipboard";

    // Debug: copy ALL words ever seen
    const debugCopyButton = createElement("button", "captions-history-copy");
    debugCopyButton.type = "button";
    debugCopyButton.appendChild(createSVGIcon("search", 16));
    debugCopyButton.title = "Copy ALL words (debug)";

    // Diff: compare transcript vs all words
    const diffButton = createElement("button", "captions-history-copy");
    diffButton.type = "button";
    diffButton.appendChild(createSVGIcon("git-compare", 16));
    diffButton.title = "Compare transcript vs all words";

    historyHeader.append(historyTitle, historyCopyButton, debugCopyButton, diffButton);

    const historyList = createElement("div", "captions-history-list");
    historyList.id = "captions-history-list";

    historySection.append(historyHeader, historyList);

    // Assemble sidebar (history only for now)
    sidebarContent.append(historySection);
    sidebar.append(titleBar, sidebarContent);

    // Floating Caption Overlay (default position - bottom of video)
    const floatingOverlay = createElement("div", "captions-floating-overlay");
    floatingOverlay.id = "captions-floating-overlay";

    const overlay = createElement("div", "captions-overlay");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-live", "polite");
    overlay.textContent = "";

    const dragHandle = createElement("button", "captions-drag-handle");
    dragHandle.type = "button";
    dragHandle.innerHTML = "⋮⋮";
    dragHandle.title = "Drag to reposition";

    const recenterButton = createElement("button", "captions-recenter-button");
    recenterButton.type = "button";
    recenterButton.appendChild(createSVGIcon("target", 14));
    recenterButton.title = "Recenter on video";

    const historyButton = createElement("button", "captions-history-button");
    historyButton.type = "button";
    historyButton.appendChild(createSVGIcon("list", 14));
    historyButton.title = "Show Transcript History";

    const speechCaptureButton = createElement("button", "captions-speech-capture-button");
    speechCaptureButton.type = "button";
    speechCaptureButton.appendChild(createSVGIcon("captions", 14));
    speechCaptureButton.title = "Smart Captions - Press Opt+Shift+C to start";

    const captionSettingsIcon = createElement("button", "captions-caption-settings-icon");
    captionSettingsIcon.type = "button";
    captionSettingsIcon.appendChild(createSVGIcon("settings", 16));
    captionSettingsIcon.title = "Caption Settings";

    floatingOverlay.append(dragHandle, recenterButton, historyButton, speechCaptureButton, overlay, captionSettingsIcon);

    // Word Definition Popup
    const popup = createElement("div", "captions-popup");
    popup.id = "captions-popup";

    const popupBackdrop = createElement("div", "captions-popup-backdrop");
    const popupContainer = createElement("div", "captions-popup-container");

    const popupHeader = createElement("div", "captions-popup-header");

    const popupHeaderLeft = createElement("div");
    const popupTitle = createElement("div", "captions-popup-title");
    popupTitle.textContent = "Word Analysis";
    popupHeaderLeft.appendChild(popupTitle);

    const popupClose = createElement("button", "captions-popup-close");
    popupClose.type = "button";
    popupClose.innerHTML = "×";

    popupHeader.append(popupHeaderLeft, popupClose);
    popupHeader.style.cursor = "grab";

    const popupContent = createElement("div", "captions-popup-content");
    const popupLoading = createElement("div", "captions-popup-loading");
    popupLoading.textContent = "Loading...";
    popupContent.appendChild(popupLoading);

    // Arrow pointing down to the word (hidden when dragged)
    const popupArrow = createElement("div", "captions-popup-arrow");

    popupContainer.append(popupHeader, popupContent, popupArrow);
    popup.append(popupBackdrop, popupContainer);

    // Popup drag functionality
    popupHeader.addEventListener("mousedown", (e) => {
      if (e.target === popupClose) return; // Don't drag when clicking close
      e.preventDefault();
      state.isPopupDragging = true;
      state.popupDragStartX = e.clientX;
      state.popupDragStartY = e.clientY;

      const rect = popupContainer.getBoundingClientRect();
      state.popupDragStartTop = rect.top;
      state.popupDragStartLeft = rect.left;

      popupHeader.style.cursor = "grabbing";
      popupArrow.style.display = "none"; // Hide arrow when dragging
    });

    document.addEventListener("mousemove", (e) => {
      if (!state.isPopupDragging) return;

      const deltaX = e.clientX - state.popupDragStartX;
      const deltaY = e.clientY - state.popupDragStartY;

      const newTop = state.popupDragStartTop + deltaY;
      const newLeft = state.popupDragStartLeft + deltaX;

      popupContainer.style.top = `${newTop}px`;
      popupContainer.style.left = `${newLeft}px`;
    });

    document.addEventListener("mouseup", () => {
      if (state.isPopupDragging) {
        state.isPopupDragging = false;
        popupHeader.style.cursor = "grab";

        // Save popup position
        const rect = popupContainer.getBoundingClientRect();
        config.popupPosition = {
          top: rect.top,
          left: rect.left
        };
        saveConfig();
      }
    });

    // Unified Learning Settings Panel
    const settingsPanel = createElement("div", "captions-unified-settings-panel");
    settingsPanel.id = "captions-unified-settings-panel";

    const settingsHeader = createElement("div", "captions-unified-settings-header");
    const settingsHeaderTitle = createElement("div", "captions-unified-settings-title");
    settingsHeaderTitle.textContent = "SideCap Settings";
    settingsHeader.append(settingsHeaderTitle);

    const settingsClose = createElement("button", "captions-settings-close");
    settingsClose.type = "button";
    settingsClose.innerHTML = "×";
    settingsClose.title = "Close Settings";

    const settingsContent = createElement("div", "captions-unified-settings-content");

    // === MODE SECTION ===
    const modeSection = createElement("div", "captions-settings-section");
    const modeSectionLabel = createElement("div", "captions-settings-section-label");
    modeSectionLabel.textContent = "MODE";
    const modePillGroup = createElement("div", "captions-pill-group");

    const learningPill = createElement("button", "captions-pill");
    learningPill.type = "button";
    learningPill.textContent = "Learning";
    learningPill.dataset.value = "learning";
    if (config.mode === "learning") learningPill.classList.add("is-active");

    const translationPill = createElement("button", "captions-pill");
    translationPill.type = "button";
    translationPill.textContent = "Translation";
    translationPill.dataset.value = "translation";
    if (config.mode === "translation") translationPill.classList.add("is-active");

    modePillGroup.append(learningPill, translationPill);
    modeSection.append(modeSectionLabel, modePillGroup);

    // === LANGUAGE SETTINGS SECTION (mode-dependent) ===
    const languageSection = createElement("div", "captions-settings-section");
    languageSection.id = "language-section";
    const languageSectionLabel = createElement("div", "captions-settings-section-label");
    languageSectionLabel.textContent = "LANGUAGE";

    // Learning Mode: Dictionary Language
    const learningLangGroup = createElement("div", "captions-settings-group");
    learningLangGroup.id = "learning-lang-group";
    const learningLangLabel = createElement("label", "captions-settings-label");
    learningLangLabel.textContent = "Dictionary Language";
    const learningLangControl = createElement("div", "captions-settings-control");
    const learningLangSelect = createElement("select", "captions-settings-select");
    learningLangSelect.id = "learning-lang-select";

    // Translation Mode: Source and Target Languages
    const translationLangGroup = createElement("div", "captions-settings-group");
    translationLangGroup.id = "translation-lang-group";
    translationLangGroup.style.display = "none";

    const sourceLangLabel = createElement("label", "captions-settings-label");
    sourceLangLabel.textContent = "Captions In";
    const sourceLangControl = createElement("div", "captions-settings-control");
    const sourceLangSelect = createElement("select", "captions-settings-select");
    sourceLangSelect.id = "source-lang-select";

    const targetLangLabel = createElement("label", "captions-settings-label");
    targetLangLabel.textContent = "Translate To";
    targetLangLabel.style.marginTop = "12px";
    const targetLangControl = createElement("div", "captions-settings-control");
    const targetLangSelect = createElement("select", "captions-settings-select");
    targetLangSelect.id = "target-lang-select";

    const languages = [
      { code: "en", name: "English" },
      { code: "es", name: "Spanish" },
      { code: "fr", name: "French" },
      { code: "de", name: "German" },
      { code: "it", name: "Italian" },
      { code: "pt", name: "Portuguese" },
      { code: "ru", name: "Russian" },
      { code: "ja", name: "Japanese" },
      { code: "ko", name: "Korean" },
      { code: "zh", name: "Chinese" },
      { code: "ar", name: "Arabic" },
      { code: "hi", name: "Hindi" },
      { code: "nl", name: "Dutch" },
      { code: "sv", name: "Swedish" },
      { code: "no", name: "Norwegian" },
      { code: "da", name: "Danish" },
      { code: "fi", name: "Finnish" },
      { code: "pl", name: "Polish" },
      { code: "tr", name: "Turkish" },
      { code: "el", name: "Greek" },
      { code: "he", name: "Hebrew" }
    ];

    // Populate language selectors
    languages.forEach(lang => {
      const learningOption = createElement("option");
      learningOption.value = lang.code;
      learningOption.textContent = lang.name;
      if (lang.code === config.dictionaryLang) {
        learningOption.selected = true;
      }
      learningLangSelect.appendChild(learningOption);

      const sourceOption = createElement("option");
      sourceOption.value = lang.code;
      sourceOption.textContent = lang.name;
      if (lang.code === config.sourceLang) {
        sourceOption.selected = true;
      }
      sourceLangSelect.appendChild(sourceOption);

      const targetOption = createElement("option");
      targetOption.value = lang.code;
      targetOption.textContent = lang.name;
      if (lang.code === config.targetLang) {
        targetOption.selected = true;
      }
      targetLangSelect.appendChild(targetOption);
    });

    learningLangControl.appendChild(learningLangSelect);
    learningLangGroup.append(learningLangLabel, learningLangControl);

    sourceLangControl.appendChild(sourceLangSelect);
    targetLangControl.appendChild(targetLangSelect);
    translationLangGroup.append(sourceLangLabel, sourceLangControl, targetLangLabel, targetLangControl);

    languageSection.append(languageSectionLabel, learningLangGroup, translationLangGroup);

    // Show/hide language controls based on mode
    function updateLanguageControls() {
      if (config.mode === "learning") {
        learningLangGroup.style.display = "flex";
        translationLangGroup.style.display = "none";
      } else {
        learningLangGroup.style.display = "none";
        translationLangGroup.style.display = "flex";
      }
    }
    updateLanguageControls();

    // === CAPTION LOCATION SECTION ===
    const locationSection = createElement("div", "captions-settings-section");
    const locationSectionLabel = createElement("div", "captions-settings-section-label");
    locationSectionLabel.textContent = "CAPTION LOCATION";
    const locationPillGroup = createElement("div", "captions-pill-group");

    const sidebarPill = createElement("button", "captions-pill");
    sidebarPill.type = "button";
    sidebarPill.textContent = "Sidebar";
    sidebarPill.dataset.value = "sidebar";
    if (config.captionLocation === "sidebar") sidebarPill.classList.add("is-active");

    const fixedPill = createElement("button", "captions-pill");
    fixedPill.type = "button";
    fixedPill.textContent = "Overlay Fixed";
    fixedPill.dataset.value = "overlay-fixed";
    if (config.captionLocation === "overlay-fixed") fixedPill.classList.add("is-active");

    const draggablePill = createElement("button", "captions-pill");
    draggablePill.type = "button";
    draggablePill.textContent = "Overlay Draggable";
    draggablePill.dataset.value = "overlay-draggable";
    if (config.captionLocation === "overlay-draggable") draggablePill.classList.add("is-active");

    locationPillGroup.append(sidebarPill, fixedPill, draggablePill);
    locationSection.append(locationSectionLabel, locationPillGroup);

    // === WORD DETAIL DENSITY SECTION ===
    const densitySection = createElement("div", "captions-settings-section");
    const densitySectionLabel = createElement("div", "captions-settings-section-label");
    densitySectionLabel.textContent = "WORD DETAIL DENSITY";

    // Helper function to create toggle switch
    function createToggle(label, id, checked) {
      const toggleRow = createElement("div", "captions-toggle-row");
      const toggleLabel = createElement("label", "captions-toggle-label");
      toggleLabel.textContent = label;
      toggleLabel.htmlFor = id;

      const toggleSwitch = createElement("label", "captions-toggle-switch");
      const toggleInput = createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.id = id;
      toggleInput.checked = checked;
      const toggleSlider = createElement("span", "captions-toggle-slider");

      toggleSwitch.append(toggleInput, toggleSlider);
      toggleRow.append(toggleLabel, toggleSwitch);
      return { row: toggleRow, input: toggleInput };
    }

    const phoneticsToggle = createToggle("Phonetics", "toggle-phonetics", config.showPhonetics);
    const posToggle = createToggle("Part of Speech", "toggle-pos", config.showPartOfSpeech);
    const definitionsToggle = createToggle("Definitions", "toggle-definitions", config.showDefinitions);
    const examplesToggle = createToggle("Example Usage", "toggle-examples", config.showExamples);

    densitySection.append(
      densitySectionLabel,
      phoneticsToggle.row,
      posToggle.row,
      definitionsToggle.row,
      examplesToggle.row
    );

    // === CAPTION APPEARANCE SECTION ===
    const appearanceSection = createElement("div", "captions-settings-section");
    const appearanceSectionLabel = createElement("div", "captions-settings-section-label");
    appearanceSectionLabel.textContent = "CAPTION APPEARANCE";

    // Opacity Control
    const capOpacityGroup = createElement("div", "captions-settings-group");
    const capOpacityLabel = createElement("label", "captions-settings-label");
    capOpacityLabel.textContent = "Opacity";
    const capOpacityControl = createElement("div", "captions-settings-control");
    const capOpacitySlider = createElement("input", "captions-settings-slider");
    capOpacitySlider.type = "range";
    capOpacitySlider.min = "0.3";
    capOpacitySlider.max = "1";
    capOpacitySlider.step = "0.05";
    capOpacitySlider.value = config.captionOpacity.toString();
    capOpacitySlider.id = "caption-opacity-slider";
    const capOpacityValue = createElement("span", "captions-settings-value");
    capOpacityValue.textContent = `${Math.round(config.captionOpacity * 100)}%`;
    capOpacityControl.append(capOpacitySlider, capOpacityValue);
    capOpacityGroup.append(capOpacityLabel, capOpacityControl);

    // Font Size Control
    const capFontSizeGroup = createElement("div", "captions-settings-group");
    const capFontSizeLabel = createElement("label", "captions-settings-label");
    capFontSizeLabel.textContent = "Font Size";
    const capFontSizeControl = createElement("div", "captions-settings-control");
    const capFontSizeSlider = createElement("input", "captions-settings-slider");
    capFontSizeSlider.type = "range";
    capFontSizeSlider.min = "14";
    capFontSizeSlider.max = "48";
    capFontSizeSlider.value = config.captionFontSize.toString();
    capFontSizeSlider.id = "caption-font-size-slider";
    const capFontSizeValue = createElement("span", "captions-settings-value");
    capFontSizeValue.textContent = `${config.captionFontSize}px`;
    capFontSizeControl.append(capFontSizeSlider, capFontSizeValue);
    capFontSizeGroup.append(capFontSizeLabel, capFontSizeControl);

    // Font Family Control
    const capFontFamilyGroup = createElement("div", "captions-settings-group");
    const capFontFamilyLabel = createElement("label", "captions-settings-label");
    capFontFamilyLabel.textContent = "Font Family";
    const capFontFamilyControl = createElement("div", "captions-settings-control");
    const capFontFamilySelect = createElement("select", "captions-settings-select");
    capFontFamilySelect.id = "caption-font-family-select";

    const fonts = [
      { value: "inherit", name: "Default (YouTube)" },
      { value: "Arial, sans-serif", name: "Arial" },
      { value: "'Roboto', sans-serif", name: "Roboto" },
      { value: "'Helvetica Neue', sans-serif", name: "Helvetica" },
      { value: "'Courier New', monospace", name: "Courier" },
      { value: "'Georgia', serif", name: "Georgia" },
      { value: "'Times New Roman', serif", name: "Times" },
      { value: "'Comic Sans MS', cursive", name: "Comic Sans" },
    ];

    fonts.forEach(font => {
      const option = createElement("option");
      option.value = font.value;
      option.textContent = font.name;
      if (font.value === config.captionFontFamily) {
        option.selected = true;
      }
      capFontFamilySelect.appendChild(option);
    });

    capFontFamilyControl.appendChild(capFontFamilySelect);
    capFontFamilyGroup.append(capFontFamilyLabel, capFontFamilyControl);

    // Colors Control (Text + Background side by side)
    const capColorGroup = createElement("div", "captions-settings-group");
    const capColorLabel = createElement("label", "captions-settings-label");
    capColorLabel.textContent = "Colors";
    const capColorControl = createElement("div", "captions-settings-control");
    capColorControl.style.gap = "8px";

    const textColorWrap = createElement("div");
    textColorWrap.style.flex = "1";
    const textColorLabel = createElement("div");
    textColorLabel.textContent = "Text";
    textColorLabel.style.fontSize = "10px";
    textColorLabel.style.color = "var(--text-muted)";
    textColorLabel.style.marginBottom = "4px";
    const capColorInput = createElement("input");
    capColorInput.type = "color";
    capColorInput.value = config.captionColor;
    capColorInput.id = "caption-color-input";
    capColorInput.style.width = "100%";
    capColorInput.style.height = "32px";
    capColorInput.style.border = "1px solid var(--border)";
    capColorInput.style.borderRadius = "6px";
    capColorInput.style.cursor = "pointer";
    textColorWrap.append(textColorLabel, capColorInput);

    const bgColorWrap = createElement("div");
    bgColorWrap.style.flex = "1";
    const bgColorLabel = createElement("div");
    bgColorLabel.textContent = "Background";
    bgColorLabel.style.fontSize = "10px";
    bgColorLabel.style.color = "var(--text-muted)";
    bgColorLabel.style.marginBottom = "4px";
    const capBgColorInput = createElement("input");
    capBgColorInput.type = "color";
    capBgColorInput.value = config.captionBgColor;
    capBgColorInput.id = "caption-bg-color-input";
    capBgColorInput.style.width = "100%";
    capBgColorInput.style.height = "32px";
    capBgColorInput.style.border = "1px solid var(--border)";
    capBgColorInput.style.borderRadius = "6px";
    capBgColorInput.style.cursor = "pointer";
    bgColorWrap.append(bgColorLabel, capBgColorInput);

    capColorControl.append(textColorWrap, bgColorWrap);
    capColorGroup.append(capColorLabel, capColorControl);

    // Width Control
    const capWidthGroup = createElement("div", "captions-settings-group");
    const capWidthLabel = createElement("label", "captions-settings-label");
    capWidthLabel.textContent = "Width";
    const capWidthControl = createElement("div", "captions-settings-control");
    const capWidthSlider = createElement("input", "captions-settings-slider");
    capWidthSlider.type = "range";
    capWidthSlider.min = "40";
    capWidthSlider.max = "100";
    capWidthSlider.value = config.captionWidth.toString();
    capWidthSlider.id = "caption-width-slider";
    const capWidthValue = createElement("span", "captions-settings-value");
    capWidthValue.textContent = `${config.captionWidth}%`;
    capWidthControl.append(capWidthSlider, capWidthValue);
    capWidthGroup.append(capWidthLabel, capWidthControl);

    // Show Native YouTube Captions Toggle
    const nativeCaptionsToggle = createToggle("Show Native YouTube Captions", "toggle-native-captions", config.showNativeCaptions);

    appearanceSection.append(
      appearanceSectionLabel,
      capOpacityGroup,
      capFontSizeGroup,
      capFontFamilyGroup,
      capColorGroup,
      capWidthGroup,
      nativeCaptionsToggle.row
    );

    // === THEME SECTION ===
    const themeSection = createElement("div", "captions-settings-section");
    const themeSectionLabel = createElement("div", "captions-settings-section-label");
    themeSectionLabel.textContent = "THEME";
    const themePillGroup = createElement("div", "captions-pill-group");

    const darkPill = createElement("button", "captions-pill");
    darkPill.type = "button";
    darkPill.textContent = "Dark";
    darkPill.dataset.value = "dark";
    if (config.theme === "dark") darkPill.classList.add("is-active");

    const lightPill = createElement("button", "captions-pill");
    lightPill.type = "button";
    lightPill.textContent = "Light";
    lightPill.dataset.value = "light";
    if (config.theme === "light") lightPill.classList.add("is-active");

    themePillGroup.append(darkPill, lightPill);
    themeSection.append(themeSectionLabel, themePillGroup);

    // === TRANSLATION SECTION ===
    const dualSection = createElement("div", "captions-settings-section");
    const dualSectionLabel = createElement("div", "captions-settings-section-label");
    dualSectionLabel.textContent = "TRANSLATION";

    const dualToggle = createToggle("Show translate buttons in history", "toggle-dual-subtitles", config.dualSubtitles);

    dualSection.append(dualSectionLabel, dualToggle.row);

    // Assemble all sections
    settingsContent.append(
      modeSection,
      languageSection,
      locationSection,
      densitySection,
      appearanceSection,
      themeSection,
      dualSection
    );

    settingsPanel.append(settingsHeader, settingsClose, settingsContent);

    // Assemble
    root.append(floatingToggle, sidebar, floatingOverlay, popup, settingsPanel);
    document.body.appendChild(root);

    // Event Handlers

    // Helper function to toggle sidebar and trigger YouTube resize
    function toggleSidebar() {
      const willBeHidden = !sidebar.classList.contains("is-hidden");

      // For expand (opening), trigger resize slightly before to pre-shift YouTube
      if (willBeHidden === false) {
        window.dispatchEvent(new Event('resize'));

        // Check if caption overlay is in danger zone (will be hidden under sidebar)
        if (config.customPosition && floatingOverlay) {
          const sidebarWidth = 402;
          const safeMargin = 20; // Extra padding from sidebar edge

          // If caption is positioned in the left danger zone
          if (config.customPosition.left < sidebarWidth + safeMargin) {
            // Move it to safe position (just right of sidebar)
            config.customPosition.left = sidebarWidth + safeMargin;
            floatingOverlay.style.left = `${config.customPosition.left}px`;
            saveConfig();
          }
        }

        // Small delay to let YouTube start adjusting before sidebar appears
        setTimeout(() => {
          sidebar.classList.toggle("is-hidden");
        }, 20);
      } else {
        // For collapse (closing), toggle immediately
        sidebar.classList.toggle("is-hidden");
        window.dispatchEvent(new Event('resize'));
      }

      const isHidden = sidebar.classList.contains("is-hidden");

      // Update collapse button icon and title
      setTimeout(() => {
        collapseButton.textContent = "";
        collapseButton.appendChild(createSVGIcon("panel-right", 16));
        collapseButton.title = isHidden ? "Show Sidebar" : "Hide Sidebar";
      }, willBeHidden === false ? 20 : 0);

      // Save state
      config.sidebarCollapsed = isHidden;
      saveConfig();

      // Final resize after fast transition completes (0.2s)
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 250);
    }

    // Floating toggle button - toggles entire sidebar visibility
    floatingToggle.addEventListener("click", toggleSidebar);

    // Collapse button - toggles entire sidebar visibility
    collapseButton.addEventListener("click", toggleSidebar);

    // History button - toggles sidebar visibility
    historyButton.addEventListener("click", toggleSidebar);

    // Recenter button - repositions caption overlay to video center
    function recenterOverlay() {
      const video = document.querySelector("video");
      if (!video) return;

      const videoRect = video.getBoundingClientRect();
      const overlayRect = floatingOverlay.getBoundingClientRect();

      // Center horizontally and position near bottom of video
      const centerLeft = videoRect.left + (videoRect.width - overlayRect.width) / 2;
      const bottomTop = videoRect.bottom - overlayRect.height - 60;

      floatingOverlay.style.top = `${bottomTop}px`;
      floatingOverlay.style.left = `${centerLeft}px`;
      floatingOverlay.style.bottom = "auto";
      floatingOverlay.style.transform = "none";

      // Save new position
      config.customPosition = {
        top: bottomTop,
        left: centerLeft,
        width: `${overlayRect.width}px`
      };
      saveConfig();
    }

    recenterButton.addEventListener("click", (e) => {
      e.stopPropagation();
      recenterOverlay();
    });

    // Smart Captions button
    speechCaptureButton.addEventListener("click", async (e) => {
      e.stopPropagation();
      console.log("[SideCap] SC button clicked, current state:", state.speechCaptureActive);

      if (state.speechCaptureActive) {
        // Stop capture
        console.log("[SideCap] Stopping Smart Captions...");
        await stopSpeechCapture();
        speechCaptureButton.innerHTML = "";
        speechCaptureButton.appendChild(createSVGIcon("captions", 14));
        speechCaptureButton.title = "Smart Captions - Press Opt+Shift+C to start";
        speechCaptureButton.classList.remove("is-active");
        flashStatus("Smart Captions stopped. Press Opt+Shift+C to restart.");
      } else {
        // Guide user to use keyboard shortcut (can't start from content script click)
        console.log("[SideCap] SC not active, prompting user to use shortcut");
        flashStatus("Press Opt+Shift+C to start Smart Captions");
      }
    });

    // Drag functionality for floating overlay
    dragHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.isDragging = true;
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;

      const rect = floatingOverlay.getBoundingClientRect();
      state.dragStartTop = rect.top;
      state.dragStartLeft = rect.left;

      floatingOverlay.style.cursor = "grabbing";
      dragHandle.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!state.isDragging) return;

      const deltaX = e.clientX - state.dragStartX;
      const deltaY = e.clientY - state.dragStartY;

      const newTop = state.dragStartTop + deltaY;
      const newLeft = state.dragStartLeft + deltaX;

      // Apply position
      floatingOverlay.style.top = `${newTop}px`;
      floatingOverlay.style.left = `${newLeft}px`;
      floatingOverlay.style.bottom = "auto";
      floatingOverlay.style.transform = "none";
    });

    document.addEventListener("mouseup", () => {
      if (state.isDragging) {
        state.isDragging = false;
        floatingOverlay.style.cursor = "";
        dragHandle.style.cursor = "grab";

        // Save custom position
        const rect = floatingOverlay.getBoundingClientRect();
        config.customPosition = {
          top: rect.top,
          left: rect.left,
          width: `${rect.width}px`
        };
        saveConfig();
      }
    });

    // History copy button click
    historyCopyButton.addEventListener("click", async (e) => {
      e.stopPropagation();

      if (state.captionHistory.length === 0) {
        flashStatus("No history to copy");
        return;
      }

      // Format history as text with timestamps
      const transcriptText = state.captionHistory
        .map(entry => `[${entry.timestamp}] ${entry.text}`)
        .join('\n\n');

      try {
        await navigator.clipboard.writeText(transcriptText);
        flashStatus("Transcript copied!");

        // Visual feedback - change icon briefly
        historyCopyButton.textContent = "";
        historyCopyButton.appendChild(createSVGIcon("check", 16));
        setTimeout(() => {
          historyCopyButton.textContent = "";
          historyCopyButton.appendChild(createSVGIcon("copy", 16));
        }, 1500);
      } catch (error) {
        flashStatus("Copy failed");
      }
    });

    // Debug copy button - copy ALL words ever seen
    debugCopyButton.addEventListener("click", async (e) => {
      e.stopPropagation();

      if (state.allWordsEverSeen.length === 0) {
        flashStatus("No words tracked");
        return;
      }

      // Format as plain text
      const allWordsText = state.allWordsEverSeen.join(' ');

      try {
        await navigator.clipboard.writeText(allWordsText);
        flashStatus(`All words copied! (${state.allWordsEverSeen.length} words)`);
        console.log(`[Debug] Copied all ${state.allWordsEverSeen.length} words`);

        // Visual feedback
        debugCopyButton.textContent = "";
        debugCopyButton.appendChild(createSVGIcon("check", 16));
        setTimeout(() => {
          debugCopyButton.textContent = "";
          debugCopyButton.appendChild(createSVGIcon("search", 16));
        }, 1500);
      } catch (error) {
        flashStatus("Copy failed");
      }
    });

    // Diff button - compare transcript vs all words
    diffButton.addEventListener("click", async (e) => {
      e.stopPropagation();

      if (state.allWordsEverSeen.length === 0 || state.captionHistory.length === 0) {
        flashStatus("Not enough data");
        return;
      }

      // Strip timestamps from transcript and join
      const transcriptText = state.captionHistory
        .map(entry => entry.text)
        .join(' ');

      const allWordsText = state.allWordsEverSeen.join(' ');

      // Create comparison report
      const report = `=== DIFF REPORT ===

ALL WORDS (${state.allWordsEverSeen.length} words):
${allWordsText}

---

TRANSCRIPT (stripped timestamps):
${transcriptText}

---

STATS:
- All words: ${state.allWordsEverSeen.length}
- Transcript word count: ${transcriptText.split(/\s+/).length}
- History entries: ${state.captionHistory.length}
- Match: ${transcriptText === allWordsText ? '✓ PERFECT' : '✗ MISMATCH'}
`;

      try {
        await navigator.clipboard.writeText(report);
        flashStatus("Diff copied!");
        console.log("[Diff] Comparison report copied to clipboard");

        // Visual feedback
        diffButton.textContent = "";
        diffButton.appendChild(createSVGIcon("check", 16));
        setTimeout(() => {
          diffButton.textContent = "";
          diffButton.appendChild(createSVGIcon("git-compare", 16));
        }, 1500);
      } catch (error) {
        flashStatus("Copy failed");
      }
    });

    // Settings icon click
    settingsIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsPanel.classList.toggle("is-visible");
    });

    // Settings close button
    settingsClose.addEventListener("click", () => {
      settingsPanel.classList.remove("is-visible");
    });

    // === MODE PILL BUTTONS ===
    function handleModePillClick(e) {
      const value = e.currentTarget.dataset.value;
      config.mode = value;

      // Update active state
      learningPill.classList.toggle("is-active", value === "learning");
      translationPill.classList.toggle("is-active", value === "translation");

      // Update language controls visibility
      updateLanguageControls();

      flashStatus(`Mode: ${value === "learning" ? "Learning" : "Translation"}`);
      saveConfig();
    }

    learningPill.addEventListener("click", handleModePillClick);
    translationPill.addEventListener("click", handleModePillClick);

    // === CAPTION LOCATION PILL BUTTONS ===
    function handleLocationPillClick(e) {
      const value = e.currentTarget.dataset.value;
      config.captionLocation = value;

      // Update active state
      sidebarPill.classList.toggle("is-active", value === "sidebar");
      fixedPill.classList.toggle("is-active", value === "overlay-fixed");
      draggablePill.classList.toggle("is-active", value === "overlay-draggable");

      flashStatus(`Caption location: ${value}`);
      saveConfig();

      // TODO: Implement actual location switching logic
    }

    sidebarPill.addEventListener("click", handleLocationPillClick);
    fixedPill.addEventListener("click", handleLocationPillClick);
    draggablePill.addEventListener("click", handleLocationPillClick);

    // === WORD DETAIL DENSITY TOGGLES ===
    phoneticsToggle.input.addEventListener("change", (e) => {
      config.showPhonetics = e.target.checked;
      saveConfig();
    });

    posToggle.input.addEventListener("change", (e) => {
      config.showPartOfSpeech = e.target.checked;
      saveConfig();
    });

    definitionsToggle.input.addEventListener("change", (e) => {
      config.showDefinitions = e.target.checked;
      saveConfig();
    });

    examplesToggle.input.addEventListener("change", (e) => {
      config.showExamples = e.target.checked;
      saveConfig();
    });

    nativeCaptionsToggle.input.addEventListener("change", (e) => {
      config.showNativeCaptions = e.target.checked;
      updateNativeCaptionsVisibility();
      flashStatus(`Native captions: ${e.target.checked ? "shown" : "hidden"}`);
      saveConfig();
    });

    // === THEME PILLS ===
    function applyTheme(theme) {
      root.classList.remove("theme-dark", "theme-light");
      root.classList.add(`theme-${theme}`);
    }

    function handleThemePillClick(e) {
      const value = e.currentTarget.dataset.value;
      config.theme = value;

      darkPill.classList.toggle("is-active", value === "dark");
      lightPill.classList.toggle("is-active", value === "light");

      applyTheme(value);
      flashStatus(`Theme: ${value}`);
      saveConfig();
    }

    darkPill.addEventListener("click", handleThemePillClick);
    lightPill.addEventListener("click", handleThemePillClick);

    // Apply initial theme
    applyTheme(config.theme);

    // === TRANSLATION TOGGLE ===
    dualToggle.input.addEventListener("change", (e) => {
      config.dualSubtitles = e.target.checked;
      renderHistory(); // Re-render to show/hide translate buttons
      flashStatus(`Translation: ${e.target.checked ? "enabled" : "disabled"}`);
      saveConfig();
    });

    // === LANGUAGE SELECTORS ===
    learningLangSelect.addEventListener("change", (e) => {
      config.dictionaryLang = e.target.value;
      flashStatus(`Dictionary language: ${e.target.options[e.target.selectedIndex].text}`);
      saveConfig();
    });

    sourceLangSelect.addEventListener("change", (e) => {
      config.sourceLang = e.target.value;
      flashStatus(`Captions in: ${e.target.options[e.target.selectedIndex].text}`);
      saveConfig();
    });

    targetLangSelect.addEventListener("change", (e) => {
      config.targetLang = e.target.value;
      flashStatus(`Translate to: ${e.target.options[e.target.selectedIndex].text}`);
      saveConfig();
    });

    // Caption Settings Icon (opens unified panel now)
    captionSettingsIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsPanel.classList.toggle("is-visible");
    });

    // Caption Opacity Slider
    capOpacitySlider.addEventListener("input", (e) => {
      const value = parseFloat(e.target.value);
      config.captionOpacity = value;
      capOpacityValue.textContent = `${Math.round(value * 100)}%`;
      applyBgColor();
      saveConfig();
    });

    // Caption Font Size Slider
    capFontSizeSlider.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      config.captionFontSize = value;
      capFontSizeValue.textContent = `${value}px`;
      overlay.style.fontSize = `${value}px`;
      saveConfig();
    });

    // Caption Font Family Select
    capFontFamilySelect.addEventListener("change", (e) => {
      config.captionFontFamily = e.target.value;
      overlay.style.fontFamily = e.target.value;
      saveConfig();
    });

    // Caption Color Input
    capColorInput.addEventListener("input", (e) => {
      config.captionColor = e.target.value;
      overlay.style.color = e.target.value;
      saveConfig();
    });

    capBgColorInput.addEventListener("input", (e) => {
      config.captionBgColor = e.target.value;
      applyBgColor();
      saveConfig();
    });

    function applyBgColor() {
      // Convert hex to rgba with opacity
      const hex = config.captionBgColor;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      floatingOverlay.style.background = `rgba(${r}, ${g}, ${b}, ${config.captionOpacity})`;
    }

    // Caption Width Slider
    capWidthSlider.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      config.captionWidth = value;
      capWidthValue.textContent = `${value}%`;

      // Update overlay width
      const rect = getPlayerRect();
      if (rect) {
        const overlayWidth = rect.width * (value / 100);
        floatingOverlay.style.width = `${overlayWidth}px`;
      }
      saveConfig();
    });

    overlay.addEventListener("click", async (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const wordEl = event.target.closest(".captions-word");
      if (!wordEl) {
        return;
      }

      // Pause immediately for responsiveness (no rewind - keeps caption stable)
      const video = getVideo();
      if (video) {
        video.pause();
      }

      const wordText = normalizeWord(wordEl.textContent);
      if (!wordText) {
        return;
      }

      flashStatus(`Looking up: ${wordText}`);
      state.activeWord = wordText;

      // Show popup
      popup.classList.add("is-open");

      // Position popup - use saved position or position above clicked word
      const wordRect = wordEl.getBoundingClientRect();
      const container = popup.querySelector(".captions-popup-container");
      const arrow = popup.querySelector(".captions-popup-arrow");

      if (container) {
        if (config.popupPosition) {
          // Use saved position
          container.style.left = `${config.popupPosition.left}px`;
          container.style.top = `${config.popupPosition.top}px`;
          // Hide arrow when using saved position (not pointing at word)
          if (arrow) {
            arrow.style.display = "none";
          }
        } else {
          // Position above the clicked word
          const popupWidth = 420; // max-width from CSS
          const popupHeight = 400; // estimated
          const arrowSize = 12; // arrow height in pixels

          // Center popup horizontally over the word, but keep it on screen
          let left = wordRect.left + (wordRect.width / 2) - (popupWidth / 2);
          left = Math.max(20, Math.min(left, window.innerWidth - popupWidth - 20));

          // Position above the word with gap for arrow
          const top = wordRect.top - popupHeight - arrowSize - 10;

          container.style.left = `${left}px`;
          container.style.top = `${Math.max(20, top)}px`;

          // Position arrow to point at the word center
          if (arrow) {
            arrow.style.display = "";
            const arrowLeft = wordRect.left + (wordRect.width / 2) - left - 12; // 12 = half arrow width
            arrow.style.left = `${arrowLeft}px`;
          }
        }
      }

      state.popupOpen = true;
      popupContent.innerHTML = '<div class="captions-popup-loading">Loading definition...</div>';

      // Lookup word
      const language = config.dictionaryLang || "en";
      const cacheKey = getCacheKey(wordText, language);
      const cached = getCachedEntry(cacheKey);

      try {
        let data;
        if (cached) {
          data = cached;
        } else {
          data = await fetchDictionaryEntry(wordText, language);
          setCachedEntry(cacheKey, data);
        }

        if (!state.popupOpen) {
          return;
        }

        const parsed = parseDictionaryData(data);
        renderPopupContent(popupContent, parsed);
      } catch (error) {
        if (!state.popupOpen) {
          return;
        }
        popupContent.innerHTML = '<div class="captions-popup-error">Definition not found</div>';
      }
    });

    popupClose.addEventListener("click", () => {
      popup.classList.remove("is-open");
      state.popupOpen = false;
      // Refresh overlay state when popup closes
      applyOverlayState(overlay, getOverlayState());
    });

    // Click backdrop to close popup
    popupBackdrop.addEventListener("click", () => {
      popup.classList.remove("is-open");
      state.popupOpen = false;
      applyOverlayState(overlay, getOverlayState());
    });

    // ESC key to close popup
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.popupOpen) {
        popup.classList.remove("is-open");
        state.popupOpen = false;
        applyOverlayState(overlay, getOverlayState());
      }
    });

    async function renderPopupContent(container, parsed) {
      container.textContent = "";

      // Word header with phonetic and pronunciation button
      const wordHeader = createElement("div");
      wordHeader.style.display = "flex";
      wordHeader.style.alignItems = "center";
      wordHeader.style.justifyContent = "space-between";
      wordHeader.style.marginBottom = "16px";

      const wordInfo = createElement("div");
      const wordEl = createElement("div", "captions-popup-word");
      wordEl.textContent = parsed.word;

      const phoneticEl = createElement("div", "captions-popup-phonetic");
      phoneticEl.textContent = parsed.pronunciations.length ? `/${parsed.pronunciations[0]}/` : "";

      wordInfo.append(wordEl, phoneticEl);

      const speakBtn = createElement("button", "captions-popup-speak");
      speakBtn.type = "button";
      speakBtn.appendChild(createSVGIcon("volume", 20));
      speakBtn.addEventListener("click", () => {
        speakWord(parsed.word, config.dictionaryLang, parsed.audioUrl);
      });

      wordHeader.append(wordInfo, speakBtn);
      container.appendChild(wordHeader);

      // Translation section (translation mode, or learning mode with translation enabled)
      const showTranslation = config.mode === "translation" || config.dualSubtitles;
      if (showTranslation) {
        const transSection = createElement("div", "captions-popup-section");
        const transLabel = createElement("div", "captions-popup-label");
        transLabel.textContent = config.targetLang.toUpperCase();

        const transValue = createElement("div", "captions-popup-translation");
        transValue.textContent = "...";

        transSection.append(transLabel, transValue);
        container.appendChild(transSection);

        // Fetch translation async
        translateText(parsed.word, config.sourceLang, config.targetLang)
          .then(translation => {
            transValue.textContent = translation;
          });
      }

      // Definition (if enabled and available)
      if (config.showDefinitions && parsed.definitions.length) {
        const defSection = createElement("div", "captions-popup-section");
        const defLabel = createElement("div", "captions-popup-label");
        defLabel.textContent = "DEFINITION";

        const defValue = createElement("div", "captions-popup-definition");
        defValue.textContent = parsed.definitions[0];

        defSection.append(defLabel, defValue);
        container.appendChild(defSection);
      }

      // Examples (if enabled and available)
      if (config.showExamples && parsed.examples && parsed.examples.length > 0) {
        const exampleSection = createElement("div", "captions-popup-section");
        const exampleLabel = createElement("div", "captions-popup-label");
        exampleLabel.textContent = "EXAMPLE";

        const exampleValue = createElement("div", "captions-popup-example");
        exampleValue.textContent = `"${parsed.examples[0]}"`;

        exampleSection.append(exampleLabel, exampleValue);
        container.appendChild(exampleSection);
      }

      // Show error only if nothing to display
      if (!showTranslation && !parsed.definitions.length) {
        const noData = createElement("div", "captions-popup-error");
        noData.textContent = "No definition available";
        container.appendChild(noData);
      }
    }

    // Initialize styles from config
    overlay.style.fontSize = `${config.captionFontSize}px`;
    overlay.style.fontFamily = config.captionFontFamily;
    overlay.style.color = config.captionColor;
    applyBgColor(); // Apply background with color and opacity

    // Apply saved sidebar visibility state
    if (config.sidebarCollapsed) {
      sidebar.classList.add("is-hidden");
      collapseButton.textContent = "";
      collapseButton.appendChild(createSVGIcon("panel-right", 16));
      collapseButton.title = "Show Sidebar";
    }

    // Initialize
    checkVideoChange();  // Set initial video ID
    renderHistory();
    attachCaptionObserver(overlay);

    // Auto-center overlay on first load (if no custom position saved)
    if (!config.customPosition) {
      setTimeout(() => {
        recenterOverlay();
      }, 500);
    }
    applyOverlayState(overlay, getOverlayState());
    updateOverlayPosition();

    // Polling and updates
    setInterval(() => {
      checkVideoChange();  // Detect video navigation and clear state
      attachCaptionObserver(overlay);
      applyOverlayState(overlay, getOverlayState());
      updateNativeCaptionsVisibility(); // Keep native captions visibility in sync
    }, CAPTION_POLL_MS);

    // Update overlay position on resize/scroll
    window.addEventListener("resize", updateOverlayPosition);
    window.addEventListener("scroll", updateOverlayPosition, true);

    // Backup: flush if text has been showing for too long
    setInterval(() => {
      if (!config.historyEnabled) return;
      if (!state.lastSeenText || !state.lastSeenTime) return;

      const video = getVideo();
      const currentTime = video ? video.currentTime : 0;

      // If text has been showing for >20 seconds, flush it
      if ((currentTime - state.lastSeenTime) > 20) {
        console.log(`[Captions] ⏰ Time backup flush`);
        captureToHistory(state.lastSeenText, state.lastSeenTime);
        state.lastSeenText = "";
        state.lastSeenTime = 0;
      }
    }, 3000);
  }

  // Initialize: load config first, then mount UI
  async function init() {
    await loadConfig();
    console.log("[SideCap] Config loaded, mounting UI...");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }

  init();
})();
