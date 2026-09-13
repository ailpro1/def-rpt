// Domain layer: projects, sections, photos, settings.
import * as db from './db.js';
import { BUILD } from './build.js';
import { DEFAULT_CAPTIONS, DEFAULT_SECTIONS, DEFAULT_COMPONENTS, LIB_SEED_VERSION } from './captions.js';

export const SETTINGS_ID = 'app';

export const DEFAULT_SETTINGS = {
  id: SETTINGS_ID,
  company: '',
  preparedBy: '',
  contact: '',
  logoBlobId: null,
  reportTitle: 'DEFECT INSPECTION REPORT',
  coverEnabled: true,
  coverKicker: 'INSPECTION REPORT',
  coverBody: '',
  summaryEnabled: true,
  summaryTitle: 'EXECUTIVE SUMMARY',
  summaryBody:
    'This report records the defects observed during the inspection of the property stated above. '
    + 'Each item is photographed and captioned by location. Items marked as observed require '
    + 'rectification by the contractor prior to handover.\n\n'
    + 'Inspection was carried out visually and with hand instruments only. No dismantling, '
    + 'destructive testing or opening up of concealed works was performed.',
  summaryTableEnabled: true,
  notesEnabled: false,
  notesTitle: 'NOTES & LIMITATIONS',
  notesBody: '',
  footerText: '',
  reportFormat: 'captions',    // 'captions' = photo captions; 'table' = defect table per section
  photosPerPage: 6,
  pageNumbering: 'document',   // 'document' = page 4 of 17; 'section' = the older per-section style
  stampEnabled: true,
  stampFormat: 'ymd24',    // 2026.08.15 17:23 — matches the sample reports
  stampPosition: 'br',
  stampInShare: true,
  imageMaxPx: BUILD.defaultImageMaxPx || 1600,
  imageQuality: 0.82,
  aiImagePx: 768,          // one Gemini image tile — cheapest useful size
  captionLib: DEFAULT_CAPTIONS,
  sectionLib: DEFAULT_SECTIONS,
  componentLib: DEFAULT_COMPONENTS,
  usage: {},              // caption text -> {n,last,sections{}}
  libSeedVersion: LIB_SEED_VERSION,
  ai: { key: '', model: 'gemini-2.5-flash', enabled: false, auto: true, available: [], checkedAt: null },
  lastBackupAt: null,
};

let _settings = null;

export async function getSettings(force = false) {
  if (_settings && !force) return _settings;
  const s = await db.get(db.STORES.settings, SETTINGS_ID);
  _settings = s ? { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } }
                : { ...DEFAULT_SETTINGS };
  // Read the version off the STORED row, not off the merge: DEFAULT_SETTINGS
  // supplies libSeedVersion, so an old row that lacks the key would otherwise
  // look current and never migrate.
  if (s && (s.libSeedVersion || 0) < LIB_SEED_VERSION) await mergeSeedLibraries();
  return _settings;
}

/**
 * A stored library is the user's own — we never overwrite it. When the shipped
 * seeds grow, append only the entries the user does not already have, keeping
 * their edits, their order and anything they removed on purpose is re-added
 * only once (libSeedVersion guards the repeat).
 */
async function mergeSeedLibraries() {
  const cur = _settings;
  // Stamp first: saveSettings() re-enters getSettings(), which would otherwise
  // see the old version and recurse.
  _settings = { ...cur, libSeedVersion: LIB_SEED_VERSION };
  const seen = new Set();
  const lib = (cur.captionLib || []).map((g) => ({ ...g, items: [...g.items] }));
  lib.forEach((g) => g.items.forEach((i) => seen.add(i.trim().toUpperCase())));
  let added = 0;
  DEFAULT_CAPTIONS.forEach((sg) => {
    const fresh = sg.items.filter((i) => !seen.has(i.trim().toUpperCase()));
    if (!fresh.length) return;
    fresh.forEach((i) => seen.add(i.trim().toUpperCase()));
    added += fresh.length;
    const g = lib.find((x) => x.group === sg.group);
    if (g) g.items.push(...fresh);
    else lib.push({ group: sg.group, items: fresh });
  });
  const mergeFlat = (stored, seeds) => {
    const have = new Set((stored || []).map((x) => x.trim().toUpperCase()));
    const fresh = seeds.filter((x) => !have.has(x.trim().toUpperCase()));
    return fresh.length ? [...(stored || []), ...fresh] : (stored || []);
  };
  const sectionLib = mergeFlat(cur.sectionLib, DEFAULT_SECTIONS);
  const componentLib = mergeFlat(cur.componentLib, DEFAULT_COMPONENTS);
  await saveSettings({
    captionLib: added ? lib : cur.captionLib,
    sectionLib,
    componentLib,
    libSeedVersion: LIB_SEED_VERSION,
  });
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  _settings = { ...cur, ...patch, id: SETTINGS_ID };
  await db.put(db.STORES.settings, _settings);
  return _settings;
}

/** Is this exact caption already in the library? */
export async function captionInLibrary(text) {
  const s = await getSettings();
  const needle = (text || '').trim().toUpperCase();
  if (!needle) return true;
  return s.captionLib.some((g) => g.items.some((i) => i.trim().toUpperCase() === needle));
}

/** Add a caption to a library group, creating the group if it is new. */
export async function addCaptionToLibrary(text, groupName) {
  const s = await getSettings();
  const value = (text || '').trim();
  if (!value) return null;
  const lib = s.captionLib.map((g) => ({ ...g, items: [...g.items] }));
  let group = lib.find((g) => g.group === groupName);
  if (!group) { group = { group: groupName || 'General', items: [] }; lib.push(group); }
  if (!group.items.some((i) => i.trim().toUpperCase() === value.toUpperCase())) group.items.push(value);
  await saveSettings({ captionLib: lib });
  return group.group;
}

export async function noteCaptionUse(text, sectionTitle) {
  if (!text) return;
  const s = await getSettings();
  const usage = { ...s.usage };
  const sec = (sectionTitle || '').toUpperCase();
  const u = usage[text] || { n: 0, last: 0, sections: {} };
  u.n += 1; u.last = Date.now();
  u.sections = { ...u.sections, [sec]: (u.sections[sec] || 0) + 1 };
  usage[text] = u;
  await saveSettings({ usage });
}

/* ------------------------- projects ------------------------- */

export async function listProjects() {
  const rows = await db.all(db.STORES.projects);
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows;
}

export async function createProject(data = {}) {
  const s = await getSettings();
  const now = Date.now();
  const p = {
    id: db.uid('prj'),
    name: data.name || 'Untitled Inspection',
    address: data.address || '',
    client: data.client || '',
    ref: data.ref || '',
    unitType: data.unitType || '',
    inspector: data.inspector || s.preparedBy || '',
    inspectionDate: data.inspectionDate || new Date().toISOString().slice(0, 10),
    status: 'open',
    coverOverride: null,
    summaryOverride: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.put(db.STORES.projects, p);
  return p;
}

export const getProject = (id) => db.get(db.STORES.projects, id);

export async function updateProject(id, patch) {
  const p = await getProject(id);
  if (!p) return null;
  const next = { ...p, ...patch, updatedAt: Date.now() };
  await db.put(db.STORES.projects, next);
  return next;
}

export async function deleteProject(id) {
  const photos = await db.byIndex(db.STORES.photos, 'projectId', id);
  const blobIds = [];
  photos.forEach((ph) => { blobIds.push(ph.blobId); if (ph.flatBlobId) blobIds.push(ph.flatBlobId); });
  await db.delMany(db.STORES.blobs, blobIds.filter(Boolean));
  await db.delMany(db.STORES.photos, photos.map((p) => p.id));
  const sections = await db.byIndex(db.STORES.sections, 'projectId', id);
  await db.delMany(db.STORES.sections, sections.map((s) => s.id));
  await db.del(db.STORES.projects, id);
}

export async function duplicateProject(id, name) {
  const src = await getProject(id);
  if (!src) return null;
  const p = await createProject({ ...src, name: name || src.name + ' (copy)' });
  const sections = await listSections(id);
  for (const sec of sections) await createSection(p.id, sec.title);
  return p;
}

/* ------------------------- sections ------------------------- */

export async function listSections(projectId) {
  const rows = await db.byIndex(db.STORES.sections, 'projectId', projectId);
  rows.sort((a, b) => a.order - b.order);
  return rows;
}

export async function createSection(projectId, title) {
  const existing = await listSections(projectId);
  const sec = {
    id: db.uid('sec'),
    projectId,
    title: (title || 'NEW SECTION').toUpperCase(),
    order: existing.length ? Math.max(...existing.map((s) => s.order)) + 1 : 0,
    createdAt: Date.now(),
  };
  await db.put(db.STORES.sections, sec);
  await touch(projectId);
  return sec;
}

export async function updateSection(id, patch) {
  const s = await db.get(db.STORES.sections, id);
  if (!s) return null;
  const next = { ...s, ...patch };
  if (next.title) next.title = next.title.toUpperCase();
  await db.put(db.STORES.sections, next);
  await touch(next.projectId);
  return next;
}

export async function reorderSections(projectId, orderedIds) {
  const rows = await listSections(projectId);
  const map = new Map(rows.map((r) => [r.id, r]));
  const next = orderedIds.map((id, i) => ({ ...map.get(id), order: i })).filter((r) => r.id);
  await db.putMany(db.STORES.sections, next);
  await touch(projectId);
}

export async function deleteSection(id) {
  const sec = await db.get(db.STORES.sections, id);
  const photos = await db.byIndex(db.STORES.photos, 'sectionId', id);
  const blobIds = [];
  photos.forEach((ph) => { blobIds.push(ph.blobId); if (ph.flatBlobId) blobIds.push(ph.flatBlobId); });
  await db.delMany(db.STORES.blobs, blobIds.filter(Boolean));
  await db.delMany(db.STORES.photos, photos.map((p) => p.id));
  await db.del(db.STORES.sections, id);
  if (sec) await touch(sec.projectId);
}

/* ------------------------- photos ------------------------- */

export async function listPhotos(sectionId) {
  const rows = await db.byIndex(db.STORES.photos, 'sectionId', sectionId);
  rows.sort((a, b) => a.order - b.order);
  return rows;
}

export const listProjectPhotos = (projectId) => db.byIndex(db.STORES.photos, 'projectId', projectId);

export async function addPhoto(projectId, sectionId, blob, thumb, meta = {}) {
  const existing = await listPhotos(sectionId);
  const blobId = db.uid('blb');
  await db.put(db.STORES.blobs, { id: blobId, blob });
  const thumbId = db.uid('thb');
  await db.put(db.STORES.blobs, { id: thumbId, blob: thumb });
  const photo = {
    id: db.uid('pho'),
    projectId, sectionId, blobId, thumbId,
    takenAt: meta.takenAt || Date.now(),
    takenSource: meta.takenSource || 'now',
    component: '',
    flatBlobId: null,
    ops: [],
    caption: '',
    caption2: '',
    tags: [],
    severity: '',
    order: existing.length ? Math.max(...existing.map((p) => p.order)) + 1 : 0,
    createdAt: Date.now(),
    meta,
  };
  await db.put(db.STORES.photos, photo);
  await touch(projectId);
  return photo;
}

export const getPhoto = (id) => db.get(db.STORES.photos, id);

export async function updatePhoto(id, patch) {
  const p = await getPhoto(id);
  if (!p) return null;
  const next = { ...p, ...patch };
  await db.put(db.STORES.photos, next);
  await touch(next.projectId);
  return next;
}

export async function deletePhoto(id) {
  const p = await getPhoto(id);
  if (!p) return;
  await db.delMany(db.STORES.blobs, [p.blobId, p.thumbId, p.flatBlobId].filter(Boolean));
  await db.del(db.STORES.photos, id);
  await touch(p.projectId);
}

export async function reorderPhotos(sectionId, orderedIds) {
  const rows = await listPhotos(sectionId);
  const map = new Map(rows.map((r) => [r.id, r]));
  const next = orderedIds.map((id, i) => ({ ...map.get(id), order: i })).filter((r) => r.id);
  await db.putMany(db.STORES.photos, next);
  if (next[0]) await touch(next[0].projectId);
}

export async function movePhotos(ids, targetSectionId) {
  const target = await db.get(db.STORES.sections, targetSectionId);
  if (!target) return;
  const existing = await listPhotos(targetSectionId);
  let order = existing.length ? Math.max(...existing.map((p) => p.order)) + 1 : 0;
  const updated = [];
  for (const id of ids) {
    const p = await getPhoto(id);
    if (p) updated.push({ ...p, sectionId: targetSectionId, order: order++ });
  }
  await db.putMany(db.STORES.photos, updated);
  await touch(target.projectId);
}

/* ------------------------- blobs ------------------------- */

export async function getBlob(id) {
  if (!id) return null;
  const rec = await db.get(db.STORES.blobs, id);
  return rec ? rec.blob : null;
}
export async function putBlob(blob) {
  const id = db.uid('blb');
  await db.put(db.STORES.blobs, { id, blob });
  return id;
}
export const deleteBlob = (id) => (id ? db.del(db.STORES.blobs, id) : Promise.resolve());

/* Display blob: flattened (annotated) version if present, else original. */
export const displayBlobId = (photo) => photo.flatBlobId || photo.blobId;

/* ------------------------- defect-table grouping ------------------------- */


/**
 * Split a section's photos into COMPONENT blocks for the defect-table format.
 * Photos keep their order; blocks appear in the order their component is first
 * seen. Photos with no component fall into one unnamed block.
 */
export function componentBlocks(photos) {
  const order = [];
  const byComponent = new Map();
  photos.forEach((p) => {
    const key = (p.component || '').trim().toUpperCase();
    if (!byComponent.has(key)) { byComponent.set(key, []); order.push(key); }
    byComponent.get(key).push(p);
  });
  return order.map((component) => ({ component, photos: byComponent.get(component) }));
}

/**
 * The DEFECT cell: captions collapsed into picture references, the way the
 * reference reports read — "(PIC 1-3) UNFILLED GROUT  (PIC 4) HOLLOW TILE".
 * Photos are numbered from 1 within their block.
 */
export function defectSummary(photos) {
  const runs = [];
  photos.forEach((p, i) => {
    const caption = (p.caption || '').replace(/\n/g, ' ').trim().toUpperCase();
    if (!caption) return;
    const last = runs[runs.length - 1];
    if (last && last.caption === caption && last.to === i) last.to = i + 1;
    else runs.push({ caption, from: i, to: i + 1 });
  });
  return runs
    .map((r) => `(PIC ${r.from + 1}${r.to > r.from + 1 ? `-${r.to}` : ''}) ${r.caption}`)
    .join('   ');
}

/** Components already used in a project, for suggesting the next one. */
export async function usedComponents(projectId) {
  const photos = await listProjectPhotos(projectId);
  const seen = new Set();
  photos.forEach((p) => { if (p.component) seen.add(p.component.trim().toUpperCase()); });
  return [...seen].sort();
}

/** When the photo was taken. Falls back for records made before stamps existed. */
export const photoTakenAt = (photo) =>
  (photo && (photo.takenAt || (photo.meta && (photo.meta.takenAt || photo.meta.ts)) || photo.createdAt)) || null;

async function touch(projectId) {
  const p = await getProject(projectId);
  if (p) await db.put(db.STORES.projects, { ...p, updatedAt: Date.now() });
}

/* ------------------------- stats ------------------------- */

export async function projectStats(projectId) {
  const [sections, photos] = await Promise.all([
    listSections(projectId),
    listProjectPhotos(projectId),
  ]);
  const bySection = {};
  photos.forEach((p) => { bySection[p.sectionId] = (bySection[p.sectionId] || 0) + 1; });
  const defects = photos.filter((p) => !isOkCaption(p.caption)).length;
  return { sections: sections.length, photos: photos.length, defects, bySection };
}

/**
 * Photos whose capture time does not sit near the inspection date. A site phone
 * with a wrong clock stamps every photo months out, and that only shows up once
 * the report is being written — so surface it on the project screen.
 */
export async function timeAnomalies(projectId, { toleranceDays = 2 } = {}) {
  const project = await getProject(projectId);
  if (!project) return { total: 0, offDate: [], noSource: [], offsetDays: 0 };
  const photos = await listProjectPhotos(projectId);
  const base = project.inspectionDate ? new Date(project.inspectionDate + 'T12:00:00').getTime() : null;
  const window = toleranceDays * 864e5;

  const offDate = [];
  const noSource = [];
  const deltas = [];
  photos.forEach((p) => {
    if (p.takenSource === 'now' || !photoTakenAt(p)) { noSource.push(p); return; }
    if (base === null) return;
    const delta = photoTakenAt(p) - base;
    if (Math.abs(delta) > window) { offDate.push(p); deltas.push(delta); }
  });

  // A single consistent offset means one wrong clock, which is correctable in bulk.
  deltas.sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  return {
    total: photos.length,
    offDate,
    noSource,
    offsetDays: Math.round(median / 864e5),
  };
}

/** Move a set of photos onto the inspection date, keeping each time of day. */
export async function retimeToDate(photoIds, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const updated = [];
  for (const id of photoIds) {
    const p = await getPhoto(id);
    if (!p) continue;
    const was = new Date(photoTakenAt(p) || p.createdAt);
    const next = new Date(y, m - 1, d, was.getHours(), was.getMinutes(), was.getSeconds());
    updated.push({ ...p, takenAt: next.getTime(), takenSource: 'corrected' });
  }
  await db.putMany(db.STORES.photos, updated);
  if (updated[0]) await touch(updated[0].projectId);
  return updated.length;
}

export function isOkCaption(text) {
  const t = (text || '').toUpperCase();
  return t.includes('- OK') || t.includes('NO DEFECT') || t.startsWith('GENERAL VIEW')
    || t.startsWith('OVERVIEW') || t.startsWith('FRONT VIEW');
}
