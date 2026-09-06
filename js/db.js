// Minimal promise wrapper over IndexedDB. All app data lives here so the app
// is fully functional offline.
const DB_NAME = 'fastreport';
const DB_VERSION = 1;

export const STORES = {
  projects: 'projects',
  sections: 'sections',
  photos: 'photos',
  blobs: 'blobs',
  settings: 'settings',
};

let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) {
        const s = db.createObjectStore(STORES.projects, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORES.sections)) {
        const s = db.createObjectStore(STORES.sections, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const s = db.createObjectStore(STORES.photos, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('sectionId', 'sectionId');
      }
      // Image bytes are kept apart from metadata so list views stay cheap.
      if (!db.objectStoreNames.contains(STORES.blobs)) {
        db.createObjectStore(STORES.blobs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'id' });
      }
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const get = (store, id) => tx(store, 'readonly').then((s) => wrap(s.get(id)));
export const all = (store) => tx(store, 'readonly').then((s) => wrap(s.getAll()));
export const put = (store, value) => tx(store, 'readwrite').then((s) => wrap(s.put(value)).then(() => value));
export const del = (store, id) => tx(store, 'readwrite').then((s) => wrap(s.delete(id)));
export const clear = (store) => tx(store, 'readwrite').then((s) => wrap(s.clear()));

export function byIndex(store, index, value) {
  return tx(store, 'readonly').then((s) => wrap(s.index(index).getAll(value)));
}

export function putMany(store, values) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    values.forEach((v) => os.put(v));
    t.oncomplete = () => resolve(values.length);
    t.onerror = () => reject(t.error);
  }));
}

export function delMany(store, ids) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    ids.forEach((id) => os.delete(id));
    t.oncomplete = () => resolve(ids.length);
    t.onerror = () => reject(t.error);
  }));
}

export function uid(prefix = 'id') {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  return prefix + '_' + Date.now().toString(36) + '_' +
    Array.from(rnd, (b) => b.toString(36)).join('').slice(0, 8);
}

export async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  return navigator.storage.estimate();
}
