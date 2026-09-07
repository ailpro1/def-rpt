// Builds the report as a real PDF, from the data rather than from the DOM, so
// the output carries nothing the browser wants to add to a printed page.
// Geometry here mirrors css/report.css — change both together.
import { createPdf, measure, wrap, PAGE } from './pdf.js';
import { getBlob, displayBlobId, isOkCaption, photoTakenAt } from './store.js';
import { formatStamp, fmtDate } from './ui.js';

const MM = 25.4 / 72;                 // one point, in mm

const L = {
  top: 14, side: 12, bottom: 12,
  headSize: 9, footSize: 8.5, capSize: 8.2, stampSize: 5.6,
  colGap: 5, rowGap: 4,
  rule: 0.42,                         // 1.2pt
};
const contentW = PAGE.w - L.side * 2;
const headBaseline = L.top + L.headSize * MM * 0.8;
const headRule = L.top + L.headSize * MM + 1.8;
const gridTop = headRule + 4;
const footRule = PAGE.h - L.bottom - 4.5;
const footBaseline = footRule + 1.5 + L.footSize * MM * 0.8;
const gridBottom = footRule - 4;

const GREY = [51, 51, 51];
const RULE_GREY = [153, 153, 153];

const bytesOf = async (blobId) => {
  const blob = await getBlob(blobId);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
};

function header(doc, titleValue, groupValue) {
  const labelW = measure('Title:', { font: 'bold', size: L.headSize });
  doc.text('Title:', L.side, headBaseline, { font: 'bold', size: L.headSize });
  doc.text(titleValue.toUpperCase(), L.side + labelW + 2, headBaseline, { size: L.headSize });

  const gx = L.side + contentW * 0.5;
  const groupW = measure('Group:', { font: 'bold', size: L.headSize });
  doc.text('Group:', gx, headBaseline, { font: 'bold', size: L.headSize });
  doc.text(String(groupValue || '').toUpperCase(), gx + groupW + 2, headBaseline, { size: L.headSize });

  doc.line(L.side, headRule, PAGE.w - L.side, headRule, { width: L.rule });
}

function footer(doc, left, right) {
  doc.line(L.side, footRule, PAGE.w - L.side, footRule, { width: L.rule });
  if (left) doc.text(left, L.side, footBaseline, { size: L.footSize, color: GREY });
  if (right) doc.text(right, PAGE.w - L.side, footBaseline, { size: L.footSize, align: 'right' });
}

/**
 * @param opts { cover, summary, summaryTable, notes, perPage, stamp, draft }
 * @returns {Promise<Blob>}
 */
export async function buildReportPdf({ project, settings, data, opts }) {
  const doc = createPdf({
    title: `${settings.reportTitle || 'DEFECT INSPECTION REPORT'} — ${project.name}`,
    author: settings.company || settings.preparedBy || '',
    subject: project.address || '',
  });
  const footLeft = settings.footerText || project.address || '';
  const perSection = opts.numbering === 'section';

  // Page counts are worked out before anything is drawn, so a footer can say
  // "page 4 of 17" on the page where it is printed.
  const sectionPages = data.map((d) => Math.max(1, Math.ceil(d.photos.length / opts.perPage)));
  const totalPages = (opts.cover ? 1 : 0)
    + (opts.summary ? 1 : 0)
    + (opts.notes && settings.notesBody ? 1 : 0)
    + sectionPages.reduce((a, b) => a + b, 0);
  let pageNo = 0;
  const nextPage = () => { doc.page(); return ++pageNo; };

  /* ---------- cover ---------- */
  if (opts.cover) {
    nextPage();
    let y = L.top + 6;
    if (settings.logoBlobId) {
      const logo = await bytesOf(settings.logoBlobId);
      if (logo) { doc.image(logo, L.side, y, 60, 26, { fit: 'contain' }); y += 32; }
    }
    y += 6;
    doc.text(settings.coverKicker || 'INSPECTION REPORT', L.side, y, { size: 10, color: [85, 85, 85], letterSpacing: 0.5 });
    y += 9;
    const titleLines = wrap(settings.reportTitle || 'DEFECT INSPECTION REPORT', contentW, { font: 'bold', size: 26 });
    titleLines.forEach((line) => { doc.text(line, L.side, y + 8, { font: 'bold', size: 26 }); y += 26 * MM * 1.12; });
    y += 4;
    doc.rect(L.side, y, 38, 0.85, { fill: [0, 0, 0] });
    y += 10;
    [project.name, project.address].filter(Boolean).forEach((line) => {
      y += doc.textBlock(line, L.side, y, contentW, { size: 12, color: GREY, lineHeight: 1.35 });
    });

    const coverBody = project.coverOverride || settings.coverBody;
    if (coverBody) { y += 8; doc.textBlock(coverBody, L.side, y, contentW, { size: 10, lineHeight: 1.5 }); }

    // Metadata sits on the lower part of the page, like the screen version.
    const rows = [
      ['Client', project.client],
      ['Reference', project.ref],
      ['Unit type', project.unitType],
      ['Inspection date', fmtDate(project.inspectionDate)],
      ['Inspected by', project.inspector || settings.preparedBy],
      ['Prepared by', settings.company],
      ['Contact', settings.contact],
    ].filter(([, v]) => v);
    let my = PAGE.h - L.bottom - 10 - rows.length * 8;
    rows.forEach(([k, v]) => {
      doc.line(L.side, my, PAGE.w - L.side, my, { width: 0.18, color: [187, 187, 187] });
      doc.text(k.toUpperCase(), L.side, my + 5.4, { font: 'bold', size: 8.5, letterSpacing: 0.15 });
      doc.textBlock(v, L.side + 34, my + 4.2, contentW - 34, { size: 10, maxLines: 2 });
      my += 8;
    });
    if (opts.draft) draftMark(doc);
  }

  /* ---------- executive summary ---------- */
  if (opts.summary) {
    nextPage();
    header(doc, project.name, settings.summaryTitle || 'EXECUTIVE SUMMARY');
    let y = gridTop;
    y += doc.textBlock(project.summaryOverride || settings.summaryBody || '', L.side, y, contentW,
      { size: 10, lineHeight: 1.5 });

    if (opts.summaryTable && data.length) {
      y += 8;
      const cols = [contentW - 44, 22, 22];
      const head = ['Location', 'Photos', 'Items'];
      const rows = data.map((d) => [
        d.section.title,
        String(d.photos.length),
        String(d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length),
      ]);
      rows.push(['Total',
        String(data.reduce((n, d) => n + d.photos.length, 0)),
        String(data.reduce((n, d) => n + d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length, 0))]);

      const rowH = 6.4;
      doc.rect(L.side, y, contentW, rowH, { fill: [238, 238, 238], stroke: RULE_GREY, lineWidth: 0.18 });
      let cx = L.side;
      head.forEach((h, i) => {
        doc.text(h.toUpperCase(), i === 0 ? cx + 2 : cx + cols[i] - 2, y + 4.4,
          { font: 'bold', size: 8.5, align: i === 0 ? 'left' : 'right', letterSpacing: 0.1 });
        cx += cols[i];
      });
      y += rowH;
      rows.forEach((r, ri) => {
        const last = ri === rows.length - 1;
        doc.rect(L.side, y, contentW, rowH, { stroke: RULE_GREY, lineWidth: 0.18 });
        cx = L.side;
        r.forEach((cell, i) => {
          doc.text(cell, i === 0 ? cx + 2 : cx + cols[i] - 2, y + 4.4,
            { size: 9, font: last ? 'bold' : 'regular', align: i === 0 ? 'left' : 'right' });
          cx += cols[i];
        });
        y += rowH;
      });
    }
    footer(doc, footLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`);
    if (opts.draft) draftMark(doc);
  }

  /* ---------- notes ---------- */
  if (opts.notes && settings.notesBody) {
    nextPage();
    header(doc, project.name, settings.notesTitle || 'NOTES & LIMITATIONS');
    doc.textBlock(settings.notesBody, L.side, gridTop, contentW, { size: 10, lineHeight: 1.5 });
    footer(doc, footLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`);
    if (opts.draft) draftMark(doc);
  }

  /* ---------- photo pages ---------- */
  const cols = opts.perPage <= 2 ? 1 : 2;
  const rows = Math.ceil(opts.perPage / cols);
  const colW = (contentW - L.colGap * (cols - 1)) / cols;
  const rowH = (gridBottom - gridTop - L.rowGap * (rows - 1)) / rows;
  const capLine = L.capSize * MM * 1.28;
  const capH = capLine * 2 + 1.4;
  const imgH = rowH - capH;

  for (const d of data) {
    const chunks = [];
    for (let i = 0; i < d.photos.length; i += opts.perPage) chunks.push(d.photos.slice(i, i + opts.perPage));
    if (!chunks.length) chunks.push([]);

    for (let c = 0; c < chunks.length; c++) {
      nextPage();
      header(doc, project.name, d.section.title);

      for (let i = 0; i < chunks[c].length; i++) {
        const photo = chunks[c][i];
        const cx = L.side + (i % cols) * (colW + L.colGap);
        const cy = gridTop + Math.floor(i / cols) * (rowH + L.rowGap);

        const jpeg = await bytesOf(displayBlobId(photo));
        if (jpeg) {
          doc.image(jpeg, cx, cy, colW, imgH, { fit: 'cover' });
          if (opts.stamp) {
            const text = formatStamp(photoTakenAt(photo), settings.stampFormat);
            if (text) stamp(doc, text, cx, cy, colW, imgH, settings.stampPosition || 'br');
          }
        } else {
          doc.rect(cx, cy, colW, imgH, { fill: [238, 238, 238] });
        }

        const caption = [photo.caption, photo.caption2].filter(Boolean).join('\n');
        if (caption) {
          doc.textBlock(caption.toUpperCase(), cx, cy + imgH + 1.4, colW,
            { size: L.capSize, lineHeight: 1.28, maxLines: 2 });
        }
      }

      footer(doc, footLeft, perSection
        ? `page ${c + 1} of ${chunks.length}`
        : `page ${pageNo} of ${totalPages}`);
      if (opts.draft) draftMark(doc);
    }
  }

  return doc.build();
}

/** Camera-style capture time, inside the photo. */
function stamp(doc, text, x, y, w, h, position) {
  const size = L.stampSize;
  const padX = 1, padY = 0.7;
  const tw = measure(text, { font: 'mono', size });
  const boxW = tw + padX * 2;
  const boxH = size * MM + padY * 2;
  const bx = position.endsWith('l') ? x + 1.2 : x + w - 1.2 - boxW;
  const by = position.startsWith('t') ? y + 1.2 : y + h - 1.2 - boxH;
  doc.rect(bx, by, boxW, boxH, { fill: [0, 0, 0] });
  doc.text(text, bx + padX, by + padY + size * MM * 0.78, { font: 'mono', size, color: [255, 255, 255] });
}

/** Diagonal DRAFT marking, for anything not being issued. */
function draftMark(doc) {
  const text = 'DRAFT — NOT FOR ISSUE';
  doc.text(text, PAGE.w / 2, PAGE.h / 2, { font: 'bold', size: 30, color: [225, 225, 225], align: 'center' });
}

export function reportFilename(project) {
  const clean = (s) => String(s || '').replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
  const date = (project.inspectionDate || new Date().toISOString().slice(0, 10));
  const parts = [clean(project.ref), clean(project.name) || 'Inspection Report', date].filter(Boolean);
  return `${parts.join(' - ')}.pdf`;
}
