/**
 * Responses 自定义工具输出工具。
 *
 * 这里统一解决三件事：
 * 1. JS 工具返回对象 / 数组时，默认转成稳定、可读的 JSON 文本；
 * 2. 过长输出按接近 Codex 的思路做中间截断，避免上下文被意外撑爆；
 * 3. 需要时把长文本切成多个 input_text content item，避免“大块 JSON 字符串二次转义”。
 */

const APPROX_BYTES_PER_TOKEN = 4;

// 参考 Codex 在历史/工具输出路径里常见的 2_500 token 级别预算，
// 这里为浏览器 JS 工具也采用同量级上限，既能保留足够上下文，又不容易把后续 hop 撑爆。
export const RESPONSES_TOOL_OUTPUT_MAX_TOKENS = 2_500;
export const RESPONSES_TOOL_OUTPUT_MAX_BYTES = RESPONSES_TOOL_OUTPUT_MAX_TOKENS * APPROX_BYTES_PER_TOKEN;
export const RESPONSES_TOOL_OUTPUT_CHUNK_CHARS = 3_000;

function approxTokensFromByteCount(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric / APPROX_BYTES_PER_TOKEN);
}

function describeDomLikeValue(value) {
  if (!value || typeof value !== 'object') return null;
  const nodeType = Number(value.nodeType);
  const nodeName = typeof value.nodeName === 'string' ? value.nodeName.toLowerCase() : '';
  if (!Number.isFinite(nodeType) || !nodeName) return null;
  const id = typeof value.id === 'string' && value.id ? `#${value.id}` : '';
  const className = typeof value.className === 'string' && value.className.trim()
    ? `.${value.className.trim().split(/\s+/).join('.')}`
    : '';
  return `[DOM ${nodeName}${id}${className}]`;
}

function buildSafeStringifyReplacer() {
  const seen = new WeakSet();
  return function replace(_key, value) {
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
    if (typeof value === 'symbol') return String(value);
    if (value instanceof Error) {
      return {
        name: value.name || 'Error',
        message: value.message || '',
        stack: typeof value.stack === 'string' ? value.stack : ''
      };
    }
    const domLike = describeDomLikeValue(value);
    if (domLike) return domLike;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * 把任意工具返回值压成适合模型和 UI 阅读的文本。
 *
 * 规则：
 * - 字符串保持原样；
 * - 其它值尽量走 JSON pretty stringify；
 * - 若 stringify 失败，则退回 String(value)；
 * - 保证“对象默认可显示”，避免 UI 因 JSON.stringify 失败而一片空白。
 *
 * @param {any} value
 * @returns {string}
 */
export function stringifyResponsesToolOutputValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return 'null';

  try {
    const serialized = JSON.stringify(value, buildSafeStringifyReplacer(), 2);
    if (typeof serialized === 'string') return serialized;
  } catch (_) {}

  try {
    return String(value);
  } catch (_) {
    return '[unserializable]';
  }
}

function splitBudget(maxBytes) {
  const left = Math.floor(maxBytes / 2);
  return [left, maxBytes - left];
}

function splitStringByByteBudget(text, prefixBudget, suffixBudget) {
  if (!text) return { prefix: '', suffix: '', removedChars: 0 };
  const len = text.length;
  const suffixStartTarget = Math.max(0, len - suffixBudget);
  let prefixEnd = 0;
  let suffixStart = len;
  let removedChars = 0;
  let suffixStarted = false;

  let index = 0;
  for (const ch of text) {
    const charEnd = index + ch.length;
    if (charEnd <= prefixBudget) {
      prefixEnd = charEnd;
    } else if (index >= suffixStartTarget) {
      if (!suffixStarted) {
        suffixStart = index;
        suffixStarted = true;
      }
    } else {
      removedChars += 1;
    }
    index = charEnd;
  }

  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  return {
    prefix: text.slice(0, prefixEnd),
    suffix: text.slice(suffixStart),
    removedChars
  };
}

/**
 * 参考 Codex 的截断风格：保留头尾，中间插入 “... N tokens truncated ...” 标记。
 *
 * @param {string} text
 * @param {number} [maxTokens]
 * @returns {string}
 */
export function truncateResponsesToolOutputText(text, maxTokens = RESPONSES_TOOL_OUTPUT_MAX_TOKENS) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  if (!content) return '';

  const byteBudget = Math.max(0, Math.trunc(Number(maxTokens) || RESPONSES_TOOL_OUTPUT_MAX_TOKENS)) * APPROX_BYTES_PER_TOKEN;
  if (byteBudget <= 0) {
    return `…${approxTokensFromByteCount(content.length)} tokens truncated…`;
  }
  if (content.length <= byteBudget) {
    return content;
  }

  const removedBytes = content.length - byteBudget;
  const removedTokens = approxTokensFromByteCount(removedBytes);
  const marker = `…${removedTokens} tokens truncated…`;
  const [prefixBudget, suffixBudget] = splitBudget(byteBudget);
  const { prefix, suffix } = splitStringByByteBudget(content, prefixBudget, suffixBudget);
  return `${prefix}${marker}${suffix}`;
}

function chunkTextByChars(text, chunkChars = RESPONSES_TOOL_OUTPUT_CHUNK_CHARS) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  if (!content) return [];
  const chars = Array.from(content);
  const size = Math.max(1, Math.trunc(Number(chunkChars) || RESPONSES_TOOL_OUTPUT_CHUNK_CHARS));
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''));
  }
  return chunks;
}

/**
 * 构造可直接塞进 Responses `function_call_output.output` 的 body。
 *
 * 说明：
 * - 这里默认返回 content items，而不是单个 JSON 字符串；
 * - 好处是避免“大块 JSON 字符串被再包一层字符串”的二次转义噪音；
 * - 模型看到的是多段 input_text 文本，UI 也可以直接拼回自然文本展示。
 *
 * @param {any} value
 * @param {{maxTokens?:number, chunkChars?:number}} [options]
 * @returns {Array<{type:'input_text', text:string}>}
 */
export function buildResponsesToolOutputContentItems(value, options = {}) {
  const serialized = stringifyResponsesToolOutputValue(value);
  const truncated = truncateResponsesToolOutputText(
    serialized,
    Number.isFinite(Number(options?.maxTokens))
      ? Number(options.maxTokens)
      : RESPONSES_TOOL_OUTPUT_MAX_TOKENS
  );
  const chunks = chunkTextByChars(
    truncated,
    Number.isFinite(Number(options?.chunkChars))
      ? Number(options.chunkChars)
      : RESPONSES_TOOL_OUTPUT_CHUNK_CHARS
  );
  return chunks.map((text) => ({
    type: 'input_text',
    text
  }));
}

/**
 * 将 function_call_output.output 正规化成适合 UI 展示的文本。
 *
 * 兼容：
 * - 旧格式：JSON 字符串
 * - 新格式：input_text content items 数组
 * - 极端情况：直接传对象/数组
 *
 * @param {any} body
 * @returns {string}
 */
export function formatResponsesToolOutputForDisplay(body) {
  if (body == null) return '';

  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return '';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return text;
    }
  }

  if (Array.isArray(body)) {
    const textChunks = body
      .map((item) => {
        if (item && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string') {
          return item.text;
        }
        return null;
      })
      .filter(value => typeof value === 'string');

    if (textChunks.length === body.length && textChunks.length > 0) {
      const joined = textChunks.join('');
      try {
        return JSON.stringify(JSON.parse(joined), null, 2);
      } catch (_) {
        return joined;
      }
    }

    return stringifyResponsesToolOutputValue(body);
  }

  if (typeof body === 'object') {
    return stringifyResponsesToolOutputValue(body);
  }

  return String(body);
}

export function hasResponsesToolOutputBody(body) {
  return formatResponsesToolOutputForDisplay(body).trim() !== '';
}
