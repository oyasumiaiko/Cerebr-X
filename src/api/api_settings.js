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
  DEFAULT_CHUNK_SUFFIX,
  getStringByteLength,
  splitStringToByteChunks,
  setChunksToSync,
  getChunksFromSync,
  removeChunksByPrefix
} from '../utils/sync_chunk.js';

export function createApiManager(appContext) {
  // 私有状态
  let apiConfigs = [];
  let selectedConfigIndex = 0;
  // 用于存储每个配置下次应使用的 API Key 索引 (内存中)
  const apiKeyUsageIndex = {};
  // API Key 黑名单（本地持久化），结构为 Map<key, expiresAtMs>
  // 约定：429 时加入黑名单 24 小时；400/403 等不可恢复错误写入 -1 表示永久失效
  const BLACKLIST_STORAGE_KEY = 'apiKeyBlacklist';
  let apiKeyBlacklist = {};

  const {
    dom,
    // services, // services.uiManager can be used for closeExclusivePanels
    utils // utils.closeExclusivePanels (which might call uiManager internally)
  } = appContext;

  const apiSettingsPanel = dom.apiSettingsPanel; // Use renamed dom property
  const apiCardsContainer = dom.apiCardsContainer;
  const closeExclusivePanels = utils.closeExclusivePanels; // Or services.uiManager.closeExclusivePanels if preferred & ready

  // ---- Sync Chunking Helpers ----
  const SYNC_CHUNK_META_KEY = 'apiConfigs_chunks_meta';
  const SYNC_CHUNK_KEY_PREFIX = 'apiConfigs_chunk_';
  let lastMetaUpdatedAt = 0;


  function minifyJsonIfPossible(input) {
    if (!input || typeof input !== 'string') return input || '';
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed);
    } catch (_) {
      return input.trim();
    }
  }

  function compactConfigsForSync(configs) {
    return configs.map(c => ({
      id: c.id,
      apiKey: c.apiKey, // 保留Key用于跨设备直接可用；如担心配额，可改为只保留当前设备
      baseUrl: c.baseUrl,
      modelName: c.modelName,
      displayName: c.displayName,
      temperature: c.temperature,
      useStreaming: (c.useStreaming !== false),
      isFavorite: !!c.isFavorite,
      maxChatHistory: c.maxChatHistory ?? 500,
      customParams: minifyJsonIfPossible(c.customParams || ''),
      customSystemPrompt: (c.customSystemPrompt || '').trim()
    }));
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

  async function saveConfigsToSyncChunked(configs) {
    try {
      const slim = compactConfigsForSync(configs);
      const serialized = JSON.stringify({ v: 1, items: slim });
      // 清理旧分片
      await removeChunksByPrefix(SYNC_CHUNK_KEY_PREFIX);
      // 切分并写入
      const maxBytesPerChunkData = MAX_SYNC_ITEM_BYTES - 1000;
      const chunks = splitStringToByteChunks(serialized, maxBytesPerChunkData);
      await setChunksToSync(SYNC_CHUNK_KEY_PREFIX, chunks, { [SYNC_CHUNK_META_KEY]: { count: chunks.length, updatedAt: Date.now() } });
      return true;
    } catch (e) {
      console.warn('保存API配置到 sync 失败：', e);
      return false;
    }
  }

  async function loadConfigsFromSyncChunked() {
    try {
      const metaWrap = await chrome.storage.sync.get([SYNC_CHUNK_META_KEY]);
      const meta = metaWrap[SYNC_CHUNK_META_KEY];
      if (!meta || !meta.count || meta.count <= 0) return null;
      const serialized = await getChunksFromSync(SYNC_CHUNK_KEY_PREFIX, meta.count);
      if (!serialized) return null;
      const parsed = JSON.parse(serialized);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) return null;
      return parsed.items;
    } catch (e) {
      console.warn('从 sync 读取API配置失败：', e);
      return null;
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
      if (chunked && chunked.length > 0) {
        result.apiConfigs = chunked;
        const syncSel = await chrome.storage.sync.get(['selectedConfigIndex']);
        result.selectedConfigIndex = syncSel.selectedConfigIndex || 0;
        try {
          const metaWrap = await chrome.storage.sync.get([SYNC_CHUNK_META_KEY]);
          const meta = metaWrap[SYNC_CHUNK_META_KEY];
          lastMetaUpdatedAt = Number(meta?.updatedAt || Date.now());
        } catch (_) {}
      } else {
        // 兼容最老的存储形态（仅一次性迁移）
        const syncResult = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
        if (syncResult.apiConfigs && syncResult.apiConfigs.length > 0) {
          result.apiConfigs = syncResult.apiConfigs;
          result.selectedConfigIndex = syncResult.selectedConfigIndex || 0;
          // 迁移到分片并清理旧键
          try {
            await saveConfigsToSyncChunked(result.apiConfigs);
            await chrome.storage.sync.remove(['apiConfigs']);
          } catch (e) {
            console.warn('迁移最老 apiConfigs 到分片失败：', e);
          }
        }
      }

      if (result.apiConfigs && result.apiConfigs.length > 0) {
        apiConfigs = result.apiConfigs.map(config => ({ ...config }));
        selectedConfigIndex = result.selectedConfigIndex || 0;

        let needResave = false;
        // 兼容旧格式：如果 apiKey 是带逗号的字符串，则转换为数组；并确保有 id
        apiConfigs.forEach(config => {
          if (!config.id) { config.id = generateUUID(); needResave = true; }
          if (typeof config.apiKey === 'string' && config.apiKey.includes(',')) {
            // 兼容多 Key：逗号分隔
            config.apiKey = config.apiKey.split(',').map(k => k.trim()).filter(Boolean);
          }
          // 默认开启流式传输（向后兼容）
          if (typeof config.useStreaming === 'undefined') {
            config.useStreaming = true;
            needResave = true;
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

      } else {
        // 创建默认配置
        apiConfigs = [{
          id: generateUUID(),
          apiKey: '', // 初始为空字符串
          baseUrl: 'https://api.openai.com/v1/chat/completions',
          modelName: 'gpt-4o',
          displayName: '',
          temperature: 1,
          useStreaming: true,
          isFavorite: false, // 添加收藏状态字段
          customParams: '',
          customSystemPrompt: '',
          maxChatHistory: 500
        }];
        selectedConfigIndex = 0;
        await saveAPIConfigs();
      }
    } catch (error) {
      console.error('加载 API 配置失败:', error);
      // 如果加载失败，也创建默认配置
      apiConfigs = [{
        id: generateUUID(),
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        modelName: 'gpt-4o',
        displayName: '',
        temperature: 1,
        useStreaming: true,
        isFavorite: false,
        customParams: '',
        customSystemPrompt: '',
        maxChatHistory: 500
      }];
      selectedConfigIndex = 0;
    }

    // 暴露 apiConfigs 到 window 对象 (向后兼容)
    window.apiConfigs = apiConfigs;
    // 触发配置更新事件
    (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));

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
      // 仅同步到 sync（分片以规避配额），并同步 selectedConfigIndex
      try { await saveConfigsToSyncChunked(configsToSave); } catch (e) { console.warn('同步 apiConfigs 到 sync 失败（可忽略）:', e); }
      try { await chrome.storage.sync.set({ selectedConfigIndex }); } catch (e) { console.warn('同步 selectedConfigIndex 到 sync 失败（可忽略）:', e); }
      // 清理本地遗留的 local 缓存（如有）
      try { await chrome.storage.local.remove(['apiConfigs', 'selectedConfigIndex']); } catch (_) {}
      // 更新 window.apiConfigs 并触发事件 (向后兼容)
      window.apiConfigs = apiConfigs; // 保持内存中的对象包含索引
      (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));
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
          const items = await loadConfigsFromSyncChunked();
          if (items && Array.isArray(items)) {
            apiConfigs = items;
            renderAPICards();
            renderFavoriteApis();
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
   * @param {string} [config.baseUrl] - API 基础 URL
   * @param {string} [config.modelName] - 模型名称
   * @param {number} [config.temperature] - temperature 值（可为 0）
   * @param {boolean} [config.isFavorite] - 是否收藏
   * @param {string} [config.customParams] - 自定义参数
   * @param {number} index - 该配置在 apiConfigs 数组中的索引
   * @param {HTMLElement} templateCard - 用于克隆的卡片模板 DOM
   * @returns {HTMLElement} 渲染后的卡片元素
   */
  function createAPICard(config, index, templateCard) {
    // 克隆模板
    const template = templateCard.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';

    if (index === selectedConfigIndex) {
      template.classList.add('selected');
    }

    // 设置标题
    const titleElement = template.querySelector('.api-card-title');
    titleElement.textContent = config.displayName || config.modelName || config.baseUrl || '新配置';

    const apiKeyInput = template.querySelector('.api-key');
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

    // 在 temperature 设置后添加最大聊天历史设置
    const maxHistoryGroup = document.createElement('div');
    maxHistoryGroup.className = 'form-group';
    
    const maxHistoryHeader = document.createElement('div');
    maxHistoryHeader.className = 'form-group-header';
    
    const maxHistoryLabel = document.createElement('label');
    maxHistoryLabel.textContent = '最大聊天历史';
    
    const maxHistoryValue = document.createElement('span');
    maxHistoryValue.className = 'max-history-value temperature-value';
    
    maxHistoryHeader.appendChild(maxHistoryLabel);
    maxHistoryHeader.appendChild(maxHistoryValue);
    
    const maxHistoryInput = document.createElement('input');
    maxHistoryInput.type = 'range';
    maxHistoryInput.className = 'max-chat-history temperature';
    maxHistoryInput.min = '0';
    maxHistoryInput.max = '500';
    maxHistoryInput.step = '5';

    // 初始化值与显示：500 => 无限制；0 => 不发送；其余按条数显示
    const currentMax = Number.isFinite(config.maxChatHistory) ? config.maxChatHistory : 500;
    const isUnlimited = currentMax >= 500;
    const clamped = Math.min(499, Math.max(0, isUnlimited ? 499 : currentMax));
    maxHistoryInput.value = isUnlimited ? '500' : String(clamped);
    maxHistoryValue.textContent = isUnlimited ? '无限制' : (clamped === 0 ? '不发送' : `${clamped}条`);
    
    maxHistoryGroup.appendChild(maxHistoryHeader);
    maxHistoryGroup.appendChild(maxHistoryInput);

    // 在自定义参数之前插入最大聊天历史设置
    // 将“最大聊天历史”放在左侧（api-form-left 的末尾）
    const formLeft = apiForm.querySelector('.api-form-left');
    if (formLeft) {
      formLeft.appendChild(maxHistoryGroup);
    } else {
      apiForm.appendChild(maxHistoryGroup);
    }
    
    // 添加事件监听
    maxHistoryInput.addEventListener('input', () => {
      const v = parseInt(maxHistoryInput.value, 10);
      if (v >= 500) {
        maxHistoryValue.textContent = '无限制';
      } else if (v === 0) {
        maxHistoryValue.textContent = '不发送';
      } else {
        maxHistoryValue.textContent = `${v}条`;
      }
    });
    
    maxHistoryInput.addEventListener('change', () => {
      const v = parseInt(maxHistoryInput.value, 10);
      // 500 代表关闭限制，保存为一个极大值，message_sender 会按此视为“发送全部”
      apiConfigs[index].maxChatHistory = (v >= 500) ? 2147483647 : v;
      saveAPIConfigs();
    });

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
      selectedConfigIndex = index;
      saveAPIConfigs();
      // 关闭设置菜单
      apiSettingsPanel.classList.remove('visible');
       // 更新收藏列表状态
      renderFavoriteApis();
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

    // 监听温度变化
    temperatureInput.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      temperatureValue.textContent = value.toFixed(1);
      apiConfigs[index].temperature = value;
      saveAPIConfigs();
    });

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

    // --- 输入变化时保存 ---
    [baseUrlInput, displayNameInput, modelNameInput].forEach(input => {
      input.addEventListener('change', () => {
        apiConfigs[index] = {
          ...apiConfigs[index],
          baseUrl: baseUrlInput.value,
          displayName: displayNameInput.value,
          modelName: modelNameInput.value,
        };
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

    // 删除配置
    template.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (apiConfigs.length > 1) {
        const deletedConfig = apiConfigs.splice(index, 1)[0];
        // 删除对应的轮询状态
        const deletedConfigId = getConfigIdentifier(deletedConfig);
        delete apiKeyUsageIndex[deletedConfigId];

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
      }
    });

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
  async function resolveToFileUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.startsWith('data:') || raw.startsWith('http')) return raw;
    if (raw.startsWith('file://')) return raw;
    // 处理相对路径：Images/...
    const rel = normalizePath(raw).replace(/^\/+/, '');
    try {
      const res = await chrome.storage.local.get([IMAGE_DOWNLOAD_ROOT_KEY]);
      const root = normalizePath(res[IMAGE_DOWNLOAD_ROOT_KEY] || '');
      if (!root) return null;
      let full = `${root.replace(/\/+$/, '')}/${rel}`;
      full = normalizePath(full);
      if (/^[A-Za-z]:\//.test(full)) full = '/' + full;
      return `file://${full}`;
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

    // 复制并规范化消息，按需注入“自定义提示词”至系统提示词最顶端
    // 说明：这里保留 messages 上的 thoughtSignature 等内部字段，仅在 Gemini 请求体构建中使用；
    // 对于 OpenAI 兼容接口，会在后续单独做字段过滤，避免发送非标准字段。
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
        // 只在模型消息（assistant/model）上回传，以符合官方文档建议
        // 读取历史消息上记录的 Thought Signature，兼容下划线与驼峰命名
        const thoughtSignature =
          (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) ||
          (typeof msg.thought_signature === 'string' && msg.thought_signature) ||
          null;
        if (thoughtSignature && parts.length > 0 && (msg.role === 'assistant' || role === 'model')) {
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

      // 处理 system 消息（优先使用规范化后的消息）
      const systemMessage = normalizedMessages.find(msg => msg.role === 'system');
      if (systemMessage && systemMessage.content) {
        requestBody.systemInstruction = {
          // 根据Gemini API文档，systemInstruction是Content类型，其role是可选的 ('user'或'model')
          // 对于系统指令，通常不指定role或留空
          parts: [{ text: systemMessage.content }]
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
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          base.tool_calls = msg.tool_calls;
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

    // 选择可用的 Key：成功不轮换；429 临时黑名单；400/403 永久黑名单
    const tried = new Set();
    let lastErrorResponse = null;

    // 计算首次尝试索引（数组）或校验单 key
    const isArrayKeys = Array.isArray(config.apiKey);
    const keysArray = isArrayKeys ? config.apiKey : [(config.apiKey || '').trim()].filter(Boolean);
    if (keysArray.length === 0) {
      console.error('API Key 缺失或无效:', config);
      throw new Error(`API Key for ${config.displayName || config.modelName} is missing or invalid.`);
    }

    // 单 Key 且已黑名单，直接错误
    if (!isArrayKeys) {
      const singleKey = keysArray[0];
      if (isKeyBlacklisted(singleKey)) {
        throw new Error('当前 API Key 已被标记为不可用，请更新配置后重试');
      }
    }

    // 查找当前使用索引（若未设置，默认为 0）
    if (isArrayKeys && typeof apiKeyUsageIndex[configId] !== 'number') {
      apiKeyUsageIndex[configId] = 0;
    }

    while (true) {
      let selectedIndex = 0;
      let selectedKey = '';
      if (isArrayKeys) {
        // 从当前索引开始，选择第一个不在黑名单且未尝试过的 key
        const startIndex = Math.min(Math.max(0, apiKeyUsageIndex[configId] || 0), config.apiKey.length - 1);
        const idx = getNextUsableKeyIndex(config, startIndex, tried);
        if (idx === -1) {
          // 无可用 key
          if (lastErrorResponse) return lastErrorResponse; // 返回最后一次错误响应，让上层按原逻辑处理
          throw new Error('没有可用的 API Key（全部黑名单或被删除）');
        }
        selectedIndex = idx;
        selectedKey = (config.apiKey[selectedIndex] || '').trim();
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
        keyCount: isArrayKeys ? (config.apiKey?.length || 0) : 1,
        triedCount: tried.size,
        isKeyRotation: isArrayKeys,
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
          const nextIdx = getNextUsableKeyIndex(config, (selectedIndex + 1) % config.apiKey.length, tried);
          if (nextIdx === -1) {
            return response; // 无可用 key，返回 429 响应
          }
          apiKeyUsageIndex[configId] = nextIdx;
          // 循环继续自动重试
          continue;
        }
        // 单 key 无法继续
        return response;
      }

      // 处理 400/403：标记 key 永久不可用
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
        if (Array.isArray(config.apiKey) && config.apiKey.length > 0) {
          const nextIdx = getNextUsableKeyIndex(config, (selectedIndex + 1) % config.apiKey.length, tried);
          if (nextIdx === -1) {
            return response;
          }
          apiKeyUsageIndex[configId] = nextIdx;
          continue;
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

    // 显示/隐藏 API 设置
      toggleButton.addEventListener('click', () => {
      const wasVisible = panel.classList.contains('visible');
      (currentAppContext.utils.closeExclusivePanels || currentAppContext.services.uiManager.closeExclusivePanels)();

      if (!wasVisible) {
        panel.classList.toggle('visible');
          loadAPIConfigs().then(() => {
            renderAPICards(); // 确保加载最新配置后渲染
            renderFavoriteApis();
        });
      }
    });

    // 返回聊天界面
    backButtonElement.addEventListener('click', () => {
      panel.classList.remove('visible');
    });
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
   * @param {number} [partialConfig.temperature] - 温度值
   * @param {string} [partialConfig.customParams] - 自定义参数字符串
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

    // 创建新的配置对象
    const newConfig = {
      baseUrl: partialConfig.baseUrl,
      // 优先使用 URL 匹配到的配置的 apiKey，其次是当前选中的，最后是空字符串
      // 注意：这里 apiKey 可能是数组或字符串
      apiKey: urlMatchedConfig?.apiKey || fallbackApiKey || '',
      modelName: partialConfig.modelName,
      displayName: partialConfig.displayName || '',
      temperature: partialConfig.temperature ?? 1.0,
      customParams: partialConfig.customParams || '',
      customSystemPrompt: partialConfig.customSystemPrompt || '',
      maxChatHistory: 500, // 添加默认值
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
    setSelectedIndex: (index) => {
      if (index >= 0 && index < apiConfigs.length) {
        selectedConfigIndex = index;
        saveAPIConfigs(); // 保存选中的索引
        renderAPICards(); // 更新卡片选中状态
        renderFavoriteApis(); // 更新收藏列表选中状态
        return true;
      }
      return false;
    },

    // 添加新配置
    addConfig: (config) => {
        // 确保新配置有必要的字段
        const newConfig = {
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1/chat/completions',
            modelName: 'new-model',
            displayName: '新配置',
            temperature: 1,
            useStreaming: true,
            isFavorite: false,
            customParams: '',
            customSystemPrompt: '',
            maxChatHistory: 500, // 添加默认值
            ...config // 允许传入部分或完整配置覆盖默认值
        };
        // 处理传入的 apiKey 格式
        if (typeof newConfig.apiKey === 'string' && newConfig.apiKey.includes(',')) {
            newConfig.apiKey = newConfig.apiKey.split(',').map(k => k.trim()).filter(Boolean);
        }
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
  };

  // 启动跨标签页变更监听（在管理器创建时即注册）
  setupStorageSyncListeners();
}
