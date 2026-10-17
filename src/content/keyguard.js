// Runs in the page's own world before any page script. Keys typed in our panel must not
// reach the site's keyboard shortcuts: google.com/maps listens on window in the capture
// phase, ahead of the panel, so typing «.» or a digit there moved focus to Google (the field
// lost its text) or opened Google's menu. Stopping the event inside the panel is too late,
// so the site's key listeners are wrapped to skip events that come from the panel.
(() => {
  const HOST_ID = 'neshan-routes-ext';
  const KEYS = new Set(['keydown', 'keyup', 'keypress']);
  const proto = EventTarget.prototype;
  const add = proto.addEventListener, remove = proto.removeEventListener;
  const wrapped = new WeakMap();

  const fromPanel = (e) => {
    const host = document.getElementById(HOST_ID);
    return !!host && e.composedPath().includes(host);
  };
  // the panel's own listeners sit on the host or inside its shadow root
  const isPanel = (node) => {
    const host = document.getElementById(HOST_ID);
    return !!host && (node === host || (node instanceof Node && node.getRootNode() === host.shadowRoot));
  };
  const wrap = (listener) => {
    let w = wrapped.get(listener);
    if (!w) {
      w = function (e) {
        if (fromPanel(e) && !isPanel(this)) return undefined;
        return typeof listener === 'function' ? listener.call(this, e) : listener.handleEvent(e);
      };
      wrapped.set(listener, w);
    }
    return w;
  };
  const guarded = (type, listener) => KEYS.has(type) && listener && (typeof listener === 'function' || typeof listener === 'object');

  proto.addEventListener = function (type, listener, options) {
    return add.call(this, type, guarded(type, listener) ? wrap(listener) : listener, options);
  };
  proto.removeEventListener = function (type, listener, options) {
    return remove.call(this, type, guarded(type, listener) ? wrapped.get(listener) || listener : listener, options);
  };
})();
