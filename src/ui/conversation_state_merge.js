/**
 * 会话保存场景下的状态合并规则（纯函数集合）。
 *
 * 设计目标：
 * - 把“内存态 vs 已存储态”的优先级规则从 UI 流程里剥离出来；
 * - 在不依赖 DOM / storage / service 的情况下可直接做输入输出断言；
 * - 保持规则集中，避免多处 copy-paste 后出现分叉。
 */

/**
 * 规范化会话级 API 锁定对象。
 * @param {any} rawLock
 * @returns {{id:string,displayName:string,modelName:string,baseUrl:string}|null}
 */
export function normalizeConversationApiLock(rawLock) {
  if (!rawLock || typeof rawLock !== 'object') return null;
  const id = typeof rawLock.id === 'string' ? rawLock.id.trim() : '';
  const displayName = typeof rawLock.displayName === 'string' ? rawLock.displayName.trim() : '';
  const modelName = typeof rawLock.modelName === 'string' ? rawLock.modelName.trim() : '';
  const baseUrl = typeof rawLock.baseUrl === 'string' ? rawLock.baseUrl.trim() : '';
  if (!id && !displayName && !modelName && !baseUrl) return null;
  return { id, displayName, modelName, baseUrl };
}

/**
 * 合并“会话 API 锁定”状态。
 *
 * 优先级：
 * 1) 内存态锁定（activeConversationApiLock / activeConversation.apiLock）；
 * 2) 当且仅当允许继承时，回退到已存储会话的 apiLock；
 * 3) 两者都不可用时返回 null。
 *
 * @param {{
 *   memoryApiLock?: any,
 *   storedApiLock?: any,
 *   preserveExistingApiLock?: boolean
 * }} [input]
 * @returns {{ apiLock: ReturnType<typeof normalizeConversationApiLock>, source: 'memory'|'stored'|'none' }}
 */
export function mergeConversationApiLockState(input = {}) {
  const preserveExistingApiLock = input?.preserveExistingApiLock !== false;
  const memoryLock = normalizeConversationApiLock(input?.memoryApiLock);
  if (memoryLock) {
    return { apiLock: memoryLock, source: 'memory' };
  }

  if (preserveExistingApiLock) {
    const storedLock = normalizeConversationApiLock(input?.storedApiLock);
    if (storedLock) {
      return { apiLock: storedLock, source: 'stored' };
    }
  }

  return { apiLock: null, source: 'none' };
}
