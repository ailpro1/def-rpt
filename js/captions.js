// Default caption + section library. Everything here is user-editable in
// Settings > Library; these are only the seeds for a fresh install.

// Building elements, as the second report format's COMPONENT column uses them.
export const DEFAULT_COMPONENTS = [
  'WALL FINISHES', 'FLOOR FINISHES', 'CEILING FINISHES', 'TABLE TOP FINISHES',
  'DOOR & FRAME ASSEMBLY', 'WINDOW ASSEMBLY', 'STEEL GATE', 'IRON WORK',
  'METAL WORK - RAILING', 'ROOF COVERING SYSTEM', 'SANITARY SYSTEM',
  'WATER SUPPLY SYSTEM', 'DRAINAGE SYSTEM', 'ELECTRICAL INSTALLATION',
  'SOCKET OUTLET / RCD PROTECTION', 'IRONMONGERY', 'GENERAL',
];

export const DEFAULT_SECTIONS = [
  'CAR PORCH', 'EXTERNAL FRONT', 'EXTERNAL REAR', 'LIVING', 'DINING',
  'KITCHEN', 'YARD', 'STAIRCASE | HALL', 'BATH 1', 'BATH 2', 'BATH 3',
  'BEDROOM 1', 'BEDROOM 2', 'BEDROOM 3', 'MASTER BEDROOM', 'BALCONY',
  'ROOF | CEILING SPACE', 'ELECTRICAL DB', 'GENERAL',
];

// Bump when the seed lists below change so existing installs pick up the
// additions without losing their own edits (see mergeSeedLibraries in store.js).
export const LIB_SEED_VERSION = 2;

// Caption groups drive the quick-pick chips on the capture screen.
export const DEFAULT_CAPTIONS = [
  { group: 'Tiling', items: [
    'UNFILLED GROUT', 'HOLLOW TILE', 'ORANGE STICKER - HOLLOW TILE',
    'ORANGE STICKER - HOLLOW TILES', 'CRACKED TILE', 'CHIPPED TILE',
    'UNEVEN TILE LEVEL', 'STAINED TILE', 'MISALIGNED TILE JOINT',
    'TILE LIPPAGE',
    'OVERALL TILE LIPPAGE RESULTING IN SHARP EDGES ON FLOOR TILES',
    'POOR FINISHING AT GROUTING', 'YELLOWISH DISCOLOURATION AT GROUTING',
    'VARIATION IN GROUTING TONE OBSERVED',
  ]},
  { group: 'Wall & Ceiling', items: [
    'UNEVEN PLASTER (WAVY SURFACE)', 'UNEVEN PLASTER (ROUGH SURFACE)',
    'POOR RENDERING (ROUGH SURFACE)', 'CRACK OBSERVED ON WALL',
    'CRACK OBSERVED AT WALL JUNCTION',
    'SEPARATION CRACK BETWEEN WALL AND CEILING', 'MISALIGNED WALL',
    'DEFECTIVE WALL\n1) GREEN STICKER: IDENTIFIED CRACKS',
    'DEFECTIVE WALL\n1) PINK STICKER: DEFECTS IN PAINTING, PLASTERING, AND SURFACE FINISHES.'
      + '\n2) GREEN STICKER: IDENTIFIED CRACKS'
      + '\nREMARKS : UNEVEN PLASTER (WAVY SURFACE), POOR PAINT FINISH',
    'DEFECTIVE WALL\n1) CRACKS OBSERVED ON WALL\n2) POOR PAINT FINISH'
      + '\n3) UNEVEN PLASTER (ROUGH SURFACE)',
    'STAINED WALL', 'PAINT PEELING', 'PEELING OFF PAINT', 'PATCHY PAINT FINISH',
    'POOR PAINT FINISH ON WALL\n(DISCOLOURATION OBSERVED ON WALL)',
    'POOR PAINT FINISH ON WALL/FRAME\n(YELLOWISH DISCOLORATION OBSERVED AT WALL CORNER)',
    'POOR FINISHING ALONG WALL EDGE', 'DAMP PATCH OBSERVED',
    'SIGNS OF WATER SEEPAGE ON CEILING',
    'CEILING BOARD JOINT VISIBLE', 'ROUGH SKIM COAT',
  ]},
  { group: 'Door & Window', items: [
    'MISALIGNED DOOR', 'DAMAGED DOOR', 'POOR DOOR FINISH', 'RUSTED DOOR KNOB',
    'DOOR NOT CLOSING PROPERLY', 'DOOR DIFFICULT TO CLOSE DUE TO MISALIGNMENT',
    'IMPROPER JOINT AT FRAME', 'IMPROPER JOINT AT FRAME/SOCKET OUTLET',
    'FRAME CONTACTS WALL DURING OPERATION', 'GAP AT DOOR FRAME',
    'SEALANT MISSING AT FRAME', 'IMPROPER SEAL RUBBER INSTALLATION',
    'SCRATCHED GLASS PANEL', 'STIFF WINDOW OPERATION',
    'WINDOW NOT OPERATING SMOOTHLY DURING OPENING',
    'SQUEAKY DOOR \u2013 DOOR PRODUCES NOISE WHEN OPENED OR CLOSED',
    'SQUEAKY WINDOW \u2013 WINDOW PRODUCES NOISE WHEN OPENED OR CLOSED',
    'KEY STICKING DURING INSERTION',
  ]},
  { group: 'Metalwork', items: [
    'RUSTED LATCH', 'RUSTED STRIKE HOLE', 'RUSTED GATE POST', 'RUSTED HINGE',
    'POOR WELD FINISH', 'PAINT DEFECT ON RAILING', 'LOOSE RAILING',
    'RUST - STAINED RAILING', 'FENCING LOOSE AND SAGGING',
    'DEFECTIVE GATE\n- RUSTED, STAINED, POOR PAINT FINISH',
  ]},
  { group: 'Roofing', items: [
    'LIGHT INGRESS THROUGH ROOF JOINTING', 'CHIPPED ROOF TILE',
  ]},
  { group: 'Electrical', items: [
    'VOLTAGE - OK\nRCD TEST - OK', 'VOLTAGE - OK\nRCD TEST - NOT OK',
    'NO POWER AT SOCKET', 'SOCKET NOT LEVEL', 'LOOSE SWITCH PLATE',
    'SUNKEN SWITCH BUTTON',
    'LIGHT POINT NOT FUNCTIONING', 'EXPOSED CONDUIT', 'DB LABELLING INCOMPLETE',
    'RCCB 30 mA INSTALLED INSTEAD OF THE SPECIFIED 100 mA RCCB FOR SINGLE-PHASE CIRCUIT',
    'CEILING FAN LOCATION PROVIDES INSUFFICIENT CLEARANCE FOR CERTAIN FAN MODELS',
  ]},
  { group: 'Plumbing', items: [
    'LEAK AT TRAP', 'LEAK AT TAP', 'SLOW DRAINAGE', 'NO WATER FLOW',
    'FLOOR TRAP NOT LEVEL', 'PONDING OBSERVED', 'SILICONE SEAL INCOMPLETE',
    'WC NOT SECURED', 'BASIN NOT LEVEL', 'UNFITTED MANHOLE COVER',
  ]},
  { group: 'General', items: [
    'POOR FINISHING', 'POOR HOUSEKEEPING', 'DEBRIS NOT CLEARED',
    'SURFACE NOT CLEANED',
    'INCOMPLETE WORK', 'ITEM NOT INSTALLED', 'GENERAL VIEW', 'OVERVIEW',
    'VIEW OF INSPECTION SECTION',
    'NON-SQUARE STAIR EDGES (NOT 90\u00b0), POTENTIAL SAFETY HAZARD',
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
    'EXTERNAL': ['Wall & Ceiling', 'Metalwork', 'Roofing'],
    'STAIR': ['Tiling', 'Wall & Ceiling'],
    'BEDROOM': ['Wall & Ceiling', 'Door & Window', 'Electrical'],
    'LIVING': ['Tiling', 'Electrical', 'Door & Window'],
    'DINING': ['Tiling', 'Electrical'],
    'ROOF': ['Roofing', 'Wall & Ceiling'],
    'CEILING': ['Roofing', 'Wall & Ceiling'],
    'DB': ['Electrical'],
  };
  for (const k of Object.keys(map)) {
    if (sec.includes(k) && map[k].includes(g)) return 4;
  }
  return 0;
}

/**
 * How well a typed query matches one piece of text, as a tier: an exact opening
 * beats a word prefix beats an abbreviation beats letters in order. 0 is no
 * match. Shared by the caption type-ahead and by section matching on import, so
 * "mb" reaching MASTER BEDROOM means the same thing in both places.
 */
export function matchTier(query, tokens, text) {
  const flat = String(text || '').toUpperCase().replace(/\n/g, ' ');
  const words = flat.split(/[^A-Z0-9]+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('');
  const q = String(query || '').toUpperCase();
  const parts = tokens || q.split(' ').filter(Boolean);

  if (flat === q) return 120;
  if (flat.startsWith(q)) return 100;
  if (words.some((w) => w.startsWith(q))) return 70;
  if (initials.startsWith(q.replace(/ /g, ''))) return 62;
  if (parts.length > 1 && parts.every((t) => words.some((w) => w.startsWith(t)))) return 55;
  if (flat.includes(q)) return 40;
  if (subsequence(q.replace(/ /g, ''), flat.replace(/ /g, ''))) return 14;
  return 0;
}

/**
 * Pick the section a free-typed name means, out of the ones on offer. Used when
 * a batch arrives from Telegram carrying whatever someone typed after /sec.
 * Returns null rather than guess when nothing is a convincing match — a wrong
 * section is worse than a new one.
 */
export function matchSection(name, candidates) {
  // "BATH1" and "BATH 1" are the same room to everyone except a string compare.
  const q = String(name || '').trim().toUpperCase()
    .replace(/([A-Z])(\d)/g, '$1 $2').replace(/\s+/g, ' ');
  if (!q) return null;
  const tokens = q.split(' ').filter(Boolean);
  let best = null;
  for (const c of candidates || []) {
    const tier = matchTier(q, tokens, c);
    // Letters-in-order is far too loose for a section: "KITCHEN" would find
    // "STAIRCASE | HALL". Nothing below a substring hit counts.
    if (tier >= 40 && (!best || tier > best.tier)) best = { title: c, tier };
  }
  return best;
}

/**
 * Type-ahead search over the caption library. Built for thumb-typing on site:
 * a word prefix, an abbreviation ("ug" finds UNFILLED GROUT) or loose letters
 * in order all match, and how often you use a caption breaks the ties.
 */
export function searchCaptions(lib, usage, sectionTitle, query, limit = 6) {
  const q = String(query || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const sec = (sectionTitle || '').toUpperCase();
  const tokens = q.split(' ').filter(Boolean);
  const out = [];

  flatCaptions(lib).forEach((c) => {
    const tier = matchTier(q, tokens, c.text);
    if (!tier) return;

    let score = tier;
    const u = usage[c.text] || { n: 0, last: 0, sections: {} };
    score += Math.min(12, u.n * 1.5) + (u.sections[sec] ? 6 : 0) + affinity(sec, c);
    if (u.last) score += Math.max(0, 4 - (Date.now() - u.last) / 36e5);
    out.push({ text: c.text, group: c.group, score, tier });
  });

  // Loose letter matches are a last resort: two letters find something in
  // almost any caption, so drop them the moment a real match exists.
  const best = out.reduce((m, c) => Math.max(m, c.tier), 0);
  const kept = best >= 40 ? out.filter((c) => c.tier >= 40) : out;

  kept.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return kept.slice(0, limit);
}

/** Do the letters of `q` appear in `text`, in order? */
function subsequence(q, text) {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length > 0 && i === q.length;
}
