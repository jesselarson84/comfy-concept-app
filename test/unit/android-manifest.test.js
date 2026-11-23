// Android manifest permissions (batch 3): exactly the permissions the app needs,
// checked on the source manifest and, when a build has produced it, on the
// merged release manifest too (what actually ships in the APK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const SRC = path.join(ROOT, 'android/app/src/main/AndroidManifest.xml');
const MERGED = [
  'android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml',
].map((p) => path.join(ROOT, p));

export const ALLOWED = [
  'android.permission.INTERNET',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.VIBRATE',
  // batch 7: recording a voice line (granted to the server's page only, MainActivity.onPermissionRequest)
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

export function permissions(xml) {
  return [...xml.matchAll(/<uses-permission\b([^>]*)>/g)].map((m) => ({
    name: /android:name="([^"]+)"/.exec(m[1])?.[1], maxSdk: /android:maxSdkVersion="(\d+)"/.exec(m[1])?.[1],
  }));
}

function check(xml, label) {
  const perms = permissions(xml);
  assert.deepEqual(perms.map((p) => p.name).sort(), [...ALLOWED].sort(), `${label}: permission set`);
  assert.equal(perms.find((p) => p.name === 'android.permission.WRITE_EXTERNAL_STORAGE').maxSdk, '28', `${label}: storage only up to Android 9`);
  assert.doesNotMatch(xml, /android\.permission\.CAMERA/, `${label}: no CAMERA (the camera button hands off to the system camera)`);
  // batch 8: no RunService, no run notification
  assert.doesNotMatch(xml, /RunService|POST_NOTIFICATIONS|FOREGROUND_SERVICE/, `${label}: no run notification service`);
}

test('source AndroidManifest: only INTERNET, storage (<= API 28), VIBRATE, RECORD_AUDIO + MODIFY_AUDIO_SETTINGS', () => {
  check(fs.readFileSync(SRC, 'utf8'), 'source');
});

test('merged release manifest (if built): same permission set as the source', (t) => {
  const f = MERGED.find((p) => fs.existsSync(p));
  if (!f) return t.skip('no release build in this tree');
  check(fs.readFileSync(f, 'utf8'), 'release');
});

test('batch 8: no run notification; the bridge still reports runs (vibrate on finish); the file picker is OPEN_DOCUMENT (shows Google Drive)', () => {
  const j = (f) => fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/app/jesse/comfyconcept', f), 'utf8');
  assert.equal(fs.existsSync(path.join(ROOT, 'android/app/src/main/java/app/jesse/comfyconcept/RunService.java')), false);
  const bridge = j('NativeBridge.java'), act = j('MainActivity.java');
  assert.match(bridge, /@JavascriptInterface\s+public void runStatus\(/);
  assert.match(bridge, /if \(!allowed\) return;\s+activity\.runOnUiThread\(new Runnable\(\) \{\s+@Override\s+public void run\(\) \{\s+activity\.setRunStatus/);
  assert.doesNotMatch(act, /POST_NOTIFICATIONS|RunService|askForNotifications/);
  assert.match(act, /if \(total > 0\) vibrate\(\);/);
  assert.match(act, /new Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/);
  assert.doesNotMatch(act, /ACTION_GET_CONTENT/);
  const strings = fs.readFileSync(path.join(ROOT, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  assert.doesNotMatch(strings, /run_running/);
});
