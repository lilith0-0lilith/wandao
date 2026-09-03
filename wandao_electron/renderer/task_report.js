(function (root) {
  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = stringifyIdentity(value);
      if (text) return text;
    }
    return '';
  }

  function stableStringify(value) {
    if (value === undefined) return '';
    if (value === null || typeof value !== 'object') {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch (_error) {
        return String(value);
      }
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }

  function stringifyIdentity(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return stableStringify(value);
    return String(value).trim();
  }

  function compact(value, limit = 700) {
    const text = typeof value === 'string' ? value : stableStringify(value ?? '');
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function numberValue(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
  }

  function maxCount(...values) {
    return values.reduce((maximum, value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > maximum ? number : maximum;
    }, 0);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function nonNegativeValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function nonNegativeNumber(...values) {
    return values.reduce((maximum, value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number > maximum ? number : maximum;
    }, 0);
  }

  const RESOURCE_TYPES = new Set(['resource', 'image', 'attachment']);
  const RESOURCE_REFERENCE_KEYS = [
    'url', 'src', 'ref', 'source', 'target', 'file', 'resource',
    'resourcePath', 'localPath', 'reference', 'image', 'attachment', 'name'
  ];
  const RESOURCE_DOCUMENT_KEYS = [
    'document', 'relativePath', 'path', 'title', 'docId', 'nodeId', 'itemKey'
  ];
  const RESOURCE_ERROR_KEYS = ['error', 'reason', 'message', 'status', 'code', 'warning'];
  const RESOURCE_CONTAINER_KEYS = ['failures', 'warnings', 'items', 'resources', 'entries'];
  const RESOURCE_WARNING_ROOTS = [
    ['resourceWarnings', 'resource'],
    ['imageWarnings', 'image'],
    ['attachmentWarnings', 'attachment'],
    ['localImageReferenceFailures', 'image']
  ];

  function firstValue(item, keys) {
    if (!item || typeof item !== 'object') return '';
    for (const key of keys) {
      const value = stringifyIdentity(item[key]);
      if (value) return value;
    }
    return '';
  }

  function normalizeResourceKind(value, fallback = 'resource') {
    const text = stringifyIdentity(value).toLowerCase();
    if (/image|图片|img/.test(text)) return 'image';
    if (/attachment|附件|file/.test(text)) return 'attachment';
    if (/resource|asset|资源/.test(text)) return 'resource';
    return RESOURCE_TYPES.has(fallback) || fallback === '' ? fallback : 'resource';
  }

  function resourceKindFromItem(item, inherited = 'resource') {
    if (!item || typeof item !== 'object') return normalizeResourceKind(inherited, 'resource');
    for (const key of ['kind', 'type', 'resourceType', 'assetType', 'category']) {
      const value = normalizeResourceKind(item[key], '');
      if (RESOURCE_TYPES.has(value)) return value;
    }
    return normalizeResourceKind(inherited, 'resource');
  }

  function resourceType(item) {
    return resourceKindFromItem(item, 'resource');
  }

  function resourceDocumentIdentity(item) {
    return firstValue(item, RESOURCE_DOCUMENT_KEYS);
  }

  function resourceReferenceIdentity(item) {
    return firstValue(item, RESOURCE_REFERENCE_KEYS);
  }

  function resourceErrorIdentity(item) {
    const direct = firstValue(item, RESOURCE_ERROR_KEYS);
    if (direct) return direct;
    const errorInfo = item?.errorInfo;
    return errorInfo && typeof errorInfo === 'object'
      ? firstValue(errorInfo, ['code', 'technicalMessage', 'message', 'userMessage'])
      : '';
  }

  function resourceIdentityParts(item) {
    return [resourceDocumentIdentity(item), resourceReferenceIdentity(item), resourceErrorIdentity(item)];
  }

  function resourceHasIdentity(item) {
    return resourceIdentityParts(item).some(Boolean);
  }

  function resourceFingerprint(item) {
    return [resourceType(item), ...resourceIdentityParts(item)].join('\u0000');
  }

  function resourceReferenceFingerprint(item) {
    return [resourceReferenceIdentity(item), resourceErrorIdentity(item)].join('\u0000');
  }

  function resourceFingerprintWithoutType(item) {
    return resourceIdentityParts(item).join('\u0000');
  }

  function localImageReferenceAlias(item) {
    const direct = firstValue(item, ['reference']);
    if (direct) return direct;
    for (const key of ['reason', 'error', 'message']) {
      const text = stringifyIdentity(item?.[key]);
      if (!text.startsWith('本地图片引用未修复')) continue;
      let remainder = text.replace(/^本地图片引用未修复\s*[:：]\s*/, '');
      const separator = ['（', '('].find((candidate) => remainder.includes(candidate));
      if (separator) remainder = remainder.split(separator, 1)[0];
      if (remainder.trim()) return remainder.trim();
    }
    return '';
  }

  function resourceTypesCompatible(left, right) {
    return left === right || left === 'resource' || right === 'resource';
  }

  function resourceItemsMatch(left, right) {
    const leftType = resourceType(left);
    const rightType = resourceType(right);
    if (!resourceTypesCompatible(leftType, rightType)) return false;
    if (resourceFingerprintWithoutType(left) === resourceFingerprintWithoutType(right)
      && (resourceHasIdentity(left) || resourceHasIdentity(right) || resourceFingerprint(left) === resourceFingerprint(right))) {
      return true;
    }
    const leftReference = localImageReferenceAlias(left);
    const rightReference = localImageReferenceAlias(right);
    if (!leftReference || leftReference !== rightReference) return false;
    const leftDocument = resourceDocumentIdentity(left);
    const rightDocument = resourceDocumentIdentity(right);
    return !leftDocument || !rightDocument || leftDocument === rightDocument;
  }

  function mergeResourceItems(left, right) {
    const leftType = resourceType(left);
    const rightType = resourceType(right);
    const preferredType = leftType === 'resource' && rightType !== 'resource' ? rightType : leftType;
    const merged = { ...left };
    Object.entries(right || {}).forEach(([key, value]) => {
      const empty = value === undefined || value === null || value === ''
        || (Array.isArray(value) && value.length === 0)
        || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      if (!(key in merged) || merged[key] === undefined || merged[key] === null || merged[key] === ''
        || (Array.isArray(merged[key]) && merged[key].length === 0)
        || (merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key]) && Object.keys(merged[key]).length === 0)) {
        if (!empty || !(key in merged)) merged[key] = value;
      }
    });
    merged.type = preferredType;
    if (preferredType !== 'resource' && (!merged.kind || normalizeResourceKind(merged.kind, '') === 'resource')) {
      merged.kind = preferredType;
    }
    return merged;
  }

  function appendResourceFailure(items, candidate) {
    const candidateType = resourceType(candidate);
    const matches = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => resourceItemsMatch(item, candidate));
    if (!matches.length) {
      items.push(candidate);
      return;
    }
    const sameType = matches.filter(({ item }) => resourceType(item) === candidateType);
    const generic = matches.filter(({ item }) => resourceType(item) === 'resource');
    let preferred;
    let removable;
    if (candidateType === 'resource') {
      preferred = (matches.find(({ item }) => resourceType(item) !== 'resource') || generic[0] || matches[0]).index;
      const preferredType = resourceType(items[preferred]);
      removable = matches.filter(({ index, item }) => index !== preferred && resourceType(item) === preferredType).map(({ index }) => index);
    } else if (sameType.length) {
      preferred = sameType[0].index;
      removable = matches.filter(({ index, item }) => index !== preferred
        && (resourceType(item) === 'resource' || resourceType(item) === candidateType)).map(({ index }) => index);
    } else if (generic.length) {
      preferred = generic[0].index;
      removable = generic.filter(({ index }) => index !== preferred).map(({ index }) => index);
    } else {
      preferred = matches[0].index;
      removable = [];
    }
    let merged = mergeResourceItems(items[preferred], candidate);
    removable.slice().sort((left, right) => right - left).forEach((index) => {
      merged = mergeResourceItems(merged, items[index]);
      items.splice(index, 1);
    });
    const shiftedPreferred = preferred - removable.filter((index) => index < preferred).length;
    items[shiftedPreferred] = merged;
  }

  function iterNamedValues(value, names, inheritedContext = {}, seen = new Set()) {
    const results = [];
    const visit = (current, context) => {
      if (current === null || typeof current !== 'object' || seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) {
        current.forEach((child) => visit(child, context));
        return;
      }
      const nextContext = { ...context };
      RESOURCE_DOCUMENT_KEYS.forEach((key) => {
        if (nextContext[key] === undefined && current[key] !== undefined && current[key] !== null) nextContext[key] = current[key];
      });
      Object.entries(current).forEach(([key, child]) => {
        if (names.has(key)) results.push({ key, value: child, context: nextContext });
        if (child && typeof child === 'object') visit(child, nextContext);
      });
    };
    visit(value, inheritedContext);
    return results;
  }

  function resourceKindForFailure(item, knownResources = []) {
    if (!item || typeof item !== 'object') return '';
    const markerKeys = ['kind', 'type', 'resourceType', 'assetType', 'category'];
    const hasExplicitMarker = markerKeys.some((key) => item[key] !== undefined && item[key] !== null && item[key] !== '');
    const explicit = normalizeResourceKind(markerKeys.map((key) => item[key]).filter(Boolean).join(' '), '');
    if (hasExplicitMarker && RESOURCE_TYPES.has(explicit)) return explicit;
    const withoutType = resourceFingerprintWithoutType(item || {});
    const reference = resourceReferenceFingerprint(item || {});
    const matched = knownResources.find((resource) => (
      (withoutType && resourceFingerprintWithoutType(resource) === withoutType)
      || (reference && resourceReferenceFingerprint(resource) === reference)
    ));
    if (matched) return resourceType(matched);
    const errorInfo = item.errorInfo && typeof item.errorInfo === 'object' ? item.errorInfo : {};
    const kindText = ['category', 'assetType', 'resourceType'].map((key) => stringifyIdentity(item[key])).join(' ').toLowerCase();
    const errorText = [
      ...RESOURCE_ERROR_KEYS.map((key) => stringifyIdentity(item[key])),
      ...['code', 'category', 'message', 'technicalMessage']
        .map((key) => stringifyIdentity(errorInfo[key]))
    ].join(' ').toLowerCase();
    const hasReference = RESOURCE_REFERENCE_KEYS.some((key) => item[key] !== undefined && item[key] !== null && item[key] !== '');
    const hasDocumentIdentity = RESOURCE_DOCUMENT_KEYS.some((key) => item[key] !== undefined && item[key] !== null && item[key] !== '');
    const canInferFromText = !hasDocumentIdentity || hasExplicitMarker;
    if (hasReference && canInferFromText && /image|img|图片/.test(`${kindText} ${errorText}`)) return 'image';
    if (hasReference && canInferFromText && /attachment|附件|resource|asset|资源|上传附件/.test(`${kindText} ${errorText}`)) {
      return /attachment|附件/.test(`${kindText} ${errorText}`) ? 'attachment' : 'resource';
    }
    return '';
  }

  function looksLikeResourceFailure(item, knownResources = []) {
    return Boolean(resourceKindForFailure(item, knownResources));
  }

  function resourceSubject(item) {
    return firstNonEmpty(
      item?.document,
      item?.relativePath,
      item?.path,
      item?.title
    );
  }

  function collectResourceFailures(data, limit = 500) {
    const source = data && typeof data === 'object' ? data : {};
    const items = [];
    const roots = [
      ['resourceFailures', 'resource'],
      ['imageFailures', 'image'],
      ['attachmentFailures', 'attachment']
    ];
    const add = (value, inheritedKind, inheritedContext) => {
      const context = { ...inheritedContext };
      RESOURCE_DOCUMENT_KEYS.forEach((key) => {
        if (context[key] === undefined && value[key] !== undefined && value[key] !== null) {
          context[key] = value[key];
        }
      });
      const currentKind = resourceKindFromItem(value, inheritedKind);
      appendResourceFailure(items, {
        ...context,
        ...value,
        type: currentKind
      });
    };
    const visit = (value, inheritedKind = 'resource', inheritedContext = {}, scalarItem = false) => {
      if (items.length >= limit || value === undefined || value === null) return;
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, inheritedKind, inheritedContext, true));
        return;
      }
      if (typeof value !== 'object') {
        if (scalarItem && stringifyIdentity(value)) {
          const text = stringifyIdentity(value);
          add({ warning: value, message: text }, inheritedKind, inheritedContext);
        }
        return;
      }
      const currentKind = resourceKindFromItem(value, inheritedKind);
      const context = { ...inheritedContext };
      RESOURCE_DOCUMENT_KEYS.forEach((key) => {
        if (value[key] !== undefined && value[key] !== null && context[key] === undefined) context[key] = value[key];
      });
      let hasChildren = false;
      RESOURCE_CONTAINER_KEYS.forEach((key) => {
        const children = value[key];
        if (!Array.isArray(children) && !(children && typeof children === 'object')) return;
        hasChildren = true;
        visit(children, currentKind, context, true);
      });
      if (hasChildren) return;
      const looksLikeResource = Boolean(
        RESOURCE_REFERENCE_KEYS.some((key) => value[key] !== undefined && value[key] !== null && value[key] !== '')
        || RESOURCE_ERROR_KEYS.some((key) => value[key] !== undefined && value[key] !== null && value[key] !== '')
        || value.errorInfo
      );
      if (!looksLikeResource) return;
      add(value, currentKind, context);
    };
    roots.forEach(([key, kind]) => visit(source[key], kind));
    RESOURCE_WARNING_ROOTS.forEach(([key, kind]) => {
      iterNamedValues(source, new Set([key])).forEach(({ value, context }) => visit(value, kind, context));
    });
    // A few legacy providers duplicated image/attachment entries in the
    // top-level `failures` list. Promote only entries that can be matched to
    // an explicit resource list or carry an unmistakable resource marker.
    const knownResources = [...items];
    asArray(source.failures).forEach((item) => {
      const kind = resourceKindForFailure(item, knownResources);
      if (!kind) return;
      visit({ ...item, type: kind }, kind);
    });
    return items;
  }

  function warningCount(data, name) {
    const source = data && typeof data === 'object' ? data : {};
    const countValue = (value, listItem = false) => {
      if (Array.isArray(value)) return value.reduce((total, child) => total + countValue(child, true), 0);
      if (value && typeof value === 'object') {
        const nestedCounts = [];
        for (const key of RESOURCE_CONTAINER_KEYS) {
          const child = value[key];
          if (Array.isArray(child) || (child && typeof child === 'object')) {
            nestedCounts.push(countValue(child, true));
          }
        }
        const explicitCounts = [];
        for (const key of ['count', 'total', 'size']) {
          const parsed = nonNegativeValue(value[key]);
          if (parsed !== null) explicitCounts.push(parsed);
        }
        if (nestedCounts.length || explicitCounts.length) {
          // A wrapper may expose both an aggregate count and a shorter alias
          // list.  Treat them as alternative evidence, not additive buckets.
          return Math.max(...nestedCounts, ...explicitCounts);
        }
        return resourceHasIdentity(value) ? 1 : 0;
      }
      if (value === undefined || value === null || value === false) return 0;
      if (listItem) return stringifyIdentity(value) ? 1 : 0;
      const parsed = nonNegativeValue(value);
      if (parsed !== null) return parsed;
      return stringifyIdentity(value) ? 1 : 0;
    };
    return iterNamedValues(source, new Set([name]))
      .reduce((total, entry) => total + countValue(entry.value), 0);
  }

  function resourceCounts(data, resources = null) {
    const source = data && typeof data === 'object' ? data : {};
    const listed = Array.isArray(resources) ? resources : collectResourceFailures(source);
    const listedImage = listed.filter((item) => resourceType(item) === 'image').length;
    const listedAttachment = listed.filter((item) => resourceType(item) === 'attachment').length;
    const imageCount = maxCount(
      listedImage,
      nonNegativeNumber(source.imageFailureCount),
      nonNegativeNumber(source.imageFailed),
      warningCount(source, 'imageWarnings'),
      warningCount(source, 'localImageReferenceFailures')
    );
    const attachmentCount = maxCount(
      listedAttachment,
      nonNegativeNumber(source.attachmentFailureCount),
      nonNegativeNumber(source.attachmentFailed),
      warningCount(source, 'attachmentWarnings')
    );
    const totalCount = maxCount(
      listed.length,
      nonNegativeNumber(source.resourceFailureCount),
      nonNegativeNumber(source.resourceFailed),
      warningCount(source, 'resourceWarnings'),
      imageCount + attachmentCount
    );
    return { imageCount, attachmentCount, totalCount };
  }

  function collectDocumentFailures(data, limit = 500) {
    const source = data && typeof data === 'object' ? data : {};
    const items = [];
    const seen = new Set();
    const knownResources = collectResourceFailures(source);
    asArray(source.failures).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      // A few older providers put resource failures in the top-level list.
      // Keep those out of the document counter when they are explicit or can
      // be matched to an image/attachment resource reported elsewhere.
      if (looksLikeResourceFailure(item, knownResources)) return;
      const fingerprint = [
        firstValue(item, ['document', 'relativePath', 'path', 'title', 'id', 'docId', 'nodeId', 'itemKey']),
        firstValue(item, RESOURCE_ERROR_KEYS)
      ].join('\u0000');
      if (!seen.has(fingerprint) && items.length < limit) {
        seen.add(fingerprint);
        items.push(item);
      }
    });
    return items;
  }

  function collectImageFailures(data, limit = 500) {
    return collectResourceFailures(data, limit).filter((item) => item.type === 'image');
  }

  function collectAttachmentFailures(data, limit = 500) {
    return collectResourceFailures(data, limit).filter((item) => item.type === 'attachment');
  }

  function formatTaskTime(value) {
    if (!value) return '-';
    const formatter = root.WandaoTime?.formatLocalDateTime;
    if (typeof formatter === 'function') return formatter(value);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function describeFailureItem(item, parent = '') {
    if (!item || typeof item !== 'object') return compact(item);
    const resourceKind = normalizeResourceKind(item.kind || item.type, '');
    const isResource = resourceKind === 'image' || resourceKind === 'attachment' || resourceKind === 'resource';
    const subject = firstNonEmpty(...(isResource
      ? [item.url, item.target, item.file, item.resource, item.relativePath, item.path, item.document]
      : [item.relativePath, item.document, item.title, item.path, item.id, item.docId, item.nodeId, item.url, item.target, item.file, item.resource]));
    const reason = firstNonEmpty(item.error, item.reason, item.message, item.status, item.code);
    const prefix = [parent, subject]
      .filter((value, index, values) => value && (index === 0 || value !== values[index - 1]))
      .join(' / ');
    if (prefix && reason) return `${prefix}：${reason}`;
    return prefix || reason || compact(item);
  }

  function collectFailureItems(data, limit = 100) {
    const documentFailures = collectDocumentFailures(data, limit);
    const resources = collectResourceFailures(data, limit);
    return [...documentFailures, ...resources].slice(0, limit).map((item, index) => ({
      source: resources.includes(item) ? 'resourceFailures' : 'failures',
      ...item,
      failureIndex: index + 1
    }));
  }

  function normalizeErrorInfo(value, options = {}) {
    const protocol = root.WandaoErrorProtocol?.normalizeError;
    if (typeof protocol === 'function') return protocol(value, options);
    const source = value && typeof value === 'object' ? value : {};
    const nested = source.errorInfo && typeof source.errorInfo === 'object' ? source.errorInfo : source;
    const raw = firstNonEmpty(nested.technicalMessage, nested.message, nested.error, value, '未知错误');
    return {
      kind: 'wandao.error',
      schemaVersion: 1,
      code: firstNonEmpty(options.code, nested.code, 'UNKNOWN_ERROR').toUpperCase().replace(/\s+/g, '_'),
      category: firstNonEmpty(options.category, nested.category, 'unknown'),
      userMessage: firstNonEmpty(options.userMessage, nested.userMessage, '任务执行失败'),
      recovery: firstNonEmpty(options.recovery, nested.recovery, '请查看详细日志，确认输入后重试或提交错误报告。'),
      retryable: options.retryable !== undefined ? Boolean(options.retryable) : nested.retryable !== false,
      correlationId: firstNonEmpty(options.correlationId, nested.correlationId),
      technicalMessage: String(raw),
      legacyMessage: String(source.error || raw),
      explicit: Boolean(nested.kind === 'wandao.error' || nested.schemaVersion !== undefined)
    };
  }

  function errorInfoForReport(source, options = {}) {
    const value = source?.errorInfo || options.errorInfo || source?.error || options.errorText || '';
    return value ? normalizeErrorInfo(value, {
      provider: firstNonEmpty(source?.provider, source?.platform, options.provider),
      operation: firstNonEmpty(source?.mode, options.mode)
    }) : null;
  }

  function normalizeTaskReport(data, options = {}) {
    // Task history written by older desktop releases stores counters in a
    // nested `stats` object, while current reports keep the source fields at
    // the top level.  Flatten the legacy counters first, then let explicit
    // top-level values win so either shape always produces a complete report.
    const rawSource = data && typeof data === 'object' ? data : {};
    const source = {
      ...(rawSource.stats && typeof rawSource.stats === 'object' ? rawSource.stats : {}),
      ...rawSource
    };
    const documentFailures = collectDocumentFailures(source);
    const resourceFailures = collectResourceFailures(source);
    const imageFailures = resourceFailures.filter((item) => item.type === 'image');
    const attachmentFailures = resourceFailures.filter((item) => item.type === 'attachment');
    const failureItems = collectFailureItems(source);
    const resourceCountsResult = resourceCounts(source, resourceFailures);
    const imageFailed = resourceCountsResult.imageCount;
    const attachmentFailed = resourceCountsResult.attachmentCount;
    const resourceFailed = resourceCountsResult.totalCount;
    const explicitDocumentFailed = nonNegativeNumber(
      source.failureCount,
      source.failedDocs,
      source.failed,
      source.errorCount
    );
    const errorLooksLikeResource = /image|img|图片|attachment|附件|resource|下载|上传/i.test(String(options.errorText || ''));
    const failed = Math.max(explicitDocumentFailed, documentFailures.length, options.errorText && !errorLooksLikeResource ? 1 : 0);
    const stats = {
      total: nonNegativeNumber(source.totalDocs, source.total, source.selectedDocs, source.docCount, source.fileCount, source.totalFiles),
      success: nonNegativeNumber(source.successCount, source.success, source.successfulDocs, source.successfulFiles),
      exported: nonNegativeNumber(source.exportedDocs, source.exported, source.exportCount),
      imported: nonNegativeNumber(source.importedDocs, source.imported, source.importCount),
      created: nonNegativeNumber(source.createdDocs, source.created, source.createdCount),
      updated: nonNegativeNumber(source.updatedDocs, source.updated, source.updatedCount),
      skipped: nonNegativeNumber(source.skippedDocs, source.skipped, source.skippedCount),
      failed,
      imageSuccess: numberValue(source.imageSuccess, source.imageUploads, source.imageUploadsCount),
      imageFailed,
      attachmentSuccess: numberValue(source.attachmentSuccess, source.attachmentUploads),
      attachmentFailed,
      resourceFailed
    };
    if (!stats.success) stats.success = stats.exported || stats.imported || stats.created + stats.updated;
    const errorInfo = errorInfoForReport(source, options);
    return {
      schemaVersion: 1,
      provider: firstNonEmpty(source.provider, source.platform, options.provider),
      mode: firstNonEmpty(source.mode, options.mode),
      output: firstNonEmpty(source.output, source.outputDir),
      reportFile: firstNonEmpty(source.reportFile),
      stopped: Boolean(source.stopped),
      rateLimitedPaused: Boolean(source.rateLimitedPaused),
      outcome: firstNonEmpty(source.outcome),
      errorInfo,
      stats,
      documentFailures,
      resourceFailures,
      imageFailures,
      attachmentFailures,
      failures: failureItems,
      raw: source
    };
  }

  function summarizeStats(stats = {}, errorText = '') {
    const parts = [];
    if (stats.total) parts.push(`总数 ${stats.total}`);
    if (stats.exported) parts.push(`导出 ${stats.exported}`);
    if (stats.imported) parts.push(`导入 ${stats.imported}`);
    if (stats.created) parts.push(`创建 ${stats.created}`);
    if (stats.updated) parts.push(`更新 ${stats.updated}`);
    if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
    if (stats.imageSuccess) parts.push(`图片 ${stats.imageSuccess}`);
    if (stats.attachmentSuccess) parts.push(`附件 ${stats.attachmentSuccess}`);
    if (stats.imageFailed) parts.push(`\u56fe\u7247\u5931\u8d25 ${stats.imageFailed}`);
    if (stats.attachmentFailed) parts.push(`\u9644\u4ef6\u5931\u8d25 ${stats.attachmentFailed}`);
    if (stats.resourceFailed) parts.push(`\u8d44\u6e90\u5931\u8d25 ${stats.resourceFailed}`);
    if (stats.failed) parts.push(`失败 ${stats.failed}`);
    if (!parts.length && errorText) parts.push(compact(errorText, 120));
    return parts.join('，') || '暂无统计信息';
  }

  function collectFailureDiagnostics(data, limit = 80) {
    const lines = [];
    const source = data && typeof data === 'object' ? data : {};
    const report = normalizeTaskReport(data);
    const pushLine = (label, text) => {
      const content = compact(text, 700);
      if (!content || lines.length >= limit) return;
      lines.push(`${label}：${content}`);
    };
    report.documentFailures.forEach((item, index) => {
      if (lines.length >= limit) return;
      const current = describeFailureItem(item);
      if (current) pushLine(`文档失败 #${index + 1}`, current);
    });
    report.resourceFailures.forEach((item, index) => {
      if (lines.length >= limit) return;
      const kindLabel = item.type === 'image' ? '图片失败' : (item.type === 'attachment' ? '附件失败' : '资源失败');
      const current = describeFailureItem(item, resourceSubject(item));
      if (current) pushLine(`${kindLabel} #${index + 1}`, current);
    });
    if (report.stats.failed > 0 && !lines.length) {
      pushLine('失败统计', `failureCount=${report.stats.failed}，脚本没有返回逐项失败原因，请查看 Python 原始日志。`);
    }
    const hasImageDetails = report.imageFailures.length > 0;
    const hasAttachmentDetails = report.attachmentFailures.length > 0;
    if (report.stats.imageFailed > 0 && !hasImageDetails) {
      pushLine('图片失败统计', `imageFailureCount=${report.stats.imageFailed}，脚本没有返回逐项图片失败原因。`);
    }
    if (report.stats.attachmentFailed > 0 && !hasAttachmentDetails) {
      pushLine('\u9644\u4ef6\u5931\u8d25\u7edf\u8ba1', `attachmentFailureCount=${report.stats.attachmentFailed}\uff0c\u811a\u672c\u6ca1\u6709\u8fd4\u56de\u9010\u9879\u9644\u4ef6\u5931\u8d25\u539f\u56e0\u3002`);
    }
    if (report.errorInfo && lines.length < limit) {
      pushLine('错误协议', `${report.errorInfo.code}：${report.errorInfo.userMessage}${report.errorInfo.recovery ? `；${report.errorInfo.recovery}` : ''}`);
    }
    if (lines.length >= limit) {
      lines.push(`还有更多失败项未展示，请打开报告文件查看完整内容：${report.reportFile || report.output || ''}`.trim());
    }
    return lines;
  }

  function statusText(status) {
    const map = {
      running: '\u8fdb\u884c\u4e2d',
      stopping: '\u6b63\u5728\u505c\u6b62',
      interrupted: '\u5df2\u4e2d\u65ad',
      completed: '\u5df2\u5b8c\u6210',
      partial: '\u90e8\u5206\u5b8c\u6210',
      paused: '\u56e0\u98ce\u63a7\u6682\u505c',
      failed: '\u5931\u8d25',
      stopped: '\u5df2\u505c\u6b62'
    };
    return map[status] || status || '\u672a\u77e5';
  }

  function hasResourceWarnings(stats = {}) {
    return maxCount(stats.resourceFailed, stats.imageFailed, stats.attachmentFailed) > 0;
  }

  function taskStatusText(task) {
    return statusText(deriveTaskStatus(task));
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes} 分 ${rest} 秒`;
  }

  function maskArgs(args) {
    const sensitiveKeys = new Set([
      '--password',
      '--password-stdin',
      '--app-secret',
      '--api-key',
      '--client-secret',
      '--token',
      '--cookie'
    ]);
    const masked = [];
    for (let index = 0; index < (args || []).length; index += 1) {
      const value = String(args[index]);
      masked.push(value);
      if (sensitiveKeys.has(value) && index + 1 < args.length) {
        masked.push('***');
        index += 1;
      }
    }
    return masked;
  }

  function createMarkdownTaskReport(task, options = {}) {
    const provider = options.provider || {};
    const maskSensitiveText = options.maskSensitiveText || ((text) => text);
    const normalizedReport = task.report || normalizeTaskReport(task.resultData, {
      errorText: task.error,
      provider: task.providerId,
      mode: task.action
    });
    const failureItems = normalizedReport?.failures || task.stats?.failureItems || [];
    const errorInfo = normalizedReport?.errorInfo || task.errorInfo || null;
    const structuredEvents = (task.logs || [])
      .filter((entry) => entry.event || entry.data)
      .map((entry) => ({
        time: entry.time,
        source: entry.source,
        type: entry.type,
        event: entry.event,
        message: entry.message,
        data: entry.data
      }));
    return maskSensitiveText([
      '# 万能导任务报告',
      '',
      `任务 ID：${task.id}`,
      `平台：${task.providerTitle || provider.title || task.providerId || '-'}`,
      `任务：${task.title || '-'}`,
      `状态：${taskStatusText(task)}`,
      `开始时间：${formatTaskTime(task.startedAt)}`,
      `结束时间：${formatTaskTime(task.finishedAt)}`,
      task.elapsedMs ? `耗时：${formatDuration(task.elapsedMs)}` : '',
      `脚本：${task.script || '-'}`,
      `参数：${JSON.stringify(maskArgs(task.args || []))}`,
      '',
      '## 统计',
      summarizeStats(normalizedReport?.stats || task.stats || {}, task.error),
      normalizedReport?.reportFile ? `报告文件：${normalizedReport.reportFile}` : '',
      normalizedReport?.output ? `输出目录：${normalizedReport.output}` : '',
      '',
      '## 错误',
      task.error || '无',
      errorInfo ? [
        `错误代码：${errorInfo.code || '-'}`,
        `错误分类：${errorInfo.category || '-'}`,
        `用户提示：${errorInfo.userMessage || '-'}`,
        `恢复建议：${errorInfo.recovery || '-'}`,
        `可重试：${errorInfo.retryable ? '是' : '否'}`,
        errorInfo.correlationId ? `关联 ID：${errorInfo.correlationId}` : ''
      ].filter(Boolean).join('\n') : '',
      '',
      '## 失败项',
      failureItems.length ? JSON.stringify(failureItems, null, 2) : '无',
      '',
      '## 资源失败（单独统计）',
      normalizedReport?.resourceFailures?.length ? JSON.stringify(normalizedReport.resourceFailures, null, 2) : '无',
      '',
      '## 结构化事件',
      structuredEvents.length ? JSON.stringify(structuredEvents, null, 2) : '无',
      '',
      '## 结果数据',
      task.resultData ? JSON.stringify(task.resultData, null, 2) : '无',
      '',
      '## 本任务详细日志',
      task.logs?.length ? task.logs.map((entry) => {
        const event = entry.event ? ` [${entry.event}]` : '';
        return `[${formatTaskTime(entry.time)}] [${entry.source}] [${entry.type}]${event} ${entry.message}`;
      }).join('\n') : '无'
    ].filter((line) => line !== '').join('\n'));
  }

  function taskArtifactPaths(task) {
    const report = task.report || normalizeTaskReport(task.resultData, {
      errorText: task.error,
      provider: task.providerId,
      mode: task.action
    });
    return {
      output: firstNonEmpty(report?.output, task.resultData?.output, task.resultData?.outputDir),
      reportFile: firstNonEmpty(report?.reportFile, task.resultData?.reportFile)
    };
  }

  function taskFailurePreview(task, limit = 3) {
    const source = task.report?.raw || task.resultData || task.report || {};
    const lines = collectFailureDiagnostics(source, Math.max(1, limit));
    if (lines.length) return lines.slice(0, limit);
    if (task.error) return [compact(task.error, 260)];
    return [];
  }

  function taskDocumentFailureCount(task) {
    const raw = task?.report?.raw || task?.resultData || {};
    const report = task?.report?.stats
      ? task.report
      : normalizeTaskReport(raw, {
        errorText: task?.error,
        errorInfo: task?.errorInfo,
        provider: task?.providerId,
        mode: task?.action
      });
    const stats = report?.stats || task?.stats || {};
    const listedFailures = Array.isArray(report?.documentFailures)
      ? report.documentFailures.length
      : collectDocumentFailures(raw).length;
    return Math.max(
      Number.isFinite(Number(stats.failed)) ? Number(stats.failed) : 0,
      Number.isFinite(Number(listedFailures)) ? Number(listedFailures) : 0
    );
  }

  function taskResourceFailureCount(task) {
    const raw = task?.report?.raw || task?.resultData || {};
    const report = task?.report?.stats
      ? task.report
      : normalizeTaskReport(raw, {
        errorText: task?.error,
        errorInfo: task?.errorInfo,
        provider: task?.providerId,
        mode: task?.action
      });
    const stats = report?.stats || task?.stats || {};
    const resourceFailures = Number(stats.resourceFailed || 0);
    const typedResourceFailures = Number(stats.imageFailed || 0) + Number(stats.attachmentFailed || 0);
    const listedResourceFailures = Array.isArray(report?.resourceFailures)
      ? report.resourceFailures.length
      : collectResourceFailures(raw).length;
    return Math.max(
      Number.isFinite(resourceFailures) ? resourceFailures : 0,
      Number.isFinite(typedResourceFailures) ? typedResourceFailures : 0,
      Number.isFinite(listedResourceFailures) ? listedResourceFailures : 0
    );
  }

  function taskErrorInfo(task) {
    const report = task?.report || normalizeTaskReport(task?.resultData || {}, {
      errorText: task?.error,
      errorInfo: task?.errorInfo,
      provider: task?.providerId,
      mode: task?.action
    });
    return report?.errorInfo || task?.errorInfo || null;
  }

  function taskFailureCount(task) {
    return taskDocumentFailureCount(task) + taskResourceFailureCount(task);
  }

  function deriveTaskStatus(task = {}, options = {}) {
    const source = task && typeof task === 'object' ? task : {};
    const result = options.result || source.result || null;
    const explicitStatus = String(options.status || source.status || '').toLowerCase();
    const report = source.report?.stats
      ? source.report
      : normalizeTaskReport(source.resultData || source.report || source, {
        errorText: options.errorText || source.error,
        provider: source.providerId,
        mode: source.action
      });
    const stopped = explicitStatus === 'stopped'
      || result?.code === 130
      || result?.data?.stopped === true
      || report?.stopped === true;

    if (stopped) return 'stopped';
    const rateLimitedPaused = explicitStatus === 'paused'
      || result?.data?.rateLimitedPaused === true
      || report?.rateLimitedPaused === true
      || report?.raw?.rateLimitedPaused === true;
    if (rateLimitedPaused) return 'paused';
    if (explicitStatus === 'running' || explicitStatus === 'stopping' || explicitStatus === 'interrupted') {
      return explicitStatus;
    }
    const failureCount = taskFailureCount({ ...source, report });
    const stats = report?.stats || {};
    const completedCount = Math.max(
      Number(stats.success || 0),
      Number(stats.exported || 0),
      Number(stats.imported || 0),
      Number(stats.created || 0) + Number(stats.updated || 0),
      Math.max(0, Number(stats.total || 0) - Number(stats.failed || 0))
    );
    if (options.thrownError || explicitStatus === 'failed' || (result && result.success === false)) {
      if (failureCount > 0 && completedCount > 0) return 'partial';
      return 'failed';
    }
    if (failureCount > 0) return 'partial';
    if (explicitStatus === 'partial') return 'partial';
    if (explicitStatus === 'completed' || result?.success === true) return 'completed';
    return explicitStatus || 'failed';
  }

  const api = {
    normalizeTaskReport,
    summarizeStats,
    collectFailureDiagnostics,
    collectFailureItems,
    describeFailureItem,
    statusText,
    taskStatusText,
    formatDuration,
    maskArgs,
    createMarkdownTaskReport,
    taskArtifactPaths,
    taskFailurePreview,
    collectResourceFailures,
    collectImageFailures,
    collectAttachmentFailures,
    warningCount,
    resourceCounts,
    collectDocumentFailures,
    normalizeErrorInfo,
    taskErrorInfo,
    taskFailureCount,
    taskDocumentFailureCount,
    taskResourceFailureCount,
    deriveTaskStatus
  };

  root.WandaoTaskReport = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
