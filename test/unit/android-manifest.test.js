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
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
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
  const svc = /<service\b([^>]*)\/?>/.exec(xml)?.[1] || '';
  assert.match(svc, /android:name="[.\w]*RunService"/, `${label}: RunService declared`);
  assert.match(svc, /android:foregroundServiceType="dataSync"/, `${label}: foreground service type matches FOREGROUND_SERVICE_DATA_SYNC`);
  assert.match(svc, /android:exported="false"/, `${label}: RunService is not exported`);
}

test('source AndroidManifest: only INTERNET, storage (<= API 28), FOREGROUND_SERVICE + DATA_SYNC, POST_NOTIFICATIONS, VIBRATE', () => {
  check(fs.readFileSync(SRC, 'utf8'), 'source');
});

test('merged release manifest (if built): same permission set as the source', (t) => {
  const f = MERGED.find((p) => fs.existsSync(p));
  if (!f) return t.skip('no release build in this tree');
  check(fs.readFileSync(f, 'utf8'), 'release');
});

test('RunService: "Running N of M" notification, dataSync start, vibration on finish; bridge exposes runStatus', () => {
  const j = (f) => fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/app/jesse/comfyconcept', f), 'utf8');
  const svc = j('RunService.java'), bridge = j('NativeBridge.java'), act = j('MainActivity.java');
  assert.match(svc, /FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
  assert.match(svc, /R\.string\.run_running/);
  assert.match(svc, /vibrate\(\)/);
  assert.match(bridge, /@JavascriptInterface\s+public void runStatus\(/);
  assert.match(bridge, /if \(!allowed\) return;\s+activity\.runOnUiThread\(new Runnable\(\) \{\s+@Override\s+public void run\(\) \{\s+activity\.setRunStatus/);
  assert.match(act, /POST_NOTIFICATIONS/);
  const strings = fs.readFileSync(path.join(ROOT, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  assert.match(strings, /name="run_running">Running %1\$d of %2\$d</);
});
