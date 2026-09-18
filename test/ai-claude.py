"""What the assistant actually sends, and what it does when Claude says no.

The assistant is the one part of this app that talks to somebody else's server,
and the one part that cost a working week when it went wrong. The failures were
never exotic: a model the key could not reach, a refusal counted as a reason to
stop trying, a key put somewhere it should not be. So this drives the real
module in a real browser against a stubbed Anthropic and checks the request
shape and the failure handling, rather than trusting either.

Run: python3 test/ai-claude.py
"""
import json
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT, PORT = '/home/user/def-rpt', 8798
MODEL = 'claude-haiku-4-5'

app = subprocess.Popen(['python3', '-m', 'http.server', str(PORT)], cwd=f'{ROOT}/dist',
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

failures = []


def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + (f' — {detail}' if detail and not cond else ''))
    if not cond:
        failures.append(name)


# Records every call and lets a test decide what Anthropic answers.
STUB = """() => {
  window.__calls = [];
  window.__plan = [];          // statuses to answer with, in order
  window.__reply = 'UNFILLED GROUT';
  window.__n = 0;
  const real = window.fetch;
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.anthropic.com')) return real(url, init);
    const headers = init.headers || {};
    const body = JSON.parse(init.body);
    window.__calls.push({ url: u, headers, body });

    const status = window.__plan.length ? window.__plan.shift() : 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: `stub says ${status}` } }),
        { status, headers: { 'retry-after': '0' } });
    }
    // Numbered when the prompt asked for numbered lines, which is the contract
    // the batch path relies on. The counter runs across chunks, so a caption
    // landing against the wrong photo shows up as a number out of place.
    const images = body.messages[0].content.filter((b) => b.type === 'image').length;
    const wants = body.messages[0].content
      .some((b) => b.type === 'text' && b.text.includes('numbered lines'));
    const text = wants
      ? Array.from({ length: images }, (_, i) => `${i + 1}. ${window.__reply} ${++window.__n}`).join('\\n')
      : window.__reply;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
    }), { status: 200 });
  };
}"""

PHOTO = """async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('canvas');
    // Deliberately larger than the 768px the assistant should send.
    c.width = 2000; c.height = 1500;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${i * 20},100,100)`;
    ctx.fillRect(0, 0, 2000, 1500);
    out.push(await new Promise((r) => c.toBlob(r, 'image/jpeg')));
  }
  window.__blobs = out;
  return out.length;
}"""

CAPTION_ONE = """async () => {
  const assist = await import('/admin/js/assist.js');
  try {
    const out = await assist.suggestCaption(window.__blobs[0], { sectionTitle: 'BATH 1' });
    return { ok: true, text: out.text };
  } catch (err) { return { ok: false, error: err.message }; }
}"""

CAPTION_MANY = """async () => {
  const assist = await import('/admin/js/assist.js');
  const items = window.__blobs.map((b, i) => ({ id: i, blob: b }));
  window.__progress = [];
  try {
    const out = await assist.suggestCaptionsBatch(items, {
      sectionTitle: 'KITCHEN',
      chunkSize: 3,
      onProgress: (done, total, results, start) =>
        window.__progress.push({ done, total, start, texts: results.map((r) => r.text) }),
    });
    return { ok: true, texts: out.map((r) => r.text), progress: window.__progress };
  } catch (err) {
    return { ok: false, error: err.message, progress: window.__progress };
  }
}"""

SETTINGS = """async (patch) => {
  const s = await import('/admin/js/store.js');
  const cur = await s.getSettings(true);
  await s.saveSettings({ ai: { ...cur.ai, ...patch } });
  return (await s.getSettings(true)).ai;
}"""

KEY = 'sk-ant-test-0123456789'

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        pg = b.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://localhost:{PORT}/admin/index.html')
        pg.wait_for_timeout(2000)
        pg.evaluate(STUB)
        pg.evaluate(PHOTO, 1)
        pg.evaluate(SETTINGS, {'key': KEY, 'enabled': True})

        # ---------- one photo ----------
        one = pg.evaluate(CAPTION_ONE)
        check('a photo comes back captioned', one['ok'], str(one.get('error')))
        check('the caption is cleaned up', one.get('text') == 'UNFILLED GROUT', str(one.get('text')))

        calls = pg.evaluate("() => window.__calls")
        check('exactly one request for one photo', len(calls) == 1, str(len(calls)))
        c = calls[0]

        check('it goes to the Messages API',
              c['url'] == 'https://api.anthropic.com/v1/messages', c['url'])
        check('the model is the one we chose and nothing else',
              c['body']['model'] == MODEL, str(c['body'].get('model')))

        # The header a browser needs, and the two that authenticate it.
        h = {k.lower(): v for k, v in c['headers'].items()}
        check('the key travels as a header', h.get('x-api-key') == KEY, str(list(h)))
        check('the API version is pinned', bool(h.get('anthropic-version')), str(list(h)))
        check('browser access is declared',
              h.get('anthropic-dangerous-direct-browser-access') == 'true', str(list(h)))

        # A key in a URL ends up in logs and history. It must only ever be a header.
        check('the key is nowhere but the header',
              KEY not in c['url'] and KEY not in json.dumps(c['body']),
              'the key appears in the URL or body')

        content = c['body']['messages'][0]['content']
        img = next((x for x in content if x['type'] == 'image'), None)
        check('the photo is sent as base64', img and img['source']['type'] == 'base64', str(img))
        check('the photo is JPEG', img and img['source']['media_type'] == 'image/jpeg', str(img))

        # Claude bills an image by its area, so sending the 2000px original
        # instead of a 768px copy costs several times as much for no better
        # caption. A rough size check is enough to catch it being skipped.
        check('the photo is downscaled before sending, not sent at capture size',
              len(img['source']['data']) < 200_000,
              f"{len(img['source']['data'])} base64 chars")

        sys_text = c['body'].get('system') or ''
        check('the wording rules are sent', 'UPPERCASE' in sys_text, sys_text[:60])
        check('the burnt-in timestamp is ruled out', 'Ignore any date' in sys_text, sys_text[:60])
        room = ' '.join(x.get('text', '') for x in content if x['type'] == 'text')
        check('the room is named', 'BATH 1' in room, room[:80])
        check('the library is offered', 'Library:' in room, room[:80])

        # ---------- a batch ----------
        pg.evaluate(PHOTO, 7)
        pg.evaluate("() => { window.__calls = []; window.__n = 0; }")
        many = pg.evaluate(CAPTION_MANY)
        check('a batch comes back captioned', many['ok'], str(many.get('error')))
        check('every photo got a caption',
              len(many.get('texts', [])) == 7 and all(many['texts']), str(many.get('texts')))
        check('captions come back against the right photos, across chunks',
              many['texts'] == [f'UNFILLED GROUT {i}' for i in range(1, 8)],
              str(many['texts']))

        batch_calls = pg.evaluate("() => window.__calls")
        check('seven photos cost three requests, not seven',
              len(batch_calls) == 3, f'{len(batch_calls)} requests')
        check('each request carries several photos',
              [sum(1 for x in bc['body']['messages'][0]['content'] if x['type'] == 'image')
               for bc in batch_calls] == [3, 3, 1],
              str([sum(1 for x in bc['body']['messages'][0]['content'] if x['type'] == 'image')
                   for bc in batch_calls]))

        # ---------- a rate limit is not a failure ----------
        pg.evaluate("() => { window.__calls = []; window.__plan = [429]; }")
        pg.evaluate(PHOTO, 1)
        limited = pg.evaluate(CAPTION_ONE)
        check('a rate limit is waited out, not surfaced', limited['ok'], str(limited.get('error')))
        check('it retried exactly once', len(pg.evaluate("() => window.__calls")) == 2,
              str(len(pg.evaluate("() => window.__calls"))))

        # ---------- a bad key is not worth retrying ----------
        pg.evaluate("() => { window.__calls = []; window.__plan = [401, 401]; }")
        bad = pg.evaluate(CAPTION_ONE)
        check('a rejected key fails', not bad['ok'], str(bad.get('text')))
        check('a rejected key says so in words the user can act on',
              'rejected' in (bad.get('error') or '').lower(), str(bad.get('error')))
        check('a rejected key is not retried', len(pg.evaluate("() => window.__calls")) == 1,
              str(len(pg.evaluate("() => window.__calls"))))

        # ---------- a failure part-way keeps what was already written ----------
        # This is what makes a 200-photo job safe: stopping must never throw away
        # the captions already paid for.
        pg.evaluate(PHOTO, 7)
        pg.evaluate("() => { window.__calls = []; window.__plan = [200, 401, 401]; }")
        partial = pg.evaluate(CAPTION_MANY)
        done = [t for t in (partial.get('texts') or []) if t]
        check('the captions written before the failure survive it',
              len(done) == 3, f'{len(done)} kept of the first 3')
        check('progress was reported before the failure',
              len(partial.get('progress') or []) >= 1, str(partial.get('progress')))

        # ---------- no key ----------
        pg.evaluate(SETTINGS, {'key': '', 'enabled': True})
        pg.evaluate("() => { window.__calls = []; window.__plan = []; }")
        pg.evaluate(PHOTO, 1)
        keyless = pg.evaluate(CAPTION_ONE)
        check('without a key nothing is sent anywhere',
              len(pg.evaluate("() => window.__calls")) == 0,
              str(pg.evaluate("() => window.__calls")))
        check('without a key it falls back rather than throwing', keyless['ok'],
              str(keyless.get('error')))

        check('no page errors', not errs, str(errs))
        b.close()
finally:
    app.terminate()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
