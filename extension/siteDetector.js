/**
 * Site Detector - Analyzes unknown sites for caption potential
 *
 * Provides heuristics for detecting video players and caption elements
 * on sites not in the adapter registry, plus reporting for crowd-sourcing.
 */

const SiteDetector = {
  // Common caption-related class/attribute patterns
  captionPatterns: [
    /caption/i,
    /subtitle/i,
    /timedtext/i,
    /closed.?caption/i,
    /cc-/i,
    /vtt/i,
    /srt/i,
    /text.?track/i,
    /cue/i,
  ],

  // Common video player patterns
  playerPatterns: [
    /video.?js/i,
    /jwplayer/i,
    /bitmovin/i,
    /plyr/i,
    /flowplayer/i,
    /hls.?js/i,
    /shaka/i,
    /dash/i,
    /mediaelement/i,
    /brightcove/i,
    /kaltura/i,
    /wistia/i,
    /vimeo/i,
    /youtube/i,
  ],

  /**
   * Analyze the current page for video and caption elements
   * @returns {Object} Analysis report
   */
  analyzePage() {
    const report = {
      url: window.location.href,
      hostname: window.location.hostname,
      timestamp: new Date().toISOString(),
      videos: this.findVideos(),
      players: this.detectPlayers(),
      potentialCaptionElements: this.findCaptionElements(),
      iframes: this.findVideoIframes(),
      scripts: this.findRelevantScripts(),
      recommendation: null,
    };

    // Generate recommendation
    report.recommendation = this.generateRecommendation(report);

    return report;
  },

  /**
   * Find all video elements on the page
   */
  findVideos() {
    const videos = document.querySelectorAll("video");
    return Array.from(videos).map((video, index) => ({
      index,
      src: video.src || video.currentSrc || "(blob/stream)",
      hasTextTracks: video.textTracks?.length > 0,
      textTrackCount: video.textTracks?.length || 0,
      textTrackKinds: Array.from(video.textTracks || []).map(t => ({
        kind: t.kind,
        language: t.language,
        label: t.label,
        mode: t.mode,
      })),
      dimensions: `${video.videoWidth}x${video.videoHeight}`,
      parent: this.getElementPath(video.parentElement),
    }));
  },

  /**
   * Detect known video players on the page
   */
  detectPlayers() {
    const detected = [];

    // Check for global player objects
    const globalChecks = [
      { name: "Video.js", check: () => typeof window.videojs !== "undefined" },
      { name: "JW Player", check: () => typeof window.jwplayer !== "undefined" },
      { name: "Plyr", check: () => typeof window.Plyr !== "undefined" },
      { name: "Shaka Player", check: () => typeof window.shaka !== "undefined" },
      { name: "HLS.js", check: () => typeof window.Hls !== "undefined" },
      { name: "Dash.js", check: () => typeof window.dashjs !== "undefined" },
      { name: "Flowplayer", check: () => typeof window.flowplayer !== "undefined" },
    ];

    for (const { name, check } of globalChecks) {
      try {
        if (check()) {
          detected.push({ name, detectedBy: "global" });
        }
      } catch (e) {
        // Ignore errors from accessing globals
      }
    }

    // Check for player containers in DOM
    const domChecks = [
      { name: "Video.js", selector: ".video-js" },
      { name: "JW Player", selector: ".jwplayer" },
      { name: "Bitmovin", selector: ".bmpui-ui-uicontainer" },
      { name: "Plyr", selector: ".plyr" },
      { name: "Flowplayer", selector: ".flowplayer" },
      { name: "Brightcove", selector: ".bc-player-default" },
      { name: "Kaltura", selector: ".kaltura-player" },
      { name: "Wistia", selector: ".wistia_embed" },
      { name: "MediaElement.js", selector: ".mejs__container" },
    ];

    for (const { name, selector } of domChecks) {
      if (document.querySelector(selector)) {
        if (!detected.find(d => d.name === name)) {
          detected.push({ name, detectedBy: "dom", selector });
        }
      }
    }

    return detected;
  },

  /**
   * Find potential caption elements using heuristics
   */
  findCaptionElements() {
    const found = [];

    // Method 1: Search by class names
    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      const className = el.className?.toString() || "";
      const id = el.id || "";

      for (const pattern of this.captionPatterns) {
        if (pattern.test(className) || pattern.test(id)) {
          const text = el.textContent?.trim().slice(0, 100);
          if (text && text.length > 0) {
            found.push({
              selector: this.generateSelector(el),
              path: this.getElementPath(el),
              className: className.slice(0, 100),
              sampleText: text,
              visible: this.isVisible(el),
            });
          }
          break;
        }
      }
    }

    // Method 2: Check video.textTracks
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      if (video.textTracks?.length > 0) {
        for (const track of video.textTracks) {
          found.push({
            type: "textTrack",
            kind: track.kind,
            language: track.language,
            label: track.label,
            mode: track.mode,
            cueCount: track.cues?.length || 0,
          });
        }
      }
    }

    // Deduplicate
    return found.slice(0, 20); // Limit to avoid huge reports
  },

  /**
   * Find iframes that might contain video players
   */
  findVideoIframes() {
    const iframes = document.querySelectorAll("iframe");
    return Array.from(iframes)
      .filter(iframe => {
        const src = iframe.src || "";
        return (
          src.includes("youtube") ||
          src.includes("vimeo") ||
          src.includes("dailymotion") ||
          src.includes("player") ||
          src.includes("video") ||
          src.includes("embed")
        );
      })
      .map(iframe => ({
        src: iframe.src,
        dimensions: `${iframe.width}x${iframe.height}`,
      }));
  },

  /**
   * Find scripts that might be video player related
   */
  findRelevantScripts() {
    const scripts = document.querySelectorAll("script[src]");
    return Array.from(scripts)
      .filter(script => {
        const src = script.src.toLowerCase();
        return this.playerPatterns.some(p => p.test(src));
      })
      .map(script => script.src)
      .slice(0, 10);
  },

  /**
   * Generate a CSS selector for an element
   */
  generateSelector(el) {
    if (el.id) {
      return `#${el.id}`;
    }

    const classes = Array.from(el.classList || []).slice(0, 3).join(".");
    if (classes) {
      return `${el.tagName.toLowerCase()}.${classes}`;
    }

    return el.tagName.toLowerCase();
  },

  /**
   * Get a readable path to an element
   */
  getElementPath(el, depth = 3) {
    const parts = [];
    let current = el;
    let count = 0;

    while (current && count < depth) {
      const tag = current.tagName?.toLowerCase() || "";
      const cls = current.classList?.[0] ? `.${current.classList[0]}` : "";
      if (tag) {
        parts.unshift(tag + cls);
      }
      current = current.parentElement;
      count++;
    }

    return parts.join(" > ");
  },

  /**
   * Check if an element is visible
   */
  isVisible(el) {
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  },

  /**
   * Generate a recommendation based on analysis
   */
  generateRecommendation(report) {
    const hasVideo = report.videos.length > 0;
    const hasTextTracks = report.videos.some(v => v.hasTextTracks);
    const hasPlayer = report.players.length > 0;
    const hasCaptionElements = report.potentialCaptionElements.length > 0;

    if (!hasVideo && report.iframes.length > 0) {
      return {
        type: "iframe",
        message: "Video is embedded in an iframe. SideCap may need to run inside the iframe context.",
        canUseSmartCaptions: true,
      };
    }

    if (!hasVideo) {
      return {
        type: "no-video",
        message: "No video element found on this page.",
        canUseSmartCaptions: false,
      };
    }

    if (hasTextTracks || hasCaptionElements) {
      return {
        type: "has-captions",
        message: "This site appears to have native caption support. SideCap should be able to capture them.",
        canUseSmartCaptions: true,
        preferNative: true,
      };
    }

    if (hasVideo && hasPlayer) {
      return {
        type: "player-no-captions",
        message: `Detected ${report.players.map(p => p.name).join(", ")} but no captions found. Smart Captions recommended.`,
        canUseSmartCaptions: true,
        preferNative: false,
      };
    }

    return {
      type: "unknown",
      message: "Video found but caption support unclear. Try Smart Captions.",
      canUseSmartCaptions: true,
      preferNative: false,
    };
  },

  /**
   * Generate a compact report for sharing
   */
  generateShareableReport(analysis) {
    const report = analysis || this.analyzePage();

    const lines = [
      `# SideCap Site Report`,
      ``,
      `**URL:** ${report.hostname}`,
      `**Date:** ${report.timestamp}`,
      ``,
      `## Detection Results`,
      `- Videos found: ${report.videos.length}`,
      `- Player detected: ${report.players.map(p => p.name).join(", ") || "None"}`,
      `- Native captions: ${report.videos.some(v => v.hasTextTracks) ? "Yes" : "No"}`,
      `- Caption elements: ${report.potentialCaptionElements.length}`,
      ``,
      `## Recommendation`,
      `${report.recommendation?.message || "Unknown"}`,
      ``,
    ];

    // Add caption selectors if found
    if (report.potentialCaptionElements.length > 0) {
      lines.push(`## Potential Caption Selectors`);
      for (const el of report.potentialCaptionElements.slice(0, 5)) {
        if (el.selector) {
          lines.push(`- \`${el.selector}\` - "${el.sampleText?.slice(0, 50)}..."`);
        } else if (el.type === "textTrack") {
          lines.push(`- TextTrack: ${el.kind} (${el.language}) - ${el.cueCount} cues`);
        }
      }
      lines.push(``);
    }

    // Add player info
    if (report.players.length > 0) {
      lines.push(`## Player Details`);
      for (const player of report.players) {
        lines.push(`- ${player.name} (detected via ${player.detectedBy})`);
      }
      lines.push(``);
    }

    return lines.join("\n");
  },
};

// Export for use in content.js
if (typeof window !== "undefined") {
  window.SiteDetector = SiteDetector;
}

export default SiteDetector;
