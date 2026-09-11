import * as ui from '../ui.js';
import { getSettings, saveSettings, putBlob, deleteBlob, getBlob, listProjects, DEFAULT_SETTINGS } from '../store.js';
import * as db from '../db.js';
import { ingest, blobUrl } from '../image.js';
import { exportBackup, importBackup, backupFilename, saveFile } from '../backup.js';
import { BUILD } from '../build.js';
import { ask, listModels, modelFor, DEFAULT_MODEL, aiEnabled } from '../assist.js';

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

    const modelRow = ui.inputRow('Model', draft.model, (v) => { draft.model = v; }, { placeholder: DEFAULT_MODEL });
    const modelField = modelRow.querySelector('input');

    // Presets come from what the key actually has, not from a hardcoded list:
    // model names change, and they differ between keys.
    const presets = ui.h('div', { class: 'chips scrollrow' });
    const paintPresets = () => {
      ui.clear(presets);
      const list = (draft.available || []).filter((m) => !/embedding|aqa|imagen|image-generation|tts|native-audio|live/.test(m));
      if (!list.length) {
        presets.appendChild(ui.h('div', { class: 'hint', style: { padding: '0 4px' },
          text: 'Tap Test connection to load the models available to this key.' }));
        return;
      }
      list.forEach((m) => presets.appendChild(ui.h('button', {
        class: 'chip', text: m,
        onclick: () => { draft.model = m; modelField.value = m; ui.haptic(); },
      })));
    };
    paintPresets();

    // Auto mode picks the cheapest model that can do each job and steps to
    // another one by itself when a model is rate limited or unavailable.
    const manual = ui.h('div', {}, modelRow, presets);
    const syncAuto = () => {
      const on = draft.auto !== false;
      manual.style.opacity = on ? '.4' : '1';
      manual.style.pointerEvents = on ? 'none' : 'auto';
    };
    const autoRow = ui.switchRow('Choose model automatically', draft.auto !== false,
      (v) => { draft.auto = v; syncAuto(); },
      'Cheapest first, matched to what your key has; falls back on rate limits');

    const testBtn = ui.h('button', { class: 'btn tinted wide' }, ui.h('span', { text: 'Test connection' }));
    testBtn.onclick = async () => {
      const label = testBtn.querySelector('span');
      const key = resolveKey();
      if (!key) { ui.toast('Enter an API key first'); return; }
      testBtn.disabled = true;
      const prev = { ...s.ai };
      try {
        // Ask the key what it has, then prove one of those models answers.
        label.textContent = 'Reading models\u2026';
        await set({ ai: { ...draft, key, enabled: true } });
        const models = await listModels();
        if (!models.length) throw new Error('This key has no models that can generate content.');
        draft.available = models;
        await set({ ai: { ...draft, key, enabled: true, available: models, checkedAt: Date.now() } });
        paintPresets();

        label.textContent = 'Testing\u2026';
        const used = await modelFor('text');
        const reply = await ask('Reply with the single word OK.');
        if (!reply) throw new Error('The model returned nothing.');
        await set({ ai: { ...draft, key, enabled: true, available: models, checkedAt: Date.now() } });
        ui.alert('Connected', `${models.length} model(s) available. Answered on ${used}.`);
      } catch (err) {
        await set({ ai: prev });
        ui.alert('Test failed', err.message);
      }
      label.textContent = 'Test connection';
      testBtn.disabled = false;
    };

    const body2 = ui.h('div', {},
      ui.h('div', { class: 'hint', text: 'The assistant suggests captions from your photos, captions a batch in one go, drafts the executive summary and answers questions about the inspection. It needs a connection; everything else in the app works offline.' }),
      ui.group('Google AI Studio', [
        ui.switchRow('Enable assistant', draft.enabled, (v) => { draft.enabled = v; }),
        ui.inputRow('API key', draft.key ? '••••••••' + draft.key.slice(-4) : '', (v) => { draft.key = v; }, { placeholder: 'AIza…' }),
        autoRow,
      ]),
      manual,
      ui.h('div', { class: 'btn-stack' }, testBtn),
      ui.h('div', { class: 'group-note', text: 'Get a key at aistudio.google.com. It is stored on this device only, sent to Google with each request, and is never included in a backup file.' }),
      ui.h('div', { class: 'group-note', text: 'Free-tier keys are rate limited and Google may use free-tier requests to improve their models. Use a billed key for client photos that must stay private.' }));

    syncAuto();
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
      ui.inputRow('Page footer', s.footerText, (v) => set({ footerText: v }), { placeholder: 'Left side of the page footer' }),
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
        sub: s.ai.enabled && s.ai.key
          ? (s.ai.auto !== false
            ? `Google AI Studio · auto${(s.ai.available || []).length ? ` · ${s.ai.available.length} models` : ' · not tested yet'}`
            : `Google AI Studio · ${s.ai.model}`)
          : 'Google AI Studio (Gemini)',
        value: s.ai.enabled && s.ai.key ? 'On' : 'Off',
        iconName: 'sparkle', iconColor: 'var(--sys-indigo)',
        chevron: true, onclick: aiSheet,
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

    body.appendChild(ui.h('div', { class: 'group-note', style: { textAlign: 'center', padding: '22px 16px 4px' },
      text: `${BUILD.name} — works offline. Photos and projects stay on this device until you back them up.` }));
    body.appendChild(ui.h('div', { class: 'credit' },
      ui.h('div', { text: 'Built by Ahmad Fudhail' }),
      ui.h('small', { text: BUILD.id === 'site' ? 'Capture edition' : 'Full edition' })));
  }

  await paint();
  return screen;
}
