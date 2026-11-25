// Batch 13: GPU busy check ignores ComfyUI's own window and an idle card, the
// batch sheet redesign (toggle, clock, Edit, drag), the bottom bar, the + only
// when the preset takes a file, project clipboard icon, no Folders, History is
// called Files, the nodes icon, no color tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { HistoryStore } from '../../server/history.js';
import { createScheduler } from '../../server/scheduler.js';
import { parseUtilState, parsePmon, readGpuBusy } from '../../server/hardware.js';
import { TAG_GROUPS } from '../../server/tagger.js';
import { rowsOf, reorderIds, clockLabel, nextClockTime } from '../../app/js/ui/batch-sheet.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PMON = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0      34848   C+G     32     19      -      -      -      -    Comfy Desktop.e
    0      57200     C      4      2      -      -      -      -    python.exe
    0      67912   C+G      -      -      -      -      -      -    Grok Bot.exe
`;

test('GPU busy: an idle card (P8) is free; ComfyUI\'s own window and Python never count; a game does', async () => {
  assert.deepEqual(parseUtilState('32 %, P8'), { util: 32, pstate: 8 });
  assert.deepEqual(parseUtilState('97, P2'), { util: 97, pstate: 2 });
  assert.equal(parseUtilState('garbage'), null);
  assert.deepEqual(parsePmon(PMON).map((r) => [r.name, r.sm]), [['Comfy Desktop.e', 32], ['python.exe', 4]], 'names with spaces; "-" rows skipped');
  let pmonCalls = 0;
  const pmon = async () => { pmonCalls++; return PMON; };
  assert.equal(await readGpuBusy({ runState: async () => '32, P8', runPmon: pmon }), 0, 'low-power state = idle');
  assert.equal(pmonCalls, 0, 'no per-process sample needed when idle');
  assert.equal(await readGpuBusy({ runState: async () => '36, P2', runPmon: pmon }), 0, 'only ComfyUI is drawing');
  assert.equal(await readGpuBusy({ runState: async () => '95, P0', runPmon: async () => '    0 999 C+G 80 30 - - - - Game.exe\n' + PMON }), 80, 'a game counts');
  assert.equal(await readGpuBusy({ runState: async () => '70, P2', runPmon: async () => '# nothing\n' }), 70, 'no sample -> the card total');
  assert.equal(await readGpuBusy({ runState: async () => { throw new Error('no nvidia-smi'); } }), null);
  const idx = read('server/index.js');
  assert.match(idx, /gpuUtil: opts\.gpuUtil \|\| \(\(\) => readGpuBusy\(\)\)[\s\S]*gpuUtil: opts\.gpuUtil \|\| \(\(\) => readGpuBusy\(\)\)/, 'tagger and scheduler both use it');
});

function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-b13-'));
  // a ComfyUI that is free and takes every job
  const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/queue') ? { queue_running: [], queue_pending: [] } : String(url).endsWith('/prompt') ? { prompt_id: 'p1' } : {}) });
  const s = createScheduler({ dataDir, history: new HistoryStore(dataDir), getComfyUrl: () => 'http://comfy', gpuUtil: async () => 0, fetchImpl });
  const job = (label, group) => ({ graph: { 1: { class_type: 'X', inputs: {} } }, meta: { workflow: 'ai:z', prompt: label }, label, group });
  return { s, job };
}

test('scheduler: Edit replaces a row\'s waiting jobs in the same place; a started job is refused', async () => {
  const { s, job } = rig();
  s.add([job('a', 'g1')]); s.add([job('b1', 'g2'), job('b2', 'g2')]); s.add([job('c', 'g3')]);
  const ids = s.view().jobs.filter((j) => j.group === 'g2').map((j) => j.id);
  const v = s.replace(ids, [job('B', 'g9'), job('B', 'g9'), job('B', 'g9')]);
  assert.deepEqual(v.jobs.map((j) => j.label), ['a', 'B', 'B', 'B', 'c'], 'same spot, new count');
  assert.throws(() => s.replace(['nope'], [job('x')]), /Not found/);
  assert.throws(() => s.replace(ids, [job('x')]), /Not found/, 'the old ids are gone');
  s.start(null); await s.tick();
  const first = s.view().jobs[0];
  assert.equal(first.status, 'running');
  assert.throws(() => s.replace([first.id], [job('x')]), /already started/);
});

test('batch sheet helpers: rows per save, drag order, clock label', () => {
  const J = (id, group, status = 'waiting') => ({ id, group, status });
  const rows = rowsOf([J('1', 'a', 'done'), J('2', 'b'), J('3', 'b'), J('4', 'c'), J('5', 'd')]);
  assert.deepEqual(rows.map((r) => r.jobs.length), [1, 2, 1, 1]);
  const waiting = rows.filter((r) => r.status === 'waiting');
  assert.deepEqual(reorderIds(waiting, 2, 0), ['5', '2', '3', '4'], 'last row dragged to the top');
  assert.deepEqual(reorderIds(waiting, 0, 1), ['4', '2', '3', '5'], 'a row with 2 jobs moves as one');
  assert.equal(clockLabel('23:30'), '11:30 PM'); assert.equal(clockLabel('00:05'), '12:05 AM'); assert.equal(clockLabel('12:00'), '12:00 PM');
  assert.equal(nextClockTime('23:30', new Date(2026, 10, 24, 22, 0)), new Date(2026, 10, 24, 23, 30).getTime());
  const bs = read('app/js/ui/batch-sheet.js');
  assert.match(bs, /'Start now' : `Start at \$\{label\}`/, 'the blue button follows the toggle');
  assert.match(bs, /label: 'Edit'[\s\S]*label: 'Remove', danger: true/, '⋮ = Edit + Remove only');
  assert.doesNotMatch(bs, /Move up|Move down|i-chevron-up/, 'no move buttons: long-press and drag');
  assert.match(bs, /setTimeout\(\(\) => this\.#lift\(/, 'long-press lifts the row');
  assert.doesNotMatch(bs, /In 1 hour|Tomorrow 7/, 'no quick-pick times');
  assert.match(bs, /scroll-snap|bs-wheel/);
});

test('Edit a batch job: form loads the job, Cancel / Update replace Run + the batch group', () => {
  const main = read('app/js/main.js'), html = read('app/index.html'), css = read('app/styles.css');
  assert.match(main, /onEdit: \(row\) => startEdit\(row\)/);
  assert.match(main, /await batchSheet\.replace\(editing\.ids, jobs\)/);
  assert.match(main, /saved as a new job/, 'started meanwhile -> kept as a new job');
  assert.match(html, /id="edit-bar" class="edit-bar" hidden/);
  assert.match(html, /id="btn-edit-cancel"[\s\S]*id="btn-edit-update"/);
  assert.match(css, /\.actionbar\.editing \.run, \.actionbar\.editing \.batch-grp \{ display: none; \}/);
  assert.match(read('server/index.js'), /\/api\/schedule\/replace/);
});

test('bottom bar: Run, then one group [ + | stack count ]; count always shown', () => {
  const html = read('app/index.html');
  assert.match(html, /id="btn-generate"[\s\S]*<span class="batch-grp">\s*<button id="btn-batch-add"[^>]*><i class="i i-plus"><\/i><\/button>\s*<button id="btn-batch"[^>]*><i class="i i-layers"><\/i><span id="batch-count" class="batch-count">0<\/span>/);
  assert.doesNotMatch(html, /Save to batch<\/span>|i-list"/);
  assert.match(read('app/js/ui/batch-sheet.js'), /this\.badge\.textContent = String\(n\);/);
});

test('+ in the prompt box only when the preset takes a picture, video or audio; the sheet lists only those', () => {
  const main = read('app/js/main.js'), sheet = read('app/js/ui/import-sheet.js');
  assert.match(main, /importSheet\.setKinds\(kinds\);\n\s*\$\('#btn-attach'\)\.hidden = !kinds\.size;/);
  assert.match(sheet, /img \? row\('photo'/); assert.match(sheet, /aud \? row\('record'/); assert.match(sheet, /vid \? row\('video'/);
  assert.match(read('app/styles.css'), /\.attach-btn\[hidden\] \{ display: none; \}/);
});

test('project box: clipboard icon, name not bold; Files: no Folders, renamed; Nodes icon; no color tags', () => {
  // batch 17: the clipboard for a project, the empty circle for No project
  assert.match(read('app/js/ui/projects.js'), /this\.icon\.className = `i \$\{p \? 'i-clipboard-list' : 'i-circle'\}`/);
  assert.match(read('app/styles.css'), /\.project-chip \.name \{ font-weight: 400; \}/);
  const hv = read('app/js/ui/history-view.js');
  assert.doesNotMatch(hv, /foldersBtn|FoldersScreen|openAddTo|getFolders/);
  assert.match(hv, /h\('h2', \{\}, 'Files'\)/);
  assert.match(hv, /this\.favOnly \? 'Favorites' : 'Files'/);
  const html = read('app/index.html');
  assert.match(html, /id="btn-history"[^>]*aria-label="Files" title="Files"/);
  assert.match(html, /id="btn-canvas"[^>]*><i class="i i-nodes"><\/i>/);
  const icons = read('app/icons.css');
  for (const n of ['clipboard-list', 'nodes', 'pencil', 'square']) assert.match(icons, new RegExp(`\\.i-${n}\\{--svg:url`));
  assert.ok(!TAG_GROUPS.includes('colors'));
  assert.doesNotMatch(read('server/tagger.js'), /colors: 2-5/);
  assert.match(hv, /placeholder: 'Search prompts and tags'/);
});
