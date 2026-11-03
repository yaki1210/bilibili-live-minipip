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
  };

  const logInfo = (...a) => console.info(TAG, ...a);
  const logWarn = (...a) => console.warn(TAG, ...a);
  const logErr = (...a) => console.error(TAG, ...a);
  const vstat = (v) => v && ({ paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight });

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
    bar.append(playBtn, muteBtn, vol, dmBtn, closeBtn);
    d.body.append(bar);

    state.ui = { bar, playBtn, muteBtn, dmBtn, center, layer, needsUnmute: false };
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
        if (!state.renderer) return;
        const on = !state.renderer.enabled;
        state.renderer.setEnabled(on);
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
        if (state.renderer) {
          const on = !state.renderer.enabled;
          state.renderer.setEnabled(on);
          dmBtn.textContent = on ? '弹幕开' : '弹幕关';
        }
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
    state.phase = 'active';
    logInfo('move active', { w: size.width, h: size.height, video: vstat(video) });
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
    if (wsAvailable()) { startWsDanmaku(); return; }
    startDomDanmaku();
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
      if (ver === 2) {
        try {
          const out = await inflateZlib(body);
          await parseWsBuffer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        } catch (e) {
          if (!wsWarned) { wsWarned = true; logWarn('ws inflate failed', e.name, e.message); }
        }
      } else if (ver === 3) {
        if (!wsWarned) { wsWarned = true; logWarn('ws brotli frame; protover 2 was not applied'); }
      } else if (op === 5) {
        parseDanmuJson(new TextDecoder().decode(body));
      }
      off += total;
    }
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
    const ds = new DecompressionStream('deflate');
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
    if (state.renderer) state.renderer.push({ segments: [{ type: 'text', text: t }], color, uname, text: t });
  }

  function startDomDanmaku() {
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
