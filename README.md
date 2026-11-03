# bilibili-live-minipip (M1) — 0.1.6

Chrome MV3 extension: clicking the live player's native **小窗模式** button opens our own
Document Picture-in-Picture window containing the live `<video>` (no danmaku yet — M2).

## Load unpacked
1. Chrome/Edge ≥ 116 → `chrome://extensions` → enable *Developer mode*.
2. *Load unpacked* → select this folder (the one with `manifest.json`).
3. Open `https://live.bilibili.com/<room>`, hover player → click 小窗模式.
4. Close the mini window (✕ / Esc / window close) → video returns to the page.
Debug: page DevTools console, filter `[bmp]`.

## Notes (0.1.2)
- Live player often sits in a same-origin iframe. Document PiP only works from a
  **top-level** browsing context, so `openPip` resolves `documentPictureInPicture`
  from `window.top` when reachable, then moves `#live-player video` from the iframe
  document into the PiP window (and back on close).
- Cross-origin top frames cannot open Document PiP from the player iframe; check
  console for a clear `[bmp]` error in that case.

- 0.1.3: picks the *playing* <video> (not first match) across frames, moves it into PiP, logs post-move state, captureStream mirror fallback if it does not render.

- 0.1.4: moves the whole original `#live-player` (video + danmaku layer + controls) into the top-level Document PiP window (page styles copied), placeholder left on page; moved back on close. No captureStream.

- 0.1.5: iframe rooms → mirror mode (player stays on page, PiP shows `captureStream()`, audio from original); same-frame rooms move whole player, kick play/resize, fall back to mirror if not playing after ~1.8s.

- 0.1.6: back to moving the whole `#live-player` (no captureStream). PiP is requested from the document that owns the player (Chromium keeps the media player only then). In iframe rooms, where Chrome refuses iframe Doc PiP, the real player becomes a draggable/resizable in-page floating mini window (same nodes, controls + danmaku).

## Files
- `manifest.json` — MV3, two content scripts on `*://live.bilibili.com/*` (`all_frames`).
- `src/main-guard.js` — MAIN world, `document_start`: wraps page `documentPictureInPicture.requestWindow`;
  forwards to content via `bmp:pip-request` when `html[data-bmp-hijack]` is set (passes through when `data-bmp-self` is set on this or top documentElement).
- `src/content.js` — isolated world: Path A (official requestWindow) + Path B click interception,
  Doc PiP via top when needed, move video in/out, mute/volume/close bar.
