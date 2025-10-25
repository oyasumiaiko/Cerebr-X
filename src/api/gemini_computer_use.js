/**
 * 创建 Gemini Computer Use API 客户端
 * @param {Object} appContext - 应用上下文
 * @returns {Object} 客户端实例
 */
export function createComputerUseApi(appContext) {
  const showNotification = appContext?.utils?.showNotification || (() => {});

  const STORAGE_KEY = 'computerUseApiConfig';
  const defaultConfig = {
    apiKey: '',
    modelName: 'gemini-2.5-computer-use-preview-10-2025',
    temperature: 0.2,
    executionMode: 'auto',
    actionSettleDelayMs: 1000
  };

  const PREDEFINED_SCREENSHOT_ACTIONS = new Set([
    'open_web_browser',
    'click_at',
    'hover_at',
    'type_text_at',
    'scroll_document',
    'scroll_at',
    'wait_5_seconds',
    'go_back',
    'go_forward',
    'search',
    'navigate',
    'key_combination',
    'drag_and_drop'
  ]);
  const MAX_SCREENSHOT_TURNS = 3;

  let initialized = false;
  let currentConfig = { ...defaultConfig };
  const subscribers = new Set();

  function cloneConfig() {
    return { ...currentConfig };
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(key, (result) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            reject(err);
            return;
          }
          resolve(result || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageSet(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(payload, () => {
          const err = chrome.runtime?.lastError;
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function loadConfig() {
    if (initialized) return;
    initialized = true;
    try {
      const stored = await storageGet(STORAGE_KEY);
      const saved = stored?.[STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        currentConfig = { ...defaultConfig, ...saved };
      }
    } catch (error) {
      console.warn('加载电脑操作配置失败，将使用默认值:', error);
      currentConfig = { ...defaultConfig };
    }
  }

  async function persistConfig(partial) {
    await loadConfig();
    if (partial && typeof partial === 'object') {
      currentConfig = { ...currentConfig, ...partial };
    }
    try {
      await storageSet({ [STORAGE_KEY]: currentConfig });
      notifySubscribers();
    } catch (error) {
      console.warn('保存电脑操作配置失败:', error);
    }
  }

  function notifySubscribers() {
    const snapshot = cloneConfig();
    subscribers.forEach((cb) => {
      try {
        cb(snapshot);
      } catch (err) {
        console.warn('电脑操作配置监听回调失败:', err);
      }
    });
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback);
    callback(cloneConfig());
    return () => subscribers.delete(callback);
  }

  /**
   * 深拷贝任意 JSON 兼容结构
   * @param {any} data
   * @returns {any}
   */
  function cloneDeep(data) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(data);
      } catch (_) {
        // 忽略 structuredClone 失败，退回 JSON 方案
      }
    }
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (error) {
      console.warn('电脑操作：克隆数据失败，返回原始引用', error);
      return data;
    }
  }

  /**
   * 将 dataURL 转换为裸的 Base64 字符串
   * @param {string} dataUrl - 形如 data:image/png;base64,... 的字符串
   * @returns {string}
   */
  function extractBase64(dataUrl) {
    if (!dataUrl) return '';
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  }

  /**
   * 判断部件中是否包含截图数据
   * @param {Object} part
   * @returns {boolean}
   */
  function hasInlineScreenshot(part) {
    if (!part) return false;
    const candidate = part.inline_data || part.inlineData;
    if (candidate && candidate.data) return true;
    if (Array.isArray(part.parts)) {
      return part.parts.some((child) => hasInlineScreenshot(child));
    }
    return false;
  }

  /**
   * 清理会话历史中过旧的截图，限制体积
   * @param {Array<Object>} contents
   */
  function pruneSessionScreenshots(contents) {
    let screenshotTurns = 0;
    for (let idx = contents.length - 1; idx >= 0; idx -= 1) {
      const content = contents[idx];
      if (!content?.parts || !Array.isArray(content.parts)) continue;
      let hasScreenshot = false;
      content.parts.forEach((part) => {
        const functionResponse = part.function_response || part.functionResponse;
        if (
          functionResponse?.parts &&
          Array.isArray(functionResponse.parts) &&
          PREDEFINED_SCREENSHOT_ACTIONS.has(functionResponse.name)
        ) {
          const containsScreenshot = functionResponse.parts.some((inner) => hasInlineScreenshot(inner));
          if (containsScreenshot) {
            hasScreenshot = true;
            if (screenshotTurns >= MAX_SCREENSHOT_TURNS) {
              functionResponse.parts = [];
            }
          }
        }
      });
      if (hasScreenshot) screenshotTurns += 1;
    }
  }

  /**
   * 构建函数响应部件
   * @param {Object} fr
   * @returns {Object|null}
   */
  function buildFunctionResponsePart(fr) {
    if (!fr || typeof fr !== 'object') return null;
    const payload = {
      name: fr.name,
      response: cloneDeep(fr.response || {})
    };
    if (!payload.name) {
      return null;
    }
    const callId = fr.id || fr.callId || fr.call_id;
    if (callId) payload.id = callId;
    if (Array.isArray(fr.parts) && fr.parts.length > 0) {
      payload.parts = fr.parts.map((part) => cloneDeep(part));
    }
    return { function_response: payload };
  }

  /**
   * 根据最新请求与响应生成新的会话快照
   * @param {Array<Object>} contents
   * @param {Object} payload
   * @returns {{ contents: Array<Object> }}
   */
  function createSessionContext(contents, payload) {
    const snapshot = Array.isArray(contents) ? contents.map((item) => cloneDeep(item)) : [];
    const candidateContent = payload?.candidates?.[0]?.content;
    if (candidateContent) {
      snapshot.push(cloneDeep(candidateContent));
    }
    pruneSessionScreenshots(snapshot);
    return {
      contents: snapshot,
      createdAt: Date.now()
    };
  }

  /**
   * 构造标准 Computer Use 请求体
   * @param {Array<Object>} contents
   * @param {number} temperature
   * @returns {Object}
   */
  function buildRequestBody(contents, temperature) {
    return {
      contents,
      tools: [
        {
          computerUse: {
            environment: 'ENVIRONMENT_BROWSER'
          }
        }
      ],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : defaultConfig.temperature,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 4096
      }
    };
  }

  /**
   * 执行与 Gemini 的 HTTP 请求
   * @param {string} endpoint
   * @param {Object} body
   * @returns {Promise<Object>}
   */
  async function callGemini(endpoint, body) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Computer Use 请求失败 (${response.status}): ${detail}`);
    }

    return response.json();
  }

  /**
   * 解析模型响应，提取叙述与操作指令
   * @param {Object} payload - 原始响应
   * @returns {{ narration: string, actions: Array<Object>, candidate: Object }}
   */
  function normalizeResponse(payload) {
    const candidate = payload?.candidates?.[0];
    if (!candidate) {
      throw new Error('Gemini 返回结果为空');
    }
    const parts = candidate.content?.parts || [];
    const narrationPieces = [];
    const actions = [];

    for (const part of parts) {
      if (part?.text) {
        narrationPieces.push(part.text);
      }
      if (part?.functionCall) {
        const call = part.functionCall;
        if (!call?.name) continue;
        actions.push({
          name: call?.name,
          args: call?.args || {},
          callId: call?.id || call?.callId || null
        });
      }
    }

    return {
      narration: narrationPieces.join('\n') || '',
      actions,
      candidate
    };
  }

  /**
   * 标准化 session 对象
   * @param {any} session
   * @param {Object|null} [fallback=null]
   * @returns {Object|null}
   */
  function normalizeSession(session, fallback = null) {
    if (!session) return fallback || null;
    if (typeof session === 'string') {
      return { name: session };
    }
    if (typeof session === 'object') {
      const copy = cloneDeep(session);
      if (!copy.name && copy.id) {
        copy.name = copy.id;
      }
      return copy;
    }
    return fallback || null;
  }

  /**
   * 从返回 payload 提取 session 信息
   * @param {Object} payload
   * @param {Object|null} [fallback=null]
   * @returns {Object|null}
   */
  function extractSession(payload, fallback = null) {
    const direct = normalizeSession(payload?.session);
    if (direct) return direct;
    const candidateSession = normalizeSession(payload?.candidates?.[0]?.session);
    if (candidateSession) return candidateSession;
    const sessionId = payload?.sessionId || payload?.session_id;
    if (sessionId) return normalizeSession(sessionId);
    return fallback || null;
  }

  /**
   * 发送初始 Computer Use 请求
   * @param {Object} options
   * @param {string} options.instruction - 用户提供的指令
   * @param {string} options.screenshotDataUrl - 当前页面的截图（dataURL）
   * @returns {Promise<{ narration: string, actions: Array<Object>, candidate: Object }>}
   */
  async function startSession({ instruction, screenshotDataUrl }) {
    if (!instruction || !instruction.trim()) {
      throw new Error('请输入要执行的操作指令');
    }

    await loadConfig();
    const { apiKey, modelName, temperature } = currentConfig;
    const trimmedKey = (apiKey || '').trim();
    if (!trimmedKey) {
      throw new Error('请在电脑操作设置中填写专用的 Gemini API Key');
    }
    if (!modelName || !modelName.trim()) {
      throw new Error('请在电脑操作设置中填写电脑操作模型名称');
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName.trim()}:generateContent?key=${encodeURIComponent(trimmedKey)}`;

    const inlineData = extractBase64(screenshotDataUrl);
    if (!inlineData) {
      throw new Error('未获取到有效的页面截图');
    }

    const initialContent = {
      role: 'user',
      parts: [
        { text: instruction.trim() },
        {
          inline_data: {
            mime_type: 'image/png',
            data: inlineData
          }
        }
      ]
    };

    try {
      const requestBody = buildRequestBody([initialContent], temperature);
      const payload = await callGemini(endpoint, requestBody);
      const parsed = normalizeResponse(payload);
      const sessionContext = createSessionContext([initialContent], payload);
      const sessionMeta = {
        ...sessionContext,
        serverSession: extractSession(payload),
        clientToolState: cloneDeep(payload?.clientToolState) || null
      };
      return {
        ...parsed,
        session: sessionMeta,
        finishReason: payload.candidates?.[0]?.finishReason || null
      };
    } catch (error) {
      console.error('调用 Gemini Computer Use 失败:', error);
      showNotification({ message: error.message || 'Computer Use 请求失败', type: 'error' });
      throw error;
    }
  }

  async function continueSession({ session, functionResponses }) {
    if (!session || !Array.isArray(session?.contents) || session.contents.length === 0) {
      throw new Error('缺少会话信息，无法继续电脑操作流程');
    }
    if (!Array.isArray(functionResponses) || functionResponses.length === 0) {
      throw new Error('缺少动作执行结果，无法继续电脑操作流程');
    }

    await loadConfig();
    const { apiKey, modelName, temperature } = currentConfig;
    const trimmedKey = (apiKey || '').trim();
    if (!trimmedKey) {
      throw new Error('请在电脑操作设置中填写专用的 Gemini API Key');
    }
    if (!modelName || !modelName.trim()) {
      throw new Error('请在电脑操作设置中填写电脑操作模型名称');
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName.trim()}:generateContent?key=${encodeURIComponent(trimmedKey)}`;

    const parts = functionResponses
      .map((item) => buildFunctionResponsePart(item))
      .filter((part) => !!part);

    if (!parts.length) {
      throw new Error('动作执行结果无效，无法继续电脑操作流程');
    }

    const historyContents = session.contents.map((content) => cloneDeep(content));
    const userContent = {
      role: 'user',
      parts
    };
    const nextContents = [...historyContents, userContent];

    const requestBody = buildRequestBody(nextContents, temperature);

    try {
      const payload = await callGemini(endpoint, requestBody);
      const parsed = normalizeResponse(payload);
      const sessionContext = createSessionContext(nextContents, payload);
      const updatedSession = {
        ...sessionContext,
        serverSession: extractSession(payload, session.serverSession),
        clientToolState: payload?.clientToolState ? cloneDeep(payload.clientToolState) : cloneDeep(session.clientToolState)
      };
      return {
        ...parsed,
        session: updatedSession,
        finishReason: payload.candidates?.[0]?.finishReason || null
      };
    } catch (error) {
      console.error('继续 Gemini Computer Use 失败:', error);
      showNotification({ message: error.message || 'Computer Use 请求失败', type: 'error' });
      throw error;
    }
  }

  return {
    init: loadConfig,
    getConfig: () => cloneConfig(),
    saveConfig: (partial) => persistConfig(partial),
    subscribe,
    startSession,
    continueSession
  };
}
