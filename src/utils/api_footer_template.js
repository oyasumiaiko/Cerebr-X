/**
 * AI 消息 footer 模板工具：
 * - 统一解析可展示的 API 元数据；
 * - 提供模板渲染（支持 {{var}} 与 {{#var}}...{{/var}}）；
 * - 输出 footer 文本与 tooltip 标题，避免多处重复实现。
 */

export const DEFAULT_AI_FOOTER_TEMPLATE = '{{display_label}}';

// AI footer 可配置模板变量（去重后的“主变量”清单，供设置界面展示/复制）。
export const AI_FOOTER_TEMPLATE_VARIABLES = Object.freeze([
  { key: 'display_label', group: '常用', description: '默认显示文案（含 signatured 前缀）' },
  { key: 'display_with_total_tokens_k', group: '常用', description: '默认文案 + 总 tokens（k/m/b）' },
  { key: 'display_with_usage_k', group: '常用', description: '默认文案 + in/out/total（k/m/b）' },
  { key: 'apiname', group: '模型信息', description: 'API 显示名（displayName 优先，回退 model）' },
  { key: 'display_name', group: '模型信息', description: '配置中的 displayName（或历史快照）' },
  { key: 'model', group: '模型信息', description: '模型名（modelName / apiModelId）' },
  { key: 'api_uuid', group: '模型信息', description: 'API 配置 id' },
  { key: 'signature', group: '模型信息', description: '有推理签名时为 signatured，否则为空' },
  { key: 'signature_prefix', group: '模型信息', description: '有签名时为 signatured · ' },
  { key: 'signature_source', group: '模型信息', description: '签名来源（gemini/openai）' },
  { key: 'input_tokens', group: 'Tokens', description: '输入 tokens（原始数值）' },
  { key: 'output_tokens', group: 'Tokens', description: '输出 tokens（原始数值）' },
  { key: 'total_tokens', group: 'Tokens', description: '总 tokens（原始数值）' },
  { key: 'input_tokens_k', group: 'Tokens', description: '输入 tokens（k/m/b）' },
  { key: 'output_tokens_k', group: 'Tokens', description: '输出 tokens（k/m/b）' },
  { key: 'total_tokens_k', group: 'Tokens', description: '总 tokens（k/m/b）' },
  { key: 'usage_line', group: 'Tokens', description: 'in/out/total 汇总（千分位）' },
  { key: 'usage_line_k', group: 'Tokens', description: 'in/out/total 汇总（k/m/b）' },
  { key: 'timestamp', group: '时间', description: '消息时间戳（毫秒）' },
  { key: 'time', group: '时间', description: '时间（HH:mm）' },
  { key: 'date', group: '时间', description: '智能日期（非本日显示 M/D，非本年显示 YYYY/M/D）' },
  { key: 'datetime', group: '时间', description: '智能日期 + 时间（date + HH:mm）' }
]);

function toTrimmedText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeTimestampMs(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeTokenValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function formatTokenWithThousands(value) {
  const normalized = normalizeTokenValue(value);
  if (normalized == null) return '';
  return normalized.toLocaleString();
}

function formatTokenCompact(value) {
  const normalized = normalizeTokenValue(value);
  if (normalized == null) return '';
  if (normalized < 1000) return String(normalized);
  const units = [
    { base: 1e9, suffix: 'b' },
    { base: 1e6, suffix: 'm' },
    { base: 1e3, suffix: 'k' }
  ];
  const unit = units.find(item => normalized >= item.base) || units[units.length - 1];
  const scaled = normalized / unit.base;
  const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
  const text = scaled
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/g, '$1')
    .replace(/\.$/g, '');
  return `${text}${unit.suffix}`;
}

function buildUsageLine(usage, formatter) {
  if (!usage || typeof usage !== 'object') return '';
  const format = (typeof formatter === 'function') ? formatter : (value => String(value ?? ''));
  const parts = [];
  if (usage.promptTokens != null) parts.push(`in ${format(usage.promptTokens)}`);
  if (usage.completionTokens != null) parts.push(`out ${format(usage.completionTokens)}`);
  if (usage.totalTokens != null) parts.push(`total ${format(usage.totalTokens)}`);
  return parts.join(' · ');
}

// 日期展示策略：
// - 今天：不显示日期（返回空字符串）；
// - 同一年但非今天：显示 M/D；
// - 非本年：显示 YYYY/M/D。
function formatSmartDateLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameMonth = date.getMonth() === now.getMonth();
  const sameDay = date.getDate() === now.getDate();
  if (sameYear && sameMonth && sameDay) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (sameYear) return `${month}/${day}`;
  return `${date.getFullYear()}/${month}/${day}`;
}

function formatTimeHhMm(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function hasTemplateValue(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value);
  return toTrimmedText(value).length > 0;
}

function applyConditionalSections(template, context) {
  let rendered = String(template ?? '');
  const sectionPattern = /{{#\s*([a-zA-Z0-9_]+)\s*}}([\s\S]*?){{\/\s*\1\s*}}/g;
  // 简单多轮替换，支持常见的浅层嵌套条件块。
  for (let i = 0; i < 8; i += 1) {
    let changed = false;
    rendered = rendered.replace(sectionPattern, (_, key, inner) => {
      changed = true;
      return hasTemplateValue(context[key]) ? inner : '';
    });
    if (!changed) break;
  }
  return rendered;
}

function normalizeFooterText(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resolveMatchedConfig(nodeLike, allConfigs) {
  if (!nodeLike || !Array.isArray(allConfigs) || allConfigs.length === 0) return null;
  const targetUuid = toTrimmedText(nodeLike.apiUuid);
  if (!targetUuid) return null;
  return allConfigs.find(config => config?.id === targetUuid) || null;
}

/**
 * 统一归一化 usage 字段，兼容 promptTokens / prompt_tokens 两种命名。
 * @param {any} rawUsage
 * @returns {{promptTokens:number|null,completionTokens:number|null,totalTokens:number|null}|null}
 */
export function normalizeApiUsageMeta(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const promptTokens = normalizeTokenValue(rawUsage.prompt_tokens ?? rawUsage.promptTokens);
  const completionTokens = normalizeTokenValue(rawUsage.completion_tokens ?? rawUsage.completionTokens);
  const totalTokens = normalizeTokenValue(rawUsage.total_tokens ?? rawUsage.totalTokens);
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

/**
 * 生成 footer 模板可用上下文。
 * @param {any} nodeLike - 历史节点或等价对象
 * @param {any|null} matchedConfig - 按 apiUuid 匹配到的当前配置快照
 */
export function buildApiFooterContext(nodeLike, matchedConfig = null) {
  const displayName = toTrimmedText(matchedConfig?.displayName) || toTrimmedText(nodeLike?.apiDisplayName);
  const modelName = toTrimmedText(matchedConfig?.modelName) || toTrimmedText(nodeLike?.apiModelId);
  const apiName = displayName || modelName;
  const hasThoughtSignature = !!nodeLike?.thoughtSignature;
  const usage = normalizeApiUsageMeta(nodeLike?.apiUsage);
  const timestampMs = normalizeTimestampMs(nodeLike?.timestamp);
  const date = (timestampMs != null) ? new Date(timestampMs) : null;
  const promptTokens = usage?.promptTokens ?? '';
  const completionTokens = usage?.completionTokens ?? '';
  const totalTokens = usage?.totalTokens ?? '';
  const promptTokensK = formatTokenCompact(usage?.promptTokens);
  const completionTokensK = formatTokenCompact(usage?.completionTokens);
  const totalTokensK = formatTokenCompact(usage?.totalTokens);
  const usageLine = buildUsageLine(usage, value => formatTokenWithThousands(value));
  const usageLineK = buildUsageLine(usage, value => formatTokenCompact(value));
  const timeLabel = formatTimeHhMm(date);
  const dateLabel = formatSmartDateLabel(date);
  const dateTimeLabel = dateLabel ? `${dateLabel} ${timeLabel}`.trim() : timeLabel;

  const displayLabel = hasThoughtSignature
    ? (apiName ? `signatured · ${apiName}` : 'signatured')
    : apiName;
  const displayWithTotalTokensK = displayLabel
    ? (totalTokensK ? `${displayLabel} · ${totalTokensK} tok` : displayLabel)
    : (totalTokensK ? `${totalTokensK} tok` : '');
  const displayWithUsageK = displayLabel
    ? (usageLineK ? `${displayLabel} · ${usageLineK}` : displayLabel)
    : usageLineK;

  return {
    display_label: displayLabel || '',
    display_with_total_tokens_k: displayWithTotalTokensK,
    display_with_usage_k: displayWithUsageK,
    apiname: apiName || '',
    api_uuid: toTrimmedText(nodeLike?.apiUuid),
    display_name: displayName || '',
    model: modelName || '',
    signature: hasThoughtSignature ? 'signatured' : '',
    signature_prefix: hasThoughtSignature ? 'signatured · ' : '',
    signature_source: toTrimmedText(nodeLike?.thoughtSignatureSource),
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    input_tokens_k: promptTokensK,
    output_tokens_k: completionTokensK,
    total_tokens_k: totalTokensK,
    prompt_tokens_k: promptTokensK,
    completion_tokens_k: completionTokensK,
    usage_line: usageLine,
    usage_line_k: usageLineK,
    timestamp: timestampMs != null ? String(timestampMs) : '',
    time: timeLabel,
    date: dateLabel,
    datetime: dateTimeLabel
  };
}

/**
 * 渲染 footer 模板。
 * 支持：
 * - 变量：{{apiname}}
 * - 条件块：{{#total_tokens}}总: {{total_tokens}}{{/total_tokens}}
 */
export function renderApiFooterTemplate(template, context = {}) {
  const source = (typeof template === 'string') ? template : DEFAULT_AI_FOOTER_TEMPLATE;
  const withSections = applyConditionalSections(source, context);
  const rendered = withSections.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
  return normalizeFooterText(rendered);
}

/**
 * 生成 footer tooltip（标题）文本。
 */
export function buildApiFooterTitle(nodeLike, matchedConfig = null) {
  const displayName = toTrimmedText(matchedConfig?.displayName) || toTrimmedText(nodeLike?.apiDisplayName);
  const modelName = toTrimmedText(matchedConfig?.modelName) || toTrimmedText(nodeLike?.apiModelId);
  const hasThoughtSignature = !!nodeLike?.thoughtSignature;
  const usage = normalizeApiUsageMeta(nodeLike?.apiUsage);
  const titleLines = [
    `API uuid: ${toTrimmedText(nodeLike?.apiUuid) || '-'} | displayName: ${displayName || '-'} | model: ${modelName || '-'}`
  ];
  if (hasThoughtSignature) {
    titleLines.push('thought_signature: stored');
  }
  if (usage?.promptTokens != null) titleLines.push(`prompt_tokens: ${usage.promptTokens}`);
  if (usage?.completionTokens != null) titleLines.push(`completion_tokens: ${usage.completionTokens}`);
  if (usage?.totalTokens != null) titleLines.push(`total_tokens: ${usage.totalTokens}`);
  return titleLines.join('\n');
}

/**
 * 一次性输出 footer 渲染结果，供 UI 层直接消费。
 */
export function buildApiFooterRenderData(nodeLike, options = {}) {
  const allConfigs = Array.isArray(options.allConfigs) ? options.allConfigs : [];
  const matchedConfig = resolveMatchedConfig(nodeLike, allConfigs);
  const context = buildApiFooterContext(nodeLike, matchedConfig);
  const text = renderApiFooterTemplate(options.template, context);
  const title = buildApiFooterTitle(nodeLike, matchedConfig);
  return {
    text,
    title,
    context,
    matchedConfig
  };
}
