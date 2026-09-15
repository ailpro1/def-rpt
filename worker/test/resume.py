"""A half-finished import must resume, not duplicate.

Imports a batch with the photo endpoint failing partway, then repairs it and
imports the same code again — the second run should top up, not double.

    python3 worker/test/resume.py
"""
import re, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT, WORKER_PORT, APP_PORT = '/home/user/def-rpt', 8794, 8795

worker = subprocess.Popen(['node', 'worker/test/serve.js', str(WORKER_PORT), '5'],
                          cwd=ROOT, stdout=subprocess.PIPE, text=True)
code = re.search(r'CODE=(\w+)', worker.stdout.readline()).group(1)
app = subprocess.Popen(['python3', '-m', 'http.server', str(APP_PORT)], cwd=f'{ROOT}/dist',
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

failures = []
def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + (f' — {detail}' if detail and not cond else ''))
    if not cond: failures.append(name)

IMPORT = """async (args) => {
  const s = await import('/admin/js/store.js');
  await s.saveSettings({ intake: { url: args.url, lastCode: '' } });
  return true;
}"""

COUNT = """async () => {
  const s = await import('/admin/js/store.js');
  const p = (await s.listProjects())[0];
  if (!p) return { photos: 0, marked: 0 };
  const photos = await s.listProjectPhotos(p.id);
  return {
    photos: photos.length,
    marked: photos.filter(x => x.meta && x.meta.intake).length,
    unique: new Set(photos.map(x => x.meta && x.meta.intake && `${x.meta.intake.code}:${x.meta.intake.id}`)).size,
  };
}"""

def do_import(pg):
    """Run one import and wait for it to actually end, rather than a guessed
    number of seconds — 9 photos through the full ingest path is not quick."""
    pg.goto(f'http://localhost:{APP_PORT}/admin/index.html#/inbox')
    pg.wait_for_timeout(1200)
    pg.fill('input[type=text]', code)
    pg.click('button:has-text("Fetch batch")')
    pg.wait_for_timeout(2500)
    if pg.locator('.alert').count():
        raise SystemExit('fetch failed: ' + pg.inner_text('.alert').replace('\n', ' '))
    btn = pg.locator('button.btn.primary:has-text("Import")')
    label = btn.inner_text()
    btn.click()
    pg.wait_for_timeout(700)
    pg.click('.alert .a-btns button.primary')          # confirm

    # Done when either the summary alert shows or it has moved to the project.
    alert = ''
    for _ in range(120):
        pg.wait_for_timeout(500)
        if pg.locator('.alert').count():
            alert = pg.inner_text('.alert')
            pg.click('.alert .a-btns button.primary')
            pg.wait_for_timeout(800)
            break
        if '#/project/' in pg.url:
            break
    return label, alert


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        pg = b.new_page()
        pg.goto(f'http://localhost:{APP_PORT}/admin/index.html')
        pg.wait_for_timeout(2000)
        pg.evaluate(IMPORT, {'url': f'http://localhost:{WORKER_PORT}'})

        # Drop the connection after the fourth photo, the way a phone going to
        # sleep or a lift does.
        served = {'n': 0}
        def flaky(route):
            served['n'] += 1
            route.abort() if served['n'] > 4 else route.continue_()
        pg.route('**/api/photo/**', flaky)

        label, alert = do_import(pg)
        print('  first run alert:', alert.replace('\n', ' ')[:110])
        partial = pg.evaluate(COUNT)
        print('  after partial:', partial)
        check('some photos landed', 0 < partial['photos'] < 9, str(partial))
        check('every landed photo is marked with its batch', partial['marked'] == partial['photos'], str(partial))
        check('the user is told to run it again', 'again' in alert, alert[:80])

        # Connection restored.
        pg.unroute('**/api/photo/**')
        label2, alert2 = do_import(pg)
        print('  second run button:', label2, '| alert:', alert2.replace('\n', ' ')[:80])
        full = pg.evaluate(COUNT)
        print('  after resume:', full)
        check('all nine photos now in', full['photos'] == 9, str(full))
        check('nothing was duplicated', full['unique'] == 9, str(full))
        check('the button counts only what it will add', label2 == 'Import 5 photos', label2)
        b.close()
finally:
    worker.terminate(); app.terminate()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
