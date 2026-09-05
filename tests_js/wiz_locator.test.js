const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'wandao_electron', 'renderer', 'app.js'), 'utf8');
const wizSource = fs.readFileSync(path.join(root, 'plugins', 'wiz', 'backend', 'export_wiz.py'), 'utf8');

test('Wiz failure details expose an ID-verified in-app locator, not an editor URL', () => {
  assert.match(appSource, /data-history-action="locate-wiz-note"/);
  assert.match(appSource, /--locate-doc/);
  assert.match(appSource, /pageLink\.url === 'https:\/\/www\.wiz\.cn\/xapp'/);
  assert.match(wizSource, /def locate_wiz_document/);
  assert.match(wizSource, /focusDocument/);
  assert.doesNotMatch(wizSource, /documentUrl"\s*:\s*f"\{self\.kb_server\}\/editor/);
});
