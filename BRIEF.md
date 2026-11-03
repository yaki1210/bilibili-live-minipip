# B站直播「弹幕小窗」插件 — 产品 + 技术 Brief（v0.1 草案）

> 状态：v0.3。M1 已写代码（待真机验证）。调研日期 2026-11-03（UTC+8）。

## 1. 背景
- **点播小窗**：B站点播页的“小窗模式”本质是把整个 BPX 播放器容器（含弹幕层、控制栏）用 CSS 移位/缩放到页面右下角，仍在页面内，因此弹幕正常。
- **直播小窗 / 系统画中画**：直播页的小窗与浏览器原生 `video.requestPictureInPicture()` 只能投出**裸 `<video>`**，弹幕是页面里的 DOM/Canvas 叠加层，无法进入系统 PiP → **小窗里没有弹幕**。
- 结论：要在“页面外”的浮窗里看到弹幕，需要用 **Document Picture-in-Picture**（可放任意 DOM 的置顶窗口）自绘弹幕层。

## 2. 目标（v1）
- 在 `live.bilibili.com/<房间号>` 页面一键打开置顶小窗：直播画面 + **实时弹幕**。
- 基础调节：弹幕开关、透明度、字号、速度、显示区域（上 1/4、1/2、全屏）、音量（含静音）。
- ~~可选：在小窗内发送弹幕~~ → **v1 不做**，以后再说。

## 3. 非目标（v1）
- 不做多开（同时多个直播间小窗）。
- 不支持非 Chromium 浏览器（Firefox/Safari 无 Document PiP）。
- 不劫持/替换整站播放器（不做 dmMiniPlayer 的“播放器替换”模式）。
- 不做礼物/SC/上舰特效渲染、不做录屏。

## 4. 推荐技术方案
### 4.1 窗口：Document Picture-in-Picture
- `documentPictureInPicture.requestWindow({width, height})`，必须由用户手势触发；Chrome 116+ / Edge。
- 把页面原 `<video>` 节点 **移动** 进 PiP 文档（不中断解码与音频；关闭时移回原位）。备选：`captureStream()`/canvas 复制（更耗性能，v1 不用）。
- 参考 dmMiniPlayer 的实现：`src/core/WebProvider/DocPIPWebProvider.ts` 按视频宽高比计算窗口尺寸，并注释了 Chrome bug：“第二次打开不会按照 width 和 height 设置窗口大小，需要自己调整”（用 `resizeTo` 兜底）。

### 4.2 弹幕源
- **v1：MutationObserver 监听页面聊天区**（右侧弹幕列表），解析新增节点的用户名/文本/表情。优点：零鉴权、零协议依赖、复用页面已登录状态；缺点：依赖 DOM 选择器、页面折叠聊天区时可能不更新、只能拿到页面已展示的弹幕。
- **v2：直连弹幕 WebSocket**（参考 dmMiniPlayer）：
  1. `room/v1/Room/mobileRoomInit?id=<短号>` → 真实 room_id；
  2. `xlive/web-room/v1/index/getDanmuInfo?id=<room_id>&type=0`（带 cookie，现需 WBI 签名）→ token + host_list；或像 dmMiniPlayer 那样直接读页面 `window.__danmuInfo`；
  3. 用 `bilibili-live-ws`（`LiveWS`，protover 3 / brotli）连 `wss://host:port/sub`，携带 uid（`/x/web-interface/nav`）与 `buvid3` cookie，否则弹幕可能被打码/限流。
- 抽象一个 `DanmakuSource` 接口（`onMessage(cb)`），v1/v2 可互换。

### 4.3 弹幕渲染
- PiP 文档内绝对定位层，CSS `transform: translateX` + `transition` 滚动；轨道分配避免重叠；上限并发数（如 60 条）超出丢弃。
- 设置存 `chrome.storage.sync`。

### 4.4 扩展形态
- MV3 Chrome 扩展：content script（live.bilibili.com）+ 需要读页面变量时注入 main-world 脚本。也可先做油猴脚本验证（Document PiP 在用户脚本里同样可用）。

## 5. 关键交互
- **入口**：劫持官方控制栏「小窗模式」按钮（点击时阻止官方 PiP，改开我们的 Doc PiP）。**不新增任何按钮**。
- **拖拽/贴边**：Document PiP 窗口位置由浏览器管理，**无法通过 API 设置/记忆位置**，只能用户拖动系统窗口；不可实现自定义贴边吸附。尺寸可 `resizeTo`（受限）。
- **关闭/回页**：小窗内 Esc 或关闭按钮 → 关闭 PiP，video 移回原位置继续播放；提供“返回标签页”按钮（`window.focus()` 受限，可能仅高亮）。
- **页面关闭/跳转** → PiP 随之关闭（API 行为）；监听 `pagehide` 清理。
- 小窗 hover 才显示控制条，3 秒无操作自动隐藏。

## 6. 风险
| 风险 | 说明 | 缓解 |
|---|---|---|
| HEVC/编码 | 直播流可能是 HEVC/WebCodecs/MSE；移动 video 节点一般没问题，但若播放器用 canvas 渲染则无 `<video>` 可移 | M0 探针确认；备选 canvas.captureStream |
| WBI/cookie | v2 的 getDanmuInfo 需 WBI 签名与登录 cookie，未登录弹幕会打码 | v1 走 DOM；v2 优先读 `window.__danmuInfo` |
| 仅 Chromium | Document PiP 仅 Chrome/Edge 116+ | 检测 API 不可用时隐藏入口并提示 |
| 发送弹幕 CSRF | `api.live.bilibili.com/msg/send` 需 `bili_jct` 作 csrf；风控/频率限制 | 可选功能，默认关；仅在登录态下启用，或模拟页面输入框提交 |
| 页面改版 | 选择器失效 | 选择器集中配置 + 降级提示 |
| 播放器状态冲突 | 移走 video 后原播放器可能重建/暂停 | M1 重点验证，必要时改为 captureStream |

## 7. 里程碑
- **M0 探针**：控制台脚本确认：video 选择器、聊天区容器及单条弹幕结构、`window.__danmuInfo` 是否存在、移动 video 后是否继续播放。
- **M1 无弹幕小窗**：入口按钮 → Document PiP 播放直播，关闭回页。
- **M2 弹幕层**：MutationObserver 弹幕源 + 滚动渲染。
- **M3 调节面板**：开关/透明度/字号/速度/区域/音量，持久化。
- **M4 发送弹幕（可选）**：输入框 + 发送，登录检测。
- （后续）v2 WebSocket 弹幕源。

## 8. 待确认问题（请勾选）
- [x] 形态：**Chrome 扩展**（已确认 2026-11-03）
- [x] 入口：**接管/替换官方「小窗模式」按钮**（用户确认：不新增按钮、不做悬浮/快捷键）
- [x] v1 弹幕源：**DOM 监听**（已确认）
- [x] 发送弹幕：**以后再说**（v1 不做）
- [ ] 弹幕默认显示区域：上 1/4 □ / 上 1/2 □ / 全屏 □
- [ ] 是否显示表情图片/粉丝牌/用户名：是 □ / 否 □
- [ ] 是否需要屏蔽词/只看房管等过滤：是 □ / 否 □
- [ ] 小窗默认尺寸：480×270 □ / 640×360 □ / 记忆上次 □
- [x] 范围：**只做直播**（不做点播）
- [ ] 是否计划上架商店（影响权限与隐私说明）：是 □ / 否 □

## 9. 参考
- dmMiniPlayer：https://github.com/apades/dmMiniPlayer （README 声明支持“bilibili 视频 + 直播”弹幕播放和发送）
  - 直播弹幕客户端：https://github.com/apades/dmMiniPlayer/blob/main/src/danmaku/bilibili/liveBarrageClient/index.ts
  - 独立弹幕获取包：https://github.com/apades/dmMiniPlayer/blob/main/packages/danmakuGetter/apiDanmaku/bilibili/BilibiliLive.ts
  - Document PiP 实现：https://github.com/apades/dmMiniPlayer/blob/main/src/core/WebProvider/DocPIPWebProvider.ts
- bilibili-live-ws：https://github.com/simon300000/bilibili-live-ws
- Bilibili-Evolved（点播弹幕转换器被 dmMiniPlayer 复用）：https://github.com/the1812/Bilibili-Evolved
- Document PiP API：https://developer.chrome.com/docs/web-platform/document-picture-in-picture
- B站 API 文档（社区）：https://github.com/SocialSisterYi/bilibili-API-collect

## 10. M0 探针结果（2026-11-03，游客，房间 27632810）
详见同目录 `probe-live.md` 与截图。

| 项 | 结果 |
|---|---|
| 播放器根 | `#live-player`（外层 `#live-player-ctnr` / `.live-player-mounter`） |
| 视频 | `#live-player video`（id 随机 `video-<digits>`，blob URL，绝对定位） |
| 弹幕叠层 | `#live-player .web-player-danmaku .danmaku-item-container`（本房间当时无滚动弹幕） |
| 聊天列表 | `#chat-items.chat-items > .chat-item`（系统通知有；真实弹幕 `data-*` 未验证到） |
| 原生小窗 | 控制栏「小窗模式」→ 置顶「Picture in picture」窗口（推断 Document PiP）；页内播放器仍在；**未见弹幕进小窗**（本房弹幕稀少，需热闹房复验） |
| 其它 | `.minimal-control-panel` / `#player-minimal-panel-vm`；控制条 hover 才渲染（svelte 哈希类） |
| 未测 | `window.__danmuInfo` / `livePlayer`（浏览器侧无法 eval）；移动 `<video>` 后是否断流 |

**对方案的含义：** 官方直播小窗已是 Document PiP 路线，但只投画面；我们的插件应在自建 Doc PiP 里叠自绘弹幕，或劫持/增强官方 PiP 文档（后者更脆）。M1 优先：自建 Doc PiP + 挪 `#live-player video`。


## 11. M1 进度（2026-11-03）
状态：**代码完成，待真机验证**（盒子浏览器无法加载解包扩展做端到端测试）。
- 拦截方式（多层）：
  1. `window` capture 阶段监听 pointerdown/mousedown/pointerup/mouseup/click，沿 `composedPath()` 在 `#live-player` 内找 `aria-label/title/data-title/data-tooltip` 或短文本匹配 `/^(退出)?小窗模式$/` 的节点 → `preventDefault + stopImmediatePropagation`，打开自建 Doc PiP（再点一次则关闭）。
  2. 兜底：若按钮本身无文本（svelte 哈希类、tooltip 为独立节点、hover 才渲染），则在控制区（`#web-player-controller-wrap-el` / `.control-area` / `*right-area*`）内点击时，扫描 `#live-player` 中**可见**的「小窗模式」tooltip，且其水平中心距指针 <40px 即判定命中。
  3. 保险：MAIN world 脚本在 `document_start` 包装页面的 `documentPictureInPicture.requestWindow`，在 `html[data-bmp-hijack]` 存在时 reject，从而即便 1/2 漏判，官方小窗也打不开（隔离世界里我们自己的调用不受影响）。
- 视频：移动 `#live-player video` 进 PiP 文档，记录原 parent/nextSibling/style，`pagehide`（PiP 与主页面）时移回并 `play()`。
- PiP 内：hover 底栏 静音 / 音量滑条 / 关闭，Esc 关闭。
- 不支持 Doc PiP 的浏览器：不挂钩，官方行为保留。
- 已知风险：tooltip 若不在 `#live-player` 内（挂 body 的 portal）兜底 2 失效 → 只剩 3（此时官方按钮点了"没反应"，需把 tooltip 扫描范围扩大到 document）；官方播放器在 video 被移走后可能重建/暂停 video；官方若改用 `video.requestPictureInPicture` 则 3 不覆盖；第二次打开窗口尺寸 Chrome bug 用 `resizeTo` 兜底。
