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
 * @returns {{id:string,connectionSourceId:string,displayName:string,modelName:string,baseUrl:string,connectionType:string}|null}
 */
export function normalizeConversationApiLock(rawLock) {
  if (!rawLock || typeof rawLock !== 'object') return null;
  const normalizeConnectionType = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'gemini') return 'gemini';
    if (normalized === 'openai_responses') return 'openai_responses';
    if (normalized === 'openai') return 'openai';
    return '';
  };
  const id = typeof rawLock.id === 'string' ? rawLock.id.trim() : '';
  const connectionSourceId = typeof rawLock.connectionSourceId === 'string' ? rawLock.connectionSourceId.trim() : '';
  const displayName = typeof rawLock.displayName === 'string' ? rawLock.displayName.trim() : '';
  const modelName = typeof rawLock.modelName === 'string' ? rawLock.modelName.trim() : '';
  const baseUrl = typeof rawLock.baseUrl === 'string' ? rawLock.baseUrl.trim() : '';
  let connectionType = normalizeConnectionType(rawLock.connectionType);
  const normalizedBaseUrl = baseUrl.toLowerCase();
  if (!connectionType && (normalizedBaseUrl === 'genai' || normalizedBaseUrl.includes('generativelanguage.googleapis.com'))) {
    connectionType = 'gemini';
  } else if (!connectionType && /(^|\/)responses(?:\/[^/?#]+)?\/?$/.test(normalizedBaseUrl)) {
    connectionType = 'openai_responses';
  }
  if (!id && !connectionSourceId && !displayName && !modelName && !baseUrl) return null;
  return { id, connectionSourceId, displayName, modelName, baseUrl, connectionType };
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
 *   startPageMetaSource?: string,
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
  const startPageMetaSource = normalizeOptionalTrimmedString(input?.startPageMetaSource);
  const summaryCandidate = (typeof input?.summaryCandidate === 'string') ? input.summaryCandidate : '';
  const summaryFromExistingTitle = (typeof input?.summaryFromExistingTitle === 'string')
    ? input.summaryFromExistingTitle
    : '';

  let urlToSave = normalizeOptionalTrimmedString(startPageMeta?.url);
  let titleToSave = normalizeOptionalTrimmedString(startPageMeta?.title);
  const hasFrozenStartPageMeta = startPageMetaSource === 'first_user_message' && !!(urlToSave || titleToSave);
  let summaryToSave = summaryCandidate;
  let summarySourceToSave = isUpdate ? null : 'default';
  let parentConversationIdToSave = null;
  let forkedFromMessageIdToSave = null;

  if (isUpdate && existingConversation && typeof existingConversation === 'object') {
    const existingUrl = normalizeOptionalTrimmedString(existingConversation.url);
    const existingTitle = normalizeOptionalTrimmedString(existingConversation.title);
    if (!hasFrozenStartPageMeta) {
      urlToSave = existingUrl;
      titleToSave = existingTitle;
    } else {
      if (!urlToSave) urlToSave = existingUrl;
      if (!titleToSave) titleToSave = existingTitle;
    }

    const summarySource = normalizeOptionalTrimmedString(existingConversation.summarySource);
    summarySourceToSave = summarySource || null;
    const isManualSummary = summarySource === 'manual';
    const existingSummary = normalizeOptionalTrimmedString(existingConversation.summary);
    const normalizedSummaryCandidate = normalizeOptionalTrimmedString(summaryCandidate);
    const candidateLooksSummary = normalizedSummaryCandidate.startsWith('[总结]');
    const existingLooksSummary = existingSummary.startsWith('[总结]');
    const shouldSyncSummaryWithMetadata = !isManualSummary
      && !!normalizedSummaryCandidate
      && (candidateLooksSummary || existingLooksSummary);

    const parentConversationId = normalizeOptionalTrimmedString(existingConversation.parentConversationId);
    const forkedFromMessageId = normalizeOptionalTrimmedString(existingConversation.forkedFromMessageId);
    parentConversationIdToSave = parentConversationId || null;
    forkedFromMessageIdToSave = forkedFromMessageId || null;

    // 总结类会话（[总结] 前缀）在非手动重命名场景下，始终跟随元数据标题重算，避免 SPA 页面切换后出现“URL/标题已更新但列表标题旧值残留”。
    if (shouldSyncSummaryWithMetadata) {
      summaryToSave = normalizedSummaryCandidate;
      if (!summarySourceToSave) {
        summarySourceToSave = 'default';
      }
    } else if (existingSummary) {
      summaryToSave = existingSummary;
    } else if (existingConversation.title) {
      summaryToSave = summaryFromExistingTitle || normalizedSummaryCandidate;
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
