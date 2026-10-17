// Entry point injected into neshan.org/maps and google.com/maps (MAIN world, bundled by build.mjs).
import { findNeshanMap, NeshanMap } from './neshan-map.js';
import { GoogleMap } from './google-map.js';
import { neshanProvider, googleProvider } from './providers.js';
import { setServiceName } from '../lib/neshan.js';
import { mountUI } from './ui.js';

if (!window.__neshanRoutesLoaded) {
  window.__neshanRoutesLoaded = true;
  const fail = (e) => console.warn('[neshan-routes] could not attach to the map:', e);
  if (/(^|\.)neshan\.org$/.test(location.hostname)) {
    setServiceName('نشان');
    findNeshanMap().then((m) => mountUI(new NeshanMap(m), neshanProvider)).catch(fail);
  } else if (/(^|\.)google\.[a-z.]+$/.test(location.hostname)) {
    setServiceName('گوگل');
    new GoogleMap().ready().then((gm) => {
      mountUI(gm, googleProvider);
      // Google's own side panel is on the right in right-to-left languages, else on the left
      if (document.documentElement.dir !== 'rtl') document.getElementById('neshan-routes-ext')?.classList.add('side-right');
    }).catch(fail);
  }
}
