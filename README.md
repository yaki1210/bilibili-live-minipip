# bilibili-live-minipip (M2) — 0.2.3

Chrome MV3 extension: the live player's native **小窗模式** button opens a real, always-on-top
mini window with the live picture and live danmaku. The page player keeps playing; no page is
reloaded and no second stream is pulled.

## What it does

- **Top-document rooms**: moves the whole `#live-player` node into a Document Picture-in-Picture
  window (same document, so the media element keeps playing). Danmaku and player controls come
  along. On close the player moves back.
- **Same-origin iframe rooms**: opens Document PiP from the top document, then mirrors the playing
  `<video>` with `captureStream()` into a PiP `<video>`, and draws danmaku in a DOM layer inside
  the PiP window. The page keeps playing; page audio is muted with a WebAudio gain, PiP audio comes
  from a `MediaStreamDestination`.
- **Fallback**: if Document PiP or `captureStream()` is unavailable, it opens the native
  `video.requestPictureInPicture()` window (no danmaku).

## Load unpacked

1. Chrome/Edge >= 116 -> `chrome://extensions` -> enable *Developer mode*.
2. *Load unpacked* -> select this folder (the one with `manifest.json`).
3. Open `https://live.bilibili.com/<room>`, hover the player -> click 小窗模式.
4. Close the mini window (关闭 / Esc / window close) -> page audio returns, player keeps running.
5. Filter the DevTools console by `[bmp]` for logs.

## Notes (0.2.3)

- Diagnostics: `danmaku ws closed` now logs the close code/reason; `danmaku ws connect` logs
  room/user/host counts without the token; `__danmuInfo` polling lasts 60s. `buvid3` also falls
  back to localStorage/sessionStorage.

## Notes (0.2.2)

- **Own danmaku socket**: 0.2.1 patched the page's WebSocket, but that missed the real connection
  in some rooms. 0.2.2 reads the page's `window.__danmuInfo` (main-guard posts it over), falls back
  to `getDanmuInfo` if needed, and opens its own `wss://<host>:<port>/sub` socket with
  `protover 2` (zlib), heartbeat, and auto-reconnect. This socket lives in the content script and
  keeps receiving while the browser is minimized; frames are rendered into the PiP window.
- Order of danmaku sources: own socket -> page socket tap (0.2.1) -> DOM observer (last resort).
- Console markers: `[bmp] __danmuInfo captured`, `[bmp] danmaku ws connect`,
  `[bmp] danmaku ws open`. If it closes, `danmaku ws closed; retry` up to 3 times, then the DOM
  fallback (which stops when minimized).

## Notes (0.2.1)

- **Minimized browser / hidden tab**: the old danmaku source was the page DOM, and Bilibili stops
  updating the chat DOM when the tab is hidden. 0.2.1 taps the page's own danmaku WebSocket in the
  MAIN world (`src/main-guard.js`), switches the auth packet to `protover 2` (zlib) and forwards
  every frame to the content script, which inflates it with the native `DecompressionStream` and
  renders into the PiP window. The PiP window stays visible while the browser is minimized, so
  danmaku keeps scrolling. The DOM observer remains only as a fallback when no socket is tapped.
- If the server ignores protover 2 and keeps sending brotli (`ver 3`), the console shows
  `[bmp] ws brotli frame` and danmaku falls back to the DOM source (which stops when minimized).

## Notes (0.2.0)

- Document PiP must be requested from the **top-level** document. In iframe rooms the content
  script calls `window.top.documentPictureInPicture.requestWindow()` synchronously inside the
  click handler so the user gesture is preserved.
- Moving a playing `<video>` across documents destroys its media element, so iframe rooms use a
  stream mirror instead of moving the player. The mirror is the same decoded stream, not a reload.
- Danmaku source: the top document's chat list `#chat-items .chat-item.danmaku-item` first, then
  the player overlay `.web-player-danmaku .danmaku-item-container`. Gift / guard / system / SC
  messages are filtered out. Emotes from `*.hdslb.com` are shown as images.
- Watermark: the mirrored PiP video is the page video stream; the page itself stays visible.
- If the page is in a background tab, `captureStream()` keeps producing frames because the source
  video keeps playing (the PiP window consumes the stream). Danmaku from the chat DOM may stop if
  Bilibili throttles chat updates in background tabs; a WebSocket danmaku source is the next step.
- Audio: `video.muted = true` would also mute `captureStream()` audio, so the page is silenced with
  `AudioContext` gain 0 and the PiP gets a `MediaStreamDestination` track. If Bilibili already owns
  the element's WebAudio graph, the mirror and danmaku still work and the page keeps its sound.
- Native Video PiP fallback has no danmaku (the browser only renders the `<video>`).

## Files

- `manifest.json` — MV3, two content scripts on `*://live.bilibili.com/*` (`all_frames`).
- `src/main-guard.js` — MAIN world, `document_start`: wraps the page's own
  `documentPictureInPicture.requestWindow`, forwards it to the content script synchronously, and
  lets it through when our request sets `data-bmp-self`.
- `src/content.js` — button hijack (Path A official call / Path B DOM click), Document PiP open,
  top-document player move, iframe mirror (`captureStream` + WebAudio), PiP danmaku renderer,
  control bar, and cleanup.

## Version history

- 0.1.x: move the player / in-page float / iframe page copy experiments.
- 0.2.0: real top-level mini window; mirror instead of reloading a page; live danmaku in the PiP.
