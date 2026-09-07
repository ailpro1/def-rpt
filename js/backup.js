// Backup / restore. One self-contained JSON file so a phone can be swapped or
// a project handed to a colleague without any server.
import * as db from './db.js';
import { getSettings } from './store.js';

const FORMAT = 'instareport-backup';
const VERSION = 1;

const b64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

function fromB64(data, type = 'image/jpeg') {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

/** projectIds omitted = full backup (settings + everything). */
export async function exportBackup(projectIds = null, { onProgress } = {}) {
  const settings = await getSettings();
  const allProjects = await db.all(db.STORES.projects);
  const projects = projectIds ? allProjects.filter((p) => projectIds.includes(p.id)) : allProjects;
  const ids = projects.map((p) => p.id);

  const sections = (await db.all(db.STORES.sections)).filter((s) => ids.includes(s.projectId));
  const photos = (await db.all(db.STORES.photos)).filter((p) => ids.includes(p.projectId));

  const blobIds = new Set();
  photos.forEach((p) => [p.blobId, p.thumbId, p.flatBlobId].forEach((b) => b && blobIds.add(b)));
  if (!projectIds && settings.logoBlobId) blobIds.add(settings.logoBlobId);

  const blobs = {};
  let n = 0;
  for (const id of blobIds) {
    const rec = await db.get(db.STORES.blobs, id);
    if (rec && rec.blob) blobs[id] = { type: rec.blob.type || 'image/jpeg', data: await b64(rec.blob) };
    onProgress && onProgress(++n, blobIds.size);
  }

  const payload = {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    settings: projectIds ? null : { ...settings, ai: { ...settings.ai, key: '' } }, // never export the API key
    projects, sections, photos, blobs,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export function backupFilename(label = 'all') {
  const d = new Date().toISOString().slice(0, 10);
  return `insta-report-${label.replace(/[^\w-]+/g, '-').toLowerCase()}-${d}.json`;
}

export async function importBackup(file, { merge = true } = {}) {
  const text = await file.text();
  const data = JSON.parse(text);
  // 'fastreport-backup' is the pre-rename format tag; still accepted.
  if (data.format !== FORMAT && data.format !== 'fastreport-backup') {
    throw new Error('Not an Insta Report backup file.');
  }

  if (!merge) {
    await Promise.all([
      db.clear(db.STORES.projects), db.clear(db.STORES.sections),
      db.clear(db.STORES.photos), db.clear(db.STORES.blobs),
    ]);
  }

  const blobRecords = Object.entries(data.blobs || {}).map(([id, v]) => ({ id, blob: fromB64(v.data, v.type) }));
  await db.putMany(db.STORES.blobs, blobRecords);
  await db.putMany(db.STORES.projects, data.projects || []);
  await db.putMany(db.STORES.sections, data.sections || []);
  await db.putMany(db.STORES.photos, data.photos || []);

  if (data.settings) {
    const current = await getSettings();
    await db.put(db.STORES.settings, {
      ...data.settings,
      id: 'app',
      ai: { ...data.settings.ai, key: current.ai?.key || '' }, // keep the key already on this device
    });
  }
  return {
    projects: (data.projects || []).length,
    photos: (data.photos || []).length,
  };
}

export async function saveFile(blob, filename) {
  // Prefer the native share sheet on iOS so it can go to Files / iCloud.
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] })) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: blob.type })], title: filename });
      return 'shared';
    } catch (err) { if (err.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
