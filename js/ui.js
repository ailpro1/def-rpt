// Tiny DOM + iOS-style presentation helpers. No framework, no build step.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  children.flat(3).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  });
  return el;
}

export const svg = (paths, size = 24) =>
  h('span', { html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${paths}</svg>` }).firstChild;

export const ICON = {
  chevron: '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l1.6-2h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  photos: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  share: '<path d="M12 15V4M8.5 7.5L12 4l3.5 3.5"/><path d="M5 13v6h14v-6"/>',
  gear: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
  more: '<circle cx="12" cy="12" r="9"/><circle cx="8.4" cy="12" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.6" cy="12" r="1.05" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
  down: '<path d="M12 4v12M7.5 11.5L12 16l4.5-4.5"/><path d="M5 20h14"/>',
  up: '<path d="M12 20V8M7.5 12.5L12 8l4.5 4.5"/><path d="M5 4h14"/>',
  move: '<path d="M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="1.5"/><path d="M7 14h10v6H7z"/>',
};

export const icon = (name, size = 24) => svg(ICON[name] || '', size);

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/* ---------------- nav bar ---------------- */
export function navbar({ title, sub, left, right, largeTitle, search }) {
  const row = h('div', { class: 'navbar-row' },
    left || h('span', { style: { minWidth: '44px' } }),
    h('div', { class: 'navbar-title', text: largeTitle ? '' : (title || '') }),
    right || h('span', { style: { minWidth: '44px' } }));
  const bar = h('div', { class: 'navbar' }, row);
  if (largeTitle) {
    bar.appendChild(h('div', { class: 'large-title', text: title || '' }));
    if (sub) bar.appendChild(h('div', { class: 'nav-sub', text: sub }));
  } else if (sub) {
    bar.appendChild(h('div', { class: 'nav-sub', style: { paddingBottom: '8px' }, text: sub }));
  }
  if (search) bar.appendChild(h('div', { class: 'searchbar' }, search));
  return bar;
}

export const navBtn = (label, onclick, opts = {}) =>
  h('button', { class: 'nb-btn' + (opts.strong ? ' strong' : ''), onclick, disabled: opts.disabled },
    opts.icon ? icon(opts.icon, 22) : null, label ? h('span', { text: label }) : null);

export const backBtn = (onclick, label = 'Back') =>
  h('button', { class: 'nb-btn', onclick }, icon('back', 22), h('span', { text: label }));

/* ---------------- rows ---------------- */
export function row(opts = {}) {
  const { title, sub, value, iconName, iconColor, onclick, chevron = false, right, cls = '' } = opts;
  const r = h(onclick ? 'button' : 'div', { class: 'row ' + cls, onclick });
  if (iconName) r.appendChild(h('div', { class: 'row-icon', style: { background: iconColor || 'var(--sys-blue)' } }, icon(iconName, 18)));
  const main = h('div', { class: 'r-main' }, h('div', { class: 'r-title', text: title || '' }));
  if (sub) main.appendChild(h('div', { class: 'r-sub', text: sub }));
  r.appendChild(main);
  if (value !== undefined && value !== null) r.appendChild(h('div', { class: 'r-val', text: String(value) }));
  if (right) r.appendChild(right);
  if (chevron) {
    const c = icon('chevron', 18);
    c.setAttribute('class', 'chev');
    r.appendChild(c);
  }
  return r;
}

export function inputRow(label, value, oninput, opts = {}) {
  const input = h('input', {
    type: opts.type || 'text', value: value ?? '',
    placeholder: opts.placeholder || '', inputmode: opts.inputmode,
    oninput: (e) => oninput(e.target.value),
  });
  return h('div', { class: 'row' }, h('div', { class: 'r-main' }, h('div', { class: 'r-title', text: label })), input);
}

export function textRow(label, value, oninput, opts = {}) {
  const ta = h('textarea', { placeholder: opts.placeholder || '', oninput: (e) => oninput(e.target.value) });
  ta.value = value ?? '';
  if (opts.rows) ta.rows = opts.rows;
  return h('div', { class: 'row stack' }, h('label', { text: label }), ta);
}

export function switchRow(label, checked, onchange, sub) {
  const input = h('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
  input.checked = !!checked;
  return row({ title: label, sub, right: h('label', { class: 'switch' }, input, h('span')) });
}

export const group = (title, ...rows) =>
  h('div', { class: 'group' }, title ? h('div', { class: 'group-title', text: title }) : null,
    h('div', { class: 'list' }, ...rows.flat().filter(Boolean)));

/* ---------------- type-ahead ---------------- */
/**
 * Suggestion list under a text field. Sits in the flow rather than floating, so
 * it behaves inside a scrolling sheet with the keyboard up.
 *
 * `source(query)` returns [{ text, group }]. Picking one keeps the field
 * focused — the keyboard staying up is the difference between fast and not.
 */
export function autocomplete(field, { source, onPick, minChars = 1 }) {
  const box = h('div', { class: 'ac', hidden: true });

  const close = () => { box.hidden = true; clear(box); };

  // The field is usually built before it is added to a sheet, and
  // insertAdjacentElement is a no-op on a node with no parent — so attach the
  // list the first time it is needed instead.
  const attach = () => {
    if (!box.parentNode && field.parentNode) field.insertAdjacentElement('afterend', box);
    return !!box.parentNode;
  };

  function render() {
    const query = field.value || '';
    // The last line is what is being typed; earlier lines are already settled.
    const active = query.split('\n').pop();
    if (active.trim().length < minChars) return close();
    const items = source(active) || [];
    // Nothing to offer once the field already holds the whole caption.
    if (!items.length || (items.length === 1 && items[0].text === query)) return close();
    if (!attach()) return;

    clear(box);
    items.forEach((item) => {
      const row = h('button', { class: 'ac-row', type: 'button' },
        h('div', { class: 'ac-t', text: item.text.replace(/\n/g, ' · ') }),
        item.group ? h('div', { class: 'ac-s', text: item.group }) : null);
      // pointerdown, not click: the default would blur the field and drop the
      // keyboard before the tap registers.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        haptic();
        onPick(item);
        close();
        field.focus();
        const end = field.value.length;
        try { field.setSelectionRange(end, end); } catch { /* not all fields support it */ }
      });
      box.appendChild(row);
    });
    box.hidden = false;
  }

  field.addEventListener('input', render);
  field.addEventListener('focus', () => {
    render();
    // Bring the field to the top of its scroller so the suggestions have room
    // once the keyboard is up.
    setTimeout(() => {
      try { field.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* older Safari */ }
    }, 260);
  });
  field.addEventListener('blur', () => setTimeout(close, 150));
  field.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return { render, close, destroy: () => { close(); box.remove(); } };
}

/* ---------------- toast ---------------- */
let toastTimer = null;
export function toast(msg, ms = 1900) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- alert / confirm / prompt ---------------- */
function present(node, { onDismiss } = {}) {
  const host = document.getElementById('sheet-host');
  const scrim = h('div', { class: 'scrim', onclick: () => close() });
  const close = () => { scrim.remove(); node.remove(); onDismiss && onDismiss(); };
  host.appendChild(scrim);
  host.appendChild(node);
  return close;
}

/* Resolve a presentation promise exactly once: a button press must win over
   the dismiss handler that its own close() triggers. */
function once(resolve) {
  let settled = false;
  return (value) => { if (!settled) { settled = true; resolve(value); } };
}

export function alert(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const settle = once(resolve);
    const box = h('div', { class: 'alert' });
    let close;
    box.append(
      h('div', { class: 'a-body' }, h('h4', { text: title }), message ? h('p', { text: message }) : null),
      h('div', { class: 'a-btns' }, h('button', { class: 'primary', onclick: () => { settle(true); close(); }, text: okLabel })));
    close = present(box, { onDismiss: () => settle(true) });
  });
}

export function confirm(title, message, { okLabel = 'OK', destructive = false } = {}) {
  return new Promise((resolve) => {
    const settle = once(resolve);
    const box = h('div', { class: 'alert' });
    let close;
    box.append(
      h('div', { class: 'a-body' }, h('h4', { text: title }), message ? h('p', { text: message }) : null),
      h('div', { class: 'a-btns' },
        h('button', { onclick: () => { settle(false); close(); }, text: 'Cancel' }),
        h('button', { class: 'primary' + (destructive ? ' destructive' : ''), onclick: () => { settle(true); close(); }, text: okLabel })));
    close = present(box, { onDismiss: () => settle(false) });
  });
}

export function prompt(title, message, value = '', { multiline = false, okLabel = 'Save', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? h('textarea', { placeholder })
      : h('input', { type: 'text', placeholder, autocapitalize: 'characters' });
    field.value = value;
    const settle = once(resolve);
    const box = h('div', { class: 'alert' });
    let close;
    const done = () => { settle(field.value); close(); };
    if (!multiline) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    box.append(
      h('div', { class: 'a-body' }, h('h4', { text: title }), message ? h('p', { text: message }) : null, field),
      h('div', { class: 'a-btns' },
        h('button', { onclick: () => { settle(null); close(); }, text: 'Cancel' }),
        h('button', { class: 'primary', onclick: done, text: okLabel })));
    close = present(box, { onDismiss: () => settle(null) });
    setTimeout(() => field.focus(), 60);
  });
}

/* ---------------- sheet ---------------- */
export function sheet({ title, body, leftLabel = 'Cancel', rightLabel, onRight, onClose, height }) {
  const el = h('div', { class: 'sheet' });
  if (height) el.style.height = height;
  let close;
  const head = h('div', { class: 'sheet-head' },
    h('button', { class: 'nb-btn', onclick: () => close(), text: leftLabel }),
    h('div', { class: 't', text: title || '' }),
    rightLabel
      ? h('button', { class: 'nb-btn strong', onclick: async () => { const keep = await onRight?.(); if (keep !== false) close(); }, text: rightLabel })
      : h('span', { style: { minWidth: '44px' } }));
  el.append(h('div', { class: 'sheet-grab' }), head, h('div', { class: 'sheet-body' }, body));
  close = present(el, { onDismiss: onClose });
  return { el, close: () => close() };
}

export function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const settle = once(resolve);
    let close;
    const list = h('div', { class: 'list', style: { margin: '10px 12px' } },
      ...actions.map((a) => row({
        title: a.label, sub: a.sub, iconName: a.icon, iconColor: a.color,
        cls: a.destructive ? 'destructive' : (a.primary ? 'action' : ''),
        onclick: () => { settle(a.value ?? a.label); close(); },
      })));
    const body = h('div', {}, list,
      h('div', { class: 'btn-stack' }, h('button', { class: 'btn gray wide', onclick: () => { settle(null); close(); }, text: 'Cancel' })));
    const s = sheet({ title, body, leftLabel: '', onClose: () => settle(null) });
    close = s.close;
  });
}

/* ---------------- misc ---------------- */
export function empty(iconName, title, text, actionLabel, onAction) {
  return h('div', { class: 'empty' },
    icon(iconName, 46),
    h('h3', { text: title }),
    text ? h('p', { text }) : null,
    actionLabel ? h('button', { class: 'btn', onclick: onAction, text: actionLabel }) : null);
}

export const fmtDate = (v) => {
  if (!v) return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(v + 'T00:00:00');
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const STAMP_FORMATS = [
  ['ymd24', '2026.08.15 17:23'],
  ['dmy24', '15/08/2026 17:23'],
  ['dmy12', '15/08/2026 5:23 PM'],
  ['date', '15/08/2026'],
];

export function formatStamp(ts, format = 'ymd24') {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear(), M = p(d.getMonth() + 1), D = p(d.getDate());
  const hh = p(d.getHours()), mm = p(d.getMinutes());
  if (format === 'dmy24') return `${D}/${M}/${Y} ${hh}:${mm}`;
  if (format === 'dmy12') {
    const h12 = d.getHours() % 12 || 12;
    return `${D}/${M}/${Y} ${h12}:${mm} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }
  if (format === 'date') return `${D}/${M}/${Y}`;
  return `${Y}.${M}.${D} ${hh}:${mm}`;
}

/** Value for an <input type="datetime-local">, in local time. */
export function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fmtBytes = (n) => {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
};

export const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } };
