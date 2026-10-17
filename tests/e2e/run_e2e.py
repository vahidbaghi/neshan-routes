"""Browser end-to-end tests: the extension's panel on neshan.org/maps, Chrome and Firefox.

    node build.mjs --test
    python -I tests/e2e/run_e2e.py chrome  fake  <screenshot dir>
    python -I tests/e2e/run_e2e.py firefox fake  <screenshot dir>
    python -I tests/e2e/run_e2e.py chrome  live  <screenshot dir>   # real Neshan API, few requests

fake: Neshan's routing/search/address API is replaced inside the page by the fake bundled
      into dist-test (same wire formats), switched on with localStorage 'nr-fake' = '1'.
      The map, its tiles and the page are the real neshan.org.
live: same scenario with the real API (smaller meeting search).

Chrome: installed Chrome + Playwright, unpacked build loaded through DevTools
        (Extensions.loadUnpacked). Firefox: installed Firefox + Selenium, temporary add-on.
"""
import json, sys, tempfile, time
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

BROWSER, MODE = sys.argv[1], sys.argv[2]
SHOTS = Path(sys.argv[3]); SHOTS.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / 'dist-test' / BROWSER
START = 'https://neshan.org/maps/@35.7200,51.4000,12z'
USER_LINK = 'https://neshan.org/maps/routing/pedestrian/origin/35.703600,51.396600/destination/35.710118,51.401749#c35.707-51.399-15z-0p'

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + f'[{BROWSER}/{MODE}] ' + name + (f' — {detail}' if detail else ''), flush=True)

R = '__routes.root'
TRIP = R + ".querySelectorAll('.trip')[%d]"
PINS = '__routes.nm.root'
OPEN = R + ".querySelectorAll('.trip')[%d].querySelector('.trip-row')"

# ---------------------------------------------------------------- adapters

class Chrome:
    def __init__(self):
        from playwright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        self.ctx = self.pw.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='nr-chrome-'), channel='chrome', headless=True,
            args=['--enable-unsafe-extension-debugging'], ignore_default_args=['--disable-extensions'],
            viewport={'width': 1400, 'height': 900}, locale='fa-IR')
        self.ctx.browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(BUILD)})
        self.page = self.ctx.new_page()
        self.page.goto(START, wait_until='domcontentloaded')

    def js(self, expr): return self.page.evaluate(expr)
    def el(self, expr): return self.page.evaluate_handle(expr).as_element()
    def click(self, expr): self.el(expr).click()
    def fill(self, expr, text): self.el(expr).fill(text)
    def press(self, expr, key): self.el(expr).press(key)
    def select(self, expr, value): self.el(expr).select_option(value)
    def map_click(self, fx, fy):
        b = self.page.locator('#map').bounding_box()
        self.page.mouse.click(b['x'] + b['width'] * fx, b['y'] + b['height'] * fy)
    def drag(self, expr, dx, dy):
        b = self.el(expr).bounding_box()
        x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        self.page.mouse.move(x, y); self.page.mouse.down()
        for i in range(1, 11): self.page.mouse.move(x + dx * i / 10, y + dy * i / 10)
        self.page.mouse.up()
    def set_file(self, expr, path): self.el(expr).set_input_files(path)
    def shot(self, name): self.page.screenshot(path=str(SHOTS / f'{BROWSER}-{MODE}-{name}.png'))
    def reload(self): self.page.reload(wait_until='domcontentloaded')
    def quit(self): self.ctx.close(); self.pw.stop()


class Firefox:
    def __init__(self):
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
        o = Options(); o.add_argument('-headless')
        o.set_preference('intl.accept_languages', 'fa-IR, fa')
        self.d = webdriver.Firefox(options=o)
        self.d.set_window_size(1400, 1000)
        self.d.install_addon(str(BUILD), temporary=True)
        self.d.get(START)

    def js(self, expr):
        r = self.d.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            "Promise.resolve().then(() => (" + expr + ")).then(v => done({ok: v === undefined ? null : v}), e => done({err: String(e && e.stack || e)}));")
        if 'err' in r: raise RuntimeError(r['err'])
        return r['ok']
    def el(self, expr): return self.d.execute_script('return ' + expr)
    def click(self, expr):
        e = self.el(expr)
        self.d.execute_script("arguments[0].scrollIntoView({block: 'center'})", e)
        e.click()
    def fill(self, expr, text):
        e = self.el(expr); e.clear(); e.send_keys(text)
    def press(self, expr, key):
        from selenium.webdriver.common.keys import Keys
        self.el(expr).send_keys({'Enter': Keys.ENTER, 'Escape': Keys.ESCAPE}[key])
    def select(self, expr, value):
        from selenium.webdriver.support.ui import Select
        Select(self.el(expr)).select_by_value(value)
    def map_click(self, fx, fy):
        from selenium.webdriver.common.action_chains import ActionChains
        m = self.d.find_element('css selector', '#map')
        w, h = m.size['width'], m.size['height']
        ActionChains(self.d).move_to_element_with_offset(m, int(w * (fx - 0.5)), int(h * (fy - 0.5))).click().perform()
    def drag(self, expr, dx, dy):
        from selenium.webdriver.common.action_chains import ActionChains
        a = ActionChains(self.d).click_and_hold(self.el(expr))
        for _ in range(10): a.move_by_offset(dx // 10, dy // 10)
        a.release().perform()
    def set_file(self, expr, path):
        e = self.el(expr)
        self.d.execute_script("arguments[0].hidden = false", e)
        e.send_keys(path)
        self.d.execute_script("arguments[0].hidden = true", e)
    def shot(self, name): self.d.save_screenshot(str(SHOTS / f'{BROWSER}-{MODE}-{name}.png'))
    def reload(self): self.d.refresh()
    def quit(self): self.d.quit()


def wait(b, expr, timeout=30, what=''):
    end = time.time() + timeout
    last = None
    while True:
        try:
            if b.js(expr): return True
        except Exception as e:
            last = e
        if time.time() > end:
            raise TimeoutError(f'{what or expr} ({last})')
        time.sleep(0.25)

def collect_errors(b):
    # only errors coming from the extension's own script (neshan.org has its own noise)
    b.js("""(() => { window.__nrErrs = [];
      addEventListener('error', e => { if (/inpage|neshan-routes/.test(String(e.filename) + String(e.error && e.error.stack))) __nrErrs.push(String(e.message)); });
      addEventListener('unhandledrejection', e => { const s = String(e.reason && e.reason.stack || ''); if (/inpage/.test(s)) __nrErrs.push(String(e.reason && e.reason.message || e.reason)); });
      return true; })()""")

def wait_mounted(b):
    wait(b, "!!window.__routes && !!__routes.root.getElementById('tripList')", 60, 'panel mounted on neshan.org')

# ---------------------------------------------------------------- scenario

b = Chrome() if BROWSER == 'chrome' else Firefox()
try:
    wait_mounted(b)
    check('panel mounts on neshan.org and attaches to Neshan\'s map', b.js("!!__routes.nm.m.getLayer('nr-solid')"))
    if MODE == 'fake':
        b.js("(localStorage.setItem('nr-fake', '1'), true)")
        b.reload()
        wait_mounted(b)
        if not b.js("!!window.__fakeStats"):
            raise RuntimeError('fake Neshan API not active (build with: node build.mjs --test)')
    collect_errors(b)
    check('panel is open with an empty list', b.js(f"!{R}.getElementById('panel').hidden && !!{R}.querySelector('#tripList .empty-state')"))

    # open / close
    b.click(f"{R}.getElementById('closeBtn')")
    check('close button folds the panel into a launcher', b.js(f"{R}.getElementById('panel').hidden && !{R}.getElementById('launcher').hidden"))
    b.click(f"{R}.getElementById('launcher')")
    check('launcher reopens it', b.js(f"!{R}.getElementById('panel').hidden"))
    b.js("(window.postMessage({__nr: 'toggle'}, location.origin), true)")
    wait(b, f"{R}.getElementById('panel').hidden", 5, 'toolbar toggle closes')
    b.js("(window.postMessage({__nr: 'toggle'}, location.origin), true)")
    wait(b, f"!{R}.getElementById('panel').hidden", 5, 'toolbar toggle opens')
    check('toolbar-button toggle message works', True)

    # 1) the user's own neshan link
    b.fill(f"{R}.getElementById('linkInput')", USER_LINK)
    b.click(f"{R}.querySelector('#linkForm button[type=submit]')")
    wait(b, f"{TRIP % 0} && {TRIP % 0}.querySelector('.trip-result .big')", 40, 'trip 1 route')
    check('trip from a neshan link is routed', True, b.js(f"{TRIP % 0}.querySelector('.trip-result').innerText.replace(/\\n/g, ' ')"))
    check('link mode = pedestrian', b.js(f"{TRIP % 0}.querySelector('.mode.sel').dataset.mode") == 'PEDESTRIAN')
    check('route drawn on Neshan\'s map', b.js("__routes.nm.m.getSource('nr-lines')._data.features.length") >= 2)
    wait(b, f"(v => v && !/^\\d/.test(v))({TRIP % 0}.querySelector('input[data-f=origin]').value)", 20, 'reverse geocode')
    check('origin label reverse-geocoded', True, b.js(f"{TRIP % 0}.querySelector('input[data-f=origin]').value"))
    if b.js(f"{TRIP % 0}.querySelectorAll('.alt').length") > 1:
        b.click(f"{TRIP % 0}.querySelectorAll('.alt')[1]")
        check('alternative route selectable', b.js(f"{TRIP % 0}.querySelectorAll('.alt')[1].classList.contains('sel')"))
        b.click(f"{TRIP % 0}.querySelectorAll('.alt')[0]")

    # 2) search box and typed coordinates
    b.click(f"{R}.getElementById('addTripBtn')")
    b.fill(f"{TRIP % 1}.querySelector('input[data-f=name]')", 'سارا')
    b.fill(f"{TRIP % 1}.querySelector('input[data-f=origin]')", 'میدان انقلاب')
    wait(b, f"(x => x && !x.hidden && x.querySelector('button'))({TRIP % 1}.querySelector('input[data-f=origin] ~ .suggest'))", 25, 'search suggestions')
    sugg = b.js(f"{TRIP % 1}.querySelector('input[data-f=origin] ~ .suggest button').innerText")
    b.press(f"{TRIP % 1}.querySelector('input[data-f=origin]')", 'Enter')
    b.fill(f"{TRIP % 1}.querySelector('input[data-f=dest]')", '35.7572, 51.4099')
    wait(b, f"(x => x && !x.hidden && x.querySelector('button'))({TRIP % 1}.querySelector('input[data-f=dest] ~ .suggest'))", 10, 'coordinate suggestion')
    b.press(f"{TRIP % 1}.querySelector('input[data-f=dest]')", 'Enter')
    wait(b, f"{TRIP % 1}.querySelector('.trip-result .big')", 40, 'trip 2 route')
    check('search + typed coordinates give a route', True, f'first suggestion {sugg!r}')

    # 3) picking points on Neshan's map (the click must not reach Neshan's own handlers)
    b.click(f"{R}.getElementById('addTripBtn')")
    b.fill(f"{TRIP % 2}.querySelector('input[data-f=name]')", 'رضا')
    b.js("(__routes.nm.m.jumpTo({center: [51.40, 35.72], zoom: 13}), true)")
    time.sleep(0.8)
    url_before = b.js("location.href")
    b.click(f"{TRIP % 2}.querySelector('.pick-btn[data-which=origin]')")
    check('pick mode shows a hint on the map', b.js(f"!{PINS}.querySelector('.toast').hidden"))
    b.map_click(0.45, 0.78)
    b.click(f"{TRIP % 2}.querySelector('.pick-btn[data-which=dest]')")
    b.map_click(0.62, 0.42)
    wait(b, f"{TRIP % 2}.querySelector('.trip-result .big')", 40, 'trip 3 route')
    check('points picked on the map give a route', True, b.js(f"{TRIP % 2}.querySelector('.trip-result').innerText.replace(/\\n/g, ' ')"))
    check('picking did not trigger Neshan\'s own place panel', b.js("location.href") == url_before or '/routing/' not in b.js("location.href"), b.js("location.href"))
    check('6 numbered pins on the map', b.js(f"{PINS}.querySelectorAll('.pin').length") == 6)

    # drag an origin pin: the route follows
    before = b.js("JSON.stringify(__routes.state.trips[2].origin)")
    b.drag(f"{PINS}.querySelectorAll('.pin-wrap')[4]", 60, -40)
    wait(b, f"JSON.stringify(__routes.state.trips[2].origin) !== {json.dumps(before)}", 10, 'pin drag')
    wait(b, f"{TRIP % 2}.querySelector('.trip-result .big')", 40)
    check('dragging a pin moves the point and re-routes', True)

    if MODE == 'fake':
        b.click(OPEN % 1)
        check('clicking a row opens only that route', b.js(f"{TRIP % 1}.classList.contains('open') && !{TRIP % 2}.classList.contains('open')"))
        prev = b.js(f"{TRIP % 1}.querySelector('.big').innerText")
        b.click(f"{TRIP % 1}.querySelector('.mode[data-mode=PEDESTRIAN]')")
        wait(b, f"{TRIP % 1}.querySelector('.big') && {TRIP % 1}.querySelector('.big').innerText !== {json.dumps(prev)}", 20, 'reroute after mode change')
        after = b.js(f"{TRIP % 1}.querySelector('.big').innerText")
        check('mode change re-routes', True, f'{prev} -> {after}')
        b.click(f"{TRIP % 1}.querySelector('.mode[data-mode=CAR]')")
        o, d = b.js(f"[{TRIP % 1}.querySelector('input[data-f=origin]').value, {TRIP % 1}.querySelector('input[data-f=dest]').value]")
        b.click(f"{TRIP % 1}.querySelector('button[data-f=swap]')")
        o2, d2 = b.js(f"[{TRIP % 1}.querySelector('input[data-f=origin]').value, {TRIP % 1}.querySelector('input[data-f=dest]').value]")
        check('swap exchanges origin and destination', (o2, d2) == (d, o))
        b.click(f"{TRIP % 1}.querySelector('button[data-f=swap]')")
        wait(b, f"{TRIP % 1}.querySelector('.trip-result .big')", 20)
        n_lines = b.js("__routes.nm.lines.length")
        b.click(f"{TRIP % 1}.querySelector('button[data-f=hide]')")
        check('hiding a route removes it from the map', b.js("__routes.nm.lines.length") < n_lines and b.js(f"{PINS}.querySelectorAll('.pin').length") == 4)
        b.click(f"{TRIP % 1}.querySelector('button[data-f=hide]')")
        b.click(f"{TRIP % 1}.querySelector('button[data-f=dup]')")
        wait(b, f"{R}.querySelectorAll('.trip').length === 4", 5)
        b.click(f"{TRIP % 2}.querySelector('button[data-f=del]')")
        check('duplicate and delete', b.js(f"{R}.querySelectorAll('.trip').length") == 3 and b.js(f"{TRIP % 2}.querySelector('input[data-f=name]').value") == 'رضا')
    b.shot('1-trips')

    # 4) "the route open in Neshan" button
    b.js("(history.pushState({}, '', '/maps/routing/car/origin/35.699700,51.338000/destination/35.757200,51.409900'), true)")
    wait(b, f"!{R}.getElementById('fromNeshan').hidden", 5, 'from-neshan banner')
    b.click(f"{R}.getElementById('fromNeshanBtn')")
    wait(b, "__routes.state.trips.length === 4 && __routes.runtime(__routes.state.trips[3].id).status === 'ok'", 40, 'route from Neshan URL')
    check('route currently open in Neshan can be added with one click', True)
    b.js("(history.pushState({}, '', '/maps/@35.7200,51.4000,12z'), true)")
    wait(b, f"{R}.getElementById('fromNeshan').hidden", 5, 'banner hides')
    b.click(f"{TRIP % 3}.querySelector('button[data-f=del]')")

    # 5) compare tab
    b.click(f"{R}.querySelector('.tab[data-tab=compare]')")
    wait(b, f"{R}.querySelectorAll('#compareBody table.cmp')[0]?.querySelectorAll('tbody tr').length === 3", 10, 'compare table')
    check('compare table has 3 rows', True)
    check('shared-route matrix shown', b.js(f"{R}.querySelectorAll('table.matrix').length") == 1)
    b.shot('2-compare')

    # 6) meeting point: three people from different workplaces going home
    people = 3 if MODE == 'fake' else 2
    b.js("""(() => {
      const s = __routes.state;
      const P = [[{lat: 35.7572, lng: 51.4099}, {lat: 35.7414, lng: 51.5010}, '17:00'],
                 [{lat: 35.6997, lng: 51.3380}, {lat: 35.7730, lng: 51.4710}, '17:00'],
                 [{lat: 35.7006, lng: 51.3913}, {lat: 35.8048, lng: 51.4337}, '17:10']];
      P.forEach(([o, d, dep], i) => { const t = s.trips[i]; t.mode = 'CAR'; t.depart = dep;
        __routes.setPoint(t.id, 'origin', o); __routes.setPoint(t.id, 'dest', d); });
      if (%d === 2) s.trips[2].inMeeting = false;
      return true; })()""" % people)
    wait(b, "__routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 60, 'routes for meeting')
    b.click(f"{R}.querySelector('.tab[data-tab=meet]')")
    b.js(f"({R}.querySelector('input[name=precision][value=fast]').click(), true)")
    t0 = time.time()
    b.click(f"{R}.getElementById('meetBtn')")
    try:
        wait(b, f"{R}.querySelectorAll('#meetResult .person').length > 0", 150, 'meeting result')
    except TimeoutError:
        print('DIAG', b.js(f"{PINS}.querySelector('.toast').innerText + ' | ' + {R}.getElementById('meetProgress').innerText"))
        raise
    m = b.js("__routes.state.meeting")
    best = m['options'][0]
    check(f'meeting point for {people} people', b.js(f"{R}.querySelectorAll('#meetResult .person').length") == people,
          f"{time.time() - t0:.0f}s, {m['calls']} routing requests, total extra {best['sum'] / 60:.1f} min, worst {best['max'] / 60:.1f} min")
    check('every leg has geometry', all(len(x['legA']['coords']) > 1 and len(x['legB']['coords']) > 1 for x in best['per']))
    check('detours are not negative (±60s)', all(x['detour'] > -60 for x in best['per']), str([round(x['detour']) for x in best['per']]))
    wait(b, f"!/^\\d/.test({R}.querySelector('.meet-addr').textContent)", 20, 'meeting address')
    check('meeting address shown', True, b.js(f"{R}.querySelector('.meet-addr').textContent"))
    check('arrival clock times shown (17:xx)', '۱۷:' in b.js(f"{R}.getElementById('meetResult').innerText"))
    check('meeting marker and legs on Neshan\'s map', b.js(f"{PINS}.querySelectorAll('.meet:not(.alt)').length") == 1
          and b.js("__routes.nm.lines.filter(l => l.dash === 'dot').length") == people)
    time.sleep(1.2)
    b.shot('3-meeting')

    b.drag(f"{PINS}.querySelector('.meet:not(.alt)')", 120, 60)
    wait(b, f"!!{R}.querySelector('button[data-opt=manual].on')", 40, 'manual evaluation')
    m2 = b.js("__routes.state.meeting")
    check('dragging 🤝 evaluates that spot', m2['manual'] is not None,
          f"dragged spot {m2['manual']['value'] / 60:.1f} min vs best {m2['options'][0]['value'] / 60:.1f} min")
    check('optimiser result is no worse than the dragged spot', m2['options'][0]['value'] <= m2['manual']['value'] + 30)
    b.click(f"{R}.querySelector('button[data-opt=\"0\"]')")

    # 7) Neshan's night map -> panel follows
    b.js("""(() => { const m = __routes.nm.m; const st = m.getStyle(); st.name = 'Neshan Dark Base Map'; m.setStyle(st); return true; })()""")
    wait(b, "__routes.root.host.classList.contains('dark')", 10, 'dark panel')
    wait(b, "!!__routes.nm.m.getLayer('nr-solid')", 10, 'layers re-added after style change')
    check('panel turns dark with Neshan\'s night map; routes survive the style change', True)
    time.sleep(1.2)
    b.shot('4-meeting-dark')
    b.js("""(() => { const m = __routes.nm.m; const st = m.getStyle(); st.name = 'Neshan Base Map'; m.setStyle(st); return true; })()""")
    wait(b, "!__routes.root.host.classList.contains('dark')", 10, 'light again')

    # 8) persistence + route reuse (no new routing requests after a reload)
    time.sleep(0.8)
    b.reload()
    wait_mounted(b)
    wait(b, f"{R}.querySelectorAll('.trip').length === 3 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 30, 'restore')
    check('trips persist after reload (extension storage)', True)
    check('names persist', b.js(f"{TRIP % 2}.querySelector('input[data-f=name]').value") == 'رضا')
    reqs = b.js("__routes.requestCount")
    check('reload reuses saved routes (no routing requests)', reqs == 0, f'{reqs} requests')
    collect_errors(b)
    b.click(f"{R}.querySelector('.tab[data-tab=meet]')")
    check('meeting result persists', b.js(f"{R}.querySelectorAll('#meetResult .person').length") == people)

    # 9) import (with invalid and hostile entries)
    data = {'app': 'neshan-routes', 'version': 1, 'trips': [
        {'name': 'وارد شده', 'mode': 'BIKE', 'origin': {'lat': 35.70, 'lng': 51.39}, 'dest': {'lat': 35.71, 'lng': 51.40}},
        {'name': '<img src=x onerror=alert(1)>', 'mode': 'CAR', 'origin': {'lat': 35.69, 'lng': 51.38}, 'dest': {'lat': 35.72, 'lng': 51.41}},
        {'name': 'bad', 'mode': 'PLANE', 'origin': {'lat': 1, 'lng': 1}, 'dest': {'lat': 2, 'lng': 2}}]}
    f = Path(tempfile.mkdtemp()) / 'in.json'; f.write_text(json.dumps(data), encoding='utf-8')
    b.click(f"{R}.querySelector('.tab[data-tab=trips]')")
    b.set_file(f"{R}.getElementById('importFile')", str(f))
    wait(b, "__routes.state.trips.length === 2 && __routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 40, 'import')
    check('import keeps valid trips, drops invalid ones', True)
    check('names are escaped (no injected <img>)', b.js(f"{R}.querySelectorAll('.trip img, #compareBody img').length") == 0)

    errs = b.js("window.__nrErrs || []")
    check('no errors from the extension script', not errs, '; '.join(errs[:5]))
    if MODE == 'fake':
        print('fake API requests after reload:', b.js("JSON.stringify(window.__fakeStats)"))
finally:
    b.quit()

failed = [r for r in results if not r[1]]
print(f'\n[{BROWSER}/{MODE}] {len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
