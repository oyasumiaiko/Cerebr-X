/**
 * API 设置和请求处理模块
 * 负责管理 API 配置、UI 渲染以及构建和发送 API 请求
 */

/**
 * 创建 API 管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.apiSettings - API 设置面板元素
 * @param {HTMLElement} options.apiCards - API 卡片容器元素
 * @param {Function} options.closeExclusivePanels - 关闭其他面板的函数
 * @returns {Object} API 管理器实例
 */
import {
  MAX_SYNC_ITEM_BYTES,
  splitStringToByteChunks,
  setChunksToSync,
  getChunksFromSync
} from '../utils/sync_chunk.js';

// 用户消息预处理模板的说明与示例，用于“？”提示与“复制角色块”按钮。
const USER_MESSAGE_TEMPLATE_HELP_TEXT = [
  '模板语法：',
  '- {{input}} / {{text}} / {{message}}：用户输入',
  '- {{datetime}} / {{date}} / {{time}}：时间占位符',
  '- 角色块（直接写在模板中，按出现顺序发送）：',
  '  {{#system}}...{{/system}} / {{#assistant}}...{{/assistant}} / {{#user}}...{{/user}}',
  '  或 {{#message role="assistant"}}...{{/message}}',
  '- 角色块外的文本会在 trim 后作为 user 消息插入到相对位置（空白则忽略）',
  '- 若模板包含任意角色块，则发送时会替换最后一条 user（不发送空白消息）'
].join('\n');
const USER_MESSAGE_TEMPLATE_INJECT_SNIPPET = [
  '{{#system}}',
  '这里是你要置顶的系统指令',
  '{{/system}}',
  '{{#assistant}}',
  '这里是你要“虚拟插入”的 AI 回复',
  '{{/assistant}}',
  '{{#user}}',
  '这里是紧跟其后的用户追问',
  '{{/user}}'
].join('\n');

export function createApiManager(appContext) {
  // 私有状态
  let apiConfigs = [];
  let selectedConfigIndex = 0;
  // 约定：当滑块设置为“无限制”时，使用一个极大值来表示（避免 Infinity 在 JSON 中丢失）
  const MAX_CHAT_HISTORY_UNLIMITED = 2147483647;
  // 用于存储每个配置下次应使用的 API Key 索引 (内存中)
  const apiKeyUsageIndex = {};
  // 本地 key 文件的运行时缓存（仅内存）：避免每次请求都读磁盘。
  // 设计：首次读取后复用；仅在“当前 key 不可用/无可用 key”时触发一次强制重读。
  const apiKeyFileRuntimeCache = new Map();
  // API Key 黑名单（本地持久化），结构为 Map<key, expiresAtMs>
  // 约定：429 时加入黑名单 24 小时；403 与“非 bad request 的 400”写入 -1 表示永久失效
  const BLACKLIST_STORAGE_KEY = 'apiKeyBlacklist';
  let apiKeyBlacklist = {};
  // 拖动排序用的临时状态，避免在拖动过程中频繁写入。
  let draggingCardIndex = null;
  const DELETE_CONFIRM_TIMEOUT_MS = 2600;

  const {
    dom,
    services,
    utils // utils.closeExclusivePanels (which might call uiManager internally)
  } = appContext;

  // Settings manager（用于读取“是否发送 signature”等全局开关）
  const settingsManager = services?.settingsManager;

  const apiSettingsPanel = dom.apiSettingsPanel; // Use renamed dom property
  const apiCardsContainer = dom.apiCardsContainer;
  const closeExclusivePanels = utils.closeExclusivePanels; // Or services.uiManager.closeExclusivePanels if preferred & ready

  // ---- Sync Chunking Helpers ----
  const SYNC_CHUNK_META_KEY = 'apiConfigs_chunks_meta';
  const SYNC_CHUNK_KEY_PREFIX = 'apiConfigs_chunk_';
  let lastMetaUpdatedAt = 0;

  // 本地兜底备份（用于应对 sync 配额/写入失败/分片损坏等情况）
  // 说明：
  // - sync 是“跨设备同步”的主存储，但存在写入频率/容量限制；当多标签页并发写入或触发配额时容易失败；
  // - 过去的实现存在“先删旧分片再写新分片”的窗口期：只要写入失败，就会导致配置直接丢失；
  // - 因此这里额外维护一份 local 备份，保证“最坏情况下也能在本机恢复”。
  const API_CONFIGS_LOCAL_BACKUP_KEY = 'apiConfigs_backup_v1';

  // 保存失败提示节流：避免拖动滑块等高频操作导致 toast 刷屏
  let lastSyncSaveWarningAt = 0;
  const SYNC_SAVE_WARNING_COOLDOWN_MS = 8000;


  function minifyJsonIfPossible(input) {
    if (!input || typeof input !== 'string') return input || '';
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed);
    } catch (_) {
      return input.trim();
    }
  }

  function setSelectedIndexInternal(index) {
    if (!Number.isFinite(index)) return false;
    if (index < 0 || index >= apiConfigs.length) return false;
    selectedConfigIndex = index;
    saveAPIConfigs(); // 保存选中的索引
    renderAPICards(); // 更新卡片选中状态
    renderFavoriteApis(); // 更新收藏列表选中状态
    return true;
  }

  function compactConfigsForSync(configs) {
    return configs.map((c) => {
      const apiKeyFilePath = (typeof c.apiKeyFilePath === 'string') ? c.apiKeyFilePath.trim() : '';
      return {
        id: c.id,
        // 当配置了“本地 key 文件路径”时，不把内联 key 同步到 sync，避免长 key 列表撞配额。
        apiKey: apiKeyFilePath ? '' : c.apiKey,
        apiKeyFilePath,
        baseUrl: c.baseUrl,
        modelName: c.modelName,
        displayName: c.displayName,
        temperature: c.temperature,
        useStreaming: (c.useStreaming !== false),
        isFavorite: !!c.isFavorite,
        // 旧字段：单一条数上限（按“消息条目”计数）。保留以便向后兼容与降级回滚。
        maxChatHistory: c.maxChatHistory ?? 500,
        // 新字段：分别限制历史 user / assistant 消息条数（便于长对话压缩 AI 输出）
        maxChatHistoryUser: c.maxChatHistoryUser ?? null,
        maxChatHistoryAssistant: c.maxChatHistoryAssistant ?? null,
        customParams: minifyJsonIfPossible(c.customParams || ''),
        customSystemPrompt: (c.customSystemPrompt || '').trim(),
        userMessagePreprocessorTemplate: (typeof c.userMessagePreprocessorTemplate === 'string') ? c.userMessagePreprocessorTemplate : '',
        userMessagePreprocessorIncludeInHistory: !!c.userMessagePreprocessorIncludeInHistory
      };
    });
  }

  async function saveConfigsToLocalBackup(configs, selectedIndex, updatedAt) {
    try {
      const index = Number.isFinite(selectedIndex) ? selectedIndex : 0;
      await chrome.storage.local.set({
        [API_CONFIGS_LOCAL_BACKUP_KEY]: {
          v: 1,
          updatedAt: Number(updatedAt) || Date.now(),
          selectedConfigIndex: index,
          items: (Array.isArray(configs) ? configs : []).map(c => ({ ...c }))
        }
      });
      return true;
    } catch (e) {
      console.warn('写入本地 API 配置备份失败（可忽略）:', e);
      return false;
    }
  }

  async function loadConfigsFromLocalBackup() {
    try {
      const wrap = await chrome.storage.local.get([API_CONFIGS_LOCAL_BACKUP_KEY]);
      const backup = wrap?.[API_CONFIGS_LOCAL_BACKUP_KEY];
      if (!backup || backup.v !== 1 || !Array.isArray(backup.items) || backup.items.length <= 0) return null;
      return {
        apiConfigs: backup.items,
        selectedConfigIndex: Number(backup.selectedConfigIndex) || 0,
        updatedAt: Number(backup.updatedAt) || 0
      };
    } catch (e) {
      console.warn('读取本地 API 配置备份失败（可忽略）:', e);
      return null;
    }
  }

  function emitApiConfigsUpdated() {
    // 暴露 apiConfigs 到 window 对象 (向后兼容)
    window.apiConfigs = apiConfigs;
    // 触发配置更新事件：用于同步菜单文本等 UI（跨标签页由 storage.onChanged 驱动后再触发）
    (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));
  }

  // ---- API Key 黑名单相关函数 ----
  // 说明：为降低侵入性，黑名单存储在 chrome.storage.local，结构为 { [key: string]: expiresAtMs }
  async function loadApiKeyBlacklist() {
    try {
      const data = await chrome.storage.local.get([BLACKLIST_STORAGE_KEY]);
      const stored = data[BLACKLIST_STORAGE_KEY] || {};
      const now = Date.now();
      const cleaned = {};
      for (const k in stored) {
        const raw = stored[k];
        const value = Number(raw);
        if (!Number.isFinite(value) && value !== -1) continue;
        if (value === -1) {
          cleaned[k] = -1;
          continue;
        }
        if (value > now) {
          cleaned[k] = value;
        }
      }
      apiKeyBlacklist = cleaned;
      if (Object.keys(stored).length !== Object.keys(cleaned).length) {
        await chrome.storage.local.set({ [BLACKLIST_STORAGE_KEY]: cleaned });
      }
    } catch (e) {
      console.warn('加载 API Key 黑名单失败（忽略）：', e);
      apiKeyBlacklist = {};
    }
  }

  async function saveApiKeyBlacklist() {
    try {
      await chrome.storage.local.set({ [BLACKLIST_STORAGE_KEY]: apiKeyBlacklist });
    } catch (e) {
      console.warn('保存 API Key 黑名单失败（忽略）：', e);
    }
  }

  function isKeyBlacklisted(key) {
    const normalizedKey = (key || '').trim();
    if (!normalizedKey) return false;
    const expRaw = apiKeyBlacklist[normalizedKey];
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) && exp !== -1) return false;
    if (exp === -1) return true;
    if (exp <= Date.now()) {
      // 过期清理（惰性）
      delete apiKeyBlacklist[normalizedKey];
      // 异步落盘但不 await，避免阻塞调用方
      saveApiKeyBlacklist();
      return false;
    }
    return true;
  }

  async function blacklistKey(key, durationMs) {
    const normalizedKey = (key || '').trim();
    if (!normalizedKey) return;
    let expiresAt = -1;
    const durationNumber = Number(durationMs);
    if (Number.isFinite(durationNumber) && durationNumber >= 0) {
      expiresAt = Date.now() + durationNumber;
    } else if (durationNumber === -1) {
      expiresAt = -1;
    } else {
      expiresAt = Date.now();
    }
    apiKeyBlacklist[normalizedKey] = expiresAt;
    await saveApiKeyBlacklist();
  }

  function getNextUsableKeyIndex(config, startIndex, excluded = new Set()) {
    if (!Array.isArray(config.apiKey) || config.apiKey.length === 0) return -1;
    const n = config.apiKey.length;
    let idx = Math.min(Math.max(0, startIndex || 0), n - 1);
    for (let i = 0; i < n; i++) {
      const candidateIndex = (idx + i) % n;
      const candidate = (config.apiKey[candidateIndex] || '').trim();
      if (!candidate) continue;
      if (excluded.has(candidate)) continue;
      if (!isKeyBlacklisted(candidate)) return candidateIndex;
    }
    return -1;
  }

  function normalizeApiKeys(apiKey) {
    // 说明：UI 支持「单 Key」或「逗号分隔的多 Key」两种输入形态。
    // 只有在真正存在多个 Key 时（即拆分后长度 > 1），才启用黑名单筛选/轮换逻辑；
    // 单 Key 场景下即便曾被加入黑名单，也继续尝试发起请求，避免被“永久/临时不可用”状态卡死。
    if (Array.isArray(apiKey)) {
      return apiKey.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
    }
    if (typeof apiKey !== 'string') return [];
    const raw = apiKey.trim();
    if (!raw) return [];
    if (!raw.includes(',')) return [raw];
    return raw.split(',').map(k => k.trim()).filter(Boolean);
  }

  function normalizeApiKeyFilePath(apiKeyFilePath) {
    return (typeof apiKeyFilePath === 'string') ? apiKeyFilePath.trim() : '';
  }

  function getApiKeyFileCacheEntry(config, filePath) {
    const normalizedPath = normalizeApiKeyFilePath(filePath);
    if (!normalizedPath) return null;
    const configId = getConfigIdentifier(config || {});
    const cached = apiKeyFileRuntimeCache.get(configId);
    if (!cached || cached.filePath !== normalizedPath) return null;
    if (!Array.isArray(cached.keys) || cached.keys.length === 0) return null;
    return {
      configId,
      filePath: normalizedPath,
      keys: cached.keys.slice(),
      loadedAt: Number(cached.loadedAt) || 0
    };
  }

  function setApiKeyFileCacheEntry(config, filePath, keys) {
    const normalizedPath = normalizeApiKeyFilePath(filePath);
    if (!normalizedPath || !Array.isArray(keys) || keys.length === 0) return;
    const configId = getConfigIdentifier(config || {});
    apiKeyFileRuntimeCache.set(configId, {
      filePath: normalizedPath,
      keys: keys.slice(),
      loadedAt: Date.now()
    });
  }

  function clearApiKeyFileCacheEntry(config) {
    const configId = getConfigIdentifier(config || {});
    apiKeyFileRuntimeCache.delete(configId);
  }

  // 将用户输入的本地文件路径规范为可 fetch 的 file:// URL。
  // 支持：file://、Windows 盘符路径、UNC 路径、Unix 绝对路径。
  function toLocalFileUrl(rawPath) {
    const normalizedPath = normalizeApiKeyFilePath(rawPath);
    if (!normalizedPath) return '';
    if (/^file:\/\//i.test(normalizedPath)) {
      return normalizedPath;
    }
    if (/^[a-zA-Z]:[\\/]/.test(normalizedPath)) {
      return encodeURI(`file:///${normalizedPath.replace(/\\/g, '/')}`);
    }
    if (normalizedPath.startsWith('\\\\')) {
      const uncPath = normalizedPath.replace(/\\/g, '/');
      return encodeURI(`file:${uncPath}`);
    }
    if (normalizedPath.startsWith('/')) {
      return encodeURI(`file://${normalizedPath}`);
    }
    return '';
  }

  function parseApiKeysFromFileText(rawText) {
    if (typeof rawText !== 'string') return [];
    const lines = rawText.replace(/\uFEFF/g, '').split(/\r?\n/);
    const keys = [];
    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;
      if (!line.includes(',')) {
        keys.push(line);
        continue;
      }
      line.split(',').forEach((part) => {
        const value = part.trim();
        if (value) keys.push(value);
      });
    }
    return Array.from(new Set(keys));
  }

  // 本地 key 文件读取重试参数：
  // - 默认最多尝试 3 次；
  // - 使用指数退避 + 轻微随机抖动，降低瞬时失败（文件尚未写完/短暂权限抖动）带来的误报。
  const LOCAL_KEY_FILE_READ_MAX_ATTEMPTS = 3;
  const LOCAL_KEY_FILE_READ_BASE_DELAY_MS = 120;
  const LOCAL_KEY_FILE_READ_MAX_DELAY_MS = 1200;

  function getLocalKeyFileRetryDelayMs(attemptIndex) {
    const safeIndex = Math.max(0, Number(attemptIndex) || 0);
    const expDelay = LOCAL_KEY_FILE_READ_BASE_DELAY_MS * Math.pow(2, safeIndex);
    const jitterMs = Math.floor(Math.random() * 80);
    return Math.min(LOCAL_KEY_FILE_READ_MAX_DELAY_MS, expDelay + jitterMs);
  }

  function sleepMs(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function loadApiKeysFromLocalFile(apiKeyFilePath) {
    const filePath = normalizeApiKeyFilePath(apiKeyFilePath);
    if (!filePath) return { keys: [], error: 'empty_path', detail: '' };
    const fileUrl = toLocalFileUrl(filePath);
    if (!fileUrl) return { keys: [], error: 'invalid_path', detail: '仅支持绝对路径或 file:// 路径' };
    let lastError = 'read_failed';
    let lastDetail = '';
    const maxAttempts = Math.max(1, LOCAL_KEY_FILE_READ_MAX_ATTEMPTS);

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      try {
        const response = await fetch(fileUrl, { method: 'GET', cache: 'no-store' });
        if (!response.ok) {
          lastError = 'http_error';
          lastDetail = `HTTP ${response.status}`;
        } else {
          const text = await response.text();
          const keys = parseApiKeysFromFileText(text);
          if (keys.length > 0) {
            return { keys, error: '', detail: '', attempts: attemptIndex + 1 };
          }
          lastError = 'empty_file';
          lastDetail = '文件中未找到有效 key（支持每行一个，或逗号分隔）';
        }
      } catch (e) {
        lastError = 'read_failed';
        lastDetail = (e && typeof e.message === 'string') ? e.message : String(e || '未知读取错误');
      }

      const hasNextAttempt = attemptIndex < (maxAttempts - 1);
      if (hasNextAttempt) {
        await sleepMs(getLocalKeyFileRetryDelayMs(attemptIndex));
      }
    }

    const detailWithRetry = lastDetail
      ? `读取失败（已重试 ${maxAttempts} 次）：${lastDetail}`
      : `读取失败（已重试 ${maxAttempts} 次）`;
    return {
      keys: [],
      error: lastError || 'read_failed',
      detail: detailWithRetry,
      attempts: maxAttempts
    };
  }

  async function resolveRuntimeApiKeys(config, emitStatus, options = {}) {
    const forceFileReload = !!options?.forceFileReload;
    const inlineKeys = normalizeApiKeys(config?.apiKey);
    const filePath = normalizeApiKeyFilePath(config?.apiKeyFilePath);
    if (!filePath) {
      return { keys: inlineKeys, source: 'inline', detail: '' };
    }

    const cached = getApiKeyFileCacheEntry(config, filePath);
    if (!forceFileReload && cached?.keys?.length > 0) {
      return { keys: cached.keys, source: 'file_cache', detail: '', attempts: 0 };
    }

    const loaded = await loadApiKeysFromLocalFile(filePath);
    if (loaded.keys.length > 0) {
      setApiKeyFileCacheEntry(config, filePath, loaded.keys);
      emitStatus({
        stage: 'api_key_file_loaded',
        keyCount: loaded.keys.length,
        readAttempts: loaded.attempts || 1,
        loadedFrom: forceFileReload ? 'file_reload' : 'file',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });
      return { keys: loaded.keys, source: forceFileReload ? 'file_reload' : 'file', detail: '' };
    }

    if (cached?.keys?.length > 0) {
      emitStatus({
        stage: 'api_key_file_load_failed',
        willFallback: true,
        fallbackSource: 'file_cache',
        fallbackKeyCount: cached.keys.length,
        readAttempts: loaded.attempts || LOCAL_KEY_FILE_READ_MAX_ATTEMPTS,
        reason: loaded?.detail || loaded?.error || 'unknown',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });
      return {
        keys: cached.keys,
        source: 'file_cache_fallback',
        detail: loaded?.detail || loaded?.error || ''
      };
    }

    const hasFallback = inlineKeys.length > 0;
    emitStatus({
      stage: 'api_key_file_load_failed',
      willFallback: hasFallback,
      fallbackSource: hasFallback ? 'inline' : '',
      fallbackKeyCount: inlineKeys.length,
      readAttempts: loaded.attempts || LOCAL_KEY_FILE_READ_MAX_ATTEMPTS,
      reason: loaded?.detail || loaded?.error || 'unknown',
      apiBase: config?.baseUrl || '',
      modelName: config?.modelName || ''
    });
    if (hasFallback) {
      return {
        keys: inlineKeys,
        source: 'inline_fallback',
        detail: loaded?.detail || loaded?.error || ''
      };
    }
    return {
      keys: [],
      source: 'file',
      detail: loaded?.detail || loaded?.error || '本地 key 文件读取失败'
    };
  }

  // 仅用于识别“请求体/参数错误”的 400。命中后不拉黑 key，避免误伤可用 key。
  // 细化依据：Gemini 后端常见 payload 错误会返回 INVALID_ARGUMENT，并伴随以下文案。
  const BAD_REQUEST_400_HINTS = [
    'contents is not specified',
    'request contains an invalid argument',
    'invalid value at',
    'unknown name',
    'please use a valid role: user, model',
    'generatecontentrequest.contents',
    'invalid_request_error',
    'malformed',
    'parse error',
    'invalid json payload',
    'missing required parameter',
    'cannot find field',
    'unsupported parameter',
    'parameter is required',
    'messages is required'
  ];

  // 一些后端会把鉴权失败也放在 400，需要优先识别，避免被 bad request 关键词误判。
  const AUTH_RELATED_400_HINTS = [
    'api key not valid',
    'key not valid',
    'invalid api key',
    'incorrect api key',
    'api_key_invalid',
    'invalid_api_key',
    'not_authorized',
    'unauthorized',
    'authentication',
    'permission denied',
    'service_disabled',
    'api has not been used'
  ];

  async function isBadRequest400(response) {
    if (!response || response.status !== 400) return false;
    let responseText = '';
    try {
      responseText = await response.clone().text();
    } catch (_) {
      // 无法读取错误体时，保守处理为“非 bad request”，由上层继续走拉黑逻辑。
      return false;
    }

    const baseText = (responseText || '').toLowerCase();
    if (!baseText) return false;

    // 优先解析结构化错误体，避免仅靠字符串匹配导致误判。
    let parsedMessage = '';
    let parsedStatus = '';
    let parsedDetails = '';
    try {
      const parsed = JSON.parse(responseText);
      parsedMessage = String(parsed?.error?.message || '').toLowerCase();
      parsedStatus = String(parsed?.error?.status || '').toLowerCase();
      parsedDetails = JSON.stringify(parsed?.error?.details || '').toLowerCase();
    } catch (_) {
      // 解析失败时退化为纯文本匹配即可。
    }
    const normalized = [baseText, parsedMessage, parsedStatus, parsedDetails].filter(Boolean).join('\n');

    const hasAuthHint = AUTH_RELATED_400_HINTS.some((hint) => normalized.includes(hint));
    if (hasAuthHint) return false;

    const hasBadRequestHint = BAD_REQUEST_400_HINTS.some((hint) => normalized.includes(hint));
    if (!hasBadRequestHint) return false;

    // Gemini 常见 bad request 状态；注意：鉴权失败也可能复用 INVALID_ARGUMENT，
    // 因此必须先过鉴权关键词，再结合 payload 关键词一起判断。
    if (parsedStatus === 'invalid_argument' || parsedStatus === 'bad_request') {
      return true;
    }

    // 兼容其它后端只返回 message 文案、不带结构化 status 的情况。
    return hasBadRequestHint;
  }

  async function saveConfigsToSyncChunked(configs, options = {}) {
    // 重要：不要“先删后写”
    // - chrome.storage.sync 有写入频率限制；高频操作（例如温度滑块拖动）可能触发配额导致 set 失败；
    // - 若先 remove 再 set，一旦 set 失败就会造成配置被清空（你这次遇到的“只剩一个 gpt-4o”就是典型表现）；
    // - 因此改为“直接覆盖写入”，即使失败也不会破坏旧数据；多余的旧分片键最多只会占用一些空间，但不会影响读取。
    const updatedAt = Number(options?.updatedAt) || Date.now();
    const selectedIndexToSync = Number.isFinite(options?.selectedConfigIndex)
      ? options.selectedConfigIndex
      : selectedConfigIndex;
    try {
      const slim = compactConfigsForSync(configs);
      const serialized = JSON.stringify({ v: 1, items: slim });
      const maxBytesPerChunkData = MAX_SYNC_ITEM_BYTES - 1000;
      const chunks = splitStringToByteChunks(serialized, maxBytesPerChunkData);
      if (!chunks || chunks.length <= 0) {
        throw new Error('分片结果为空，拒绝写入 sync（避免写入空配置覆盖旧数据）');
      }

      // 与分片一起写入 selectedConfigIndex，减少一次 sync 写操作（降低触发配额概率）
      await setChunksToSync(SYNC_CHUNK_KEY_PREFIX, chunks, {
        [SYNC_CHUNK_META_KEY]: { count: chunks.length, updatedAt },
        selectedConfigIndex: selectedIndexToSync
      });

      return { ok: true, updatedAt };
    } catch (e) {
      console.warn('保存API配置到 sync 失败：', e);
      return { ok: false, updatedAt };
    }
  }

  async function loadConfigsFromSyncChunked() {
    try {
      const metaWrap = await chrome.storage.sync.get([SYNC_CHUNK_META_KEY]);
      const meta = metaWrap[SYNC_CHUNK_META_KEY];
      const count = Number(meta?.count || 0);
      if (!meta || !Number.isFinite(count) || count <= 0) {
        return { state: 'empty', items: null, meta: null, error: null };
      }

      const serialized = await getChunksFromSync(SYNC_CHUNK_KEY_PREFIX, count);
      if (!serialized) {
        return { state: 'corrupt', items: null, meta, error: new Error('sync serialized 为空') };
      }

      const parsed = JSON.parse(serialized);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
        return { state: 'corrupt', items: null, meta, error: new Error('sync payload 格式不合法') };
      }
      return { state: 'ok', items: parsed.items, meta, error: null };
    } catch (e) {
      console.warn('从 sync 读取API配置失败：', e);
      return { state: 'error', items: null, meta: null, error: e };
    }
  }

  // 为每个 API 配置提供稳定 ID
  function generateUUID() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (_) {}
    const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  }

  /**
   * 加载 API 配置
   * @returns {Promise<void>}
   */
  async function loadAPIConfigs() {
    try {
      // 提前加载黑名单，确保首次请求前可用
      await loadApiKeyBlacklist();
      // 读取顺序统一：sync 分片 → 旧 sync 字段（一次性迁移）
      let result = { apiConfigs: null, selectedConfigIndex: 0 };
      const chunked = await loadConfigsFromSyncChunked();
      if (chunked?.state === 'ok' && Array.isArray(chunked.items) && chunked.items.length > 0) {
        result.apiConfigs = chunked.items;
        const syncSel = await chrome.storage.sync.get(['selectedConfigIndex']);
        result.selectedConfigIndex = syncSel.selectedConfigIndex || 0;
        lastMetaUpdatedAt = Number(chunked?.meta?.updatedAt || Date.now());
      } else if (chunked?.state === 'corrupt' || chunked?.state === 'error') {
        // 云端分片存在但无法读取：优先从本地备份恢复（避免覆盖掉用户真实配置）
        const backup = await loadConfigsFromLocalBackup();
        if (backup?.apiConfigs && backup.apiConfigs.length > 0) {
          result.apiConfigs = backup.apiConfigs;
          result.selectedConfigIndex = backup.selectedConfigIndex || 0;
        } else {
          // 再尝试兼容最老的存储形态（可能是旧版本尚未迁移的情况）
          const syncResult = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
          if (syncResult.apiConfigs && syncResult.apiConfigs.length > 0) {
            result.apiConfigs = syncResult.apiConfigs;
            result.selectedConfigIndex = syncResult.selectedConfigIndex || 0;
          }
        }

        // 提示：不自动写回默认配置，避免“错误读取 => 覆盖清空”的连锁反应
        utils?.showNotification?.({
          type: 'warning',
          message: '云端 API 设置读取失败，已尝试从本地备份恢复',
          description: '建议刷新/关闭其它旧标签页后，再打开 API 设置保存一次以修复云端。'
        });
      } else {
        // 兼容最老的存储形态（仅一次性迁移）
        const syncResult = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
        if (syncResult.apiConfigs && syncResult.apiConfigs.length > 0) {
          result.apiConfigs = syncResult.apiConfigs;
          result.selectedConfigIndex = syncResult.selectedConfigIndex || 0;
          // 迁移到分片并清理旧键
          try {
              const migrated = await saveConfigsToSyncChunked(result.apiConfigs, { selectedConfigIndex: result.selectedConfigIndex || 0 });
              if (migrated?.ok) {
                await chrome.storage.sync.remove(['apiConfigs']);
              }
            } catch (e) {
              console.warn('迁移最老 apiConfigs 到分片失败：', e);
            }
        }
      }

      if (result.apiConfigs && result.apiConfigs.length > 0) {
        apiConfigs = result.apiConfigs.map(config => ({ ...config }));
        selectedConfigIndex = result.selectedConfigIndex || 0;
        selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));

        let needResave = false;
        // 兼容旧格式：如果 apiKey 是带逗号的字符串，则转换为数组；并确保有 id
        apiConfigs.forEach(config => {
          if (!config.id) { config.id = generateUUID(); needResave = true; }
          if (typeof config.apiKeyFilePath !== 'string') {
            config.apiKeyFilePath = '';
            needResave = true;
          } else {
            const trimmedPath = config.apiKeyFilePath.trim();
            if (trimmedPath !== config.apiKeyFilePath) {
              config.apiKeyFilePath = trimmedPath;
              needResave = true;
            }
          }
          if (typeof config.apiKey === 'string' && config.apiKey.includes(',')) {
            // 兼容多 Key：逗号分隔
            config.apiKey = config.apiKey.split(',').map(k => k.trim()).filter(Boolean);
          }
          // 默认开启流式传输（向后兼容）
          if (typeof config.useStreaming === 'undefined') {
            config.useStreaming = true;
            needResave = true;
          }
          if (typeof config.userMessagePreprocessorTemplate !== 'string') {
            config.userMessagePreprocessorTemplate = '';
            needResave = true;
          }
          if (typeof config.userMessagePreprocessorIncludeInHistory !== 'boolean') {
            config.userMessagePreprocessorIncludeInHistory = false;
            needResave = true;
          }
          // 兼容旧版本：将单一 maxChatHistory 迁移为按角色拆分的双上限
          // 设计目标：尽量保持“总条数”接近旧行为（默认按 50%/50% 拆分）
          const hasUserLimit = Number.isFinite(config.maxChatHistoryUser);
          const hasAssistantLimit = Number.isFinite(config.maxChatHistoryAssistant);
          if (!hasUserLimit || !hasAssistantLimit) {
            const legacyMax = Number.isFinite(config.maxChatHistory) ? config.maxChatHistory : 500;
            const legacy = Number(legacyMax);
            const isUnlimited = Number.isFinite(legacy) && legacy >= 500;
            const isDisabled = !Number.isFinite(legacy) ? false : legacy <= 0;

            if (!hasUserLimit || !hasAssistantLimit) {
              if (isUnlimited) {
                if (!hasUserLimit) config.maxChatHistoryUser = MAX_CHAT_HISTORY_UNLIMITED;
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = MAX_CHAT_HISTORY_UNLIMITED;
              } else if (isDisabled) {
                if (!hasUserLimit) config.maxChatHistoryUser = 0;
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = 0;
              } else {
                const clamped = Math.min(499, Math.max(1, Math.floor(legacy)));
                if (!hasUserLimit) config.maxChatHistoryUser = Math.ceil(clamped / 2);
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = Math.floor(clamped / 2);
              }
              needResave = true;
            }
          }
          // 初始化 apiKeyUsageIndex
          if (Array.isArray(config.apiKey) && config.apiKey.length > 0) {
             const configId = getConfigIdentifier(config); // 使用唯一标识符
             // 使用索引表示“当前使用”的 key；成功不轮换，直到遇到429再轮换
             if (typeof apiKeyUsageIndex[configId] !== 'number') {
               apiKeyUsageIndex[configId] = 0;
             }
          }
        });
        if (needResave) { await saveAPIConfigs(); }

        // 将“可用配置快照”写入本地备份，避免 sync 发生异常时无从恢复
        try { await saveConfigsToLocalBackup(apiConfigs, selectedConfigIndex, lastMetaUpdatedAt || Date.now()); } catch (_) {}

      } else {
        // 创建默认配置（仅在确认为“完全没有存储数据”的情况下才写回 sync）
        apiConfigs = [{
          id: generateUUID(),
          apiKey: '', // 初始为空字符串
          apiKeyFilePath: '',
          baseUrl: 'https://api.openai.com/v1/chat/completions',
          modelName: 'gpt-4o',
          displayName: '',
          temperature: 1,
          useStreaming: true,
          isFavorite: false, // 添加收藏状态字段
          customParams: '',
          customSystemPrompt: '',
          userMessagePreprocessorTemplate: '',
          userMessagePreprocessorIncludeInHistory: false,
          maxChatHistory: 500,
          maxChatHistoryUser: 500,
          maxChatHistoryAssistant: 500
        }];
        selectedConfigIndex = 0;
        // 如果云端分片损坏导致读取不到数据，这里不应写回默认值（否则会覆盖掉真实数据）
        // 仅当 sync 分片为空且旧字段也为空时，才写入默认配置作为初始化。
        if (chunked?.state === 'empty') {
          await saveAPIConfigs();
        } else {
          await saveConfigsToLocalBackup(apiConfigs, selectedConfigIndex, Date.now());
        }
      }
    } catch (error) {
      console.error('加载 API 配置失败:', error);
      // 如果加载失败，也创建默认配置
      apiConfigs = [{
        id: generateUUID(),
        apiKey: '',
        apiKeyFilePath: '',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        modelName: 'gpt-4o',
        displayName: '',
        temperature: 1,
        useStreaming: true,
        isFavorite: false,
        customParams: '',
        customSystemPrompt: '',
        userMessagePreprocessorTemplate: '',
        userMessagePreprocessorIncludeInHistory: false,
        maxChatHistory: 500,
        maxChatHistoryUser: 500,
        maxChatHistoryAssistant: 500
      }];
      selectedConfigIndex = 0;
    }

    emitApiConfigsUpdated();

    // 确保一定会渲染卡片和收藏列表
    renderAPICards();
    renderFavoriteApis();
  }

  /**
   * 保存配置到存储
   * @returns {Promise<void>}
   */
  async function saveAPIConfigs() {
    try {
      // 移除临时的 nextApiKeyIndex 状态再保存
      const configsToSave = apiConfigs.map(({ ...config }) => {
        // delete config.nextApiKeyIndex; // 不在 config 对象中保存索引
        return config;
      });

      const updatedAt = Date.now();

      // 先写本地兜底备份：即使后续 sync 写入失败，也能在本机恢复
      await saveConfigsToLocalBackup(configsToSave, selectedConfigIndex, updatedAt);

      // 若检测到 sync 上有更新且当前标签页可能滞后：做一次“保守合并”以避免误覆盖
      // 合并策略：以 sync 为底，按 id 用本地配置覆盖；这样至少不会把其它标签页新加的配置“抹掉”。
      const selectedId = apiConfigs?.[selectedConfigIndex]?.id || null;
      const remote = await loadConfigsFromSyncChunked();
      if (remote?.state === 'ok') {
        const remoteUpdatedAt = Number(remote?.meta?.updatedAt || 0);
        if (remoteUpdatedAt && remoteUpdatedAt > lastMetaUpdatedAt) {
          const localById = new Map(configsToSave.map(c => [c.id, c]));
          const merged = [];
          remote.items.forEach((cfg) => {
            const local = localById.get(cfg.id);
            if (local) {
              merged.push(local);
              localById.delete(cfg.id);
            } else {
              merged.push(cfg);
            }
          });
          localById.forEach((cfg) => merged.push(cfg));

          apiConfigs = merged;
          configsToSave.length = 0;
          merged.forEach(c => configsToSave.push(c));

          if (selectedId) {
            const newIndex = apiConfigs.findIndex(c => c.id === selectedId);
            selectedConfigIndex = (newIndex >= 0) ? newIndex : Math.min(selectedConfigIndex, apiConfigs.length - 1);
          } else {
            selectedConfigIndex = Math.min(selectedConfigIndex, apiConfigs.length - 1);
          }

          // 合并发生意味着当前 UI 很可能不是最新：重渲染以保持一致
          renderAPICards();
          renderFavoriteApis();
        }
      }

      // 同步到 sync（分片以规避单项 8KB），并同步 selectedConfigIndex（同一次 set）
      const syncSave = await saveConfigsToSyncChunked(configsToSave);
      if (syncSave?.ok) {
        lastMetaUpdatedAt = Math.max(lastMetaUpdatedAt, Number(syncSave.updatedAt) || 0);
      } else {
        const now = Date.now();
        if ((now - lastSyncSaveWarningAt) > SYNC_SAVE_WARNING_COOLDOWN_MS) {
          lastSyncSaveWarningAt = now;
          utils?.showNotification?.({
            type: 'warning',
            message: '云端 API 设置同步失败，已写入本地备份',
            description: '可能是 sync 写入配额/网络波动导致；稍后再保存一次即可。'
          });
        }
      }

      // 清理本地遗留的旧 local 缓存（如有），注意不要删除新的备份键
      try { await chrome.storage.local.remove(['apiConfigs', 'selectedConfigIndex']); } catch (_) {}

      emitApiConfigsUpdated();
    } catch (error) {
      console.error('保存 API 配置失败:', error);
    }
  }

  // 跨标签页同步：监听 storage 变更（sync + local）
  function setupStorageSyncListeners() {
    try {
      chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName === 'local') {
          if (changes[BLACKLIST_STORAGE_KEY]) {
            await loadApiKeyBlacklist();
          }
          return;
        }
        if (areaName !== 'sync') return;
        let needReload = false;
        if (changes[SYNC_CHUNK_META_KEY]) {
          const ts = Number(changes[SYNC_CHUNK_META_KEY]?.newValue?.updatedAt || 0);
          if (ts && ts > lastMetaUpdatedAt) {
            lastMetaUpdatedAt = ts;
            needReload = true;
          }
        }
        if (changes['selectedConfigIndex']) {
          selectedConfigIndex = Number(changes['selectedConfigIndex']?.newValue || 0);
          needReload = true;
        }
        Object.keys(changes).forEach((k) => { if (k.startsWith(SYNC_CHUNK_KEY_PREFIX)) needReload = true; });
        if (needReload) {
          const loaded = await loadConfigsFromSyncChunked();
          if (loaded?.state === 'ok' && loaded.items && Array.isArray(loaded.items)) {
            apiConfigs = loaded.items;
            selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));
            // 同步到本地备份，确保“最近一次可用配置”始终存在
            try { await saveConfigsToLocalBackup(apiConfigs, selectedConfigIndex, Number(loaded?.meta?.updatedAt || Date.now())); } catch (_) {}

            renderAPICards();
            renderFavoriteApis();
            emitApiConfigsUpdated();
          }
        }
      });
    } catch (e) {
      console.warn('注册 API 配置跨标签同步失败（忽略）：', e);
    }
  }

  /**
   * 生成配置的唯一标识符
   * @param {Object} config - API 配置对象
   * @returns {string} 唯一标识符
   */
  function getConfigIdentifier(config) {
    // 使用 baseUrl 和 modelName 组合作为唯一标识符
    return `${config.baseUrl}|${config.modelName}`;
  }

  // 将卡片索引安全转为数字，非法值返回 null。
  function parseCardIndex(value) {
    const index = Number.parseInt(value, 10);
    return Number.isFinite(index) ? index : null;
  }

  // 清理拖动高亮与插入指示，避免残留样式干扰后续操作。
  function clearDragOverStyles() {
    if (!apiCardsContainer) return;
    apiCardsContainer.querySelectorAll('.api-card.drag-over, .api-card.drag-insert-before, .api-card.drag-insert-after').forEach((card) => {
      card.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    });
  }

  // 计算拖动落点是在卡片上半区还是下半区，用于显示“插入到哪一侧”。
  function getDropPosition(card, clientY) {
    const rect = card.getBoundingClientRect();
    return clientY > rect.top + rect.height / 2 ? 'after' : 'before';
  }

  // 拖动排序：在数组内移动并同步选中索引，避免选中项错位。
  function moveConfig(fromIndex, toIndex) {
    if (fromIndex === toIndex) return false;
    if (fromIndex < 0 || fromIndex >= apiConfigs.length) return false;

    const [moved] = apiConfigs.splice(fromIndex, 1);
    const insertIndex = Math.max(0, Math.min(toIndex, apiConfigs.length));
    apiConfigs.splice(insertIndex, 0, moved);

    if (selectedConfigIndex === fromIndex) {
      selectedConfigIndex = insertIndex;
    } else if (fromIndex < insertIndex && selectedConfigIndex > fromIndex && selectedConfigIndex <= insertIndex) {
      selectedConfigIndex -= 1;
    } else if (fromIndex > insertIndex && selectedConfigIndex >= insertIndex && selectedConfigIndex < fromIndex) {
      selectedConfigIndex += 1;
    }

    return true;
  }

  /**
   * 渲染 API 卡片
   */
  function renderAPICards() {
    // 确保模板元素在
    const templateCard = document.querySelector('.api-card.template');
    if (!templateCard) {
      console.error('找不到模板卡片元素');
      return;
    }

    // 保存模板的副本
    const templateClone = templateCard.cloneNode(true);

    // 清空现有卡片
    apiCardsContainer.innerHTML = '';

    // 先重新添加模板（保持隐藏状态）
    apiCardsContainer.appendChild(templateClone);

    // 渲染实际的卡
    apiConfigs.forEach((config, index) => {
      const card = createAPICard(config, index, templateClone);
      apiCardsContainer.appendChild(card);
    });
  }

  /**
   * 创建并渲染单个 API 配置卡片
   * @param {Object} config - API 配置对象
   * @param {string | string[]} [config.apiKey] - API 密钥 (可以是单个字符串或字符串数组)
   * @param {string} [config.apiKeyFilePath] - 本地 Key 文件路径（可选，每行一个 key）
   * @param {string} [config.baseUrl] - API 基础 URL
   * @param {string} [config.modelName] - 模型名称
   * @param {number} [config.temperature] - temperature 值（可为 0）
   * @param {boolean} [config.isFavorite] - 是否收藏
   * @param {string} [config.customParams] - 自定义参数
   * @param {string} [config.userMessagePreprocessorTemplate] - 用户消息预处理模板（支持 {{#system}}/{{#assistant}}/{{#user}} 角色块）
   * @param {boolean} [config.userMessagePreprocessorIncludeInHistory] - 预处理结果是否写入历史
   * @param {number} index - 该配置在 apiConfigs 数组中的索引
   * @param {HTMLElement} templateCard - 用于克隆的卡片模板 DOM
   * @returns {HTMLElement} 渲染后的卡片元素
   */
  function createAPICard(config, index, templateCard) {
    // 克隆模板
    const template = templateCard.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';
    template.dataset.index = String(index);

    if (index === selectedConfigIndex) {
      template.classList.add('selected');
    }

    // 设置标题
    const titleElement = template.querySelector('.api-card-title');
    titleElement.textContent = config.displayName || config.modelName || config.baseUrl || '新配置';

    const apiKeyInput = template.querySelector('.api-key');
    const apiKeyFilePathInput = template.querySelector('.api-key-file-path');
    const baseUrlInput = template.querySelector('.base-url');
    const displayNameInput = template.querySelector('.display-name');
    const modelNameInput = template.querySelector('.model-name');
    const temperatureInput = template.querySelector('.temperature');
    const temperatureValue = template.querySelector('.temperature-value');
    const apiForm = template.querySelector('.api-form');
    const favoriteBtn = template.querySelector('.favorite-btn');
    const togglePasswordBtn = template.querySelector('.toggle-password-btn');
    const selectBtn = template.querySelector('.select-btn');
    const customParamsInput = template.querySelector('.custom-params');
    const customSystemPromptInput = template.querySelector('.custom-system-prompt');
    const userMessageTemplateInput = template.querySelector('.user-message-template');
    const userMessageTemplateIncludeHistoryToggle = template.querySelector('.user-message-template-include-history');
    const userMessageTemplateHelpBtn = template.querySelector('.template-help-icon');
    const userMessageTemplateCopyBtn = template.querySelector('.template-inject-copy-btn');

    // 在 temperature 设置后添加“聊天历史裁剪”设置：分别控制 user / AI(assistant) 的历史消息条数
    // 背景：超长对话时，AI 回复往往更长；允许只保留最近 N 条 AI，同时保留更多用户指令上下文。
    const formLeft = apiForm.querySelector('.api-form-left');

    const formatHistoryLimitText = (v, zeroText) => {
      if (v >= 500) return '无限制';
      if (v === 0) return zeroText;
      return `${v}条`;
    };

    const createHistoryLimitSlider = ({
      label,
      zeroText,
      inputClassName,
      getConfigValue,
      setConfigValue
    }) => {
      const group = document.createElement('div');
      group.className = 'form-group';

      const header = document.createElement('div');
      header.className = 'form-group-header';

      const labelEl = document.createElement('label');
      labelEl.textContent = label;

      const valueEl = document.createElement('span');
      valueEl.className = 'temperature-value';

      header.appendChild(labelEl);
      header.appendChild(valueEl);

      const input = document.createElement('input');
      input.type = 'range';
      input.className = `${inputClassName} temperature`;
      input.min = '0';
      input.max = '500';
      input.step = '1';

      // 初始化值与显示：500 => 无限制；0 => 不发送/仅当前；其余按条数显示
      const raw = Number.isFinite(getConfigValue()) ? getConfigValue() : 500;
      const isUnlimited = raw >= 500;
      const clamped = Math.min(499, Math.max(0, isUnlimited ? 499 : raw));
      const uiValue = isUnlimited ? 500 : clamped;
      input.value = String(uiValue);
      valueEl.textContent = formatHistoryLimitText(uiValue, zeroText);

      input.addEventListener('input', () => {
        const v = parseInt(input.value, 10);
        valueEl.textContent = formatHistoryLimitText(v, zeroText);
      });

      input.addEventListener('change', () => {
        const v = parseInt(input.value, 10);
        // 500 代表关闭限制，保存为一个极大值；composeMessages 会按此视为“发送全部”
        setConfigValue((v >= 500) ? MAX_CHAT_HISTORY_UNLIMITED : v);
        saveAPIConfigs();
      });

      group.appendChild(header);
      group.appendChild(input);
      return group;
    };

    const userHistoryGroup = createHistoryLimitSlider({
      label: '历史用户消息',
      zeroText: '仅当前',
      inputClassName: 'max-chat-history-user',
      getConfigValue: () => config.maxChatHistoryUser,
      setConfigValue: (v) => { apiConfigs[index].maxChatHistoryUser = v; }
    });

    const assistantHistoryGroup = createHistoryLimitSlider({
      label: '历史AI消息',
      zeroText: '不发送',
      inputClassName: 'max-chat-history-assistant',
      getConfigValue: () => config.maxChatHistoryAssistant,
      setConfigValue: (v) => { apiConfigs[index].maxChatHistoryAssistant = v; }
    });

    if (formLeft) {
      formLeft.appendChild(userHistoryGroup);
      formLeft.appendChild(assistantHistoryGroup);
    } else {
      apiForm.appendChild(userHistoryGroup);
      apiForm.appendChild(assistantHistoryGroup);
    }

    // 传输模式：流式/非流式 美观开关
    const streamingGroup = document.createElement('div');
    streamingGroup.className = 'form-group';
    const streamingHeader = document.createElement('div');
    streamingHeader.className = 'form-group-header';
    const streamingLabel = document.createElement('label');
    streamingLabel.textContent = '传输模式';
    const streamingHint = document.createElement('span');
    streamingHint.className = 'temperature-value';
    streamingHint.textContent = (config.useStreaming !== false) ? '流式 (SSE)' : '非流式 (JSON)';
    streamingHeader.appendChild(streamingLabel);
    streamingHeader.appendChild(streamingHint);

    const streamingRow = document.createElement('div');
    streamingRow.className = 'switch-row backup-form-row';
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    const streamingToggle = document.createElement('input');
    streamingToggle.type = 'checkbox';
    streamingToggle.id = `use-streaming-${index}`;
    streamingToggle.className = 'use-streaming-toggle';
    streamingToggle.checked = (config.useStreaming !== false);
    streamingToggle.title = '启用流式传输 (SSE)。禁用则使用一次性JSON响应。';
    const slider = document.createElement('span');
    slider.className = 'slider';
    switchLabel.appendChild(streamingToggle);
    switchLabel.appendChild(slider);
    const streamingToggleText = document.createElement('span');
    streamingToggleText.className = 'switch-text';
    streamingToggleText.textContent = streamingToggle.checked ? '启用' : '禁用';
    streamingRow.appendChild(switchLabel);
    streamingRow.appendChild(streamingToggleText);

    streamingToggle.addEventListener('change', () => {
      const enabled = !!streamingToggle.checked;
      streamingToggleText.textContent = enabled ? '启用' : '禁用';
      streamingHint.textContent = enabled ? '流式 (SSE)' : '非流式 (JSON)';
      apiConfigs[index].useStreaming = enabled;
      saveAPIConfigs();
    });

    streamingGroup.appendChild(streamingHeader);
    streamingGroup.appendChild(streamingRow);
    if (formLeft) {
      formLeft.appendChild(streamingGroup);
    } else {
      apiForm.appendChild(streamingGroup);
    }

    // 选择按钮点击事件
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 移除其他卡片的选中状态
      document.querySelectorAll('.api-card').forEach(card => {
        card.classList.remove('selected');
      });
      // 设置当前卡片为选中状态
      template.classList.add('selected');
      setSelectedIndexInternal(index);
      // 关闭面板并回到聊天界面（旧行为：选择后退出设置层）
      if (appContext.services?.chatHistoryUI?.closeChatHistoryPanel) {
        appContext.services.chatHistoryUI.closeChatHistoryPanel();
      } else {
        apiSettingsPanel.classList.remove('visible');
      }
    });

    // 点击卡片只展开/折叠表单
    template.addEventListener('click', () => {
      template.classList.toggle('expanded');
    });

    // 添加密码切换按钮的点击事件监听器
    togglePasswordBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = apiKeyInput.type === 'password' ? 'text' : 'password';
      apiKeyInput.type = type;
      togglePasswordBtn.classList.toggle('visible');
    });

    // 添加点击外部自动隐藏密码的功能
    document.addEventListener('click', (e) => {
      // 如果点击的不是API Key输入框和切换按钮
      if (!apiKeyInput.contains(e.target) && !togglePasswordBtn.contains(e.target)) {
        // 如果当前是显示状态，则切换回密码状态
        if (apiKeyInput.type === 'text') {
          apiKeyInput.type = 'password';
          togglePasswordBtn.classList.remove('visible');
        }
      }
    });

    // 当输入框失去焦点时也隐藏密码
    apiKeyInput.addEventListener('blur', () => {
      if (apiKeyInput.type === 'text') {
        apiKeyInput.type = 'password';
        togglePasswordBtn.classList.remove('visible');
      }
    });

    // --- API Key 显示逻辑 ---
    if (Array.isArray(config.apiKey)) {
      apiKeyInput.value = config.apiKey.join(',');
    } else {
      apiKeyInput.value = config.apiKey ?? '';
    }
    if (apiKeyFilePathInput) {
      apiKeyFilePathInput.value = config.apiKeyFilePath ?? '';
    }
    // ------------------------

    baseUrlInput.value = config.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
    displayNameInput.value = config.displayName ?? '';
    modelNameInput.value = config.modelName ?? 'gpt-4o';
    temperatureInput.value = config.temperature ?? 1;
    temperatureValue.textContent = (config.temperature ?? 1).toFixed(1);
    customParamsInput.value = config.customParams || '';
    if (customSystemPromptInput) {
      customSystemPromptInput.value = config.customSystemPrompt || '';
    }
    if (userMessageTemplateInput) {
      userMessageTemplateInput.value = config.userMessagePreprocessorTemplate || '';
    }
    if (userMessageTemplateIncludeHistoryToggle) {
      userMessageTemplateIncludeHistoryToggle.checked = !!config.userMessagePreprocessorIncludeInHistory;
    }
    if (userMessageTemplateHelpBtn) {
      userMessageTemplateHelpBtn.title = USER_MESSAGE_TEMPLATE_HELP_TEXT;
    }

    // 监听温度变化
    temperatureInput.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      temperatureValue.textContent = value.toFixed(1);
      apiConfigs[index].temperature = value;
    });
    // 说明：input 事件触发频率很高，直接同步到 sync 容易撞到写入配额；
    // 因此改为 change 时再落盘（用户松手/确认时触发），既省配额也更稳定。
    temperatureInput.addEventListener('change', () => saveAPIConfigs());

    // 检查是否已收藏
    if (config.isFavorite) {
      favoriteBtn.classList.add('active');
    }

    // 收藏按钮点击事件
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 直接切换当前配置的收藏状态
      apiConfigs[index].isFavorite = !apiConfigs[index].isFavorite;
      favoriteBtn.classList.toggle('active', apiConfigs[index].isFavorite);
      saveAPIConfigs();
      renderFavoriteApis();
    });

    // 阻止输入框和按钮点击事件冒泡
    const stopPropagation = (e) => e.stopPropagation();
    apiForm.addEventListener('click', stopPropagation);
    template.querySelector('.api-card-actions').addEventListener('click', stopPropagation);

    // 拖动排序：仅允许通过拖动手柄触发，避免干扰表单输入。
    const dragHandle = template.querySelector('.drag-handle');
    if (dragHandle) {
      dragHandle.setAttribute('draggable', 'true');
      dragHandle.addEventListener('click', stopPropagation);
      dragHandle.addEventListener('mousedown', stopPropagation);
      dragHandle.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        draggingCardIndex = index;
        template.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
        }
      });
      dragHandle.addEventListener('dragend', () => {
        draggingCardIndex = null;
        template.classList.remove('dragging');
        clearDragOverStyles();
      });
    }

    template.addEventListener('dragover', (e) => {
      const fromIndex = draggingCardIndex ?? parseCardIndex(e.dataTransfer?.getData('text/plain'));
      const toIndex = parseCardIndex(template.dataset.index);
      if (fromIndex == null || toIndex == null || fromIndex === toIndex) return;
      e.preventDefault();
      clearDragOverStyles();
      // 根据指针所在上下半区显示“插入线”，明确提示将插入到卡片的前或后。
      const dropPosition = getDropPosition(template, e.clientY);
      template.classList.add('drag-over');
      template.classList.toggle('drag-insert-before', dropPosition === 'before');
      template.classList.toggle('drag-insert-after', dropPosition === 'after');
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    });

    template.addEventListener('dragleave', (e) => {
      if (template.contains(e.relatedTarget)) return;
      template.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    });

    template.addEventListener('drop', (e) => {
      e.preventDefault();
      template.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');

      const fromIndex = draggingCardIndex ?? parseCardIndex(e.dataTransfer?.getData('text/plain'));
      const toIndex = parseCardIndex(template.dataset.index);
      if (fromIndex == null || toIndex == null || fromIndex === toIndex) return;

      const insertAfter = getDropPosition(template, e.clientY) === 'after';
      const rawIndex = toIndex + (insertAfter ? 1 : 0);
      const insertIndex = (fromIndex < rawIndex) ? rawIndex - 1 : rawIndex;
      if (insertIndex === fromIndex) return;

      draggingCardIndex = null;
      if (moveConfig(fromIndex, insertIndex)) {
        saveAPIConfigs();
        renderAPICards();
        renderFavoriteApis();
      }
    });

    // --- 输入变化时保存 ---
    [baseUrlInput, displayNameInput, modelNameInput].forEach(input => {
      input.addEventListener('change', () => {
        const previousConfig = { ...apiConfigs[index] };
        apiConfigs[index] = {
          ...apiConfigs[index],
          baseUrl: baseUrlInput.value,
          displayName: displayNameInput.value,
          modelName: modelNameInput.value,
        };
        // baseUrl/modelName 变化会影响缓存键，主动清理避免沿用旧缓存。
        clearApiKeyFileCacheEntry(previousConfig);
        clearApiKeyFileCacheEntry(apiConfigs[index]);
        // 更新标题
        titleElement.textContent = apiConfigs[index].displayName || apiConfigs[index].modelName || apiConfigs[index].baseUrl || '新配置';
        saveAPIConfigs();
      });
    });

    // API Key 输入变化处理
    apiKeyInput.addEventListener('change', () => {
        const rawValue = apiKeyInput.value.trim();
        let newApiKeyValue;
        if (rawValue.includes(',')) {
            newApiKeyValue = rawValue.split(',').map(k => k.trim()).filter(Boolean);
            // 如果解析后只有一个key或没有key，则存为字符串
            if (newApiKeyValue.length <= 1) {
                newApiKeyValue = newApiKeyValue[0] || '';
            }
        } else {
            newApiKeyValue = rawValue;
        }

        apiConfigs[index].apiKey = newApiKeyValue;

        // 更新或初始化轮询索引状态
        const configId = getConfigIdentifier(apiConfigs[index]);
        if (Array.isArray(newApiKeyValue) && newApiKeyValue.length > 0) {
            apiKeyUsageIndex[configId] = 0; // 重置索引
        } else {
            delete apiKeyUsageIndex[configId]; // 删除不再需要的索引
        }

        saveAPIConfigs();
    });

    // API Key 本地文件路径变化处理（每次请求会按该路径实时读取；失败时回退到输入框 key）。
    if (apiKeyFilePathInput) {
      apiKeyFilePathInput.addEventListener('change', () => {
        clearApiKeyFileCacheEntry(apiConfigs[index]);
        apiConfigs[index].apiKeyFilePath = (apiKeyFilePathInput.value || '').trim();
        clearApiKeyFileCacheEntry(apiConfigs[index]);
        saveAPIConfigs();
      });
    }

    // 自定义参数处理
    customParamsInput.addEventListener('change', () => {
      apiConfigs[index].customParams = customParamsInput.value;
      saveAPIConfigs();
    });
    customParamsInput.addEventListener('blur', () => {
      const value = customParamsInput.value.trim();
       const errorElemId = `custom-params-error-${index}`;
       let errorElem = customParamsInput.parentNode.querySelector(`#${errorElemId}`);

      if (value === "") {
        customParamsInput.style.borderColor = "";
        if (errorElem) errorElem.remove();
        apiConfigs[index].customParams = "";
        saveAPIConfigs();
        return;
      }
      try {
        const parsed = JSON.parse(value);
        customParamsInput.value = JSON.stringify(parsed, null, 2);
        apiConfigs[index].customParams = customParamsInput.value;
        if (errorElem) errorElem.remove();
        customParamsInput.style.borderColor = "";
        saveAPIConfigs();
      } catch (e) {
        customParamsInput.style.borderColor = "red";
        if (!errorElem) {
          errorElem = document.createElement("div");
          errorElem.id = errorElemId; // 添加唯一ID
          errorElem.className = "custom-params-error";
          errorElem.style.color = "red";
          errorElem.style.fontSize = "12px";
          errorElem.style.marginTop = "4px";
          customParamsInput.parentNode.appendChild(errorElem);
        }
        errorElem.textContent = "格式化失败：请检查 JSON 格式";
        console.error("自定义参数格式化失败:", e);
      }
    });

    // 自定义提示词处理（不做 JSON 校验，仅保存文本）
    if (customSystemPromptInput) {
      customSystemPromptInput.addEventListener('input', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value;
      });
      customSystemPromptInput.addEventListener('blur', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value || '';
        saveAPIConfigs();
      });
      customSystemPromptInput.addEventListener('change', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value || '';
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateInput) {
      userMessageTemplateInput.addEventListener('input', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value;
      });
      userMessageTemplateInput.addEventListener('blur', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value || '';
        saveAPIConfigs();
      });
      userMessageTemplateInput.addEventListener('change', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value || '';
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateIncludeHistoryToggle) {
      userMessageTemplateIncludeHistoryToggle.addEventListener('change', () => {
        apiConfigs[index].userMessagePreprocessorIncludeInHistory = !!userMessageTemplateIncludeHistoryToggle.checked;
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateCopyBtn) {
      userMessageTemplateCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!navigator?.clipboard?.writeText) {
          utils?.showNotification?.({ message: '当前环境不支持剪贴板复制', type: 'warning', duration: 2200 });
          return;
        }
        try {
          await navigator.clipboard.writeText(USER_MESSAGE_TEMPLATE_INJECT_SNIPPET);
          utils?.showNotification?.({ message: '已复制角色块', type: 'success', duration: 1800 });
        } catch (error) {
          console.error('复制角色块失败:', error);
          utils?.showNotification?.({ message: '复制失败，请重试', type: 'error', duration: 2200 });
        }
      });
    }

    // 自定义 Headers 功能已移除

    // 复制配置
    template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const copied = JSON.parse(JSON.stringify(config));
      copied.id = generateUUID();
      apiConfigs.push(copied);
      const newConfigId = getConfigIdentifier(copied);
      if (Array.isArray(copied.apiKey) && copied.apiKey.length > 0) {
          apiKeyUsageIndex[newConfigId] = 0;
      }
      saveAPIConfigs();
      renderAPICards();
    });

    // 删除配置：需要二次确认，避免误触。
    const deleteButton = template.querySelector('.delete-btn');
    let deleteConfirmTimer = null;
    const resetDeleteConfirm = () => {
      if (!deleteButton) return;
      deleteButton.dataset.confirming = 'false';
      deleteButton.classList.remove('is-confirming');
      template.classList.remove('delete-confirming');
      deleteButton.title = '删除';
      if (deleteConfirmTimer) {
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = null;
      }
    };

    if (deleteButton) {
      deleteButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (apiConfigs.length <= 1) return;

        if (deleteButton.dataset.confirming === 'true') {
          resetDeleteConfirm();

          const deletedConfig = apiConfigs.splice(index, 1)[0];
          // 删除对应的轮询状态
          const deletedConfigId = getConfigIdentifier(deletedConfig);
          delete apiKeyUsageIndex[deletedConfigId];
          clearApiKeyFileCacheEntry(deletedConfig);

          if (selectedConfigIndex >= apiConfigs.length) {
            selectedConfigIndex = apiConfigs.length - 1;
          }
          // 如果删除的是当前选中的，需要更新选中项状态
          if (index === selectedConfigIndex && apiConfigs.length > 0) {
               // 默认选中第一个，或者最后一个如果索引超出
               selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));
          } else if (index < selectedConfigIndex) {
               // 如果删除的是选中项之前的，索引要减一
               selectedConfigIndex--;
          }

          saveAPIConfigs();
          renderAPICards();
          renderFavoriteApis(); // 更新收藏列表状态
          return;
        }

        deleteButton.dataset.confirming = 'true';
        deleteButton.classList.add('is-confirming');
        template.classList.add('delete-confirming');
        deleteButton.title = '再次点击确认删除';
        deleteConfirmTimer = setTimeout(() => {
          resetDeleteConfirm();
        }, DELETE_CONFIRM_TIMEOUT_MS);
      });
    }

    return template;
  }

  /**
   * 渲染收藏的API列表至设置菜单。
   * - 无收藏时隐藏整个收藏区域，保持菜单简洁
   * - 有收藏时显示区域并高亮当前选中项
   * - 点击收藏项后切换当前 API 并关闭设置菜单
   * @since 1.3.0
   */
  function renderFavoriteApis() {
    const favoriteApisSection = document.getElementById('favorite-apis');
    const favoriteApisList = favoriteApisSection ? favoriteApisSection.querySelector('.favorite-apis-list') : null;
    if (!favoriteApisList) return;

    // 过滤出收藏的API
    const favoriteConfigs = apiConfigs.filter(config => config.isFavorite);

    // 无收藏：隐藏区域并清空列表
    if (favoriteConfigs.length === 0) {
      favoriteApisList.innerHTML = '';
      if (favoriteApisSection) favoriteApisSection.style.display = 'none';
      return;
    }

    // 有收藏：展示区域并渲染
    if (favoriteApisSection) favoriteApisSection.style.display = 'block';
    favoriteApisList.innerHTML = '';

    // 获取当前使用的API配置
    const currentConfig = apiConfigs[selectedConfigIndex];

    favoriteConfigs.forEach((config) => {
      const item = document.createElement('div');
      item.className = 'favorite-api-item';

      // 当前使用的API：按 id 对比
      if (currentConfig && currentConfig.id && config.id && currentConfig.id === config.id) {
        item.classList.add('current');
      }

      const apiName = document.createElement('span');
      apiName.className = 'api-name';
      apiName.textContent = config.displayName || config.modelName || config.baseUrl;
      apiName.title = apiName.textContent;

      item.appendChild(apiName);

      // 点击切换到该API配置（不关闭设置菜单）
      item.addEventListener('click', () => {
        // 按 id 查找索引
        const configIndex = apiConfigs.findIndex(c => c.id && c.id === config.id);

        if (configIndex !== -1 && configIndex !== selectedConfigIndex) {
          selectedConfigIndex = configIndex;
          saveAPIConfigs();
          renderAPICards(); // 重新渲染卡片以更新选中状态
          renderFavoriteApis(); // 更新收藏列表状态
        }
      });

      favoriteApisList.appendChild(item);
    });
  }

 /**
  * 辅助函数：将 image_url.url 转换为 Gemini 需要的 inline_data 结构
  * 
  * 设计目标：
  * - 优先支持 dataURL（兼容现有逻辑）
  * - 如果是本地文件链接 file://，在发送前临时读取文件并转为 Base64；
   * - 如果是相对路径（Images/...），结合已保存的下载根目录拼出 file://；
  * - 读取失败时返回 null，由调用方决定是否忽略该图片。
   *
   * 注意：
   * - 这里仅在构造请求体时做一次性转换，不会把 Base64 写入 IndexedDB；
   * - 需要 manifest.json 中包含 "file:///*" host_permissions 才能 fetch 本地文件。
   *
   * @param {string} url - image_url.url 字段值
   * @returns {Promise<{inline_data: { mime_type: string, data: string }}|null>}
   */
  const IMAGE_DOWNLOAD_ROOT_KEY = 'image_download_root';
  function normalizePath(p) {
    return (p || '').replace(/\\/g, '/');
  }

  /**
   * 安全约束：
   * - 扩展在具备读取 `file://` 的能力时，必须限制「仅允许读取 Cerebr/Images 目录下的图片」；
   * - 否则用户消息里夹带任意 `<img src="file://...">` 都可能被读取并转成 Base64 上传到 API，造成隐私泄漏。
   *
   * 说明：
   * - 这里不尝试做“完全可信”的路径校验（浏览器环境也很难做到），而是以最小代价实现明确的白名单：
   *   1) 仅允许 `file://` 且路径包含 `/Cerebr/Images/` 目录段；
   *   2) 仅允许相对路径且以 `Images/` 开头，并且需要已保存的下载根目录指向 Cerebr 目录。
   */
  function hasPathSegment(normalizedPathString, segment) {
    const s = String(normalizedPathString || '');
    const seg = String(segment || '');
    if (!s || !seg) return false;
    const re = new RegExp(`(^|/)${seg}(/|$)`, 'i');
    return re.test(s);
  }

  function isCerebrRootPath(rootPath) {
    const normalized = normalizePath(String(rootPath || ''));
    return hasPathSegment(normalized.toLowerCase(), 'cerebr');
  }

  function normalizeFileUrlForCheck(fileUrl) {
    const raw = String(fileUrl || '');
    if (!raw.startsWith('file://')) return '';
    try {
      // 仅做“尽力而为”的解码：无法解码时保留原串，避免抛异常中断请求构建。
      const decoded = decodeURIComponent(raw);
      return normalizePath(decoded).toLowerCase();
    } catch (_) {
      return normalizePath(raw).toLowerCase();
    }
  }

  function isAllowedCerebrImageFileUrl(fileUrl) {
    const normalized = normalizeFileUrlForCheck(fileUrl);
    if (!normalized) return false;
    // 仅允许 Cerebr/Images 下的内容，避免误读 Cerebr 根目录中的备份/其他文件。
    return /(^|\/)cerebr\/images(\/|$)/i.test(normalized);
  }

  function isAllowedCerebrRelativeImagePath(relPath) {
    const rel = normalizePath(String(relPath || '')).replace(/^\/+/, '');
    if (!rel) return false;
    // 禁止路径穿越，避免通过 Images/../../ 逃逸出白名单目录
    if (/(^|\/)\.\.(\/|$)/.test(rel)) return false;
    return rel.toLowerCase().startsWith('images/');
  }

  async function resolveToFileUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.startsWith('data:') || raw.startsWith('http')) return raw;
    if (raw.startsWith('file://')) {
      return isAllowedCerebrImageFileUrl(raw) ? raw : null;
    }
    // 处理相对路径：Images/...
    const rel = normalizePath(raw).replace(/^\/+/, '');
    if (!isAllowedCerebrRelativeImagePath(rel)) return null;
    try {
      const res = await chrome.storage.local.get([IMAGE_DOWNLOAD_ROOT_KEY]);
      const root = normalizePath(res[IMAGE_DOWNLOAD_ROOT_KEY] || '');
      if (!root || !isCerebrRootPath(root)) return null;
      let full = `${root.replace(/\/+$/, '')}/${rel}`;
      full = normalizePath(full);
      if (/^[A-Za-z]:\//.test(full)) full = '/' + full;
      const fileUrl = `file://${full}`;
      return isAllowedCerebrImageFileUrl(fileUrl) ? fileUrl : null;
    } catch (_) {
      return null;
    }
  }

  async function buildGeminiInlinePartFromImageUrl(url) {
    if (!url) {
      return null;
    }

    try {
      const resolvedUrl = await resolveToFileUrl(url);
      const finalUrl = resolvedUrl || url;

      // 1) 兼容原有 dataURL 格式：data:image/...;base64,XXXX
      if (typeof finalUrl === 'string' && finalUrl.startsWith('data:')) {
        const match = finalUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
        if (!match) {
          console.warn('不支持的 dataURL 图片格式 (Gemini):', finalUrl.substring(0, 48) + '...');
          return null;
        }
        return {
          inline_data: {
            mime_type: match[1],
            data: match[2]
          }
        };
      }

      // 2) 本地文件链接：file:// 开头
      if (typeof finalUrl === 'string' && finalUrl.startsWith('file://')) {
        if (!isAllowedCerebrImageFileUrl(finalUrl)) {
          console.warn('已阻止读取非 Cerebr/Images 目录的本地图片 (Gemini):', finalUrl);
          return null;
        }
        const response = await fetch(finalUrl);
        if (!response.ok) {
          console.warn('读取本地图片失败 (Gemini):', finalUrl, response.status, response.statusText);
          return null;
        }
        const blob = await response.blob();

        // 推断 mimeType：优先使用 blob.type，其次根据扩展名猜测
        let mimeType = (blob.type || '').toLowerCase();
        if (!mimeType || !mimeType.startsWith('image/')) {
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) mimeType = 'image/jpeg';
          else if (lowerUrl.endsWith('.png')) mimeType = 'image/png';
          else if (lowerUrl.endsWith('.gif')) mimeType = 'image/gif';
          else if (lowerUrl.endsWith('.webp')) mimeType = 'image/webp';
          else mimeType = 'image/png';
        }

        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000; // 分片编码，避免参数过长导致栈溢出
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const subarray = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, subarray);
        }
        const base64Data = btoa(binary);

        return {
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        };
      }

      // 3) 其他 URL（http/https 等）暂不自动处理，避免跨域/授权问题
      console.warn('不支持的图片URL格式 (Gemini):', url.substring(0, 64) + '...');
      return null;
    } catch (error) {
      console.error('buildGeminiInlinePartFromImageUrl 失败:', error);
      return null;
    }
  }

  /**
   * 将 image_url 的原始路径转换为 OpenAI 兼容的 dataURL：
   * - data: 开头直接透传；
   * - http/https 原样返回（OpenAI 支持远程地址）；
   * - file:// 或相对路径复用 Gemini 的读取逻辑转为 Base64，避免把本地路径直接塞进请求体。
   * @param {string} rawUrl 原始 image_url.url 或 path
   * @returns {Promise<string|null>} 可发送的 dataURL/http 链接，失败返回 null
   */
  async function normalizeImageUrlForOpenAI(rawUrl) {
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    if (/^https?:\/\//i.test(url)) return url;

    try {
      const inlinePart = await buildGeminiInlinePartFromImageUrl(url);
      if (inlinePart?.inline_data?.mime_type && inlinePart.inline_data.data) {
        return `data:${inlinePart.inline_data.mime_type};base64,${inlinePart.inline_data.data}`;
      }
    } catch (e) {
      console.warn('转换图片为数据URL失败，已跳过问题图片:', e);
    }
    console.warn('无法解析的图片路径，已避免发送 file:// 链接:', url);
    return null;
  }

  function normalizeModelIdForSignatureMatch(value) {
    return (typeof value === 'string') ? value.trim().toLowerCase() : '';
  }

  function detectModelFamily(modelId) {
    const id = normalizeModelIdForSignatureMatch(modelId);
    if (!id) return '';
    if (id.includes('claude')) return 'claude';
    if (id.includes('gemini')) return 'gemini';
    return '';
  }

  /**
   * 判断“某条历史消息上的 signature”是否允许回传到当前请求的模型。
   *
   * 背景（线上报错示例）：
   * - 不同模型/不同供应商的 thought signature 不可互传；
   * - 误回传时上游可能返回 400：Corrupted thought signature / signature required；
   *
   * 规则（按用户诉求做“每条消息单独判断”）：
   * - 若双方模型名都包含 claude，则认为同族，可回传；
   * - 若双方模型名都包含 gemini，则认为同族，可回传；
   * - 其他情况：仅当模型 id 完全一致时才回传；
   * - 若缺少任一侧模型 id，则保守不回传（避免误发触发校验失败）。
   *
   * @param {string|null|undefined} messageModelId 历史消息记录的模型ID（apiModelId）
   * @param {string|null|undefined} currentModelId 当前请求使用的模型ID（config.modelName）
   * @returns {boolean}
   */
  function isSignatureCompatibleWithModel(messageModelId, currentModelId) {
    const msgId = normalizeModelIdForSignatureMatch(messageModelId);
    const curId = normalizeModelIdForSignatureMatch(currentModelId);
    if (!msgId || !curId) return false;

    const msgFamily = detectModelFamily(msgId);
    const curFamily = detectModelFamily(curId);
    if (msgFamily && curFamily) {
      return msgFamily === curFamily;
    }
    return msgId === curId;
  }

  function getShouldSendSignatureSetting() {
    try {
      const value = settingsManager?.getSetting?.('shouldSendSignature');
      if (typeof value === 'boolean') return value;
    } catch (_) {}
    // 默认开启：保持与历史行为兼容（Gemini Thought Signature 以及 OpenAI 兼容签名都可用）
    return true;
  }

  /**
   * 构建 API 请求
   * @param {Object} options - 请求选项
   * @param {Array} options.messages - 消息数组
   * @param {Object} options.config - API 配置
   * @param {Object} [options.overrides] - 覆盖默认设置的参数
   * @returns {Promise<Object>} 请求体对象
   */
  async function buildRequest({ messages, config, overrides = {} }) {
    // 构造请求基本结构
    let requestBody = {};
    // 全局开关：是否发送 signature（无论是否发送，接收端解析到 signature 仍会照常存入历史）
    const shouldSendSignature = getShouldSendSignatureSetting();

    // 复制并规范化消息，按需注入“自定义提示词”至系统提示词最顶端
    //
    // 说明（签名透传）：
    // - Cerebr 内部会在历史节点上保存 `thoughtSignature` 等字段；
    // - Gemini：用于在 Part-level 回传 thought_signature；
    // - OpenAI 兼容：部分代理会要求在 message-level 回传 `thoughtSignature` + `reasoning_content`（以及 tool_calls[i].thoughtSignature），否则可能报 “signature required”；
    // - 因此这里先保留内部字段，后续按 API 类型有条件地注入/过滤。
    let normalizedMessages = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
    const customSystemPrompt = (config.customSystemPrompt || '').trim();
    if (customSystemPrompt) {
      const systemIndex = normalizedMessages.findIndex(m => m && m.role === 'system');
      if (systemIndex >= 0) {
        const current = normalizedMessages[systemIndex];
        const currentContent = typeof current.content === 'string' ? current.content : '';
        normalizedMessages[systemIndex] = {
          ...current,
          content: `${customSystemPrompt}\n${currentContent}`.trim()
        };
      } else {
        normalizedMessages.unshift({ role: 'system', content: customSystemPrompt });
      }
    }

    // 收集 Gemini systemInstruction 的 parts：
    // - 兼容多条 system 消息（例如“API 消息模板”注入的 {{#system}} 块）；
    // - 保持出现顺序，避免只取首条导致后续系统指令丢失。
    const collectGeminiSystemInstructionParts = (messageList) => {
      const parts = [];
      const source = Array.isArray(messageList) ? messageList : [];
      for (const msg of source) {
        if (!msg || msg.role !== 'system') continue;
        const content = msg.content;
        if (typeof content === 'string') {
          if (content.trim()) {
            parts.push({ text: content });
          }
          continue;
        }
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || item.type !== 'text') continue;
            if (typeof item.text !== 'string' || !item.text.trim()) continue;
            parts.push({ text: item.text });
          }
        }
      }
      return parts;
    };

    if (config.baseUrl === 'genai') {
      // Gemini API 请求格式（包含 Gemini 3 思维链签名 Thought Signature 的回传）
      const contents = (await Promise.all(normalizedMessages.map(async (msg) => {
        // Gemini API 使用 'user' 和 'model' 角色
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        // Gemini API 将 'system' 消息作为单独的 systemInstruction
        if (msg.role === 'system') {
          return null; // 在后面单独处理
        }

        const parts = [];
        if (Array.isArray(msg.content)) { // OpenAI Vision 格式 (文本和/或图片)
          for (const item of msg.content) {
            if (item.type === 'text') {
              parts.push({ text: item.text });
            } else if (item.type === 'image_url' && item.image_url) {
              const rawUrl = item.image_url.url || item.image_url.path || '';
              const inlinePart = await buildGeminiInlinePartFromImageUrl(rawUrl);
              if (inlinePart) {
                parts.push(inlinePart);
              }
            }
          }
        } else if (typeof msg.content === 'string') { // 纯文本消息
          parts.push({ text: msg.content });
        } else {
          console.warn('未知的消息内容格式 (Gemini):', msg.content);
        }

        // 如果该消息带有 Gemini 思维链签名，则将签名附加到最后一个 part 上
        // - 只在模型消息（assistant/model）上回传，以符合官方文档建议；
        // - 读取历史消息上记录的 Thought Signature，兼容下划线与驼峰命名；
        // - 重要：若该签名来自 OpenAI 兼容接口（thoughtSignatureSource==='openai'），则不能发给 Gemini。
	        const thoughtSignature =
	          (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) ||
	          (typeof msg.thought_signature === 'string' && msg.thought_signature) ||
	          null;
	        const thoughtSignatureSource = (typeof msg.thoughtSignatureSource === 'string' && msg.thoughtSignatureSource) || null;
	        const canSendGeminiSignature =
	          shouldSendSignature &&
	          (thoughtSignatureSource !== 'openai') &&
	          isSignatureCompatibleWithModel(msg.apiModelId, config?.modelName);
	        if (canSendGeminiSignature && thoughtSignature && parts.length > 0 && (msg.role === 'assistant' || role === 'model')) {
	          const lastPart = parts[parts.length - 1];
	          if (lastPart && typeof lastPart === 'object') {
	            // 文档中非函数调用场景为 Part-level 字段 thought_signature
	            lastPart.thought_signature = thoughtSignature;
            // 同时写入驼峰形式以兼容可能的服务端实现
            lastPart.thoughtSignature = thoughtSignature;
          }
        }
        
        // 只有当 parts 数组不为空时才创建 content 对象
        if (parts.length > 0) {
          return { role: role, parts: parts };
        }
        return null; // 如果没有有效的 parts，则不为此消息创建 content entry
      }))).filter(Boolean); // 过滤掉 null (例如 system 消息或无效消息)

      requestBody = {
        contents: contents,
        generationConfig: {
          responseMimeType: "text/plain",
          temperature: config.temperature ?? 1.0,
          topP: 0.95, // Gemini 使用 topP 而不是 top_p
        },
        ...overrides
      };

      // 处理 system 消息：合并所有 system 内容到 systemInstruction（保序）。
      const systemInstructionParts = collectGeminiSystemInstructionParts(normalizedMessages);
      if (systemInstructionParts.length > 0) {
        requestBody.systemInstruction = {
          // 根据Gemini API文档，systemInstruction是Content类型，其role是可选的 ('user'或'model')
          // 对于系统指令，通常不指定role或留空
          parts: systemInstructionParts
        };
      }
      // 如果存在自定义参数，解析并合并到 generationConfig
      if (config.customParams) {
        try {
          const allCustomParams = JSON.parse(config.customParams);
          const { tools, ...generationCustomParams } = allCustomParams; // 分离 tools 和其他参数

          if (tools && Array.isArray(tools)) {
            requestBody.tools = tools; // 将 tools 添加到请求体的根级别
          }
          
          // 将剩余的自定义参数合并到 generationConfig
          if (Object.keys(generationCustomParams).length > 0) {
            requestBody.generationConfig = { 
              ...requestBody.generationConfig, 
              ...generationCustomParams 
            };
          }
        } catch (e) {
          console.error("解析自定义参数 JSON 失败 (Gemini)，请检查格式。", e);
        }
      }

      // 再次应用 overrides，确保单次请求级别的覆盖（例如宽高比）优先于配置级自定义参数
      if (overrides && typeof overrides === 'object') {
        const originalGenerationConfig = requestBody.generationConfig || {};
        requestBody = { ...requestBody, ...overrides };
        if (overrides.generationConfig) {
          const mergedGenConfig = {
            ...originalGenerationConfig,
            ...overrides.generationConfig
          };
          // 深度合并 imageConfig，避免覆盖用户已配置的分辨率等字段
          if (overrides.generationConfig.imageConfig || originalGenerationConfig.imageConfig) {
            const mergedImageConfig = {
              ...(originalGenerationConfig.imageConfig || {}),
              ...(overrides.generationConfig.imageConfig || {})
            };
            if (!mergedImageConfig.imageSize) {
              mergedImageConfig.imageSize = (originalGenerationConfig.imageConfig && originalGenerationConfig.imageConfig.imageSize) || '4K';
            }
            mergedGenConfig.imageConfig = mergedImageConfig;
          }
          requestBody.generationConfig = mergedGenConfig;
        }
      }

    } else {
	      // 其他 API (如 OpenAI) 请求格式
	      // 仅保留 OpenAI 兼容字段，并将本地/相对图片转回可发送的 dataURL
	      const sanitizedMessages = await Promise.all(normalizedMessages.map(async (msg) => {
	        const base = { role: msg.role };
	        if (msg.name) base.name = msg.name;
	        if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id;

	        // OpenAI 兼容：对每条历史消息单独判断是否允许回传 signature（避免跨模型导致 Corrupted thought signature）
	        // 仅在 thoughtSignatureSource==='openai' 时才考虑回传，避免把 Gemini 的签名/字段发给 OpenAI 接口。
	        const thoughtSignatureSource = (typeof msg.thoughtSignatureSource === 'string' && msg.thoughtSignatureSource) || null;
	        const isAssistant = msg.role === 'assistant';
	        const canSendOpenAISignature =
	          shouldSendSignature &&
	          thoughtSignatureSource === 'openai' &&
	          isAssistant &&
	          isSignatureCompatibleWithModel(msg.apiModelId, config?.modelName);

	        // tool_calls：如果该片段带签名但当前不允许回传，则整个 tool_calls 片段都不发送（遵循“不要回传带签名的 tool 片段”原则）
	        const rawToolCalls = (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ? msg.tool_calls : null;
	        if (rawToolCalls) {
	          const toolCallsHasSignature = rawToolCalls.some((tc) => {
	            if (!tc || typeof tc !== 'object') return false;
	            const ts = (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature) ||
	              (typeof tc.thought_signature === 'string' && tc.thought_signature) ||
	              null;
	            return !!ts;
	          });
	          if (!toolCallsHasSignature) {
	            base.tool_calls = rawToolCalls;
	          } else if (canSendOpenAISignature) {
	            base.tool_calls = rawToolCalls;
	          }
	        }

	        // message-level thoughtSignature（对应 reasoning_content 的签名）
	        if (canSendOpenAISignature) {
	          const thoughtSignature =
	            (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) ||
	            (typeof msg.thought_signature === 'string' && msg.thought_signature) ||
	            null;
	          if (thoughtSignature) {
	            base.thoughtSignature = thoughtSignature;
	            // 注意：reasoning_content 必须与 message-level thoughtSignature 成对回传，否则部分上游会报 “signature required”。
	            // 同时要求“原样回传”，不要做 trim/合并/格式化。
	            if (typeof msg.reasoning_content === 'string') {
	              base.reasoning_content = msg.reasoning_content;
	            } else if (typeof msg.reasoning === 'string') {
	              base.reasoning = msg.reasoning;
	            }
	          }
	        }
	
	        if (Array.isArray(msg.content)) {
	          const parts = [];
	          for (const item of msg.content) {
            if (item.type === 'text') {
              parts.push({ type: 'text', text: item.text });
            } else if (item.type === 'image_url' && item.image_url) {
              const rawUrl = item.image_url.url || item.image_url.path || '';
              const resolvedUrl = await normalizeImageUrlForOpenAI(rawUrl);
              if (resolvedUrl) {
                parts.push({ type: 'image_url', image_url: { url: resolvedUrl } });
              }
            }
          }
          if (parts.length === 0) {
            // 当图片解析失败时提供占位文本，避免发送空消息或携带 file:// 路径
            parts.push({ type: 'text', text: '[图片无法读取]' });
          }
          base.content = parts;
        } else {
          base.content = msg.content;
        }
        return base;
      }));

      requestBody = {
        model: config.modelName,
        messages: sanitizedMessages, // OpenAI API 仅接收标准字段，过滤内部扩展字段
        stream: (config.useStreaming !== false),
        temperature: config.temperature ?? 1.0, // 确保有默认值
        top_p: 0.95,
        ...overrides // 允许覆盖默认参数
      };
      // 如果存在自定义参数，解析并合并
      if (config.customParams) {
        try {
          const extraParams = JSON.parse(config.customParams);
          requestBody = { ...requestBody, ...extraParams };
        } catch (e) {
          console.error("解析自定义参数 JSON 失败，请检查格式。", e);
        }
      }
    }
    return requestBody;
  }

  /**
   * 发送 API 请求
   * @param {Object} options - 请求选项
   * @param {Object} options.requestBody - 请求体
   * @param {Object} options.config - API 配置
   * @param {AbortSignal} [options.signal] - 中止信号
   * @param {(evt: {stage: string, [key: string]: any}) => void} [options.onStatus] - 状态回调（用于 UI 展示更细粒度的请求阶段；不得包含敏感信息）
   * @returns {Promise<Response>} Fetch 响应对象
   * @throws {Error} 如果 API Key 无效或缺失
   */
  async function sendRequest({ requestBody, config, signal, onStatus }) {
    // 说明：Fetch API 无法精确提供“上传进度/已上传完毕”的事件。
    // 这里的阶段回调只基于我们能观测到的关键生命周期节点（开始发起请求/请求已发出/收到响应头/遇到限流切换 Key 等），
    // 用于提升 UI 透明度，但不承诺网络层面的逐字节进度。
    const emitStatus = (evt) => {
      if (typeof onStatus !== 'function') return;
      try { onStatus(evt); } catch (e) { console.warn('sendRequest onStatus 回调异常:', e); }
    };

    const configId = getConfigIdentifier(config);
    // 确保黑名单已加载（若未调用过 loadAPIConfigs）
    if (!apiKeyBlacklist || typeof apiKeyBlacklist !== 'object') {
      try { await loadApiKeyBlacklist(); } catch (_) {}
    }

    // 选择可用的 Key：成功不轮换；429 临时黑名单；bad request 的 400 不拉黑；其余 400/403 永久黑名单
    const tried = new Set();
    let lastErrorResponse = null;
    const hasApiKeyFilePath = !!normalizeApiKeyFilePath(config?.apiKeyFilePath);
    let hasReloadedFileKeys = false;

    // 计算候选 key：
    // - 默认使用输入框中的 apiKey；
    // - 若配置了 apiKeyFilePath，则优先从文件读取；首次成功后走内存缓存；
    // - 仅在“当前 key 不可用/无可用 key”时，才会强制重读文件一次。
    let resolvedKeys = await resolveRuntimeApiKeys(config, emitStatus);
    let keysArray = Array.isArray(resolvedKeys?.keys) ? resolvedKeys.keys : [];
    let isArrayKeys = keysArray.length > 1;
    if (keysArray.length === 0) {
      console.error('API Key 缺失或无效:', { modelName: config?.modelName, baseUrl: config?.baseUrl, source: resolvedKeys?.source });
      const detailText = (typeof resolvedKeys?.detail === 'string' && resolvedKeys.detail.trim())
        ? ` (${resolvedKeys.detail.trim()})`
        : '';
      throw new Error(`API Key for ${config.displayName || config.modelName} is missing or invalid${detailText}.`);
    }

    // 查找当前使用索引（若未设置，默认为 0）
    if (isArrayKeys && typeof apiKeyUsageIndex[configId] !== 'number') {
      apiKeyUsageIndex[configId] = 0;
    }

    const tryReloadKeysFromFileOnce = async (reason = '') => {
      if (!hasApiKeyFilePath || hasReloadedFileKeys) return false;
      hasReloadedFileKeys = true;

      emitStatus({
        stage: 'api_key_file_reload_start',
        reason,
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });

      const refreshed = await resolveRuntimeApiKeys(config, emitStatus, { forceFileReload: true });
      const refreshedKeys = Array.isArray(refreshed?.keys) ? refreshed.keys : [];
      if (refreshedKeys.length === 0) return false;

      resolvedKeys = refreshed;
      keysArray = refreshedKeys;
      isArrayKeys = keysArray.length > 1;
      if (isArrayKeys && typeof apiKeyUsageIndex[configId] !== 'number') {
        apiKeyUsageIndex[configId] = 0;
      } else if (isArrayKeys) {
        apiKeyUsageIndex[configId] = Math.min(Math.max(0, apiKeyUsageIndex[configId] || 0), keysArray.length - 1);
      }
      return true;
    };

    while (true) {
      let selectedIndex = 0;
      let selectedKey = '';
      if (isArrayKeys) {
        // 从当前索引开始，选择第一个不在黑名单且未尝试过的 key
        const startIndex = Math.min(Math.max(0, apiKeyUsageIndex[configId] || 0), keysArray.length - 1);
        const idx = getNextUsableKeyIndex({ apiKey: keysArray }, startIndex, tried);
        if (idx === -1) {
          const reloaded = await tryReloadKeysFromFileOnce('no_usable_key_before_request');
          if (reloaded) {
            continue;
          }
          // 无可用 key
          if (lastErrorResponse) return lastErrorResponse; // 返回最后一次错误响应，让上层按原逻辑处理
          throw new Error('没有可用的 API Key（全部黑名单或被删除）');
        }
        selectedIndex = idx;
        selectedKey = keysArray[selectedIndex] || '';
      } else {
        // 单 key 情况
        selectedIndex = 0;
        selectedKey = keysArray[0];
      }

      if (!selectedKey) {
        if (lastErrorResponse) return lastErrorResponse;
        throw new Error(`Selected API Key for ${config.displayName || config.modelName} is empty.`);
      }

      emitStatus({
        stage: 'api_key_selected',
        keyIndex: selectedIndex,
        keyCount: isArrayKeys ? keysArray.length : 1,
        triedCount: tried.size,
        isKeyRotation: isArrayKeys,
        keySource: resolvedKeys?.source || 'inline',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });

      // 组装请求
      let endpointUrl = config.baseUrl;
      const headers = { 'Content-Type': 'application/json' };
      if (config.baseUrl === 'genai') {
        if (config.useStreaming !== false) {
          endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.modelName}:streamGenerateContent?key=${selectedKey}&alt=sse`;
        } else {
          endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.modelName}:generateContent?key=${selectedKey}`;
        }
      } else {
        headers['Authorization'] = `Bearer ${selectedKey}`;
      }

      emitStatus({
        stage: 'http_request_start',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || '',
        useStreaming: config?.baseUrl === 'genai' ? (config.useStreaming !== false) : !!requestBody?.stream
      });

      // 重要：先创建 fetch Promise 再 emit “已发出请求”，让 UI 可以在等待响应头阶段展示更明确的状态。
      // 这里不向 onStatus 透出 endpointUrl，避免 Gemini 场景下 URL 携带 key 造成泄漏风险。
      const fetchPromise = fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      });

      emitStatus({
        stage: 'http_request_sent',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });

      const response = await fetchPromise;
      emitStatus({
        stage: 'http_response_headers_received',
        status: response?.status,
        ok: response?.ok,
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });

      // 处理 429：加入黑名单并尝试下一个 key
      if (response.status === 429) {
        emitStatus({
          stage: 'http_429_rate_limited',
          willRetry: !!isArrayKeys,
          apiBase: config?.baseUrl || '',
          modelName: config?.modelName || ''
        });
        lastErrorResponse = response;
        try { await blacklistKey(selectedKey, 24 * 60 * 60 * 1000); } catch (_) {}
        tried.add(selectedKey);
        if (isArrayKeys) {
          // 轮换到下一个可用 key（并更新“当前使用”索引）
          const nextIdx = getNextUsableKeyIndex({ apiKey: keysArray }, (selectedIndex + 1) % keysArray.length, tried);
          if (nextIdx === -1) {
            const reloaded = await tryReloadKeysFromFileOnce('rate_limited_no_next_key');
            if (reloaded) {
              continue;
            }
            return response; // 无可用 key，返回 429 响应
          }
          apiKeyUsageIndex[configId] = nextIdx;
          // 循环继续自动重试
          continue;
        }
        // 单 key：仅在使用本地文件 key 时尝试一次重读（便于立即接入新 key），否则按原逻辑返回。
        {
          const reloaded = await tryReloadKeysFromFileOnce('rate_limited_single_key');
          if (reloaded) {
            continue;
          }
        }
        return response;
      }

      // 处理 400：若明确是 bad request（请求体/参数错误），不拉黑 key。
      if (response.status === 400) {
        const badRequest = await isBadRequest400(response);
        if (badRequest) {
          emitStatus({
            stage: 'http_400_bad_request_not_blacklisted',
            status: 400,
            willRetry: false,
            apiBase: config?.baseUrl || '',
            modelName: config?.modelName || ''
          });
          return response;
        }
      }

      // 处理“非 bad request 的 400”与 403：标记 key 永久不可用
      if (response.status === 400 || response.status === 403) {
        emitStatus({
          stage: 'http_auth_or_bad_request_key_blacklisted',
          status: response.status,
          willRetry: !!isArrayKeys,
          apiBase: config?.baseUrl || '',
          modelName: config?.modelName || ''
        });
        lastErrorResponse = response;
        tried.add(selectedKey);
        try { await blacklistKey(selectedKey, -1); } catch (_) {}
        if (isArrayKeys) {
          const nextIdx = getNextUsableKeyIndex({ apiKey: keysArray }, (selectedIndex + 1) % keysArray.length, tried);
          if (nextIdx === -1) {
            const reloaded = await tryReloadKeysFromFileOnce('key_blacklisted_no_next_key');
            if (reloaded) {
              continue;
            }
            return response;
          }
          apiKeyUsageIndex[configId] = nextIdx;
          continue;
        }
        {
          const reloaded = await tryReloadKeysFromFileOnce('key_blacklisted_single_key');
          if (reloaded) {
            continue;
          }
        }
        return response;
      }

      // 其他错误：直接返回给上层处理（不更改轮换状态）
      if (!response.ok) {
        return response;
      }

      // 成功：固定在当前 key（不轮换）。将当前索引保存为“正在使用”的索引
      if (isArrayKeys) {
        apiKeyUsageIndex[configId] = selectedIndex;
      }
      return response;
    }
  }

  /**
   * 设置UI事件处理
   * @param {HTMLElement} apiSettingsToggle - API设置切换按钮
   * @param {HTMLElement} backButton - 返回按钮
   */
  function setupUIEventHandlers(appContextForSetup) {
    const currentAppContext = appContextForSetup || appContext;
    const toggleButton = currentAppContext.dom.apiSettingsToggle;
    const panel = currentAppContext.dom.apiSettingsPanel;
    const backButtonElement = currentAppContext.dom.apiSettingsBackButton;
    const addButton = currentAppContext.dom.apiSettingsAddButton;

    // 显示/隐藏 API 设置（已并入“聊天记录”面板的标签页）
    toggleButton.addEventListener('click', async (e) => {
      e?.stopPropagation?.();

      const chatHistoryUI = currentAppContext.services?.chatHistoryUI;
      const uiManager = currentAppContext.services?.uiManager;
      const targetTab = 'api-settings';

      const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
      const activeTab = chatHistoryUI?.getActiveTabName?.();

      // 行为对齐旧交互：已在该标签页时再次点击则关闭面板，否则跳转到该标签页。
      if (isPanelOpen && activeTab === targetTab) {
        uiManager?.closeExclusivePanels?.();
        return;
      }

      if (!isPanelOpen) {
        uiManager?.closeExclusivePanels?.();
        await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
      } else {
        await chatHistoryUI?.activateTab?.(targetTab);
      }

    });

    // 返回聊天界面
    backButtonElement.addEventListener('click', () => {
      const chatHistoryUI = currentAppContext.services?.chatHistoryUI;
      if (chatHistoryUI?.closeChatHistoryPanel) {
        chatHistoryUI.closeChatHistoryPanel();
      } else {
        panel.classList.remove('visible');
      }
    });

    // 新增按钮：创建空配置，避免依赖克隆。
    if (addButton) {
      addButton.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        addConfig();
      });
    }
  }

  /**
   * 获取模型配置
   * @param {string} [promptType] - 提示词类型
   * @param {Object} promptsConfig - 提示词设置
   * @param {number} [messagesCount] - 当前对话的消息数量 (可选)
   * @returns {Object} 选中的API配置
   */
  function getModelConfig(promptType, promptsConfig, messagesCount) {
    const SHORT_CONVO_DISPLAY_NAME = "[S]"; // 用于短对话的配置标识
    const MEDIUM_CONVO_DISPLAY_NAME = "[M]"; // 用于中等长度对话的配置标识

    // 2. 检查特定提示词类型是否指定了特定模型 (原有逻辑)
    if (promptType && promptsConfig && promptsConfig[promptType]?.model) {
      const preferredValue = String(promptsConfig[promptType].model || '').trim();
      if (preferredValue) {
        // 支持 id 优先；回退 displayName；再回退 modelName
        let config = apiConfigs.find(c => c.id && c.id === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.displayName || '').trim() === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.modelName || '').trim() === preferredValue);
        if (config) {
          console.log(`根据 promptType "${promptType}" 使用配置: ${config.displayName || config.modelName}`);
          return config;
        }
        console.log(`未找到 promptType "${promptType}" 指定的配置 "${preferredValue}"，将使用默认选中配置。`);
      }
    }

    // 1. 检查对话长度并尝试查找特定配置
    if (messagesCount !== undefined) {
      if (messagesCount < 50) {
        const shortConvoConfig = apiConfigs.find(c => c.displayName?.includes(SHORT_CONVO_DISPLAY_NAME));
        if (shortConvoConfig) {
          console.log(`使用短对话配置: ${shortConvoConfig.displayName}`);
          return shortConvoConfig;
        }
        console.log(`未找到displayName包含"${SHORT_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      } else if (messagesCount < 300) {
        const mediumConvoConfig = apiConfigs.find(c => c.displayName?.includes(MEDIUM_CONVO_DISPLAY_NAME));
        if (mediumConvoConfig) {
          console.log(`使用中等长度对话配置: ${mediumConvoConfig.displayName}`);
          return mediumConvoConfig;
        }
        console.log(`未找到displayName包含"${MEDIUM_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      }
    }
    // 3. 如果没有特定模型配置或找不到，使用当前选中的配置 (原有逻辑)
    const selectedConfig = apiConfigs[selectedConfigIndex] || apiConfigs[0]; // 保证总有返回值
    console.log(`使用当前选中配置: ${selectedConfig?.displayName || selectedConfig?.modelName}`);
    return selectedConfig;
  }

  /**
   * 从部分配置信息中获取完整的 API 配置
   * @param {Object} partialConfig - 部分 API 配置信息
   * @param {string} partialConfig.baseUrl - API 基础 URL
   * @param {string} partialConfig.modelName - 模型名称
   * @param {string} [partialConfig.apiKeyFilePath] - 本地 Key 文件路径（可选）
   * @param {number} [partialConfig.temperature] - 温度值
   * @param {string} [partialConfig.customParams] - 自定义参数字符串
   * @param {string} [partialConfig.userMessagePreprocessorTemplate] - 用户消息预处理模板（支持 {{#system}}/{{#assistant}}/{{#user}} 角色块）
   * @param {boolean} [partialConfig.userMessagePreprocessorIncludeInHistory] - 预处理结果是否写入历史
   * @returns {Object|null} 完整的 API 配置对象或 null
   */
  function getApiConfigFromPartial(partialConfig) {
    if (!partialConfig || !partialConfig.baseUrl || !partialConfig.modelName) {
      return null;
    }

    // 尝试按 baseUrl 和 modelName 查找现有配置
    let matchedConfig = apiConfigs.find(config =>
      (partialConfig.id && config.id === partialConfig.id) ||
      (config.baseUrl === partialConfig.baseUrl && config.modelName === partialConfig.modelName)
    );

    // 如果找到完全匹配，返回该配置 (确保包含 apiKey 和轮询状态)
    if (matchedConfig) {
        // 确保返回的对象有 apiKey 和可能的轮询状态
        const configId = getConfigIdentifier(matchedConfig);
        return {
            ...matchedConfig,
            // nextApiKeyIndex: apiKeyUsageIndex[configId] || 0 // 附加轮询状态
        };
    }

    // 如果没有找到完全匹配，尝试仅按 URL 匹配以获取可能的 API Key
    const urlMatchedConfig = apiConfigs.find(config => config.baseUrl === partialConfig.baseUrl);

    // 获取当前选中配置的 apiKey 作为备选
    const currentSelectedConfig = apiConfigs[selectedConfigIndex];
    const fallbackApiKey = currentSelectedConfig ? currentSelectedConfig.apiKey : '';
    const fallbackApiKeyFilePath = currentSelectedConfig ? currentSelectedConfig.apiKeyFilePath : '';

    // 创建新的配置对象
    const newConfig = {
      baseUrl: partialConfig.baseUrl,
      // 优先使用 URL 匹配到的配置的 apiKey，其次是当前选中的，最后是空字符串
      // 注意：这里 apiKey 可能是数组或字符串
      apiKey: urlMatchedConfig?.apiKey || fallbackApiKey || '',
      apiKeyFilePath: urlMatchedConfig?.apiKeyFilePath || fallbackApiKeyFilePath || '',
      modelName: partialConfig.modelName,
      displayName: partialConfig.displayName || '',
      temperature: partialConfig.temperature ?? 1.0,
      customParams: partialConfig.customParams || '',
      customSystemPrompt: partialConfig.customSystemPrompt || '',
      userMessagePreprocessorTemplate: (typeof partialConfig.userMessagePreprocessorTemplate === 'string') ? partialConfig.userMessagePreprocessorTemplate : '',
      userMessagePreprocessorIncludeInHistory: !!partialConfig.userMessagePreprocessorIncludeInHistory,
      maxChatHistory: 500, // 旧字段：保留默认值
      maxChatHistoryUser: 500,
      maxChatHistoryAssistant: 500,
      // isFavorite: false // 新创建的默认不收藏
    };

     // 初始化新配置的轮询状态
    const newConfigId = getConfigIdentifier(newConfig);
    if (Array.isArray(newConfig.apiKey) && newConfig.apiKey.length > 0) {
         apiKeyUsageIndex[newConfigId] = 0;
    }

    return newConfig;
  }

  /**
   * 解析外部传入的 apiParam 为可用的完整 API 配置
   * 支持以下形式：
   * - 字符串：'selected' | 配置 id | displayName | modelName
   * - 对象：
   *   - { id?: string, displayName?: string }
   *   - { favoriteIndex?: number } 选择收藏列表中的第 N 个
   *   - { baseUrl, modelName, ... } 作为部分配置，自动补全为完整配置
   * @param {string|Object|null|undefined} apiParam
   * @returns {Object|null} 匹配/构造的配置，未解析成功返回 null
   */
  function resolveApiParam(apiParam) {
    if (apiParam == null) return apiConfigs[selectedConfigIndex] || apiConfigs[0] || null;

    // 字符串：特殊值或 id/displayName/modelName
    if (typeof apiParam === 'string') {
      const key = apiParam.trim();
      if (key.toLowerCase() === 'selected' || key.toLowerCase() === 'follow_current') {
        return apiConfigs[selectedConfigIndex] || apiConfigs[0] || null;
      }
      let config = apiConfigs.find(c => c.id && c.id === key);
      if (!config) config = apiConfigs.find(c => (c.displayName || '').trim() === key);
      if (!config) config = apiConfigs.find(c => (c.modelName || '').trim() === key);
      return config || null;
    }

    // 对象：优先 id/displayName；favoriteIndex；否则按部分配置补全
    if (typeof apiParam === 'object') {
      if (apiParam.id) {
        const cfg = apiConfigs.find(c => c.id === apiParam.id);
        if (cfg) return cfg;
      }
      if (apiParam.displayName) {
        const cfg = apiConfigs.find(c => (c.displayName || '').trim() === String(apiParam.displayName).trim());
        if (cfg) return cfg;
      }
      if (typeof apiParam.favoriteIndex === 'number') {
        const favorites = apiConfigs.filter(c => c.isFavorite);
        const idx = apiParam.favoriteIndex;
        if (idx >= 0 && idx < favorites.length) return favorites[idx];
        return null;
      }
      // 作为部分配置尝试补全
      return getApiConfigFromPartial(apiParam);
    }

    return null;
  }

  // 新增配置入口：集中处理默认值与持久化，避免各处复制逻辑。
  function addConfig(config = {}) {
    // 确保新配置有必要的字段
    const newConfig = {
      id: generateUUID(),
      apiKey: '',
      apiKeyFilePath: '',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      modelName: 'new-model',
      displayName: '新配置',
      temperature: 1,
      useStreaming: true,
      isFavorite: false,
      customParams: '',
      customSystemPrompt: '',
      userMessagePreprocessorTemplate: '',
      userMessagePreprocessorIncludeInHistory: false,
      maxChatHistory: 500, // 旧字段：保留默认值
      maxChatHistoryUser: 500,
      maxChatHistoryAssistant: 500,
      ...config // 允许传入部分或完整配置覆盖默认值
    };
    // 处理传入的 apiKey 格式
    if (typeof newConfig.apiKey === 'string' && newConfig.apiKey.includes(',')) {
      newConfig.apiKey = newConfig.apiKey.split(',').map(k => k.trim()).filter(Boolean);
    }
    newConfig.apiKeyFilePath = normalizeApiKeyFilePath(newConfig.apiKeyFilePath);
    // 初始化轮询状态
    const newConfigId = getConfigIdentifier(newConfig);
    if (Array.isArray(newConfig.apiKey) && newConfig.apiKey.length > 0) {
      apiKeyUsageIndex[newConfigId] = 0;
    }

    apiConfigs.push(newConfig);
    saveAPIConfigs();
    renderAPICards();
    renderFavoriteApis();
  }

  /**
   * 公共API接口
   */
  return {
    init: loadAPIConfigs,
    loadAPIConfigs,
    saveAPIConfigs,
    renderAPICards,
    renderFavoriteApis,
    buildRequest,
    sendRequest,
    setupUIEventHandlers,
    getModelConfig,
    getApiConfigFromPartial,
    resolveApiParam,

    // 获取和设置配置
    getSelectedConfig: () => {
        const config = apiConfigs[selectedConfigIndex];
        // if (config) {
        //     const configId = getConfigIdentifier(config);
        //     // 返回时附加当前的轮询索引
        //     return { ...config, nextApiKeyIndex: apiKeyUsageIndex[configId] || 0 };
        // }
        return config; // 返回内存中的配置对象
    },
    getAllConfigs: () => [...apiConfigs], // 返回包含轮询状态的配置副本
    getSelectedIndex: () => selectedConfigIndex,
    setSelectedIndex: (index) => setSelectedIndexInternal(index),

    // 添加新配置
    addConfig
  };

  // 启动跨标签页变更监听（在管理器创建时即注册）
  setupStorageSyncListeners();
}
