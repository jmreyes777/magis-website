// src/utils/patchPassiveTouchListeners.js

// Patch event listeners to allow preventDefault on wheel/touch events
;(function() {
  function patch(proto) {
    if (!proto || !proto.addEventListener) return;
    const orig = proto.addEventListener;
    proto.addEventListener = function(type, listener, options) {
      // normalize options into an object
      let opts;
      if (typeof options === 'object' && options !== null) {
        opts = { ...options };
      } else {
        opts = { capture: Boolean(options) };
      }

      // force non-passive to allow preventDefault()
      if (
        type === 'touchmove'   ||
        type === 'touchstart'  ||
        type === 'wheel'
      ) {
        opts.passive = false;
      }

      return orig.call(this, type, listener, opts);
    };
  }

  // Patch key prototypes to ensure coverage
  patch(EventTarget.prototype);
  patch(Window.prototype);
  patch(Document.prototype);
  patch(HTMLElement.prototype);
})();
