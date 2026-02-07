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

function normalizeOptionalTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * 合并会话保存时的元数据状态（纯函数）。
 *
 * 说明：
 * - 该函数只处理“值选择”与“字段继承规则”，不触发任何 IO/副作用；
 * - 适用于 saveCurrentConversation 等需要在“内存态 + 已存储态”之间做一致性合并的场景。
 *
 * @param {{
 *   isUpdate?: boolean,
 *   startPageMeta?: { url?: string, title?: string },
 *   summaryCandidate?: string,
 *   existingConversation?: any,
 *   summaryFromExistingTitle?: string
 * }} [input]
 * @returns {{
 *   urlToSave: string,
 *   titleToSave: string,
 *   summaryToSave: string,
 *   summarySourceToSave: string|null,
 *   parentConversationIdToSave: string|null,
 *   forkedFromMessageIdToSave: string|null
 * }}
 */
export function mergeConversationSaveMetadataState(input = {}) {
  const isUpdate = input?.isUpdate === true;
  const startPageMeta = input?.startPageMeta || {};
  const existingConversation = input?.existingConversation || null;
  const summaryCandidate = (typeof input?.summaryCandidate === 'string') ? input.summaryCandidate : '';
  const summaryFromExistingTitle = (typeof input?.summaryFromExistingTitle === 'string')
    ? input.summaryFromExistingTitle
    : '';

  let urlToSave = normalizeOptionalTrimmedString(startPageMeta?.url);
  let titleToSave = normalizeOptionalTrimmedString(startPageMeta?.title);
  let summaryToSave = summaryCandidate;
  let summarySourceToSave = isUpdate ? null : 'default';
  let parentConversationIdToSave = null;
  let forkedFromMessageIdToSave = null;

  if (isUpdate && existingConversation && typeof existingConversation === 'object') {
    urlToSave = normalizeOptionalTrimmedString(existingConversation.url);
    titleToSave = normalizeOptionalTrimmedString(existingConversation.title);

    const summarySource = normalizeOptionalTrimmedString(existingConversation.summarySource);
    summarySourceToSave = summarySource || null;

    const parentConversationId = normalizeOptionalTrimmedString(existingConversation.parentConversationId);
    const forkedFromMessageId = normalizeOptionalTrimmedString(existingConversation.forkedFromMessageId);
    parentConversationIdToSave = parentConversationId || null;
    forkedFromMessageIdToSave = forkedFromMessageId || null;

    if (existingConversation.summary) {
      summaryToSave = existingConversation.summary;
    } else if (existingConversation.title) {
      summaryToSave = summaryFromExistingTitle;
    }
  }

  return {
    urlToSave,
    titleToSave,
    summaryToSave,
    summarySourceToSave,
    parentConversationIdToSave,
    forkedFromMessageIdToSave
  };
}
