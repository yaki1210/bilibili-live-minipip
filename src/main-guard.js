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
// We ask the server for protover 2 (zlib) instead of brotli, forward every frame to the
// content script, and it renders into the Document PiP window (which stays visible).
(() => {
  const Orig = window.WebSocket;
  if (!Orig || Orig.__bmpWsPatched) return;
  const DANMU_URL = /\/sub(\?|$)|broadcastlv|chat\.bilibili\.com/i;

  function isDanmuUrl(url) {
    try { return DANMU_URL.test(String(url)); } catch (_) { return false; }
  }

  // The auth packet is op 7, ver 1, JSON body. Switch protover 3 (brotli) to 2 (zlib);
  // the page's own parser handles the zlib frames by their version field.
  function patchAuth(data) {
    try {
      let buf = null;
      if (data instanceof ArrayBuffer) buf = data;
      else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (!buf || buf.byteLength < 16) return data;
      const dv = new DataView(buf);
      const total = dv.getUint32(0);
      const headLen = dv.getUint16(4);
      const op = dv.getUint32(8);
      if (op !== 7 || total < headLen || total > buf.byteLength) return data;
      const text = new TextDecoder().decode(new Uint8Array(buf, headLen, total - headLen));
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') return data;
      obj.protover = 2;
      const body = new TextEncoder().encode(JSON.stringify(obj));
      const out = new ArrayBuffer(headLen + body.byteLength);
      const odv = new DataView(out);
      odv.setUint32(0, out.byteLength);
      odv.setUint16(4, headLen);
      odv.setUint16(6, dv.getUint16(6));
      odv.setUint32(8, op);
      odv.setUint32(12, dv.getUint32(12));
      new Uint8Array(out, headLen).set(body);
      return out;
    } catch (_) { return data; }
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
      const send = ws.send.bind(ws);
      ws.send = function (d) { return send(patchAuth(d)); };
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
