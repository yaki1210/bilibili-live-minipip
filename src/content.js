// Bilibili Live mini-player — M1: hijack native 「小窗模式」 → our Document PiP with the live <video>.
(() => {
  if (window.top !== window && !document.querySelector('#live-player')) {
    // iframe rooms: only act if the player lives here (checked again lazily below)
  }
  const TAG = '[bmp]';
  const PIP_TEXT = /^(退出)?小窗模式$/;
  const SEL = { player: '#live-player', video: '#live-player video' };
  let pipWin = null;
  let restore = null; // {video, parent, next, style}
  let lastHover = null;

  // Native Document PiP must run on a top-level browsing context. When the
  // live player lives in a same-origin iframe, resolve the API from top.
  function getDpip() {
    try {
      if (window.top && window.top !== window) {
        if (window.top.documentPictureInPicture)
          return window.top.documentPictureInPicture;
        return null;
      }
    } catch (_) {
      // cross-origin top: cannot use top's API from this frame
      return null;
    }
    return window.documentPictureInPicture || null;
  }

  if (!getDpip() && !('documentPictureInPicture' in window)) {
    console.warn(TAG, 'Document PiP not available here; will use in-page float window');
  }
  document.documentElement.setAttribute('data-bmp-hijack', '1');

  const txt = (el) => (el && (el.getAttribute?.('aria-label') || el.getAttribute?.('title') ||
    el.getAttribute?.('data-title') || el.getAttribute?.('data-tooltip') || '')).trim();

  // Visible tooltip somewhere in the player saying 小窗模式 / 退出小窗模式
  function visibleTooltipMatches() {
    // Tooltips may portal outside #live-player — walk the whole document.
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

  // 0.1.4: detach the WHOLE original player (#live-player: video + danmaku layer + controls)
  // into the top-level Document PiP window, instead of a bare <video> in a self-drawn shell.
  // Same DOM nodes are moved (not cloned), so decoding, audio, danmaku and player JS keep running.
  const info = (el) => el && ({ connected: el.isConnected, doc: el.ownerDocument?.location?.href || '(pip)' });

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

  // 0.1.6: same-document rule. Chromium keeps the media player when a <video> moves into a
  // Doc PiP window opened by its OWN document; otherwise the player is destroyed (endless loading).
  // So: top frame → Doc PiP (move whole #live-player). Iframe → try the iframe's own
  // requestWindow; if the browser refuses (top-level only), float the real #live-player
  // as an in-page mini window (same nodes, same document, controls + danmaku intact).
  let floatState = null; // {player, ph, parent, next, style}
  const vstat = (v) => v && ({ paused: v.paused, readyState: v.readyState, w: v.videoWidth, h: v.videoHeight });

  async function openPip() {
    const player = document.querySelector(SEL.player);
    const video = document.querySelector(SEL.video);
    if (!player) { console.warn(TAG, 'no #live-player in this frame'); return; }
    if (floatState) { closeFloat(); return; }
    const vw = video?.videoWidth || 16, vh = video?.videoHeight || 9;
    const width = 480, height = Math.round(width * vh / vw);

    const own = window.documentPictureInPicture;
    if (own) {
      console.info(TAG, 'requestWindow from own document', window.top !== window ? '(iframe)' : '(top)', width, height);
      setBmpSelf(true);
      try { pipWin = await own.requestWindow({ width, height }); }
      catch (e) {
        console.warn(TAG, 'own-document requestWindow refused → in-page float window', e.name, e.message);
        pipWin = null;
      } finally { setBmpSelf(false); }
    }
    if (!pipWin) { openFloat(player, video, width, height); return; }
    movePlayerIntoPip(player, video, width, height);
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

  // ---- Doc PiP (top frame / browsers that allow it): move whole player (0.1.4 behavior)
  function movePlayerIntoPip(player, video, width, height) {
    console.info(TAG, 'pip opened');
    try { pipWin.resizeTo(width, height + (pipWin.outerHeight - pipWin.innerHeight)); } catch {}
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
    try { pipWin.dispatchEvent(new Event('resize')); } catch {}
    setTimeout(() => console.info(TAG, 'post-move check', vstat(player.querySelector('video'))), 1500);
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') pipWin.close(); });
    pipWin.addEventListener('pagehide', moveBack, { once: true });
  }

  // ---- In-page float window (iframe rooms): same document, so video never reloads
  function openFloat(player, video, width, height) {
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
      const mv = (ev) => { win.style.left = Math.max(0, r.left + ev.clientX - sx) + 'px'; win.style.top = Math.max(0, r.top + ev.clientY - sy) + 'px'; };
      const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up);
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
    restore = null; pipWin = null;
  }

  window.addEventListener('pagehide', () => { if (pipWin) pipWin.close(); moveBack(); closeFloat(); });
})();
