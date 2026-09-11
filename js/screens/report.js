// Report builder: paginated A4 pages that print (or "Save as PDF") natively.
import * as ui from '../ui.js';
import { go } from '../app.js';
import {
  getProject, listSections, listPhotos, getBlob, getSettings,
  displayBlobId, isOkCaption, updateProject, photoTakenAt,
  componentBlocks, defectSummary,
} from '../store.js';
import { blobUrl } from '../image.js';
import { draftSummary, aiReady, aiEnabled } from '../assist.js';
import { buildReportPdf, reportFilename, planTableFormat } from '../report-pdf.js';
import { saveFile } from '../backup.js';

const MM = 96 / 25.4;

export default async function renderReport(projectId) {
  const project = await getProject(projectId);
  const settings = await getSettings();
  if (!project) {
    return ui.h('div', { class: 'screen' },
      ui.navbar({ title: 'Report' }),
      ui.empty('doc', 'Project not found', '', 'Projects', () => go('#/projects')));
  }

  const screen = ui.h('div', { class: 'screen' });
  const wrap = ui.h('div', { class: 'report-wrap' });
  const scroll = ui.h('div', { class: 'scroll', style: { padding: '0' } }, wrap);

  const opts = {
    cover: settings.coverEnabled,
    summary: settings.summaryEnabled,
    summaryTable: settings.summaryTableEnabled,
    notes: settings.notesEnabled,
    perPage: settings.photosPerPage || 6,
    skipEmpty: true,
    stamp: settings.stampEnabled !== false,
    numbering: settings.pageNumbering || 'document',
    format: settings.reportFormat || 'captions',
  };

  screen.appendChild(ui.navbar({
    title: 'Report',
    sub: project.name,
    left: ui.backBtn(() => go('#/project/' + projectId), 'Project'),
    right: ui.h('span', { style: { display: 'flex' } },
      ui.navBtn('', optionsSheet, { icon: 'more' }),
      ui.navBtn('', savePdf, { icon: 'down' })),
  }));
  screen.appendChild(scroll);

  function optionsSheet() {
    const body = ui.h('div', {},
      ui.group('Format', [
        ui.row({
          title: 'Layout',
          sub: opts.format === 'table'
            ? 'Numbered photos with a defect table per section'
            : 'A caption under every photo',
          right: ui.h('select', {
            onchange: (e) => { opts.format = e.target.value; build(); },
            style: { border: 0, background: 'none', fontSize: '15px', color: 'var(--label-2)' },
          }, ...[['captions', 'Photo captions'], ['table', 'Defect table']].map(([v, label]) => {
            const o = ui.h('option', { value: v, text: label });
            if (v === opts.format) o.selected = true;
            return o;
          })),
        }),
      ]),
      ui.group('Include', [
        ui.switchRow('Cover page', opts.cover, (v) => { opts.cover = v; build(); }),
        ui.switchRow('Executive summary', opts.summary, (v) => { opts.summary = v; build(); }),
        ui.switchRow('Summary table', opts.summaryTable, (v) => { opts.summaryTable = v; build(); }, 'Item counts per location'),
        ui.switchRow('Notes & limitations', opts.notes, (v) => { opts.notes = v; build(); }),
        ui.switchRow('Skip empty sections', opts.skipEmpty, (v) => { opts.skipEmpty = v; build(); }),
        ui.switchRow('Photo timestamps', opts.stamp, (v) => { opts.stamp = v; build(); }, 'Capture time on each photo'),
      ]),
      ui.group('Layout', [
        ui.row({
          title: 'Page numbers',
          right: ui.h('select', {
            onchange: (e) => { opts.numbering = e.target.value; build(); },
            style: { border: 0, background: 'none', fontSize: '15px', color: 'var(--label-2)' },
          }, ...[['document', 'Whole report'], ['section', 'Per section']].map(([v, label]) => {
            const o = ui.h('option', { value: v, text: label });
            if (v === opts.numbering) o.selected = true;
            return o;
          })),
        }),
        ui.row({
          title: 'Photos per page',
          right: ui.h('select', {
            onchange: (e) => { opts.perPage = Number(e.target.value); build(); },
            style: { border: 0, background: 'none', fontSize: '17px', color: 'var(--label-2)' },
          }, ...[2, 4, 6, 8].map((n) => {
            const o = ui.h('option', { value: String(n), text: String(n) });
            if (n === opts.perPage) o.selected = true;
            return o;
          })),
        }),
      ]),
      ui.h('div', { class: 'btn-stack' },
        ui.h('button', { class: 'btn wide', onclick: savePdf, text: 'Save PDF' }),
        aiEnabled
          ? ui.h('button', { class: 'btn tinted wide', onclick: aiSummary, text: 'Draft summary with AI' })
          : null,
        ui.h('button', { class: 'btn gray wide', onclick: () => window.print(), text: 'Print instead' })),
      ui.h('div', { class: 'group-note', text: 'Save PDF writes the file itself, so it carries none of the browser\u2019s own page header or footer. Print goes through Safari or Chrome, which add the page address and date.' }));
    ui.sheet({ title: 'Report Options', body, leftLabel: 'Done' });
  }

  async function aiSummary() {
    const sections = await listSections(projectId);
    const payload = [];
    for (const s of sections) {
      const ph = await listPhotos(s.id);
      payload.push({ title: s.title, captions: ph.map((p) => p.caption).filter(Boolean) });
    }
    ui.toast((await aiReady()) ? 'Drafting summary…' : 'Building summary offline…', 60000);
    try {
      const text = await draftSummary(project, payload);
      await updateProject(projectId, { summaryOverride: text });
      project.summaryOverride = text;
      ui.toast('Summary updated');
      build();
    } catch (err) { ui.toast(err.message || 'Could not draft summary'); }
  }

  /* ---------------- PDF ---------------- */
  async function savePdf() {
    const sections = await listSections(projectId);
    const data = [];
    for (const sec of sections) {
      const photos = await listPhotos(sec.id);
      if (opts.skipEmpty && !photos.length) continue;
      data.push({ section: sec, photos });
    }
    if (!data.length) { ui.toast('Nothing to report yet — add photos first'); return; }

    const total = data.reduce((n, d) => n + d.photos.length, 0);
    ui.toast(`Writing PDF (${total} photo${total === 1 ? '' : 's'})\u2026`, 120000);
    try {
      const blob = await buildReportPdf({ project, settings, data, opts });
      const name = reportFilename(project);
      const how = await saveFile(blob, name);
      if (how === 'cancelled') ui.toast('Cancelled');
      else ui.toast(`${name} \u2014 ${ui.fmtBytes(blob.size)}`, 3500);
    } catch (err) {
      console.error(err);
      ui.alert('Could not write the PDF', err.message || String(err));
    }
  }

  /* ---------------- page helpers ---------------- */
  const page = (extraClass = '') => ui.h('div', { class: 'rpage ' + extraClass });
  const cols = () => (opts.perPage <= 2 ? 1 : 2);
  const rows = () => Math.ceil(opts.perPage / cols());

  function footer(left, right) {
    return ui.h('div', { class: 'rfoot' },
      ui.h('div', { class: 'left', text: left || '' }),
      ui.h('div', { class: 'right', text: right || '' }));
  }

  /* Title is the project, Group is the section this page belongs to. */
  function sectionHeader(groupText) {
    const table = ui.h('table', {},
      ui.h('tbody', {},
        ui.h('tr', {},
          ui.h('td', { class: 'rh-k', text: 'Title:' }),
          ui.h('td', { class: 'rh-v rh-title', text: project.name }),
          ui.h('td', { class: 'rh-k', style: { paddingLeft: '6mm' }, text: 'Group:' }),
          ui.h('td', { class: 'rh-v rh-title', text: groupText }))));
    return ui.h('div', { class: 'rhead' }, table);
  }

  async function photoCell(p) {
    const cell = ui.h('div', { class: 'rcell' });
    const wrap = ui.h('div', { class: 'ph-wrap' });
    const img = ui.h('img', { class: 'ph' });
    const id = displayBlobId(p);
    const b = await getBlob(id);
    if (b) img.src = blobUrl(id + ':rpt', b);
    wrap.appendChild(img);
    if (opts.stamp) {
      const text = ui.formatStamp(photoTakenAt(p), settings.stampFormat);
      if (text) wrap.appendChild(ui.h('div', { class: 'ph-stamp ' + (settings.stampPosition || 'br'), text }));
    }
    cell.appendChild(wrap);
    const cap = ui.h('div', { class: 'cp', text: p.caption || '' });
    if (p.caption2) cap.appendChild(ui.h('div', { class: 'sub', text: p.caption2 }));
    cell.appendChild(cap);
    return cell;
  }

  /* ---------------- build ---------------- */
  async function build() {
    ui.clear(wrap);
    wrap.appendChild(ui.h('div', { class: 'center-pad', text: 'Building report…' }));

    const sections = await listSections(projectId);
    const data = [];
    for (const s of sections) {
      const ph = await listPhotos(s.id);
      if (opts.skipEmpty && !ph.length) continue;
      data.push({ section: s, photos: ph });
    }

    // Address is no longer in the header, so it rides in the footer instead.
    const footerLeft = settings.footerText || project.address || '';
    const perSection = opts.numbering === 'section';
    const tablePlan = opts.format === 'table' ? planTableFormat(data, opts.perPage) : null;
    const sectionPages = tablePlan
      ? tablePlan.map((blocks) => blocks.reduce((n, b) => n + b.pages.length, 0))
      : data.map((d) => Math.max(1, Math.ceil(d.photos.length / opts.perPage)));
    const totalPages = (opts.cover ? 1 : 0)
      + (opts.summary ? 1 : 0)
      + (opts.notes && settings.notesBody ? 1 : 0)
      + sectionPages.reduce((a, b) => a + b, 0);
    let pageNo = 0;
    const pages = [];

    /* cover */
    if (opts.cover) {
      const c = page('rcover');
      const logo = settings.logoBlobId ? await getBlob(settings.logoBlobId) : null;
      if (logo) c.appendChild(ui.h('img', { class: 'c-logo', src: blobUrl(settings.logoBlobId + ':logo', logo) }));
      c.append(
        ui.h('div', { class: 'c-kicker', text: settings.coverKicker || 'INSPECTION REPORT' }),
        ui.h('div', { class: 'c-title', text: settings.reportTitle || 'DEFECT INSPECTION REPORT' }),
        ui.h('div', { class: 'c-rule' }),
        ui.h('div', { class: 'c-sub', text: [project.name, project.address].filter(Boolean).join('\n') }));
      pageNo++;
      const coverBody = project.coverOverride || settings.coverBody;
      if (coverBody) c.appendChild(ui.h('div', { class: 'c-body', text: coverBody }));
      const meta = ui.h('table', { class: 'c-meta' }, ui.h('tbody', {},
        ...[
          ['Client', project.client],
          ['Reference', project.ref],
          ['Unit type', project.unitType],
          ['Inspection date', ui.fmtDate(project.inspectionDate)],
          ['Inspected by', project.inspector || settings.preparedBy],
          ['Prepared by', settings.company],
          ['Contact', settings.contact],
        ].filter(([, v]) => v).map(([k, v]) => ui.h('tr', {}, ui.h('td', { text: k }), ui.h('td', { text: v })))));
      c.appendChild(meta);
      pages.push(c);
    }

    /* executive summary */
    if (opts.summary) {
      const s = page('rtext');
      s.appendChild(sectionHeader(settings.summaryTitle || 'EXECUTIVE SUMMARY'));
      s.appendChild(ui.h('div', { class: 'body', text: project.summaryOverride || settings.summaryBody || '' }));
      if (opts.summaryTable) {
        const rows = data.map((d) => {
          const items = d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length;
          return [d.section.title, d.photos.length, items];
        });
        const total = rows.reduce((a, r) => [null, a[1] + r[1], a[2] + r[2]], [null, 0, 0]);
        const table = ui.h('table', { class: 'sum' },
          ui.h('thead', {}, ui.h('tr', {},
            ui.h('th', { text: 'Location' }),
            ui.h('th', { class: 'n', style: { textAlign: 'right' }, text: 'Photos' }),
            ui.h('th', { class: 'n', style: { textAlign: 'right' }, text: 'Items' }))),
          ui.h('tbody', {},
            ...rows.map((r) => ui.h('tr', {},
              ui.h('td', { text: r[0] }),
              ui.h('td', { class: 'n', text: String(r[1]) }),
              ui.h('td', { class: 'n', text: String(r[2]) }))),
            ui.h('tr', {},
              ui.h('td', { html: '<b>Total</b>' }),
              ui.h('td', { class: 'n', html: `<b>${total[1]}</b>` }),
              ui.h('td', { class: 'n', html: `<b>${total[2]}</b>` }))));
        s.appendChild(table);
      }
      pageNo++;
      s.appendChild(footer(footerLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`));
      pages.push(s);
    }

    /* notes */
    if (opts.notes && settings.notesBody) {
      const n = page('rtext');
      n.appendChild(sectionHeader(settings.notesTitle || 'NOTES & LIMITATIONS'));
      n.appendChild(ui.h('div', { class: 'body', text: settings.notesBody }));
      pageNo++;
      n.appendChild(footer(footerLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`));
      pages.push(n);
    }

    /* photo pages — defect-table format */
    if (opts.format === 'table') {
      for (let si = 0; si < data.length; si++) {
        const d = data[si];
        const blocks = tablePlan[si];
        let first = true;
        for (let bi = 0; bi < blocks.length; bi++) {
          const b = blocks[bi];
          const defect = b.defect;
          const chunks = b.pages.map(([from, to]) => b.photos.slice(from, to));

          for (let c = 0; c < chunks.length; c++) {
            const pg = page('rtable');
            pg.appendChild(sectionHeader(d.section.title));
            const body2 = ui.h('div', { class: 'rt-body' });
            if (first) {
              body2.appendChild(ui.h('div', { class: 'rt-section', text: d.section.title.toUpperCase() }));
              first = false;
            }
            // A single unnamed block would only repeat the section heading.
            if (c === 0 && (b.component || blocks.length > 1)) {
              body2.appendChild(ui.h('div', { class: 'rt-block',
                text: b.component
                  ? `${bi + 1}.0 ${d.section.title.toUpperCase()} (${b.component})`
                  : `${bi + 1}.0 ${d.section.title.toUpperCase()}` }));
            }
            const grid = ui.h('div', { class: 'rt-grid' });
            for (let i = 0; i < chunks[c].length; i++) {
              const p = chunks[c][i];
              const n = b.pages[c][0] + i + 1;
              const cell = ui.h('div', { class: 'rt-cell' }, ui.h('div', { class: 'rt-num', text: String(n) }));
              const wrapEl = ui.h('div', { class: 'ph-wrap' });
              const img = ui.h('img', { class: 'ph' });
              const id = displayBlobId(p);
              const blob = await getBlob(id);
              if (blob) img.src = blobUrl(id + ':rpt', blob);
              wrapEl.appendChild(img);
              if (opts.stamp) {
                const text = ui.formatStamp(photoTakenAt(p), settings.stampFormat);
                if (text) wrapEl.appendChild(ui.h('div', { class: 'ph-stamp ' + (settings.stampPosition || 'br'), text }));
              }
              cell.appendChild(wrapEl);
              grid.appendChild(cell);
            }
            body2.appendChild(grid);
            pg.appendChild(body2);

            if (c === chunks.length - 1) {
              pg.appendChild(ui.h('table', { class: 'rt-info' }, ui.h('tbody', {},
                ui.h('tr', {},
                  ui.h('th', { text: 'LOCATION' }),
                  ui.h('td', { text: d.section.title }),
                  ui.h('th', { text: 'COMPONENT' }),
                  ui.h('td', { text: b.component || '' })),
                ui.h('tr', {},
                  ui.h('th', { text: 'DEFECT' }),
                  ui.h('td', { colspan: '3', text: defect || '-' })))));
            }

            pageNo++;
            pg.appendChild(footer(footerLeft, perSection
              ? `page ${c + 1} of ${chunks.length}`
              : `page ${pageNo} of ${totalPages}`));
            pages.push(pg);
          }
        }
      }
      ui.clear(wrap);
      pages.forEach((p) => wrap.appendChild(ui.h('div', { class: 'rpage-holder' }, p)));
      scalePages();
      return;
    }

    /* photo pages — paginated per section, matching the sample layout */
    for (const d of data) {
      const chunks = [];
      for (let i = 0; i < d.photos.length; i += opts.perPage) chunks.push(d.photos.slice(i, i + opts.perPage));
      if (!chunks.length) chunks.push([]);
      for (let i = 0; i < chunks.length; i++) {
        const pg = page();
        pg.appendChild(sectionHeader(d.section.title));
        const g = ui.h('div', { class: 'rgrid' });
        g.style.setProperty('--cols', String(cols()));
        g.style.setProperty('--rows', String(rows()));
        for (const p of chunks[i]) g.appendChild(await photoCell(p));
        pg.appendChild(g);
        pageNo++;
        pg.appendChild(footer(footerLeft, perSection
          ? `page ${i + 1} of ${chunks.length}`
          : `page ${pageNo} of ${totalPages}`));
        pages.push(pg);
      }
    }

    ui.clear(wrap);
    if (!pages.length) {
      wrap.appendChild(ui.h('div', { class: 'center-pad', text: 'Nothing to report yet — add photos first.' }));
      return;
    }
    pages.forEach((p) => wrap.appendChild(ui.h('div', { class: 'rpage-holder' }, p)));
    scalePages();
  }

  /* Fit the A4 pages to the phone screen without touching print output. */
  function scalePages() {
    // build() runs before the router attaches this screen, so clientWidth can
    // still be 0 here — which used to produce a negative scale and pages with
    // no height. Fall back to the document width, and never go non-positive.
    const avail = (wrap.clientWidth || document.documentElement.clientWidth) - 16;
    const scale = Math.min(1, Math.max(0.2, avail / (210 * MM)));
    wrap.style.setProperty('--scale', String(scale));
  }
  // Recompute once the node is actually in the page, and on rotation.
  if ('ResizeObserver' in window) new ResizeObserver(scalePages).observe(wrap);
  window.addEventListener('resize', scalePages);

  await build();
  return screen;
}
