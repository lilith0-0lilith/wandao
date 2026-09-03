const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectFailureDiagnostics,
  deriveTaskStatus,
  normalizeTaskReport,
  resourceCounts,
  warningCount,
  summarizeStats,
  taskDocumentFailureCount,
  taskFailureCount,
  taskResourceFailureCount,
  taskStatusText
} = require('../wandao_electron/renderer/task_report');

const resourceFailureReport = {
  exportedDocs: 1,
  failureCount: 0,
  imageFailureCount: 1,
  attachmentFailureCount: 1,
  resourceFailures: [
    {
      document: 'doc.md',
      failures: [
        { kind: 'image', url: 'https://cdn.example.test/image.png', error: 'HTTP 500' },
        { kind: 'attachment', url: 'https://files.example.test/guide.pdf', error: 'HTTP 403' }
      ]
    }
  ]
};

test('resource download warnings stay separate from document export failures', () => {
  const report = normalizeTaskReport(resourceFailureReport);
  const summary = summarizeStats(report.stats);
  const diagnostics = collectFailureDiagnostics(resourceFailureReport);

  assert.equal(report.stats.failed, 0);
  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.stats.attachmentFailed, 1);
  assert.equal(report.stats.resourceFailed, 2);
  assert.equal(taskDocumentFailureCount({ status: 'completed', report }), 0);
  assert.equal(taskResourceFailureCount({ status: 'completed', report }), 2);
  assert.equal(taskFailureCount({ status: 'completed', report }), 2);
  assert.match(summary, /\u56fe\u7247\u5931\u8d25 1/);
  assert.match(summary, /\u9644\u4ef6\u5931\u8d25 1/);
  assert.match(summary, /\u8d44\u6e90\u5931\u8d25 2/);
  assert.ok(diagnostics.some((line) => line.includes('guide.pdf') && line.includes('HTTP 403')));
  assert.equal(deriveTaskStatus({ status: 'completed', report }), 'partial');
  assert.equal(taskStatusText({ status: 'completed', report }), '\u90e8\u5206\u5b8c\u6210');
});

test('legacy nested stats reports normalize without requiring failure arrays', () => {
  const report = normalizeTaskReport({
    stats: {
      total: 7,
      success: 5,
      failed: 2,
      imageFailed: 1,
      attachmentFailed: 1
    }
  });

  assert.equal(report.stats.total, 7);
  assert.equal(report.stats.success, 5);
  assert.equal(report.stats.failed, 2);
  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.stats.attachmentFailed, 1);
  assert.deepEqual(report.documentFailures, []);
  assert.deepEqual(report.imageFailures, []);
  assert.deepEqual(report.attachmentFailures, []);
});

test('attachment-only warning has an explicit fallback diagnostic', () => {
  const diagnostics = collectFailureDiagnostics({
    exportedDocs: 1,
    failureCount: 0,
    attachmentFailureCount: 1
  });

  assert.ok(diagnostics.some((line) => line.includes('attachmentFailureCount=1')));
});

test('task status preserves partial work from non-zero process exits', () => {
  const report = normalizeTaskReport(resourceFailureReport);

  assert.equal(deriveTaskStatus({ status: 'completed', report }), 'partial');
  assert.equal(deriveTaskStatus({ status: 'completed', report }, { result: { success: false, code: 1 } }), 'partial');
  assert.equal(
    deriveTaskStatus(
      { status: 'completed', report: normalizeTaskReport({ totalDocs: 1, failureCount: 1 }) },
      { result: { success: false, code: 1 } }
    ),
    'failed'
  );
  assert.equal(deriveTaskStatus({ status: 'completed', report }, { result: { success: false, code: 130 } }), 'stopped');
  assert.equal(deriveTaskStatus({ status: 'stopping', report }), 'stopping');
});

test('rate-limit pause remains resumable instead of looking completed', () => {
  const report = normalizeTaskReport({
    exportedDocs: 2,
    rateLimitedPaused: true,
    rateLimitPauseReason: '连续 429，安全暂停'
  });

  assert.equal(report.rateLimitedPaused, true);
  assert.equal(deriveTaskStatus({ status: 'completed', report }), 'paused');
  assert.equal(taskStatusText({ status: 'completed', report }), '\u56e0\u98ce\u63a7\u6682\u505c');
});

test('document failures and resource warnings stay distinct for retry decisions', () => {
  const report = normalizeTaskReport({
    totalDocs: 3,
    failureCount: 1,
    failures: [{ relativePath: 'broken.md', error: 'HTTP 500' }],
    imageFailureCount: 2
  });
  const task = { status: 'completed', report };

  assert.equal(taskDocumentFailureCount(task), 1);
  assert.equal(taskResourceFailureCount(task), 2);
  assert.equal(taskFailureCount(task), 3);
  assert.equal(deriveTaskStatus(task), 'partial');
});

test('legacy duplicated resource failures do not become document failures', () => {
  const report = normalizeTaskReport({
    exportedDocs: 1,
    failureCount: 0,
    failures: [
      { url: 'https://cdn.example.test/a.png', error: 'HTTP 500' }
    ],
    imageFailures: [
      { url: 'https://cdn.example.test/a.png', error: 'HTTP 500' }
    ],
    imageFailureCount: 1
  });

  assert.equal(report.stats.failed, 0);
  assert.equal(report.documentFailures.length, 0);
  assert.equal(report.resourceFailures.length, 1);
  assert.equal(report.stats.resourceFailed, 1);
  assert.equal(taskDocumentFailureCount({ report }), 0);
  assert.equal(taskResourceFailureCount({ report }), 1);
});

test('resource counts remain additive when only explicit image and attachment counts exist', () => {
  const report = normalizeTaskReport({ imageFailureCount: 2, attachmentFailureCount: 3 });

  assert.equal(report.stats.imageFailed, 2);
  assert.equal(report.stats.attachmentFailed, 3);
  assert.equal(report.stats.resourceFailed, 5);
});

test('root resource warning list becomes resource details without document failures', () => {
  const source = {
    resourceWarnings: [
      { url: 'https://cdn.example.test/a.bin', error: 'HTTP 403' },
      '资源被跳过'
    ]
  };
  const report = normalizeTaskReport(source);

  assert.equal(report.stats.failed, 0);
  assert.equal(report.stats.resourceFailed, 2);
  assert.equal(report.resourceFailures.length, 2);
  assert.ok(report.resourceFailures.some((item) => item.url));
  assert.ok(report.resourceFailures.some((item) => item.warning === '资源被跳过'));
});

test('nested image and attachment warnings inherit their document context', () => {
  const report = normalizeTaskReport({
    documents: [
      {
        relativePath: '目录/图片.md',
        imageWarnings: [{ url: 'https://cdn.example.test/image.png', error: '404' }]
      },
      {
        document: '目录/附件.md',
        attachmentWarnings: [{ name: 'guide.pdf', error: '403' }]
      }
    ]
  });

  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.stats.attachmentFailed, 1);
  assert.equal(report.stats.resourceFailed, 2);
  assert.equal(report.imageFailures[0].relativePath, '目录/图片.md');
  assert.equal(report.attachmentFailures[0].document, '目录/附件.md');
});

test('local image reference aliases are de-duplicated with generic resources', () => {
  const report = normalizeTaskReport({
    resourceFailures: [
      {
        document: 'a.md',
        reason: '本地图片引用未修复：assets/a.png（找不到本地文件）'
      }
    ],
    localImageReferenceFailures: [
      { document: 'a.md', reference: 'assets/a.png', warning: '缺少本地图片' }
    ]
  });

  assert.equal(report.stats.resourceFailed, 1);
  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.resourceFailures.length, 1);
  assert.equal(report.resourceFailures[0].type, 'image');
});

test('document failure with a URL and image wording is not reclassified as a resource', () => {
  const report = normalizeTaskReport({
    failureCount: 1,
    failures: [{
      relativePath: '正文.md',
      url: 'https://example.test/document',
      error: '正文图片说明解析失败'
    }]
  });

  assert.equal(report.stats.failed, 1);
  assert.equal(report.stats.resourceFailed, 0);
  assert.equal(report.resourceFailures.length, 0);
  assert.equal(report.documentFailures.length, 1);
});

test('warning count supports aggregate numbers and scalar lists', () => {
  const countOnly = normalizeTaskReport({
    imageWarnings: 3,
    attachmentWarnings: 0,
    resourceWarnings: 4
  });
  const listOnly = normalizeTaskReport({
    imageWarnings: ['a', 'b'],
    attachmentWarnings: ['c']
  });

  assert.equal(warningCount({ imageWarnings: 3 }, 'imageWarnings'), 3);
  assert.equal(countOnly.stats.imageFailed, 3);
  assert.equal(countOnly.stats.attachmentFailed, 0);
  assert.equal(countOnly.stats.resourceFailed, 4);
  assert.equal(countOnly.resourceFailures.length, 0);
  assert.equal(listOnly.stats.imageFailed, 2);
  assert.equal(listOnly.stats.attachmentFailed, 1);
  assert.equal(listOnly.stats.resourceFailed, 3);
  assert.equal(listOnly.resourceFailures.length, 3);
});

test('same reference remains separate when image and attachment types differ', () => {
  const source = {
    imageFailures: [{ url: 'https://cdn.example.test/shared', error: 'image failed' }],
    attachmentFailures: [{ url: 'https://cdn.example.test/shared', error: 'attachment failed' }]
  };
  const report = normalizeTaskReport(source);

  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.stats.attachmentFailed, 1);
  assert.equal(report.stats.resourceFailed, 2);
  assert.equal(report.resourceFailures.length, 2);
});

test('generic resource is upgraded by a matching concrete resource', () => {
  const report = normalizeTaskReport({
    resourceFailures: [{ url: 'https://cdn.example.test/a.png', error: 'failed' }],
    imageFailures: [{ url: 'https://cdn.example.test/a.png', error: 'failed', kind: 'image' }]
  });

  assert.equal(report.stats.resourceFailed, 1);
  assert.equal(report.stats.imageFailed, 1);
  assert.equal(report.resourceFailures.length, 1);
  assert.equal(report.resourceFailures[0].type, 'image');
});

test('explicit resource counts reconcile with listed items by taking the maximum evidence', () => {
  const source = {
    imageFailureCount: 5,
    attachmentFailureCount: 1,
    resourceFailureCount: 2,
    imageFailures: [{ url: 'https://cdn.example.test/a.png' }],
    attachmentFailures: [
      { url: 'https://files.example.test/a.pdf' },
      { url: 'https://files.example.test/b.pdf' }
    ]
  };
  const report = normalizeTaskReport(source);
  const counts = resourceCounts(source, report.resourceFailures);

  assert.equal(report.stats.imageFailed, 5);
  assert.equal(report.stats.attachmentFailed, 2);
  assert.equal(report.stats.resourceFailed, 7);
  assert.deepEqual(counts, { imageCount: 5, attachmentCount: 2, totalCount: 7 });
});

test('warning wrapper count and alias list use the larger value', () => {
  const report = normalizeTaskReport({
    imageWarnings: { count: 5, items: ['a', 'b'] }
  });

  assert.equal(report.stats.imageFailed, 5);
  assert.equal(report.stats.resourceFailed, 5);
});
