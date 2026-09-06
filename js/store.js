// Domain layer: projects, sections, photos, settings.
import * as db from './db.js';
import { DEFAULT_CAPTIONS, DEFAULT_SECTIONS } from './captions.js';

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
  photosPerPage: 6,
  imageMaxPx: 1600,
  imageQuality: 0.82,
  captionLib: DEFAULT_CAPTIONS,
  sectionLib: DEFAULT_SECTIONS,
  usage: {},              // caption text -> {n,last,sections{}}
  ai: { key: '', model: 'gemini-2.5-flash', enabled: false },
  lastBackupAt: null,
};

let _settings = null;

export async function getSettings(force = false) {
  if (_settings && !force) return _settings;
  const s = await db.get(db.STORES.settings, SETTINGS_ID);
  _settings = s ? { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } }
                : { ...DEFAULT_SETTINGS };
  return _settings;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  _settings = { ...cur, ...patch, id: SETTINGS_ID };
  await db.put(db.STORES.settings, _settings);
  return _settings;
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

export function isOkCaption(text) {
  const t = (text || '').toUpperCase();
  return t.includes('- OK') || t.includes('NO DEFECT') || t.startsWith('GENERAL VIEW')
    || t.startsWith('OVERVIEW') || t.startsWith('FRONT VIEW');
}
