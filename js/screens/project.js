import * as ui from '../ui.js';
import { go, back } from '../app.js';
import {
  getProject, updateProject, listSections, createSection, updateSection,
  deleteSection, reorderSections, projectStats, getSettings, deleteProject,
  timeAnomalies, retimeToDate, photoTakenAt,
} from '../store.js';
import { openAssistant, aiEnabled } from '../assist.js';

export default async function renderProject(id) {
  const project = await getProject(id);
  if (!project) {
    return ui.h('div', { class: 'screen' },
      ui.navbar({ title: 'Project', left: ui.backBtn(back) }),
      ui.empty('folder', 'Project not found', 'It may have been deleted.', 'Projects', () => go('#/projects')));
  }

  const screen = ui.h('div', { class: 'screen' });
  const body = ui.h('div', { class: 'scroll' });

  screen.appendChild(ui.navbar({
    title: project.name,
    left: ui.backBtn(() => go('#/projects'), 'Projects'),
    right: ui.navBtn('', menu, { icon: 'more' }),
  }));
  screen.appendChild(body);

  async function menu() {
    const choice = await ui.actionSheet(project.name, [
      { label: 'Edit details', value: 'edit', icon: 'pencil', color: 'var(--sys-blue)' },
      { label: 'Report overrides', value: 'over', icon: 'doc', color: 'var(--sys-indigo)', sub: 'Cover & summary for this project only' },
      aiEnabled ? { label: 'Ask the assistant', value: 'ai', icon: 'sparkle', color: 'var(--sys-indigo)', sub: 'Questions about this inspection' } : null,
      { label: 'Add sections from template', value: 'tpl', icon: 'list', color: 'var(--sys-teal)' },
      { label: 'Reorder sections', value: 'order', icon: 'move', color: 'var(--sys-gray)' },
      { label: 'Delete project', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ].filter(Boolean));
    if (choice === 'edit') editDetails();
    if (choice === 'over') editOverrides();
    if (choice === 'ai') openAssistant(project);
    if (choice === 'tpl') addFromTemplate();
    if (choice === 'order') reorderSheet();
    if (choice === 'del') {
      const ok = await ui.confirm('Delete project?', 'All sections and photos are removed.', { okLabel: 'Delete', destructive: true });
      if (ok) { await deleteProject(id); go('#/projects'); }
    }
  }

  function editDetails() {
    const draft = { ...project };
    const form = ui.h('div', {},
      ui.group('Property', [
        ui.inputRow('Project', draft.name, (v) => { draft.name = v; }),
        ui.textRow('Address', draft.address, (v) => { draft.address = v; }),
        ui.inputRow('Unit type', draft.unitType, (v) => { draft.unitType = v; }),
      ]),
      ui.group('Inspection', [
        ui.inputRow('Client', draft.client, (v) => { draft.client = v; }),
        ui.inputRow('Reference', draft.ref, (v) => { draft.ref = v; }),
        ui.inputRow('Inspector', draft.inspector, (v) => { draft.inspector = v; }),
        ui.inputRow('Date', draft.inspectionDate, (v) => { draft.inspectionDate = v; }, { type: 'date' }),
      ]));
    ui.sheet({
      title: 'Project Details', body: form, rightLabel: 'Save',
      onRight: async () => { Object.assign(project, await updateProject(id, draft)); paint(); ui.toast('Saved'); },
    });
  }

  async function editOverrides() {
    const s = await getSettings();
    const draft = {
      coverOverride: project.coverOverride ?? '',
      summaryOverride: project.summaryOverride ?? '',
    };
    const form = ui.h('div', {},
      ui.h('div', { class: 'hint', text: 'Leave blank to use the defaults from Settings. Anything typed here applies to this project only.' }),
      ui.group('Cover note', [ui.textRow('Cover body', draft.coverOverride, (v) => { draft.coverOverride = v; }, { placeholder: s.coverBody || 'Default from Settings' })]),
      ui.group('Executive summary', [ui.textRow('Summary', draft.summaryOverride, (v) => { draft.summaryOverride = v; }, { placeholder: s.summaryBody })]));
    ui.sheet({
      title: 'Report Overrides', body: form, rightLabel: 'Save',
      onRight: async () => {
        Object.assign(project, await updateProject(id, {
          coverOverride: draft.coverOverride.trim() || null,
          summaryOverride: draft.summaryOverride.trim() || null,
        }));
        ui.toast('Saved');
      },
    });
  }

  async function addFromTemplate() {
    const s = await getSettings();
    const existing = (await listSections(id)).map((x) => x.title);
    const picked = new Set();
    const chips = ui.h('div', { class: 'chips' },
      ...s.sectionLib.map((t) => {
        const used = existing.includes(t.toUpperCase());
        const c = ui.h('button', {
          class: 'chip', 'aria-pressed': 'false', disabled: used, text: used ? t + ' ✓' : t,
          onclick: () => {
            if (used) return;
            const on = c.getAttribute('aria-pressed') === 'true';
            c.setAttribute('aria-pressed', String(!on));
            if (on) picked.delete(t); else picked.add(t);
            ui.haptic();
          },
        });
        if (used) c.style.opacity = '.45';
        return c;
      }));
    const body2 = ui.h('div', {},
      ui.h('div', { class: 'hint', text: 'Tap the locations you inspected. Sections already added are ticked.' }),
      chips,
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn tinted wide', text: 'Add all standard sections',
          onclick: async () => {
            for (const t of s.sectionLib) if (!existing.includes(t.toUpperCase())) await createSection(id, t);
            sh.close(); paint(); ui.toast('Sections added');
          },
        })));
    const sh = ui.sheet({
      title: 'Add Sections', body: body2, rightLabel: 'Add',
      onRight: async () => {
        for (const t of picked) await createSection(id, t);
        paint();
        ui.toast(picked.size ? `${picked.size} section(s) added` : 'Nothing selected');
      },
    });
  }

  async function reorderSheet() {
    const sections = await listSections(id);
    const list = ui.h('div', { class: 'list', style: { margin: '10px 12px' } });
    const order = sections.map((s) => s.id);
    function paintList() {
      ui.clear(list);
      order.forEach((sid, i) => {
        const sec = sections.find((s) => s.id === sid);
        list.appendChild(ui.row({
          title: sec.title,
          right: ui.h('span', { style: { display: 'flex', gap: '4px' } },
            ui.h('button', {
              class: 'nb-btn', onclick: () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; paintList(); } },
            }, ui.icon('up', 20)),
            ui.h('button', {
              class: 'nb-btn', onclick: () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; paintList(); } },
            }, ui.icon('down', 20))),
        }));
      });
    }
    paintList();
    ui.sheet({
      title: 'Reorder Sections', body: list, rightLabel: 'Save',
      onRight: async () => { await reorderSections(id, order); paint(); ui.toast('Order saved'); },
    });
  }

  async function clockSheet(clock) {
    const suspect = [...clock.offDate, ...clock.noSource];
    const sections = await listSections(id);
    const nameOf = (sid) => (sections.find((x) => x.id === sid) || {}).title || 'Unknown';
    const list = ui.h('div', { class: 'list', style: { margin: '10px 12px' } },
      ...suspect.slice(0, 40).map((p) => ui.row({
        title: p.caption ? p.caption.split('\n')[0] : 'Uncaptioned',
        sub: nameOf(p.sectionId),
        value: ui.formatStamp(photoTakenAt(p), 'dmy24'),
      })),
      suspect.length > 40 ? ui.row({ title: `+ ${suspect.length - 40} more` }) : null);

    const body2 = ui.h('div', {},
      ui.h('div', { class: 'hint', text: `Inspection date is ${ui.fmtDate(project.inspectionDate)}. `
        + 'These photos carry a capture time that does not match it, usually because the phone that took them had the wrong date.' }),
      list,
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', {
          class: 'btn wide',
          text: `Move all ${suspect.length} to the inspection date`,
          onclick: async () => {
            const ok = await ui.confirm('Move capture times?',
              `Each photo keeps its time of day and moves to ${ui.fmtDate(project.inspectionDate)}.`,
              { okLabel: 'Move' });
            if (!ok) return;
            const n = await retimeToDate(suspect.map((p) => p.id), project.inspectionDate);
            sh.close();
            ui.toast(`${n} capture time(s) corrected`);
            paint();
          },
        }),
        ui.h('button', {
          class: 'btn gray wide', text: 'Change the inspection date instead',
          onclick: () => { sh.close(); editDetails(); },
        })));

    const sh = ui.sheet({ title: 'Capture Times', body: body2, leftLabel: 'Done' });
  }

  async function newSection() {
    const title = await ui.prompt('New Section', 'Printed as the report Title, e.g. MASTER BEDROOM.', '', { okLabel: 'Add' });
    if (title && title.trim()) {
      const sec = await createSection(id, title.trim());
      go('#/section/' + sec.id);
    }
  }

  async function sectionMenu(sec) {
    const choice = await ui.actionSheet(sec.title, [
      { label: 'Open', value: 'open', icon: 'photos', color: 'var(--sys-blue)', primary: true },
      { label: 'Rename', value: 'ren', icon: 'pencil', color: 'var(--sys-gray)' },
      { label: 'Delete section', value: 'del', icon: 'trash', color: 'var(--sys-red)', destructive: true },
    ]);
    if (choice === 'open') go('#/section/' + sec.id);
    if (choice === 'ren') {
      const t = await ui.prompt('Rename Section', '', sec.title);
      if (t && t.trim()) { await updateSection(sec.id, { title: t.trim() }); paint(); }
    }
    if (choice === 'del') {
      const ok = await ui.confirm('Delete section?', 'Photos in this section are removed.', { okLabel: 'Delete', destructive: true });
      if (ok) { await deleteSection(sec.id); paint(); }
    }
  }

  async function paint() {
    const [sections, st] = await Promise.all([listSections(id), projectStats(id)]);
    ui.clear(body);

    body.appendChild(ui.group('Property', [
      ui.row({ title: 'Address', sub: project.address || 'Not set' }),
      ui.row({ title: 'Client', value: project.client || '—' }),
      ui.row({ title: 'Reference', value: project.ref || '—' }),
      ui.row({ title: 'Inspector', value: project.inspector || '—' }),
      ui.row({ title: 'Date', value: ui.fmtDate(project.inspectionDate) || '—' }),
      ui.row({ title: 'Edit details', cls: 'action', onclick: editDetails }),
    ]));

    /* Clock warning — a site phone with a wrong date poisons every timestamp. */
    const clock = await timeAnomalies(id);
    if (clock.offDate.length || clock.noSource.length) {
      const rows = [];
      if (clock.offDate.length) {
        rows.push(ui.row({
          title: `${clock.offDate.length} photo${clock.offDate.length === 1 ? '' : 's'} dated off the inspection date`,
          sub: clock.offsetDays
            ? `About ${Math.abs(clock.offsetDays)} day${Math.abs(clock.offsetDays) === 1 ? '' : 's'} ${clock.offsetDays > 0 ? 'later' : 'earlier'} — likely a wrong camera clock`
            : 'Capture times do not match the inspection date',
          iconName: 'x', iconColor: 'var(--sys-orange)',
          chevron: true,
          onclick: () => clockSheet(clock),
        }));
      }
      if (clock.noSource.length) {
        rows.push(ui.row({
          title: `${clock.noSource.length} photo${clock.noSource.length === 1 ? '' : 's'} with no capture time`,
          sub: 'Stamped with the import time — check before reporting',
          iconName: 'x', iconColor: 'var(--sys-gray)',
          chevron: true,
          onclick: () => clockSheet(clock),
        }));
      }
      body.appendChild(ui.group('Check', rows));
    }

    body.appendChild(ui.group('Progress', [
      ui.row({ title: 'Photos', value: String(st.photos), iconName: 'photos', iconColor: 'var(--sys-teal)' }),
      ui.row({ title: 'Items recorded', value: String(st.defects), iconName: 'check', iconColor: 'var(--sys-orange)' }),
    ]));

    const secRows = sections.map((sec) => {
      const n = st.bySection[sec.id] || 0;
      const r = ui.row({
        title: sec.title,
        sub: n ? `${n} photo${n === 1 ? '' : 's'}` : 'Empty',
        iconName: 'photos',
        iconColor: n ? 'var(--sys-blue)' : 'var(--sys-gray)',
        chevron: true,
        onclick: () => go('#/section/' + sec.id),
      });
      let timer = null;
      r.addEventListener('pointerdown', () => { timer = setTimeout(() => { ui.haptic(14); sectionMenu(sec); }, 550); });
      ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) => r.addEventListener(ev, () => clearTimeout(timer)));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); sectionMenu(sec); });
      return r;
    });

    body.appendChild(ui.group('Sections',
      secRows.length ? secRows : [ui.row({ title: 'No sections yet', sub: 'Add the locations you will inspect' })],
      ));
    body.appendChild(ui.group('', [
      ui.row({ title: 'Add section', cls: 'action', iconName: 'plus', iconColor: 'var(--sys-green)', onclick: newSection }),
      ui.row({ title: 'Add from template', cls: 'action', iconName: 'list', iconColor: 'var(--sys-teal)', onclick: addFromTemplate }),
    ]));

    body.appendChild(ui.h('div', { class: 'btn-stack' },
      ui.h('button', {
        class: 'btn wide', onclick: () => go('#/report/' + id), disabled: !st.photos,
      }, ui.icon('doc', 20), ui.h('span', { text: 'Generate Report' })),
      ui.h('button', { class: 'btn tinted wide', onclick: editOverrides, text: 'Cover & Summary for this project' })));
  }

  await paint();
  return screen;
}
