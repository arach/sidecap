(function () {
  const ROOT_ID = "captions-root-v2";
  const OVERLAY_ID = "captions-overlay-v2";
  const CAPTION_POLL_MS = 500;
  const REPLAY_BACK_SECONDS = 1.6;
  const STATUS_FLASH_MS = 1600;
  const DICTIONARY_API_BASE = "https://api.dictionaryapi.dev/api/v2/entries";
  const DICTIONARY_CACHE_TTL_MS = 60 * 60 * 1000;
  const CONTROL_SEEK_SECONDS = 5;

  const defaultConfig = {
    align: "left",
    fontSize: 24,
    opacity: 0.95,
    blur: 8,
    dictionaryLang: "en",
    historyEnabled: true,
    historySize: 12,
    customPosition: null, // { top, left } for custom drag position
    popupMode: "compact", // "compact" or "fullscreen"
  };

  const config = { ...defaultConfig };

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
    // Track all words and flush in chunks
    allWordsEverSeen: [],     // All unique words in order seen
    lastFlushedIndex: 0,      // Words up to this index have been flushed to history
    lastFlushTime: 0,         // When we last flushed
    lastCapturedText: "",     // For deduplication
    currentVideoId: null,     // Track current video to detect navigation
  };

  const dictionaryCache = new Map();

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

    if (type === "copy") {
      // Clipboard icon
      svg.innerHTML = `
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      `;
    } else if (type === "settings") {
      // Gear icon
      svg.innerHTML = `
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M12 1v6m0 6v6m4.22-13a10 10 0 0 1 0 14M7.78 6a10 10 0 0 0 0 12"></path>
        <path d="M19.78 12h-3.56m-8.44 0H4.22"></path>
      `;
    } else if (type === "history") {
      // Clock/History icon
      svg.innerHTML = `
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      `;
    } else if (type === "check") {
      // Checkmark
      svg.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
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

  function getCaptionText() {
    const container = document.querySelector(".ytp-caption-window-container");
    if (container) {
      // Use innerText to preserve YouTube's line breaks
      return container.innerText;
    }
    const segments = Array.from(
      document.querySelectorAll(".ytp-caption-segment")
    );
    if (!segments.length) {
      return "";
    }
    return segments
      .map((segment) => segment.textContent)
      .filter(Boolean)
      .join("")
      .trim();
  }

  function getCaptionsButton() {
    return document.querySelector(".ytp-subtitles-button");
  }

  function getCaptionAvailability() {
    if (!document.querySelector("video")) {
      return "no-video";
    }
    const button = getCaptionsButton();
    if (!button || button.getAttribute("aria-disabled") === "true") {
      return "unavailable";
    }
    if (button.getAttribute("aria-pressed") === "true") {
      return "enabled";
    }
    return "disabled";
  }

  function getOverlayState() {
    const captionText = getCaptionText();
    if (captionText) {
      return {
        text: captionText,
        status: "Captions active",
        variant: "active",
        isCaption: true,
        showOverlay: true,
      };
    }

    const availability = getCaptionAvailability();
    if (availability === "no-video") {
      return {
        text: "Open a YouTube video to see captions.",
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
    // Remove YouTube UI noise patterns - aggressive cleanup
    let cleaned = text
      .replace(/\(auto-generated\)/gi, "")
      .replace(/Click for settings/gi, "")
      .replace(/Click for/gi, "")  // Remove standalone "Click for" (appears frequently)
      .replace(/\bsettings\b/gi, "")
      // Remove standalone language names anywhere (common YouTube noise)
      .replace(/\b(English|French|Spanish|German|Italian|Portuguese|Japanese|Korean|Chinese|Russian|Arabic|Hindi|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Turkish|Greek|Hebrew|Vietnamese|Thai|Indonesian|Malay)\b/gi, "");

    // Normalize whitespace
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

    // === TUNABLE HEURISTICS ===
    // Minimum quality threshold - snippets must be this big to save
    const MIN_WORDS = 10;           // At least 10 words
    const MIN_CHARS = 50;           // AND at least 50 characters
    // ==========================

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS || normalized.length < MIN_CHARS) {
      console.log(`[Captions] ❌ Too short: ${wordCount}w ${normalized.length}c`);
      return;
    }

    // Simple deduplication - don't add if it's a substring of what we just added
    if (state.lastCapturedText && state.lastCapturedText.includes(normalized)) {
      console.log(`[Captions] ❌ Duplicate (subset)`);
      return;
    }

    // Or if new text is just slightly longer version of last capture
    if (state.lastCapturedText && normalized.includes(state.lastCapturedText)) {
      // Replace the last entry with this longer version
      if (state.captionHistory.length > 0) {
        console.log(`[Captions] 🔄 Replaced: ${wordCount}w ${normalized.length}c`);
        state.captionHistory[state.captionHistory.length - 1] = {
          id: Date.now(),
          text: normalized,
          time: videoTime,
          timestamp: formatTimestamp(videoTime),
        };
        state.lastCapturedText = normalized;
        renderHistory();
        return;
      }
    }

    console.log(`[Captions] ✅ CAPTURED: ${wordCount}w ${normalized.length}c - "${normalized.substring(0, 50)}..."`);

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
    renderHistory();
  }

  function shouldFlushBuffer(buffer) {
    // === TUNABLE HEURISTICS ===
    // These control when we flush the buffer (create history entry)
    const TARGET_WORDS = 50;        // Flush at ~50 words (~25s of speech)
    const TARGET_CHARS = 350;       // Or ~350 chars (roughly 4-5 lines)
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
      console.log(`[Debug] +${newWords.length}w (overlap: ${overlapCount}), total: ${state.allWordsEverSeen.length}`);
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

      captureToHistory(chunkText, state.lastFlushTime || currentTime);

      state.lastFlushedIndex += TARGET_WORDS;
      state.lastFlushTime = currentTime;

      console.log(`[Captions] 📦 Flushed chunk: ${TARGET_WORDS}w, remaining: ${unflushedWords.length - TARGET_WORDS}w`);
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
    const historyList = document.getElementById("captions-history-list-v2");
    if (!historyList) {
      return;
    }

    historyList.textContent = "";

    if (!config.historyEnabled || !state.captionHistory.length) {
      const empty = createElement("div", "captions-history-empty-v2");
      empty.textContent = config.historyEnabled
        ? "Sentences will appear here..."
        : "History disabled";
      historyList.appendChild(empty);
      return;
    }

    state.captionHistory.forEach((entry) => {
      const item = createElement("button", "captions-history-item-v2");
      item.type = "button";
      item.dataset.time = String(entry.time);

      const time = createElement("span", "captions-history-time-v2");
      time.textContent = entry.timestamp;

      const text = createElement("span", "captions-history-text-v2");
      text.textContent = entry.text;

      item.append(time, text);
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

      parts.forEach((part) => {
        if (!part) return;

        if (/^\s+$/.test(part)) {
          // Preserve whitespace as-is
          overlay.appendChild(document.createTextNode(part));
        } else {
          // Make words clickable
          const word = createElement("span", "captions-word-v2");
          word.textContent = part;
          overlay.appendChild(word);
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
        applyOverlayState(overlay, getOverlayState());
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
    const overlay = document.getElementById("captions-floating-overlay-v2");
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

    // Main Caption Overlay Container
    const floatingOverlay = createElement("div", "captions-floating-overlay-v2");
    floatingOverlay.id = "captions-floating-overlay-v2";

    // Caption display
    const overlay = createElement("div", "captions-overlay-v2");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-live", "polite");
    overlay.textContent = "";

    // Subtle branding
    const branding = createElement("div", "captions-branding-v2");
    branding.textContent = "by captions";

    // Drag handle
    const dragHandle = createElement("button", "captions-drag-handle-v2");
    dragHandle.type = "button";
    dragHandle.innerHTML = "⋮⋮";
    dragHandle.title = "Drag to reposition";

    // History toggle button
    const historyButton = createElement("button", "captions-history-button-v2");
    historyButton.type = "button";
    historyButton.textContent = "History";
    historyButton.title = "Toggle Transcript History";

    // Settings icon
    const settingsIcon = createElement("button", "captions-settings-icon-v2");
    settingsIcon.type = "button";
    settingsIcon.appendChild(createSVGIcon("settings", 18));
    settingsIcon.title = "Settings";

    floatingOverlay.append(overlay, branding, dragHandle, historyButton, settingsIcon);

    // History Panel (collapsible)
    const historyPanel = createElement("div", "captions-history-panel-v2");
    historyPanel.id = "captions-history-panel-v2";

    const historyHeader = createElement("div", "captions-history-header-v2");

    const historyTitle = createElement("span", "captions-history-title-v2");
    historyTitle.textContent = "History";

    const historyCopyButton = createElement("button", "captions-history-copy-v2");
    historyCopyButton.type = "button";
    historyCopyButton.appendChild(createSVGIcon("copy", 16));
    historyCopyButton.title = "Copy transcript to clipboard";

    // Debug: copy ALL words ever seen
    const debugCopyButton = createElement("button", "captions-history-copy-v2");
    debugCopyButton.type = "button";
    debugCopyButton.textContent = "🔍";
    debugCopyButton.title = "Copy ALL words (debug)";
    debugCopyButton.style.fontSize = "14px";

    // Diff: compare transcript vs all words
    const diffButton = createElement("button", "captions-history-copy-v2");
    diffButton.type = "button";
    diffButton.textContent = "⚖️";
    diffButton.title = "Compare transcript vs all words";
    diffButton.style.fontSize = "14px";

    historyHeader.append(historyTitle, historyCopyButton, debugCopyButton, diffButton);

    const historyList = createElement("div", "captions-history-list-v2");
    historyList.id = "captions-history-list-v2";

    historyPanel.append(historyHeader, historyList);

    // Word Definition Popup
    const popup = createElement("div", "captions-popup-v2");
    popup.id = "captions-popup-v2";

    const popupContainer = createElement("div", "captions-popup-container-v2");

    const popupHeader = createElement("div", "captions-popup-header-v2");

    const popupHeaderLeft = createElement("div");
    const popupTitle = createElement("div", "captions-popup-title-v2");
    popupTitle.textContent = "Word Analysis";
    popupHeaderLeft.appendChild(popupTitle);

    const popupClose = createElement("button", "captions-popup-close-v2");
    popupClose.type = "button";
    popupClose.innerHTML = "×";

    popupHeader.append(popupHeaderLeft, popupClose);

    const popupContent = createElement("div", "captions-popup-content-v2");
    const popupLoading = createElement("div", "captions-popup-loading-v2");
    popupLoading.textContent = "Loading...";
    popupContent.appendChild(popupLoading);

    // Arrow pointing down to the word
    const popupArrow = createElement("div", "captions-popup-arrow-v2");

    popupContainer.append(popupHeader, popupContent, popupArrow);
    popup.appendChild(popupContainer);

    // Settings Panel
    const settingsPanel = createElement("div", "captions-settings-panel-v2");
    settingsPanel.id = "captions-settings-panel-v2";

    const settingsHeader = createElement("div", "captions-settings-header-v2");
    settingsHeader.textContent = "Display Settings";

    const settingsClose = createElement("button", "captions-settings-close-v2");
    settingsClose.type = "button";
    settingsClose.innerHTML = "×";
    settingsClose.title = "Close Settings";

    const settingsContent = createElement("div", "captions-settings-content-v2");

    // Font Size Control
    const fontSizeGroup = createElement("div", "captions-settings-group-v2");
    const fontSizeLabel = createElement("label", "captions-settings-label-v2");
    fontSizeLabel.textContent = "Font Size";
    const fontSizeControl = createElement("div", "captions-settings-control-v2");
    const fontSizeSlider = createElement("input", "captions-settings-slider-v2");
    fontSizeSlider.type = "range";
    fontSizeSlider.min = "16";
    fontSizeSlider.max = "48";
    fontSizeSlider.value = config.fontSize.toString();
    fontSizeSlider.id = "font-size-slider";
    const fontSizeValue = createElement("span", "captions-settings-value-v2");
    fontSizeValue.textContent = `${config.fontSize}px`;
    fontSizeControl.append(fontSizeSlider, fontSizeValue);
    fontSizeGroup.append(fontSizeLabel, fontSizeControl);

    // Opacity Control
    const opacityGroup = createElement("div", "captions-settings-group-v2");
    const opacityLabel = createElement("label", "captions-settings-label-v2");
    opacityLabel.textContent = "Opacity";
    const opacityControl = createElement("div", "captions-settings-control-v2");
    const opacitySlider = createElement("input", "captions-settings-slider-v2");
    opacitySlider.type = "range";
    opacitySlider.min = "0.3";
    opacitySlider.max = "1";
    opacitySlider.step = "0.05";
    opacitySlider.value = config.opacity.toString();
    opacitySlider.id = "opacity-slider";
    const opacityValue = createElement("span", "captions-settings-value-v2");
    opacityValue.textContent = `${Math.round(config.opacity * 100)}%`;
    opacityControl.append(opacitySlider, opacityValue);
    opacityGroup.append(opacityLabel, opacityControl);

    // Blur Control
    const blurGroup = createElement("div", "captions-settings-group-v2");
    const blurLabel = createElement("label", "captions-settings-label-v2");
    blurLabel.textContent = "Background Blur";
    const blurControl = createElement("div", "captions-settings-control-v2");
    const blurSlider = createElement("input", "captions-settings-slider-v2");
    blurSlider.type = "range";
    blurSlider.min = "0";
    blurSlider.max = "20";
    blurSlider.value = config.blur.toString();
    blurSlider.id = "blur-slider";
    const blurValue = createElement("span", "captions-settings-value-v2");
    blurValue.textContent = `${config.blur}px`;
    blurControl.append(blurSlider, blurValue);
    blurGroup.append(blurLabel, blurControl);

    // Dictionary Language Control
    const langGroup = createElement("div", "captions-settings-group-v2");
    const langLabel = createElement("label", "captions-settings-label-v2");
    langLabel.textContent = "Dictionary Language";
    const langControl = createElement("div", "captions-settings-control-v2");
    const langSelect = createElement("select", "captions-settings-select-v2");
    langSelect.id = "lang-select";

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

    languages.forEach(lang => {
      const option = createElement("option");
      option.value = lang.code;
      option.textContent = lang.name;
      if (lang.code === config.dictionaryLang) {
        option.selected = true;
      }
      langSelect.appendChild(option);
    });

    langControl.appendChild(langSelect);
    langGroup.append(langLabel, langControl);

    settingsContent.append(fontSizeGroup, opacityGroup, blurGroup, langGroup);
    settingsPanel.append(settingsHeader, settingsClose, settingsContent);

    // Assemble
    root.append(floatingOverlay, historyPanel, popup, settingsPanel);
    document.body.appendChild(root);

    // Event Handlers

    // Drag functionality
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

    // History button click
    historyButton.addEventListener("click", (e) => {
      e.stopPropagation();
      historyPanel.classList.toggle("is-visible");
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
        debugCopyButton.textContent = "✓";
        setTimeout(() => {
          debugCopyButton.textContent = "🔍";
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
        diffButton.textContent = "✓";
        setTimeout(() => {
          diffButton.textContent = "⚖️";
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

    // Font size slider
    fontSizeSlider.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      config.fontSize = value;
      fontSizeValue.textContent = `${value}px`;
      overlay.style.fontSize = `${value}px`;
      saveConfig();
    });

    // Opacity slider
    opacitySlider.addEventListener("input", (e) => {
      const value = parseFloat(e.target.value);
      config.opacity = value;
      opacityValue.textContent = `${Math.round(value * 100)}%`;
      floatingOverlay.style.opacity = value.toString();
      saveConfig();
    });

    // Blur slider
    blurSlider.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      config.blur = value;
      blurValue.textContent = `${value}px`;
      const currentBackdrop = floatingOverlay.style.backdropFilter || "";
      floatingOverlay.style.backdropFilter = `blur(${value}px) saturate(150%)`;
      saveConfig();
    });

    // Language select
    langSelect.addEventListener("change", (e) => {
      config.dictionaryLang = e.target.value;
      flashStatus(`Dictionary language: ${e.target.options[e.target.selectedIndex].text}`);
      saveConfig();
    });

    overlay.addEventListener("click", async (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const wordEl = event.target.closest(".captions-word-v2");
      if (!wordEl) {
        return;
      }

      const video = getVideo();
      if (video) {
        const nextTime = Math.max(0, video.currentTime - REPLAY_BACK_SECONDS);
        video.currentTime = nextTime;
        video.pause();
      }

      const wordText = normalizeWord(wordEl.textContent);
      if (!wordText) {
        return;
      }

      flashStatus(`Replaying: ${wordText}`);
      state.activeWord = wordText;

      // Show popup
      popup.classList.add("is-open");

      // Position popup above the clicked word
      const wordRect = wordEl.getBoundingClientRect();
      const container = popup.querySelector(".captions-popup-container-v2");
      const arrow = popup.querySelector(".captions-popup-arrow-v2");

      if (container) {
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
          const arrowLeft = wordRect.left + (wordRect.width / 2) - left - 12; // 12 = half arrow width
          arrow.style.left = `${arrowLeft}px`;
        }
      }

      state.popupOpen = true;
      popupContent.innerHTML = '<div class="captions-popup-loading-v2">Loading definition...</div>';

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
        popupContent.innerHTML = '<div class="captions-popup-error-v2">Definition not found</div>';
      }
    });

    popupClose.addEventListener("click", () => {
      popup.classList.remove("is-open");
      state.popupOpen = false;
    });

    // Click outside to close popup
    popup.addEventListener("click", (event) => {
      if (event.target === popup) {
        popup.classList.remove("is-open");
        state.popupOpen = false;
      }
    });

    function renderPopupContent(container, parsed) {
      container.textContent = "";

      // Word header with phonetic and pronunciation button
      const wordHeader = createElement("div");
      wordHeader.style.display = "flex";
      wordHeader.style.alignItems = "center";
      wordHeader.style.justifyContent = "space-between";
      wordHeader.style.marginBottom = "20px";

      const wordInfo = createElement("div");
      const wordEl = createElement("div", "captions-popup-word-v2");
      wordEl.textContent = parsed.word;

      const phoneticEl = createElement("div", "captions-popup-phonetic-v2");
      phoneticEl.textContent = parsed.pronunciations.length ? `/${parsed.pronunciations[0]}/` : "";

      wordInfo.append(wordEl, phoneticEl);

      const speakBtn = createElement("button", "captions-popup-speak-v2");
      speakBtn.type = "button";
      speakBtn.innerHTML = "🔊";
      speakBtn.addEventListener("click", () => {
        speakWord(parsed.word, config.dictionaryLang, parsed.audioUrl);
      });

      wordHeader.append(wordInfo, speakBtn);
      container.appendChild(wordHeader);

      // Definition section
      if (parsed.definitions.length) {
        const defSection = createElement("div", "captions-popup-section-v2");
        const defLabel = createElement("div", "captions-popup-label-v2");
        defLabel.textContent = "DEFINITION";

        const defValue = createElement("div", "captions-popup-definition-v2");
        defValue.textContent = parsed.definitions[0]; // Show first definition

        defSection.append(defLabel, defValue);
        container.appendChild(defSection);
      }

      // Translation section (placeholder for now - will need translation API)
      const transSection = createElement("div", "captions-popup-section-v2");
      const transLabel = createElement("div", "captions-popup-label-v2");
      transLabel.textContent = "TRANSLATION";

      const transValue = createElement("div", "captions-popup-value-v2");
      transValue.textContent = "(Translation coming soon)";

      transSection.append(transLabel, transValue);
      container.appendChild(transSection);

      // Context section
      const contextSection = createElement("div", "captions-popup-section-v2");
      const contextLabel = createElement("div", "captions-popup-label-v2");
      contextLabel.textContent = "CONTEXT";

      const contextBadge = createElement("span", "captions-popup-context-badge-v2");
      contextBadge.textContent = "Video Sync";

      contextSection.append(contextLabel, contextBadge);
      container.appendChild(contextSection);

      // Example section
      if (parsed.examples && parsed.examples.length > 0) {
        const exampleSection = createElement("div", "captions-popup-section-v2");
        const exampleLabel = createElement("div", "captions-popup-label-v2");
        exampleLabel.textContent = "EXAMPLE";

        const exampleValue = createElement("div", "captions-popup-example-v2");
        exampleValue.textContent = `"${parsed.examples[0]}"`;

        exampleSection.append(exampleLabel, exampleValue);
        container.appendChild(exampleSection);
      }

      if (!parsed.definitions.length) {
        const noData = createElement("div", "captions-popup-error-v2");
        noData.textContent = "No definition available";
        container.appendChild(noData);
      }
    }

    historyList.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const item = event.target.closest(".captions-history-item-v2");
      if (!item) {
        return;
      }
      const time = Number(item.dataset.time);
      if (!Number.isFinite(time)) {
        return;
      }
      const video = getVideo();
      if (video) {
        video.currentTime = Math.max(0, time - 0.5);
        video.play().catch(() => {});
        flashStatus(`Jumped to ${formatTimestamp(time)}`);
      }
    });

    // Initialize styles from config
    overlay.style.fontSize = `${config.fontSize}px`;
    floatingOverlay.style.opacity = config.opacity.toString();
    floatingOverlay.style.backdropFilter = `blur(${config.blur}px) saturate(150%)`;

    // Initialize
    checkVideoChange();  // Set initial video ID
    renderHistory();
    attachCaptionObserver(overlay);
    applyOverlayState(overlay, getOverlayState());
    updateOverlayPosition();

    // Polling and updates
    setInterval(() => {
      checkVideoChange();  // Detect video navigation and clear state
      attachCaptionObserver(overlay);
      applyOverlayState(overlay, getOverlayState());
    }, CAPTION_POLL_MS);

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

    window.addEventListener("resize", updateOverlayPosition);
    window.addEventListener("scroll", updateOverlayPosition, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
