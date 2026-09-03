const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { createProcessor } = require('../wandao_electron/renderer/structured_logs');

const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
const indexHtml = fs.readFileSync('wandao_electron/renderer/index.html', 'utf8');
const styles = fs.readFileSync('wandao_electron/renderer/styles.css', 'utf8');

test('progress UI exposes elapsed time without turning it into a live announcement', () => {
  assert.match(indexHtml, /class="progress-elapsed" id="progress-elapsed" aria-label="任务已用时"/);
  assert.match(appJs, /let progressStartedAt = 0/);
  assert.match(appJs, /function progressHeartbeatDetail\(elapsedMs\)/);
  assert.match(appJs, /progressHeartbeatTimer = window\.setInterval\(\(\) => refreshProgressFeedback\(\), 1000\)/);
  assert.match(appJs, /function stopProgressHeartbeat\(\)[\s\S]*window\.clearInterval\(progressHeartbeatTimer\)/);
  assert.match(appJs, /els\.fill\.className = 'progress-fill indeterminate';\s*\n\s*els\.fill\.style\.width = ''/);
  assert.match(appJs, /progressHasRealProgress = safeTotal > 0/);
  const runnerStart = appJs.indexOf('async function runProviderCommand');
  const runnerEnd = appJs.indexOf('\nfunction shouldTrackTask', runnerStart);
  assert.match(appJs.slice(runnerStart, runnerEnd), /if \(!progressVisible\) \{[\s\S]*startProgress\(/);
  assert.match(styles, /\.progress-fill\.indeterminate \{[\s\S]*width: 38%;[\s\S]*animation: progress-slide/);
  assert.match(styles, /\.progress-detail-row \{/);
  assert.match(styles, /\.progress-elapsed \{[\s\S]*font-variant-numeric: tabular-nums/);
});

test('directory heartbeat has an explicit long-running fallback', () => {
  const start = appJs.indexOf('function progressHeartbeatDetail');
  const end = appJs.indexOf('function refreshProgressFeedback', start);
  const source = appJs.slice(start, end);
  assert.match(source, /正在连接远端服务并读取目录结构/);
  assert.match(source, /仍在读取远端目录，远端暂未返回细分进度/);
  assert.match(appJs, /startProgress\(`读取目录：\$\{config\.title\}`, '正在连接远端服务，准备读取目录结构\.\.\.', \{ phase: 'directory' \}\)/);
});

test('task.started totals become real progress immediately', () => {
  const progress = [];
  const processor = createProcessor({ updateProgress: (...args) => progress.push(args) });
  processor.handleEvent({
    event: 'task.started',
    level: 'info',
    message: '开始导出，共 113 篇。',
    totals: { documents: 113 }
  });
  assert.deepEqual(progress, [[0, 113, '开始导出，共 113 篇。']]);
});
