"""Offline UI test of the panel (no neshan.org at all).

    python -I tests/e2e/offline_ui.py <screenshot dir> [--ratelimit]

Bundles tests/e2e/offline/entry.js (real panel + stand-in map + fake Neshan API) with
esbuild, opens it in the installed Chrome (Playwright) and walks through the UI.
--ratelimit additionally runs a meeting search against a fake limiter (5 requests / 5 s)
with the extension's real request pacing; it takes about two minutes.
"""
import pathlib, subprocess, sys, tempfile, time
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(sys.argv[1]); SHOTS.mkdir(parents=True, exist_ok=True)
RATELIMIT = '--ratelimit' in sys.argv
CLIP = {'x': 56, 'y': 58, 'width': 390, 'height': 700}

work = pathlib.Path(tempfile.mkdtemp(prefix='nr-offline-'))
subprocess.run(['npx', 'esbuild', str(ROOT / 'tests/e2e/offline/entry.js'), '--bundle', '--format=iife',
                '--loader:.css=text', f'--outfile={work / "bundle.js"}', '--log-level=warning'],
               check=True, cwd=ROOT, shell=sys.platform == 'win32')
(work / 'index.html').write_text('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#e9e7e2">'
                                 '<div id="map" style="position:fixed;inset:0"></div><script src="bundle.js"></script>', encoding='utf-8')

results = []
def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix='nr-h-'), channel='chrome', headless=True,
                                               viewport={'width': 1100, 'height': 900})
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto((work / 'index.html').as_uri())
    pg.wait_for_function("!!window.__routes && !__routes.root.getElementById('panel').hidden", timeout=15000)
    js = pg.evaluate
    shot = lambda n: pg.screenshot(path=str(SHOTS / f'offline-{n}.png'), clip=CLIP)
    T = "__routes.root.querySelectorAll('.trip')[%d]"

    check('first run shows the three-step guide', js("__routes.root.querySelectorAll('.steps li').length") == 3)
    check('no route count badge while empty', js("__routes.root.getElementById('tripCount').hidden"))
    shot('1-empty')

    # a new route opens with the name field focused
    pg.click('#addTripBtn')
    check('new route: name field is focused', js("__routes.root.activeElement?.dataset.f") == 'name')
    pg.keyboard.type('علی')
    check('row shows the typed name', js(f"{T % 0}.querySelector('.row-name').textContent") == 'علی')
    pg.fill('input[data-f=origin]', '35.7572, 51.4099')
    pg.locator('input[data-f=origin] ~ .suggest button').first.wait_for()
    pg.press('input[data-f=origin]', 'Enter')
    pg.fill('input[data-f=dest]', 'میدان')
    pg.locator('input[data-f=dest] ~ .suggest button').first.wait_for(timeout=10000)
    pg.press('input[data-f=dest]', 'Enter')
    pg.wait_for_function(f"{T % 0}.querySelector('.trip-result .big')")
    check('search + coordinates give a route; row shows time and distance', 'دقیقه' in js(f"{T % 0}.querySelector('.row-sub').textContent"),
          js(f"{T % 0}.querySelector('.row-sub').textContent"))
    check('route and two pins drawn', len(js("__routes.nm.lines")) >= 1 and len(js("__routes.nm.pins")) == 2)

    # mode buttons
    before = js(f"{T % 0}.querySelector('.big').textContent")
    pg.click('.mode[data-mode=PEDESTRIAN]')
    pg.wait_for_function(f"{T % 0}.querySelector('.big') && {T % 0}.querySelector('.big').textContent !== {before!r}")
    check('mode buttons switch and re-route', js("__routes.state.trips[0].mode") == 'PEDESTRIAN')
    pg.click('.mode[data-mode=PUBLIC_TRANSPORTATION]')
    pg.wait_for_function(f"!!{T % 0}.querySelector('ol.transit')")
    res = js(f"{T % 0}.querySelector('.trip-result').innerText")
    check('public transport: estimated time, fare and steps', 'حدود' in res and 'کرایه' in res and 'BRT1' in res and 'ایستگاه' in res, res.replace('\n', ' ')[:160])
    check('public transport drawn as walking (dotted) and riding parts', any(l.get('dash') == 'dot' for l in js("__routes.nm.lines")))
    pg.click('.mode[data-mode=CAR]')
    pg.wait_for_function(f"{T % 0}.querySelector('.big') && {T % 0}.querySelector('.big').textContent === {before!r}")

    # 24-hour departure time under "more"
    pg.click('details.more > summary')
    pg.select_option('select[data-f=dep-h]', '17')
    pg.select_option('select[data-f=dep-m]', '30')
    check('24-hour departure picker', js("__routes.state.trips[0].depart") == '17:30' and 'رسیدن ۱۷:' in js(f"{T % 0}.querySelector('.row-sub').textContent"),
          js(f"{T % 0}.querySelector('.row-sub').textContent"))
    check('hour list has 24 entries, no AM/PM', js("__routes.root.querySelectorAll('select[data-f=dep-h] option').length") == 25)
    if js(f"{T % 0}.querySelectorAll('.alt').length") > 1:
        pg.locator('.alt').nth(1).click()
        check('Neshan alternative routes selectable', js("__routes.state.trips[0].alt") == 1)
        pg.locator('.alt').nth(0).click()
    shot('2-route-open')

    # two more people; only one editor open at a time
    js("""() => { const P = [['سارا', {lat: 35.6997, lng: 51.3380}, {lat: 35.7730, lng: 51.4710}], ['رضا', {lat: 35.7006, lng: 51.3913}, {lat: 35.8048, lng: 51.4337}]];
      for (const [n, o, d] of P) { __routes.root.getElementById('addTripBtn').click(); const t = __routes.state.trips.at(-1); t.name = n; __routes.setPoint(t.id, 'origin', o); __routes.setPoint(t.id, 'dest', d); } }""")
    pg.wait_for_function("__routes.state.trips.length === 3 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')")
    check('only the newest route is open', js("[...__routes.root.querySelectorAll('.trip.open')].length") == 1 and js(f"{T % 2}.classList.contains('open')"))
    pg.locator('.trip-row').nth(0).click()
    check('clicking another row switches the open editor', js(f"{T % 0}.classList.contains('open') && !{T % 2}.classList.contains('open')"))
    pg.locator('.trip-row').nth(0).click()
    check('clicking the open row folds it', js("__routes.root.querySelectorAll('.trip.open').length") == 0)
    n_lines = len(js("__routes.nm.lines"))
    pg.locator('.trip-row button[data-f=hide]').nth(1).click()
    check('👁 hides a route from the map without opening it', len(js("__routes.nm.lines")) < n_lines and js("__routes.root.querySelectorAll('.trip.open').length") == 0)
    pg.locator('.trip-row button[data-f=hide]').nth(1).click()
    shot('3-list')

    # Esc cancels picking a point (keys inside the panel are kept away from Neshan)
    pg.locator('.trip-row').nth(2).click()
    pg.locator('.trip.open .pick-btn[data-which=dest]').click()
    check('pick mode shows its hint', js("!__routes.nm.root.querySelector('.toast').hidden"))
    pg.keyboard.press('Escape')
    check('Esc cancels picking', js("__routes.nm.root.querySelector('.toast').hidden && !__routes.root.querySelector('.pick-btn.active')"))
    pg.locator('.trip.open .trip-row').click()

    # compare
    pg.click('.tab[data-tab=compare]')
    check('compare table lists 3 routes', js("__routes.root.querySelectorAll('#compareBody table.cmp:not(.matrix) tbody tr').length") == 3)
    pg.click('#compareBody label:has(input[value=distance])')
    check('bars switch between time and distance', 'کیلومتر' in js("__routes.root.querySelector('.bars').textContent"))
    shot('4-compare')

    # meeting
    pg.click('.tab[data-tab=meet]')
    check('everyone ready is selected by default', js("__routes.root.querySelectorAll('.chip.on').length") == 3)
    pg.locator('.chip').nth(0).click(); pg.locator('.chip').nth(1).click()
    check('fewer than two people: button disabled with a hint',
          js("__routes.root.getElementById('meetBtn').disabled && !__routes.root.getElementById('meetHint').hidden"))
    pg.locator('.chip').nth(0).click(); pg.locator('.chip').nth(1).click()
    check('settings are folded with a one-line summary', not js("__routes.root.getElementById('meetSettings').open")
          and 'معمولی' in js("__routes.root.getElementById('meetSummary').textContent"))
    shot('5-meet-before')
    t0 = time.time()
    pg.click('#meetBtn')
    pg.wait_for_function("__routes.root.querySelectorAll('#meetResult .person').length === 3", timeout=60000)
    m = js("__routes.state.meeting")
    check('meeting point found', True, f"{time.time() - t0:.1f}s, {m['calls']} requests")
    check('one line per person, details folded', js("__routes.root.querySelectorAll('details.person[open]').length") == 0)
    pg.locator('details.person summary').first.click()
    check('a person line opens to show legs and Neshan links', js("__routes.root.querySelector('details.person[open] .person-links a') !== null"))
    if js("__routes.root.querySelectorAll('.options button').length") > 1:
        pg.locator('.options button').nth(1).click()
        check('other suggested spots selectable', js("__routes.state.meeting.show") == 1)
        pg.locator('.options button').nth(0).click()
    shot('6-meet-result')

    # one person by public transport: the meeting search works with estimated times too
    pg.click('.tab[data-tab=trips]')
    js("(() => { const t = __routes.state.trips[1]; t.mode = 'PUBLIC_TRANSPORTATION'; __routes.routeTrip(t); return true; })()")
    pg.wait_for_function("__routes.runtime(__routes.state.trips[1].id).status === 'ok' && !!__routes.runtime(__routes.state.trips[1].id).alts[0].transit")
    pg.click('.tab[data-tab=meet]')
    pg.wait_for_function("!__routes.root.getElementById('meetBtn').disabled")
    pg.click('#meetBtn')
    pg.wait_for_function("__routes.state.meeting && !__routes.state.meeting.stale && __routes.root.querySelectorAll('#meetResult .person').length === 3", timeout=60000)
    check('meeting with one person on public transport', len(js("__routes.state.meeting.options[0].per[1].legA.coords")) > 1)

    js("__setDark(true)")
    check('panel follows the night map', js("__routes.root.host.classList.contains('dark')"))
    shot('7-meet-dark')
    js("__setDark(false)")

    if RATELIMIT:
        pg.goto((work / 'index.html').as_uri() + '?ratelimit')
        pg.wait_for_function("!!window.__routes && !__routes.root.getElementById('panel').hidden", timeout=15000)
        js("""() => { const P = [[{lat: 35.7572, lng: 51.4099}, {lat: 35.7414, lng: 51.5010}], [{lat: 35.6997, lng: 51.3380}, {lat: 35.7730, lng: 51.4710}], [{lat: 35.7006, lng: 51.3913}, {lat: 35.8048, lng: 51.4337}]];
          for (const [o, d] of P) { __routes.root.getElementById('addTripBtn').click(); const t = __routes.state.trips.at(-1); __routes.setPoint(t.id, 'origin', o); __routes.setPoint(t.id, 'dest', d); } }""")
        pg.wait_for_function("__routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", timeout=120000)
        pg.click('.tab[data-tab=meet]')
        t0 = time.time()
        pg.click('#meetBtn')
        saw_pause = False
        while not js("__routes.root.querySelectorAll('#meetResult .person').length"):
            saw_pause |= 'صبر' in (js("__routes.root.querySelector('#meetProgress .ptext').textContent") or '')
            if time.time() - t0 > 300: break
            time.sleep(0.5)
        m = js("__routes.state.meeting")
        check('under a rate limit the search waits and still finishes', bool(m) and not m.get('partial'),
              f"{time.time() - t0:.0f}s, {m and m['calls']} requests, limited {js('__fakeStats.limited || 0')}x, pause shown: {saw_pause}")

    # grouping by origin / destination (homes -> daily places, origins a few dozen metres apart)
    pg.goto((work / 'index.html').as_uri())
    pg.wait_for_function("!!window.__routes && !__routes.root.getElementById('panel').hidden", timeout=15000)
    js("""() => {
      const H = { 'یوسف‌آباد': [35.7290, 51.4040], 'پاسداران': [35.7730, 51.4710], 'نارمک': [35.7414, 51.5010] };
      const D = { 'ونک': [35.7572, 51.4099], 'انقلاب': [35.7006, 51.3913] };
      let k = 0;
      for (const [h, [hl, hg]] of Object.entries(H)) for (const [d, [dl, dg]] of Object.entries(D)) {
        __routes.root.getElementById('addTripBtn').click();
        const t = __routes.state.trips.at(-1); t.name = `${h} به ${d}`; t.mode = 'PEDESTRIAN';
        const j = (k++ % 3) * 0.0002;  // ~20 m apart: the same place picked twice
        __routes.setPoint(t.id, 'origin', { lat: hl + j, lng: hg }, `${h}، تهران`);
        __routes.setPoint(t.id, 'dest', { lat: dl, lng: dg }, `${d}، تهران`);
      } }""")
    pg.wait_for_function("__routes.state.trips.length === 6 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", timeout=30000)
    before = js("JSON.stringify(__routes.state.trips.map(t => [t.name, t.origin, t.dest, t.mode]))")
    pg.click('.tab[data-tab=compare]')
    pg.click('#compareBody label:has(input[value=origin])')
    heads = js("[...__routes.root.querySelectorAll('.group-head b')].map(b => b.textContent)")
    check('group by origin: one card per place', heads == ['از یوسف‌آباد', 'از پاسداران', 'از نارمک'], str(heads))
    check('each card lists its 2 destinations, fastest first',
          js("[...__routes.root.querySelectorAll('.card.group')].every(c => c.querySelectorAll('.g-row').length === 2)"))
    shot('8-grouped-origin')
    pg.click('#compareBody label:has(input[value=dest])')
    check('group by destination', js("[...__routes.root.querySelectorAll('.group-head b')].map(b => b.textContent)") == ['به ونک', 'به انقلاب'])
    pg.locator('[data-only]').first.click()
    check('"only these on the map" hides the other routes', js("__routes.state.trips.filter(t => t.hidden).length") == 3)
    pg.click('[data-act=show-all]')
    check('"show all" brings them back', js("__routes.state.trips.filter(t => t.hidden).length") == 0)
    pg.click('#compareBody label:has(input[value=none])')
    check('back to the plain table', js("__routes.root.querySelectorAll('#compareBody table.cmp:not(.matrix) tbody tr').length") == 6)
    check('6+ routes: shared road shown as a list of pairs, not a wide table', js("__routes.root.querySelectorAll('table.matrix').length") == 0)
    check('routes untouched by grouping', js("JSON.stringify(__routes.state.trips.map(t => [t.name, t.origin, t.dest, t.mode]))") == before)

    check('no page errors', not errors, '; '.join(errors[:3]))
    ctx.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
