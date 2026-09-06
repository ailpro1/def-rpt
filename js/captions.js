// Default caption + section library. Everything here is user-editable in
// Settings > Library; these are only the seeds for a fresh install.

export const DEFAULT_SECTIONS = [
  'CAR PORCH', 'EXTERNAL FRONT', 'EXTERNAL REAR', 'LIVING', 'DINING',
  'KITCHEN', 'YARD', 'STAIRCASE | HALL', 'BATH 1', 'BATH 2', 'BATH 3',
  'BEDROOM 1', 'BEDROOM 2', 'BEDROOM 3', 'MASTER BEDROOM', 'BALCONY',
  'ROOF | CEILING SPACE', 'ELECTRICAL DB', 'GENERAL',
];

// Caption groups drive the quick-pick chips on the capture screen.
export const DEFAULT_CAPTIONS = [
  { group: 'Tiling', items: [
    'UNFILLED GROUT', 'HOLLOW TILE', 'ORANGE STICKER - HOLLOW TILE',
    'ORANGE STICKER - HOLLOW TILES', 'CRACKED TILE', 'CHIPPED TILE',
    'UNEVEN TILE LEVEL', 'STAINED TILE', 'MISALIGNED TILE JOINT',
  ]},
  { group: 'Wall & Ceiling', items: [
    'UNEVEN PLASTER (WAVY SURFACE)', 'CRACK OBSERVED ON WALL',
    'DEFECTIVE WALL\n1) GREEN STICKER: IDENTIFIED CRACKS', 'STAINED WALL',
    'PAINT PEELING', 'PATCHY PAINT FINISH', 'DAMP PATCH OBSERVED',
    'CEILING BOARD JOINT VISIBLE', 'ROUGH SKIM COAT',
  ]},
  { group: 'Door & Window', items: [
    'MISALIGNED DOOR', 'DAMAGED DOOR', 'POOR DOOR FINISH', 'RUSTED DOOR KNOB',
    'DOOR NOT CLOSING PROPERLY', 'IMPROPER JOINT AT FRAME',
    'FRAME CONTACTS WALL DURING OPERATION', 'GAP AT DOOR FRAME',
    'SEALANT MISSING AT FRAME', 'SCRATCHED GLASS PANEL', 'STIFF WINDOW OPERATION',
  ]},
  { group: 'Metalwork', items: [
    'RUSTED LATCH', 'RUSTED STRIKE HOLE', 'RUSTED GATE POST', 'RUSTED HINGE',
    'POOR WELD FINISH', 'PAINT DEFECT ON RAILING', 'LOOSE RAILING',
  ]},
  { group: 'Electrical', items: [
    'VOLTAGE - OK\nRCD TEST - OK', 'VOLTAGE - OK\nRCD TEST - NOT OK',
    'NO POWER AT SOCKET', 'SOCKET NOT LEVEL', 'LOOSE SWITCH PLATE',
    'LIGHT POINT NOT FUNCTIONING', 'EXPOSED CONDUIT', 'DB LABELLING INCOMPLETE',
  ]},
  { group: 'Plumbing', items: [
    'LEAK AT TRAP', 'LEAK AT TAP', 'SLOW DRAINAGE', 'NO WATER FLOW',
    'FLOOR TRAP NOT LEVEL', 'PONDING OBSERVED', 'SILICONE SEAL INCOMPLETE',
    'WC NOT SECURED', 'BASIN NOT LEVEL',
  ]},
  { group: 'General', items: [
    'POOR FINISHING', 'DEBRIS NOT CLEARED', 'SURFACE NOT CLEANED',
    'INCOMPLETE WORK', 'ITEM NOT INSTALLED', 'GENERAL VIEW', 'OVERVIEW',
    'RECTIFICATION REQUIRED', 'ACCEPTABLE - NO DEFECT OBSERVED',
  ]},
];

// Reference photos (front view etc.) that carry the address as a second line.
export const CAPTION_SUFFIX_TOKENS = {
  '{address}': (p) => p.address || '',
  '{project}': (p) => p.name || '',
  '{date}': () => new Date().toLocaleDateString('en-GB'),
};

export function flatCaptions(lib) {
  return (lib || DEFAULT_CAPTIONS).flatMap((g) => g.items.map((t) => ({ group: g.group, text: t })));
}

// Very small offline ranker: recency + frequency + section affinity.
// Keeps the "fast" promise working with no network.
export function rankCaptions(lib, usage, sectionTitle, limit = 14) {
  const flat = flatCaptions(lib);
  const sec = (sectionTitle || '').toUpperCase();
  const scored = flat.map((c) => {
    const u = usage[c.text] || { n: 0, last: 0, sections: {} };
    let score = u.n * 2 + (u.sections[sec] || 0) * 6;
    if (u.last) score += Math.max(0, 6 - (Date.now() - u.last) / 36e5);
    score += affinity(sec, c);
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function affinity(sec, c) {
  const g = c.group;
  const map = {
    'BATH': ['Plumbing', 'Tiling', 'Door & Window'],
    'KITCHEN': ['Plumbing', 'Tiling', 'Electrical'],
    'YARD': ['Plumbing', 'Metalwork'],
    'CAR PORCH': ['Metalwork', 'General'],
    'EXTERNAL': ['Wall & Ceiling', 'Metalwork'],
    'STAIR': ['Tiling', 'Wall & Ceiling'],
    'BEDROOM': ['Wall & Ceiling', 'Door & Window', 'Electrical'],
    'LIVING': ['Tiling', 'Electrical', 'Door & Window'],
    'DINING': ['Tiling', 'Electrical'],
    'DB': ['Electrical'],
  };
  for (const k of Object.keys(map)) {
    if (sec.includes(k) && map[k].includes(g)) return 4;
  }
  return 0;
}
