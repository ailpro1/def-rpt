// Ask-the-assistant sheet. Online only; the rest of the app never depends on it.
import * as ui from '../ui.js';
import { ask, aiReady } from '../assist.js';
import { listSections, listPhotos } from '../store.js';

const QUICK = [
  'Summarise the defects recorded so far',
  'Which items are most urgent to rectify?',
  'Suggest sections I may have missed',
  'Write a handover note to the contractor',
];

export async function buildContext(project) {
  const sections = await listSections(project.id);
  const lines = [];
  for (const s of sections) {
    const photos = await listPhotos(s.id);
    const caps = photos.map((p) => p.caption).filter(Boolean);
    if (!caps.length) continue;
    // Repeats are collapsed to "CAPTION x7" — a 40-photo room costs a few tokens
    // instead of forty, and the model reads the pattern more clearly.
    const counts = new Map();
    caps.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
    const tallied = [...counts.entries()]
      .map(([c, n]) => (n > 1 ? `${c.replace(/\n/g, ' / ')} x${n}` : c.replace(/\n/g, ' / ')))
      .join('; ');
    lines.push(`${s.title}: ${tallied}`);
  }
  return `Property: ${project.name}\nAddress: ${project.address}\nDate: ${project.inspectionDate}\n`
    + `Locations with items: ${lines.length}\n\n${lines.join('\n')}`;
}

export async function openAssistant(project) {
  const ready = await aiReady();
  const log = ui.h('div', { style: { padding: '4px 14px 10px' } });
  const input = ui.h('textarea', {
    class: 'cap-input', placeholder: 'Ask about this inspection…',
    style: { minHeight: '64px', borderTop: '.5px solid var(--sep)' },
  });

  const bubble = (who, text) => ui.h('div', {
    style: {
      background: who === 'you' ? 'var(--sys-blue)' : 'var(--bg-group)',
      color: who === 'you' ? '#fff' : 'var(--label)',
      alignSelf: who === 'you' ? 'flex-end' : 'flex-start',
      padding: '10px 13px', borderRadius: '16px', margin: '6px 0',
      maxWidth: '86%', whiteSpace: 'pre-wrap', fontSize: '15px', lineHeight: '1.4',
      marginLeft: who === 'you' ? 'auto' : '0',
    }, text,
  });

  async function send(text) {
    if (!text.trim()) return;
    log.appendChild(bubble('you', text.trim()));
    input.value = '';
    const thinking = bubble('ai', 'Thinking…');
    log.appendChild(thinking);
    log.scrollIntoView({ block: 'end' });
    try {
      const ctx = await buildContext(project);
      const answer = await ask(text.trim(), ctx);
      thinking.textContent = answer || 'No answer returned.';
    } catch (err) {
      thinking.textContent = err.message || 'The assistant is unavailable.';
    }
  }

  const body = ui.h('div', {},
    ready ? null : ui.h('div', { class: 'hint', text: 'Turn the assistant on in Settings > AI Assistant and connect to the internet to use this.' }),
    ui.h('div', { class: 'chips scrollrow' },
      ...QUICK.map((q) => ui.h('button', { class: 'chip', text: q, onclick: () => send(q) }))),
    log,
    input,
    ui.h('div', { class: 'btn-stack' },
      ui.h('button', { class: 'btn wide', text: 'Send', onclick: () => send(input.value) })));

  ui.sheet({ title: 'Assistant', body, leftLabel: 'Close', height: '86vh' });
}
