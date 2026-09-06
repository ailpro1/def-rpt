// Router + shell. Screens are plain modules that return a DOM node.
import * as ui from './ui.js';
import { getSettings } from './store.js';
import { revokeAll } from './image.js';

import renderProjects from './screens/projects.js';
import renderProject from './screens/project.js';
import renderSection from './screens/section.js';
import renderReport from './screens/report.js';
import renderSettings from './screens/settings.js';
import renderLibrary from './screens/library.js';

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

const ROUTES = [
  { re: /^#\/projects$/, render: renderProjects, tab: '#/projects' },
  { re: /^#\/project\/([^/]+)$/, render: renderProject, tab: '#/projects' },
  { re: /^#\/section\/([^/]+)$/, render: renderSection, tab: '#/projects', hideTabs: true },
  { re: /^#\/report\/([^/]+)$/, render: renderReport, tab: '#/projects', hideTabs: true },
  { re: /^#\/library$/, render: renderLibrary, tab: '#/library' },
  { re: /^#\/settings$/, render: renderSettings, tab: '#/settings' },
];

export function go(hash, replace = false) {
  if (replace) location.replace(hash); else location.hash = hash;
}
export const back = () => history.length > 1 ? history.back() : go('#/projects');

let currentToken = 0;

async function route() {
  const hash = location.hash || '#/projects';
  const match = ROUTES.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  if (!match) return go('#/projects', true);

  const token = ++currentToken;
  const scrollKey = 'sc:' + hash;
  revokeAll();

  let node;
  try {
    node = await match.r.render(...match.m.slice(1));
  } catch (err) {
    console.error(err);
    node = ui.h('div', { class: 'screen' },
      ui.navbar({ title: 'Error', left: ui.backBtn(back) }),
      ui.empty('x', 'Something went wrong', String(err && err.message || err), 'Go to Projects', () => go('#/projects')));
  }
  if (token !== currentToken) return;

  ui.clear(app);
  app.appendChild(node);

  tabbar.hidden = !!match.r.hideTabs;
  app.style.paddingBottom = match.r.hideTabs ? '0' : '';
  [...tabbar.querySelectorAll('.tab')].forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.route === match.r.tab));
  });

  const scroller = node.querySelector('.scroll');
  if (scroller) {
    const saved = Number(sessionStorage.getItem(scrollKey) || 0);
    if (saved) scroller.scrollTop = saved;
    let t = null;
    scroller.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => sessionStorage.setItem(scrollKey, String(scroller.scrollTop)), 120);
    }, { passive: true });
  }
}

tabbar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) { ui.haptic(); go(btn.dataset.route); }
});

window.addEventListener('hashchange', route);

/* ---------- offline indicator ---------- */
function syncOnline() {
  let pill = document.querySelector('.offline-pill');
  if (navigator.onLine) { pill && pill.remove(); return; }
  if (!pill) {
    pill = ui.h('div', { class: 'offline-pill', text: 'Offline — saving on device' });
    document.body.appendChild(pill);
  }
}
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);

/* ---------- automatic updates ---------- */
/* A new service worker installs in the background, then waits. When the app is
   idle we show "App is updating", hand over, and reload onto the new version. */
const UPDATE_CHECK_MS = 30 * 60 * 1000;
let handingOver = false;

function showUpdating() {
  if (document.querySelector('.updating')) return;
  document.body.appendChild(ui.h('div', { class: 'updating' },
    ui.h('div', { class: 'u-box' },
      ui.h('span', { class: 'spinner' }),
      ui.h('p', { text: 'App is updating. Please wait…' }),
      ui.h('small', { text: 'Your projects and photos are not affected.' }))));
}

/* Never interrupt an open editor or sheet — a half-drawn annotation would be
   lost. Wait for the screen to be idle, then take the update. */
const busy = () => !!document.querySelector('.editor, .sheet, .alert');

function handOver(worker) {
  if (handingOver || !worker) return;
  handingOver = true;
  const go = () => {
    if (busy() || document.hidden) return setTimeout(go, 2000);
    showUpdating();
    // Hold the message on screen long enough to read before the reload.
    setTimeout(() => worker.postMessage('skipWaiting'), 700);
    // Safety net: if the handover event never arrives, reload anyway.
    setTimeout(() => reloadOnce(), 6000);
  };
  go();
}

let reloaded = false;
function reloadOnce() {
  if (reloaded) return;
  reloaded = true;
  showUpdating();
  location.reload();
}

async function setupUpdates() {
  const reg = await navigator.serviceWorker.register('./sw.js');
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);

  if (reg.waiting && navigator.serviceWorker.controller) handOver(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      // No controller means this is the very first install — nothing to replace.
      if (sw.state === 'installed' && navigator.serviceWorker.controller) handOver(sw);
    });
  });

  const check = () => reg.update().catch(() => {});
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('online', check);
}

/* ---------- boot ---------- */
(async function boot() {
  await getSettings();
  if (!location.hash) go('#/projects', true);
  syncOnline();
  await route();

  if ('serviceWorker' in navigator) {
    try { await setupUpdates(); } catch (e) { console.warn('SW registration failed', e); }
  }
  // Ask for durable storage so iOS does not evict the photo store.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); });
  }
})();
