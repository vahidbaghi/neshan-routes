"""Live check of the panel on google.com/maps (Chrome + Playwright, real Google responses).

    node build.mjs
    python -I tests/e2e/google_live.py <screenshot dir>

Opens Google's own route Vanak -> Enghelab and adds the same route in the panel, so the
screenshots show whether our line sits on Google's line before and after dragging and
zooming. Uses roughly 60 Google requests (spaced out); run it rarely.
"""
import sys, tempfile, time
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SHOTS = Path(sys.argv[1]); SHOTS.mkdir(parents=True, exist_ok=True)
R = '__routes.root'
results = []
def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

def wait(pg, expr, timeout=60, what=''):
    end = time.time() + timeout
    while True:
        try:
            if pg.evaluate(expr): return
        except Exception:
            pass
        if time.time() > end: raise TimeoutError(what or expr)
        time.sleep(0.3)

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix='nr-g-'), channel='chrome', headless=True,
        args=['--enable-unsafe-extension-debugging'], ignore_default_args=['--disable-extensions'],
        viewport={'width': 1440, 'height': 900}, locale='fa-IR')
    ctx.browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(ROOT / 'dist' / 'chrome')})
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto('https://www.google.com/maps/dir/35.7572,51.4099/35.7006,51.3913/data=!4m2!4m1!3e0?hl=fa', wait_until='domcontentloaded')
    wait(pg, f"!!window.__routes && !!{R}.getElementById('tripList')", 60, 'panel on google.com/maps')
    check('panel mounts on google.com/maps', pg.evaluate("__routes.provider.id") == 'google')
    time.sleep(4)
    check('"route open in Google Maps" detected', not pg.evaluate(f"{R}.getElementById('fromNeshan').hidden"),
          pg.evaluate(f"{R}.getElementById('fromNeshan').innerText"))
    pg.click('#fromNeshanBtn')
    wait(pg, "__routes.state.trips.length === 1 && __routes.runtime(__routes.state.trips[0].id).status === 'ok'", 60, 'route from Google')
    sub = pg.evaluate(f"{R}.querySelector('.row-sub').textContent")
    check('route fetched from Google', 'دقیقه' in sub, sub)
    check('origin named from Google', not pg.evaluate("/^\\d/.test(__routes.state.trips[0].origin.label)"), pg.evaluate("__routes.state.trips[0].origin.label"))
    check('our line drawn on the map layer', pg.evaluate("__routes.nm.root.querySelectorAll('svg path').length") >= 2)
    pg.locator('.trip.open .trip-row').click()
    time.sleep(1)
    pg.screenshot(path=str(SHOTS / 'google-1-overlay.png'))

    # drag the map: the layer must follow and be re-placed when Google reports the new view
    url0 = pg.url
    pg.mouse.move(700, 500); pg.mouse.down()
    for i in range(1, 16): pg.mouse.move(700 + 10 * i, 500 + 6 * i); time.sleep(0.02)
    pg.mouse.up()
    try:
        wait(pg, f"location.href !== {url0!r}", 8, 'view update after drag')
        time.sleep(0.6)
        moved = True
    except TimeoutError:
        moved = False
    check('after dragging Google updates the view and the layer is re-placed', moved and pg.evaluate("__routes.nm.layer.style.transform") in ('', 'translate(0px, 0px)'))
    pg.screenshot(path=str(SHOTS / 'google-2-after-drag.png'))
    pg.mouse.move(700, 520); pg.mouse.wheel(0, -500)
    time.sleep(3)
    pg.screenshot(path=str(SHOTS / 'google-3-after-zoom.png'))

    # pick a point on the map: no Google place card
    pg.click('#addTripBtn')
    pg.keyboard.type('سارا')
    before = pg.url
    pg.locator('.trip.open .pick-btn[data-which=origin]').click()
    pg.mouse.click(900, 650)
    wait(pg, "!!__routes.state.trips[1].origin", 10, 'picked origin')
    time.sleep(1.5)
    check('picking a point does not open Google\'s place card', '/place/' not in pg.url, pg.url[:90])
    pg.evaluate("""() => { const t = __routes.state.trips[1]; __routes.setPoint(t.id, 'dest', { lat: 35.7730, lng: 51.4710 }, 'پاسداران'); }""")
    pg.evaluate("""() => { document.querySelector('#neshan-routes-ext').shadowRoot.getElementById('addTripBtn').click();
        const t = __routes.state.trips[2]; t.name = 'رضا';
        __routes.setPoint(t.id, 'origin', { lat: 35.7006, lng: 51.3913 }, 'میدان انقلاب');
        __routes.setPoint(t.id, 'dest', { lat: 35.8048, lng: 51.4337 }, 'میدان تجریش'); }""")
    wait(pg, "__routes.state.trips.length === 3 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 90, 'three routes')
    check('three routes from Google', True, pg.evaluate(f"[...{R}.querySelectorAll('.row-sub')].map(e => e.textContent).join(' | ')"))

    # meeting point with Google routes
    pg.click('.tab[data-tab=meet]')
    pg.evaluate(f"({R}.querySelector('input[name=precision][value=fast]').click(), true)")
    t0 = time.time()
    pg.click('#meetBtn')
    wait(pg, f"{R}.querySelectorAll('#meetResult .person').length === 3", 400, 'meeting result')
    m = pg.evaluate("__routes.state.meeting")
    check('meeting point found with Google routes', True, f"{time.time() - t0:.0f}s, {m['calls']} requests, partial={m.get('partial')}")
    time.sleep(1)
    pg.screenshot(path=str(SHOTS / 'google-4-meeting.png'))
    check('no page errors from the panel', not [e for e in errors if 'neshan-routes' in e or 'inpage' in e], '; '.join(errors[:3]))
    ctx.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
