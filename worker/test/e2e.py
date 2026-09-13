"""End to end: the real Worker code on one port, the built admin app on another,
driven in headless Chromium. Proves a Telegram batch becomes a project.

    python3 worker/test/e2e.py
"""
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = '/home/user/def-rpt'
WORKER_PORT = 8790
APP_PORT = 8791

worker = subprocess.Popen(
    ['node', 'worker/test/serve.js', str(WORKER_PORT)],
    cwd=ROOT, stdout=subprocess.PIPE, text=True)
line = worker.stdout.readline()
code = re.search(r'CODE=(\w+)', line).group(1)
print('batch code:', code)

app = subprocess.Popen(['python3', '-m', 'http.server', str(APP_PORT)],
                       cwd=f'{ROOT}/dist', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

failures = []
def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + (f' — {detail}' if detail and not cond else ''))
    if not cond:
        failures.append(name)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        pg = b.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(f'console:{m.type}:{m.text}') if m.type == 'error' else None)
        pg.goto(f'http://localhost:{APP_PORT}/admin/index.html')
        pg.wait_for_timeout(2000)

        # Point the app at the local Worker, the way Settings would.
        pg.evaluate("""async (url) => {
          const s = await import('/admin/js/store.js');
          await s.saveSettings({ intake: { url, lastCode: '' } });
        }""", f'http://localhost:{WORKER_PORT}')

        pg.goto(f'http://localhost:{APP_PORT}/admin/index.html#/inbox')
        pg.wait_for_timeout(1200)
        check('inbox screen opens', 'Import from Telegram' in pg.inner_text('.screen'))

        pg.fill('input[type=text]', code)
        pg.click('button:has-text("Fetch batch")')
        pg.wait_for_timeout(3000)
        if pg.locator('.alert').count():
            print('ALERT:', pg.inner_text('.alert'))
        print('CONSOLE:', errs[:4])

        text = pg.inner_text('.screen')
        check('batch summary shown', '23 JALAN KERUING' in text, text[:200])
        check('photo count shown', '4 photos' in text, text[:200])
        check('sections listed', 'CAR PORCH' in text and 'KITCHEN' in text)
        # "/sec MASTER BED" must resolve to the library's MASTER BEDROOM.
        check('fuzzy section matched', 'MASTER BEDROOM' in text, text[:400])

        pg.click('button.btn.primary:has-text("Import 4 photos")')
        pg.wait_for_timeout(700)
        pg.click('.alert .a-btns button.primary')
        pg.wait_for_timeout(8000)

        state = pg.evaluate("""async () => {
          const s = await import('/admin/js/store.js');
          const projects = await s.listProjects();
          const p = projects[0];
          const sections = await s.listSections(p.id);
          const out = [];
          for (const sec of sections) {
            const photos = await s.listPhotos(sec.id);
            out.push({ title: sec.title, n: photos.length,
                       captions: photos.map(x => x.caption),
                       sources: photos.map(x => x.takenSource),
                       orders: photos.map(x => x.order) });
          }
          return { name: p.name, sections: out };
        }""")

        print('imported:', state)
        check('project created', state['name'] == '23 JALAN KERUING', state['name'])
        titles = [s['title'] for s in state['sections']]
        check('three sections', len(titles) == 3, ','.join(titles))
        check('fuzzy section became MASTER BEDROOM', 'MASTER BEDROOM' in titles, ','.join(titles))
        total = sum(s['n'] for s in state['sections'])
        check('every photo landed', total == 4, str(total))
        caps = [c for s in state['sections'] for c in s['captions']]
        check('captions carried over', 'UNFILLED GROUT' in caps and 'OVERVIEW' in caps, str(caps))
        srcs = {x for s in state['sections'] for x in s['sources']}
        check('capture time marked as a send time', srcs == {'telegram'}, str(srcs))
        orders = [o for s in state['sections'] for o in s['orders']]
        check('photo order assigned by the app', all(isinstance(o, int) for o in orders), str(orders))

        # Snapshot before the next check, which asks for a batch that is gone on
        # purpose and would otherwise log its own 404 as a page error.
        errs_during_import = list(errs)

        # The batch is claimed once everything is in, so a second import finds nothing.
        again = pg.evaluate("""async (args) => {
          const res = await fetch(`${args.url}/api/batch/${args.code}`);
          return res.status;
        }""", {'url': f'http://localhost:{WORKER_PORT}', 'code': code})
        check('batch claimed after import', again == 404, str(again))

        check('no page errors', not errs_during_import, str(errs_during_import))
        b.close()
finally:
    worker.terminate()
    app.terminate()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
