// history-filter.js - batch 9: History search, filters and stats (pure, no DOM).
// Search: every word must appear somewhere in the entry - its prompt, model
// name, type, or its tags (genre, mood, palette, colours, setting, lighting,
// medium), so "neon blue" finds a picture tagged neon-lit + blue.
// Filters: type (picture / video / 3D / audio), model, date range, tags.

export const TYPES = [
  { key: 'image', label: 'Pictures' }, { key: 'video', label: 'Video' },
  { key: '3d', label: '3D' }, { key: 'audio', label: 'Audio' },
];
export const DATES = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' }, { key: 'month', label: 'This month' },
];
export const TAG_GROUPS = ['genre', 'mood', 'palette', 'colors', 'setting', 'lighting', 'medium'];

/** image | video | 3d | audio | file for a History entry. */
export function entryType(e) {
  if (e.images?.length) return 'image';
  const f = e.files?.[0];
  if (!f) return 'file';
  if (f.kind) return f.kind;
  const n = String(f.filename || '').toLowerCase();
  if (/\.(glb|gltf|obj|ply|stl)$/.test(n)) return '3d';
  if (/\.(mp4|webm|mov|mkv|gif)$/.test(n)) return 'video';
  if (/\.(wav|mp3|flac|ogg|m4a|opus)$/.test(n)) return 'audio';
  return 'file';
}

/** Every tag of an entry, flat. */
export const entryTags = (e) => (e.tags ? TAG_GROUPS.flatMap((g) => e.tags[g] || []) : []);

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** [from, to) in ms for a date filter ({ key } or { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }). */
export function dateRange(f, now = new Date()) {
  if (!f) return null;
  const today = dayStart(now), DAY = 864e5;
  if (f.key === 'today') return [today, Infinity];
  if (f.key === 'yesterday') return [today - DAY, today];
  if (f.key === 'week') return [today - 6 * DAY, Infinity];
  if (f.key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Infinity];
  const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
  const from = parse(f.from), to = parse(f.to);
  if (from === null && to === null) return null;
  return [from ?? -Infinity, to === null ? Infinity : to + DAY];
}

/** Search words of an entry (lower case). labelOf(workflowId) -> the model's name. */
export function haystack(e, labelOf = () => '') {
  const type = entryType(e);
  return [e.prompt, e.negative, labelOf(e.workflow), e.workflow, TYPES.find((t) => t.key === type)?.label, type, ...entryTags(e)].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Does an entry pass?  f = { q, types: Set, models: Set, date, tags: Set }
 * (empty sets / missing = no filter).
 */
export function matches(e, f = {}, { labelOf, now } = {}) {
  if (f.types?.size && !f.types.has(entryType(e))) return false;
  if (f.models?.size && !f.models.has(e.workflow)) return false;
  const r = dateRange(f.date, now);
  if (r && !(e.createdAt >= r[0] && e.createdAt < r[1])) return false;
  if (f.tags?.size) { const t = new Set(entryTags(e)); for (const x of f.tags) if (!t.has(x)) return false; }
  const words = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) { const hay = haystack(e, labelOf); if (!words.every((w) => hay.includes(w))) return false; }
  return true;
}

export const isFiltering = (f = {}) => !!(String(f.q || '').trim() || f.types?.size || f.models?.size || f.date || f.tags?.size);

/** Counts for the stats strip: total, by type, today, this month, top models, top tags. */
export function statsOf(entries, { now = new Date(), labelOf = (id) => id } = {}) {
  const today = dayStart(now), month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const byType = {}, models = new Map(), tags = new Map();
  let todayN = 0, monthN = 0;
  for (const e of entries) {
    const t = entryType(e); byType[t] = (byType[t] || 0) + 1;
    if (e.createdAt >= today) todayN++;
    if (e.createdAt >= month) monthN++;
    if (e.workflow) { const k = e.workflow; models.set(k, (models.get(k) || 0) + 1); }
    for (const g of new Set(entryTags(e))) tags.set(g, (tags.get(g) || 0) + 1); // a tag in two groups counts once
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
  return {
    total: entries.length, byType, today: todayN, month: monthN,
    models: top(models, 5).map(([id, n]) => ({ id, label: labelOf(id) || id, n })),
    allModels: top(models, 99).map(([id, n]) => ({ id, label: labelOf(id) || id, n })),
    tags: top(tags, 200).map(([tag, n]) => ({ tag, n })),
  };
}

/** "3:04 PM" */
export const timeLabel = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
