import * as ui from '../ui.js';
import { getSettings, saveSettings, putBlob, deleteBlob, getBlob, listProjects, DEFAULT_SETTINGS } from '../store.js';
import * as db from '../db.js';
import { ingest, blobUrl } from '../image.js';
import { exportBackup, importBackup, backupFilename, saveFile } from '../backup.js';
import { BUILD } from '../build.js';
import { updateWaiting, applyUpdate } from '../app.js';
import { ask, MODEL, aiEnabled } from '../assist.js';
import { intakeEnabled, testConnection } from '../intake.js';

export default async function renderSettings() {
  let s = await getSettings(true);
  const screen = ui.h('div', { class: 'screen' });
  const body = ui.h('div', { class: 'scroll' });

  screen.appendChild(ui.navbar({ title: 'Settings', largeTitle: true }));
  screen.appendChild(body);

  const logoInput = ui.h('input', {
    type: 'file', accept: 'image/*', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const { blob } = await ingest(f, { maxPx: 900, quality: 0.9, thumbPx: 200 });
      if (s.logoBlobId) await deleteBlob(s.logoBlobId);
      const id = await putBlob(blob);
      s = await saveSettings({ logoBlobId: id });
      logoInput.value = '';
      ui.toast('Logo saved');
      paint();
    },
  });
  const restoreInput = ui.h('input', {
    type: 'file', accept: 'application/json,.json', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files[0];
      restoreInput.value = '';
      if (!f) return;
      const mode = await ui.actionSheet('Restore backup', [
        { label: 'Merge into this device', value: 'merge', icon: 'copy', color: 'var(--sys-blue)', primary: true, sub: 'Keeps existing projects' },
        { label: 'Replace everything', value: 'replace', icon: 'trash', color: 'var(--sys-red)', destructive: true, sub: 'Deletes projects on this device first' },
      ]);
      if (!mode) return;
      try {
        ui.toast('Restoring…', 60000);
        const r = await importBackup(f, { merge: mode === 'merge' });
        s = await getSettings(true);
        ui.toast(`Restored ${r.projects} project(s), ${r.photos} photo(s)`);
        paint();
      } catch (err) { ui.alert('Restore failed', err.message); }
    },
  });
  screen.append(logoInput, restoreInput);

  const set = async (patch) => { s = await saveSettings(patch); };

  function editTextSheet(title, key, placeholder, note) {
    let value = s[key] || '';
    const body2 = ui.h('div', {},
      note ? ui.h('div', { class: 'hint', text: note }) : null,
      ui.group('', [ui.textRow(title, value, (v) => { value = v; }, { placeholder })]));
    ui.sheet({
      title, body: body2, rightLabel: 'Save',
      onRight: async () => { await set({ [key]: value }); paint(); ui.toast('Saved'); },
    });
  }

  /**
   * The bot's address is all this needs — the Telegram token lives on the
   * Worker and never comes near the phone. The Worker holds no AI key at all
   * any more: captioning happens here, in the app.
   */
  async function intakeSheet() {
    let url = s.intake.url || '';
    const status = ui.h('div', { class: 'hint', text: '' });
    const body2 = ui.h('div', {},
      ui.group('Address', [
        ui.inputRow('Worker URL', url, (v) => { url = v.trim(); },
          { placeholder: 'https://your-worker.workers.dev' }),
      ]),
      status,
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn tinted wide', text: 'Test connection',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Testing\u2026';
            try {
              await set({ intake: { ...s.intake, url } });
              await testConnection(url);
              status.textContent = 'Connected. The bot is answering.';
            } catch (err) {
              status.textContent = err.message;
            } finally {
              btn.disabled = false; btn.textContent = 'Test connection';
            }
          },
        })),
      ui.h('div', { class: 'group-note',
        text: 'Setting it up is written out in worker/SETUP.md. Photos are collected by the bot, '
          + 'then pulled into a project from Projects > + > Import from Telegram.' }),
    );
    ui.sheet({
      title: 'Telegram intake',
      body: body2,
      rightLabel: 'Save',
      onRight: async () => { await set({ intake: { ...s.intake, url } }); paint(); ui.toast('Saved'); },
    });
  }

  async function backupSheet() {
    const projects = await listProjects();
    // The capture build only ever sends one job at a time: a project file cannot
    // overwrite the office's company details, logo or caption library.
    const pick = BUILD.fullBackup
      ? await ui.actionSheet('Backup', [
        { label: 'Full backup', value: 'all', icon: 'down', color: 'var(--sys-blue)', primary: true, sub: 'Projects, photos and settings' },
        { label: 'One project only', value: 'one', icon: 'folder', color: 'var(--sys-teal)', sub: 'Hand a job to a colleague' },
      ])
      : 'one';
    if (!pick) return;
    let ids = null; let label = 'all';
    if (pick === 'one') {
      if (!projects.length) { ui.toast('No projects yet'); return; }
      const chosen = await ui.actionSheet('Which project?', projects.map((p) => ({ label: p.name, value: p.id, icon: 'folder', color: 'var(--sys-blue)' })));
      if (!chosen) return;
      ids = [chosen];
      label = projects.find((p) => p.id === chosen).name;
    }
    ui.toast('Preparing backup…', 60000);
    try {
      const blob = await exportBackup(ids);
      const res = await saveFile(blob, backupFilename(label));
      if (res !== 'cancelled') {
        await set({ lastBackupAt: Date.now() });
        ui.toast(`Backup ready (${ui.fmtBytes(blob.size)})`);
        paint();
      } else ui.toast('Cancelled');
    } catch (err) { ui.alert('Backup failed', err.message); }
  }

  function aiSheet() {
    const draft = { ...s.ai };
    const resolveKey = () => (draft.key.startsWith('••') ? s.ai.key : draft.key.trim());

    // No model picker, no auto switch, no presets. Which model to use was a
    // setting because a free key could not be relied on to have any particular
    // one, and the app had to discover and step between them. It is a constant
    // in the code now: one fewer thing to choose, and one fewer thing that can
    // stop working without saying so.
    const testBtn = ui.h('button', { class: 'btn tinted wide' }, ui.h('span', { text: 'Test connection' }));
    testBtn.onclick = async () => {
      const label = testBtn.querySelector('span');
      const key = resolveKey();
      if (!key) { ui.toast('Enter an API key first'); return; }
      testBtn.disabled = true;
      label.textContent = 'Testing\u2026';
      const prev = { ...s.ai };
      try {
        await set({ ai: { ...draft, key, enabled: true } });
        const reply = await ask('Reply with the single word OK.');
        if (!reply) throw new Error('The model returned nothing.');
        await set({ ai: { ...draft, key, enabled: true, checkedAt: Date.now() } });
        ui.alert('Connected', `${MODEL} answered.`);
      } catch (err) {
        await set({ ai: { ...prev, key } });
        ui.alert('Test failed', err.message);
      }
      label.textContent = 'Test connection';
      testBtn.disabled = false;
    };

    const body2 = ui.h('div', {},
      ui.h('div', { class: 'hint', text: 'The assistant suggests captions from your photos, captions a batch in one go, drafts the executive summary and answers questions about the inspection. It needs a connection; everything else in the app works offline.' }),
      ui.group('Claude', [
        ui.switchRow('Enable assistant', draft.enabled, (v) => { draft.enabled = v; }),
        ui.inputRow('API key', draft.key ? '••••••••' + draft.key.slice(-4) : '', (v) => { draft.key = v; }, { placeholder: 'sk-ant-…' }),
        ui.row({ title: 'Model', sub: MODEL }),
      ]),
      ui.h('div', { class: 'btn-stack' }, testBtn),
      ui.h('div', { class: 'group-note', text: 'Get a key at console.anthropic.com. It is stored on this device only, sent to Anthropic with each request, and is never included in a backup file.' }),
      ui.h('div', { class: 'group-note', text: 'This is a paid key \u2014 around 20 US cents for a 200-photo inspection. Anthropic does not train on API requests, so client photos stay yours.' }));

    ui.sheet({
      title: 'AI Assistant', body: body2, rightLabel: 'Save',
      onRight: async () => {
        await set({ ai: { ...draft, key: resolveKey() } });
        paint(); ui.toast('Saved');
      },
    });
  }

  async function paint() {
    ui.clear(body);

    /* branding */
    const logoBlob = s.logoBlobId ? await getBlob(s.logoBlobId) : null;
    const logoPreview = logoBlob
      ? ui.h('img', { src: blobUrl(s.logoBlobId + ':lg', logoBlob), style: { height: '30px', maxWidth: '110px', objectFit: 'contain' } })
      : null;

    body.appendChild(ui.group('Your Details', [
      ui.inputRow('Company', s.company, (v) => set({ company: v })),
      ui.inputRow('Prepared by', s.preparedBy, (v) => set({ preparedBy: v })),
      ui.inputRow('Contact', s.contact, (v) => set({ contact: v })),
      ui.row({
        title: 'Logo', sub: s.logoBlobId ? 'Shown on the cover page' : 'Not set',
        right: logoPreview, onclick: () => logoInput.click(), chevron: !logoPreview,
      }),
      s.logoBlobId ? ui.row({
        title: 'Remove logo', cls: 'destructive',
        onclick: async () => { await deleteBlob(s.logoBlobId); await set({ logoBlobId: null }); paint(); },
      }) : null,
    ]));

    /* report defaults */
    body.appendChild(ui.group('Report Defaults', [
      ui.row({
        title: 'Layout',
        sub: (s.reportFormat || 'captions') === 'table'
          ? 'Numbered photos, defect table per section'
          : 'A caption under every photo',
        right: ui.h('select', {
          onchange: (e) => set({ reportFormat: e.target.value }).then(paint),
          style: { border: 0, background: 'none', fontSize: '15px', color: 'var(--label-2)' },
        }, ...[['captions', 'Photo captions'], ['table', 'Defect table']].map(([v, label]) => {
          const o = ui.h('option', { value: v, text: label });
          if (v === (s.reportFormat || 'captions')) o.selected = true;
          return o;
        })),
      }),
      ui.inputRow('Report title', s.reportTitle, (v) => set({ reportTitle: v })),
      ui.switchRow('Cover page', s.coverEnabled, (v) => set({ coverEnabled: v })),
      ui.inputRow('Cover kicker', s.coverKicker, (v) => set({ coverKicker: v })),
      ui.row({ title: 'Cover note', sub: s.coverBody ? s.coverBody.slice(0, 60) + '…' : 'Not set', chevron: true, onclick: () => editTextSheet('Cover note', 'coverBody', 'Optional paragraph on the cover page') }),
      ui.switchRow('Executive summary', s.summaryEnabled, (v) => set({ summaryEnabled: v })),
      ui.inputRow('Summary heading', s.summaryTitle, (v) => set({ summaryTitle: v })),
      ui.row({ title: 'Summary text', sub: (s.summaryBody || '').slice(0, 60) + '…', chevron: true, onclick: () => editTextSheet('Executive summary', 'summaryBody', 'Default summary text') }),
      ui.switchRow('Summary table', s.summaryTableEnabled, (v) => set({ summaryTableEnabled: v }), 'Photo and item counts per location'),
      ui.switchRow('Notes & limitations page', s.notesEnabled, (v) => set({ notesEnabled: v })),
      ui.row({ title: 'Notes text', sub: s.notesBody ? s.notesBody.slice(0, 60) + '…' : 'Not set', chevron: true, onclick: () => editTextSheet('Notes & limitations', 'notesBody', 'Scope, method and limitations') }),
      ui.row({
        title: 'Page numbers',
        sub: s.pageNumbering === 'section' ? 'Restarts at each section, like the older reports' : 'Runs through the whole report',
        right: ui.h('select', {
          onchange: (e) => set({ pageNumbering: e.target.value }).then(paint),
          style: { border: 0, background: 'none', fontSize: '15px', color: 'var(--label-2)' },
        }, ...[['document', 'Whole report'], ['section', 'Per section']].map(([v, label]) => {
          const o = ui.h('option', { value: v, text: label });
          if (v === (s.pageNumbering || 'document')) o.selected = true;
          return o;
        })),
      }),
      ui.inputRow('Page footer', s.footerText, (v) => set({ footerText: v }),
        { placeholder: 'Left of the footer \u2014 empty for page numbers only' }),
    ]));

    /* capture */
    body.appendChild(ui.group('Capture', [
      ui.row({
        title: 'Photo size',
        right: ui.h('select', {
          onchange: (e) => set({ imageMaxPx: Number(e.target.value) }),
          style: { border: 0, background: 'none', fontSize: '17px', color: 'var(--label-2)' },
        }, ...[[1200, 'Small (fast)'], [1600, 'Standard'], [2200, 'Large (sharp)']].map(([v, l]) => {
          const o = ui.h('option', { value: String(v), text: l });
          if (v === s.imageMaxPx) o.selected = true;
          return o;
        })),
      }),
      ui.row({
        title: 'Photos per report page',
        right: ui.h('select', {
          onchange: (e) => set({ photosPerPage: Number(e.target.value) }),
          style: { border: 0, background: 'none', fontSize: '17px', color: 'var(--label-2)' },
        }, ...[2, 4, 6, 8].map((n) => {
          const o = ui.h('option', { value: String(n), text: String(n) });
          if (n === s.photosPerPage) o.selected = true;
          return o;
        })),
      }),
      !aiEnabled ? null : ui.row({
        title: 'AI photo detail',
        sub: 'Size sent to the assistant — smaller uses fewer tokens',
        right: ui.h('select', {
          onchange: (e) => set({ aiImagePx: Number(e.target.value) }),
          style: { border: 0, background: 'none', fontSize: '17px', color: 'var(--label-2)' },
        }, ...[[512, 'Low'], [768, 'Standard'], [1024, 'High']].map(([v, l]) => {
          const o = ui.h('option', { value: String(v), text: l });
          if (v === s.aiImagePx) o.selected = true;
          return o;
        })),
      }),
      ui.row({ title: 'Caption & section library', sub: 'Quick-pick captions used on site', chevron: true, onclick: () => { location.hash = '#/library'; } }),
    ]));

    /* photo timestamp */
    body.appendChild(ui.group('Photo Timestamp', [
      ui.switchRow('Show on report photos', s.stampEnabled !== false, (v) => set({ stampEnabled: v }).then(paint),
        'Capture time is read from the photo itself'),
      ui.row({
        title: 'Format',
        right: ui.h('select', {
          onchange: (e) => set({ stampFormat: e.target.value }).then(paint),
          style: { border: 0, background: 'none', fontSize: '15px', color: 'var(--label-2)' },
        }, ...ui.STAMP_FORMATS.map(([v, label]) => {
          const o = ui.h('option', { value: v, text: label });
          if (v === s.stampFormat) o.selected = true;
          return o;
        })),
      }),
      ui.row({
        title: 'Position',
        right: ui.h('select', {
          onchange: (e) => set({ stampPosition: e.target.value }),
          style: { border: 0, background: 'none', fontSize: '17px', color: 'var(--label-2)' },
        }, ...[['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']].map(([v, label]) => {
          const o = ui.h('option', { value: v, text: label });
          if (v === (s.stampPosition || 'br')) o.selected = true;
          return o;
        })),
      }),
      ui.switchRow('Burn into shared photos', s.stampInShare !== false, (v) => set({ stampInShare: v }),
        'For photos sent out of the app on their own'),
    ]));

    /* AI */
    if (aiEnabled) body.appendChild(ui.group('Assistant', [
      ui.row({
        title: 'AI assistant',
        sub: s.ai.enabled && s.ai.key ? MODEL : 'Claude — needs an API key',
        value: s.ai.enabled && s.ai.key ? 'On' : 'Off',
        iconName: 'sparkle', iconColor: 'var(--sys-indigo)',
        chevron: true, onclick: aiSheet,
      }),
    ]));

    /* Telegram intake */
    if (intakeEnabled) body.appendChild(ui.group('Telegram Intake', [
      ui.row({
        title: 'Intake bot',
        sub: s.intake.url || 'Not set up',
        value: s.intake.url ? 'On' : 'Off',
        iconName: 'down', iconColor: 'var(--sys-blue)',
        chevron: true, onclick: intakeSheet,
      }),
    ]));

    /* backup */
    const est = await db.estimate();
    body.appendChild(ui.group('Backup & Storage', [
      ui.row({
        title: BUILD.fullBackup ? 'Back up now' : 'Export project to send',
        sub: BUILD.fullBackup ? '' : 'One file per job, for the office',
        cls: 'action', iconName: 'down', iconColor: 'var(--sys-blue)', onclick: backupSheet,
      }),
      ui.row({ title: 'Restore from file', cls: 'action', iconName: 'up', iconColor: 'var(--sys-teal)', onclick: () => restoreInput.click() }),
      ui.row({ title: 'Last backup', value: s.lastBackupAt ? ui.fmtDate(s.lastBackupAt) : 'Never' }),
      est ? ui.row({ title: 'Storage used', value: `${ui.fmtBytes(est.usage || 0)} of ${ui.fmtBytes(est.quota || 0)}` }) : null,
    ]));

    /* danger */
    body.appendChild(ui.group('', [
      ui.row({
        title: 'Reset report defaults', cls: 'destructive',
        onclick: async () => {
          const ok = await ui.confirm('Reset defaults?', 'Cover, summary and notes text return to the built-in wording. Projects and photos are not touched.', { okLabel: 'Reset', destructive: true });
          if (!ok) return;
          const keep = ['company', 'preparedBy', 'contact', 'logoBlobId', 'captionLib', 'sectionLib', 'usage', 'ai', 'lastBackupAt'];
          const patch = {};
          Object.keys(DEFAULT_SETTINGS).forEach((k) => { if (!keep.includes(k) && k !== 'id') patch[k] = DEFAULT_SETTINGS[k]; });
          await set(patch); paint(); ui.toast('Defaults restored');
        },
      }),
    ]));

    // Which version is running, and a way to take an update that is ready but
    // waiting. The handover holds off while a sheet or an editor is open, which
    // is exactly where someone sits when something is wrong — so it has to be
    // possible to say "now".
    body.appendChild(ui.group('App', [
      ui.row({
        title: 'Version',
        value: BUILD.version || 'dev',
        sub: updateWaiting() ? 'An update is ready' : 'Up to date',
      }),
      ...(updateWaiting() ? [ui.row({
        title: 'Update now',
        sub: 'Reloads the app. Projects and photos are not affected',
        iconName: 'down', iconColor: 'var(--sys-green)',
        onclick: () => applyUpdate(),
      })] : []),
    ]));

    body.appendChild(ui.h('div', { class: 'group-note', style: { textAlign: 'center', padding: '22px 16px 4px' },
      text: `${BUILD.name} — works offline. Photos and projects stay on this device until you back them up.` }));
    body.appendChild(ui.h('div', { class: 'credit' },
      ui.h('div', { text: 'Built by Ahmad Fudhail' }),
      ui.h('small', { text: BUILD.id === 'site' ? 'Capture edition' : 'Full edition' })));
  }

  await paint();
  return screen;
}
