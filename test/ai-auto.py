"""Auto model selection must not need the user's help.

Model names change and differ between keys, so "auto" has to find out what the
key actually has. It used to guess from a hardcoded ladder and, when that 404'd,
tell the user to go and press Test connection — which is the app handing its own
problem to the person using it.

Run: python3 test/ai-auto.py
"""
import json
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT, PORT = '/home/user/def-rpt', 8797

app = subprocess.Popen(['python3', '-m', 'http.server', str(PORT)], cwd=f'{ROOT}/dist',
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

failures = []
def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + (f' — {detail}' if detail and not cond else ''))
    if not cond:
        failures.append(name)

# A key whose real models are named nothing like the built-in ladder.
REAL_MODELS = ['gemini-3-flash-latest', 'gemini-3-flash-lite-latest', 'gemini-3-pro-latest']

STUB = """(models) => {
  window.__calls = [];
  const real = window.fetch;
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('generativelanguage')) return real(url, init);
    window.__calls.push(u);
    if (u.includes(':generateContent')) {
      const name = /models\\/([^:]+):/.exec(u)[1];
      if (!models.includes(name)) {
        return new Response(JSON.stringify({ error: { message: `models/${name} is not found` } }),
          { status: 404 });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'UNFILLED GROUT' }] } }],
      }), { status: 200 });
    }
    // The model list.
    return new Response(JSON.stringify({
      models: models.map((m) => ({ name: 'models/' + m, supportedGenerationMethods: ['generateContent'] })),
    }), { status: 200 });
  };
}"""

CAPTION = """async () => {
  const assist = await import('/admin/js/assist.js');
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  c.getContext('2d').fillRect(0, 0, 64, 48);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
  try {
    const out = await assist.suggestCaption(blob, { sectionTitle: 'BATH 1' });
    return { ok: true, text: out.text, calls: window.__calls };
  } catch (err) {
    return { ok: false, error: err.message, calls: window.__calls };
  }
}"""

SETTINGS = """async (patch) => {
  const s = await import('/admin/js/store.js');
  const cur = await s.getSettings(true);
  await s.saveSettings({ ai: { ...cur.ai, ...patch } });
  return (await s.getSettings(true)).ai;
}"""

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        pg = b.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://localhost:{PORT}/admin/index.html')
        pg.wait_for_timeout(2000)
        pg.evaluate(STUB, REAL_MODELS)

        # A key entered but never tested: nothing is known about it yet.
        pg.evaluate(SETTINGS, {'key': 'test-key', 'enabled': True, 'auto': True, 'available': []})
        first = pg.evaluate(CAPTION)
        print('  never tested ->', json.dumps(first)[:180])
        check('a caption comes back without the user testing first', first['ok'], str(first.get('error')))
        check('it looked the models up by itself',
              any('models?' in c or c.endswith('/models') for c in first['calls']),
              str(first['calls']))
        check('it used a model the key really has',
              first['ok'] and any(m in c for c in first['calls'] for m in REAL_MODELS),
              str(first['calls']))

        saved = pg.evaluate(SETTINGS, {})
        check('what it found is remembered', sorted(saved['available']) == sorted(REAL_MODELS),
              str(saved['available']))

        # Second call: already known, so no second lookup.
        pg.evaluate("() => { window.__calls = []; }")
        again = pg.evaluate(CAPTION)
        check('a later caption does not look them up again',
              again['ok'] and not any(c.endswith('/models') or 'pageSize' in c for c in again['calls']),
              str(again['calls']))

        # A remembered list that has gone stale — models renamed under the key.
        pg.evaluate(SETTINGS, {'available': ['gemini-1.0-gone', 'gemini-1.0-also-gone']})
        pg.evaluate("() => { window.__calls = []; }")
        stale = pg.evaluate(CAPTION)
        print('  stale list ->', json.dumps(stale)[:180])
        check('a stale list is refreshed and the caption still works', stale['ok'], str(stale.get('error')))
        check('the refresh happened during the call',
              any('pageSize' in c for c in stale['calls']), str(stale['calls']))
        after = pg.evaluate(SETTINGS, {})
        check('the refreshed list replaces the stale one',
              sorted(after['available']) == sorted(REAL_MODELS), str(after['available']))

        # Nothing usable at all: it must say so plainly, not send the user to a button.
        pg.evaluate(STUB, [])
        pg.evaluate(SETTINGS, {'available': []})
        none = pg.evaluate(CAPTION)
        print('  no models ->', json.dumps(none)[:180])
        check('with no usable model it fails with a reason, not an instruction',
              (not none['ok']) and 'Test connection' not in (none.get('error') or ''),
              str(none.get('error')))

        check('no page errors', not errs, str(errs))
        b.close()
finally:
    app.terminate()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
