// Import a Telegram batch. Dropped from the capture build — see tools/build.mjs.
//
// The point of this screen is that nothing is written until the user says so:
// the batch is described first, the section mapping is shown already worked out
// but still editable, and only then does anything reach the database.
import * as ui from '../ui.js';
import { go } from '../app.js';
import {
  getSettings, saveSettings, listProjects, createProject, getProject,
  listSections, createSection, addPhoto, updatePhoto, listProjectPhotos,
  noteCaptionUse, getBlob,
} from '../store.js';
import { matchSection } from '../captions.js';
import { ingest } from '../image.js';
import { fetchManifest, fetchPhoto, claimBatch, readManifestFile } from '../intake.js';
import { suggestCaptionsBatch, aiReady } from '../assist.js';

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
  let alreadyHere = 0;        // photos of this batch the target project already has
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
    alreadyHere = target === NEW_PROJECT ? 0 : await countAlreadyHere(target);
    const existing = target === NEW_PROJECT ? [] : (await listSections(target)).map((s) => s.title);
    const candidates = [...new Set([...existing, ...(settings.sectionLib || [])])];
    mapping = new Map();
    for (const s of manifest.sections) {
      const m = matchSection(s.title, candidates);
      mapping.set(s.title, m ? m.title : s.title.toUpperCase());
    }
  }

  /** How much of this batch is already in that project, from an earlier run. */
  async function countAlreadyHere(projectId) {
    const have = new Set((await listProjectPhotos(projectId))
      .map((p) => p.meta && p.meta.intake)
      .filter((i) => i && i.code === manifest.code)
      .map((i) => String(i.id)));
    return manifest.sections
      .flatMap((s) => s.photos)
      .filter((p) => have.has(String(p.id))).length;
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
      // Every photo remembers the batch and message it came from, so importing
      // the same code again tops up what is missing instead of doubling it.
      // That is what makes a run interrupted halfway — a dropped connection, a
      // phone that slept, a tab the browser reclaimed — safe to simply repeat.
      const already = new Set((await listProjectPhotos(projectId))
        .map((p) => p.meta && p.meta.intake)
        .filter(Boolean)
        .map((i) => `${i.code}:${i.id}`));
      let done = 0;
      let skipped = 0;
      const failed = [];
      // What will need writing up, grouped later by room: the bot brings the
      // photos and whatever the site team typed, and nothing else.
      const uncaptioned = [];

      for (const incoming of sections) {
        const title = mapping.get(incoming.title);
        let section = bySection.get(title.toUpperCase());
        if (!section) {
          section = await createSection(projectId, title);
          bySection.set(section.title.toUpperCase(), section);
        }

        for (const photo of incoming.photos) {
          if (already.has(`${manifest.code}:${photo.id}`)) { skipped++; done++; continue; }
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
              intake: { code: manifest.code, id: photo.id },
              name: `tg-${photo.id}.jpg`,
            });
            if (photo.caption) await updatePhoto(added.id, { caption: photo.caption });
            else uncaptioned.push({ id: added.id, blobId: added.blobId, sectionTitle: section.title });
          } catch (err) {
            console.error(err);
            failed.push(photo.id);
          }
          done++;
        }
      }

      ui.toast('');
      const landed = done - failed.length - skipped;
      if (failed.length) {
        await ui.alert('Imported with gaps',
          `${landed} photo${landed === 1 ? '' : 's'} added${skipped ? `, ${skipped} already here` : ''}. `
          + `${failed.length} could not be fetched.\n\n`
          + 'Run the import again with the same code — the ones already in are skipped, '
          + 'so only the missing ones come down.');
      } else {
        // Only drop the batch from the bot once every photo is safely here.
        await claimBatch(manifest.code);
        ui.toast(skipped
          ? `${landed} added, ${skipped} already here`
          : `${total} photo${total === 1 ? '' : 's'} imported`, 2600);
      }
      await offerCaptions(uncaptioned);
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

  /**
   * Write up what just landed, if the office wants it now.
   *
   * Captioning used to happen on the Worker before the photos ever reached the
   * app, which meant a second AI setup nobody could see into when it stopped.
   * Here the model is the same one the rest of the app uses, the progress is
   * visible, and a failure costs nothing: the photos are already imported and
   * every section still has its own caption button.
   */
  async function offerCaptions(list) {
    if (!list.length || !(await aiReady())) return;
    const ok = await ui.confirm('Write the captions?',
      `${list.length} photo${list.length === 1 ? '' : 's'} came in without one. `
      + 'The assistant can draft them now — you review and edit afterwards.',
      { okLabel: 'Caption them' });
    if (!ok) return;

    // Room by room: the section name is most of what makes a caption right, and
    // it is what the library is ranked against.
    const byRoom = new Map();
    for (const p of list) {
      if (!byRoom.has(p.sectionTitle)) byRoom.set(p.sectionTitle, []);
      byRoom.get(p.sectionTitle).push(p);
    }

    let saved = 0;
    const total = list.length;
    try {
      for (const [title, group] of byRoom) {
        const items = [];
        for (const p of group) items.push({ id: p.id, blob: await getBlob(p.blobId) });
        await suggestCaptionsBatch(items, {
          sectionTitle: title,
          // Written as each batch lands, so stopping part-way never throws away
          // the captions already paid for.
          onProgress: async (_done, _n, results, start) => {
            for (let i = 0; i < results.length; i++) {
              const text = results[i].text;
              if (!text) continue;
              await updatePhoto(items[start + i].id, { caption: text });
              await noteCaptionUse(text, title);
              saved++;
            }
            ui.toast(`Captioning ${saved} of ${total}\u2026`, 120000);
          },
        });
      }
      ui.toast(saved ? `${saved} caption(s) drafted \u2014 review before reporting` : 'No captions returned', 3000);
    } catch (err) {
      ui.toast(saved
        ? `Stopped after ${saved} \u2014 ${err.message}`
        : (err.message || 'The assistant is unavailable'), 5000);
    }
  }

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
    // Only the captions the site team typed in Telegram. The bot does not write
    // any: captioning is the app's job, offered once the photos are in.
    const typed = manifest.sections.reduce(
      (n, s) => n + s.photos.filter((p) => p.caption).length, 0);
    // What the button will actually add: selected sections, less anything a
    // previous run already brought in.
    const keeping = Math.max(0, manifest.sections
      .filter((s) => mapping.get(s.title) !== SKIP)
      .reduce((n, s) => n + s.photos.length, 0) - alreadyHere);

    body.appendChild(ui.group('Batch', [
      ui.row({
        title: manifest.project?.name || 'Unnamed',
        sub: typed ? `${total} photos · ${typed} already captioned` : `${total} photos`,
      }),
      ...(alreadyHere ? [ui.row({
        title: `${alreadyHere} already in this project`,
        sub: `Only the remaining ${total - alreadyHere} will be added`,
        iconName: 'check', iconColor: 'var(--sys-green)',
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
        text: busy ? 'Importing…'
          : keeping ? `Import ${keeping} photo${keeping === 1 ? '' : 's'}`
            : 'Nothing left to import',
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
