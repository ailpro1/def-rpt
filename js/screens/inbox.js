// Import a Telegram batch. Dropped from the capture build — see tools/build.mjs.
//
// The point of this screen is that nothing is written until the user says so:
// the batch is described first, the section mapping is shown already worked out
// but still editable, and only then does anything reach the database.
import * as ui from '../ui.js';
import { go } from '../app.js';
import {
  getSettings, saveSettings, listProjects, createProject, getProject,
  listSections, createSection, addPhoto, updatePhoto,
} from '../store.js';
import { matchSection } from '../captions.js';
import { ingest } from '../image.js';
import { fetchManifest, fetchPhoto, claimBatch, readManifestFile } from '../intake.js';

const SKIP = '__skip__';
const NEW_PROJECT = '__new__';

export default async function renderInbox(initialCode = '') {
  const settings = await getSettings();
  const screen = ui.h('div', { class: 'screen' });
  const body = ui.h('div', { class: 'scroll' });

  let manifest = null;
  let target = NEW_PROJECT;          // project id, or NEW_PROJECT
  let projectName = '';
  let mapping = new Map();           // incoming section title -> target title | SKIP
  let projects = [];
  let busy = false;

  screen.appendChild(ui.navbar({
    title: 'Import from Telegram',
    left: ui.backBtn(() => go('#/projects')),
  }));
  screen.appendChild(body);

  const fileInput = ui.h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        manifest = readManifestFile(await f.text());
        await prepare();
      } catch (err) {
        ui.alert('Could not read that file', err.message);
      }
    },
  });
  screen.appendChild(fileInput);

  /* ---------------- fetching ---------------- */

  let code = String(initialCode || settings.intake?.lastCode || '').toUpperCase();

  async function pull() {
    if (!settings.intake?.url) {
      const go1 = await ui.confirm('No intake address',
        'Set the bot address first, in Settings > Telegram intake.', { okLabel: 'Settings' });
      if (go1) go('#/settings');
      return;
    }
    busy = true; paint();
    ui.toast('Looking for the batch…', 30000);
    try {
      manifest = await fetchManifest(code);
      await saveSettings({ intake: { ...settings.intake, lastCode: code } });
      ui.toast('');
      await prepare();
    } catch (err) {
      ui.toast('');
      ui.alert('Could not fetch the batch', err.message);
    } finally {
      busy = false; paint();
    }
  }

  /** Work out the best target for every incoming section, before showing it. */
  async function prepare() {
    projects = await listProjects();
    projectName = manifest.project?.name || 'Telegram batch';

    // Default to a project whose name matches the batch, if there is one.
    const hit = projects.find((p) => (p.name || '').toUpperCase() === projectName.toUpperCase());
    target = hit ? hit.id : NEW_PROJECT;
    await remap();
    paint();
  }

  /**
   * Map each incoming section onto the target project's existing sections, then
   * onto the section library. Anything unmatched keeps its own name and will be
   * created — never silently merged into something close-but-wrong.
   */
  async function remap() {
    const existing = target === NEW_PROJECT ? [] : (await listSections(target)).map((s) => s.title);
    const candidates = [...new Set([...existing, ...(settings.sectionLib || [])])];
    mapping = new Map();
    for (const s of manifest.sections) {
      const m = matchSection(s.title, candidates);
      mapping.set(s.title, m ? m.title : s.title.toUpperCase());
    }
  }

  /* ---------------- the import itself ---------------- */

  async function runImport() {
    const sections = manifest.sections.filter((s) => mapping.get(s.title) !== SKIP);
    const total = sections.reduce((n, s) => n + s.photos.length, 0);
    if (!total) return ui.toast('Nothing selected to import');

    const ok = await ui.confirm('Import now?',
      `${total} photo${total === 1 ? '' : 's'} into ${target === NEW_PROJECT ? projectName : (projects.find((p) => p.id === target) || {}).name}.`,
      { okLabel: 'Import' });
    if (!ok) return;

    busy = true; paint();
    let projectId = target;
    try {
      if (projectId === NEW_PROJECT) {
        const p = await createProject({
          name: projectName,
          inspector: settings.preparedBy || '',
          inspectionDate: new Date(manifest.closedAt || Date.now()).toISOString().slice(0, 10),
        });
        projectId = p.id;
      }

      // Reuse a section of the same name rather than making a second one.
      const bySection = new Map((await listSections(projectId)).map((s) => [s.title.toUpperCase(), s]));
      let done = 0;
      const failed = [];

      for (const incoming of sections) {
        const title = mapping.get(incoming.title);
        let section = bySection.get(title.toUpperCase());
        if (!section) {
          section = await createSection(projectId, title);
          bySection.set(section.title.toUpperCase(), section);
        }

        for (const photo of incoming.photos) {
          ui.toast(`Importing ${done + 1} of ${total}…`, 60000);
          try {
            const blob = await fetchPhoto(manifest.code, photo.id);
            // Straight down the normal ingest path, so a Telegram photo is
            // stored exactly like one taken in the app — same downscale, same
            // thumbnail, same EXIF read when the original survived.
            const { blob: stored, thumb, meta } = await ingest(
              new File([blob], `tg-${photo.id}.jpg`, { type: blob.type || 'image/jpeg' }),
              { maxPx: settings.imageMaxPx, quality: settings.imageQuality },
            );
            const added = await addPhoto(projectId, section.id, stored, thumb, {
              ...meta,
              // A compressed Telegram photo has no EXIF, so ingest falls back to
              // "now" — the send time the bot recorded is much closer to true.
              takenAt: meta.takenSource === 'exif' ? meta.takenAt : photo.takenAt,
              takenSource: meta.takenSource === 'exif' ? 'exif' : 'telegram',
              source: 'telegram',
              name: `tg-${photo.id}.jpg`,
            });
            if (photo.caption) await updatePhoto(added.id, { caption: photo.caption });
          } catch (err) {
            console.error(err);
            failed.push(photo.id);
          }
          done++;
        }
      }

      ui.toast('');
      if (failed.length) {
        await ui.alert('Imported with gaps',
          `${done - failed.length} of ${total} photos landed. ${failed.length} could not be fetched — `
          + 'the code still works, so you can run the import again for the rest.');
      } else {
        // Only drop the batch from the bot once every photo is safely here.
        await claimBatch(manifest.code);
        ui.toast(`${total} photo${total === 1 ? '' : 's'} imported`, 2600);
      }
      go(`#/project/${projectId}`);
    } catch (err) {
      console.error(err);
      ui.toast('');
      ui.alert('Import failed', err.message);
    } finally {
      busy = false;
    }
  }

  /* ---------------- painting ---------------- */

  async function pickTarget() {
    const actions = [
      { label: `New project — ${projectName}`, value: NEW_PROJECT, icon: 'plus' },
      ...projects.slice(0, 12).map((p) => ({ label: p.name || 'Untitled', value: p.id })),
    ];
    const choice = await ui.actionSheet('Import into', actions);
    if (!choice) return;
    target = choice;
    await remap();
    paint();
  }

  async function pickSection(incoming) {
    const existing = target === NEW_PROJECT ? [] : (await listSections(target)).map((s) => s.title);
    const lib = (settings.sectionLib || []).filter((t) => !existing.includes(t));
    const current = mapping.get(incoming.title);
    const actions = [
      { label: `Create "${incoming.title.toUpperCase()}"`, value: incoming.title.toUpperCase(), icon: 'plus' },
      ...existing.map((t) => ({ label: t, value: t })),
      ...lib.slice(0, 10).map((t) => ({ label: `${t} (from template)`, value: t })),
      { label: 'Skip these photos', value: SKIP, destructive: true },
    ].filter((a, i, all) => all.findIndex((x) => x.value === a.value) === i);
    const choice = await ui.actionSheet(`${incoming.title} — ${incoming.photos.length} photo(s)`, actions);
    if (!choice) return;
    mapping.set(incoming.title, choice);
    paint();
    return current;
  }

  function paint() {
    ui.clear(body);

    if (!manifest) {
      const field = ui.h('input', {
        type: 'text', value: code, placeholder: 'e.g. K7M2P4QX',
        autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => {
          code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
          e.target.value = code;
        },
      });
      body.appendChild(ui.group('Import code', [
        ui.h('label', { class: 'row' }, ui.h('span', { class: 'row-title', text: 'Code' }), field),
      ]));
      body.appendChild(ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn primary wide', text: busy ? 'Looking…' : 'Fetch batch',
          disabled: busy, onclick: pull,
        }),
        ui.h('button', {
          class: 'btn tinted wide', text: 'Open a batch file instead',
          onclick: () => fileInput.click(),
        })));
      body.appendChild(ui.h('div', { class: 'hint',
        text: 'The bot replies with a code when someone types /done in the Telegram group. '
          + 'Nothing is added to a project until you have checked the sections on the next screen.' }));
      return;
    }

    const total = manifest.sections.reduce((n, s) => n + s.photos.length, 0);
    const captioned = manifest.sections.reduce(
      (n, s) => n + s.photos.filter((p) => p.caption).length, 0);
    const keeping = manifest.sections
      .filter((s) => mapping.get(s.title) !== SKIP)
      .reduce((n, s) => n + s.photos.length, 0);

    // Captioning runs on the bot after /done, so a batch fetched straight away
    // can still be part-written. Nothing blocks on it — the count is shown and
    // importing anyway is a normal choice.
    const pending = Number(manifest.pending || 0);

    body.appendChild(ui.group('Batch', [
      ui.row({ title: manifest.project?.name || 'Unnamed', sub: `${total} photos · ${captioned} captioned` }),
      ...(pending ? [ui.row({
        title: `${pending} caption${pending === 1 ? '' : 's'} still being written`,
        sub: 'Tap to check again — or import now and caption in the app',
        iconName: 'sparkle', iconColor: 'var(--sys-indigo)',
        onclick: pull,
      })] : []),
      ui.row({
        title: 'Import into',
        sub: target === NEW_PROJECT ? `New project — ${projectName}` : (projects.find((p) => p.id === target) || {}).name,
        chevron: true,
        onclick: pickTarget,
      }),
      ...(target === NEW_PROJECT
        ? [ui.inputRow('Project name', projectName, (v) => { projectName = v; })]
        : []),
    ]));

    body.appendChild(ui.group('Sections', manifest.sections.map((s) => {
      const to = mapping.get(s.title);
      const skipped = to === SKIP;
      const renamed = !skipped && to.toUpperCase() !== s.title.toUpperCase();
      return ui.row({
        title: s.title,
        sub: skipped ? 'Skipped'
          : renamed ? `${s.photos.length} photo(s) → ${to}`
            : `${s.photos.length} photo(s)`,
        chevron: true,
        onclick: () => pickSection(s),
      });
    })));

    body.appendChild(ui.h('div', { class: 'hint',
      text: 'The timestamp printed on each photo is the record. The time stored here is the '
        + 'original send time, used only for ordering — the project screen can move a whole '
        + 'batch onto the inspection date if it lands on the wrong day.' }));

    body.appendChild(ui.h('div', { class: 'btn-stack' },
      ui.h('button', {
        class: 'btn primary wide',
        text: busy ? 'Importing…' : `Import ${keeping} photo${keeping === 1 ? '' : 's'}`,
        disabled: busy || !keeping,
        onclick: runImport,
      }),
      ui.h('button', {
        class: 'btn wide', text: 'Use a different code', disabled: busy,
        onclick: () => { manifest = null; paint(); },
      })));
  }

  paint();
  if (initialCode) await pull();
  return screen;
}

/** Entry point from elsewhere in the app. */
export function openInbox(code = '') {
  go(code ? `#/inbox/${encodeURIComponent(code)}` : '#/inbox');
}
