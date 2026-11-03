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
