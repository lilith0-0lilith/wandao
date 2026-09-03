const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const {
  assertSafeRelativePath,
  compareVersions,
  sha256Hex,
  verifyPluginEnvelope,
  verifyRegistryEnvelope
} = require('./plugin_format');

const STATE_SCHEMA_VERSION = 1;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PROTECTED_SOURCE_KINDS = new Set([
  'bundled',
  'bundled-plugin',
  'builtin',
  'builtin-plugin',
  'built-in'
]);

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isLinkOrReparsePoint(target) {
  const stat = lstatOrNull(target);
  // On Windows, directory junctions are reported by lstat as symbolic links;
  // checking lstat instead of stat prevents following a junction out of the
  // managed plugin directory before an operation can validate its boundary.
  return Boolean(stat?.isSymbolicLink());
}

function isPlainDirectory(target) {
  const stat = lstatOrNull(target);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function ensurePlainDirectoryOrMissing(target, label) {
  const stat = lstatOrNull(target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}不得是符号链接、目录联接或重解析点：${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label}不是目录：${target}`);
  return true;
}

function assertPluginId(pluginId) {
  if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`插件 ID 不合法：${pluginId || '(空)'}`);
  }
  return pluginId;
}

function idSet(value) {
  if (value instanceof Set) return new Set(Array.from(value, String));
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === 'object') return new Set(Object.keys(value).filter((key) => value[key]).map(String));
  return new Set();
}

function metadataMarksProtected(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  if (metadata.bundled === true || metadata.builtin === true || metadata.builtIn === true) return true;
  const sourceKind = String(metadata.sourceKind || metadata.source_kind || metadata.source || '').trim().toLowerCase();
  return PROTECTED_SOURCE_KINDS.has(sourceKind);
}

function decodeUninstallTombstoneId(name) {
  const match = String(name || '').match(/^\.uninstall-([0-9a-f]+)-[0-9a-f-]+$/i);
  if (!match || match[1].length % 2 !== 0) return null;
  let pluginId;
  try {
    const bytes = Buffer.from(match[1], 'hex');
    pluginId = bytes.toString('utf8');
    if (Buffer.from(pluginId, 'utf8').toString('hex').toLowerCase() !== match[1].toLowerCase()) return null;
  } catch (_error) {
    return null;
  }
  return PLUGIN_ID_PATTERN.test(pluginId) ? pluginId : null;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function requestBuffer(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('插件下载重定向次数过多'));
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(options.allowLocalHttp && localHttp)) {
      return reject(new Error('插件只允许通过 HTTPS 下载'));
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      headers: { 'User-Agent': options.userAgent || 'Wandao-Plugin-Manager', Accept: 'application/json, application/octet-stream' },
      timeout: options.timeout || 30000
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        return resolve(requestBuffer(new URL(response.headers.location, parsed).toString(), options, redirects + 1));
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(new Error(`插件下载失败 HTTP ${status}`));
      }
      const chunks = [];
      let size = 0;
      const headerSize = Number.parseInt(String(response.headers['content-length'] || ''), 10);
      const totalBytes = Number.isFinite(headerSize) && headerSize >= 0 ? headerSize : 0;
      const reportProgress = (receivedBytes) => {
        if (typeof options.onProgress !== 'function') return;
        try {
          options.onProgress({ receivedBytes, totalBytes });
        } catch (_error) {
          // Progress reporting must never interrupt a verified plugin download.
        }
      };
      reportProgress(0);
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > (options.maxBytes || MAX_DOWNLOAD_BYTES)) {
          request.destroy(new Error('插件下载超过大小限制'));
          return;
        }
        chunks.push(chunk);
        reportProgress(size);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('插件下载超时')));
    request.on('error', reject);
  });
}

class PluginManager {
  constructor(options) {
    if (!options?.rootDir || !options?.trustStore) throw new Error('PluginManager 缺少 rootDir 或 trustStore');
    this.rootDir = path.resolve(options.rootDir);
    this.pluginsDir = path.join(this.rootDir, 'installed');
    this.stateFile = path.join(this.rootDir, 'state.json');
    this.trustStore = options.trustStore;
    this.coreVersion = String(options.coreVersion || '0.0.0');
    this.platform = options.platform || process.platform;
    this.registryUrl = options.registryUrl || '';
    this.allowLocalHttp = Boolean(options.allowLocalHttp);
    this.bundledPluginIds = idSet(options.bundledPluginIds);
    this.builtinPluginIds = idSet(options.builtinPluginIds);
    this.bundledRoot = options.bundledRoot ? path.resolve(options.bundledRoot) : null;
    this.builtinRoot = options.builtinRoot ? path.resolve(options.builtinRoot) : null;
    this.verifiedInstallCache = new Map();
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    ensurePlainDirectoryOrMissing(this.pluginsDir, '插件安装根目录');
    this.recoverOperationDirectories();
  }

  defaultState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, plugins: {}, updatedAt: new Date().toISOString() };
  }

  readState() {
    const state = readJson(this.stateFile, this.defaultState());
    if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION || typeof state.plugins !== 'object') return this.defaultState();
    return state;
  }

  readStateStrict() {
    const stat = lstatOrNull(this.stateFile);
    if (!stat) return this.defaultState();
    if (stat.isSymbolicLink()) throw new Error(`插件状态文件不得是符号链接或重解析点：${this.stateFile}`);
    if (!stat.isFile()) throw new Error(`插件状态文件不是普通文件：${this.stateFile}`);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (error) {
      throw new Error(`插件状态文件已损坏：${error.message}`);
    }
    if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION || !state.plugins || typeof state.plugins !== 'object' || Array.isArray(state.plugins)) {
      throw new Error('插件状态文件的结构或版本无效');
    }
    return state;
  }

  writeState(state) {
    state.schemaVersion = STATE_SCHEMA_VERSION;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.stateFile, state);
  }

  pluginRoot(pluginId) {
    assertPluginId(pluginId);
    const target = path.join(this.pluginsDir, pluginId);
    if (!isInside(this.pluginsDir, target)) throw new Error('插件路径越界');
    return target;
  }

  versionRoot(pluginId, version) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`插件版本不合法：${version || '(空)'}`);
    return path.join(this.pluginRoot(pluginId), version);
  }

  recoverOperationDirectories() {
    if (!isPlainDirectory(this.pluginsDir)) return;
    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const plugin of entries) {
      const pluginDir = path.join(this.pluginsDir, plugin.name);
      if (!plugin.isDirectory() || !isPlainDirectory(pluginDir)) continue;
      for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        const operationDir = path.join(pluginDir, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('.staging-') && isPlainDirectory(operationDir)) {
          fs.rmSync(operationDir, { recursive: true, force: true });
        }
      }
    }

    // If the process stopped after rename() but before the state transaction,
    // keep the tombstone until a trustworthy state file tells us whether the
    // uninstall was committed.  A corrupt state must never cause data loss.
    const state = this.readRecoveryState();
    if (!state) return;
    for (const entry of entries) {
      const tombstone = path.join(this.pluginsDir, entry.name);
      if (!entry.isDirectory() || !isPlainDirectory(tombstone)) continue;
      const pluginId = decodeUninstallTombstoneId(entry.name);
      if (!pluginId) continue;
      const root = this.pluginRoot(pluginId);
      const rootStat = lstatOrNull(root);
      if (rootStat?.isSymbolicLink()) {
        // Do not replace or remove a path that was changed into a link while
        // the app was not running.  Leave the recovery directory for a later
        // explicit repair instead of following an attacker-controlled path.
        continue;
      }
      const stillInstalled = Object.prototype.hasOwnProperty.call(state.plugins, pluginId);
      if (stillInstalled && !rootStat) {
        fs.renameSync(tombstone, root);
      } else {
        fs.rmSync(tombstone, { recursive: true, force: true });
      }
    }
  }

  // Keep the old method name for callers from the first plugin-center build.
  recoverStagingDirectories() {
    return this.recoverOperationDirectories();
  }

  readRecoveryState() {
    const stat = lstatOrNull(this.stateFile);
    if (!stat) return this.defaultState();
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION || !state.plugins || typeof state.plugins !== 'object' || Array.isArray(state.plugins)) {
        return null;
      }
      return state;
    } catch (_error) {
      return null;
    }
  }

  compatibility(manifest) {
    if (manifest.core?.minVersion && compareVersions(this.coreVersion, manifest.core.minVersion) < 0) {
      return { compatible: false, reason: `需要万能导 ${manifest.core.minVersion} 或更高版本` };
    }
    if (manifest.platforms?.length && !manifest.platforms.includes(this.platform)) {
      return { compatible: false, reason: `插件不支持当前系统 ${this.platform}` };
    }
    return { compatible: true, reason: '' };
  }

  async fetchRegistry(url = this.registryUrl) {
    if (!url) throw new Error('尚未配置插件注册表地址');
    const content = await requestBuffer(url, { allowLocalHttp: this.allowLocalHttp, maxBytes: 4 * 1024 * 1024 });
    let registry;
    try {
      registry = JSON.parse(content.toString('utf8'));
    } catch (error) {
      throw new Error(`插件注册表不是有效 JSON：${error.message}`);
    }
    verifyRegistryEnvelope(registry, this.trustStore);
    return registry;
  }

  async installFromRegistry(pluginId, registry = null, options = {}) {
    const index = registry || await this.fetchRegistry();
    const entry = index.plugins.find((item) => item.id === pluginId);
    if (!entry) throw new Error(`插件注册表中没有 ${pluginId}`);
    const buffer = await requestBuffer(entry.packageUrl, {
      allowLocalHttp: this.allowLocalHttp,
      onProgress: options.onProgress
    });
    if (sha256Hex(buffer) !== entry.sha256) throw new Error('插件下载文件的 SHA-256 与注册表不一致');
    return this.installBuffer(buffer, { registryEntry: entry });
  }

  installFile(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('插件包文件不存在');
    return this.installBuffer(fs.readFileSync(resolved), { sourceFile: resolved });
  }

  installBuffer(buffer, source = {}) {
    let envelope;
    try {
      envelope = JSON.parse(Buffer.from(buffer).toString('utf8'));
    } catch (error) {
      throw new Error(`插件包不是有效 JSON：${error.message}`);
    }
    const verified = verifyPluginEnvelope(envelope, this.trustStore);
    const compatibility = this.compatibility(verified.manifest);
    if (!compatibility.compatible) throw new Error(compatibility.reason);
    if (source.registryEntry && (source.registryEntry.id !== verified.manifest.id || source.registryEntry.version !== verified.manifest.version)) {
      throw new Error('插件包身份与注册表不一致');
    }
    const manifest = verified.manifest;
    const pluginDir = this.pluginRoot(manifest.id);
    fs.mkdirSync(pluginDir, { recursive: true });
    const target = this.versionRoot(manifest.id, manifest.version);
    const staging = path.join(pluginDir, `.staging-${manifest.version}-${process.pid}-${Date.now()}`);
    if (fs.existsSync(target)) {
      try {
        this.verifyInstalledVersion(manifest.id, manifest.version, { force: true });
      } catch (_error) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(staging, { recursive: true });
      try {
        for (const [relativePath, content] of verified.files.entries()) {
          const output = path.resolve(staging, ...relativePath.split('/'));
          if (!isInside(staging, output)) throw new Error(`插件文件路径越界：${relativePath}`);
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, content);
        }
        writeJsonAtomic(path.join(staging, 'plugin.json'), manifest);
        writeJsonAtomic(path.join(staging, '.wandao-install.json'), {
          installedAt: new Date().toISOString(),
          integrity: verified.integrity,
          signer: verified.signer,
          signature: envelope.signature,
          filePaths: Array.from(verified.files.keys()).sort(),
          source
        });
        fs.renameSync(staging, target);
      } finally {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      }
    }

    const state = this.readState();
    const previous = state.plugins[manifest.id];
    const previousVersions = Array.from(new Set([
      ...(previous?.previousVersions || []),
      ...(previous?.currentVersion && previous.currentVersion !== manifest.version ? [previous.currentVersion] : [])
    ])).filter((item) => fs.existsSync(this.versionRoot(manifest.id, item)));
    state.plugins[manifest.id] = {
      id: manifest.id,
      enabled: true,
      currentVersion: manifest.version,
      previousVersions: previousVersions.slice(-3),
      channel: source.registryEntry?.channel || previous?.channel || 'local',
      installedAt: previous?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.writeState(state);
    this.verifiedInstallCache.delete(`${manifest.id}@${manifest.version}`);
    this.verifyInstalledVersion(manifest.id, manifest.version, { force: true });
    return this.describeInstalled(manifest.id);
  }

  verifyInstalledVersion(pluginId, version, options = {}) {
    const cacheKey = `${pluginId}@${version}`;
    if (!options.force && this.verifiedInstallCache.has(cacheKey)) return this.verifiedInstallCache.get(cacheKey);
    const root = this.versionRoot(pluginId, version);
    const manifest = readJson(path.join(root, 'plugin.json'));
    const receipt = readJson(path.join(root, '.wandao-install.json'));
    if (!manifest || manifest.id !== pluginId || manifest.version !== version || !receipt?.signature || !Array.isArray(receipt.filePaths)) {
      throw new Error(`插件安装记录无效：${pluginId}@${version}`);
    }
    const files = {};
    const fileHashes = new Map();
    for (const relativePath of receipt.filePaths) {
      const safe = assertSafeRelativePath(relativePath, '已安装插件文件');
      const absolute = path.resolve(root, ...safe.split('/'));
      if (!isInside(root, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        throw new Error(`插件文件缺失：${pluginId}/${safe}`);
      }
      const content = fs.readFileSync(absolute);
      files[safe] = content.toString('base64');
      fileHashes.set(safe, sha256Hex(content));
    }
    const envelope = {
      formatVersion: 1,
      manifest,
      files,
      integrity: { algorithm: 'sha256', value: receipt.integrity },
      signature: receipt.signature
    };
    const verified = verifyPluginEnvelope(envelope, this.trustStore);
    const result = { ...verified, root, fileHashes };
    this.verifiedInstallCache.set(cacheKey, result);
    return result;
  }

  verifyInstalledFile(pluginId, version, relativePath) {
    const verified = this.verifyInstalledVersion(pluginId, version);
    const safe = assertSafeRelativePath(relativePath, '已安装插件文件');
    const expected = verified.fileHashes.get(safe);
    if (!expected) throw new Error(`文件不在已签名插件包中：${safe}`);
    const absolute = path.resolve(verified.root, ...safe.split('/'));
    if (!isInside(verified.root, absolute) || !fs.existsSync(absolute) || sha256Hex(fs.readFileSync(absolute)) !== expected) {
      this.verifiedInstallCache.delete(`${pluginId}@${version}`);
      throw new Error(`插件文件在安装后被修改：${pluginId}/${safe}`);
    }
    return absolute;
  }

  describeInstalled(pluginId) {
    const state = this.readState().plugins[pluginId];
    if (!state) return null;
    const root = this.versionRoot(pluginId, state.currentVersion);
    const manifest = readJson(path.join(root, 'plugin.json'));
    if (!manifest) return null;
    return { ...state, manifest, compatibility: this.compatibility(manifest) };
  }

  listInstalled() {
    const state = this.readState();
    return Object.keys(state.plugins).sort().map((id) => this.describeInstalled(id)).filter(Boolean);
  }

  listWithRegistry(registry = null) {
    const installed = new Map(this.listInstalled().map((item) => [item.id, item]));
    const remote = registry?.plugins || [];
    const merged = remote.map((entry) => {
      const local = installed.get(entry.id);
      installed.delete(entry.id);
      return {
        ...entry,
        installed: Boolean(local),
        enabled: local?.enabled || false,
        installedVersion: local?.currentVersion || '',
        updateAvailable: Boolean(local && compareVersions(entry.version, local.currentVersion) > 0),
        previousVersions: local?.previousVersions || [],
        compatibility: this.compatibility({ core: { minVersion: entry.minCoreVersion }, platforms: entry.platforms })
      };
    });
    installed.forEach((local) => merged.push({
      id: local.id,
      name: local.manifest.name,
      description: local.manifest.description,
      publisher: local.manifest.publisher,
      version: local.currentVersion,
      permissions: local.manifest.permissions || [],
      installed: true,
      enabled: local.enabled,
      installedVersion: local.currentVersion,
      updateAvailable: false,
      previousVersions: local.previousVersions,
      channel: local.channel || 'local',
      compatibility: local.compatibility,
      unavailableFromRegistry: true
    }));
    return merged.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN'));
  }

  setEnabled(pluginId, enabled) {
    const state = this.readState();
    if (!state.plugins[pluginId]) throw new Error(`插件尚未安装：${pluginId}`);
    state.plugins[pluginId].enabled = Boolean(enabled);
    state.plugins[pluginId].updatedAt = new Date().toISOString();
    this.writeState(state);
    return this.describeInstalled(pluginId);
  }

  rollback(pluginId) {
    const state = this.readState();
    const current = state.plugins[pluginId];
    if (!current) throw new Error(`插件尚未安装：${pluginId}`);
    const candidates = (current.previousVersions || []).filter((version) => fs.existsSync(this.versionRoot(pluginId, version)));
    const targetVersion = candidates.pop();
    if (!targetVersion) throw new Error('没有可回滚的插件版本');
    const previousCurrent = current.currentVersion;
    current.currentVersion = targetVersion;
    current.previousVersions = Array.from(new Set([...candidates, previousCurrent])).slice(-3);
    current.enabled = true;
    current.updatedAt = new Date().toISOString();
    this.writeState(state);
    return this.describeInstalled(pluginId);
  }

  readInstalledManifest(filePath) {
    const stat = lstatOrNull(filePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
    return readJson(filePath);
  }

  installedManifests(root, stateEntry) {
    if (!isPlainDirectory(root)) return [];
    const candidates = [];
    if (typeof stateEntry?.currentVersion === 'string' && VERSION_PATTERN.test(stateEntry.currentVersion)) {
      candidates.push(path.join(root, stateEntry.currentVersion, 'plugin.json'));
    }
    candidates.push(path.join(root, 'plugin.json'));
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const versionDir = path.join(root, entry.name);
      if (!entry.isDirectory() || entry.name.startsWith('.') || !isPlainDirectory(versionDir)) continue;
      candidates.push(path.join(versionDir, 'plugin.json'));
    }
    return Array.from(new Set(candidates))
      .map((filePath) => this.readInstalledManifest(filePath))
      .filter(Boolean);
  }

  isProtectedPlugin(pluginId, stateEntry, root) {
    if (this.bundledPluginIds.has(pluginId) || this.builtinPluginIds.has(pluginId)) return true;
    for (const bundledRoot of [this.bundledRoot, this.builtinRoot]) {
      if (bundledRoot && isInside(bundledRoot, root)) return true;
    }
    if (metadataMarksProtected(stateEntry)) return true;
    return this.installedManifests(root, stateEntry).some(metadataMarksProtected);
  }

  clearVerifiedInstallCache(pluginId) {
    Array.from(this.verifiedInstallCache.keys()).forEach((key) => {
      if (key.startsWith(`${pluginId}@`)) this.verifiedInstallCache.delete(key);
    });
  }

  uninstall(pluginId) {
    assertPluginId(pluginId);
    const state = this.readStateStrict();
    const hasStateEntry = Object.prototype.hasOwnProperty.call(state.plugins, pluginId);
    const stateEntry = hasStateEntry ? state.plugins[pluginId] : null;
    const root = this.pluginRoot(pluginId);
    if (!isInside(this.pluginsDir, root)) throw new Error('拒绝删除越界插件目录');
    const rootStat = lstatOrNull(root);
    if (rootStat && (isLinkOrReparsePoint(root) || !rootStat.isDirectory())) {
      throw new Error(`插件目录不得是符号链接、目录联接、重解析点或普通文件：${root}`);
    }
    if (this.isProtectedPlugin(pluginId, stateEntry, root)) {
      throw new Error(`内置或随应用提供的插件不可卸载：${pluginId}`);
    }
    if (!hasStateEntry && !rootStat) return false;

    const tombstone = rootStat ? this.uninstallTombstonePath(pluginId) : null;
    if (tombstone && lstatOrNull(tombstone)) {
      throw new Error(`插件卸载恢复目录已存在，拒绝覆盖：${tombstone}`);
    }
    if (tombstone) {
      fs.renameSync(root, tombstone);
    }

    if (hasStateEntry) {
      delete state.plugins[pluginId];
      try {
        // writeState() is already an atomic replace; keeping the directory in
        // the tombstone until this succeeds makes the two changes recoverable.
        this.writeState(state);
      } catch (error) {
        try {
          if (tombstone && !lstatOrNull(root)) fs.renameSync(tombstone, root);
        } catch (restoreError) {
          throw new Error(`${error.message || error}；恢复插件目录失败：${restoreError.message || restoreError}`);
        }
        throw error;
      }
    }

    if (tombstone) {
      const tombstoneStat = lstatOrNull(tombstone);
      if (tombstoneStat && !isLinkOrReparsePoint(tombstone)) {
        try {
          fs.rmSync(tombstone, { recursive: true, force: true });
        } catch (_error) {
          // The state transaction has already committed.  Leave a normal
          // tombstone for startup recovery instead of reporting a false
          // rollback or touching a path that may have changed concurrently.
        }
      }
    }
    this.clearVerifiedInstallCache(pluginId);
    return true;
  }

  uninstallTombstonePath(pluginId) {
    assertPluginId(pluginId);
    const encodedId = Buffer.from(pluginId, 'utf8').toString('hex');
    const nonce = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const tombstone = path.join(this.pluginsDir, `.uninstall-${encodedId}-${nonce}`);
    if (!isInside(this.pluginsDir, tombstone)) throw new Error('插件卸载恢复目录越界');
    return tombstone;
  }

  activePlugins() {
    return this.listInstalled().filter((item) => item.enabled && item.compatibility.compatible);
  }

  providerEntriesWithErrors() {
    const entries = [];
    const errors = [];
    this.activePlugins().forEach((plugin) => {
      let verified;
      try {
        verified = this.verifyInstalledVersion(plugin.id, plugin.currentVersion, { force: true });
      } catch (error) {
        errors.push(`${plugin.id}@${plugin.currentVersion}：${error.message || String(error)}`);
        return;
      }
      const root = verified.root;
      plugin.manifest.entrypoints.providers.forEach((relativePath) => {
        const safe = assertSafeRelativePath(relativePath, 'Provider 入口');
        const manifestPath = path.resolve(root, ...safe.split('/'));
        if (!isInside(root, manifestPath) || !fs.existsSync(manifestPath)) return;
        entries.push({
          pluginId: plugin.id,
          pluginVersion: plugin.currentVersion,
          pluginRoot: root,
          manifestPath,
          permissions: plugin.manifest.permissions || [],
          uiEntry: plugin.manifest.entrypoints.ui || '',
          verified: true
        });
      });
    });
    return { entries, errors };
  }

  providerEntries() {
    return this.providerEntriesWithErrors().entries;
  }

  resolveScript(pluginId, relativePath) {
    const plugin = this.describeInstalled(pluginId);
    if (!plugin || !plugin.enabled || !plugin.compatibility.compatible) throw new Error(`插件未启用：${pluginId}`);
    if (!(plugin.manifest.permissions || []).includes('process')) throw new Error(`插件没有声明运行进程权限：${pluginId}`);
    const safe = assertSafeRelativePath(relativePath, '插件脚本');
    const root = this.versionRoot(pluginId, plugin.currentVersion);
    const target = this.verifyInstalledFile(pluginId, plugin.currentVersion, safe);
    if (!isInside(root, target) || !fs.existsSync(target) || path.extname(target).toLowerCase() !== '.py') {
      throw new Error(`插件脚本不存在或类型不允许：${relativePath}`);
    }
    return { path: target, plugin, root };
  }

  readUi(pluginId, relativePath) {
    const plugin = this.describeInstalled(pluginId);
    if (!plugin || !plugin.enabled) throw new Error(`插件未启用：${pluginId}`);
    const safe = assertSafeRelativePath(relativePath, '插件 UI');
    const root = this.versionRoot(pluginId, plugin.currentVersion);
    const target = this.verifyInstalledFile(pluginId, plugin.currentVersion, safe);
    if (!isInside(root, target) || !fs.existsSync(target) || path.extname(target).toLowerCase() !== '.html') {
      throw new Error('插件自定义 UI 文件无效');
    }
    const stat = fs.statSync(target);
    if (stat.size > 2 * 1024 * 1024) throw new Error('插件自定义 UI 超过 2 MB 限制');
    return fs.readFileSync(target, 'utf8');
  }
}

module.exports = { PluginManager, isInside, requestBuffer, writeJsonAtomic };
