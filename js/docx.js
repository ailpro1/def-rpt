// Minimal Word (.docx) writer — the OOXML parts this report needs and nothing
// more. Word documents are a ZIP of XML, so with js/zip.js underneath there is
// no dependency and it still works offline.
//
// Units: twips (1/20 pt, 1mm = 56.6929) for layout, EMU (1/914400 in) for images.
import { createZip } from './zip.js';

export const TWIP = 56.6929;                  // twips per millimetre
export const EMU = 36000;                     // EMU per millimetre
export const mmToTwip = (mm) => Math.round(mm * TWIP);
export const mmToEmu = (mm) => Math.round(mm * EMU);

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A run of text. `size` is in points. */
export function run(text, { bold = false, size = 11, color, font, caps = false } = {}) {
  const props = [
    font ? `<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}"/>` : '',
    bold ? '<w:b/>' : '',
    caps ? '<w:caps/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`,
  ].join('');
  // Split on newlines so a caption's second line stays in one paragraph.
  const body = String(text ?? '').split('\n')
    .map((line, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t>`)
    .join('');
  return `<w:r><w:rPr>${props}</w:rPr>${body}</w:r>`;
}

export function para(runs, { align, spaceAfter = 0, spaceBefore = 0, keepNext = false, pageBreakBefore = false } = {}) {
  // Order matters: the schema fixes the sequence of pPr children, and Word and
  // LibreOffice both reject a document that gets it wrong.
  const props = [
    keepNext ? '<w:keepNext/>' : '',
    pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    `<w:spacing w:before="${mmToTwip(spaceBefore)}" w:after="${mmToTwip(spaceAfter)}" w:line="240" w:lineRule="auto"/>`,
    align ? `<w:jc w:val="${align}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${props}</w:pPr>${Array.isArray(runs) ? runs.join('') : runs || ''}</w:p>`;
}

/**
 * An inline image, sized in millimetres. `id` must be unique in the document.
 * `crop` trims the source by a fraction of its own width/height ({l,t,r,b}),
 * which is how a picture fills a fixed box without being stretched — Word's
 * equivalent of the PDF's `fit: 'cover'`.
 */
export function image(relId, id, widthMm, heightMm, name = 'photo', crop = null) {
  const cx = mmToEmu(widthMm);
  const cy = mmToEmu(heightMm);
  const pct = (v) => Math.max(0, Math.round((v || 0) * 100000));
  const srcRect = crop
    ? `<a:srcRect l="${pct(crop.l)}" t="${pct(crop.t)}" r="${pct(crop.r)}" b="${pct(crop.b)}"/>`
    : '';
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${esc(name)}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

const BORDER = (sz) => ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="000000"/>`).join('');

/**
 * A table with fixed column widths. `rows` is an array of arrays of cells:
 * { text | xml, bold, span, align }.
 */
export function table(colsMm, rows, { borderEighthPt = 0, cellPadMm = 1.2, rowHeightMm = 0 } = {}) {
  const grid = colsMm.map((w) => `<w:gridCol w:w="${mmToTwip(w)}"/>`).join('');
  const pad = mmToTwip(cellPadMm);
  const body = rows.map((cells) => {
    let col = 0;
    const tcs = cells.map((cell) => {
      const span = cell.span || 1;
      const width = colsMm.slice(col, col + span).reduce((a, b) => a + b, 0);
      col += span;
      const content = cell.xml !== undefined
        ? cell.xml
        : para(run(cell.text ?? '', { bold: cell.bold, size: cell.size ?? 8 }), { align: cell.align });
      return `<w:tc><w:tcPr><w:tcW w:w="${mmToTwip(width)}" w:type="dxa"/>`
        + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '')
        + `<w:tcMar><w:top w:w="${pad}" w:type="dxa"/><w:left w:w="${pad}" w:type="dxa"/>`
        + `<w:bottom w:w="${pad}" w:type="dxa"/><w:right w:w="${pad}" w:type="dxa"/></w:tcMar>`
        + `</w:tcPr>${content}</w:tc>`;
    }).join('');
    const trPr = rowHeightMm
      // CT_TrPr's documented order: cantSplit before trHeight.
      ? `<w:trPr><w:cantSplit/><w:trHeight w:val="${mmToTwip(rowHeightMm)}" w:hRule="atLeast"/></w:trPr>`
      : '';
    return `<w:tr>${trPr}${tcs}</w:tr>`;
  }).join('');
  const width = colsMm.reduce((a, b) => a + b, 0);
  return `<w:tbl><w:tblPr><w:tblW w:w="${mmToTwip(width)}" w:type="dxa"/>`
    + (borderEighthPt ? `<w:tblBorders>${BORDER(borderEighthPt)}</w:tblBorders>` : '')
    + `<w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>`
    + `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

/** "page 4 of 17" using Word's own fields, so it stays right when edited. */
export const pageOfPages = (size = 8.5) =>
  `<w:r><w:rPr><w:sz w:val="${size * 2}"/></w:rPr><w:t xml:space="preserve">page </w:t></w:r>`
  + `<w:r><w:fldChar w:fldCharType="begin"/></w:r>`
  + `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>`
  + `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  + `<w:r><w:rPr><w:sz w:val="${size * 2}"/></w:rPr><w:t xml:space="preserve"> of </w:t></w:r>`
  + `<w:r><w:fldChar w:fldCharType="begin"/></w:r>`
  + `<w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>`
  + `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Assemble the package.
 * @param sections [{ body, header, footer }] — one Word section each, so every
 *        report section can carry its own header line.
 * @param images   [{ name, bytes }]
 * @param page     { widthMm, heightMm, marginMm:{top,right,bottom,left} }
 */
export function buildDocx({ sections, images = [], page, title = '', author = '' }) {
  const zip = createZip();
  const media = images.map((img, i) => ({ ...img, file: `image${i + 1}.jpeg`, rel: `rId${100 + i}` }));

  const sectPr = (i, hasHeader) => {
    const m = page.marginMm;
    return '<w:sectPr>'
      + (hasHeader ? `<w:headerReference w:type="default" r:id="rIdH${i}"/>` : '')
      + `<w:footerReference w:type="default" r:id="rIdF${i}"/>`
      + `<w:pgSz w:w="${mmToTwip(page.widthMm)}" w:h="${mmToTwip(page.heightMm)}"/>`
      + `<w:pgMar w:top="${mmToTwip(m.top)}" w:right="${mmToTwip(m.right)}" `
      + `w:bottom="${mmToTwip(m.bottom)}" w:left="${mmToTwip(m.left)}" `
      + `w:header="${mmToTwip(m.top / 2)}" w:footer="${mmToTwip(m.bottom / 2)}" w:gutter="0"/>`
      + '</w:sectPr>';
  };

  // Every section but the last closes with its own sectPr inside a paragraph;
  // the final one lives directly in the body, as OOXML requires.
  const closeTable = (xml) => (xml.trimEnd().endsWith('</w:tbl>') ? `${xml}<w:p/>` : xml);
  const bodyXml = sections.map((s, i) => {
    const body = closeTable(s.body);
    const last = i === sections.length - 1;
    // The final section's properties live in the body; every other section ends
    // with a paragraph carrying its own, which is what starts a new page.
    if (last) return body + sectPr(i, !!s.header);
    return body + `<w:p><w:pPr>${sectPr(i, !!s.header)}</w:pPr></w:p>`;
  }).join('');

  zip.add('[Content_Types].xml', XML
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + sections.map((s, i) => (s.header ? `<Override PartName="/word/header${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` : '')
      + `<Override PartName="/word/footer${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`).join('')
    + '</Types>');

  zip.add('_rels/.rels', XML
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>');

  zip.add('docProps/core.xml', XML
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator>`
    + `<cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>`
    + '</cp:coreProperties>');

  zip.add('word/styles.xml', XML
    + `<w:styles ${DOC_NS}><w:docDefaults><w:rPrDefault><w:rPr>`
    + '<w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica" w:cs="Helvetica"/>'
    + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '</w:styles>');

  zip.add('word/document.xml', XML + `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`);

  const docRels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    ...media.map((m) => `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.file}"/>`),
    ...sections.map((s, i) => (s.header ? `<Relationship Id="rIdH${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${i}.xml"/>` : '')
      + `<Relationship Id="rIdF${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${i}.xml"/>`),
  ].join('');
  zip.add('word/_rels/document.xml.rels', XML
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels}</Relationships>`);

  sections.forEach((s, i) => {
    if (s.header) zip.add(`word/header${i}.xml`, XML + `<w:hdr ${DOC_NS}>${closeTable(s.header)}</w:hdr>`);
    zip.add(`word/footer${i}.xml`, XML + `<w:ftr ${DOC_NS}>${s.footer || para('')}</w:ftr>`);
  });

  media.forEach((m) => zip.add(`word/media/${m.file}`, m.bytes));

  return zip.build('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/** Register an image and get the relationship id to reference it with. */
export function imageRel(index) { return `rId${100 + index}`; }
