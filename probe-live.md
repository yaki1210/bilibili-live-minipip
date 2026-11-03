# Bilibili live probe (2026-11-03, guest, no login)
URL: https://live.bilibili.com/27632810 (room id 27632810; chosen from homepage; a 语音连麦 "点歌" room, live, ~9h30 elapsed). Blob-URL video, playing, 720P.
Note: Google Translate bubble popped up (Chinese) – harmless.

## Player roots (found via page.content(); DevTools/JS eval blocked by proxy, so no globals probed)
- `#live-player` exists (inside `#live-player-ctnr`, `.live-player-mounter`).
- Inside #live-player (in order): `#fullscreen-danmaku-vm` (fullscreen danmaku input, guest-disabled), `.web-player-danmaku` (z-index 10, pointer-events:none, contains `.danmaku-item-container` > `.bili-danmaku-x-dm-rotate`), `.web-player-video-info-panel`, `.web-player-controller-bg.web-player-controller-wrap`, `#web-player-controller-wrap-el` (> `.live-web-player-controller.svelte-*` > `.control-area` > `.left-area` / right area; rendered only after hover), `#animation-mask-wrapper`, `<video>`, `.web-player-inject-wrap` (z-index 9, pointer-events none), `#web-player__bottom-bar__container` (inner `#full-screen-interactive-wrap`).
- Other: `.web-player-icon-roomStatus` (1). `.web-player-inject-wrapper` = 0 (note the "-wrap" vs "-wrapper").
## <video>
- Exactly 1 `<video id="video-<random digits>" autoplay playsinline webkit-playsinline src="blob:https://live.bilibili.com/...">`, style absolute 100%x100%, z-index 1. Direct child of `#live-player`'s inner player container (the one holding the danmaku layer) -> parent chain: `#live-player` > (player container div) > video. ID is random: select via `#live-player video`.
## Danmaku / chat
- Danmaku overlay (canvas/DOM layer over video): `#live-player .web-player-danmaku .danmaku-item-container` (empty in this room - no scrolling danmaku appeared; `.danmaku-item` count 0).
- Chat panel: `.chat-history-panel` > `#chat-history-list.chat-history-list` > `#chat-items.chat-items` > `.chat-item` (+ modifiers e.g. `.convention-msg border-box` for the system notice). Chat only had the system notice in guest session (guest chat sparse / login prompt "登录后可参与讨论" `.privacy-dialog`). No data-* attributes seen on the system item; real danmaku items normally carry data-danmaku/data-uname/data-ts etc. — unverified here (none arrived).
- Chat input area: `.chat-control-panel`, `.control-panel-icon-row`; guest shows "游客状态无法输入弹幕".
## Official 小窗
- Bottom-right player control icons (hover shows tooltip): 小窗模式 (first icon, ~x928,y693) -> tooltip toggles to 退出小窗模式; then 另两个功能图标, 网页全屏, 全屏.
- Clicking it opens a native always-on-top **Document Picture-in-Picture window** (OS window titled "Picture in picture", origin live.bilibili.com, bottom-right ~195x340 px), showing a scaled copy of the video/room view in portrait; the page player stays in place. Could not confirm danmaku in it (this room had no live danmaku); at least no danmaku visible. The controls bar has a left icon (pause/refresh/volume) + right area; selectors for the button not captured (svelte-hashed, hover-only DOM).
- No `[class*=pip]` elements in page DOM; a `player-minimal-panel-vm` / `.minimal-control-panel` / `.minimal-restore-btn` (pause/resume/reload) are DOM bits for the minimal/pip view.
## Screenshots (this dir)
- full-page-before-pip.webp, full-page-hover-tooltip.webp (tooltip 小窗模式), pip-mini-state.webp (full desktop with PiP window), player-area.png (crop), pip-window-crop.png (mini window).
## Limits
Browser tool blocks page.evaluate, so no JS globals / computed parent classes; findings from static HTML.
