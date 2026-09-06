import * as ui from '../ui.js';
import { go } from '../app.js';
import { listProjects, createProject, deleteProject, duplicateProject, projectStats, getSettings } from '../store.js';

export default async function renderProjects() {
  const screen = ui.h('div', { class: 'screen' });
  const body = ui.h('div', { class: 'scroll' });
  let query = '';

  const search = ui.h('input', {
    type: 'search', placeholder: 'Search projects',
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
  });

  screen.appendChild(ui.navbar({
    title: 'Projects',
    largeTitle: true,
    right: ui.navBtn('', newProject, { icon: 'plus' }),
    search,
  }));
  screen.appendChild(body);
  screen.appendChild(ui.h('button', { class: 'fab', onclick: newProject, 'aria-label': 'New project' }, ui.icon('plus', 28)));

  async function newProject() {
    const s = await getSettings();
    let data = { name: '', address: '', client: '', ref: '', inspector: s.preparedBy || '', inspectionDate: new Date().toISOString().slice(0, 10) };
    const form = ui.h('div', {},
      ui.group('Property', [
        ui.inputRow('Project', data.name, (v) => { data.name = v; }, { placeholder: 'e.g. No. 4 Klebang Seroja' }),
        ui.textRow('Address', data.address, (v) => { data.address = v; }, { placeholder: 'Full address as it should print' }),
        ui.inputRow('Unit type', data.unitType, (v) => { data.unitType = v; }, { placeholder: 'e.g. 2-storey terrace' }),
      ]),
      ui.group('Inspection', [
        ui.inputRow('Client', data.client, (v) => { data.client = v; }),
        ui.inputRow('Reference', data.ref, (v) => { data.ref = v; }, { placeholder: 'Report no.' }),
        ui.inputRow('Inspector', data.inspector, (v) => { data.inspector = v; }),
        ui.inputRow('Date', data.inspectionDate, (v) => { data.inspectionDate = v; }, { type: 'date' }),
      ]),
      ui.h('div', { class: 'group-note', text: 'Sections can be added from the template on the next screen.' }),
    );
    ui.sheet({
      title: 'New Project', body: form, rightLabel: 'Create',
      onRight: async () => {
        if (!data.name.trim()) { ui.toast('Project name required'); return false; }
        const p = await createProject(data);
        go('#/project/' + p.id);
      },
    });
  }

  async function longPress(p) {
    const choice = await ui.actionSheet(p.name, [
      { label: 'Open', value: 'open', icon: 'folder', color: 'var(--sys-blue)', primary: true },
      { label: 'Generate report', value: 'report', icon: 'doc', color: 'var(--sys-indigo)' },
      { label: 'Duplicate structure', value: 'dupe', icon: 'copy', color: 'var(--sys-gray)' },
      { label: 'Delete project', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    if (choice === 'open') go('#/project/' + p.id);
    if (choice === 'report') go('#/report/' + p.id);
    if (choice === 'dupe') {
      const name = await ui.prompt('Duplicate', 'Copies the section list, not the photos.', p.name + ' (copy)');
      if (name) { await duplicateProject(p.id, name); ui.toast('Duplicated'); paint(); }
    }
    if (choice === 'del') {
      const ok = await ui.confirm('Delete project?', 'All sections and photos in this project are removed. This cannot be undone.', { okLabel: 'Delete', destructive: true });
      if (ok) { await deleteProject(p.id); ui.toast('Deleted'); paint(); }
    }
  }

  async function paint() {
    const projects = await listProjects();
    const filtered = query
      ? projects.filter((p) => [p.name, p.address, p.client, p.ref].join(' ').toLowerCase().includes(query))
      : projects;

    ui.clear(body);
    if (!projects.length) {
      body.appendChild(ui.empty('folder', 'No projects yet',
        'Create a project for each property you inspect. Everything is stored on this device and works offline.',
        'New Project', newProject));
      return;
    }
    if (!filtered.length) {
      body.appendChild(ui.empty('list', 'No matches', 'Try a different search term.'));
      return;
    }

    const rows = [];
    for (const p of filtered) {
      const st = await projectStats(p.id);
      const r = ui.row({
        title: p.name,
        sub: [p.address, `${st.photos} photo${st.photos === 1 ? '' : 's'} · ${st.sections} section${st.sections === 1 ? '' : 's'}`]
          .filter(Boolean).join(' — '),
        iconName: 'folder',
        iconColor: st.photos ? 'var(--sys-blue)' : 'var(--sys-gray)',
        chevron: true,
        onclick: () => go('#/project/' + p.id),
      });
      let timer = null;
      r.addEventListener('pointerdown', () => { timer = setTimeout(() => { ui.haptic(14); longPress(p); }, 550); });
      ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) =>
        r.addEventListener(ev, () => clearTimeout(timer)));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); longPress(p); });
      rows.push(r);
    }
    body.appendChild(ui.group(`${filtered.length} project${filtered.length === 1 ? '' : 's'}`, rows));
    body.appendChild(ui.h('div', { class: 'group-note', text: 'Tip: press and hold a project for report, duplicate and delete.' }));
  }

  await paint();
  return screen;
}
