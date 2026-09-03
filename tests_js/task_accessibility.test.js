const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
const indexHtml = fs.readFileSync('wandao_electron/renderer/index.html', 'utf8');
const styles = fs.readFileSync('wandao_electron/renderer/styles.css', 'utf8');

test('task progress and terminal outcomes are announced atomically to assistive technology', () => {
  assert.match(indexHtml, /id="progress-detail" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(indexHtml, /id="task-announcements" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(appJs, /function announceTaskOutcome\(task\)[\s\S]*announcer\.textContent/);
  const finishHistory = appJs.slice(appJs.indexOf('async function finishHistoryTask'), appJs.indexOf('async function runTrackedPythonCommand'));
  assert.match(finishHistory, /renderTaskStatusOrb\(\);[\s\S]*announceTaskOutcome\(task\);/);
  assert.match(appJs, /els\.section\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(appJs, /els\.section\.setAttribute\('aria-busy', 'false'\)/);
});

test('compact task status control offers navigation while detailed failures stay in task center', () => {
  assert.match(indexHtml, /id="task-status-orb" aria-label="最近任务状态" hidden/);
  assert.match(appJs, /function renderTaskStatusOrb\(\)[\s\S]*data-task-orb-action="return"[\s\S]*data-task-orb-action="task-center"/);
  assert.match(appJs, /function taskHistoryDetailsHtml\(task\)[\s\S]*<details class="task-history-details">/);
  assert.match(appJs, /data-history-action="export-failure-log"/);
  assert.match(appJs, /function exportTaskFailureLog\(taskId\)[\s\S]*saveFile[\s\S]*writeFile/);
  assert.match(appJs, /data-history-action="copy-failures" aria-label="复制此任务的失败项"/);
  assert.match(styles, /\.task-status-orb \{/);
  assert.match(styles, /button:focus-visible,[\s\S]*\[tabindex\]:focus-visible/);
});
