'use strict';
/** Run after :app:assembleDebug :app:assembleDebugAndroidTest on a fresh emulator. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scenario = process.argv.includes('--scenario=denied') ? 'denied' : 'full';
const output = path.join(__dirname, '.artifacts', 'android-picker', scenario);
fs.mkdirSync(output, { recursive: true });
const adb = process.env.ADB_PATH || 'adb';
function run(args, timeout = 90000) {
  const result = spawnSync(adb, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'adb ' + args.join(' ') + '\n' + result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

const devices = run(['devices']);
assert.match(devices, /emulator-\d+\s+device/, 'Use a disposable Android emulator, never a personal phone');
const deviceLines = devices.split(/\r?\n/).filter(line => /\s+device$/.test(line));
assert.equal(deviceLines.length, 1, 'Exactly one emulator must be attached');
run(['install', '-r', '-g', path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')]);
run(['install', '-r', '-g', path.join(root, 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
if (scenario === 'denied') {
  run(['shell', 'pm', 'revoke', 'com.jianmiao.imagestudio', 'android.permission.READ_MEDIA_IMAGES']);
  run(['shell', 'pm', 'revoke', 'com.jianmiao.imagestudio', 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED']);
}
run(['shell', 'settings', 'put', 'global', 'window_animation_scale', '0']);
run(['shell', 'settings', 'put', 'global', 'transition_animation_scale', '0']);
run(['shell', 'settings', 'put', 'global', 'animator_duration_scale', '0']);
run(['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1']);
let log = '';
try {
  const result = spawnSync(adb, ['shell', 'am', 'instrument', '-w', '-e', 'scenario', scenario, 'com.jianmiao.imagestudio.test/com.jianmiao.imagestudio.test.PickerInstrumentation'], { encoding: 'utf8', windowsHide: true, timeout: 240000 });
  log = (result.stdout || '') + (result.stderr || '');
  console.log(log);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Android instrumentation process failed');
} finally {
  fs.writeFileSync(path.join(output, 'instrumentation.txt'), log);
  const pulled = spawnSync(adb, ['pull', '/sdcard/Android/data/com.jianmiao.imagestudio/files/instrumentation/' + scenario + '/.', output], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  console.log(pulled.stdout || pulled.stderr);
  const logcat = spawnSync(adb, ['logcat', '-d', '-t', '1000'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  fs.writeFileSync(path.join(output, 'logcat.txt'), (logcat.stdout || '') + (logcat.stderr || ''));
}
assert.match(log, /^PICKER_TEST_RESULT=OK\r?$/m, 'Native album picker instrumentation must pass');
assert.doesNotMatch(log, /PICKER_TEST_RESULT=FAIL|result=FAIL|INSTRUMENTATION_FAILED|Process crashed/);
console.log('Native gallery interaction, album filtering, selection and automatic mode checks passed. Artifacts: ' + output);
