/**
 * Responses Prompt Cache 相关纯函数。
 *
 * 设计目标：
 * - 把“如何为一个会话生成稳定 prompt_cache_key”的策略从发送流程里抽出来；
 * - 保持纯函数，方便单元测试与后续在 queue / 后台发送 / 会话恢复等路径复用；
 * - 不引入任何 DOM / storage / 全局状态依赖。
 */

/**
 * 规范化 prompt_cache_key。
 *
 * @param {any} value
 * @returns {string}
 */
export function normalizeResponsesPromptCacheKey(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

/**
 * 为当前会话构造一个稳定的默认 prompt_cache_key。
 *
 * 规则：
 * - 若调用方已经持有稳定 key，则直接复用；
 * - 否则优先使用真实 conversationId；
 * - 若当前仍是“草稿会话”，则使用草稿队列键生成 draft key。
 *
 * 说明：
 * - 这里不会自行随机生成值；调用方必须提供 conversationId 或 draftConversationKey 之一，
 *   从而保证 key 的来源可解释、可复现。
 *
 * @param {{existingKey?: string|null, conversationId?: string|null, draftConversationKey?: string|null}} options
 * @returns {string}
 */
export function buildDefaultResponsesPromptCacheKey(options = {}) {
  const existingKey = normalizeResponsesPromptCacheKey(options.existingKey);
  if (existingKey) return existingKey;

  const conversationId = (typeof options.conversationId === 'string')
    ? options.conversationId.trim()
    : '';
  if (conversationId) {
    return `conv:${conversationId}`;
  }

  const draftConversationKey = (typeof options.draftConversationKey === 'string')
    ? options.draftConversationKey.trim()
    : '';
  if (draftConversationKey) {
    return `draft:${draftConversationKey}`;
  }

  return '';
}
