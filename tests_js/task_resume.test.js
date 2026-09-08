const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  buildResumeArgs,
  hasDeferredDocuments,
  isInterruptedTask,
  providerCheckpointArgs,
  providerCheckpointFile,
  shouldRetryFailureItems
} = require('../wandao_electron/renderer/task_resume');

test('manifest providers can derive checkpoint paths from a shared base field', () => {
  const provider = {
    id: 'xiliu-import',
    checkpoint: { supported: true, baseField: 'source_dir', fileName: 'xiliu-import.sqlite' }
  };
  assert.equal(
    providerCheckpointFile(provider, { source_dir: 'E:/notes/demo/' }),
    'E:/notes/demo/.wandao/xiliu-import.sqlite'
  );
  assert.equal(providerCheckpointFile(provider, { source_dir: '' }), '');
});

test('FlowUs import manifest uses a non-TOC target action and shared checkpoint contract', () => {
  const provider = require('../plugins/xiliu/providers/xiliu-import/provider.json');
  const targets = provider.actions.find((action) => action.id === 'targets');
  const sourceDir = provider.fields.find((field) => field.name === 'source_dir');
  const parentId = provider.fields.find((field) => field.name === 'parent_id');
  const spaceId = provider.fields.find((field) => field.name === 'space_id');

  assert.equal(provider.capabilities.scanToc, false);
  assert.equal(targets.kind, 'check');
  assert.ok(targets.args.includes('--scan-targets'));
  assert.equal(targets.includeSelection, false);
  assert.ok(!sourceDir.actions.includes('targets'));
  assert.equal(parentId.type, 'select');
  assert.equal(parentId.required, true);
  assert.equal(spaceId.type, 'select');
  assert.deepEqual(targets.updates.map((update) => [update.field, update.path]), [
    ['parent_id', 'targets'],
    ['space_id', 'spaces']
  ]);
  assert.equal(
    providerCheckpointFile(provider, { source_dir: 'E:/notes/demo/' }),
    'E:/notes/demo/.wandao/xiliu-import.sqlite'
  );
  assert.deepEqual(
    providerCheckpointArgs(provider, { source_dir: 'E:/notes/demo/' }),
    ['--checkpoint-file', 'E:/notes/demo/.wandao/xiliu-import.sqlite', '--resume']
  );
});

test('Yuque and Feishu import builders assign stable provider checkpoint task IDs', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const yuqueBuilder = appJs.slice(appJs.indexOf('function buildYuqueImportArgs'), appJs.indexOf('function yuqueImportReportPath'));
  const feishuBuilder = appJs.slice(appJs.indexOf('function buildFeishuImportArgs'), appJs.indexOf('function setFeishuImportRunning'));

  assert.match(yuqueBuilder, /--checkpoint-file[\s\S]*yuque-import\.sqlite[\s\S]*--resume[\s\S]*--checkpoint-task-id[\s\S]*yuque-import/);
  assert.match(feishuBuilder, /--checkpoint-file[\s\S]*feishu-import\.sqlite[\s\S]*--resume[\s\S]*--checkpoint-task-id[\s\S]*feishu-import/);
});

test('cooperative stops neither produce error diagnostics nor failed history', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const finishHistory = appJs.slice(appJs.indexOf('async function finishHistoryTask'), appJs.indexOf('async function runTrackedPythonCommand'));
  const diagnostics = appJs.slice(appJs.indexOf('function recordPythonResultDiagnostics'), appJs.indexOf('function clearDetailedLogs'));

  assert.match(appJs, /function isStoppedResult\(result\) \{[\s\S]*result\?\.code === 130[\s\S]*result\?\.data\?\.stopped === true/);
  assert.match(finishHistory, /const stopped = isStoppedResult\(result\) && !thrownError/);
  assert.match(finishHistory, /'stopped'/);
  assert.match(diagnostics, /isStoppedResult\(result\)[\s\S]*return/);
});

test('an explicit stopped payload wins over a successful process result', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const finishHistory = appJs.slice(appJs.indexOf('async function finishHistoryTask'), appJs.indexOf('async function runTrackedPythonCommand'));
  const start = appJs.indexOf('async function handleExport');
  const end = appJs.indexOf('// Handle stop', start);
  const handler = appJs.slice(start, end);

  assert.match(finishHistory, /const stopped = isStoppedResult\(result\) && !thrownError/);
  assert.match(finishHistory, /const fallbackStatus = stopped \? 'stopped' : \(success \? 'completed' :/);
  assert.match(finishHistory, /WandaoTaskReport\?\.deriveTaskStatus/);
  assert.match(handler, /if \(isStoppedResult\(result\)\) \{[\s\S]*finishProgress\('stopped'/);
});

test('a manually stopped task keeps checkpoint resume mode instead of switching to retry-failed', () => {
  const task = { status: 'stopped', args: ['--checkpoint-file', 'out/.wandao/checkpoint.sqlite', '--resume'] };
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 1), task.args);
  assert.equal(shouldRetryFailureItems(task, '--retry-failed', 1), false);
});

test('an interrupted task removes a stale retry-failed argument before continuing', () => {
  const task = { status: 'interrupted', args: ['--resume', '--retry-failed'] };
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 1), ['--resume']);
  assert.equal(isInterruptedTask(task), true);
});

test('a stopped task removes a stale retry argument even when no failures were recorded', () => {
  const task = { status: 'stopped', args: ['--resume', '--retry-failed'] };
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 0), ['--resume']);
  assert.equal(shouldRetryFailureItems(task, '--retry-failed', 0), false);
});

test('a real failed task still retries only its failed items when supported', () => {
  const task = { status: 'failed', args: ['--resume'] };
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 2), ['--resume', '--retry-failed']);
  assert.equal(shouldRetryFailureItems(task, '--retry-failed', 2), true);
});

test('a failed cursor-based Group export continues from its saved cursor instead of narrowing to retry-failed items', () => {
  const task = { status: 'failed', args: ['--resume'] };
  const provider = { checkpoint: { supported: true, strategy: 'cursor' } };
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 12, provider), ['--resume']);
  assert.equal(shouldRetryFailureItems(task, '--retry-failed', 12, provider), false);
});

test('a service-paused task continues pending pages instead of narrowing to failed items', () => {
  const task = {
    status: 'partial',
    args: ['--resume', '--retry-failed'],
    report: { deferred: [{ id: 'pending-page' }] }
  };
  assert.equal(hasDeferredDocuments(task), true);
  assert.deepEqual(buildResumeArgs(task, '--retry-failed', 1), ['--resume']);
  assert.equal(shouldRetryFailureItems(task, '--retry-failed', 1), false);
});

test('the renderer loads and uses the resume helper before app startup', () => {
  const indexHtml = fs.readFileSync('wandao_electron/renderer/index.html', 'utf8');
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  assert.ok(indexHtml.indexOf('task_resume.js') < indexHtml.indexOf('app.js'));
  assert.match(appJs, /WandaoTaskResume\?\.buildResumeArgs/);
  assert.match(appJs, /WandaoTaskResume\?\.shouldRetryFailureItems/);
});

test('resuming historical task treats code 130 as stopped without entering failure handling', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const start = appJs.indexOf('async function resumeTask');
  const end = appJs.indexOf('function latestResumableTask', start);
  const handler = appJs.slice(start, end);

  assert.match(handler, /else if \(outcome === 'stopped'\) \{[\s\S]*?已停止[\s\S]*?finishProgress\('stopped', [\s\S]*?已停止[\s\S]*?\} else \{[\s\S]*?失败/);
});

test('resuming on the current provider preserves its live form instead of re-rendering it', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const start = appJs.indexOf('async function resumeTask');
  const end = appJs.indexOf('function latestResumableTask', start);
  const handler = appJs.slice(start, end);

  assert.match(
    handler,
    /task\.providerId && TOOLS\[task\.providerId\] && currentTool !== task\.providerId/
  );
  assert.match(handler, /if \(!switchTool\(task\.providerId\)\) \{/);
  assert.ok(
    handler.indexOf('currentTool !== task.providerId') < handler.indexOf('switchTool(task.providerId)'),
    'the provider equality guard must run before any navigation'
  );
});

test('generic export treats the cooperative stop exit code as stopped, not a resource failure', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const start = appJs.indexOf('async function handleExport');
  const end = appJs.indexOf('// Handle stop', start);
  const handler = appJs.slice(start, end);

  assert.match(handler, /isStoppedResult\(result\)[\s\S]*已停止[\s\S]*finishProgress/);
});

test('Yuque import preserves checkpoint arguments and displays code 130 as stopped', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  assert.match(appJs, /yuque-import\.sqlite/);
  const start = appJs.indexOf('async function runYuqueImportCommand');
  const end = appJs.indexOf('async function handleYuqueImport', start);
  const handler = appJs.slice(start, end);
  assert.match(handler, /if \(isStoppedResult\(result\)\)/);
  assert.match(handler, /已停止，已完成项目会在下次继续时跳过/);
  assert.match(handler, /finishProgress\('stopped'/);
});

test('manifest-provider actions treat code 130 as stopped before the failure branch', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const start = appJs.indexOf('actions.forEach((action) => {');
  const end = appJs.indexOf('function sandboxPluginHtml', start);
  const handler = appJs.slice(start, end);

  assert.match(handler, /if \(isStoppedResult\(result\)\) \{[\s\S]*finishProgress\('stopped',[\s\S]*\} else if \(result\.success\) \{/);
});

test('resource failures are retried when the provider supports failed-item retry', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const canResume = appJs.slice(appJs.indexOf('function canResumeTask'), appJs.indexOf('function resumeTaskDisabledReason'));
  const resumeArgs = appJs.slice(appJs.indexOf('function resumeTaskArgs'), appJs.indexOf('async function performTaskHistoryLoad'));
  const resumeTaskHandler = appJs.slice(appJs.indexOf('async function resumeTask'), appJs.indexOf('function latestResumableTask'));
  const taskDetails = appJs.slice(appJs.indexOf('function taskHistoryDetailsHtml'), appJs.indexOf('function activeTaskStatusOrbTask'));

  assert.match(canResume, /taskFailureCount\(task\)/);
  assert.match(resumeArgs, /taskFailureCount\(task\)/);
  assert.match(resumeTaskHandler, /const retryableFailures = taskFailureCount\(task\)/);
  assert.match(resumeTaskHandler, /失败项，共 \$\{retryableFailures\} 个/);
  assert.match(taskDetails, /renderTaskFailureDetails\('图片失败', imageFailures, 'image', 12, \{ providerId: task\.providerId \}\)/);
  assert.match(taskDetails, /renderTaskFailureDetails\('其他资源失败', otherResourceFailures, 'resource', 12, \{ providerId: task\.providerId \}\)/);
  assert.match(taskDetails, /task-history-recovery/);
  assert.doesNotMatch(taskDetails, /不会把它们误作“失败文档”自动重试/);
});

test('unsupported providers do not advertise a retry-failed action', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const label = appJs.slice(appJs.indexOf('function taskResumeActionLabel'), appJs.indexOf('async function performTaskHistoryLoad'));
  assert.match(label, /const supportsFailureRetry = Boolean\(providerRetryFailureArg\(TOOLS\[task\?\.providerId\]/);
  assert.match(label, /supportsFailureRetry && \(status === 'completed' \|\| status === 'partial'\)/);
});

test('historical task rendering normalizes legacy reports and keeps startup independent from history rendering', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const normalizedReport = appJs.slice(appJs.indexOf('function normalizedTaskReport'), appJs.indexOf('function renderTaskFailureDetails'));
  const taskDetails = appJs.slice(appJs.indexOf('function taskHistoryDetailsHtml'), appJs.indexOf('function activeTaskStatusOrbTask'));
  const appPaths = appJs.slice(appJs.indexOf('function loadAppPaths'), appJs.indexOf('// Tool switching'));

  assert.doesNotMatch(normalizedReport, /if \(task\?\.report\?\.stats\) return task\.report/);
  assert.match(normalizedReport, /imageFailures: \[\]/);
  assert.match(normalizedReport, /attachmentFailures: \[\]/);
  assert.match(taskDetails, /const documentFailures = Array\.isArray\(report\.documentFailures\)/);
  assert.match(taskDetails, /renderTaskFailureDetails\('图片失败', imageFailures, 'image', 12, \{ providerId: task\.providerId \}\)/);
  assert.match(appPaths, /try \{\s*await loadTaskHistory\(\);\s*\} catch \(error\)/);
  assert.match(appPaths, /平台页面仍可正常打开/);
});

test('latest task status orb offers direct retry for supported failed items', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const orb = appJs.slice(appJs.indexOf('function activeTaskStatusOrbTask'), appJs.indexOf('function dismissTaskStatusOrb'));
  const completion = appJs.slice(appJs.indexOf('function taskResultCompletionState'), appJs.indexOf('function finishProgressForTaskResult'));

  assert.match(orb, /function canRetryFailureItems\(task\)/);
  assert.match(orb, /data-task-orb-action="retry"/);
  assert.match(orb, /只重新处理这次任务失败的文档或资源/);
  assert.match(completion, /点击任务提示中的“重试失败项”直接重试/);
});

test('running tasks keep workbench navigation but block other platform actions', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const switching = appJs.slice(appJs.indexOf('function switchTool'), appJs.indexOf('// Initialize tool event handlers'));
  const guard = appJs.slice(appJs.indexOf('function isAllowedWhileRunningControl'), appJs.indexOf('function feishuImportConfigPath'));

  assert.match(switching, /const allowsWorkbenchNavigation = PRIMARY_NAV_ITEMS\.some/);
  assert.match(switching, /!allowsWorkbenchNavigation && !allowsActiveTaskNavigation/);
  assert.match(guard, /if \(control\.matches\('\[data-tool\]'\)\) return isPrimaryWorkbenchView/);
  assert.match(guard, /\[data-notice-id\], \[data-notice-action\]/);
  assert.match(guard, /if \(control\.matches\('\[data-plugin-action\]'\)\) \{[\s\S]*return !pluginOperationBlocked/);
  assert.match(appJs, /function restoreActiveTaskFormValues\(provider\)/);
  assert.match(appJs, /function providerFieldElement\(provider, field\)/);
  assert.match(appJs, /data-history-key/);
  assert.match(switching, /restoreActiveTaskFormValues\(config\);/);
  assert.match(appJs, /if \(!element \|\| !value \|\| String\(element\.value \|\| ''\)\.trim\(\)\) return;/);
});

test('plugin center protects the plugin used by the active task', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const pluginGuard = appJs.slice(appJs.indexOf('function runningTaskProviderId'), appJs.indexOf('function renderPluginCard'));
  const actions = appJs.slice(appJs.indexOf('async function installPluginFromCatalog'), appJs.indexOf('async function runPluginCenterAction'));
  const bulkUpdate = appJs.slice(appJs.indexOf('async function runPluginCenterUpdateAll'), appJs.indexOf('function bindPluginCenterActions'));

  assert.match(pluginGuard, /TOOLS\[providerId\]\?\.pluginId/);
  assert.match(pluginGuard, /\(isRunning \|\| mainPythonProcessState\.running\)[\s\S]*runningPluginId/);
  assert.match(actions, /if \(pluginOperationBlocked\(plugin\.id\)\)/);
  assert.match(bulkUpdate, /allCandidates\.filter\(\(plugin\) => !pluginOperationBlocked/);
});

test('resuming a historical task does not repeat an existing action prefix in its title', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const subject = appJs.slice(appJs.indexOf('function taskResumeSubject'), appJs.indexOf('async function performTaskHistoryLoad'));
  const handler = appJs.slice(appJs.indexOf('async function resumeTask'), appJs.indexOf('function latestResumableTask'));

  assert.match(subject, /function taskResumeSubject\(task\)/);
  assert.match(subject, /继续任务\|重试失败项/);
  assert.match(handler, /const resumeSubject = taskResumeSubject\(task\)/);
  assert.match(handler, /继续任务：\$\{resumeSubject\}/);
  assert.doesNotMatch(handler, /继续任务：\$\{task\.title \|\| task\.script\}/);
});

test('resource diagnostics are not duplicated after reports are finalized', () => {
  const report = require('../wandao_electron/renderer/task_report');
  const resource = {
    type: 'image',
    document: '示例文档',
    path: 'out/example.md',
    failures: [{ url: 'https://image.example.test/resource.png', error: 'timed out' }]
  };
  const diagnostics = report.collectFailureDiagnostics({
    imageFailureCount: 1,
    imageFailures: [resource],
    resourceFailures: [resource]
  });
  assert.equal(diagnostics.filter((line) => line.includes('https://image.example.test/resource.png')).length, 1);
  assert.ok(!diagnostics.some((line) => line.includes('脚本没有返回逐项图片失败原因')));
});

test('latest task status stays compact while actionable details live in task center', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const indexHtml = fs.readFileSync('wandao_electron/renderer/index.html', 'utf8');
  const styles = fs.readFileSync('wandao_electron/renderer/styles.css', 'utf8');
  const finishHistory = appJs.slice(appJs.indexOf('async function finishHistoryTask'), appJs.indexOf('async function runTrackedPythonCommand'));

  assert.ok(indexHtml.indexOf('id="progress-section"') < indexHtml.indexOf('id="content-area"'));
  assert.match(indexHtml, /id="task-status-orb"/);
  assert.doesNotMatch(indexHtml, /task-result-card/);
  assert.match(appJs, /function renderTaskStatusOrb\(\)/);
  assert.match(appJs, /data-task-orb-action="return"/);
  assert.match(appJs, /data-task-orb-action="task-center"/);
  assert.match(appJs, /function taskHistoryDetailsHtml\(task\)[\s\S]*<details class="task-history-details">/);
  assert.match(appJs, /data-history-action="open-output"/);
  assert.match(appJs, /data-history-action="open-report"/);
  assert.match(appJs, /data-history-action="copy-failures"/);
  assert.match(appJs, /data-history-action="resume"/);
  assert.match(finishHistory, /latestFinishedTaskId = task\.id[\s\S]*renderTaskStatusOrb\(\)/);
  assert.match(styles, /\.progress-section \{[\s\S]*position: static/);
  assert.match(styles, /\.action-section \{[\s\S]*position: static/);
  assert.match(styles, /\.provider-mode-switcher \{[\s\S]*position: static/);
  assert.match(styles, /\.task-status-orb \{[\s\S]*position: fixed/);
});

test('manual stop remains stopping until command completion records its terminal state', () => {
  const appJs = fs.readFileSync('wandao_electron/renderer/app.js', 'utf8');
  const handler = appJs.slice(appJs.indexOf('async function handleStop'), appJs.indexOf('// Set running state'));

  assert.match(handler, /const task = activeHistoryTask/);
  assert.match(handler, /task\.status = 'stopping'/);
  assert.doesNotMatch(handler, /task\.status = 'stopped'/);
  assert.match(handler, /等待当前进程退出/);
});
