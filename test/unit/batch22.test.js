// Batch 22: the app as a "Concept" tab in ComfyUI's left sidebar (the ComfyUI add-on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the ComfyUI add-on registers a Concept sidebar tab that frames the app with ?in=comfy', () => {
  const js = read('comfyui/ComfyUI-AIWorkflowMenu/web/concept_sidebar.js');
  assert.match(js, /import \{ app \} from "\.\.\/\.\.\/scripts\/app\.js"/);
  assert.match(js, /registerSidebarTab\(\{[\s\S]*id: "concept-app"[\s\S]*title: "Concept"[\s\S]*type: "custom"/);
  assert.match(js, /const APP_URL = "http:\/\/127\.0\.0\.1:3100\/\?in=comfy"/);
  assert.doesNotMatch(js, /localStorage|api\/settings|fetch\(/, 'saves nothing in ComfyUI');
});

test('the app hides its node-view button inside ComfyUI (remembered across the frame\'s reloads)', () => {
  const main = read('app/js/main.js');
  assert.match(main, /get\('in'\) === 'comfy'\) sessionStorage\.setItem\('inComfy', '1'\)/);
  assert.match(main, /classList\.toggle\('in-comfy', inComfy\)/);
  assert.match(read('app/styles.css'), /\.in-comfy #btn-canvas \{ display: none; \}/);
});
