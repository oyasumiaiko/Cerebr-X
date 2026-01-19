/**
 * 用户消息预处理（纯函数）
 * - 负责将模板渲染为实际发送内容
 * - 支持在不修改历史结构的前提下替换消息文本
 */
import { replacePlaceholders } from './prompt_resolver.js';

/**
 * 渲染用户消息模板。
 *
 * 规则：
 * - {{input}} / {{text}} / {{message}} 代表用户原始输入；
 * - {{datetime}} / {{date}} / {{time}} 复用提示词占位符规则。
 *
 * @param {Object} args
 * @param {string} args.template
 * @param {string} args.inputText
 * @returns {string}
 */
export function renderUserMessageTemplate({ template, inputText }) {
  const rawTemplate = (typeof template === 'string') ? template : '';
  const safeInput = (typeof inputText === 'string') ? inputText : '';
  if (!rawTemplate.trim()) return safeInput;
  const withTime = replacePlaceholders(rawTemplate);
  return withTime.replace(/{{\s*(input|text|message)\s*}}/gi, () => safeInput);
}

/**
 * 将渲染后的文本写回消息内容（兼容纯文本与多模态数组）。
 * @param {string|Array} content
 * @param {string} renderedText
 * @returns {string|Array}
 */
export function applyRenderedTextToMessageContent(content, renderedText) {
  const safeText = (typeof renderedText === 'string') ? renderedText : '';
  if (!Array.isArray(content)) return safeText;
  const nonTextParts = content.filter(part => part && part.type !== 'text');
  if (!safeText.trim()) {
    return nonTextParts;
  }
  return [...nonTextParts, { type: 'text', text: safeText }];
}
