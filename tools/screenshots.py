"""Takes the README screenshots on the real neshan.org (Tehran) with the release build.

    node build.mjs
    python -I tools/screenshots.py [--proxy <proxy-url>]

Uses the real Neshan API, so it is written to be gentle: about 60 routing requests in
total, and the browser profile is kept in .shots-profile/ so a re-run reuses routes the
extension already has (for 30 minutes) instead of asking Neshan again.
"""
import io, sys, time
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'screenshots'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = ROOT / '.shots-profile'
PROXY = sys.argv[sys.argv.index('--proxy') + 1] if '--proxy' in sys.argv else None
R = '__routes.root'

# Three colleagues going home from different offices, plus one home with three daily trips.
TRIPS = [
    ('علی',            'CAR',   (35.7572, 51.4099, 'میدان ونک'),     (35.7414, 51.5010, 'نارمک، میدان هفت حوض'), '17:00'),
    ('سارا',           'CAR',   (35.6997, 51.3380, 'میدان آزادی'),   (35.7730, 51.4710, 'پاسداران، گلستان'),      '17:00'),
    ('رضا',            'CAR',   (35.7006, 51.3913, 'میدان انقلاب'),  (35.8048, 51.4337, 'میدان تجریش'),          '17:15'),
    ('خانه تا دفتر',    'CAR',   (35.7290, 51.4040, 'یوسف‌آباد'),     (35.7572, 51.4099, 'میدان ونک'),            ''),
    ('خانه تا باشگاه',  'MOTOR', (35.7290, 51.4040, 'یوسف‌آباد'),     (35.7790, 51.4130, 'پارک ملت'),             ''),
    ('خانه تا دانشگاه', 'BIKE',  (35.7291, 51.4041, 'یوسف‌آباد'),     (35.7036, 51.3966, 'دانشگاه تهران'),        ''),
]


def wait(pg, expr, timeout=90, what=''):
    end = time.time() + timeout
    while True:
        try:
            if pg.evaluate(expr):
                return
        except Exception:
            pass
        if time.time() > end:
            raise TimeoutError(what or expr)
        time.sleep(0.3)


def shot(pg, name):
    png = pg.screenshot()
    Image.open(io.BytesIO(png)).convert('RGB').save(OUT / f'{name}.webp', 'WEBP', quality=84, method=6)
    print('saved', name, flush=True)


def settle(pg, s=1.6):
    time.sleep(s)  # map animation + tiles


with sync_playwright() as p:
    opts = dict(channel='chrome', headless=True, viewport={'width': 1440, 'height': 900}, locale='fa-IR',
                args=['--enable-unsafe-extension-debugging'], ignore_default_args=['--disable-extensions'])
    if PROXY:
        opts['proxy'] = {'server': PROXY}
    ctx = p.chromium.launch_persistent_context(str(PROFILE), **opts)
    ctx.browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(ROOT / 'dist' / 'chrome')})
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    pg.goto('https://neshan.org/maps/@35.7400,51.4100,12z', wait_until='domcontentloaded')
    wait(pg, f"!!window.__routes && !!{R}.getElementById('tripList')", 60, 'panel')
    pg.evaluate(f"{R}.getElementById('panel').hidden && {R}.getElementById('launcher').click()")
    settle(pg, 3)

    have = pg.evaluate("__routes.state.trips.map(t => t.name)")
    if not have:
        shot(pg, '00-start')
        # first route through the UI: name, search suggestions, then a typed point
        pg.click('#addTripBtn')
        pg.keyboard.type(TRIPS[0][0])
        pg.fill('input[data-f=origin]', 'میدان ونک')
        pg.locator('input[data-f=origin] ~ .suggest button').first.wait_for(timeout=30000)
        settle(pg, 0.6)
        shot(pg, '01-search')
        pg.press('input[data-f=origin]', 'Enter')
        settle(pg, 0.5)
    # the rest of the data straight into the panel (labels given, so no address lookups)
    pg.evaluate("""(TRIPS) => {
      const s = __routes.state;
      TRIPS.forEach(([name, mode, o, d, dep], i) => {
        let t = s.trips.find((x) => x.name === name);
        if (!t) { __routes.root.getElementById('addTripBtn').click(); t = s.trips.at(-1); t.name = name; }
        t.mode = mode; t.depart = dep; t.inMeeting = i < 3;
        if (!t.origin || Math.abs(t.origin.lat - o[0]) > 1e-4) __routes.setPoint(t.id, 'origin', { lat: o[0], lng: o[1] }, o[2]);
        if (!t.dest || Math.abs(t.dest.lat - d[0]) > 1e-4) __routes.setPoint(t.id, 'dest', { lat: d[0], lng: d[1] }, d[2]);
      });
      __routes.renderTrips && __routes.renderTrips();
    }""", [[n, m, list(o), list(d), dep] for n, m, o, d, dep in TRIPS])
    wait(pg, "__routes.state.trips.length >= 6 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 240, 'routes')
    pg.evaluate("__routes.state.trips.forEach(t => t.hidden = false); __routes.fitAll()")
    pg.locator('.tab[data-tab=trips]').click()
    pg.evaluate(f"{R}.querySelectorAll('.trip.open .trip-row').forEach(r => r.click())")
    settle(pg, 2.5)
    shot(pg, '02-routes')

    # one route open: name, transport, origin/destination, Neshan's alternatives
    pg.locator('.trip-row').nth(1).click()
    pg.evaluate("__routes.fitAll()")
    settle(pg, 2)
    shot(pg, '03-route-editor')

    # picking a point on the map
    pg.locator('.trip.open .pick-btn[data-which=dest]').click()
    settle(pg, 0.8)
    shot(pg, '04-pick-on-map')
    pg.keyboard.press('Escape')
    pg.locator('.trip.open .trip-row').click()

    # compare: table and bars, then grouped by origin with only that group on the map
    pg.click('.tab[data-tab=compare]')
    pg.click('#compareBody label:has(input[value=none])')
    settle(pg, 1)
    shot(pg, '05-compare')
    pg.click('#compareBody label:has(input[value=origin])')
    pg.locator('.card.group:has(.g-row:nth-of-type(3)) [data-only]').first.click()
    settle(pg, 2.5)
    shot(pg, '06-compare-by-origin')
    pg.click('[data-act=show-all]')

    # meeting point for the three colleagues
    pg.click('.tab[data-tab=meet]')
    pg.evaluate(f"({R}.querySelector('input[name=precision][value=fast]').click(), true)")
    settle(pg, 0.5)
    shot(pg, '07-meeting-setup')
    if not pg.evaluate("__routes.state.meeting && !__routes.state.meeting.stale"):
        pg.click('#meetBtn')
        wait(pg, f"{R}.querySelectorAll('#meetResult .person').length === 3", 900, 'meeting result')
    wait(pg, f"!/^\\d/.test({R}.querySelector('.meet-addr').textContent)", 30, 'address')
    pg.evaluate(f"{R}.querySelector('[data-act=zoom-meet]').click()")
    pg.locator('details.person summary').first.click()
    settle(pg, 2.5)
    shot(pg, '08-meeting-result')

    # Neshan's night map: the panel follows
    # (hovering Neshan's button opens its layer panel, so click it from script)
    toggle_night = '''(label) => { const el = [...document.querySelectorAll('span, div, button')]
        .find((e) => e.childElementCount === 0 && e.textContent.trim() === label); if (el) el.click(); return !!el; }'''
    if pg.evaluate(toggle_night, 'نقشه نمای شب'):
        wait(pg, "__routes.root.host.classList.contains('dark')", 20, 'night map')
        settle(pg, 3)
        shot(pg, '09-night-map')
        pg.evaluate(toggle_night, 'نقشه نمای روز') or pg.evaluate(toggle_night, 'نقشه نمای شب')

    # a route open in Neshan itself can be added with one click
    pg.goto('https://neshan.org/maps/routing/car/origin/35.715500,51.425500/destination/35.744800,51.375300', wait_until='domcontentloaded')
    wait(pg, f"!!window.__routes && !{R}.getElementById('fromNeshan').hidden", 60, 'from-neshan banner')
    pg.click('.tab[data-tab=trips]')
    settle(pg, 4)
    shot(pg, '10-from-neshan')
    ctx.close()
print('done')
