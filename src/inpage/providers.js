// What differs between the two sites the panel runs on.
import * as N from '../lib/neshan.js';
import * as G from '../lib/google.js';

// Accept links of either site wherever a link can be pasted.
const anyLink = (u) => N.parseNeshanUrl(u) || G.parseGoogleUrl(u);

export const neshanProvider = {
  id: 'neshan',
  siteName: 'نشان',
  storageKey: 'state',
  modes: ['CAR', 'PUBLIC_TRANSPORTATION', 'MOTOR', 'PEDESTRIAN', 'BIKE'],
  avoid: true, // traffic zone / odd-even / toll options
  linkHint: 'یا لینک یک مسیر نشان را اینجا بچسبانید',
  badLinkText: 'این لینک مسیر نشان نیست. لینکی شبیه neshan.org/maps/routing/… لازم است.',
  getRoutes: (args) => N.getRoutes(args),
  routeKey: (mode, o, d, avoid) => N.routeKey(mode, o, d, avoid),
  search: (term, center, signal) => N.search(term, center, signal),
  reverse: (p, signal) => N.reverse(p, signal),
  link: (mode, o, d) => N.neshanUrl(mode, o, d),
  parseLink: anyLink,
  currentRoute: () => N.parseNeshanUrl(location.pathname),
};

export const googleProvider = {
  id: 'google',
  siteName: 'گوگل‌مپ',
  storageKey: 'state.google',
  modes: ['CAR', 'PUBLIC_TRANSPORTATION', 'PEDESTRIAN', 'BIKE'],
  avoid: false,
  linkHint: 'یا لینک یک مسیر گوگل‌مپ را اینجا بچسبانید',
  badLinkText: 'این لینک مسیر گوگل‌مپ نیست. لینکی شبیه google.com/maps/dir/… لازم است.',
  getRoutes: ({ mode, origin, dest, signal }) => G.getGoogleRoutes({ mode, origin, dest, signal }),
  routeKey: (mode, o, d) => G.googleRouteKey(mode, o, d),
  search: (term, center, signal) => G.googleSearch(term, center, signal),
  // Google has no cheap reverse lookup we can use, but every route answer names its two
  // end points: a tiny walking route from the point gives the point's name (one request).
  reverse: async (p, signal) => {
    try {
      const alts = await G.getGoogleRoutes({ mode: 'PEDESTRIAN', origin: p, dest: { lat: p.lat + 0.0015, lng: p.lng }, signal });
      return alts.labels?.[0] || '';
    } catch {
      return '';
    }
  },
  link: (mode, o, d) => G.googleUrl(mode, o, d),
  parseLink: anyLink,
  currentRoute: () => G.parseGoogleUrl(location.href),
};
