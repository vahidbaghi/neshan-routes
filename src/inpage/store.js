// Page-side client of content/bridge.js (extension storage via window.postMessage).
let seq = 0;
const pending = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.__nr !== 'res') return;
  const done = pending.get(e.data.id);
  if (done) { pending.delete(e.data.id); done(e.data.result); }
});

function call(op, key, value) {
  return new Promise((resolve) => {
    const id = `nr${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, resolve);
    // same-window message; opaque origins (file:// test pages) cannot be named as a target
    const target = location.origin === 'null' ? '*' : location.origin;
    window.postMessage({ __nr: 'req', id, op, key, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }, target);
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 4000);
  });
}

export const store = {
  get: (key) => call('get', key),
  set: (key, value) => call('set', key, value),
  remove: (key) => call('remove', key),
};

export function onToggle(cb) {
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__nr === 'toggle') cb();
  });
}
