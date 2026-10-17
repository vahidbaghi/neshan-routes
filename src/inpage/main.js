// Entry point injected into neshan.org/maps (MAIN world, bundled by build.mjs).
import { findNeshanMap, NeshanMap } from './neshan-map.js';
import { mountUI } from './ui.js';

if (!window.__neshanRoutesLoaded) {
  window.__neshanRoutesLoaded = true;
  findNeshanMap()
    .then((m) => mountUI(new NeshanMap(m)))
    .catch((e) => console.warn('[neshan-routes] could not attach to the Neshan map:', e));
}
