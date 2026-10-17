"""Google Maps check in a real Firefox profile (signed in, real cookies), driven like a user.

    node build.mjs
    python -I tests/e2e/google_profile.py <firefox profile dir> <screenshot dir> [--headful]

Clean test profiles are signed out, and a signed-in Google session behaves differently
(v1.2.0 got 400 for every route there). Point this at a copy of a real profile: cookies.sqlite
(+ -wal/-shm) and prefs.js are enough. Uses roughly 50 Google requests; run it before releases.
"""
import sys, time
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
from selenium import webdriver
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options

ROOT = Path(__file__).resolve().parents[2]
PROFILE, SHOTS = sys.argv[1], Path(sys.argv[2]); SHOTS.mkdir(parents=True, exist_ok=True)
VERSION = __import__('json').loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
results = []
def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

o = Options()
if '--headful' not in sys.argv: o.add_argument('-headless')
o.add_argument('-profile'); o.add_argument(PROFILE)
d = webdriver.Firefox(options=o); d.set_window_size(1440, 960)
js = lambda e, *a: d.execute_script('return ' + e, *a)
el = lambda sel: js(f"__routes.root.querySelector({sel!r})")  # panel lives in a shadow root
T0 = "__routes.root.querySelectorAll('.trip')[0]"

def wait(expr, timeout=60, what=''):
    end = time.time() + timeout
    while True:
        try:
            if js(expr): return
        except Exception:
            pass
        if time.time() > end: raise TimeoutError(what or expr)
        time.sleep(0.3)

def errors_shown():
    return js("[...__routes.root.querySelectorAll('.err, .error, .trip-result')].map(e => e.textContent).filter(t => /خطا|\\(4\\d\\d\\)/.test(t)).join(' | ')")

try:
    d.install_addon(str(ROOT / 'dist' / f'neshan-routes-firefox-{VERSION}.zip'), temporary=True)
    d.get('https://www.google.com/maps/@35.7400,51.4000,13z?hl=fa')
    wait("!!window.__routes && !!__routes.root.getElementById('tripList')", 60, 'panel on google.com/maps')
    time.sleep(3)
    signed_in = js("!!document.querySelector('a[href*=\"SignOutOptions\"], a[aria-label*=\"Google Account\"], a[aria-label*=\"حساب Google\"]')")
    check('profile is signed in to Google (the case clean profiles miss)', signed_in)
    check('panel is open', not js("__routes.root.getElementById('panel').hidden"))
    if js("__routes.state.trips.length"):  # routes left by an earlier run in this profile
        js("(() => { window.confirm = () => true; __routes.root.querySelector('[data-act=clear]').click(); return 1; })()")
    check('texts name Google, not Neshan', 'گوگل' in js("__routes.root.getElementById('linkInput').placeholder")
          and 'نشان ' not in js("__routes.root.getElementById('panel').innerText"), js("__routes.root.getElementById('linkInput').placeholder"))

    # first route by typing, the way a user does
    el('#addTripBtn').click()
    check('new route: name field focused', js("__routes.root.activeElement?.dataset.f") == 'name')
    el('input[data-f=name]').send_keys('علی')
    origin = el('input[data-f=origin]')
    origin.send_keys('میدان ونک')
    wait("!!__routes.root.querySelector('input[data-f=origin] ~ .suggest button')", 20, 'Google search suggestions')
    check('Google place search answers', True, js("__routes.root.querySelector('input[data-f=origin] ~ .suggest button').textContent"))
    origin.send_keys(Keys.ENTER)
    dest = el('input[data-f=dest]')
    for ch in '35.7006, 51.3913':  # key by key: Google's shortcuts used to steal «.» and digits
        dest.send_keys(ch); time.sleep(0.05)
    time.sleep(0.8)
    check('typed coordinates stay in the field (keys kept from Google)', js("arguments[0].value", dest) == '35.7006, 51.3913'
          and js("document.activeElement.id") == 'neshan-routes-ext', js("arguments[0].value", dest))
    pin = js("""(() => { const i = __routes.root.querySelector('input[data-f=dest]'), b = i.parentElement.querySelector('.pick-btn');
        const rb = b.getBoundingClientRect(), ri = i.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(i).paddingLeft); return { textLeft: ri.left + pad, btnRight: rb.right, dir: getComputedStyle(i).direction }; })()""")
    check('📍 does not cover typed coordinates', pin['textLeft'] >= pin['btnRight'], pin)
    js("arguments[0].scrollIntoView({block: 'center'})", dest)
    d.save_screenshot(str(SHOTS / 'profile-1-coords.png'))
    dest.send_keys(Keys.ENTER)
    wait(f"__routes.runtime(__routes.state.trips[0].id).status !== 'loading' && !!{T0}.querySelector('.row-sub')", 60, 'first route')
    wait(f"['ok', 'error'].includes(__routes.runtime(__routes.state.trips[0].id).status)", 60, 'route result')
    sub = js(f"{T0}.querySelector('.row-sub').textContent")
    check('car route from Google (signed in)', js("__routes.runtime(__routes.state.trips[0].id).status") == 'ok' and 'دقیقه' in sub, sub or errors_shown())
    check('route drawn on the map', js("__routes.nm.root.querySelectorAll('svg path').length") >= 2)
    time.sleep(2)
    check('end point named from Google', not js("/^\\d/.test(__routes.state.trips[0].dest.label)"), js("__routes.state.trips[0].dest.label"))
    d.save_screenshot(str(SHOTS / 'profile-2-route.png'))

    before = js(f"{T0}.querySelector('.big').textContent")
    js("__routes.root.querySelector('.mode[data-mode=PEDESTRIAN]').click()")
    wait(f"!!{T0}.querySelector('.big') && {T0}.querySelector('.big').textContent !== {before!r} || __routes.runtime(__routes.state.trips[0].id).status === 'error'", 40, 'walking route')
    check('walking route', js("__routes.runtime(__routes.state.trips[0].id).status") == 'ok', js(f"{T0}.querySelector('.big')?.textContent") or errors_shown())
    js("__routes.root.querySelector('.mode[data-mode=CAR]').click()")
    wait(f"__routes.runtime(__routes.state.trips[0].id).status === 'ok'", 40, 'back to car')

    # second person and a meeting search
    js("""(() => { __routes.root.getElementById('addTripBtn').click(); const t = __routes.state.trips.at(-1); t.name = 'سارا';
        __routes.setPoint(t.id, 'origin', {lat: 35.6997, lng: 51.3380}, 'میدان آزادی'); __routes.setPoint(t.id, 'dest', {lat: 35.8048, lng: 51.4337}, 'تجریش'); return 1; })()""")
    wait("__routes.state.trips.every(t => __routes.runtime(t.id).status === 'ok')", 60, 'second route')
    check('second route', True, js("__routes.root.querySelectorAll('.row-sub')[1].textContent"))
    js("__routes.switchTab('meet')")
    js("__routes.root.querySelector('input[name=precision][value=fast]').click()")
    t0 = time.time()
    js("__routes.root.getElementById('meetBtn').click()")
    wait("__routes.root.querySelectorAll('#meetResult .person').length === 2 || /خطا/.test(__routes.root.getElementById('meetResult').textContent)", 240, 'meeting result')
    m = js("__routes.state.meeting")
    check('meeting point found on Google', bool(m) and not m.get('partial'), f"{time.time() - t0:.0f}s, {m and m['calls']} requests")
    try: wait("!!__routes.state.meeting.options[0].address", 20)
    except TimeoutError: pass
    check('meeting point named', js("__routes.state.meeting.options[0].address"), "→ " + js("__routes.root.getElementById('meetResult').innerText").replace('\n', ' ')[:120])
    d.save_screenshot(str(SHOTS / 'profile-3-meet.png'))
    check('no Google error anywhere in the panel', not errors_shown(), errors_shown())
finally:
    d.quit()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
