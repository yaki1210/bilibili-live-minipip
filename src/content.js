// Bilibili Live mini-player — M2 (0.2.0): a real top-level mini window.
// top document: move #live-player into Document PiP (same document, media keeps playing).
// iframe room: mirror the playing <video> with captureStream into a PiP <video> and draw
// danmaku in a DOM layer inside the PiP window. No page reload, no second live stream.
(() => {
  const TAG = '[bmp]';
  const PIP_TEXT = /^(退出)?小窗模式$/;
  const SEL = { player: '#live-player', video: '#live-player video' };
  const isTopFrame = window.self === window.top;
  const EXCLUDE = /(gift|guard|system|welcome|interact|super-?chat|hot-?rank|common-?info|convention|activity|notice|pk[-_])/i;

  const state = {
    phase: 'idle',
    generation: 0,
    pipWin: null,
    pipVideo: null,
    sourceVideo: null,
    capStream: null,
    audio: null,
    renderer: null,
    dm: null,
    restore: null,
    listeners: [],
    timers: [],
    ui: {},
    barTimer: 0,
    wsListening: false,
    wsSeen: null,
    wsChain: null,
    ws: null,
    wsRetry: 0,
  };

  const logInfo = (...a) => console.info(TAG, ...a);
  const logWarn = (...a) => console.warn(TAG, ...a);
  const logErr = (...a) => console.error(TAG, ...a);
  const vstat = (v) => v && ({ paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight });

  // Danmaku server config from the page (posted by main-guard from window.__danmuInfo
  // or from the page's own getDanmuInfo response).
  let danmuInfo = null;
  let fetchSeq = 0;
  const fetchPending = new Map();
  function onMainMessage(ev) {
    const d = ev.data;
    if (!d) return;
    if (d.__bmpFetchResult && ev.currentTarget === window && fetchPending.has(d.id)) {
      const pending = fetchPending.get(d.id);
      fetchPending.delete(d.id);
      if (d.error) pending.reject(new Error(d.error));
      else pending.resolve(d.json);
      return;
    }
    if (d.__bmpDanmuInfo && d.info) {
      danmuInfo = d.info;
      logInfo('danmu info received');
    }
  }
  window.addEventListener('message', onMainMessage);
  if (!isTopFrame) {
    try { window.top.addEventListener('message', onMainMessage); } catch (_) { /* cross-origin */ }
  }

  // Fetch from the page world so the request carries the live page's cookies.
  // getDanmuInfo without a WBI signature returns -352.
  function pageFetch(url) {
    const id = ++fetchSeq;
    const bridged = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!fetchPending.has(id)) return;
        fetchPending.delete(id);
        reject(new Error('page fetch timeout'));
      }, 8000);
      fetchPending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      window.postMessage({ __bmpFetch: true, id, url }, '*');
    });
    return bridged.catch((error) => {
      logWarn('page fetch fallback', error.message);
      return fetch(url, { credentials: 'include' }).then((res) => res.json());
    });
  }

  // ---------- window helpers ----------
  function getTopDpip() {
    if (isTopFrame) return window.documentPictureInPicture || null;
    try { return window.top.documentPictureInPicture || null; } catch (_) { return null; }
  }

  function setBmpSelf(on) {
    const attr = 'data-bmp-self';
    if (on) document.documentElement.setAttribute(attr, '1');
    else document.documentElement.removeAttribute(attr);
    try {
      const topDe = window.top && window.top !== window && window.top.document && window.top.document.documentElement;
      if (topDe) {
        if (on) topDe.setAttribute(attr, '1');
        else topDe.removeAttribute(attr);
      }
    } catch (_) { /* cross-origin */ }
  }

  function copyStyles(fromDoc, toDoc) {
    let n = 0;
    for (const sheet of fromDoc.styleSheets) {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const st = toDoc.createElement('style');
        st.textContent = css;
        toDoc.head.append(st);
        n++;
      } catch (_) {
        if (sheet.href) {
          const l = toDoc.createElement('link');
          l.rel = 'stylesheet';
          l.href = sheet.href;
          toDoc.head.append(l);
          n++;
        }
      }
    }
    try {
      toDoc.documentElement.className = fromDoc.documentElement.className;
      toDoc.body.className = fromDoc.body.className;
    } catch (_) { /* ignore */ }
    return n;
  }

  function makePlaceholder(player) {
    const ph = document.createElement('div');
    ph.className = 'bmp-placeholder';
    const r = player.getBoundingClientRect();
    ph.style.cssText = 'width:' + r.width + 'px;height:' + r.height + 'px;background:#000;color:#888;' +
      'display:flex;align-items:center;justify-content:center;font:14px system-ui';
    ph.textContent = '正在小窗中播放';
    return ph;
  }

  function toastPage(msg) {
    try {
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);' +
        'z-index:2147483647;padding:8px 14px;border-radius:6px;background:rgba(0,0,0,.82);' +
        'color:#fff;font:13px system-ui;pointer-events:none';
      document.body.append(el);
      setTimeout(() => el.remove(), 2600);
    } catch (_) { /* ignore */ }
  }

  function toastPip(msg) {
    const win = state.pipWin;
    if (!win || win.closed) return;
    const d = win.document;
    let el = d.querySelector('.bmp-toast');
    if (!el) {
      el = d.createElement('div');
      el.className = 'bmp-toast';
      d.body.append(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el.__bmpTimer);
    el.__bmpTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  // ---------- video pick / size ----------
  function pickVideo(player) {
    if (!player) return null;
    const vids = [...player.querySelectorAll('video')];
    return vids.find((v) => !v.paused && v.videoWidth > 0) ||
      vids.find((v) => v.videoWidth > 0) || vids[0] || null;
  }

  function calcSize(video) {
    const vw = video && video.videoWidth ? video.videoWidth : 16;
    const vh = video && video.videoHeight ? video.videoHeight : 9;
    const portrait = vh > vw;
    let width = portrait ? 360 : 480;
    let height = Math.round(width * vh / vw);
    if (portrait) {
      height = Math.min(640, height);
      width = Math.round(height * vw / vh);
    }
    return { width, height };
  }

  // ---------- audio (page muted via gain, PiP gets the MediaStreamDestination) ----------
  let sharedCtx = null;
  const audioCache = new WeakMap();

  function ensureAudioContext() {
    try {
      if (!sharedCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        sharedCtx = new AC();
      }
      if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
      return sharedCtx;
    } catch (e) {
      logWarn('AudioContext unavailable', e.name, e.message);
      return null;
    }
  }

  function ensureAudio(video) {
    const orig = { muted: video.muted, volume: video.volume };
    const ctx = ensureAudioContext();
    if (!ctx) throw new Error('AudioContext unavailable');

    let graph = audioCache.get(video);
    if (!graph) {
      video.muted = false;
      video.volume = 1;
      try {
        const source = ctx.createMediaElementSource(video);
        const pageGain = ctx.createGain();
        pageGain.gain.value = 0;
        source.connect(pageGain);
        pageGain.connect(ctx.destination);
        const dest = ctx.createMediaStreamDestination();
        source.connect(dest);
        graph = { ctx, source, pageGain, dest, destConnected: true };
        audioCache.set(video, graph);
      } catch (e) {
        video.muted = orig.muted;
        video.volume = orig.volume;
        throw e;
      }
    } else {
      video.muted = false;
      video.volume = 1;
      graph.pageGain.gain.value = 0;
      if (!graph.destConnected) {
        try { graph.source.connect(graph.dest); } catch (_) { /* ignore */ }
        graph.destConnected = true;
      }
    }
    return { orig, graph, audioTrack: graph.dest.stream.getAudioTracks()[0] || null };
  }

  function releaseAudio(video, audio) {
    const { orig, graph } = audio;
    try { graph.source.disconnect(graph.dest); } catch (_) { /* ignore */ }
    graph.destConnected = false;
    try { graph.pageGain.gain.value = 1; } catch (_) { /* ignore */ }
    try { video.muted = orig.muted; video.volume = orig.volume; } catch (_) { /* ignore */ }
    try { graph.ctx.resume().catch(() => {}); } catch (_) { /* ignore */ }
  }

  function stopTracks(stream) {
    if (!stream) return;
    try { stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } }); } catch (_) { /* ignore */ }
  }

  function captureOf(video) {
    try {
      if (video.captureStream) return video.captureStream();
      if (video.mozCaptureStream) return video.mozCaptureStream();
    } catch (e) { logWarn('captureStream failed', e.name, e.message); }
    return null;
  }

  // ---------- danmaku renderer (inside the PiP document) ----------
  class DanmakuRenderer {
    constructor(doc, layer) {
      this.doc = doc;
      this.layer = layer;
      this.win = doc.defaultView;
      this.enabled = true;
      this.paused = false;
      this.alive = true;
      this.queue = [];
      this.active = [];
      this.tracks = [];
      this.speed = 130;
      this.font = 18;
      this.lineHeight = 24;
      this.maxActive = 80;
      this.rx = 0;
      this.shown = 0;
      this.dropped = 0;
      this.resize();
      this.tick = this.tick.bind(this);
      this.raf = this.win.requestAnimationFrame(this.tick);
    }

    resize() {
      const w = this.doc.documentElement.clientWidth || 480;
      const h = this.doc.documentElement.clientHeight || 270;
      this.font = Math.max(12, Math.min(22, Math.round(h / 18)));
      this.lineHeight = Math.round(this.font * 1.35);
      const usable = Math.max(this.lineHeight * 3, h - 64);
      const count = Math.max(3, Math.min(10, Math.floor(usable / this.lineHeight)));
      this.tracks = Array.from({ length: count }, (_, i) => ({ top: 8 + i * this.lineHeight, freeAt: 0 }));
      this.layer.style.fontSize = this.font + 'px';
    }

    push(item) {
      if (!this.enabled) return;
      this.rx++;
      this.queue.push({ item, at: this.win.performance.now() });
      if (this.queue.length > 30) {
        this.queue.shift();
        this.dropped++;
      }
    }

    tick() {
      if (!this.alive) return;
      const now = this.win.performance.now();
      if (!this.paused) {
        let n = 0;
        while (this.queue.length && n < 2) {
          const head = this.queue[0];
          if (now - head.at > 1500) {
            this.queue.shift();
            this.dropped++;
            continue;
          }
          const track = this.tracks.find((t) => t.freeAt <= now);
          if (!track) break;
          this.queue.shift();
          this.show(head.item, track, now);
          n++;
        }
      }
      this.raf = this.win.requestAnimationFrame(this.tick);
    }

    show(item, track, now) {
      const d = this.doc;
      const el = d.createElement('span');
      el.className = 'bmp-dm';
      el.style.top = track.top + 'px';
      el.style.color = item.color || '#ffffff';
      for (const seg of item.segments) {
        if (seg.type === 'image') {
          const img = d.createElement('img');
          img.src = seg.src;
          img.alt = seg.alt || '';
          img.style.width = Math.round(this.font * 1.3) + 'px';
          img.style.height = Math.round(this.font * 1.3) + 'px';
          img.onerror = () => {
            try { img.replaceWith(d.createTextNode('[' + (seg.alt || '表情') + ']')); } catch (_) { /* ignore */ }
          };
          el.append(img);
        } else {
          el.append(d.createTextNode(seg.text));
        }
      }
      this.layer.append(el);

      const w = el.offsetWidth || 0;
      const layerW = this.layer.clientWidth || 480;
      const dist = layerW + w;
      const dur = Math.max(600, Math.round(dist / this.speed * 1000));
      const anim = el.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + dist + 'px)' }],
        { duration: dur, easing: 'linear' }
      );
      anim.onfinish = () => { try { el.remove(); } catch (_) { /* ignore */ } };
      if (this.paused) { try { anim.pause(); } catch (_) { /* ignore */ } }

      track.freeAt = now + Math.round((w + 28) / this.speed * 1000);
      this.active.push(el);
      this.shown++;
      if (this.active.length > this.maxActive) {
        const old = this.active.shift();
        try { old.remove(); } catch (_) { /* ignore */ }
      }
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!on) {
        this.queue = [];
        for (const el of this.active) { try { el.remove(); } catch (_) { /* ignore */ } }
        this.active = [];
        this.tracks.forEach((t) => { t.freeAt = 0; });
      }
    }

    pause() {
      this.paused = true;
      for (const el of this.active) {
        const anims = el.getAnimations ? el.getAnimations() : [];
        anims.forEach((a) => { try { a.pause(); } catch (_) { /* ignore */ } });
      }
    }

    resume() {
      this.paused = false;
      for (const el of this.active) {
        const anims = el.getAnimations ? el.getAnimations() : [];
        anims.forEach((a) => { try { a.play(); } catch (_) { /* ignore */ } });
      }
    }

    stats() {
      return { rx: this.rx, shown: this.shown, dropped: this.dropped, queue: this.queue.length, active: this.active.length };
    }

    destroy() {
      this.alive = false;
      try { this.win.cancelAnimationFrame(this.raf); } catch (_) { /* ignore */ }
      for (const el of this.active) { try { el.remove(); } catch (_) { /* ignore */ } }
      this.active = [];
      this.queue = [];
      try { this.layer.replaceChildren(); } catch (_) { /* ignore */ }
    }
  }

  // ---------- PiP DOM (mirror path) ----------
  function buildPipDom(win) {
    const d = win.document;
    d.title = 'Bilibili Live 小窗';
    const st = d.createElement('style');
    st.textContent = [
      'html,body{margin:0!important;padding:0!important;width:100%;height:100%;background:#000!important;overflow:hidden!important}',
      '.bmp-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:1}',
      '.bmp-danmaku{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;' +
        'font-family:"Microsoft YaHei",system-ui,sans-serif;font-weight:600;' +
        'text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000}',
      '.bmp-dm{position:absolute;left:100%;white-space:nowrap;line-height:1.35;will-change:transform}',
      '.bmp-dm img{vertical-align:middle;margin:0 1px}',
      '.bmp-center{position:absolute;inset:0;display:none;align-items:center;justify-content:center;z-index:3;pointer-events:none}',
      '.bmp-center button{pointer-events:auto;padding:10px 22px;border:0;border-radius:22px;' +
        'background:rgba(0,0,0,.65);color:#fff;font:14px system-ui;cursor:pointer}',
      '.bmp-controls{position:absolute;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;' +
        'gap:10px;padding:0 12px;background:linear-gradient(transparent,rgba(0,0,0,.7));z-index:4;' +
        'opacity:0;transition:opacity .2s;pointer-events:none}',
      '.bmp-controls.show{opacity:1;pointer-events:auto}',
      '.bmp-controls button{background:none;border:0;color:#eee;font:12px system-ui;cursor:pointer;' +
        'padding:6px 8px;border-radius:4px}',
      '.bmp-controls button:hover{background:rgba(255,255,255,.15)}',
      '.bmp-controls input[type=range]{width:80px;accent-color:#00aeec}',
      '.bmp-status{font:11px system-ui;color:#aaa;margin-left:auto;white-space:nowrap}',
      '.bmp-badge{position:absolute;top:6px;right:8px;z-index:5;font:11px system-ui;' +
        'color:rgba(255,255,255,.75);background:rgba(0,0,0,.45);padding:2px 6px;border-radius:4px;' +
        'pointer-events:none;white-space:nowrap}',
      '.bmp-toast{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:5;' +
        'padding:8px 14px;border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font:13px system-ui;' +
        'display:none;pointer-events:none}',
    ].join('');
    (d.head || d.documentElement).append(st);

    const video = d.createElement('video');
    video.className = 'bmp-video';
    video.autoplay = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    d.body.append(video);
    state.pipVideo = video;

    const layer = d.createElement('div');
    layer.id = 'bmp-dm-layer';
    layer.className = 'bmp-danmaku';
    d.body.append(layer);

    const center = d.createElement('div');
    center.className = 'bmp-center';
    const centerBtn = d.createElement('button');
    centerBtn.textContent = '播放';
    center.append(centerBtn);
    d.body.append(center);

    const bar = d.createElement('div');
    bar.className = 'bmp-controls';
    const mkBtn = (act, label, text) => {
      const b = d.createElement('button');
      b.dataset.act = act;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.textContent = text;
      return b;
    };
    const playBtn = mkBtn('play', '播放/暂停', '暂停');
    const muteBtn = mkBtn('mute', '静音', '静音');
    const dmBtn = mkBtn('dm', '弹幕开关', '弹幕开');
    const closeBtn = mkBtn('close', '关闭小窗', '关闭');
    const vol = d.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1';
    vol.step = '0.01';
    vol.value = '1';
    vol.setAttribute('aria-label', '音量');
    const status = d.createElement('span');
    status.className = 'bmp-status';
    status.textContent = '弹幕：—';
    bar.append(status, playBtn, muteBtn, vol, dmBtn, closeBtn);
    d.body.append(bar);

    const badge = d.createElement('div');
    badge.id = 'bmp-dm-badge';
    badge.className = 'bmp-badge';
    badge.textContent = '弹幕：—';
    d.body.append(badge);

    state.ui = { bar, playBtn, muteBtn, dmBtn, center, layer, status, badge, lastStatus: '', needsUnmute: false };
    state.renderer = new DanmakuRenderer(d, layer);

    centerBtn.addEventListener('click', () => {
      const v = state.sourceVideo;
      if (v && v.paused) {
        try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
      }
    });

    bar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'play') {
        const v = state.sourceVideo;
        if (!v) return;
        if (v.paused) {
          try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
        } else {
          v.pause();
        }
      } else if (act === 'mute') {
        const v = state.pipVideo;
        if (!v) return;
        v.muted = !v.muted;
        muteBtn.textContent = v.muted ? '取消静音' : '静音';
        vol.value = v.muted ? '0' : String(v.volume);
      } else if (act === 'dm') {
        const on = !(state.renderer && state.renderer.enabled);
        syncDanmakuEnabled(on);
        dmBtn.textContent = on ? '弹幕开' : '弹幕关';
      } else if (act === 'close') {
        cleanup('close-button');
      }
    });

    vol.addEventListener('input', () => {
      const v = state.pipVideo;
      if (!v) return;
      v.volume = Number(vol.value);
      v.muted = v.volume === 0;
      muteBtn.textContent = v.muted ? '取消静音' : '静音';
    });

    video.addEventListener('click', () => {
      if (!state.ui.needsUnmute) return;
      state.ui.needsUnmute = false;
      video.muted = false;
      try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
      if (state.audio && state.audio.graph && state.audio.graph.ctx) {
        try { state.audio.graph.ctx.resume().catch(() => {}); } catch (_) { /* ignore */ }
      }
      toastPip('声音已开启');
    });

    let hideTimer = 0;
    const showBar = () => {
      bar.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.remove('show'), 2500);
      state.barTimer = hideTimer;
    };
    d.addEventListener('pointermove', showBar);
    bar.addEventListener('pointerenter', () => { bar.classList.add('show'); clearTimeout(hideTimer); });
    bar.addEventListener('pointerleave', showBar);

    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { cleanup('escape'); return; }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        const v = state.sourceVideo;
        if (!v) return;
        if (v.paused) {
          try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
        } else {
          v.pause();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        const v = state.pipVideo;
        if (v) { v.muted = !v.muted; muteBtn.textContent = v.muted ? '取消静音' : '静音'; }
      } else if (e.key === 'd' || e.key === 'D') {
        const on = !(state.renderer && state.renderer.enabled);
        syncDanmakuEnabled(on);
        dmBtn.textContent = on ? '弹幕开' : '弹幕关';
      }
    });

    win.addEventListener('resize', () => { if (state.renderer) state.renderer.resize(); });
  }

  // ---------- open paths ----------
  function startMove(player, video, size) {
    const win = state.pipWin;
    try { win.resizeTo(size.width, size.height + (win.outerHeight - win.innerHeight)); } catch (_) { /* ignore */ }
    const d = win.document;
    d.title = document.title || 'Bilibili Live 小窗';
    copyStyles(document, d);
    const style = d.createElement('style');
    style.textContent = [
      'html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;' +
        'background:#000!important;overflow:hidden!important;min-width:0!important}',
      '#live-player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;' +
        'margin:0!important;transform:none!important;z-index:1!important}',
      '#live-player video{width:100%!important;height:100%!important;object-fit:contain}',
    ].join('');
    d.head.append(style);

    const ph = makePlaceholder(player);
    state.restore = { player, parent: player.parentNode, next: player.nextSibling, style: player.getAttribute('style'), ph };
    try {
      player.parentNode.insertBefore(ph, player);
      d.body.append(player);
    } catch (e) {
      logErr('moving #live-player into PiP failed', e);
      cleanup('move-failed');
      openNative(video, 'move-failed');
      return;
    }
    try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    try { win.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ }
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup('escape'); });
    mountMoveDanmaku(win);
    state.phase = 'active';
    startDanmaku();
    logInfo('move active', { w: size.width, h: size.height, video: vstat(video) });
  }

  function mountMoveDanmaku(win) {
    const d = win.document;
    if (d.getElementById('bmp-dm-style')) return;
    const st = d.createElement('style');
    st.id = 'bmp-dm-style';
    st.textContent = [
      '.bmp-danmaku{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:6;' +
        'font-family:"Microsoft YaHei",system-ui,sans-serif;font-weight:600;' +
        'text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000}',
      '.bmp-dm{position:absolute;left:100%;white-space:nowrap;line-height:1.35;will-change:transform}',
      '.bmp-badge{position:absolute;top:6px;right:8px;z-index:7;font:11px system-ui;' +
        'color:rgba(255,255,255,.75);background:rgba(0,0,0,.45);padding:2px 6px;border-radius:4px;' +
        'pointer-events:none;white-space:nowrap}',
      'html.bmp-dm-live .web-player-danmaku, html.bmp-dm-live .danmaku-item-container{visibility:hidden!important}',
    ].join('');
    (d.head || d.documentElement).append(st);
    const layer = d.createElement('div');
    layer.id = 'bmp-dm-layer';
    layer.className = 'bmp-danmaku';
    d.body.append(layer);
    const badge = d.createElement('div');
    badge.id = 'bmp-dm-badge';
    badge.className = 'bmp-badge';
    badge.textContent = '弹幕：连接中…';
    d.body.append(badge);
  }

  function updatePlayBtn(playing) {
    if (state.ui.playBtn) state.ui.playBtn.textContent = playing ? '暂停' : '播放';
    if (state.ui.center) state.ui.center.style.display = playing ? 'none' : 'flex';
  }

  function bindSource(video) {
    const onPlay = () => { if (state.renderer) state.renderer.resume(); updatePlayBtn(true); };
    const onPause = () => { if (state.renderer) state.renderer.pause(); updatePlayBtn(false); };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    state.listeners.push({ target: video, type: 'play', fn: onPlay }, { target: video, type: 'pause', fn: onPause });
    updatePlayBtn(!video.paused);
  }

  async function playPipVideo(v) {
    try {
      await v.play();
      return true;
    } catch (e) {
      logWarn('PiP video play blocked', e.name, e.message);
      v.muted = true;
      try { await v.play(); } catch (e2) { logWarn('PiP video muted play failed', e2.name, e2.message); }
      if (state.ui) state.ui.needsUnmute = true;
      toastPip('已静音播放，点击画面开启声音');
      return false;
    }
  }

  async function startMirror(video, size) {
    const win = state.pipWin;
    const gen = state.generation;
    state.sourceVideo = video;
    buildPipDom(win);
    try { win.resizeTo(size.width, size.height + (win.outerHeight - win.innerHeight)); } catch (_) { /* ignore */ }

    const cap = captureOf(video);
    const vTrack = cap && cap.getVideoTracks ? cap.getVideoTracks()[0] : null;
    if (!vTrack) {
      logWarn('captureStream unavailable; native PiP fallback');
      cleanup('no-capture');
      openNative(video, 'no-capture');
      return;
    }

    let audio = null;
    try { audio = ensureAudio(video); }
    catch (e) { logWarn('audio route failed; page audio stays on', e.name, e.message); }

    if (gen !== state.generation) { stopTracks(cap); return; }

    if (audio && !audio.audioTrack) {
      releaseAudio(video, audio);
      audio = null;
    }
    const tracks = [vTrack];
    if (audio && audio.audioTrack) tracks.push(audio.audioTrack);
    state.capStream = cap;
    state.audio = audio;
    state.pipVideo.srcObject = new MediaStream(tracks);
    await playPipVideo(state.pipVideo);
    if (gen !== state.generation) return;

    startDanmaku();
    bindSource(video);
    state.phase = 'active';
    startHeartbeat();
    logInfo('mirror active', {
      role: isTopFrame ? 'top' : 'iframe',
      video: vstat(video),
      tracks: { video: 1, audio: !!(audio && audio.audioTrack) },
      pageAudio: audio ? 'muted-via-gain' : 'left-on',
    });
  }

  async function openNative(video, reason) {
    state.phase = 'idle';
    logWarn('native PiP fallback:', reason);
    if (!video) { toastPage('未找到视频'); return; }
    if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
      toastPage('当前浏览器无法打开小窗');
      return;
    }
    try {
      await video.requestPictureInPicture();
      logInfo('native PiP opened', vstat(video));
    } catch (e) {
      logWarn('native PiP failed', e.name, e.message);
      toastPage('小窗打开失败：' + (e.name || '未知错误'));
    }
  }

  async function openMini() {
    const player = document.querySelector(SEL.player);
    if (!player) { toastPage('未找到播放器'); return; }
    const video = pickVideo(player);
    if (!video) { toastPage('未找到视频'); return; }
    const size = calcSize(video);
    const dpip = getTopDpip();
    if (!dpip) { openNative(video, 'no-document-pip'); return; }

    if (!isTopFrame) ensureAudioContext();

    state.phase = 'opening';
    const gen = ++state.generation;
    setBmpSelf(true);
    let req;
    try {
      req = dpip.requestWindow({ width: size.width, height: size.height, preferInitialWindowPlacement: true });
    } catch (e) {
      setBmpSelf(false);
      state.phase = 'idle';
      logWarn('requestWindow threw', e.name, e.message);
      openNative(video, 'request-threw');
      return;
    }
    setBmpSelf(false);

    let win;
    try { win = await req; }
    catch (e) {
      state.phase = 'idle';
      logWarn('requestWindow rejected', e.name, e.message);
      openNative(video, 'request-rejected');
      return;
    }
    if (gen !== state.generation) { try { win.close(); } catch (_) { /* ignore */ } return; }

    state.pipWin = win;
    win.addEventListener('pagehide', () => cleanup('pagehide'), { once: true });

    if (isTopFrame) startMove(player, video, size);
    else await startMirror(video, size);
  }

  // ---------- danmaku source ----------
  function findDanmakuRoot() {
    try {
      const td = window.top.document;
      const root = td.querySelector('#chat-items, .chat-items');
      if (root) return { root, kind: 'chat', doc: td };
    } catch (_) { /* cross-origin */ }
    const own = document.querySelector('#chat-items, .chat-items');
    if (own) return { root: own, kind: 'chat', doc: document };
    const ov = document.querySelector('.web-player-danmaku .danmaku-item-container, .danmaku-item-container');
    if (ov) return { root: ov, kind: 'overlay', doc: document };
    return null;
  }

  function colorOf(raw) {
    if (!raw) return '#ffffff';
    const s = String(raw).trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
    if (/^\d{1,3},\d{1,3},\d{1,3}$/.test(s)) return 'rgb(' + s + ')';
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (!Number.isFinite(n)) return '#ffffff';
      return '#' + ((n & 0xffffff) >>> 0).toString(16).padStart(6, '0');
    }
    return '#ffffff';
  }

  function normalizeEmote(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.href);
      if (!/(^|\.)(hdslb\.com|bilibili\.com)$/i.test(u.hostname)) return '';
      if (u.protocol === 'http:') u.protocol = 'https:';
      return u.href;
    } catch (_) { return ''; }
  }

  function parseChatItem(el) {
    if (!el || !el.classList) return null;
    const cls = String(el.className || '');
    if (EXCLUDE.test(cls)) return null;
    if (!el.classList.contains('chat-item')) return null;
    const isDm = el.classList.contains('danmaku-item') || el.hasAttribute('data-danmaku');
    if (!isDm) return null;

    const rawText = (el.getAttribute('data-danmaku') || '').trim();
    const uname = (el.getAttribute('data-uname') || '').trim();
    const color = colorOf(el.getAttribute('data-color') || el.getAttribute('data-dm-color'));
    const image = el.getAttribute('data-image') || '';
    const fileId = el.getAttribute('data-file-id') || '';

    const segments = [];
    if (image && fileId) {
      const src = normalizeEmote(image);
      if (src) segments.push({ type: 'image', src, alt: rawText || '表情' });
      else if (rawText) segments.push({ type: 'text', text: rawText });
    } else if (rawText) {
      segments.push({ type: 'text', text: rawText });
    } else {
      const content = el.querySelector('.danmaku-item-right, .danmaku-content');
      const text = (content ? content.textContent : '').trim();
      if (text) segments.push({ type: 'text', text });
    }
    if (!segments.length) return null;
    return { segments, color, uname, text: rawText };
  }

  function parseOverlayItem(el) {
    if (!el) return null;
    const cls = String(el.className || '');
    if (EXCLUDE.test(cls)) return null;
    const text = (el.textContent || '').trim();
    const imgs = el.querySelectorAll ? [...el.querySelectorAll('img')] : [];
    const segments = [];
    let hasImg = false;
    for (const img of imgs) {
      const src = normalizeEmote(img.getAttribute('src') || img.src || '');
      if (!src) continue;
      segments.push({ type: 'image', src, alt: img.alt || '表情' });
      hasImg = true;
    }
    if (text && !hasImg) segments.push({ type: 'text', text });
    if (!segments.length) return null;
    const color = el.style && el.style.color ? el.style.color : '';
    return { segments, color, text };
  }

  function startDanmaku() {
    state.wsSeen = state.wsSeen || new Set();
    state.wsChain = state.wsChain || Promise.resolve();
    startDanmuSource().catch((e) => logWarn('danmaku start failed', e.name, e.message));
  }

  async function startDanmuSource() {
    setDmStatus('弹幕：连接中…');
    const info = await waitDanmuInfo(4000);
    if (state.phase !== 'active' && state.phase !== 'opening') return;
    if (info) { startOwnWs(info); return; }
    const nav = await fetchNav();
    const roomid = await resolveRoomId(null);
    if (state.phase !== 'active' && state.phase !== 'opening') return;
    let apiInfo = null;
    if (roomid) apiInfo = await fetchDanmuInfo(roomid, nav);
    if (state.phase !== 'active' && state.phase !== 'opening') return;
    if (apiInfo) { startOwnWs(apiInfo); return; }
    if (wsAvailable()) { startWsDanmaku(); return; }
    startDomDanmaku();
  }

  function setDmStatus(text) {
    state.dmText = text;
    if (state.ui) {
      if (state.ui.status) state.ui.status.textContent = text;
      if (state.ui.badge) state.ui.badge.textContent = text + ' · ' + (state.dmCount || 0);
      if (state.ui.lastStatus === text) return;
      state.ui.lastStatus = text;
    }
    logInfo('danmaku status:', text);
    toastPip(text);
  }

  function danmuPayload(r) {
    return r && r.data && r.data.token && r.data.host_list && r.data.host_list.length ? r : null;
  }

  function waitDanmuInfo(ms) {
    if (danmuInfo) return Promise.resolve(danmuInfo);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (danmuInfo) return resolve(danmuInfo);
        if (Date.now() - t0 >= ms) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async function startOwnWs(info) {
    const data = (info && info.data) || info || {};
    const token = data.token;
    const hosts = (data.host_list || []).filter((h) => h && h.host).map((h) => ({
      host: h.host,
      wss_port: h.wss_port || 443,
    }));
    if (!token || !hosts.length) { fallbackDanmaku(); return; }
    const roomid = await resolveRoomId(data);
    const uid = await fetchUid();
    if (state.phase !== 'active' && state.phase !== 'opening') return;
    const buvid = readBuvid();
    const auth = { uid, roomid, protover: 2, platform: 'web', type: 2, key: token, buvid, clientver: '1.14.3' };
    const win = state.pipWin;
    logInfo('danmaku ws connect', { host: hosts[0].host, roomid, uid, buvid: !!buvid, token: !!token, hosts: hosts.length });
    if (win && !win.closed) {
      try {
        state.pipClient = createPipDanmaku(win);
        state.pipClient.start({
          hosts: hosts,
          auth: auth,
          enabled: !(state.renderer && state.renderer.enabled === false),
        });
        return;
      } catch (e) {
        logWarn('pip danmaku client failed', e.name, e.message);
      }
    }
    connectDanmakuWs('wss://' + hosts[0].host + ':' + hosts[0].wss_port + '/sub', auth);
  }

  function syncDanmakuEnabled(on) {
    if (state.renderer) state.renderer.setEnabled(on);
    if (state.pipClient) state.pipClient.setEnabled(on);
  }

  // Socket, heartbeat and drawing use the PiP window's own constructors and timers.
  // The live tab is frozen in the background; a visible PiP window is not.
  // No inline script: the PiP document's CSP blocks it.
  function createPipDanmaku(win) {
    const document = win.document;
    const WebSocket = win.WebSocket;
    const setInterval = win.setInterval.bind(win);
    const clearInterval = win.clearInterval.bind(win);
    const setTimeout = win.setTimeout.bind(win);
    const requestAnimationFrame = win.requestAnimationFrame.bind(win);
    const performance = win.performance;
    const DecompressionStream = win.DecompressionStream || globalThis.DecompressionStream;
    const Blob = win.Blob;
    const Response = win.Response;
    const TextEncoder = win.TextEncoder;
    const TextDecoder = win.TextDecoder;
    const ArrayBufferRef = win.ArrayBuffer;

    const st = {
      ws: null,
      hb: 0,
      gen: 0,
      retry: 0,
      hosts: [],
      hostIdx: 0,
      auth: null,
      started: false,
      alive: true,
      enabled: true,
      seen: new Set(),
      queue: [],
      active: [],
      tracks: [],
      font: 18,
      count: 0,
    };

    function layer() { return document.getElementById('bmp-dm-layer'); }
    function setStatus(text) {
      const line = st.count ? text + ' · ' + st.count : text;
      const badge = document.getElementById('bmp-dm-badge');
      const status = document.querySelector('.bmp-status');
      if (badge) badge.textContent = line;
      if (status) status.textContent = text;
      document.documentElement.setAttribute('data-bmp-dm-state', text);
      document.documentElement.setAttribute('data-bmp-dm-count', String(st.count));
    }

    function resize() {
      const el = layer();
      if (!el) return;
      const h = document.documentElement.clientHeight || 270;
      const font = Math.max(12, Math.min(22, Math.round(h / 18)));
      const lh = Math.round(font * 1.35);
      const usable = Math.max(lh * 3, h - 64);
      const count = Math.max(3, Math.min(10, Math.floor(usable / lh)));
      st.font = font;
      st.tracks = Array.from({ length: count }, function (_, i) { return { top: 8 + i * lh, freeAt: 0 }; });
      el.style.fontSize = font + 'px';
    }

    function paint(item, track, now) {
      const elLayer = layer();
      if (!elLayer) return;
      const node = document.createElement('span');
      node.className = 'bmp-dm';
      node.style.top = track.top + 'px';
      node.style.color = item.color || '#ffffff';
      node.textContent = item.text;
      elLayer.append(node);
      const w = node.offsetWidth || 0;
      const dist = (elLayer.clientWidth || 480) + w;
      const speed = 130;
      const anim = node.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + dist + 'px)' }],
        { duration: Math.max(600, Math.round(dist / speed * 1000)), easing: 'linear' }
      );
      anim.onfinish = function () { try { node.remove(); } catch (e) { /* ignore */ } };
      track.freeAt = now + Math.round((w + 28) / speed * 1000);
      st.active.push(node);
      if (st.active.length > 80) {
        const old = st.active.shift();
        try { old.remove(); } catch (e) { /* ignore */ }
      }
    }

    function pump() {
      if (!st.alive) return;
      const now = performance.now();
      if (st.enabled) {
        let n = 0;
        while (st.queue.length && n < 2) {
          const track = st.tracks.find(function (t) { return t.freeAt <= now; });
          if (!track) break;
          paint(st.queue.shift(), track, now);
          n++;
        }
      }
      requestAnimationFrame(pump);
    }

    function colorOf(raw) {
      const s = String(raw == null ? '' : raw).trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
      if (/^\d+$/.test(s)) return '#' + ((parseInt(s, 10) & 0xffffff) >>> 0).toString(16).padStart(6, '0');
      return '#ffffff';
    }

    function remember(item) {
      if (!item.text) return;
      const key = item.key;
      if (st.seen.has(key)) return;
      st.seen.add(key);
      if (st.seen.size > 800) st.seen.clear();
      st.count++;
      setStatus(document.documentElement.getAttribute('data-bmp-dm-state') || '弹幕：WebSocket');
      if (!st.enabled) return;
      st.queue.push(item);
      if (st.queue.length > 40) st.queue.shift();
    }

    function sendPacket(ws, op, body) {
      const head = 16;
      const buf = new ArrayBuffer(head + body.byteLength);
      const dv = new DataView(buf);
      dv.setUint32(0, buf.byteLength);
      dv.setUint16(4, head);
      dv.setUint16(6, 1);
      dv.setUint32(8, op);
      dv.setUint32(12, 1);
      new Uint8Array(buf, head).set(body);
      ws.send(buf);
    }

    async function inflate(bytes, format) {
      const ds = new DecompressionStream(format);
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }

    async function parseBuf(buf) {
      let off = 0;
      while (off + 16 <= buf.byteLength) {
        const dv = new DataView(buf, off);
        const total = dv.getUint32(0);
        const headLen = dv.getUint16(4);
        const ver = dv.getUint16(6);
        const op = dv.getUint32(8);
        if (total < headLen || off + total > buf.byteLength) break;
        const body = new Uint8Array(buf, off + headLen, total - headLen);
        if (ver === 2 || ver === 3) {
          try {
            const out = await inflate(body, ver === 3 ? 'brotli' : 'deflate');
            await parseBuf(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
          } catch (e) {
            const n = Number(document.documentElement.getAttribute('data-bmp-dm-decode-fail') || 0) + 1;
            document.documentElement.setAttribute('data-bmp-dm-decode-fail', String(n));
          }
        } else if (op === 5) {
          let obj;
          try { obj = JSON.parse(new TextDecoder().decode(body)); } catch (e) { obj = null; }
          if (obj && obj.cmd) document.documentElement.setAttribute('data-bmp-dm-last-cmd', String(obj.cmd).slice(0, 40));
          if (obj && String(obj.cmd || '').indexOf('DANMU_MSG') === 0 && Array.isArray(obj.info)) {
            const info = obj.info;
            const text = String(info[1] || '').trim();
            const meta = Array.isArray(info[0]) ? info[0] : [];
            const user = Array.isArray(info[2]) ? info[2] : [];
            remember({
              text: text,
              color: colorOf(meta[3]),
              key: String(user[0] || '') + '|' + String(meta[4] || '') + '|' + text,
            });
          }
        }
        off += total;
      }
    }

    function shutdown() {
      st.alive = false;
      st.gen++;
      if (st.hb) { clearInterval(st.hb); st.hb = 0; }
      if (st.ws) { try { st.ws.close(); } catch (e) { /* ignore */ } st.ws = null; }
    }

    function connect() {
      const gen = ++st.gen;
      if (st.hb) { clearInterval(st.hb); st.hb = 0; }
      if (st.ws) { try { st.ws.close(); } catch (e) { /* ignore */ } st.ws = null; }
      if (!st.hosts.length) { setStatus('弹幕：无服务器'); return; }
      const h = st.hosts[st.hostIdx % st.hosts.length];
      const url = 'wss://' + h.host + ':' + (h.wss_port || 443) + '/sub';
      let ws;
      try { ws = new WebSocket(url); } catch (e) { schedule(gen); return; }
      st.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        if (gen !== st.gen) return;
        try { sendPacket(ws, 7, new TextEncoder().encode(JSON.stringify(st.auth || {}))); } catch (e) { /* ignore */ }
        st.hb = setInterval(function () {
          try { sendPacket(ws, 2, new Uint8Array(0)); } catch (e) { /* ignore */ }
        }, 30000);
        st.retry = 0;
        document.documentElement.classList.add('bmp-dm-live');
        setStatus('弹幕：WebSocket');
      };
      ws.onmessage = function (ev) {
        const n = Number(document.documentElement.getAttribute('data-bmp-dm-frames') || 0) + 1;
        document.documentElement.setAttribute('data-bmp-dm-frames', String(n));
        const take = function (data) {
          if (data instanceof ArrayBufferRef) parseBuf(data).catch(function () {});
        };
        if (ev.data instanceof Blob) ev.data.arrayBuffer().then(take).catch(function () {});
        else take(ev.data);
      };
      ws.onclose = function () {
        if (gen !== st.gen || !st.alive) return;
        if (st.hb) { clearInterval(st.hb); st.hb = 0; }
        document.documentElement.classList.remove('bmp-dm-live');
        st.hostIdx++;
        schedule(gen);
      };
      setStatus('弹幕：连接中…');
    }

    function schedule(gen) {
      st.retry++;
      setStatus('弹幕：重连 ' + st.retry);
      setTimeout(function () {
        if (gen !== st.gen || !st.alive) return;
        connect();
      }, Math.min(30000, 2000 * st.retry));
    }

    win.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(pump);

    return {
      start: function (cfg) {
        if (st.started) return;
        st.hosts = (cfg && cfg.hosts) || [];
        st.auth = (cfg && cfg.auth) || {};
        st.enabled = !cfg || cfg.enabled !== false;
        st.started = true;
        resize();
        connect();
      },
      stop: shutdown,
      setEnabled: function (on) { st.enabled = !!on; },
    };
  }

  function fallbackDanmaku() {
    if (wsAvailable()) startWsDanmaku();
    else startDomDanmaku();
  }

  function pageRoomId() {
    let path = location.pathname;
    if (!/\/(\d+)(\/|$)/.test(path) && !isTopFrame) {
      try { path = window.top.location.pathname; } catch (_) { /* cross-origin */ }
    }
    const m = path.match(/\/(\d+)(\/|$)/);
    return m ? Number(m[1]) : 0;
  }

  async function resolveRoomId(data) {
    if (data && data.room_id) return data.room_id;
    const short = pageRoomId();
    if (!short) return 0;
    try {
      const r = await fetch('https://api.live.bilibili.com/room/v1/Room/mobileRoomInit?id=' + short, { credentials: 'include' }).then((x) => x.json());
      if (r && r.data && r.data.room_id) return r.data.room_id;
    } catch (_) { /* ignore */ }
    return short;
  }

  let navCache = null;
  async function fetchNav() {
    if (navCache) return navCache;
    try {
      const r = await pageFetch('https://api.bilibili.com/x/web-interface/nav');
      navCache = r && r.data ? r.data : null;
    } catch (e) {
      logWarn('nav failed', e.name, e.message);
      navCache = null;
    }
    return navCache;
  }

  async function fetchUid() {
    const nav = await fetchNav();
    return nav && nav.mid ? nav.mid : 0;
  }

  // Minimal MD5 (UTF-8) for the WBI signature; no dependencies.
  function md5(str) {
    const utf8 = new TextEncoder().encode(str);
    const len = utf8.length;
    const bitLen = len * 8;
    const total = (((len + 8) >> 6) + 1) * 64;
    const padded = new Uint8Array(total);
    padded.set(utf8);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(total - 8, bitLen >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

    for (let off = 0; off < total; off += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    out.setInt32(0, a0, true);
    out.setInt32(4, b0, true);
    out.setInt32(8, c0, true);
    out.setInt32(12, d0, true);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, '0');
    return hex;
  }

  function signDanmuQuery(roomid, nav) {
    if (!nav || !nav.wbi_img || !nav.wbi_img.img_url || !nav.wbi_img.sub_url) return '';
    const keyOf = (u) => String(u).split('/').pop().split('.')[0];
    const raw = keyOf(nav.wbi_img.img_url) + keyOf(nav.wbi_img.sub_url);
    const TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
      33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
      0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
    const mixin = TAB.map((i) => raw[i] || '').join('').slice(0, 32);
    const params = {
      id: String(roomid),
      type: '0',
      web_location: '444.8',
      wts: String(Math.floor(Date.now() / 1000)),
    };
    const query = Object.keys(params).sort().map((k) => {
      const v = String(params[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    return query + '&w_rid=' + md5(query + mixin);
  }

  async function fetchDanmuInfo(roomid, nav, triedBuvid) {
    try {
      const query = signDanmuQuery(roomid, nav);
      if (!query) {
        logWarn('getDanmuInfo wbi key missing');
        return null;
      }
      const url = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' + query;
      const r = await pageFetch(url);
      const payload = danmuPayload(r);
      if (payload) return payload;
      logWarn('getDanmuInfo refused', r && r.code, r && r.message);
      if (!triedBuvid && r && r.code === -352) {
        await pageFetch('https://api.bilibili.com/x/frontend/finger/spi');
        navCache = null;
        return fetchDanmuInfo(roomid, await fetchNav(), true);
      }
    } catch (e) {
      logWarn('getDanmuInfo failed', e.name, e.message);
    }
    return null;
  }

  function readCookie(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (_) { return ''; }
  }

  function readBuvid() {
    let v = readCookie('buvid3');
    if (!v) { try { v = localStorage.getItem('buvid3') || ''; } catch (_) { /* ignore */ } }
    if (!v) { try { v = sessionStorage.getItem('buvid3') || ''; } catch (_) { /* ignore */ } }
    return v;
  }

  function sendPacket(ws, op, body, ver) {
    const head = 16;
    const buf = new ArrayBuffer(head + body.byteLength);
    const dv = new DataView(buf);
    dv.setUint32(0, buf.byteLength);
    dv.setUint16(4, head);
    dv.setUint16(6, ver == null ? 1 : ver);
    dv.setUint32(8, op);
    dv.setUint32(12, 1);
    new Uint8Array(buf, head).set(body);
    ws.send(buf);
  }

  function connectDanmakuWs(url, auth) {
    if (state.ws) { try { state.ws.close(); } catch (_) { /* ignore */ } state.ws = null; }
    // Create the socket in the PiP window when possible: that window stays visible and
    // unthrottled while the page tab is in the background or the browser is minimized.
    const win = state.pipWin && !state.pipWin.closed ? state.pipWin : null;
    const WS = (win && win.WebSocket) || WebSocket;
    const setI = win && win.setInterval ? win.setInterval.bind(win) : setInterval;
    const clearI = win && win.clearInterval ? win.clearInterval.bind(win) : clearInterval;
    const setT = win && win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
    let ws;
    try { ws = new WS(url); } catch (e) {
      logWarn('danmaku ws create failed', e.name, e.message);
      fallbackDanmaku();
      return;
    }
    state.ws = ws;
    ws.binaryType = 'arraybuffer';
    let hb = 0;
    ws.onopen = () => {
      try {
        sendPacket(ws, 7, new TextEncoder().encode(JSON.stringify(auth)));
        hb = setI(() => {
          try { sendPacket(ws, 2, new Uint8Array(0)); } catch (_) { /* ignore */ }
        }, 30000);
        state.dmCount = 0;
        logInfo('danmaku ws open', url);
        setDmStatus('弹幕：WebSocket');
      } catch (e) {
        logWarn('danmaku ws auth failed', e.name, e.message);
      }
    };
    ws.onmessage = (ev) => parseWsPayload(ev.data);
    ws.onerror = () => logWarn('danmaku ws error');
    ws.onclose = (ev) => {
      if (hb) { try { clearI(hb); } catch (_) { /* ignore */ } }
      if (state.phase !== 'active' && state.phase !== 'opening') return;
      const n = (state.wsRetry || 0) + 1;
      state.wsRetry = n;
      logWarn('danmaku ws closed; retry', n, ev && ev.code, ev && ev.reason);
      setDmStatus('弹幕：断开重试 ' + n);
      if (n <= 3) {
        setT(() => connectDanmakuWs(url, auth), 3000);
      } else {
        fallbackDanmaku();
      }
    };
  }

  function wsAvailable() {
    try { if (document.documentElement.hasAttribute('data-bmp-ws')) return true; } catch (_) { /* ignore */ }
    try {
      const td = window.top.document;
      return !!(td && td.documentElement && td.documentElement.hasAttribute('data-bmp-ws'));
    } catch (_) { return false; }
  }

  function startWsDanmaku() {
    if (state.wsListening) return;
    state.wsListening = true;
    state.wsSeen = new Set();
    state.wsChain = Promise.resolve();
    const onMsg = (ev) => {
      const d = ev.data;
      if (!d || !d.__bmpWs) return;
      if (!state.renderer) return;
      if (state.phase !== 'active' && state.phase !== 'opening') return;
      parseWsPayload(d.data);
    };
    window.addEventListener('message', onMsg);
    state.listeners.push({ target: window, type: 'message', fn: onMsg });
    if (!isTopFrame) {
      try {
        window.top.addEventListener('message', onMsg);
        state.listeners.push({ target: window.top, type: 'message', fn: onMsg });
      } catch (_) { /* cross-origin */ }
    }
    logInfo('danmaku source ws (page socket tap)');
    setDmStatus('弹幕：页面 Socket');
  }

  let wsWarned = false;
  function parseWsPayload(data) {
    try {
      if (typeof data === 'string') { parseDanmuJson(data); return; }
      let buf = null;
      if (data instanceof ArrayBuffer) buf = data;
      else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (!buf) return;
      const run = () => parseWsBuffer(buf).catch((e) => {
        if (!wsWarned) { wsWarned = true; logWarn('ws parse failed', e.name, e.message); }
      });
      state.wsChain = (state.wsChain || Promise.resolve()).then(run, run);
    } catch (e) {
      if (!wsWarned) { wsWarned = true; logWarn('ws payload failed', e.name, e.message); }
    }
  }

  async function parseWsBuffer(buf) {
    let off = 0;
    while (off + 16 <= buf.byteLength) {
      const dv = new DataView(buf, off);
      const total = dv.getUint32(0);
      const headLen = dv.getUint16(4);
      const ver = dv.getUint16(6);
      const op = dv.getUint32(8);
      if (total < headLen || off + total > buf.byteLength) break;
      const body = new Uint8Array(buf, off + headLen, total - headLen);
      if (ver === 2 || ver === 3) {
        try {
          const out = await inflateFormat(body, ver === 3 ? 'brotli' : 'deflate');
          await parseWsBuffer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        } catch (e) {
          if (!wsWarned) { wsWarned = true; logWarn(ver === 3 ? 'ws brotli frame' : 'ws inflate failed', e && e.message); }
        }
      } else if (op === 5) {
        parseDanmuJson(new TextDecoder().decode(body));
      }
      off += total;
    }
  }

  async function inflateFormat(bytes, format) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
    const ds = new DecompressionStream(format);
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function parseDanmuJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (_) { return; }
    const cmd = String(obj.cmd || '');
    if (!cmd.startsWith('DANMU_MSG')) return;
    const info = obj.info;
    if (!Array.isArray(info)) return;
    const t = String(info[1] || '').trim();
    if (!t) return;
    const uid = Array.isArray(info[2]) ? String(info[2][0] || '') : '';
    const ts = Array.isArray(info[0]) ? String(info[0][4] || '') : '';
    const key = uid + '|' + ts + '|' + t;
    if (state.wsSeen) {
      if (state.wsSeen.has(key)) return;
      state.wsSeen.add(key);
      if (state.wsSeen.size > 800) state.wsSeen.clear();
    }
    const uname = Array.isArray(info[2]) ? String(info[2][1] || '') : '';
    const color = colorOf(String(info[3] == null ? '' : info[3]));
    if (state.renderer) {
      state.renderer.push({ segments: [{ type: 'text', text: t }], color, uname, text: t });
      state.dmCount = (state.dmCount || 0) + 1;
      if (state.ui && state.ui.badge) {
        state.ui.badge.textContent = (state.dmText || '弹幕') + ' · ' + state.dmCount;
      }
    }
  }

  function startDomDanmaku() {
    setDmStatus('弹幕：DOM（最小化会停）');
    let tries = 0;
    const attempt = () => {
      if (state.phase !== 'active' && state.phase !== 'opening') return;
      const found = findDanmakuRoot();
      if (!found) {
        if (++tries < 10) {
          const id = setTimeout(attempt, 1000);
          state.timers.push(id);
        } else {
          logWarn('danmaku source not found; video only');
        }
        return;
      }
      const { root, kind, doc } = found;
      const View = doc.defaultView;
      if (!View || !root || root.nodeType !== 1) { logWarn('danmaku root invalid'); return; }
      const MO = View.MutationObserver;
      const seen = new WeakSet();
      const handle = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        const parsed = kind === 'chat' ? parseChatItem(el) : parseOverlayItem(el);
        if (parsed && state.renderer) state.renderer.push(parsed);
      };
      const observer = new MO((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!(n instanceof View.Element)) continue;
            if (kind === 'chat') {
              if (n.matches && n.matches('.chat-item')) handle(n);
              if (n.querySelectorAll) {
                for (const el of n.querySelectorAll('.chat-item')) handle(el);
              }
              const p = n.parentElement && n.parentElement.closest ? n.parentElement.closest('.chat-item') : null;
              if (p) handle(p);
            } else {
              handle(n);
            }
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      state.dm = { observer, root, kind, doc };
      logInfo('danmaku source', kind, 'crossDoc=' + (doc !== document), root.id || root.className || root.tagName);
    };
    attempt();
  }

  function stopDanmaku() {
    if (state.pipClient) {
      try { state.pipClient.stop(); } catch (_) { /* ignore */ }
      state.pipClient = null;
    }
    if (state.ws) { try { state.ws.close(); } catch (_) { /* ignore */ } state.ws = null; }
    if (state.dm && state.dm.observer) {
      try { state.dm.observer.disconnect(); } catch (_) { /* ignore */ }
    }
    state.dm = null;
  }

  function startHeartbeat() {
    const id = setInterval(() => {
      const v = state.sourceVideo;
      const p = state.pipVideo;
      const r = state.renderer;
      if (!v || !p) return;
      logInfo('hb', {
        hidden: document.hidden,
        src: vstat(v),
        pip: vstat(p),
        dm: r ? r.stats() : null,
      });
    }, 15000);
    state.timers.push(id);
  }

  // ---------- cleanup ----------
  function cleanup(reason) {
    if (state.phase === 'idle' || state.phase === 'closing') return;
    state.phase = 'closing';
    state.generation++;

    stopDanmaku();
    if (state.barTimer) { clearTimeout(state.barTimer); state.barTimer = 0; }
    for (const id of state.timers) {
      try { clearTimeout(id); } catch (_) { /* ignore */ }
      try { clearInterval(id); } catch (_) { /* ignore */ }
    }
    state.timers.length = 0;
    for (const l of state.listeners) {
      try { l.target.removeEventListener(l.type, l.fn); } catch (_) { /* ignore */ }
    }
    state.listeners.length = 0;

    if (state.renderer) {
      try { state.renderer.destroy(); } catch (_) { /* ignore */ }
      state.renderer = null;
    }

    if (state.pipVideo) {
      try { state.pipVideo.pause(); state.pipVideo.srcObject = null; } catch (_) { /* ignore */ }
    }
    if (state.capStream) {
      stopTracks(state.capStream);
      state.capStream = null;
    }
    if (state.audio) {
      releaseAudio(state.sourceVideo, state.audio);
      state.audio = null;
    }

    if (state.restore) {
      const r = state.restore;
      state.restore = null;
      try {
        if (r.ph.isConnected) r.ph.replaceWith(r.player);
        else if (r.parent && r.parent.isConnected) r.parent.insertBefore(r.player, r.next && r.next.parentNode === r.parent ? r.next : null);
        else document.body.append(r.player);
      } catch (e) { logWarn('restore player failed', e.name, e.message); }
      try { r.ph.remove(); } catch (_) { /* ignore */ }
      try { r.style == null ? r.player.removeAttribute('style') : r.player.setAttribute('style', r.style); } catch (_) { /* ignore */ }
      const v = r.player.querySelector('video');
      if (v) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ } }
    }

    if (state.pipWin && !state.pipWin.closed) {
      try { state.pipWin.close(); } catch (_) { /* ignore */ }
    }
    state.pipWin = null;
    state.pipVideo = null;
    state.sourceVideo = null;
    state.dm = null;
    state.ui = {};
    state.wsListening = false;
    state.wsSeen = null;
    state.wsChain = null;
    state.ws = null;
    state.wsRetry = 0;
    state.phase = 'idle';
    logInfo('closed', reason);
  }

  // ---------- hijack the native 小窗模式 button ----------
  document.documentElement.setAttribute('data-bmp-hijack', '1');
  if (!getTopDpip()) logWarn('no usable Document PiP here; native PiP will be the fallback');

  const txt = (el) => (el && (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.getAttribute('data-title') || el.getAttribute('data-tooltip')) || '')).trim();

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
    const inPlayer = path.some((n) => n instanceof Element && n.matches && n.matches(SEL.player));
    if (!inPlayer) return false;
    for (const n of path) {
      if (!(n instanceof Element)) continue;
      if (n.matches(SEL.player)) break;
      if (PIP_TEXT.test(txt(n))) return true;
      if (n.childElementCount < 4 && PIP_TEXT.test((n.textContent || '').trim())) return true;
    }
    const inControls = path.some((n) => n instanceof Element && n.matches &&
      n.matches('#web-player-controller-wrap-el, .control-area, [class*="right-area"]'));
    if (inControls) {
      const tip = visibleTooltipMatches();
      if (tip) {
        const t = tip.getBoundingClientRect();
        const x = ev.clientX, y = ev.clientY;
        if (Math.abs((t.left + t.right) / 2 - x) < 40 && y > t.top - 10) return true;
      }
    }
    return false;
  }

  function swallow(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
  }

  let lastToggle = 0;
  function toggle(src) {
    const now = Date.now();
    if (now - lastToggle < 400) { logInfo('toggle debounced', src); return; }
    lastToggle = now;
    if (state.phase === 'opening' || state.phase === 'closing') return;
    if (state.phase === 'active') { cleanup('toggle'); return; }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    const dpip = getTopDpip();
    if (dpip && dpip.window) { try { dpip.window.close(); } catch (_) { /* ignore */ } return; }
    logInfo('toggle via', src, '(open)');
    openMini().catch((e) => {
      logErr('openMini failed', e);
      toastPage('打开小窗失败');
      cleanup('open-failed');
    });
  }

  window.addEventListener('bmp:pip-request', () => {
    if (!document.querySelector(SEL.video)) { logWarn('pip-request but no video here; fall through'); return; }
    document.documentElement.setAttribute('data-bmp-ack', '1');
    toggle('official requestWindow');
  });

  let pending = false;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(type, (ev) => {
      if (ev.button !== 0) return;
      if (type === 'pointerdown') {
        pending = isPipControl(ev);
        if (pending) logInfo('detected 小窗 control on pointerdown', ev.target);
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

  window.addEventListener('pagehide', () => { cleanup('page'); });

  logInfo('armed in', location.href);
})();
