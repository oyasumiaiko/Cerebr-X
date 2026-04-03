/**
 * Mermaid 渲染辅助工具。
 *
 * 设计目标：
 * - 让 Markdown 渲染阶段继续保持“纯函数”：只输出安全占位 HTML；
 * - 把 Mermaid 真正的 SVG 渲染放到 DOM 挂载后执行，避免污染 Markdown 纯渲染职责；
 * - 统一处理主题跟随、异步渲染竞争、失败回退与布局刷新回调。
 */

/* global mermaid */

let mermaidRenderSequence = 0;
let lastConfiguredThemeSignature = '';
let mermaidRenderQueue = Promise.resolve();

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
 * 判断 fenced code block 的语言标记是否为 mermaid。
 * 仅检查 info string 的首个 token，兼容 ```mermaid、```Mermaid 这类写法。
 * @param {string} infoString
 * @returns {boolean}
 */
export function isMermaidLanguage(infoString) {
  const lang = (typeof infoString === 'string' ? infoString : '').trim().split(/\s+/, 1)[0] || '';
  return /^mermaid$/i.test(lang);
}

/**
 * 为 Markdown 渲染阶段生成 Mermaid 占位节点。
 * 说明：
 * - source 仍以纯文本方式放进 <code> 中，确保 DOMPurify 之后依然安全；
 * - 真正的 SVG 会在挂载后注入到 __canvas；
 * - 失败时会把原始源码重新展示出来，方便用户定位语法问题。
 *
 * @param {string} source
 * @returns {string}
 */
export function createMermaidBlockHtml(source) {
  const safeSource = escapeHtml(typeof source === 'string' ? source.replace(/\n+$/g, '') : '');
  return [
    '<div class="mermaid-diagram is-pending">',
    '  <div class="mermaid-diagram__status" aria-live="polite">Mermaid 图表渲染中...</div>',
    '  <div class="mermaid-diagram__canvas"></div>',
    '  <pre class="mermaid-diagram__source"><code>',
    safeSource,
    '</code></pre>',
    '</div>\n'
  ].join('');
}

function readCssVariable(computedStyle, name, fallback) {
  const value = computedStyle?.getPropertyValue?.(name)?.trim();
  return value || fallback;
}

function isDarkTheme(root) {
  if (!root) return false;
  if (root.classList.contains('dark-theme')) return true;
  if (root.classList.contains('light-theme')) return false;
  try {
    return !!window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  } catch (_) {
    return false;
  }
}

function buildMermaidThemeConfig() {
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const darkMode = isDarkTheme(root);

  const textColor = readCssVariable(computed, '--cerebr-text-color', darkMode ? '#d8dee9' : '#24292e');
  const borderColor = readCssVariable(computed, '--cerebr-border-color', darkMode ? '#4c566a' : '#d0d7de');
  const highlightColor = readCssVariable(computed, '--cerebr-highlight', darkMode ? '#61afef' : '#0366d6');
  const aiBackground = readCssVariable(computed, '--cerebr-message-ai-bg', darkMode ? '#2c313c' : '#f5f5f5');
  const inputBackground = readCssVariable(computed, '--cerebr-input-bg', darkMode ? '#21252b' : '#f8f8f8');
  const codeBackground = readCssVariable(computed, '--cerebr-code-bg', darkMode ? '#282c34' : '#f6f8fa');
  const tooltipBackground = readCssVariable(computed, '--cerebr-tooltip-bg', darkMode ? '#21252b' : '#ffffff');

  const themeVariables = {
    darkMode,
    background: 'transparent',
    fontFamily: 'inherit',
    primaryColor: aiBackground,
    primaryTextColor: textColor,
    primaryBorderColor: borderColor,
    secondaryColor: inputBackground,
    secondaryTextColor: textColor,
    secondaryBorderColor: borderColor,
    tertiaryColor: codeBackground,
    tertiaryTextColor: textColor,
    tertiaryBorderColor: borderColor,
    mainBkg: aiBackground,
    secondBkg: inputBackground,
    tertiaryBkg: codeBackground,
    clusterBkg: inputBackground,
    clusterBorder: borderColor,
    actorBkg: aiBackground,
    actorBorder: borderColor,
    actorTextColor: textColor,
    noteBkg: tooltipBackground,
    noteTextColor: textColor,
    noteBorderColor: borderColor,
    edgeLabelBackground: tooltipBackground,
    activationBorderColor: highlightColor,
    activationBkgColor: inputBackground,
    sequenceNumberColor: textColor,
    lineColor: highlightColor,
    textColor
  };

  const signature = JSON.stringify([
    darkMode,
    textColor,
    borderColor,
    highlightColor,
    aiBackground,
    inputBackground,
    codeBackground,
    tooltipBackground
  ]);

  return {
    signature,
    config: {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: 'inherit',
      themeVariables
    }
  };
}

function ensureMermaidConfigured() {
  if (!mermaid || typeof mermaid.initialize !== 'function') {
    throw new Error('Mermaid 库未正确加载');
  }

  const { signature, config } = buildMermaidThemeConfig();
  if (signature === lastConfiguredThemeSignature) return;

  mermaid.initialize(config);
  lastConfiguredThemeSignature = signature;
}

function collectMermaidBlocks(rootElement) {
  if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return [];
  const blocks = [];
  if (typeof rootElement.matches === 'function' && rootElement.matches('.mermaid-diagram')) {
    blocks.push(rootElement);
  }
  rootElement.querySelectorAll('.mermaid-diagram').forEach((block) => blocks.push(block));
  return Array.from(new Set(blocks));
}

function setMermaidBlockState(block, nextState, statusText = '') {
  if (!block || !block.classList) return;
  block.classList.remove('is-pending', 'is-ready', 'is-error');
  block.classList.add(`is-${nextState}`);
  block.dataset.mermaidState = nextState;

  const status = block.querySelector('.mermaid-diagram__status');
  if (status) {
    status.textContent = statusText;
  }
}

function normalizeMermaidSource(block) {
  const sourceNode = block?.querySelector?.('.mermaid-diagram__source code');
  const raw = sourceNode?.textContent || '';
  return raw.replace(/^\n+|\n+$/g, '');
}

function enqueueMermaidRender(task) {
  mermaidRenderQueue = mermaidRenderQueue
    .catch(() => {})
    .then(task);
  return mermaidRenderQueue;
}

function cleanupMermaidDetachedArtifact(renderId) {
  if (!renderId) return;
  const detachedNode = document.getElementById(`d${renderId}`);
  if (detachedNode && detachedNode.parentNode) {
    detachedNode.parentNode.removeChild(detachedNode);
  }
}

/**
 * 挂载后增强 Mermaid 占位节点。
 *
 * @param {HTMLElement} rootElement
 * @param {{ force?: boolean, onRenderComplete?: (block: HTMLElement, state: string) => void }} [options]
 */
export function enhanceMermaidDiagrams(rootElement, options = {}) {
  const blocks = collectMermaidBlocks(rootElement);
  if (!blocks.length) return;

  const force = !!options.force;
  const onRenderComplete = typeof options.onRenderComplete === 'function'
    ? options.onRenderComplete
    : null;

  blocks.forEach((block) => {
    const currentState = block.dataset.mermaidState || '';
    if (!force && (currentState === 'ready' || currentState === 'pending' || currentState === 'rendering')) {
      return;
    }

    const source = normalizeMermaidSource(block);
    const canvas = block.querySelector('.mermaid-diagram__canvas');
    if (!canvas || !source) {
      setMermaidBlockState(block, 'error', 'Mermaid 图表源码为空，无法渲染');
      if (onRenderComplete) onRenderComplete(block, 'error');
      return;
    }

    const renderToken = `cerebr_mermaid_${Date.now()}_${mermaidRenderSequence += 1}`;
    block.dataset.mermaidRenderToken = renderToken;
    block.dataset.mermaidState = 'rendering';
    canvas.innerHTML = '';
    setMermaidBlockState(block, 'pending', 'Mermaid 图表渲染中...');

    enqueueMermaidRender(async () => {
      let renderId = '';
      try {
        ensureMermaidConfigured();
        renderId = `cerebr_mermaid_svg_${mermaidRenderSequence += 1}`;
        const result = await mermaid.render(renderId, source);
        if (block.dataset.mermaidRenderToken !== renderToken) return;

        const svgMarkup = typeof result === 'string' ? result : result?.svg || '';
        const bindFunctions = typeof result === 'object' ? result?.bindFunctions : null;
        if (!svgMarkup) {
          throw new Error('Mermaid 未返回可用的 SVG 结果');
        }

        canvas.innerHTML = svgMarkup;
        const svgElement = canvas.querySelector('svg');
        if (svgElement) {
          svgElement.classList.add('mermaid-diagram__svg');
          svgElement.removeAttribute('height');
          svgElement.style.height = 'auto';
          svgElement.style.maxWidth = '100%';
          svgElement.style.display = 'block';
          svgElement.setAttribute('focusable', 'false');
        }

        if (typeof bindFunctions === 'function') {
          bindFunctions(canvas);
        }

        setMermaidBlockState(block, 'ready', '');
        if (onRenderComplete) onRenderComplete(block, 'ready');
      } catch (error) {
        if (block.dataset.mermaidRenderToken !== renderToken) return;

        const reason = error?.message ? String(error.message) : '未知错误';
        canvas.innerHTML = '';
        setMermaidBlockState(block, 'error', `Mermaid 渲染失败：${reason}`);
        if (onRenderComplete) onRenderComplete(block, 'error');
      } finally {
        cleanupMermaidDetachedArtifact(renderId);
      }
    });
  });
}
