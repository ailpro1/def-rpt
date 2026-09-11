// Caption and section library. Everything a user taps on site comes from here,
// so it is fully editable and survives in backups.
import * as ui from '../ui.js';
import { getSettings, saveSettings } from '../store.js';
import { DEFAULT_CAPTIONS, DEFAULT_SECTIONS, DEFAULT_COMPONENTS } from '../captions.js';

export default async function renderLibrary() {
  let s = await getSettings(true);
  let tab = 'captions';

  const screen = ui.h('div', { class: 'screen' });
  const body = ui.h('div', { class: 'scroll' });

  const seg = ui.h('div', { class: 'segmented', style: { margin: '0 12px 12px' } },
    ui.h('button', { 'aria-selected': 'true', text: 'Captions', onclick: () => switchTab('captions') }),
    ui.h('button', { 'aria-selected': 'false', text: 'Sections', onclick: () => switchTab('sections') }),
    ui.h('button', { 'aria-selected': 'false', text: 'Components', onclick: () => switchTab('components') }));

  screen.appendChild(ui.navbar({
    title: 'Library',
    largeTitle: true,
    sub: 'Tap-to-apply captions and the section template',
    right: ui.navBtn('', addItem, { icon: 'plus' }),
  }));
  screen.appendChild(ui.h('div', { style: { paddingTop: '10px' } }, seg));
  screen.appendChild(body);

  const TABS = ['captions', 'sections', 'components'];
  function switchTab(t) {
    tab = t;
    [...seg.children].forEach((b, i) => b.setAttribute('aria-selected', String(TABS[i] === t)));
    paint();
  }

  const save = async (patch) => { s = await saveSettings(patch); };

  async function addItem() {
    if (tab === 'components') {
      const t = await ui.prompt('New Component', 'Used by the defect-table report.', '', { okLabel: 'Add' });
      if (t && t.trim()) {
        await save({ componentLib: [...s.componentLib, t.trim().toUpperCase()] });
        paint();
      }
      return;
    }
    if (tab === 'sections') {
      const t = await ui.prompt('New Section Name', 'Used when adding sections to a project.', '', { okLabel: 'Add' });
      if (t && t.trim()) {
        await save({ sectionLib: [...s.sectionLib, t.trim().toUpperCase()] });
        paint();
      }
      return;
    }
    const groups = s.captionLib.map((g) => ({ label: g.group, value: g.group, icon: 'list', color: 'var(--sys-blue)' }));
    const target = await ui.actionSheet('Add caption to', [...groups, { label: 'New group…', value: '__new', icon: 'plus', color: 'var(--sys-green)' }]);
    if (!target) return;
    let groupName = target;
    if (target === '__new') {
      const g = await ui.prompt('New Group', 'e.g. Roofing', '', { okLabel: 'Create' });
      if (!g || !g.trim()) return;
      groupName = g.trim();
      await save({ captionLib: [...s.captionLib, { group: groupName, items: [] }] });
    }
    const text = await ui.prompt('New Caption', 'Printed under the photo. Use a new line for a second line.', '', { multiline: true, okLabel: 'Add' });
    if (!text || !text.trim()) return;
    const lib = s.captionLib.map((g) => g.group === groupName ? { ...g, items: [...g.items, text.trim().toUpperCase()] } : g);
    await save({ captionLib: lib });
    paint();
  }

  async function editCaption(groupName, index) {
    const g = s.captionLib.find((x) => x.group === groupName);
    const current = g.items[index];
    const choice = await ui.actionSheet(current.replace(/\n/g, ' · '), [
      { label: 'Edit', value: 'edit', icon: 'pencil', color: 'var(--sys-blue)', primary: true },
      { label: 'Delete', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    if (choice === 'edit') {
      const t = await ui.prompt('Edit Caption', '', current, { multiline: true });
      if (t === null) return;
      const lib = s.captionLib.map((x) => x.group === groupName
        ? { ...x, items: x.items.map((it, i) => i === index ? t.trim().toUpperCase() : it) } : x);
      await save({ captionLib: lib });
      paint();
    }
    if (choice === 'del') {
      const lib = s.captionLib.map((x) => x.group === groupName
        ? { ...x, items: x.items.filter((_, i) => i !== index) } : x);
      await save({ captionLib: lib });
      paint();
    }
  }

  async function groupMenu(groupName) {
    const choice = await ui.actionSheet(groupName, [
      { label: 'Rename group', value: 'ren', icon: 'pencil', color: 'var(--sys-gray)' },
      { label: 'Delete group', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    if (choice === 'ren') {
      const t = await ui.prompt('Rename Group', '', groupName);
      if (t && t.trim()) {
        await save({ captionLib: s.captionLib.map((g) => g.group === groupName ? { ...g, group: t.trim() } : g) });
        paint();
      }
    }
    if (choice === 'del') {
      const ok = await ui.confirm('Delete group?', 'Its captions are removed from the library.', { okLabel: 'Delete', destructive: true });
      if (ok) { await save({ captionLib: s.captionLib.filter((g) => g.group !== groupName) }); paint(); }
    }
  }

  async function componentMenu(index) {
    const name = s.componentLib[index];
    const choice = await ui.actionSheet(name, [
      { label: 'Rename', value: 'ren', icon: 'pencil', color: 'var(--sys-blue)', primary: true },
      { label: 'Move up', value: 'up', icon: 'up', color: 'var(--sys-gray)' },
      { label: 'Move down', value: 'down', icon: 'down', color: 'var(--sys-gray)' },
      { label: 'Delete', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    const lib = [...s.componentLib];
    if (choice === 'ren') {
      const t = await ui.prompt('Rename Component', '', name);
      if (!t || !t.trim()) return;
      lib[index] = t.trim().toUpperCase();
    } else if (choice === 'up' && index > 0) {
      [lib[index - 1], lib[index]] = [lib[index], lib[index - 1]];
    } else if (choice === 'down' && index < lib.length - 1) {
      [lib[index + 1], lib[index]] = [lib[index], lib[index + 1]];
    } else if (choice === 'del') {
      lib.splice(index, 1);
    } else return;
    await save({ componentLib: lib });
    paint();
  }

  async function sectionMenu(index) {
    const name = s.sectionLib[index];
    const choice = await ui.actionSheet(name, [
      { label: 'Rename', value: 'ren', icon: 'pencil', color: 'var(--sys-blue)', primary: true },
      { label: 'Move up', value: 'up', icon: 'up', color: 'var(--sys-gray)' },
      { label: 'Move down', value: 'down', icon: 'down', color: 'var(--sys-gray)' },
      { label: 'Delete', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    const lib = [...s.sectionLib];
    if (choice === 'ren') {
      const t = await ui.prompt('Rename Section', '', name);
      if (!t || !t.trim()) return;
      lib[index] = t.trim().toUpperCase();
    } else if (choice === 'up' && index > 0) {
      [lib[index - 1], lib[index]] = [lib[index], lib[index - 1]];
    } else if (choice === 'down' && index < lib.length - 1) {
      [lib[index + 1], lib[index]] = [lib[index], lib[index + 1]];
    } else if (choice === 'del') {
      lib.splice(index, 1);
    } else return;
    await save({ sectionLib: lib });
    paint();
  }

  function paint() {
    ui.clear(body);
    if (tab === 'captions') {
      const used = Object.entries(s.usage || {}).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
      if (used.length) {
        body.appendChild(ui.group('Most used', used.map(([text, u]) =>
          ui.row({ title: text.replace(/\n/g, ' · '), value: `${u.n}×` }))));
      }
      s.captionLib.forEach((g) => {
        const title = ui.h('button', {
          class: 'group-title',
          style: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' },
          text: g.group, onclick: () => groupMenu(g.group),
        });
        body.appendChild(title);
        body.appendChild(ui.h('div', { class: 'list' },
          ...(g.items.length ? g.items.map((t, i) =>
            ui.row({ title: t.replace(/\n/g, ' · '), chevron: true, onclick: () => editCaption(g.group, i) }))
            : [ui.row({ title: 'Empty group', sub: 'Add a caption with + above' })])));
      });
      body.appendChild(ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn tinted wide', text: 'Restore built-in captions',
          onclick: async () => {
            const ok = await ui.confirm('Restore built-in captions?', 'Your own captions are kept; missing built-ins are added back.', { okLabel: 'Restore' });
            if (!ok) return;
            const merged = DEFAULT_CAPTIONS.map((d) => {
              const mine = s.captionLib.find((g) => g.group === d.group);
              return { group: d.group, items: Array.from(new Set([...(mine ? mine.items : []), ...d.items])) };
            });
            const extra = s.captionLib.filter((g) => !DEFAULT_CAPTIONS.some((d) => d.group === g.group));
            await save({ captionLib: [...merged, ...extra] });
            paint(); ui.toast('Library restored');
          },
        })));
    } else if (tab === 'components') {
      body.appendChild(ui.h('div', { class: 'hint',
        text: 'The defect-table report groups each section\u2019s photos by component, and prints one table per group.' }));
      body.appendChild(ui.group('Components',
        s.componentLib.map((t, i) => ui.row({ title: t, chevron: true, onclick: () => componentMenu(i) }))));
      body.appendChild(ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn tinted wide', text: 'Restore built-in components',
          onclick: async () => {
            await save({ componentLib: Array.from(new Set([...s.componentLib, ...DEFAULT_COMPONENTS])) });
            paint(); ui.toast('Components restored');
          },
        })));
    } else {
      body.appendChild(ui.group('Section template',
        s.sectionLib.map((t, i) => ui.row({ title: t, chevron: true, onclick: () => sectionMenu(i) }))));
      body.appendChild(ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn tinted wide', text: 'Restore built-in sections',
          onclick: async () => {
            await save({ sectionLib: Array.from(new Set([...s.sectionLib, ...DEFAULT_SECTIONS])) });
            paint(); ui.toast('Sections restored');
          },
        })));
    }
  }

  paint();
  return screen;
}
