/**
 * Site Adapter Registry for SideCap
 *
 * Each adapter defines how to detect and extract captions from a specific site/player.
 * This allows native captions to be preferred when available, with Smart Captions as fallback.
 */

const SiteAdapters = {
  // Registry of known site adapters
  adapters: {
    youtube: {
      name: "YouTube",
      hostPatterns: ["youtube.com", "youtu.be"],
      captionSelectors: [
        ".ytp-caption-segment",           // Main caption text
        ".caption-window",                 // Caption container
        ".captions-text",                  // Alternative selector
      ],
      containerSelector: ".html5-video-container",
      videoSelector: "video.html5-main-video, video",
      // YouTube has its own caption toggle
      captionToggleSelector: ".ytp-subtitles-button",
      hasCaptions: () => {
        const btn = document.querySelector(".ytp-subtitles-button");
        return btn && btn.getAttribute("aria-pressed") !== undefined;
      },
      areCaptionsEnabled: () => {
        const btn = document.querySelector(".ytp-subtitles-button");
        return btn && btn.getAttribute("aria-pressed") === "true";
      }
    },

    ina: {
      name: "INA.fr / Madelen",
      hostPatterns: ["ina.fr", "madelen.ina.fr"],
      captionSelectors: [
        ".bmpui-ui-subtitle-label",       // Bitmovin subtitle display
        ".bmpui-subtitle-region-container span",
        "[class*='subtitle']",
      ],
      containerSelector: ".bmpui-ui-uicontainer",
      videoSelector: "video",
      playerType: "bitmovin",
      hasCaptions: () => {
        // Check if subtitle button exists and has options
        const subtitleBtn = document.querySelector(".bmpui-ui-subtitlesettingstogglebutton");
        return subtitleBtn !== null;
      },
      areCaptionsEnabled: () => {
        const label = document.querySelector(".bmpui-ui-subtitle-label");
        return label && label.textContent.trim().length > 0;
      }
    },

    netflix: {
      name: "Netflix",
      hostPatterns: ["netflix.com"],
      captionSelectors: [
        ".player-timedtext span",
        ".player-timedtext-text-container span",
        "[data-uia='player-timedtext']",
      ],
      containerSelector: ".watch-video",
      videoSelector: "video",
      hasCaptions: () => {
        // Netflix always has captions available for most content
        const timedText = document.querySelector(".player-timedtext");
        return timedText !== null;
      },
      areCaptionsEnabled: () => {
        const text = document.querySelector(".player-timedtext span");
        return text && text.textContent.trim().length > 0;
      }
    },

    primevideo: {
      name: "Amazon Prime Video",
      hostPatterns: ["primevideo.com", "amazon.com/gp/video"],
      captionSelectors: [
        ".atvwebplayersdk-captions-text",
        ".webPlayerSDKContainer [class*='captions']",
        "[class*='timedTextBackground']",
      ],
      containerSelector: ".webPlayerSDKContainer",
      videoSelector: "video",
      hasCaptions: () => {
        const captionBtn = document.querySelector("[class*='subtitles']");
        return captionBtn !== null;
      }
    },

    disneyplus: {
      name: "Disney+",
      hostPatterns: ["disneyplus.com"],
      captionSelectors: [
        "[data-testid='subtitles'] span",
        ".btm-media-overlays-container [class*='caption']",
      ],
      containerSelector: ".btm-media-client-element",
      videoSelector: "video",
      hasCaptions: () => {
        const subtitleBtn = document.querySelector("[data-testid='subtitles-button']");
        return subtitleBtn !== null;
      }
    },

    hbomax: {
      name: "Max (HBO)",
      hostPatterns: ["max.com", "hbomax.com"],
      captionSelectors: [
        "[class*='StyledTimedText'] span",
        ".closed-captions",
      ],
      containerSelector: "[class*='VideoPlayer']",
      videoSelector: "video",
    },

    vimeo: {
      name: "Vimeo",
      hostPatterns: ["vimeo.com"],
      captionSelectors: [
        ".vp-captions span",
        "[class*='captions-display']",
      ],
      containerSelector: ".player-container",
      videoSelector: "video",
      hasCaptions: () => {
        const ccBtn = document.querySelector("[class*='cc-button']");
        return ccBtn !== null;
      }
    },

    twitch: {
      name: "Twitch",
      hostPatterns: ["twitch.tv"],
      captionSelectors: [
        "[data-a-target='player-overlay-click-handler'] + div [class*='caption']",
      ],
      containerSelector: ".video-player__container",
      videoSelector: "video",
      // Twitch rarely has captions, SC is usually needed
      hasCaptions: () => false,
    },

    dailymotion: {
      name: "Dailymotion",
      hostPatterns: ["dailymotion.com"],
      captionSelectors: [
        ".dmp_SubtitleLabel",
        "[class*='Subtitle']",
      ],
      containerSelector: ".dmp_Player",
      videoSelector: "video",
    },

    // Generic Bitmovin player (used by many sites)
    bitmovin: {
      name: "Bitmovin Player",
      hostPatterns: [], // Detected by player presence, not host
      captionSelectors: [
        ".bmpui-ui-subtitle-label",
        ".bmpui-subtitle-region-container span",
      ],
      containerSelector: ".bmpui-ui-uicontainer",
      videoSelector: "video",
      detectByPlayer: true,
      detect: () => {
        return document.querySelector(".bmpui-ui-uicontainer") !== null;
      }
    },

    // Generic Video.js player
    videojs: {
      name: "Video.js Player",
      hostPatterns: [],
      captionSelectors: [
        ".vjs-text-track-display div",
        ".vjs-text-track-cue div",
      ],
      containerSelector: ".video-js",
      videoSelector: "video",
      detectByPlayer: true,
      detect: () => {
        return document.querySelector(".video-js") !== null;
      }
    },

    // JW Player
    jwplayer: {
      name: "JW Player",
      hostPatterns: [],
      captionSelectors: [
        ".jw-captions",
        ".jw-text-track-display",
      ],
      containerSelector: ".jwplayer",
      videoSelector: "video",
      detectByPlayer: true,
      detect: () => {
        return document.querySelector(".jwplayer") !== null || typeof window.jwplayer === "function";
      }
    },

    // Plyr
    plyr: {
      name: "Plyr",
      hostPatterns: [],
      captionSelectors: [
        ".plyr__captions span",
      ],
      containerSelector: ".plyr",
      videoSelector: "video",
      detectByPlayer: true,
      detect: () => {
        return document.querySelector(".plyr") !== null;
      }
    },
  },

  /**
   * Detect which adapter to use for the current page
   * @returns {Object|null} The matching adapter or null
   */
  detectAdapter() {
    const hostname = window.location.hostname.toLowerCase();

    // First, try to match by hostname
    for (const [key, adapter] of Object.entries(this.adapters)) {
      if (adapter.hostPatterns && adapter.hostPatterns.length > 0) {
        for (const pattern of adapter.hostPatterns) {
          if (hostname.includes(pattern)) {
            console.log(`[SideCap] Detected site: ${adapter.name}`);
            return { key, ...adapter };
          }
        }
      }
    }

    // Then, try to detect by player type
    for (const [key, adapter] of Object.entries(this.adapters)) {
      if (adapter.detectByPlayer && adapter.detect && adapter.detect()) {
        console.log(`[SideCap] Detected player: ${adapter.name}`);
        return { key, ...adapter };
      }
    }

    return null;
  },

  /**
   * Check if native captions are available on the current page
   * @param {Object} adapter - The detected adapter
   * @returns {boolean}
   */
  checkCaptionsAvailable(adapter) {
    if (!adapter) return false;

    if (adapter.hasCaptions) {
      return adapter.hasCaptions();
    }

    // Fallback: Check if any caption selector matches
    for (const selector of adapter.captionSelectors || []) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Get caption text from the current page
   * @param {Object} adapter - The detected adapter
   * @returns {string|null}
   */
  getCaptionText(adapter) {
    if (!adapter || !adapter.captionSelectors) return null;

    for (const selector of adapter.captionSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        return Array.from(elements)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0)
          .join(" ");
      }
    }

    return null;
  },

  /**
   * Observe caption changes on the page
   * @param {Object} adapter - The detected adapter
   * @param {Function} callback - Called with new caption text
   * @returns {MutationObserver|null}
   */
  observeCaptions(adapter, callback) {
    if (!adapter) return null;

    // Find the container to observe
    let container = null;
    if (adapter.containerSelector) {
      container = document.querySelector(adapter.containerSelector);
    }
    if (!container) {
      container = document.body;
    }

    const observer = new MutationObserver((mutations) => {
      const text = this.getCaptionText(adapter);
      if (text) {
        callback(text);
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return observer;
  },
};

// Export for use in content.js
if (typeof window !== "undefined") {
  window.SiteAdapters = SiteAdapters;
}

export default SiteAdapters;
