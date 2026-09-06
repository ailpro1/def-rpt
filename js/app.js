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

/* ---------- boot ---------- */
(async function boot() {
  await getSettings();
  if (!location.hash) go('#/projects', true);
  syncOnline();
  await route();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw && sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            ui.toast('Update ready — reopen the app');
          }
        });
      });
    } catch (e) { console.warn('SW registration failed', e); }
  }
  // Ask for durable storage so iOS does not evict the photo store.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); });
  }
})();
