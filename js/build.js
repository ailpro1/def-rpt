// Build profile. `tools/build.mjs` rewrites this file for each variant, so the
// same source tree produces both apps.
//
//   admin — full app, AI assistant on, generates the report
//   site  — capture only: no assistant, no API key, smaller photos, one file out
export const BUILD = {
  id: 'admin',
  name: 'Insta Report',
  shortName: 'Insta Report',
  // Kept apart so both apps can live on one phone: GitHub Pages serves them
  // from the same origin, and IndexedDB is per-origin, not per-path.
  dbName: 'instareport',
  ai: true,
  fullBackup: true,
  defaultImageMaxPx: 1600,
};
