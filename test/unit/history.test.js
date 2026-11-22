// History persistence (data/history.json): add, update, sessions, atomic file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../../server/history.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hist-'));

test('add -> persists to disk -> reload sees it; favorite update persists', async () => {
  const dir = tmp();
  const h = new HistoryStore(dir);
  const e = await h.add({ prompt: 'fox', seed: 1, workflow: 'basic-txt2img', width: 1024, height: 1024, images: [{ filename: 'a.png', subfolder: 'concept-app', type: 'output', junk: 1 }] });
  assert.equal(e.status, 'done');
  assert.deepEqual(e.images, [{ filename: 'a.png', subfolder: 'concept-app', type: 'output' }]);
  await h.update(e.id, { favorite: true });
  const again = new HistoryStore(dir);
  const all = again.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].entries[0].prompt, 'fox');
  assert.equal(all[0].entries[0].favorite, true);
  assert.deepEqual(fs.readdirSync(dir), ['history.json'], 'no .tmp left behind');
});

test('sessions split on time gap; newest first; favorites filter', async () => {
  const h = new HistoryStore(tmp(), { sessionGapMinutes: 60 });
  const t0 = Date.UTC(2026, 0, 1, 10);
  const a = await h.add({ prompt: 'a', createdAt: t0 });
  const b = await h.add({ prompt: 'b', createdAt: t0 + 30 * 60e3 });
  const c = await h.add({ prompt: 'c', createdAt: t0 + 3 * 3600e3, favorite: true });
  assert.equal(a.sessionId, b.sessionId);
  assert.notEqual(b.sessionId, c.sessionId);
  const list = h.list();
  assert.deepEqual(list.map((s) => s.entries.map((e) => e.prompt)), [['c'], ['b', 'a']]);
  assert.deepEqual(h.list({ favoritesOnly: true }).map((s) => s.entries.length), [1]);
});

test('pending entries (promptId, no images) are reported; many concurrent writes stay valid JSON', async () => {
  const dir = tmp();
  const h = new HistoryStore(dir);
  await Promise.all(Array.from({ length: 30 }, (_, i) => h.add({ prompt: 'p' + i, promptId: 'pid' + i })));
  assert.equal(h.pending().length, 30);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
  assert.equal(data.entries.length, 30);
  assert.equal(await h.update('nope', { favorite: true }), null);
});

test('corrupt history.json is moved aside, not overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), '{not json');
  const h = new HistoryStore(dir);
  assert.equal(h.list().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('history.json.corrupt-')));
});
