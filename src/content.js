// Bilibili Live mini-player — M1.7: hijack native 「小窗模式」 → real top-level Document PiP.
// 0.1.7: iframe rooms request the PiP window from the TOP document (Chrome refuses Document PiP
// inside an iframe) and embed a fresh playback iframe in it. This is a real OS-level always-on-top
// window that can leave the player area. The old in-page float stays only as a last resort.
(() => {
  const TAG = '[bmp]';
  const PIP_TEXT = /^(退出)?小窗模式$/;
  const SEL = { player: '#live-player', video: '#live-player video' };
  const isTopFrame = window.self === window.top;

  let pipWin = null;
  let pipKind = null;    // 'move' (top document moves the player) | 'iframe' (PiP embeds an iframe)
  let restore = null;    // 'move': {player, parent, next, style, ph}
  let pipState = null;   // 'iframe': {win, video, before}
  let floatState = null; // last resort: in-page float window (same document)
  let lastHover = null;

  // ---------- PiP child document: this page was loaded inside our PiP window ----------
  function isPipChild() {
    if (isTopFrame) return false;
    try {
      return !!(window.top.document && window.top.document.documentElement &&
        window.top.document.documentElement.hasAttribute('data-bmp-pip-host'));
    } catch (_) { return false; }
  }

  if (isPipChild()) { initPipChild(); return; }

  function initPipChild() {
    console.info(TAG, 'PiP child document: isolating #live-player');
    const st = document.createElement('style');
    st.textContent = 'html{background:#000!important}body{margin:0!important;padding:0!important;' +
      'overflow:hidden!important;background:#000!important}';
    (document.head || document.documentElement).append(st);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { try { window.top.close(); } catch (_) { /* ignore */ } }
    }, true);

    let isolated = false;
    let tries = 0;
    const tick = () => {
      const player = document.querySelector(SEL.player);
      if (player) {
        if (!isolated) { isolated = true; isolatePlayer(player); }
        const v = player.querySelector('video');
        if (v) autoPlay(v);
      }
      if (tries++ < 30) setTimeout(tick, 400); // ~12s: player boot
    };
    tick();
  }

  // Hide every sibling subtree that does not contain the player, all the way up to <body>,
  // then pin the player to the viewport. Works for both the player page and a full room page.
  function isolatePlayer(player) {
    let node = player;
    while (node && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib !== node) sib.style.setProperty('display', 'none', 'important');
      }
      if (parent !== document.body) {
        const clear = [
          ['position', 'static'], ['transform', 'none'], ['filter', 'none'],
          ['overflow', 'visible'], ['width', 'auto'], ['height', 'auto'],
          ['max-width', 'none'], ['max-height', 'none'], ['min-width', '0'],
          ['min-height', '0'], ['display', 'block']
        ];
        for (const [k, v] of clear) parent.style.setProperty(k, v, 'important');
      }
      node = parent;
    }
    const b = document.body;
    if (b) {
      b.style.setProperty('margin', '0', 'important');
      b.style.setProperty('padding', '0', 'important');
      b.style.setProperty('overflow', 'hidden', 'important');
      b.style.setProperty('background', '#000', 'important');
    }
    document.documentElement.style.setProperty('background', '#000', 'important');
    const pin = [
      ['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'],
      ['z-index', '2147483647'], ['transform', 'none'], ['margin', '0'],
      ['border-radius', '0'], ['overflow', 'hidden']
    ];
    for (const [k, v] of pin) player.style.setProperty(k, v, 'important');
    try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ }
  }

  function autoPlay(v) {
    if (v.__bmpAutoplay) return;
    v.__bmpAutoplay = true;
    const attempt = (muted, left) => {
      if (muted) v.muted = true;
      let p;
      try { p = v.play(); } catch (_) { return; }
      if (!p || !p.catch) return;
      p.catch((e) => {
        if (e && e.name === 'NotAllowedError' && !muted) return attempt(true, left);
        if (left > 0) setTimeout(() => attempt(muted, left - 1), 700);
        else showUnmute(v);
      });
    };
    attempt(false, 3);
  }

  function showUnmute(v) {
    if (document.getElementById('bmp-unmute')) return;
    const b = document.createElement('button');
    b.id = 'bmp-unmute';
    b.textContent = '点击开启声音';
    b.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);' +
      'z-index:2147483647;padding:8px 16px;border:0;border-radius:6px;background:#00aeec;' +
      'color:#fff;font:14px/1.4 system-ui;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.45)';
    b.addEventListener('click', () => {
      v.muted = false;
      try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
      b.remove();
    });
    (document.body || document.documentElement).append(b);
  }

  // ---------- normal page (top document or the player iframe) ----------
  function getTopDpip() {
    if (isTopFrame) return window.documentPictureInPicture || null;
    try { return window.top.documentPictureInPicture || null; } catch (_) { return null; }
  }

  if (!getTopDpip()) console.warn(TAG, 'no usable Document PiP here; in-page float is the fallback');
  document.documentElement.setAttribute('data-bmp-hijack', '1');

  const txt = (el) => (el && (el.getAttribute?.('aria-label') || el.getAttribute?.('title') ||
    el.getAttribute?.('data-title') || el.getAttribute?.('data-tooltip') || '')).trim();

  // Visible tooltip somewhere in the page saying 小窗模式 / 退出小窗模式
  function visibleTooltipMatches() {
    const root = document.body;
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (PIP_TEXT.test(n.nodeValue.trim())) {
        const el = n.parentElement;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width && r.height && cs.visibility !== 'hidden' && cs.opacity !== '0') return el;
      }
    }
    return false;
  }

  function isPipControl(ev) {
    const path = ev.composedPath();
    const inPlayer = path.some((n) => n instanceof Element && n.matches?.(SEL.player));
    if (!inPlayer) return false;
    for (const n of path) {
      if (!(n instanceof Element)) continue;
      if (n.matches(SEL.player)) break;
      // 1) attribute / own text on the control itself
      if (PIP_TEXT.test(txt(n))) return true;
      if (n.childElementCount < 4 && PIP_TEXT.test((n.textContent || '').trim())) return true;
    }
    // 2) fallback: tooltip 「小窗模式」 currently shown and pointer is over an icon in the control area
    const inControls = path.some((n) => n instanceof Element &&
      n.matches?.('#web-player-controller-wrap-el, .control-area, [class*="right-area"]'));
    if (inControls && visibleTooltipMatches()) {
      const tip = visibleTooltipMatches();
      const t = tip.getBoundingClientRect();
      const x = ev.clientX, y = ev.clientY;
      // tooltip sits just above the hovered icon: horizontal overlap within ~40px
      if (Math.abs((t.left + t.right) / 2 - x) < 40 && y > t.top - 10) return true;
    }
    return false;
  }

  function swallow(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
  }

  // Mark so MAIN-world main-guard does not treat our requestWindow as an official page call.
  function setBmpSelf(on) {
    const attr = 'data-bmp-self';
    if (on) document.documentElement.setAttribute(attr, '1');
    else document.documentElement.removeAttribute(attr);
    try {
      const topDe = window.top && window.top !== window && window.top.document?.documentElement;
      if (topDe) {
        if (on) topDe.setAttribute(attr, '1');
        else topDe.removeAttribute(attr);
      }
    } catch (_) { /* cross-origin */ }
  }

  // --- Path A (primary): the official button calls documentPictureInPicture.requestWindow;
  // main-guard forwards it here synchronously. No DOM detection needed.
  let lastToggle = 0;
  function toggle(src) {
    const now = Date.now();
    if (now - lastToggle < 400) { console.debug(TAG, 'toggle debounced', src); return; }
    lastToggle = now;
    console.info(TAG, 'toggle via', src, pipWin ? '(close)' : '(open)');
    if (pipWin) { pipWin.close(); return; }
    if (floatState) { closeFloat(); return; }
    openPip().catch((e) => console.error(TAG, 'openPip failed', e));
  }
  window.addEventListener('bmp:pip-request', () => {
    // Frames without the player: warn and skip ack so official may proceed.
    if (!document.querySelector(SEL.video)) { console.warn(TAG, 'pip-request but no video here; fall through'); return; }
    document.documentElement.setAttribute('data-bmp-ack', '1');
    toggle('official requestWindow');
  });

  // --- Path B (secondary): DOM detection with a sticky pending flag, so the click still
  // opens our PiP even if the tooltip vanished between pointerdown and click.
  let pending = false;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(type, (ev) => {
      if (ev.button !== 0) return;
      if (type === 'pointerdown') {
        pending = isPipControl(ev);
        if (pending) console.debug(TAG, 'detected 小窗 control on pointerdown', ev.target);
      }
      if (pending) swallow(ev);
    }, true);
  }
  window.addEventListener('click', (ev) => {
    const hit = pending || isPipControl(ev);
    pending = false;
    if (!hit) return;
    swallow(ev);
    toggle('dom click');
  }, true);
  console.info(TAG, 'armed in', location.href);
  window.addEventListener('pointerover', (ev) => { lastHover = ev.target; }, true);

  const info = (el) => el && ({ connected: el.isConnected, doc: el.ownerDocument?.location?.href || '(pip)' });
  const vstat = (v) => v && ({ paused: v.paused, readyState: v.readyState, w: v.videoWidth, h: v.videoHeight });

  function copyStyles(fromDoc, toDoc) {
    let n = 0;
    for (const sheet of fromDoc.styleSheets) {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const st = toDoc.createElement('style'); st.textContent = css; toDoc.head.append(st); n++;
      } catch (_) {
        if (sheet.href) { // cross-origin sheet: reference it by URL
          const l = toDoc.createElement('link'); l.rel = 'stylesheet'; l.href = sheet.href; toDoc.head.append(l); n++;
        }
      }
    }
    // inherit html/body classes some themes key off
    toDoc.documentElement.className = fromDoc.documentElement.className;
    toDoc.body.className = fromDoc.body.className;
    return n;
  }

  async function openPip() {
    const player = document.querySelector(SEL.player);
    const video = document.querySelector(SEL.video);
    if (!player) { console.warn(TAG, 'no #live-player in this frame'); return; }
    if (floatState) { closeFloat(); return; }
    const vw = video?.videoWidth || 16, vh = video?.videoHeight || 9;
    const width = 480, height = Math.round(width * vh / vw);
    if (isTopFrame) await openPipInTop(player, video, width, height);
    else await openPipInFrame(player, video, width, height);
  }

  // Top document: moving #live-player into a PiP opened by its own document keeps the media element.
  async function openPipInTop(player, video, width, height) {
    const dpip = window.documentPictureInPicture;
    if (!dpip) { openFloat(player, video, width, height); return; }
    console.info(TAG, 'top: requestWindow', width, height);
    setBmpSelf(true);
    try { pipWin = await dpip.requestWindow({ width, height }); }
    catch (e) {
      pipWin = null;
      console.warn(TAG, 'top requestWindow refused → in-page float', e.name, e.message);
    } finally { setBmpSelf(false); }
    if (!pipWin) { openFloat(player, video, width, height); return; }
    pipKind = 'move';
    movePlayerIntoPip(player, video, width, height);
  }

  // iframe: Document PiP is top-level only. Ask the TOP document for the window and load a fresh
  // copy of this player page inside it (moving nodes across documents destroys the media element).
  async function openPipInFrame(player, video, width, height) {
    const dpip = getTopDpip();
    if (!dpip) {
      console.warn(TAG, 'iframe: top Doc PiP unreachable (cross-origin top?) → in-page float');
      openFloat(player, video, width, height);
      return;
    }
    console.info(TAG, 'iframe: requestWindow via top document', width, height);
    setBmpSelf(true);
    try { pipWin = await dpip.requestWindow({ width, height }); }
    catch (e) {
      pipWin = null;
      console.warn(TAG, 'iframe: top requestWindow refused → in-page float', e.name, e.message);
    } finally { setBmpSelf(false); }
    if (!pipWin) { openFloat(player, video, width, height); return; }
    pipKind = 'iframe';
    mountIframePip(pipWin, video, width, height);
  }

  function pipSourceUrl() {
    if (/^https?:/i.test(location.href)) return location.href;
    try {
      if (/^https?:/i.test(window.top.location.href)) return window.top.location.href;
    } catch (_) { /* cross-origin */ }
    return location.href;
  }

  function mountIframePip(win, video, width, height) {
    const d = win.document;
    d.documentElement.setAttribute('data-bmp-pip-host', '1');
    d.title = 'Bilibili Live 小窗';
    const st = d.createElement('style');
    st.textContent = 'html,body{margin:0!important;padding:0!important;width:100%;height:100%;' +
      'background:#000!important;overflow:hidden!important}' +
      'iframe.bmp-pip-frame{border:0;display:block;width:100%;height:100%;background:#000}';
    (d.head || d.documentElement).append(st);

    const f = d.createElement('iframe');
    f.className = 'bmp-pip-frame';
    f.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
    f.setAttribute('allowfullscreen', 'true');
    const src = pipSourceUrl();
    f.src = src;
    d.body.append(f);

    const hint = d.createElement('div');
    hint.textContent = '正在打开小窗…';
    hint.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:#000;color:#aaa;font:14px system-ui;pointer-events:none';
    d.body.append(hint);
    f.addEventListener('load', () => hint.remove(), { once: true });

    // Pause the page player: only one live stream / one audio source stays active.
    const before = video ? { paused: video.paused, muted: video.muted, volume: video.volume } : null;
    if (video) { try { video.muted = true; video.pause(); } catch (_) { /* ignore */ } }
    pipState = { win, video, before };

    try { win.resizeTo(width, height + (win.outerHeight - win.innerHeight)); } catch (_) { /* Chrome bug */ }
    win.addEventListener('pagehide', onIframePipClosed, { once: true });
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') win.close(); });
    console.info(TAG, 'iframe PiP mounted', src, vstat(video));
  }

  function onIframePipClosed() {
    const st = pipState; pipState = null; pipWin = null; pipKind = null;
    if (!st) return;
    const { video, before } = st;
    if (video && before) {
      try { video.muted = before.muted; video.volume = before.volume; } catch (_) { /* ignore */ }
      if (!before.paused) {
        try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
      }
    }
    console.info(TAG, 'iframe PiP closed; page player restored');
  }

  function makePlaceholder(player) {
    const ph = document.createElement('div');
    ph.className = 'bmp-placeholder';
    const r = player.getBoundingClientRect();
    ph.style.cssText = `width:${r.width}px;height:${r.height}px;background:#000;color:#888;display:flex;
      align-items:center;justify-content:center;font:14px system-ui`;
    ph.textContent = '正在小窗中播放';
    return ph;
  }

  // ---- Doc PiP opened by the top document itself: move the whole player (media stays alive)
  function movePlayerIntoPip(player, video, width, height) {
    console.info(TAG, 'pip opened');
    try { pipWin.resizeTo(width, height + (pipWin.outerHeight - pipWin.innerHeight)); } catch (_) { /* ignore */ }
    const d = pipWin.document;
    d.title = document.title;
    const nSheets = copyStyles(document, d);
    const style = d.createElement('style');
    style.textContent = `
      html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;
        background:#000!important;overflow:hidden!important;min-width:0!important}
      #live-player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;
        margin:0!important;transform:none!important;z-index:1!important}
      #live-player video{width:100%!important;height:100%!important;object-fit:contain}`;
    d.head.append(style);
    const ph = makePlaceholder(player);
    restore = { player, parent: player.parentNode, next: player.nextSibling, style: player.getAttribute('style'), ph };
    try {
      player.parentNode.insertBefore(ph, player);
      d.body.append(player);
      console.info(TAG, 'player moved into PiP', { sheets: nSheets, video: vstat(video) });
    } catch (e) { console.error(TAG, 'moving #live-player into PiP failed', e); }
    video?.play?.().catch(() => {});
    try { pipWin.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ }
    setTimeout(() => console.info(TAG, 'post-move check', vstat(player.querySelector('video'))), 1500);
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') pipWin.close(); });
    pipWin.addEventListener('pagehide', moveBack, { once: true });
  }

  // ---- Last resort: in-page float (same document). Only used when Doc PiP is impossible.
  function openFloat(player, video, width, height) {
    const availW = Math.max(240, document.documentElement.clientWidth - 48);
    const availH = Math.max(160, document.documentElement.clientHeight - 72);
    width = Math.min(width, availW);
    height = Math.min(height, availH);

    const ph = makePlaceholder(player);
    floatState = { player, ph, parent: player.parentNode, next: player.nextSibling, style: player.getAttribute('style') };
    player.parentNode.insertBefore(ph, player);

    const win = document.createElement('div');
    win.id = 'bmp-float';
    const vwW = document.documentElement.clientWidth, vwH = document.documentElement.clientHeight;
    win.style.cssText = `position:fixed;z-index:2147483647;left:${vwW - width - 24}px;top:${vwH - height - 24 - 24}px;
      width:${width}px;height:${height + 24}px;background:#000;box-shadow:0 8px 30px rgba(0,0,0,.5);
      border-radius:8px;overflow:hidden;resize:both;min-width:240px;min-height:160px;display:flex;flex-direction:column`;
    const bar = document.createElement('div');
    bar.style.cssText = 'height:24px;flex:none;display:flex;align-items:center;gap:6px;padding:0 6px;background:#222;color:#ddd;font:12px system-ui;cursor:move;user-select:none';
    bar.innerHTML = '<span style="flex:1">小窗模式（拖动标题栏，右下角调整大小）</span><button title="关闭 (Esc)" style="background:none;border:0;color:#ddd;cursor:pointer;font-size:14px">✕</button>';
    const body = document.createElement('div');
    body.style.cssText = 'position:relative;flex:1;min-height:0';
    win.append(bar, body);
    document.body.append(win);
    body.append(player); // same document → media player preserved
    player.style.cssText += ';position:absolute!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;transform:none!important';
    floatState.win = win;
    bar.querySelector('button').onclick = (e) => { e.stopPropagation(); closeFloat(); };

    // drag
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const sx = e.clientX, sy = e.clientY, r = win.getBoundingClientRect();
      bar.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        win.style.left = Math.max(0, r.left + ev.clientX - sx) + 'px';
        win.style.top = Math.max(0, r.top + ev.clientY - sy) + 'px';
      };
      const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', mv);
      bar.addEventListener('pointerup', up);
    });
    // let the player relayout when the float is resized
    floatState.ro = new ResizeObserver(() => window.dispatchEvent(new Event('resize')));
    floatState.ro.observe(win);
    floatState.esc = (e) => { if (e.key === 'Escape') closeFloat(); };
    document.addEventListener('keydown', floatState.esc);
    video?.play?.().catch(() => {});
    console.info(TAG, 'float window opened (same document)', vstat(video));
    setTimeout(() => console.info(TAG, 'float post-move check', vstat(player.querySelector('video'))), 1500);
  }

  function closeFloat() {
    if (!floatState) return;
    const { player, ph, parent, next, style, win, ro, esc } = floatState;
    ro?.disconnect(); document.removeEventListener('keydown', esc);
    if (ph.isConnected) ph.replaceWith(player);
    else if (parent?.isConnected) parent.insertBefore(player, next && next.parentNode === parent ? next : null);
    ph.remove(); win?.remove();
    style == null ? player.removeAttribute('style') : player.setAttribute('style', style);
    player.querySelector('video')?.play?.().catch(() => {});
    window.dispatchEvent(new Event('resize'));
    console.info(TAG, 'float closed, player restored');
    floatState = null;
  }

  function moveBack() {
    if (restore) {
      const { player, parent, next, style, ph } = restore;
      try {
        if (ph.isConnected) ph.replaceWith(player);
        else if (parent?.isConnected) parent.insertBefore(player, next && next.parentNode === parent ? next : null);
        else document.body.append(player);
      } catch (e) { console.error(TAG, 'move back failed', e); }
      ph.remove();
      style == null ? player.removeAttribute('style') : player.setAttribute('style', style);
      player.querySelector('video')?.play?.().catch(() => {});
      console.info(TAG, 'player moved back', info(player));
    }
    restore = null;
    pipWin = null;
    pipKind = null;
  }

  window.addEventListener('pagehide', () => {
    if (pipWin) pipWin.close();
    moveBack();
    closeFloat();
  });
})();
