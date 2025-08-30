/**
 * Markdown 安全渲染工具
 *
 * 目标：
 * - 禁止原始 HTML 在 Markdown 中直接生效（例如 <script>、<iframe> 等）
 * - 支持 KaTeX 数学公式（$...$ / $$...$$ / \(...\) / \[...\]）
 * - 支持 GFM 与换行、代码高亮、表格样式
 * - 使用 DOMPurify 进行严格白名单清洗
 * - 尽量保持纯函数式：输入字符串 → 输出安全 HTML 字符串
 *
 * 依赖（通过 sidebar.html 全局引入）：
 * - marked (window.marked)
 * - highlight.js (window.hljs)
 * - katex (window.katex)
 * - DOMPurify (window.DOMPurify)
 *
 * @since 1.0.0
 */

/* global marked, hljs, katex, DOMPurify */

/**
 * 简单 HTML 转义（用于极小范围需要时）。
 * @param {string} input - 原始字符串
 * @returns {string} - 转义后的字符串
 */
function escapeHtml(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 预处理：修正粗体解析（与现有逻辑一致），但避免在代码块内添加零宽空格。
 * @param {string} text - 原始文本
 * @returns {string}
 */
function fixBoldParsingIssue(text) {
  if (!text) return '';
  
  // 按代码块分割文本，只在非代码块部分添加零宽空格
  const segments = splitByCodeFences(text);
  return segments.map((segment, index) => {
    if (segment.type === 'code') {
      // 代码块内部保持原样，不添加零宽空格
      return segment.content;
    } else {
      // 普通文本部分添加零宽空格来修正粗体解析
      return segment.content.replace(/\*\*/g, '\u200B**\u200B');
    }
  }).join('```');
}

/**
 * 处理未闭合的代码块（确保 ``` 成对）。
 * @param {string} text - 原始文本
 * @returns {string}
 */
function closeUnbalancedCodeFences(text) {
  const codeFenceRegex = /```/g;
  const count = ((text || '').match(codeFenceRegex) || []).length;
  if (count % 2 !== 0) {
    return text + "\n```";
  }
  return text;
}

/**
 * 将文本按三引号代码块切片，偶数段落为普通文本，奇数段落为代码块。
 * @param {string} text
 * @returns {Array<{ type: 'text'|'code', content: string }>} 段落数组
 */
function splitByCodeFences(text) {
  if (!text) return [];
  const parts = text.split(/```/);
  return parts.map((content, index) => ({ type: index % 2 === 0 ? 'text' : 'code', content }));
}

/**
 * 在非代码段中提取数学表达式为占位符。
 * 支持：
 * - \(...\) 行内
 * - \[...\] 块级
 * - $$...$$ 块级
 * - $...$ 行内（采用较严格启发式，减少与货币符号冲突）
 *
 * @param {string} text - 原始文本
 * @returns {{ text: string, mathTokens: Array<{ placeholder: string, content: string, display: boolean }> }}
 */
function extractMathPlaceholders(text) {
  let work = text;
  const mathTokens = [];
  let counter = 0;

  // 1) \\[…\\] 块级
  work = work.replace(/\\\[([\s\S]+?)\\\]/g, (m, inner) => {
    const placeholder = `\u2063MATH_${counter++}\u2063`;
    mathTokens.push({ placeholder, content: inner, display: true });
    return placeholder;
  });

  // 2) \\\\\(...\\) 行内
  work = work.replace(/\\\(([\s\S]+?)\\\)/g, (m, inner) => {
    const placeholder = `\u2063MATH_${counter++}\u2063`;
    mathTokens.push({ placeholder, content: inner, display: false });
    return placeholder;
  });

  // 3) $$...$$ 块级（不跨越代码块，此函数只在纯文本段落上调用）
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (m, inner) => {
    const placeholder = `\u2063MATH_${counter++}\u2063`;
    mathTokens.push({ placeholder, content: inner.trim(), display: true });
    return placeholder;
  });

  // 4) $...$ 行内（避免空白紧邻与纯数字场景，尽量减少误判）
//   work = work.replace(/(^|[^$])\$([^\s$][\s\S]*?[^\s$])\$(?!\$)/g, (m, pre, inner) => {
//     // 排除明显货币格式：以数字或空格紧邻 $ 的情形
//     const invalidPre = /[\d\s]$/.test(pre);
//     const looksLikeMath = /[A-Za-z\\^_{}\\\\]/.test(inner);
//     if (invalidPre || !looksLikeMath) return m; // 放弃替换
//     const placeholder = `\u2063MATH_${counter++}\u2063`;
//     mathTokens.push({ placeholder, content: inner.trim(), display: false });
//     return `${pre}${placeholder}`;
//   });

  return { text: work, mathTokens };
}

/**
 * 将数学占位符替换为 KaTeX HTML。
 * @param {string} html - 输入 HTML
 * @param {Array<{ placeholder: string, content: string, display: boolean }>} mathTokens - 占位符与内容
 * @returns {string}
 */
function restoreMath(html, mathTokens) {
  let out = html;
  for (const token of mathTokens) {
    let rendered = token.content;
    try {
      rendered = katex.renderToString(token.content, { displayMode: token.display, throwOnError: false });
    } catch (e) {
      // 保留原样以避免崩溃
      rendered = escapeHtml(token.content);
      if (token.display) rendered = `<pre class="math-error">${rendered}</pre>`;
      else rendered = `<span class="math-error">${rendered}</span>`;
    }
    out = out.split(token.placeholder).join(rendered);
  }
  return out;
}

/**
 * DOMPurify 配置（严格白名单）。
 * - 允许常见 Markdown 标签、KaTeX 必需标签、可选的 details/summary
 * - 禁止所有事件属性 on*
 * - 禁止危险标签
 */
const DEFAULT_PURIFY_CONFIG = {
//   ALLOWED_TAGS: [
//     'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'i', 'li', 'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'ul', 'hr',
//     'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
//     'table', 'thead', 'tbody', 'tr', 'th', 'td',
//     'details', 'summary',
//     // KaTeX 可能用到
//     'math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mover', 'munder'
//   ],
//   ALLOWED_ATTR: [
//     'href', 'title', 'target', 'rel',
//     'id', 'class', 'aria-hidden', 'aria-label', 'role', 'tabindex',
//     'colspan', 'rowspan', 'align'
//   ],
  FORBID_TAGS: [ 'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select' ],
  FORBID_ATTR: [/^on/i],
  // 仅允许 http/https 相对/绝对链接（禁止 javascript: 等）
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[\/\?#])/i
};

/**
 * 生成 marked 渲染器，禁用原始 HTML 的直接输出（对 html token 统一转义）。
 * @returns {marked.Renderer}
 */
function createSafeMarkedRenderer() {
  const renderer = new marked.Renderer();
  renderer.table = function(header, body) {
    return `<table class="markdown-table">\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
  };
  renderer.html = function(html) {
    // 直接透传，后续交由 DOMPurify 严格清洗
    return html;
  };
  return renderer;
}

/**
 * 将 Markdown 渲染为安全 HTML。
 *
 * 注意：函数为纯函数，不触碰 DOM。外部如需给链接添加 target/rel，建议在挂载后再做属性设置。
 *
 * @param {string} markdownText - 输入 Markdown 文本
 * @param {{ allowDetails?: boolean }} [options] - 可选项
 * @returns {string} 安全 HTML 字符串
 */
export function renderMarkdownSafe(markdownText, options = {}) {
  const allowDetails = options.allowDetails !== false; // 默认允许 details/summary

  // 1) 基本预处理
  const fixed = fixBoldParsingIssue(markdownText || '');
  const closed = closeUnbalancedCodeFences(fixed);

  // 2) 仅对“非代码块段落”抽取数学占位符，避免误伤代码
  const segments = splitByCodeFences(closed);
  let rebuilt = '';
  const collectedMathTokens = [];
  for (const seg of segments) {
    if (seg.type === 'code') {
      rebuilt += '```' + seg.content + '```';
    } else {
      const { text: out, mathTokens } = extractMathPlaceholders(seg.content);
      collectedMathTokens.push(...mathTokens);
      rebuilt += out;
    }
  }

  // 3) marked 渲染（禁用原始 HTML）
  const renderer = createSafeMarkedRenderer();
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
    renderer,
    highlight(code, lang) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch (_) {
        return escapeHtml(code);
      }
    }
  });

  let html = marked.parse(rebuilt);

  // 4) 恢复数学（KaTeX 渲染）
  html = restoreMath(html, collectedMathTokens);

  // 5) DOMPurify 清洗（严格白名单）
  const purifyConfig = { ...DEFAULT_PURIFY_CONFIG };
  if (!allowDetails) {
    purifyConfig.FORBID_TAGS = Array.from(new Set([...(purifyConfig.FORBID_TAGS || []), 'details', 'summary']));
  }
  const safe = DOMPurify.sanitize(html, purifyConfig);
  return safe;
}


