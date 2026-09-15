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
      const body = JSON.parse(init.body);
      window.__bodies = window.__bodies || [];
      window.__bodies.push(body);
      // Some models refuse the system instruction outright, as Ahmad's do.
      if (window.__refuseSystem && body.systemInstruction) {
        return new Response(JSON.stringify({ error: {
          message: `Developer instruction is not enabled for models/${name}` } }), { status: 400 });
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

        # A key like Ahmad's: the model names match nothing in the built-in
        # ladder — no "flash", no "pro", no "lite" — but they are real models.
        ODD = ['antigravity-preview-05-2026', 'antigravity-preview-09-2026']
        pg.evaluate(STUB, ODD)
        pg.evaluate(SETTINGS, {'available': ODD})
        pg.evaluate("() => { window.__calls = []; }")
        odd = pg.evaluate(CAPTION)
        print('  unfamiliar names ->', json.dumps(odd)[:180])
        check('a key whose models are named nothing like the ladder still works',
              odd['ok'], str(odd.get('error')))
        check('it never asks for a model the key does not list',
              all(not any(bad in c for bad in ['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
                  for c in odd['calls'] if ':generateContent' in c),
              str(odd['calls']))

        # And when it genuinely cannot, the message says what it tried.
        pg.evaluate(STUB, [])
        pg.evaluate(SETTINGS, {'available': ODD})
        nope = pg.evaluate(CAPTION)
        print('  none answer ->', json.dumps(nope)[:200])
        check('the failure names the models it tried',
              all(m in (nope.get('error') or '') for m in ODD), str(nope.get('error')))
        check('the failure says how many the key has',
              'usable model' in (nope.get('error') or ''), str(nope.get('error')))

        # The real failure from the phone: the model exists and the key is fine,
        # but it will not accept a system instruction.
        pg.evaluate(STUB, ODD)
        pg.evaluate("() => { window.__refuseSystem = true; window.__calls = []; window.__bodies = []; }")
        pg.evaluate(SETTINGS, {'available': ODD})
        picky = pg.evaluate(CAPTION)
        print('  refuses system ->', json.dumps(picky)[:180])
        check('a model that refuses a system instruction still captions',
              picky['ok'], str(picky.get('error')))

        bodies = pg.evaluate("() => window.__bodies")
        check('it tried the same model again without the instruction',
              any('systemInstruction' in b for b in bodies)
              and any('systemInstruction' not in b for b in bodies),
              str([sorted(b.keys()) for b in bodies]))
        plain = [b for b in bodies if 'systemInstruction' not in b][-1]
        first_text = next((p.get('text') for p in plain['contents'][0]['parts'] if 'text' in p), '')
        check('the rules are moved into the prompt, not dropped',
              'UPPERCASE' in first_text, first_text[:80])
        check('the photo is still sent',
              any('inline_data' in p for p in plain['contents'][0]['parts']),
              str([sorted(p.keys()) for p in plain['contents'][0]['parts']]))
        pg.evaluate("() => { window.__refuseSystem = false; }")

        check('no page errors', not errs, str(errs))
        b.close()
finally:
    app.terminate()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
