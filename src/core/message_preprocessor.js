/**
 * 用户消息预处理（纯函数）
 * - 负责将模板渲染为实际发送内容
 * - 支持在不修改历史结构的前提下替换消息文本
 */
import { replacePlaceholders } from './prompt_resolver.js';

const INJECT_BLOCK_REGEX = /{{#\s*inject\b[^}]*}}([\s\S]*?){{\/\s*inject\s*}}/gi;
const INJECT_MESSAGE_BLOCK_REGEX = /{{#\s*message\b[^}]*\brole\s*=\s*["']?(user|assistant|system|ai|model)["']?[^}]*}}([\s\S]*?){{\/\s*message\s*}}/gi;
const INJECT_ROLE_BLOCK_REGEX = /{{#\s*(user|assistant|system|ai|model)\s*}}([\s\S]*?){{\/\s*\1\s*}}/gi;

function renderTemplateText(template, inputText) {
  const rawTemplate = (typeof template === 'string') ? template : '';
  const safeInput = (typeof inputText === 'string') ? inputText : '';
  if (!rawTemplate.trim()) return safeInput;
  const withTime = replacePlaceholders(rawTemplate);
  return withTime.replace(/{{\s*(input|text|message)\s*}}/gi, () => safeInput);
}

function normalizeInjectedRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'ai' || normalized === 'model') return 'assistant';
  if (normalized === 'user' || normalized === 'system') return normalized;
  return null;
}

function normalizeInjectedBlockText(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let lines = normalized.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  let minIndent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^[ \t]+/);
    const indent = match ? match[0].length : 0;
    minIndent = (minIndent === null) ? indent : Math.min(minIndent, indent);
    if (minIndent === 0) break;
  }
  if (minIndent && minIndent > 0) {
    lines = lines.map(line => line.slice(minIndent));
  }
  return lines.join('\n');
}

function collectInjectedMessages(blockText) {
  if (typeof blockText !== 'string' || !blockText.trim()) return [];
  const matches = [];
  let match;

  INJECT_MESSAGE_BLOCK_REGEX.lastIndex = 0;
  while ((match = INJECT_MESSAGE_BLOCK_REGEX.exec(blockText)) !== null) {
    matches.push({
      index: match.index,
      role: normalizeInjectedRole(match[1]),
      content: normalizeInjectedBlockText(match[2])
    });
  }

  INJECT_ROLE_BLOCK_REGEX.lastIndex = 0;
  while ((match = INJECT_ROLE_BLOCK_REGEX.exec(blockText)) !== null) {
    matches.push({
      index: match.index,
      role: normalizeInjectedRole(match[1]),
      content: normalizeInjectedBlockText(match[2])
    });
  }

  matches.sort((a, b) => a.index - b.index);
  const results = [];
  for (const item of matches) {
    if (!item.role) continue;
    if (!item.content || !item.content.trim()) continue;
    results.push({ role: item.role, content: item.content });
  }
  return results;
}

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
  return renderTemplateText(template, inputText);
}

/**
 * 渲染用户消息模板，并解析“仅发送给 API 的注入消息”块。
 *
 * 注入语法：
 * - 使用 {{#inject}} ... {{/inject}} 包裹；
 * - 块内支持 {{#assistant}}...{{/assistant}} / {{#user}}...{{/user}} / {{#system}}...{{/system}}
 *   或 {{#message role="assistant"}}...{{/message}} 的写法；
 * - 注入块内也会应用 {{input}} / {{date}} / {{time}} 等占位符替换。
 *
 * @param {Object} args
 * @param {string} args.template
 * @param {string} args.inputText
 * @returns {{renderedText: string, injectedMessages: Array<{role: string, content: string}>, hasInjectedBlocks: boolean}}
 */
export function renderUserMessageTemplateWithInjection({ template, inputText }) {
  const rawTemplate = (typeof template === 'string') ? template : '';
  const renderedText = renderTemplateText(template, inputText);
  if (!rawTemplate.trim()) {
    return { renderedText, injectedMessages: [], hasInjectedBlocks: false };
  }

  const injectedMessages = [];
  let hasInjectedBlocks = false;
  INJECT_BLOCK_REGEX.lastIndex = 0;
  const cleanedText = renderedText.replace(INJECT_BLOCK_REGEX, (match, blockText) => {
    hasInjectedBlocks = true;
    injectedMessages.push(...collectInjectedMessages(blockText));
    return '';
  });

  return {
    renderedText: cleanedText,
    injectedMessages,
    hasInjectedBlocks
  };
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
