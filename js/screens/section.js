import * as ui from '../ui.js';
import { go, back } from '../app.js';
import {
  getProject, listSections, listPhotos, addPhoto, updatePhoto, deletePhoto,
  reorderPhotos, movePhotos, getBlob, getSettings, noteCaptionUse, displayBlobId, updateSection,
  photoTakenAt,
} from '../store.js';
import * as db from '../db.js';
import { ingest, blobUrl, stampedCopy } from '../image.js';
import { rankCaptions, searchCaptions } from '../captions.js';
import { openEditor } from './annotate.js';
import { suggestCaption, suggestCaptionsBatch, aiReady, aiEnabled } from '../assist.js';

export default async function renderSection(sectionId) {
  const section = await db.get(db.STORES.sections, sectionId);
  if (!section) {
    return ui.h('div', { class: 'screen' },
      ui.navbar({ title: 'Section', left: ui.backBtn(back) }),
      ui.empty('photos', 'Section not found', '', 'Projects', () => go('#/projects')));
  }
  const project = await getProject(section.projectId);
  const settings = await getSettings();

  const screen = ui.h('div', { class: 'screen' });
  const grid = ui.h('div', { class: 'pgrid' });
  const bodyScroll = ui.h('div', { class: 'scroll' });
  let photos = [];
  let selectMode = false;
  const selected = new Set();

  /* ---------------- hidden file inputs ---------------- */
  const camInput = ui.h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, onchange: (e) => importFiles(e.target.files, true) });
  const libInput = ui.h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: (e) => importFiles(e.target.files, false) });
  screen.append(camInput, libInput);

  const navRight = ui.h('span', { style: { display: 'flex' } },
    ui.navBtn('', () => toggleSelect(), { icon: 'check' }),
    ui.navBtn('', sectionMenu, { icon: 'more' }));

  const bar = ui.navbar({
    title: section.title,
    sub: project ? project.name : '',
    left: ui.backBtn(() => go('#/project/' + section.projectId), 'Project'),
    right: navRight,
  });
  screen.appendChild(bar);
  screen.appendChild(bodyScroll);
  bodyScroll.appendChild(grid);

  /* ---------------- bottom action bar ---------------- */
  const actions = ui.h('div', { class: 'btn-stack' },
    ui.h('button', { class: 'btn wide', onclick: () => camInput.click() }, ui.icon('camera', 20), ui.h('span', { text: 'Take Photo' })),
    ui.h('button', { class: 'btn tinted wide', onclick: () => libInput.click() }, ui.icon('photos', 20), ui.h('span', { text: 'Add from Library' })));
  bodyScroll.appendChild(actions);

  const selectBar = ui.h('div', { class: 'btn-stack', hidden: true });
  bodyScroll.appendChild(selectBar);

  /* ---------------- import ---------------- */
  async function importFiles(fileList, fromCamera) {
    const files = [...fileList];
    if (!files.length) return;
    ui.toast(`Processing ${files.length} photo${files.length === 1 ? '' : 's'}…`, 60000);
    const added = [];
    for (const f of files) {
      try {
        const { blob, thumb, meta } = await ingest(f, {
          maxPx: settings.imageMaxPx, quality: settings.imageQuality,
        });
        added.push(await addPhoto(section.projectId, sectionId, blob, thumb, { ...meta, fromCamera: !!fromCamera, name: f.name }));
      } catch (err) {
        console.error(err);
        ui.toast('Could not read ' + (f.name || 'a photo'));
      }
    }
    camInput.value = ''; libInput.value = '';
    ui.toast(`${added.length} photo${added.length === 1 ? '' : 's'} added`);
    await paint();
    if (added.length === 1) openCaption(added[0]);
    else if (added.length > 1) offerBatchCaption(added);
  }

  async function offerBatchCaption(added) {
    const ready = aiEnabled && await aiReady();
    const choice = await ui.actionSheet(`${added.length} photos added`, [
      ready ? { label: 'AI caption all', value: 'ai', icon: 'sparkle', color: 'var(--sys-indigo)', sub: 'Suggests a caption for each photo' } : null,
      { label: 'Caption one by one', value: 'one', icon: 'pencil', color: 'var(--sys-blue)', primary: true },
      { label: 'Apply one caption to all', value: 'same', icon: 'list', color: 'var(--sys-teal)' },
      { label: 'Later', value: null },
    ].filter(Boolean));
    if (choice === 'one') await captionQueue(added);
    if (choice === 'same') {
      const text = await pickCaption('Caption for all');
      if (text != null) {
        for (const p of added) await updatePhoto(p.id, { caption: text });
        await noteCaptionUse(text, section.title);
        paint();
      }
    }
    if (choice === 'ai') await aiCaptionMany(added);
  }

  async function captionQueue(queue) {
    for (const p of queue) {
      const cont = await openCaption(p, { queue: true });
      if (cont === false) break;
    }
  }

  async function aiCaptionMany(list, { redo = false } = {}) {
    let queue = redo ? list : list.filter((p) => !p.caption);
    if (!queue.length) {
      const ok = await ui.confirm('Already captioned', 'Replace the existing captions with new suggestions?', { okLabel: 'Replace' });
      if (!ok) return;
      queue = list;
    }
    ui.toast(`Captioning 0 of ${queue.length}…`, 120000);
    const items = [];
    for (const p of queue) items.push({ id: p.id, blob: await getBlob(p.blobId) });
    let saved = 0;
    try {
      await suggestCaptionsBatch(items, {
        sectionTitle: section.title,
        // Captions are written as each batch lands, so a rate limit part-way
        // through never throws away the work already done.
        onProgress: async (done, total, results, start) => {
          for (let i = 0; i < results.length; i++) {
            const text = results[i].text;
            if (!text) continue;
            await updatePhoto(items[start + i].id, { caption: text });
            await noteCaptionUse(text, section.title);
            saved++;
          }
          ui.toast(`Captioning ${done} of ${total}…`, 120000);
          paint();
        },
      });
      ui.toast(saved ? `${saved} caption(s) suggested — review before reporting` : 'No captions returned');
    } catch (err) {
      ui.toast(saved ? `Stopped after ${saved} — ${err.message}` : (err.message || 'AI unavailable'), 4000);
    }
    paint();
  }

  /* ---------------- caption picker ---------------- */
  function pickCaption(title, current = '') {
    return new Promise((resolve) => {
      let value = current;
      const ta = ui.h('textarea', {
        class: 'cap-input', placeholder: 'Type to search captions, or write your own',
        autocapitalize: 'characters', spellcheck: 'false',
        oninput: (e) => { value = e.target.value; },
      });
      ta.value = current;
      ui.autocomplete(ta, {
        source: (q) => searchCaptions(settings.captionLib, settings.usage, section.title, q),
        onPick: (item) => { value = item.text; ta.value = item.text; },
      });
      const ranked = rankCaptions(settings.captionLib, settings.usage, section.title, 12);
      const quick = ui.h('div', { class: 'chips' },
        ...ranked.map((c) => ui.h('button', {
          class: 'chip', text: c.text.replace(/\n/g, ' · '),
          onclick: () => { value = c.text; ta.value = c.text; ui.haptic(); },
        })));
      const groups = settings.captionLib.map((g) => ui.h('div', {},
        ui.h('div', { class: 'group-title', style: { paddingTop: '10px' }, text: g.group }),
        ui.h('div', { class: 'chips', style: { paddingTop: '0' } },
          ...g.items.map((t) => ui.h('button', {
            class: 'chip', text: t.replace(/\n/g, ' · '),
            onclick: () => { value = t; ta.value = t; ui.haptic(); },
          })))));
      const body = ui.h('div', {}, ta, ui.h('div', { class: 'group-title', style: { paddingTop: '12px' }, text: 'Suggested' }), quick, ...groups);
      ui.sheet({
        title, body, rightLabel: 'Use',
        onRight: () => resolve(value.trim()),
        onClose: () => resolve(null),
      });
    });
  }

  /* ---------------- single photo caption sheet ---------------- */
  async function openCaption(photo, { queue = false } = {}) {
    const fresh = await db.get(db.STORES.photos, photo.id);
    if (!fresh) return true;
    const blob = await getBlob(displayBlobId(fresh));
    let caption = fresh.caption || '';
    let caption2 = fresh.caption2 || '';
    let result = true;
    let saved = false;

    const img = ui.h('img', { class: 'cap-preview', src: blobUrl(displayBlobId(fresh) + ':cap', blob) });
    const ta = ui.h('textarea', {
      class: 'cap-input', placeholder: 'Type to search captions, or write your own',
      autocapitalize: 'characters', spellcheck: 'false',
      oninput: (e) => { caption = e.target.value; },
    });
    ta.value = caption;
    // Type-ahead over the library: two or three letters is usually enough.
    ui.autocomplete(ta, {
      source: (q) => searchCaptions(settings.captionLib, settings.usage, section.title, q),
      onPick: (item) => {
        const lines = ta.value.split('\n');
        lines[lines.length - 1] = item.text;      // replace only what was being typed
        caption = lines.join('\n');
        ta.value = caption;
      },
    });
    const ta2 = ui.h('textarea', { class: 'cap-input', style: { minHeight: '48px', fontSize: '14px' }, placeholder: 'Second line (optional) — e.g. address or note', oninput: (e) => { caption2 = e.target.value; } });
    ta2.value = caption2;

    const ranked = rankCaptions(settings.captionLib, settings.usage, section.title, 14);
    const setCap = (t) => { caption = t; ta.value = t; ui.haptic(); };
    const quick = ui.h('div', { class: 'chips' },
      ...ranked.map((c) => ui.h('button', { class: 'chip' + (/- OK|NO DEFECT/.test(c.text) ? ' ok' : ''), text: c.text.replace(/\n/g, ' · '), onclick: () => setCap(c.text) })));

    const groups = settings.captionLib.map((g) => ui.h('div', {},
      ui.h('div', { class: 'group-title', style: { paddingTop: '10px' }, text: g.group }),
      ui.h('div', { class: 'chips', style: { paddingTop: '0' } },
        ...g.items.map((t) => ui.h('button', { class: 'chip', text: t.replace(/\n/g, ' · '), onclick: () => setCap(t) })))));

    const aiBtn = !aiEnabled ? null : ui.h('button', {
      class: 'btn tinted wide',
      onclick: async () => {
        aiBtn.disabled = true;
        const label = aiBtn.querySelector('span');
        const old = label.textContent;
        label.textContent = 'Thinking…';
        try {
          const r = await suggestCaption(blob, { sectionTitle: section.title });
          if (r.text) { setCap(r.text); if (r.offline) ui.toast('Offline suggestion from your library'); }
          else ui.toast('No suggestion available');
        } catch (err) { ui.toast(err.message); }
        label.textContent = old;
        aiBtn.disabled = false;
      },
    }, ui.icon('sparkle', 20), ui.h('span', { text: 'Suggest caption' }));
    if (aiBtn) aiBtn.dataset.role = 'suggest';

    const stampRow = ui.row({
      title: 'Captured',
      value: ui.formatStamp(photoTakenAt(fresh), settings.stampFormat) || 'Unknown',
      sub: { exif: 'From the photo (EXIF)', file: 'From the photo file', now: 'Import time — check this' }[fresh.takenSource] || '',
      chevron: true,
      onclick: () => editTakenAt(fresh, stampRow),
    });

    const body = ui.h('div', {},
      img,
      ui.h('div', { class: 'list', style: { margin: '12px 12px 0' } }, stampRow),
      ui.h('div', { class: 'group-title', style: { paddingTop: '12px' }, text: 'Caption' }), ta,
      ta2,
      ui.h('div', { class: 'btn-stack' },
        aiBtn,
        ui.h('button', {
          class: 'btn gray wide',
          onclick: async () => { sh.close(); await annotate(fresh); },
        }, ui.icon('pencil', 20), ui.h('span', { text: 'Annotate photo' }))),
      ui.h('div', { class: 'group-title', text: 'Suggested' }), quick,
      ...groups,
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn danger wide', text: 'Delete photo',
          onclick: async () => {
            const ok = await ui.confirm('Delete photo?', '', { okLabel: 'Delete', destructive: true });
            if (ok) { await deletePhoto(fresh.id); sh.close(); paint(); }
          },
        })));

    const sh = ui.sheet({
      title: queue ? 'Caption Photo' : 'Photo',
      body,
      leftLabel: queue ? 'Stop' : 'Cancel',
      rightLabel: queue ? 'Next' : 'Save',
      onRight: async () => {
        saved = true;
        await updatePhoto(fresh.id, { caption: caption.trim(), caption2: caption2.trim() });
        if (caption.trim()) await noteCaptionUse(caption.trim(), section.title);
        await paint();
      },
      onClose: () => { if (queue && !saved) result = false; },
    });

    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!document.body.contains(sh.el)) { obs.disconnect(); resolve(result); }
      });
      obs.observe(document.getElementById('sheet-host'), { childList: true });
    });
  }

  /* ---------------- capture time ---------------- */
  function editTakenAt(photo, rowEl) {
    const field = ui.h('input', { type: 'datetime-local', style: { width: '100%' } });
    field.value = ui.toLocalInput(photoTakenAt(photo));
    const body = ui.h('div', {},
      ui.h('div', { class: 'hint', text: 'Read from the photo itself where possible. Correct it here if the camera clock was wrong.' }),
      ui.group('', [ui.h('div', { class: 'row stack' }, ui.h('label', { text: 'Date and time' }), field)]),
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn gray wide', text: 'Use this device\u2019s time now',
          onclick: () => { field.value = ui.toLocalInput(Date.now()); },
        })));
    ui.sheet({
      title: 'Capture Time', body, rightLabel: 'Save',
      onRight: async () => {
        const ts = field.value ? new Date(field.value).getTime() : null;
        if (!ts || Number.isNaN(ts)) { ui.toast('Enter a valid date and time'); return false; }
        const next = await updatePhoto(photo.id, { takenAt: ts, takenSource: 'manual' });
        photo.takenAt = ts;
        photo.takenSource = 'manual';
        if (rowEl) {
          rowEl.querySelector('.r-val').textContent = ui.formatStamp(ts, settings.stampFormat);
          const sub = rowEl.querySelector('.r-sub');
          if (sub) sub.textContent = 'Set by hand';
        }
        void next;
        ui.toast('Capture time saved');
        paint();
      },
    });
  }

  /* ---------------- annotate ---------------- */
  async function annotate(photo) {
    const src = await getBlob(photo.blobId);
    await openEditor({
      blob: src,
      ops: photo.ops || [],
      title: section.title,
      onSave: async (ops, flatBlob) => {
        let flatId = photo.flatBlobId;
        if (flatId) await db.del(db.STORES.blobs, flatId);
        flatId = null;
        if (ops.length) {
          flatId = db.uid('blb');
          await db.put(db.STORES.blobs, { id: flatId, blob: flatBlob });
        }
        await updatePhoto(photo.id, { ops, flatBlobId: flatId });
        ui.toast('Annotation saved');
        await paint();
      },
    });
  }

  /* ---------------- select mode ---------------- */
  function toggleSelect(force) {
    selectMode = force !== undefined ? force : !selectMode;
    selected.clear();
    paintSelectBar();
    paint();
  }

  function paintSelectBar() {
    ui.clear(selectBar);
    selectBar.hidden = !selectMode;
    actions.hidden = selectMode;
    if (!selectMode) return;
    const n = selected.size;
    selectBar.append(
      ui.h('div', { class: 'hint', style: { textAlign: 'center' }, text: n ? `${n} selected` : 'Tap photos to select' }),
      ui.h('button', { class: 'btn wide', disabled: !n, text: 'Apply caption to selected', onclick: applyCaptionToSelected }),
      ui.h('button', { class: 'btn tinted wide', disabled: !n, text: 'Move to another section', onclick: moveSelected }),
      aiEnabled ? ui.h('button', { class: 'btn gray wide', disabled: !n, text: 'AI caption selected', onclick: async () => {
        const list = photos.filter((p) => selected.has(p.id));
        if (!(await aiReady())) { ui.toast('Turn on the AI assistant in Settings'); return; }
        await aiCaptionMany(list); toggleSelect(false);
      } }) : null,
      ui.h('button', { class: 'btn danger wide', disabled: !n, text: 'Delete selected', onclick: deleteSelected }),
      ui.h('button', { class: 'btn gray wide', text: 'Done', onclick: () => toggleSelect(false) }));
  }

  async function applyCaptionToSelected() {
    const text = await pickCaption(`Caption ${selected.size} photo(s)`);
    if (text == null) return;
    for (const id of selected) await updatePhoto(id, { caption: text });
    if (text) await noteCaptionUse(text, section.title);
    toggleSelect(false);
    ui.toast('Caption applied');
  }

  async function moveSelected() {
    const sections = (await listSections(section.projectId)).filter((s) => s.id !== sectionId);
    if (!sections.length) { ui.toast('No other section to move to'); return; }
    const target = await ui.actionSheet('Move to', sections.map((s) => ({ label: s.title, value: s.id, icon: 'photos', color: 'var(--sys-blue)' })));
    if (!target) return;
    await movePhotos([...selected], target);
    toggleSelect(false);
    ui.toast('Moved');
  }

  async function deleteSelected() {
    const ok = await ui.confirm(`Delete ${selected.size} photo(s)?`, 'This cannot be undone.', { okLabel: 'Delete', destructive: true });
    if (!ok) return;
    for (const id of selected) await deletePhoto(id);
    toggleSelect(false);
    ui.toast('Deleted');
  }

  /* ---------------- section menu ---------------- */
  async function sectionMenu() {
    const choice = await ui.actionSheet(section.title, [
      { label: 'Rename section', value: 'ren', icon: 'pencil', color: 'var(--sys-gray)' },
      { label: 'Reorder photos', value: 'order', icon: 'move', color: 'var(--sys-teal)' },
      { label: 'Caption every uncaptioned photo', value: 'fill', icon: 'list', color: 'var(--sys-blue)' },
      { label: 'Share photos', value: 'share', icon: 'share', color: 'var(--sys-green)' },
    ]);
    if (choice === 'ren') {
      const t = await ui.prompt('Rename Section', '', section.title);
      if (t && t.trim()) {
        await updateSection(sectionId, { title: t.trim() });
        section.title = t.trim().toUpperCase();
        bar.querySelector('.navbar-title').textContent = section.title;
      }
    }
    if (choice === 'order') reorderSheet();
    if (choice === 'fill') {
      const missing = photos.filter((p) => !p.caption);
      if (!missing.length) { ui.toast('All photos captioned'); return; }
      await captionQueue(missing);
    }
    if (choice === 'share') sharePhotos();
  }

  async function reorderSheet() {
    const order = photos.map((p) => p.id);
    const list = ui.h('div', { class: 'list', style: { margin: '10px 12px' } });
    function paintList() {
      ui.clear(list);
      order.forEach((pid, i) => {
        const p = photos.find((x) => x.id === pid);
        list.appendChild(ui.row({
          title: `${i + 1}. ${p.caption ? p.caption.split('\n')[0] : 'Uncaptioned'}`,
          right: ui.h('span', { style: { display: 'flex', gap: '4px' } },
            ui.h('button', { class: 'nb-btn', onclick: () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; paintList(); } } }, ui.icon('up', 20)),
            ui.h('button', { class: 'nb-btn', onclick: () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; paintList(); } } }, ui.icon('down', 20))),
        }));
      });
    }
    paintList();
    ui.sheet({ title: 'Reorder Photos', body: list, rightLabel: 'Save', onRight: async () => { await reorderPhotos(sectionId, order); paint(); } });
  }

  async function sharePhotos() {
    if (!navigator.share) { ui.toast('Sharing is not supported in this browser'); return; }
    const burn = settings.stampEnabled !== false && settings.stampInShare !== false;
    const files = [];
    for (const p of photos.slice(0, 12)) {
      let b = await getBlob(displayBlobId(p));
      if (!b) continue;
      if (burn) {
        // The report draws its own stamp, so only shared copies get one burned in.
        const text = ui.formatStamp(photoTakenAt(p), settings.stampFormat);
        if (text) b = await stampedCopy(b, text, { position: settings.stampPosition || 'br' });
      }
      files.push(new File([b], `${section.title}-${(p.caption || 'photo').replace(/[^\w]+/g, '-').slice(0, 30)}.jpg`, { type: 'image/jpeg' }));
    }
    if (!files.length) { ui.toast('No photos to share'); return; }
    try { await navigator.share({ files, title: section.title }); }
    catch (err) { if (err.name !== 'AbortError') ui.toast('Share failed'); }
  }

  /* ---------------- grid ---------------- */
  async function paint() {
    photos = await listPhotos(sectionId);
    ui.clear(grid);
    if (!photos.length) {
      grid.appendChild(ui.empty('camera', 'No photos yet',
        'Take a photo or add from your library. Captions can be picked in one tap.', 'Take Photo', () => camInput.click()));
      paintSelectBar();
      return;
    }
    photos.forEach((p, i) => {
      const cell = ui.h('div', { class: 'pcell' + (selected.has(p.id) ? ' sel' : '') });
      const img = ui.h('img', { loading: 'lazy', alt: p.caption || 'photo' });
      cell.appendChild(img);
      getBlob(p.thumbId || displayBlobId(p)).then((b) => { if (b) img.src = blobUrl((p.thumbId || p.blobId) + ':t', b); });
      cell.appendChild(ui.h('div', { class: 'num', text: String(i + 1) }));
      if (p.ops && p.ops.length) cell.appendChild(ui.h('div', { class: 'badge' }, ui.icon('pencil', 12)));
      const stamp = ui.formatStamp(photoTakenAt(p), 'dmy24');
      cell.appendChild(ui.h('div', { class: 'cap' },
        ui.h('div', { text: p.caption ? p.caption.replace(/\n/g, ' · ') : 'Tap to caption' }),
        stamp ? ui.h('div', { class: 'cap-time', text: stamp.split(' ')[1] }) : null));
      cell.addEventListener('click', () => {
        if (selectMode) {
          if (selected.has(p.id)) selected.delete(p.id); else selected.add(p.id);
          cell.classList.toggle('sel');
          paintSelectBar();
        } else {
          openCaption(p);
        }
      });
      let timer = null;
      cell.addEventListener('pointerdown', () => {
        timer = setTimeout(async () => {
          ui.haptic(14);
          const c = await ui.actionSheet(p.caption || `Photo ${i + 1}`, [
            { label: 'Caption', value: 'cap', icon: 'pencil', color: 'var(--sys-blue)', primary: true },
            { label: 'Annotate', value: 'ann', icon: 'pencil', color: 'var(--sys-orange)' },
            { label: 'Select multiple', value: 'sel', icon: 'check', color: 'var(--sys-gray)' },
            { label: 'Delete', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
          ]);
          if (c === 'cap') openCaption(p);
          if (c === 'ann') annotate(p);
          if (c === 'sel') { toggleSelect(true); selected.add(p.id); paintSelectBar(); paint(); }
          if (c === 'del') {
            const ok = await ui.confirm('Delete photo?', '', { okLabel: 'Delete', destructive: true });
            if (ok) { await deletePhoto(p.id); paint(); }
          }
        }, 550);
      });
      ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) => cell.addEventListener(ev, () => clearTimeout(timer)));
      cell.addEventListener('contextmenu', (e) => e.preventDefault());
      grid.appendChild(cell);
    });
    paintSelectBar();
  }

  await paint();
  return screen;
}
