# Captions Extension

A YouTube caption enhancement tool for language learning.

## Versions

### V2 (Current - Floating Overlay) ✨

**Location:** `/v2/`

**Design Philosophy:**
- Floating overlay positioned near video player
- Compact, non-intrusive popup for word definitions
- Sentence-based caption history (no duplicate words)
- Clean, focused learning experience

**Features:**
- 📍 **Floating overlay** - positioned at bottom-center of video
- 🔍 **Click words** - instant popup with definition, pronunciation, and speaker
- 📜 **Smart history** - sentence detection algorithm groups captions intelligently
- 🎮 **Video controls** - play/pause, seek forward/back
- 🗂️ **Slide-out history** - toggle history panel on the left side

**Algorithm:**
The V2 history uses intelligent sentence detection:
- Detects sentence-ending punctuation (. ! ?)
- Groups phrases at pauses (, : ;) when 8+ words
- Avoids duplicate/overlapping entries
- Archives complete thoughts, not streaming words

**Popup Design:**
- Non-blocking modal overlay
- Shows only essentials: part of speech, pronunciation, top 2 definitions
- Speak button for pronunciation
- Click outside to close

---

### V1 (DevTools Style)

**Location:** `/` (root - Content.js, style.css)

**Design Philosophy:**
- Chrome DevTools-inspired bottom panel
- Tab-based organization
- Comprehensive settings and features

**Features:**
- 🔧 **DevTools panel** - full-width bottom docked
- 📑 **4 Tabs** - Captions, History, Dictionary, Settings
- ⚙️ **Full settings** - alignment, font size, opacity, etc.
- ⌨️ **Keyboard shortcut** - Alt+C to toggle

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `/captions` folder
5. Navigate to YouTube and enable captions (CC button)

## Switching Versions

Edit `manifest.json`:

**For V2 (Floating):**
```json
"js": ["v2/Content-v2.js"],
"css": ["v2/style-v2.css"],
```

**For V1 (DevTools):**
```json
"js": ["Content.js"],
"css": ["style.css"],
```

After changing, reload the extension in `chrome://extensions/`

## Usage

1. **Open a YouTube video** with captions available
2. **Turn on CC** (captions/closed captions button)
3. **Click any word** in the captions to:
   - Replay that section of the video
   - See definition and pronunciation (V2: popup, V1: Dictionary tab)
   - Hear the word spoken aloud
4. **Use history** to jump back to previous sentences/captions
5. **Use video controls** for quick playback control

## Keyboard Shortcuts

- **Alt+C** - Toggle extension panel (V1) / No shortcut in V2 (always visible)

## Development

### V2 Structure
```
v2/
├── Content-v2.js    - Main logic with sentence algorithm
└── style-v2.css     - Floating overlay styles
```

### V1 Structure
```
Content.js      - DevTools panel logic
style.css       - DevTools panel styles
```

## Technical Details

### Sentence Detection Algorithm (V2)

The V2 history uses several heuristics to detect sentence boundaries:

1. **Sentence-ending punctuation** - Immediate archive on `. ! ?`
2. **Pause detection** - Archive on `, : ;` when 8+ words accumulated
3. **Word count stability** - If word count stable and 5+ words, archive
4. **Non-extension detection** - If current text doesn't extend previous, archive

This prevents the streaming word-by-word problem and creates a clean, readable history.

### Caption Sources

The extension monitors YouTube's caption containers:
- `.ytp-caption-window-container` (primary)
- `.ytp-caption-segment` (fallback)

## Future Ideas

- [ ] Toggle between V1/V2 in extension settings
- [ ] Export history to text file
- [ ] Flashcard generation from clicked words
- [ ] Multi-language parallel captions
- [ ] Custom keyboard shortcuts

## License

MIT
