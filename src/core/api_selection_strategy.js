/**
 * API 选择策略（纯函数）
 * - 根据意图/提示词类型与提示词设置中的“偏好模型”选择 API 配置
 * - 不依赖 DOM，不访问全局状态
 * @since 1.2.0
 */

/**
 * 根据提示词类型选择 API 配置
 * @param {Object} params
 * @param {string} params.promptType - 提示词类型：'selection'|'query'|'summary'
 * @param {Object} params.prompts - PromptSettings.getPrompts() 返回的对象
 * @param {Object} params.apiManager - api_manager 实例，需提供 resolveApiParam()
 * @returns {Object|null} 解析出的 API 配置或 null（表示使用当前选中）
 */
export function selectApiByPromptType({ promptType, prompts, apiManager }) {
  if (!promptType || !prompts || !apiManager?.resolveApiParam) return null;
  const item = prompts[promptType];
  if (!item) return null;
  const modelPref = (item.model || '').trim();
  if (!modelPref || modelPref === 'follow_current') return null;
  try {
    return apiManager.resolveApiParam(modelPref) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 基于当前输入文本推断提示词类型并选择 API 配置
 * @param {Object} params
 * @param {string|null} [params.specificPromptType] - 若已知，优先使用该类型
 * @param {string} params.messageText - 输入文本
 * @param {Object} params.prompts - PromptSettings.getPrompts()
 * @param {function} params.getPromptTypeFromContent - 函数(text, prompts) => promptType
 * @param {Object} params.apiManager - api_manager 实例
 * @returns {Object|null}
 */
export function selectApiForMessage({ specificPromptType, messageText, prompts, getPromptTypeFromContent, apiManager }) {
  const promptType = specificPromptType || getPromptTypeFromContent?.(messageText || '', prompts) || 'none';
  return selectApiByPromptType({ promptType, prompts, apiManager });
}


