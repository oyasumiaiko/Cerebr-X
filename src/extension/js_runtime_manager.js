/**
 * 基于 chrome.userScripts 的最小可用 JS Runtime。
 *
 * 设计目标（Phase 1）：
 * 1. 只做一次性执行，不做长期会话态 REPL 管理；
 * 2. 默认运行在 USER_SCRIPT world，而不是 MAIN world；
 * 3. 通过一个统一的 `cerebr.invoke(method, params)` 扩展桥，
 *    暴露少量高价值能力，避免一开始就把 background API 散乱铺开；
 * 4. 遇到 Chrome 版本 / 用户侧开关不满足时，返回明确错误，而不是偷偷 fallback。
 */

const CEREBR_JS_RUNTIME_WORLD_ID = 'cerebr_js_runtime_world';
const CEREBR_JS_RUNTIME_EXTENSION_BRIDGE_MARKER = '__cerebrJsRuntimeExtensionCall';

/**
 * 将错误对象压缩成适合 UI 展示的轻量结构。
 * @param {any} error
 * @returns {{message:string, name:string, stack:string}}
 */
function normalizeJsRuntimeError(error) {
  const message = (typeof error?.message === 'string' && error.message.trim())
    ? error.message.trim()
    : String(error || '未知错误');
  return {
    message,
    name: (typeof error?.name === 'string' && error.name.trim()) ? error.name.trim() : 'Error',
    stack: (typeof error?.stack === 'string') ? error.stack : ''
  };
}

/**
 * 用于把 execute() 返回值压成稳定结构，便于后续 UI / 工具层复用。
 * @param {any} item
 * @returns {{frameId:number|null, documentId:string|null, result:any, error:any}}
 */
function normalizeExecuteResultItem(item) {
  return {
    frameId: Number.isFinite(Number(item?.frameId)) ? Number(item.frameId) : null,
    documentId: (typeof item?.documentId === 'string' && item.documentId) ? item.documentId : null,
    result: item?.result,
    error: item?.error ? normalizeJsRuntimeError(item.error) : null
  };
}

/**
 * 将 frame 探测结果压成适合注入模型上下文的轻量快照。
 * @param {any} item
 * @returns {{frameId:number|null, documentId:string|null, url:string, title:string, isTop:boolean, error:any}}
 */
function normalizeFrameSnapshotItem(item) {
  const normalized = normalizeExecuteResultItem(item);
  const result = (normalized?.result && typeof normalized.result === 'object' && !Array.isArray(normalized.result))
    ? normalized.result
    : {};
  return {
    frameId: normalized.frameId,
    documentId: normalized.documentId,
    url: (typeof result.url === 'string') ? result.url : '',
    title: (typeof result.title === 'string') ? result.title : '',
    isTop: result.isTop === true || normalized.frameId === 0,
    error: normalized.error
  };
}

/**
 * 构造注入到 userScripts world 里的代码。
 *
 * 实现方式：
 * - 整段代码作为字符串传给 `chrome.userScripts.execute()`；
 * - 内部先注入统一的 `cerebr.invoke()` 桥，再把用户代码塞进 async IIFE；
 * - 这样用户代码天然支持 `await` 与 `return`。
 *
 * @param {string} userCode
 * @returns {string}
 */
function buildUserScriptSource(userCode) {
  const body = (typeof userCode === 'string') ? userCode : '';
  return `
(() => {
  const __cerebrInvoke = async (method, params = {}) => {
    const response = await chrome.runtime.sendMessage({
      ${CEREBR_JS_RUNTIME_EXTENSION_BRIDGE_MARKER}: true,
      method,
      params
    });
    if (!response || response.ok !== true) {
      const message = response && typeof response.error === 'string' && response.error
        ? response.error
        : 'Cerebr extension bridge 调用失败';
      throw new Error(message);
    }
    return response.result;
  };

  const cerebr = Object.freeze({
    invoke: __cerebrInvoke,
    extension: __cerebrInvoke,
    page: Object.freeze({
      url: location.href,
      title: document.title,
      origin: location.origin
    })
  });

  globalThis.cerebr = cerebr;

  return (async () => {
${body}
  })();
})()
`.trim();
}

/**
 * 构造一个最小 JS Runtime manager。
 *
 * @param {Object} deps
 * @param {(tabId:number)=>Promise<any>} deps.getPageContentByTabId
 * @returns {Object}
 */
export function createJsRuntimeManager(deps = {}) {
  const getPageContentByTabId = (typeof deps.getPageContentByTabId === 'function')
    ? deps.getPageContentByTabId
    : (async () => null);

  let configureWorldPromise = null;

  /**
   * 探测当前环境是否真的可执行 userScripts。
   * 这里既检查 API 是否存在，也检查 execute / getScripts 是否可用，
   * 并将 Chrome 版本门槛与用户侧 Allow User Scripts 开关问题区分开。
   *
   * @returns {Promise<{available:boolean, hasUserScriptsApi:boolean, hasExecute:boolean, hasMessaging:boolean, reason:string}>}
   */
  async function getAvailability() {
    const hasUserScriptsApi = !!chrome?.userScripts;
    const hasExecute = typeof chrome?.userScripts?.execute === 'function';
    const hasMessaging = typeof chrome?.runtime?.onUserScriptMessage?.addListener === 'function';

    if (!hasUserScriptsApi) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        hasMessaging,
        reason: '当前 Chrome 扩展环境不支持 chrome.userScripts。'
      };
    }

    if (!hasExecute) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        hasMessaging,
        reason: '当前 Chrome 版本不支持 chrome.userScripts.execute（需要 Chrome 135+）。'
      };
    }

    if (!hasMessaging) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        hasMessaging,
        reason: '当前环境缺少 runtime.onUserScriptMessage，无法建立扩展桥。'
      };
    }

    try {
      await chrome.userScripts.getScripts();
      return {
        available: true,
        hasUserScriptsApi,
        hasExecute,
        hasMessaging,
        reason: ''
      };
    } catch (error) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        hasMessaging,
        reason: `userScripts 当前不可用：${normalizeJsRuntimeError(error).message}。请检查扩展详情页里的 Allow User Scripts / 开发者模式设置。`
      };
    }
  }

  /**
   * 确保 userScripts world 已启用 messaging。
   * Phase 1 统一使用一个固定 worldId，后续若要支持 MAIN world，再单独扩展。
   */
  async function ensureWorldConfigured() {
    const availability = await getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'JS Runtime 当前不可用');
    }

    if (!configureWorldPromise) {
      configureWorldPromise = chrome.userScripts.configureWorld({
        worldId: CEREBR_JS_RUNTIME_WORLD_ID,
        messaging: true
      }).catch((error) => {
        configureWorldPromise = null;
        throw error;
      });
    }

    await configureWorldPromise;
  }

  /**
   * 执行一段运行时生成的 JS 代码。
   *
   * @param {Object} request
   * @param {number} request.tabId
   * @param {string} request.code
   * @param {number[]|null} [request.frameIds]
   * @param {boolean} [request.allFrames]
   * @param {boolean} [request.injectImmediately]
   * @returns {Promise<{ok:boolean, items:Array<Object>, value:any}>}
   */
  async function execute(request = {}) {
    const tabId = Number(request?.tabId);
    const code = (typeof request?.code === 'string') ? request.code : '';
    if (!Number.isFinite(tabId)) {
      throw new Error('执行 JS Runtime 失败：缺少有效 tabId。');
    }
    if (!code.trim()) {
      throw new Error('执行 JS Runtime 失败：代码内容为空。');
    }

    await ensureWorldConfigured();

    /** @type {chrome.userScripts.UserScriptInjectionTarget} */
    const target = { tabId };
    if (Array.isArray(request?.frameIds) && request.frameIds.length > 0) {
      target.frameIds = request.frameIds
        .map(value => Number(value))
        .filter(value => Number.isFinite(value));
    } else if (request?.allFrames === true) {
      target.allFrames = true;
    }

    const rawItems = await chrome.userScripts.execute({
      target,
      injectImmediately: request?.injectImmediately === true,
      worldId: CEREBR_JS_RUNTIME_WORLD_ID,
      js: [
        {
          code: buildUserScriptSource(code)
        }
      ]
    });

    const items = Array.isArray(rawItems)
      ? rawItems.map(normalizeExecuteResultItem)
      : [];
    const successfulItems = items.filter(item => !item.error);

    return {
      ok: items.every(item => !item.error),
      items,
      value: successfulItems.length === 1
        ? successfulItems[0].result
        : successfulItems.map(item => item.result)
    };
  }

  /**
   * 枚举当前标签页所有可注入 frame 的快照。
   *
   * 说明：
   * - 这里在扩展侧主动做一次 allFrames 探测；
   * - 目的是把 frameId/url/title/isTop 注入模型上下文，帮助模型在一次工具调用里直接选择目标 frame；
   * - 不是为了让模型再额外走一次“发现 frame”工具调用。
   *
   * @param {{tabId:number}} request
   * @returns {Promise<{ok:boolean, frames:Array<Object>}>}
   */
  async function listFrames(request = {}) {
    const tabId = Number(request?.tabId);
    if (!Number.isFinite(tabId)) {
      throw new Error('获取 JS Runtime frame 快照失败：缺少有效 tabId。');
    }

    const probeResult = await execute({
      tabId,
      allFrames: true,
      code: `
        let isTop = false;
        try {
          isTop = globalThis === globalThis.top;
        } catch (_) {
          isTop = false;
        }
        return {
          url: location.href,
          title: document.title || '',
          isTop
        };
      `
    });

    const frames = Array.isArray(probeResult?.items)
      ? probeResult.items
        .map(normalizeFrameSnapshotItem)
        .filter(item => !item.error && Number.isFinite(item.frameId))
        .sort((a, b) => {
          if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
          return (a.frameId ?? Number.MAX_SAFE_INTEGER) - (b.frameId ?? Number.MAX_SAFE_INTEGER);
        })
      : [];

    return {
      ok: probeResult?.ok === true,
      frames
    };
  }

  /**
   * 处理来自 userScripts world 的扩展桥请求。
   * 第一阶段只暴露极少量高价值能力。
   *
   * @param {string} method
   * @param {any} params
   * @param {chrome.runtime.MessageSender} sender
   * @returns {Promise<any>}
   */
  async function dispatchExtensionCall(method, params, sender) {
    const normalizedMethod = (typeof method === 'string') ? method.trim() : '';
    const tabId = Number(sender?.tab?.id);

    if (normalizedMethod === 'extension.getRuntimeStatus') {
      return getAvailability();
    }

    if (normalizedMethod === 'page.getContent') {
      if (!Number.isFinite(tabId)) {
        throw new Error('当前执行上下文没有关联到标签页，无法读取页面内容。');
      }
      return await getPageContentByTabId(tabId);
    }

    throw new Error(`未支持的 Cerebr JS Runtime 扩展方法：${normalizedMethod || '(empty)'}`);
  }

  /**
   * 挂载 userScripts -> background 的桥接监听器。
   * 由于 background 是单例，这里内部做幂等保护，避免热更新 / 多次初始化时重复注册。
   */
  function installBridge() {
    if (installBridge.installed === true) return;
    if (typeof chrome?.runtime?.onUserScriptMessage?.addListener !== 'function') {
      return;
    }
    const listener = (message, sender, sendResponse) => {
      if (!message || message[CEREBR_JS_RUNTIME_EXTENSION_BRIDGE_MARKER] !== true) {
        return false;
      }

      (async () => {
        try {
          const result = await dispatchExtensionCall(message.method, message.params, sender);
          sendResponse({ ok: true, result });
        } catch (error) {
          sendResponse({ ok: false, error: normalizeJsRuntimeError(error).message });
        }
      })();
      return true;
    };
    chrome.runtime.onUserScriptMessage.addListener(listener);
    installBridge.installed = true;
  }

  return {
    getAvailability,
    listFrames,
    execute,
    installBridge
  };
}
