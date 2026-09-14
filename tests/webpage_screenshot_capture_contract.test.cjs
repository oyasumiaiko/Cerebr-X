const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('webpage screenshot rejects hidden host tabs before waiting for animation frames', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../src/extension/content.js'),
    'utf8'
  );
  const functionStart = source.indexOf('function captureVisibleTabWhileSidebarHidden');
  assert.notEqual(functionStart, -1);
  const bodyStart = source.indexOf('{', functionStart);
  const sidebarSetup = source.indexOf('const visibleSidebars', bodyStart);
  const hiddenTabGuard = source.indexOf("document.visibilityState !== 'visible'", bodyStart);
  const failureCode = source.indexOf("error.code = 'TAB_NOT_VISIBLE'", bodyStart);

  assert.ok(hiddenTabGuard > bodyStart && hiddenTabGuard < sidebarSetup);
  assert.ok(failureCode > hiddenTabGuard && failureCode < sidebarSetup);
  assert.match(source, /const SCREENSHOT_CAPTURE_TIMEOUT_MS = 5000;/);
  assert.match(source, /error\.code = 'CAPTURE_TIMEOUT'/);
  assert.match(source, /restoreSidebarVisibility\(\);[\s\S]*rejectCapture\(error\);/);
});
