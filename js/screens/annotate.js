// Full-screen annotation editor. Strokes are stored as normalised vector ops so
// a photo can be re-edited later and re-rendered at any size.
import * as ui from '../ui.js';
import { decode, drawOps, flatten } from '../image.js';

const TOOLS = [
  { id: 'ellipse', label: 'Circle', icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: 'arrow', label: 'Arrow', icon: '<path d="M5 19L19 5M11 5h8v8"/>' },
  { id: 'rect', label: 'Box', icon: '<rect x="4.5" y="6.5" width="15" height="11" rx="1.5"/>' },
  { id: 'free', label: 'Draw', icon: '<path d="M4 20c4-1 5-14 9-14s3 10 7 9"/>' },
  { id: 'text', label: 'Text', icon: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>' },
  { id: 'dot', label: 'Dot', icon: '<circle cx="12" cy="12" r="4" fill="currentColor"/>' },
];
const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];

export function openEditor({ blob, ops = [], title = '', onSave }) {
  return new Promise((resolve) => {
    let tool = 'ellipse';
    let color = COLORS[0];
    let width = 0.006;
    const work = ops.map((o) => ({ ...o, points: o.points.map((p) => [...p]) }));
    const redo = [];
    let drawing = null;

    const canvas = ui.h('canvas');
    const stage = ui.h('div', { class: 'e-stage' }, canvas);
    const root = ui.h('div', { class: 'editor' });

    const top = ui.h('div', { class: 'e-top' },
      ui.h('button', { onclick: () => close(false), text: 'Cancel' }),
      ui.h('div', { class: 't', text: title || 'Annotate' }),
      ui.h('button', { class: 'done', onclick: () => save(), text: 'Done' }));

    const toolRow = ui.h('div', { class: 'toolrow' });
    const undoBtn = ui.h('button', {
      class: 'toolbtn', onclick: () => { if (work.length) { redo.push(work.pop()); render(); } },
    }, ui.h('span', { html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 14l-5-5 5-5"/><path d="M4 9h9a6 6 0 1 1 0 12H7"/></svg>' }).firstChild,
       ui.h('span', { text: 'Undo' }));
    const clearBtn = ui.h('button', {
      class: 'toolbtn', onclick: async () => {
        if (!work.length) return;
        const ok = await ui.confirm('Clear annotations?', '', { okLabel: 'Clear', destructive: true });
        if (ok) { work.length = 0; render(); }
      },
    }, ui.h('span', { html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18"/></svg>' }).firstChild,
       ui.h('span', { text: 'Clear' }));

    TOOLS.forEach((t) => {
      const b = ui.h('button', {
        class: 'toolbtn', 'aria-pressed': String(tool === t.id),
        onclick: () => { tool = t.id; ui.haptic(); [...toolRow.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.tool === tool))); },
        dataset: { tool: t.id },
      }, ui.h('span', { html: `<svg viewBox="0 0 24 24" width="22" height="22">${t.icon}</svg>` }).firstChild,
         ui.h('span', { text: t.label }));
      toolRow.appendChild(b);
    });

    const colorRow = ui.h('div', { class: 'colorrow' },
      ...COLORS.map((c) => ui.h('button', {
        class: 'swatch', style: { background: c }, 'aria-pressed': String(c === color),
        onclick: (e) => {
          color = c; ui.haptic();
          [...colorRow.children].forEach((s) => s.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
        },
      })));

    const widthRow = ui.h('div', { class: 'colorrow' },
      ...[0.004, 0.006, 0.01].map((w, i) => ui.h('button', {
        class: 'swatch', style: { background: 'transparent', display: 'grid', placeItems: 'center' },
        'aria-pressed': String(w === width),
        onclick: (e) => {
          width = w;
          [...widthRow.children].forEach((s) => s.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
        },
      }, ui.h('span', { style: { width: (5 + i * 5) + 'px', height: (5 + i * 5) + 'px', borderRadius: '50%', background: '#fff' } }))));

    const tools = ui.h('div', { class: 'e-tools' },
      ui.h('div', { class: 'toolrow' }, undoBtn, clearBtn),
      toolRow, colorRow, widthRow);

    root.append(top, stage, tools);
    document.body.appendChild(root);
    ui.lockScroll();

    let bmp = null;
    let cw = 0, ch = 0;

    (async function init() {
      bmp = await decode(blob);
      layout();
      window.addEventListener('resize', layout);
    })();

    function layout() {
      if (!bmp) return;
      const rect = stage.getBoundingClientRect();
      const ratio = bmp.width / bmp.height;
      let w = rect.width, hgt = rect.width / ratio;
      if (hgt > rect.height) { hgt = rect.height; w = rect.height * ratio; }
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      cw = Math.round(w); ch = Math.round(hgt);
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      render();
    }

    function render() {
      if (!bmp) return;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const live = drawing ? [...work, drawing] : work;
      drawOps(ctx, live, canvas.width, canvas.height);
    }

    const pt = (e) => {
      const r = canvas.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      ];
    };

    canvas.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = pt(e);
      if (tool === 'text') {
        const text = await ui.prompt('Add Text', 'Shown on the photo.', '', { okLabel: 'Add' });
        if (text && text.trim()) { work.push({ type: 'text', color, size: 0.045, points: [p], text: text.trim() }); render(); }
        return;
      }
      if (tool === 'dot') { work.push({ type: 'dot', color, width, points: [p] }); ui.haptic(); render(); return; }
      drawing = { type: tool, color, width, points: [p, p] };
      if (tool === 'free') drawing.points = [p];
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pt(e);
      if (drawing.type === 'free') drawing.points.push(p);
      else drawing.points[1] = p;
      render();
    });

    const finish = () => {
      if (!drawing) return;
      const d = drawing; drawing = null;
      const [a, b] = [d.points[0], d.points[d.points.length - 1]];
      const moved = Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.015 || d.points.length > 3;
      if (moved) { work.push(d); redo.length = 0; ui.haptic(); }
      render();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('pointerleave', finish);

    async function save() {
      const btn = top.querySelector('.done');
      btn.textContent = 'Saving…'; btn.disabled = true;
      try {
        const flat = work.length ? await flatten(blob, work) : null;
        await onSave?.(work, flat);
      } catch (err) {
        console.error(err);
        ui.toast('Could not save annotation');
      }
      close(true);
    }

    function close(saved) {
      window.removeEventListener('resize', layout);
      if (bmp && bmp.close) bmp.close();
      root.remove();
      ui.unlockScroll();
      resolve(saved);
    }
  });
}
