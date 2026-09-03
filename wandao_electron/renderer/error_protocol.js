(function (root) {
  const ERROR_KIND = 'wandao.error';
  const ERROR_SCHEMA_VERSION = 1;
  const SENSITIVE_KEY = /(cookie|token|secret|password|authorization|signature|access[_-]?key|api[_-]?key)/i;
  // `category` is a stable machine-readable value.  The renderer uses the
  // localized label for people; internal values such as `network` must never
  // appear as a toast title.
  const RULES = [
    { code: 'RESOURCE_DOWNLOAD_FAILED', category: 'resource', categoryLabel: '图片或附件下载失败', userMessage: '图片或附件处理失败', recovery: '正文可能已完成；可以在任务中心单独重试失败资源。', retryable: true, pattern: /图片下载失败|附件下载失败|download.*image|image.*download|tcs-devops\.aliyuncs\.com|cdn\.nlark\.com|图片.*HTTP\s+40[134]|HTTP\s+40[134].*图片|imageFailure|imageFailures|上传附件失败|资源.*(?:失败|错误)|下载失败/i },
    { code: 'REMOTE_NOT_FOUND', category: 'not_found', categoryLabel: '远端内容不存在', userMessage: '目标平台上找不到这个内容', recovery: '链接可能填错、内容已被删除或迁移，也可能当前账号看不到它。请在浏览器打开同一个链接确认后重试。', retryable: false, pattern: /\bHTTP\s*404\b|\bstatus[=:]\s*404\b|(?:页面|内容|文档|笔记|帖子|主题|资源)不存在|文档已删除|已被删除|invalid[^。\n]{0,16}node_token|node_token[^。\n]{0,16}(?:invalid|不存在)|无效的[^。\n]{0,8}链接/i },
    { code: 'LOCAL_FILE_ERROR', category: 'local_file', categoryLabel: '本地文件路径问题', userMessage: '本地文件或目录有问题', recovery: '请检查输入目录、输出目录和文件权限。', retryable: false, pattern: /ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|no such file(?: or directory)?|no such directory|can't open file|file not found|path not found|directory not found|系统找不到|路径不存在|目录不存在|文件不存在|无法找到[^。\n]{0,6}(?:插件|脚本|文件|目录|路径)/i },
    { code: 'COMMAND_TOO_LONG', category: 'input', categoryLabel: '任务参数过长', userMessage: '本次选择内容太多，启动参数超过系统限制', recovery: '请更新到新版后重试；大量文档 ID 会写入临时文件，避免 Windows 命令行长度限制。', retryable: false, pattern: /ENAMETOOLONG|argument list too long|command line.*too long|spawn.*too long/i },
    { code: 'AUTH_REQUIRED', category: 'auth', categoryLabel: '未登录或登录失效', userMessage: '登录状态可能已失效', recovery: '请重新登录，确认浏览器中可以打开目标页面后再重试。', retryable: true, pattern: /未登录|登录失效|登录已失效|登录凭证|没有可用.*凭证|没有可用.*cookie|cookie\s*中缺少|login required|please login|auth file|cookie|cookies|\bHTTP\s*401\b|unauthorized|会话|凭证.*失效/i },
    { code: 'BROWSER_UNAVAILABLE', category: 'browser', categoryLabel: '浏览器自动化启动失败', userMessage: '没有成功连接到可控制的浏览器', recovery: '请在设置中检测并选择 Chrome、Edge 或 Chromium，再重试。', retryable: true, pattern: /Chrome remote debugging port|remote debugging port|DevTools|debug port|\b9222\b|Chrome\/Edge executable was not found|browser executable|WANDAO_BROWSER|找不到.*Chrome|没有找到.*浏览器|浏览器.*调试/i },
    { code: 'NETWORK_ERROR', category: 'network', categoryLabel: '网络连接失败', userMessage: '网络连接失败', recovery: '请检查网络、代理或 DNS 设置后重试。', retryable: true, pattern: /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|connection refused|connection reset|Connection aborted|远程主机强迫关闭|网络连接失败|网络错误/i },
    { code: 'TIMEOUT', category: 'network', categoryLabel: '网络超时', userMessage: '网络请求超时', recovery: '请检查网络或代理设置，等待后重试。', retryable: true, pattern: /ETIMEDOUT|ESOCKETTIMEDOUT|Read timed out|ReadTimeout|ConnectTimeout|timed out|Timeout\s+\d+ms exceeded|TimeoutError|请求超时|超时/i },
    { code: 'DNS_ERROR', category: 'network', categoryLabel: 'DNS 解析失败', userMessage: '域名解析失败', recovery: '请检查网络连接、更换 DNS，或确认链接里的域名拼写正确。', retryable: true, pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo|Name or service not known|NameResolutionError|域名解析/i },
    { code: 'PROXY_OR_TLS_ERROR', category: 'network', categoryLabel: 'HTTPS 证书或代理问题', userMessage: 'HTTPS 证书或代理校验失败', recovery: '请检查代理、抓包工具和安全软件设置，或把目标域名加入直连白名单后重试。', retryable: true, pattern: /SSLError|SSLCertVerificationError|CERTIFICATE_VERIFY_FAILED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self signed certificate|ProxyError|ERR_PROXY|TunnelError|\bHTTP\s*407\b|Proxy Authentication Required/i },
    { code: 'API_PERMISSION_REQUIRED', category: 'permission', categoryLabel: '目标平台 API 权限不足', userMessage: '当前应用还没有拿到这个接口的授权', recovery: '请按页面提示开通所需 API 权限，并在平台开放后台发布应用新版本后重试。', retryable: false, pattern: /required scopes?|scopes? required|missing scopes?|应用身份权限|API 权限|权限申请|tenant_access_token|app ticket|99991672|\b(?:drive|docx|docs|wiki|sheets|base):[a-z_][a-z0-9_.]*(?::[a-z0-9_.]+)?/i },
    { code: 'PERMISSION_DENIED', category: 'permission', categoryLabel: '没有访问权限', userMessage: '当前账号或应用没有访问权限', recovery: '请确认账号能访问目标内容，并开通平台要求的权限。', retryable: false, pattern: /Access denied|permission denied|Forbidden|\bHTTP\s*403\b|无权限|没有权限|权限不足|拒绝访问|not authorized|父节点没有.*权限|\b131006\b/i },
    { code: 'PLATFORM_LIMIT', category: 'limit', categoryLabel: '平台额度或数量限制', userMessage: '目标平台额度或数量已达上限', recovery: '请减少本次数量、换一个可写知识库或等待平台额度恢复后重试。', retryable: false, pattern: /max_doc_note_number|DOC_NOTE_LIMIT|文档数超过限制|数量.*限制|超过.*数量限制|额度.*不足|quota exceeded|limit exceeded/i },
    { code: 'RATE_LIMITED', category: 'rate_limit', categoryLabel: '请求过快或平台限流', userMessage: '请求过于频繁，平台暂时限流', recovery: '请等待一段时间，调大请求间隔后再继续任务。', retryable: true, pattern: /rate limit|Too Many Requests|\bHTTP\s*429\b|请求过快|请求频率|频率过高|限流|rateLimited|too frequent/i },
    { code: 'INVALID_ARGUMENT', category: 'input', categoryLabel: '任务参数不合适', userMessage: '本次任务参数不符合平台要求', recovery: '请减少单批数量或检查高级选项后重试。', retryable: false, pattern: /无效的count|invalid count|code=14001|\b14001\b/i },
    { code: 'PAGE_STRUCTURE_CHANGED', category: 'platform', categoryLabel: '页面结构变化', userMessage: '自动化没有在页面上找到预期的元素', recovery: '平台页面可能改版，请复制错误报告给开发者适配。', retryable: false, pattern: /selector|querySelector|Cannot read properties|页面结构|目录条目|找不到元素|未找到按钮|无法定位|DOM|XPath|element not found/i }
  ];

  const CATEGORY_LABELS = Object.freeze({
    network: '网络问题',
    auth: '未登录或登录失效',
    rate_limit: '请求过快或平台限流',
    permission: '权限问题',
    not_found: '远端内容不存在',
    resource: '图片或附件下载失败',
    browser: '浏览器自动化启动失败',
    local_file: '本地文件路径问题',
    input: '任务参数问题',
    limit: '平台额度或数量限制',
    platform: '平台页面或接口问题',
    unknown: '任务执行失败'
  });

  function text(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function maskText(value) {
    return text(value)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .replace(/(cookie|token|secret|password|authorization|signature|access[_-]?key|api[_-]?key)(["']?\s*[:=]\s*["']?)[^"'\s,&;)]+/gi, '$1$2***');
  }

  function maskDetails(value) {
    if (Array.isArray(value)) return value.map(maskDetails);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '***' : maskDetails(item)
      ]));
    }
    return typeof value === 'string' ? maskText(value) : value;
  }

  function sourceText(value) {
    if (value instanceof Error) return `${value.name || 'Error'}: ${value.message || ''}`;
    if (value && typeof value === 'object') {
      return text(value.technicalMessage || value.message || value.error || value.userMessage || value);
    }
    return text(value);
  }

  function ruleFor(raw) {
    return RULES.find((rule) => rule.pattern.test(raw)) || {
      code: 'UNKNOWN_ERROR',
      category: 'unknown',
      categoryLabel: CATEGORY_LABELS.unknown,
      userMessage: '任务执行失败',
      recovery: '请查看详细日志，确认输入后重试或提交错误报告。',
      retryable: true
    };
  }

  function categoryLabel(value, fallback = '操作失败') {
    const key = text(value).trim();
    if (!key) return fallback;
    if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
    const matched = RULES.find((rule) => rule.category === key || rule.categoryLabel === key);
    return matched?.categoryLabel || key || fallback;
  }

  function correlationId(value) {
    const explicit = text(value).trim();
    if (explicit) return explicit;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeError(value, context = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const nested = source.errorInfo && typeof source.errorInfo === 'object'
      ? source.errorInfo
      : (source.error && typeof source.error === 'object' && source.error.errorInfo ? source.error.errorInfo : null);
    const info = nested || (source.kind === ERROR_KIND ? source : null) || {};
    const raw = sourceText(nested || value);
    const rule = ruleFor(raw);
    const hasExplicitProtocol = info.kind === ERROR_KIND || info.schemaVersion !== undefined;
    const result = {
      kind: ERROR_KIND,
      schemaVersion: ERROR_SCHEMA_VERSION,
      code: text(context.code || info.code || rule.code).trim().toUpperCase().replace(/\s+/g, '_').slice(0, 64) || 'UNKNOWN_ERROR',
      category: text(context.category || info.category || rule.category).trim() || rule.category,
      categoryLabel: text(context.categoryLabel || info.categoryLabel || rule.categoryLabel || categoryLabel(context.category || info.category || rule.category)).trim() || categoryLabel(rule.category),
      userMessage: text(context.userMessage || info.userMessage || rule.userMessage).trim() || rule.userMessage,
      recovery: text(context.recovery || info.recovery || rule.recovery).trim(),
      retryable: context.retryable !== undefined
        ? Boolean(context.retryable)
        : (info.retryable !== undefined ? Boolean(info.retryable) : Boolean(rule.retryable)),
      correlationId: text(context.correlationId || info.correlationId).trim() || correlationId(),
      technicalMessage: maskText(info.technicalMessage || raw || '未知错误'),
      legacyMessage: maskText(source.error && typeof source.error !== 'object' ? source.error : raw || '未知错误'),
      explicit: hasExplicitProtocol
    };
    ['provider', 'operation', 'status'].forEach((key) => {
      const selected = context[key] ?? info[key];
      if (selected !== undefined && selected !== null && text(selected).trim() !== '') result[key] = selected;
    });
    const details = context.details || info.details;
    if (details && typeof details === 'object' && !Array.isArray(details)) result.details = maskDetails(details);
    return result;
  }

  function formatError(value) {
    return normalizeError(value).legacyMessage || normalizeError(value).technicalMessage || '未知错误';
  }

  function userMessage(value) {
    const info = normalizeError(value);
    return info.recovery ? `${info.userMessage}。${info.recovery}` : info.userMessage;
  }

  const api = Object.freeze({
    ERROR_KIND,
    ERROR_SCHEMA_VERSION,
    normalizeError,
    formatError,
    userMessage,
    categoryLabel,
    maskDetails
  });

  root.WandaoErrorProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
