// MAIN world: intercept the page's own documentPictureInPicture.requestWindow.
// Instead of rejecting blindly (which killed the button when our DOM detection missed),
// we hand the request to the isolated content script synchronously (same task, so the
// user's transient activation is still valid). If it acks, the official call is aborted;
// otherwise the official PiP proceeds (fall-through, never a dead button).
(() => {
  const dpip = window.documentPictureInPicture;
  if (!dpip || dpip.__bmpPatched) return;
  const orig = dpip.requestWindow.bind(dpip);
  const de = document.documentElement;

  function isBmpSelf() {
    if (de.hasAttribute('data-bmp-self')) return true;
    try {
      const topDe = window.top && window.top !== window && window.top.document?.documentElement;
      if (topDe && topDe.hasAttribute('data-bmp-self')) return true;
    } catch (_) { /* cross-origin */ }
    return false;
  }

  dpip.requestWindow = function (opts) {
    if (de.hasAttribute('data-bmp-hijack') && !isBmpSelf()) {
      de.removeAttribute('data-bmp-ack');
      window.dispatchEvent(new CustomEvent('bmp:pip-request'));
      if (de.hasAttribute('data-bmp-ack')) {
        de.removeAttribute('data-bmp-ack');
        console.info('[bmp] official requestWindow intercepted -> our PiP');
        return Promise.reject(new DOMException('Handled by bilibili-live-minipip', 'AbortError'));
      }
      console.warn('[bmp] content script did not ack; letting official PiP through');
    }
    return orig(opts);
  };
  dpip.__bmpPatched = true;
})();

// MAIN world: tap the page's own live danmaku WebSocket. DOM-based danmaku stops when the
// tab is hidden (Bilibili stops updating the chat list), but the socket keeps receiving.
// Frames are forwarded as the page sent them. The page's auth packet is left alone.
(() => {
  const Orig = window.WebSocket;
  if (!Orig || Orig.__bmpWsPatched) return;
  const DANMU_URL = /\/sub(\?|$)|broadcastlv|chat\.bilibili\.com/i;

  function isDanmuUrl(url) {
    try { return DANMU_URL.test(String(url)); } catch (_) { return false; }
  }

  function forward(data) {
    try {
      const post = (d) => {
        try { window.top.postMessage({ __bmpWs: true, data: d }, '*'); } catch (_) { /* ignore */ }
      };
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.arrayBuffer().then(post).catch(() => {});
        return;
      }
      if (data instanceof ArrayBuffer) { post(data); return; }
      if (ArrayBuffer.isView(data)) {
        post(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        return;
      }
      if (typeof data === 'string') post(data);
    } catch (_) { /* ignore */ }
  }

  function Patched(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    if (!isDanmuUrl(url)) return ws;
    try {
      ws.addEventListener('message', (ev) => forward(ev.data));
      document.documentElement.setAttribute('data-bmp-ws', '1');
      console.info('[bmp] ws hooked', String(url));
    } catch (_) { /* ignore */ }
    return ws;
  }
  Patched.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Orig[k];
  Patched.__bmpWsPatched = true;
  window.WebSocket = Patched;
})();

// MAIN world: expose the page's danmaku server config (token/host) to the content script.
// Bilibili sets window.__danmuInfo after the player boots; poll briefly, then post it once.
(() => {
  if (window.__bmpDanmuInfoPosted) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const info = window.__danmuInfo;
    if (info && info.data && info.data.token) {
      clearInterval(timer);
      window.__bmpDanmuInfoPosted = true;
      try {
        window.top.postMessage({ __bmpDanmuInfo: true, info: JSON.parse(JSON.stringify(info)) }, '*');
        document.documentElement.setAttribute('data-bmp-danmu-info', '1');
        console.info('[bmp] __danmuInfo captured');
      } catch (e) {
        console.warn('[bmp] __danmuInfo not cloneable', e && e.name);
      }
    } else if (tries > 120) {
      clearInterval(timer);
    }
  }, 500);
})();

// MAIN world: reuse the page's own getDanmuInfo response, and run the signed
// fallback with the page's cookies. An unsigned id+type request returns -352.
(() => {
  if (window.__bmpDanmuHook) return;
  window.__bmpDanmuHook = true;
  let postedToken = '';

  function publishDanmuInfo(json) {
    const data = json && json.data;
    if (!json || json.code !== 0 || !data || !data.token || !data.host_list || !data.host_list.length) return;
    if (data.token === postedToken) return;
    postedToken = data.token;
    try {
      window.top.postMessage({ __bmpDanmuInfo: true, info: json }, '*');
      document.documentElement.setAttribute('data-bmp-danmu-info', '1');
      console.info('[bmp] getDanmuInfo captured');
    } catch (e) {
      console.warn('[bmp] getDanmuInfo not postable', e && e.name);
    }
  }

  function isDanmuInfoUrl(url) {
    return String(url || '').indexOf('/xlive/web-room/v1/index/getDanmuInfo') !== -1;
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      const url = requestUrl(arguments[0]);
      const pending = origFetch.apply(this, arguments);
      if (!isDanmuInfoUrl(url)) return pending;
      return pending.then((res) => {
        try { res.clone().json().then(publishDanmuInfo).catch(() => {}); } catch (_) { /* ignore */ }
        return res;
      });
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bmpUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isDanmuInfoUrl(this.__bmpUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType && this.responseType !== 'text' && this.responseType !== '') return;
          publishDanmuInfo(JSON.parse(this.responseText));
        } catch (_) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  function allowedPageUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'https:') return false;
      if (u.hostname === 'api.live.bilibili.com' && u.pathname === '/xlive/web-room/v1/index/getDanmuInfo') return true;
      if (u.hostname === 'api.bilibili.com' && (u.pathname === '/x/web-interface/nav' || u.pathname === '/x/frontend/finger/spi')) return true;
      return false;
    } catch (_) { return false; }
  }

  function rememberBuvid(json) {
    const data = json && json.data;
    if (!data) return;
    const b3 = data.b_3 || data.buvid3;
    const b4 = data.b_4 || data.buvid4;
    const write = (name, value) => {
      if (!value || document.cookie.indexOf(name + '=') !== -1) return;
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return;
      document.cookie = name + '=' + value + '; domain=.bilibili.com; path=/; max-age=31536000';
    };
    write('buvid3', b3);
    write('buvid4', b4);
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || !d.__bmpFetch) return;
    const id = d.id;
    const reply = (payload) => window.postMessage(Object.assign({ __bmpFetchResult: true, id }, payload), '*');
    if (!allowedPageUrl(d.url)) { reply({ error: 'url refused' }); return; }
    const run = origFetch || window.fetch;
    run(d.url, { credentials: 'include' }).then((res) => res.json()).then((json) => {
      if (String(d.url).indexOf('/x/frontend/finger/spi') !== -1) rememberBuvid(json);
      if (isDanmuInfoUrl(d.url)) publishDanmuInfo(json);
      reply({ json });
    }).catch((e) => reply({ error: String(e && e.message || e) }));
  });
})();
