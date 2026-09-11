// The report as an editable Word document, laid out from the same data as the
// PDF so both formats read the same. Word owns the pagination here — that is the
// point of handing over a .docx — so photos are sized to fit six to a page and
// each section starts on a new page.
import { buildDocx, para, run, image, table, pageOfPages, imageRel, mmToTwip } from './docx.js';
import { getBlob, displayBlobId, isOkCaption, photoTakenAt, componentBlocks, defectSummary } from './store.js';
import { stampedCopy } from './image.js';
import { formatStamp, fmtDate } from './ui.js';

const PAGE = { widthMm: 210, heightMm: 297, marginMm: { top: 14, right: 12, bottom: 12, left: 12 } };
const CONTENT_W = PAGE.widthMm - PAGE.marginMm.left - PAGE.marginMm.right;   // 186mm

const HEAD_SIZE = 9;
const FOOT_SIZE = 8.5;
const CAP_SIZE = 8.2;
const SECTION_SIZE = 14;
const BLOCK_SIZE = 11;
const TABLE_SIZE = 8;
const T_COLS = [24, 66, 30, 66];
const NUM_COL = 8;

const bytesOf = async (blobId) => {
  const blob = await getBlob(blobId);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
};

function headerXml(project, sectionTitle) {
  return table([20, 71, 22, 73], [[
    { text: 'Title:', bold: true, size: HEAD_SIZE },
    { text: (project.name || '').toUpperCase(), size: HEAD_SIZE },
    { text: 'Group:', bold: true, size: HEAD_SIZE },
    { text: (sectionTitle || '').toUpperCase(), size: HEAD_SIZE },
  ]], { cellPadMm: 0 })
    // A rule under the header, as in the printed layout.
    + `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="000000"/></w:pBdr>`
    + `<w:spacing w:after="0" w:line="60" w:lineRule="exact"/></w:pPr></w:p>`;
}

function footerXml(left) {
  return `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="12" w:space="1" w:color="000000"/></w:pBdr>`
    + `<w:tabs><w:tab w:val="right" w:pos="${mmToTwip(CONTENT_W)}"/></w:tabs>`
    + `<w:spacing w:before="0" w:after="0"/></w:pPr>`
    + run(left || '', { size: FOOT_SIZE, color: '333333' })
    + '<w:r><w:tab/></w:r>'
    + pageOfPages(FOOT_SIZE)
    + '</w:p>';
}

/** A photo cell: the image, then either its caption or nothing. */
function photoCellXml(relId, id, widthMm, heightMm, captionText) {
  return para(image(relId, id, widthMm, heightMm), { spaceAfter: captionText ? 0.6 : 0 })
    + (captionText ? para(run(captionText.toUpperCase(), { size: CAP_SIZE }), { spaceAfter: 0 }) : '');
}

/**
 * @param opts { format, cover, summary, summaryTable, notes, perPage, stamp }
 * @returns {Promise<Blob>}
 */
export async function buildReportDocx({ project, settings, data, opts }) {
  const images = [];
  const addImage = async (photo) => {
    let blob = await getBlob(displayBlobId(photo));
    if (!blob) return null;
    // Word embeds the picture as-is, so the capture time has to be burned in
    // here — the PDF draws it as a separate layer, which a .docx cannot carry.
    if (opts.stamp) {
      const text = formatStamp(photoTakenAt(photo), settings.stampFormat);
      if (text) blob = await stampedCopy(blob, text, { position: settings.stampPosition || 'br' });
    }
    images.push({ bytes: new Uint8Array(await blob.arrayBuffer()) });
    return { rel: imageRel(images.length - 1), id: images.length };
  };

  const footLeft = settings.footerText || project.address || '';
  const sections = [];
  const tableFormat = opts.format === 'table';

  // Photo geometry, matching the PDF's six-to-a-page.
  const cols = opts.perPage <= 2 ? 1 : 2;
  const gap = 4;
  const capW = (CONTENT_W - gap * (cols - 1)) / cols;
  const capH = capW / (4 / 3);
  const tblW = (CONTENT_W - (NUM_COL + gap) * cols + gap) / cols;
  const tblH = tblW / (4 / 3);

  /* ---------- cover ---------- */
  if (opts.cover) {
    const body = [];
    if (settings.logoBlobId) {
      const bytes = await bytesOf(settings.logoBlobId);
      if (bytes) {
        images.push({ bytes });
        body.push(para(image(imageRel(images.length - 1), images.length, 50, 21, 'logo'), { spaceAfter: 6 }));
      }
    }
    body.push(para(run(settings.coverKicker || 'INSPECTION REPORT', { size: 10, color: '555555' }), { spaceAfter: 3 }));
    body.push(para(run(settings.reportTitle || 'DEFECT INSPECTION REPORT', { bold: true, size: 26 }), { spaceAfter: 4 }));
    body.push(para(run([project.name, project.address].filter(Boolean).join('\n'), { size: 12, color: '333333' }), { spaceAfter: 8 }));
    const coverBody = project.coverOverride || settings.coverBody;
    if (coverBody) body.push(para(run(coverBody, { size: 10 }), { spaceAfter: 8 }));

    const meta = [
      ['Client', project.client], ['Reference', project.ref], ['Unit type', project.unitType],
      ['Inspection date', fmtDate(project.inspectionDate)],
      ['Inspected by', project.inspector || settings.preparedBy],
      ['Prepared by', settings.company], ['Contact', settings.contact],
    ].filter(([, v]) => v);
    if (meta.length) {
      body.push(table([40, CONTENT_W - 40],
        meta.map(([k, v]) => [
          { text: k.toUpperCase(), bold: true, size: 8.5 },
          { text: v, size: 10 },
        ]), { borderEighthPt: 4 }));
    }
    sections.push({ body: body.join(''), header: null, footer: footerXml(footLeft) });
  }

  /* ---------- executive summary ---------- */
  if (opts.summary) {
    const body = [
      para(run(settings.summaryTitle || 'EXECUTIVE SUMMARY', { bold: true, size: SECTION_SIZE }), { spaceAfter: 4 }),
      para(run(project.summaryOverride || settings.summaryBody || '', { size: 10 }), { spaceAfter: 6 }),
    ];
    if (opts.summaryTable && data.length) {
      const rows = [[
        { text: 'LOCATION', bold: true, size: 8.5 },
        { text: 'PHOTOS', bold: true, size: 8.5, align: 'right' },
        { text: 'ITEMS', bold: true, size: 8.5, align: 'right' },
      ]];
      data.forEach((d) => rows.push([
        { text: d.section.title, size: 9 },
        { text: String(d.photos.length), size: 9, align: 'right' },
        { text: String(d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length), size: 9, align: 'right' },
      ]));
      rows.push([
        { text: 'Total', bold: true, size: 9 },
        { text: String(data.reduce((n, d) => n + d.photos.length, 0)), bold: true, size: 9, align: 'right' },
        { text: String(data.reduce((n, d) => n + d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length, 0)), bold: true, size: 9, align: 'right' },
      ]);
      body.push(table([CONTENT_W - 44, 22, 22], rows, { borderEighthPt: 4 }));
    }
    sections.push({
      body: body.join(''),
      header: headerXml(project, settings.summaryTitle || 'EXECUTIVE SUMMARY'),
      footer: footerXml(footLeft),
    });
  }

  /* ---------- notes ---------- */
  if (opts.notes && settings.notesBody) {
    sections.push({
      body: para(run(settings.notesTitle || 'NOTES & LIMITATIONS', { bold: true, size: SECTION_SIZE }), { spaceAfter: 4 })
        + para(run(settings.notesBody, { size: 10 })),
      header: headerXml(project, settings.notesTitle || 'NOTES & LIMITATIONS'),
      footer: footerXml(footLeft),
    });
  }

  /* ---------- photo sections ---------- */
  for (const d of data) {
    const blocks = componentBlocks(d.photos);
    const body = [];
    body.push(para(run(d.section.title.toUpperCase(), { bold: true, size: SECTION_SIZE }), { spaceAfter: 1.5 }));

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.component || blocks.length > 1) {
        const label = b.component
          ? `${bi + 1}.0 ${d.section.title.toUpperCase()} (${b.component})`
          : `${bi + 1}.0 ${d.section.title.toUpperCase()}`;
        body.push(para(run(label, { bold: true, size: BLOCK_SIZE }), { spaceAfter: 2, keepNext: true }));
      }

      // Photos laid out as a borderless grid so Word keeps them in step.
      const rows = [];
      for (let i = 0; i < b.photos.length; i += cols) {
        const cells = [];
        for (let c = 0; c < cols; c++) {
          const photo = b.photos[i + c];
          if (!photo) {
            if (tableFormat) cells.push({ text: '' });
            cells.push({ text: '' });
            continue;
          }
          const ref = await addImage(photo);
          if (tableFormat) {
            // The number stands in for a caption; the table below refers to it.
            cells.push({ xml: para(run(String(i + c + 1), { size: 9 }), { align: 'center' }) });
            cells.push({ xml: ref ? photoCellXml(ref.rel, ref.id, tblW, tblH, '') : para('') });
          } else {
            const caption = [photo.caption, photo.caption2].filter(Boolean).join('\n');
            cells.push({ xml: ref ? photoCellXml(ref.rel, ref.id, capW, capH, caption) : para('') });
          }
        }
        rows.push(cells);
      }
      if (rows.length) {
        const grid = tableFormat
          ? Array.from({ length: cols }, () => [NUM_COL, tblW]).flat()
          : Array.from({ length: cols }, () => capW);
        body.push(table(grid, rows, { cellPadMm: 1 }));
      }

      if (tableFormat) {
        body.push(para('', { spaceAfter: 2 }));
        body.push(table(T_COLS, [
          [
            { text: 'LOCATION', bold: true, size: TABLE_SIZE },
            { text: d.section.title, size: TABLE_SIZE },
            { text: 'COMPONENT', bold: true, size: TABLE_SIZE },
            { text: b.component || '', size: TABLE_SIZE },
          ],
          [
            { text: 'DEFECT', bold: true, size: TABLE_SIZE },
            { text: defectSummary(b.photos) || '', size: TABLE_SIZE, span: 3 },
          ],
        ], { borderEighthPt: 8, cellPadMm: 1.6 }));
        body.push(para('', { spaceAfter: 3 }));
      }
    }

    sections.push({
      body: body.join(''),
      header: headerXml(project, d.section.title),
      footer: footerXml(footLeft),
    });
  }

  if (!sections.length) sections.push({ body: para(run('No photos yet.')), header: null, footer: footerXml('') });

  return buildDocx({
    sections,
    images,
    page: PAGE,
    title: `${settings.reportTitle || 'DEFECT INSPECTION REPORT'} — ${project.name}`,
    author: settings.company || settings.preparedBy || '',
  });
}
