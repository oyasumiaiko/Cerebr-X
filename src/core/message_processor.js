/**
 * 消息处理模块 - 负责消息的显示、更新和格式化
 * @module MessageProcessor
 */

/**
 * 创建消息处理器实例
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {Object} appContext.services.chatHistoryManager - 聊天历史管理器
 * @param {Function} appContext.services.imageHandler.processImageTags - 处理图片标签的函数
 * @param {boolean} [appContext.settingsManager.getSetting('showReference')=true] - 是否显示引用标记
 * @returns {Object} 消息处理API
 */
export function createMessageProcessor(appContext) {
  const {
    dom,
    services,
    utils
  } = appContext;

  const chatContainer = dom.chatContainer;
  const chatHistoryManager = services.chatHistoryManager;
  const imageHandler = services.imageHandler;
  const settingsManager = services.settingsManager;
  const scrollToBottom = utils.scrollToBottom;
  const showReference = settingsManager.getSetting('showReference');
  
  // 配置常量
  const MATH_DELIMITERS = {
    delimiters: [
      { left: '\\(', right: '\\)', display: false },  // 行内公式
      { left: '\\\\(', right: '\\\\)', display: false },  // 行内公式
      { left: '\\[', right: '\\]', display: true },   // 行间公式
      { left: '$$', right: '$$', display: true },     // 行间公式
      { left: '$', right: '$', display: false }       // 行内公式
    ],
    throwOnError: false,
    renderConfig: {
      throwOnError: false
    }
  };

  /**
   * 添加消息到聊天窗口
   * @param {string} text - 消息文本内容
   * @param {string} sender - 发送者 ('user' 或 'ai')
   * @param {boolean} skipHistory - 是否不更新历史记录
   * @param {DocumentFragment|null} fragment - 如使用文档片段则追加到此处，否则直接追加到聊天容器
   * @param {string|null} imagesHTML - 图片部分的 HTML 内容（可为空）
   * @returns {HTMLElement} 新生成的消息元素
   */
  function appendMessage(text, sender, skipHistory = false, fragment = null, imagesHTML = null) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', `${sender}-message`);

    // 如果是批量加载，添加特殊类名
    if (fragment) {
      messageDiv.classList.add('batch-load');
    }

    // 存储原始文本用于复制
    messageDiv.setAttribute('data-original-text', text);
    
    // 如果存在图片内容，则创建图片区域容器
    if (imagesHTML && imagesHTML.trim()) {
      const imageContentDiv = document.createElement('div');
      imageContentDiv.classList.add('image-content');
      imageContentDiv.innerHTML = imagesHTML;
      // 为图片添加点击预览事件
      imageContentDiv.querySelectorAll('img').forEach(img => {
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          imageHandler.showImagePreview(img.src);
        });
      });
      messageDiv.appendChild(imageContentDiv);
    }

    // 创建文本内容容器，并处理 Markdown 与数学公式
    const textContentDiv = document.createElement('div');
    textContentDiv.classList.add('text-content');
    try {
      textContentDiv.innerHTML = processMathAndMarkdown(text);
    } catch (error) {
      console.error('处理数学公式和Markdown失败:', error);
      textContentDiv.innerText = text;
    }
    messageDiv.appendChild(textContentDiv);
    
    // 处理消息中的其他元素
    messageDiv.querySelectorAll('a').forEach(link => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });

    // 处理代码块的语法高亮
    messageDiv.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    // 渲染 LaTeX 公式
    try {
      renderMathInElement(messageDiv, MATH_DELIMITERS.renderConfig);
    } catch (error) {
      console.error('渲染LaTeX公式失败:', error);
      // 渲染失败时保持原样
    }

    // 如果提供了文档片段，添加到片段中；否则直接添加到聊天容器
    if (fragment) {
      fragment.appendChild(messageDiv);
    } else {
      chatContainer.appendChild(messageDiv);
    }
    
    // 更新聊天历史，将文本和图片信息封装到一个对象中
    if (!skipHistory) {
      const processedContent = imageHandler.processImageTags(text, imagesHTML);
      const node = chatHistoryManager.addMessageToTree(
        sender === 'user' ? 'user' : 'assistant',
        processedContent,
        chatHistoryManager.chatHistory.currentNode
      );

      // 为消息div添加节点ID
      messageDiv.setAttribute('data-message-id', node.id);

      if (sender === 'ai') {
        messageDiv.classList.add('updating');
      }
    }

    return messageDiv;
  }

  /**
   * 更新AI消息内容
   * @param {string} aiResponse - 消息文本内容
   * @param {Object|null} groundingMetadata - 引用元数据对象，包含引用信息
   */
  function updateAIMessage(aiResponse, groundingMetadata) {
    const lastMessage = chatContainer.querySelector('.ai-message:last-child');

    if (lastMessage) {
      // 获取当前显示的文本
      const currentText = lastMessage.getAttribute('data-original-text') || '';
      // 如果新文本比当前文本长，说明有新内容需要更新
      if (aiResponse.length > currentText.length) {
        // 更新原始文本属性
        lastMessage.setAttribute('data-original-text', aiResponse);

        let processedText = aiResponse;
        let htmlElements = [];
        let processedResult = aiResponse;

        // 处理引用标记和来源信息(如果存在)
        if (groundingMetadata) {
          processedResult = addGroundingToMessage(aiResponse, groundingMetadata);
          if (typeof processedResult === 'object') {
            processedText = processedResult.text;
            htmlElements = processedResult.htmlElements;
          }
        }

        // 处理数学公式和Markdown
        let renderedHtml = processMathAndMarkdown(processedText);
        lastMessage.innerHTML = renderedHtml;

        // 处理新渲染的链接
        lastMessage.querySelectorAll('a').forEach(link => {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        });

        // 处理代码块的语法高亮
        lastMessage.querySelectorAll('pre code').forEach(block => {
          hljs.highlightElement(block);
        });

        // 渲染LaTeX公式
        renderMathInElement(lastMessage, MATH_DELIMITERS.renderConfig);

        if (groundingMetadata) {
          // 替换引用标记占位符为HTML元素
          if (htmlElements && htmlElements.length > 0) {
            htmlElements.forEach(element => {
              const placeholder = element.placeholder;
              const html = element.html;
              lastMessage.innerHTML = lastMessage.innerHTML.replace(placeholder, html);
            });
          }

          // 清理任何剩余的未替换placeholder
          lastMessage.innerHTML = lastMessage.innerHTML.replace(/\u200B😎REF_\d+😎\u200B/g, '');

          // 添加引用来源列表
          if (typeof processedResult === 'object' && processedResult.sources && processedResult.sources.length > 0) {
            renderSourcesList(lastMessage, processedResult, groundingMetadata);
          }
        }

        // 更新历史记录
        const messageId = lastMessage.getAttribute('data-message-id');
        if (messageId && chatHistoryManager.chatHistory.messages) {
          const node = chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId);
          if (node) {
            node.content = aiResponse;
          }
        }

        // 执行滚动
        scrollToBottom();
      }
    } else {
      appendMessage(aiResponse, 'ai');
    }
  }

  /**
   * 为消息添加引用标记和来源信息
   * @param {string} text - 原始消息文本
   * @param {Object} groundingMetadata - 引用元数据对象
   * @returns {(string|Object)} 处理后的结果对象或原文本
   */
  function addGroundingToMessage(text, groundingMetadata) {
    if (!groundingMetadata?.groundingSupports) return text;

    // Dynamically get showReference setting
    const showReferenceSetting = settingsManager.getSetting('showReference');

    let markedText = text;
    const htmlElements = [];
    const orderedSources = [];
    const webSearchQueries = groundingMetadata.webSearchQueries || [];

    // 创建URL到引用编号的映射
    const urlToRefNumber = new Map();
    let nextRefNumber = 1;

    // 记录每个文本片段在原文中的位置
    const textPositions = groundingMetadata.groundingSupports
        .filter(support => support.segment?.text)
        .map(support => {
            const pos = text.indexOf(support.segment.text);
            return {
                support,
                position: pos >= 0 ? pos : Number.MAX_SAFE_INTEGER
            };
        })
        .sort((a, b) => a.position - b.position);

    textPositions.forEach(({ support }, index) => {
        const placeholder = `\u200B😎REF_${index}😎\u200B`;

        // 转义正则表达式特殊字符
        const escapedText = support.segment.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedText, 'g');

        // 收集该文本片段的所有引用源和对应的置信度
        const sourceRefs = [];
        if (support.groundingChunkIndices?.length > 0) {
            support.groundingChunkIndices.forEach((chunkIndex, idx) => {
                const chunk = groundingMetadata.groundingChunks[chunkIndex];
                const confidence = support.confidenceScores?.[idx] || 0;

                if (chunk?.web) {
                    const url = chunk.web.uri;
                    if (!urlToRefNumber.has(url)) {
                        urlToRefNumber.set(url, nextRefNumber++);
                    }
                    sourceRefs.push({
                        refNumber: urlToRefNumber.get(url),
                        title: chunk.web.title,
                        url: url,
                        confidence: confidence
                    });
                }
            });
        }

        // 按引用编号排序
        sourceRefs.sort((a, b) => a.refNumber - b.refNumber);

        // 生成引用标记
        const refMark = sourceRefs.map(ref =>
            `<a href="${encodeURI(ref.url)}" 
                class="reference-number superscript" 
                target="_blank" 
                data-ref-number="${ref.refNumber}"
                >[${ref.refNumber}]</a>`
        ).join('');

        // 构建包含所有源信息的tooltip
        const tooltipContent = `
            <span class="reference-tooltip">
                ${sourceRefs.map(ref => `
                    <span class="reference-source">
                        <span class="ref-number">[${ref.refNumber}]</span>
                        <a href="${encodeURI(ref.url)}" target="_blank">${ref.title}</a>
                        <span class="confidence">${(ref.confidence * 100).toFixed(1)}%</span>
                    </span>
                `).join('')}
            </span>
        `;

        // 包装引用标记组
        const refGroup = `
            <span class="reference-mark-group">
                ${refMark}
                <span class="reference-tooltip-wrapper">${tooltipContent}</span>
            </span>
        `;

        if (showReferenceSetting) {
            // 替换文本并添加引用标记
            markedText = markedText.replace(regex, `$&${placeholder}`);
            htmlElements.push({
                placeholder,
                html: refGroup
            });
        }

        // 添加到有序来源列表
        sourceRefs.forEach(ref => {
            if (!orderedSources.some(s => s.refNumber === ref.refNumber)) {
                orderedSources.push({
                    refNumber: ref.refNumber,
                    domain: ref.title,
                    url: ref.url
                });
            }
        });
    });

    return {
        text: markedText,
        htmlElements,
        sources: orderedSources.sort((a, b) => a.refNumber - b.refNumber),
        webSearchQueries
    };
  }
  /**
   * 渲染来源列表
   * @param {HTMLElement} messageElement - 消息元素
   * @param {Object} processedResult - 处理后的结果对象
   * @param {Object} groundingMetadata - 引用元数据
   */
  function renderSourcesList(messageElement, processedResult, groundingMetadata) {
    // 创建并添加引用来源列表
    const sourcesList = document.createElement('div');
    sourcesList.className = 'sources-list';

    // 创建可折叠的标题
    const titleContainer = document.createElement('div');
    titleContainer.className = 'sources-title-container';
    titleContainer.innerHTML = `
      <h4 class="sources-title">
        <span class="expand-icon">▶</span> 
        参考来源 (${processedResult.sources.length})
      </h4>
    `;

    const sourcesContent = document.createElement('div');
    sourcesContent.className = 'sources-content';
    sourcesContent.style.display = 'none'; // 默认隐藏

    const ul = document.createElement('ul');

    // 计算每个来源的平均置信度
    const sourceConfidences = new Map();
    const sourceConfidenceCounts = new Map();

    groundingMetadata.groundingSupports.forEach(support => {
      if (support.groundingChunkIndices && support.confidenceScores) {
        support.groundingChunkIndices.forEach((chunkIndex, idx) => {
          const chunk = groundingMetadata.groundingChunks[chunkIndex];
          const confidence = support.confidenceScores[idx] || 0;

          if (chunk?.web?.uri) {
            const url = chunk.web.uri;
            sourceConfidences.set(url, (sourceConfidences.get(url) || 0) + confidence);
            sourceConfidenceCounts.set(url, (sourceConfidenceCounts.get(url) || 0) + 1);
          }
        });
      }
    });

    processedResult.sources.forEach(source => {
      const li = document.createElement('li');
      const totalConfidence = sourceConfidences.get(source.url) || 0;
      const count = sourceConfidenceCounts.get(source.url) || 1;
      const avgConfidence = (totalConfidence / count) * 100;

      // 创建置信度进度条容器
      const confidenceBar = document.createElement('div');
      confidenceBar.className = 'confidence-bar';

      // 创建进度条
      const progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      progressBar.style.width = `${avgConfidence}%`;

      // 添加进度条到容器
      confidenceBar.appendChild(progressBar);

      // 收集该来源的所有匹配文本和置信度
      const matchingTexts = [];
      groundingMetadata.groundingSupports.forEach(support => {
        if (support.groundingChunkIndices && support.confidenceScores) {
          support.groundingChunkIndices.forEach((chunkIndex, idx) => {
            const chunk = groundingMetadata.groundingChunks[chunkIndex];
            if (chunk?.web?.uri === source.url) {
              matchingTexts.push({
                text: support.segment.text,
                confidence: support.confidenceScores[idx] * 100
              });
            }
          });
        }
      });

      // 创建悬浮提示内容
      const tooltipContent = matchingTexts.map(match =>
        `<div class="match-item">
          <div class="match-text">${match.text}</div>
          <div class="match-confidence">${match.confidence.toFixed(1)}%</div>
        </div>`
      ).join('');

      li.innerHTML = `
        <div class="source-item">
          <div class="source-info">
            [${source.refNumber}] <a href="${encodeURI(source.url)}" target="_blank">${source.domain}</a>
            <span class="confidence-text">
              ${avgConfidence.toFixed(1)}% (${count}次引用)
            </span>
          </div>
          <div class="source-tooltip">
            <div class="tooltip-content">
              <h4>匹配内容：</h4>
              ${tooltipContent}
            </div>
          </div>
        </div>
      `;

      // 新增：添加点击事件，使点击 .confidence-text 打开对应网页
      const confidenceTextElem = li.querySelector('.confidence-text');
      if (confidenceTextElem) {
        confidenceTextElem.style.cursor = 'pointer';
        confidenceTextElem.addEventListener('click', () => {
          window.open(source.url, '_blank');
        });
      }

      // 将进度条插入到source-item中
      const sourceItem = li.querySelector('.source-item');
      sourceItem.appendChild(confidenceBar);

      ul.appendChild(li);
    });

    // 添加点击事件处理展开/收起
    titleContainer.addEventListener('click', () => {
      const expandIcon = titleContainer.querySelector('.expand-icon');
      const isExpanded = sourcesContent.style.display !== 'none';
      
      expandIcon.textContent = isExpanded ? '▶' : '▼';
      sourcesContent.style.display = isExpanded ? 'none' : 'block';
    });

    sourcesList.appendChild(titleContainer);
    sourcesList.appendChild(sourcesContent);
    sourcesContent.appendChild(ul);

    messageElement.appendChild(sourcesList);

    // 添加Web搜索查询部分(如果存在)
    if (processedResult.webSearchQueries && processedResult.webSearchQueries.length > 0) {
      renderWebSearchQueries(messageElement, processedResult.webSearchQueries);
    }
  }

  /**
   * 渲染Web搜索查询列表
   * @param {HTMLElement} messageElement - 消息元素
   * @param {Array<string>} queries - 查询列表 
   */
  function renderWebSearchQueries(messageElement, queries) {
    const searchQueriesList = document.createElement('div');
    searchQueriesList.className = 'search-queries-list';
    searchQueriesList.innerHTML = '<h4>搜索查询：</h4>';
    const ul = document.createElement('ul');

    queries.forEach(query => {
      const li = document.createElement('li');
      li.textContent = query;
      li.addEventListener('click', () => {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        window.open(searchUrl, '_blank');
      });
      ul.appendChild(li);
    });

    searchQueriesList.appendChild(ul);
    messageElement.appendChild(searchQueriesList);
  }

  /**
   * 获取提示词类型
   * @param {HTMLElement|string} content - 输入内容，可以是HTML元素或字符串
   * @param {Object} prompts - 提示词设置对象
   * @returns {string} 提示词类型 ('image'|'pdf'|'summary'|'selection'|'query'|'none')
   */
  function getPromptTypeFromContent(content, prompts) {
    if (!prompts) return 'none';
    // 归一化输入文本（去掉前后空白）
    const normalizedContent = (typeof content === 'string') ? content.trim() : content;

    // 如果content是图片提示词，则返回image
    if (prompts.image?.prompt && normalizedContent === prompts.image.prompt.trim()) {
      return 'image';
    }

    // 检查是否是PDF提示词
    if (prompts.pdf?.prompt && normalizedContent === prompts.pdf.prompt.trim()) {
      return 'pdf';
    }

    // 检查是否是页面总结提示词
    if (prompts.summary?.prompt && normalizedContent === prompts.summary.prompt.trim()) {
      return 'summary';
    }

    // 检查是否是划词搜索提示词，将 selection prompt 中的 "<SELECTION>" 移除后进行匹配
    if (prompts.selection?.prompt) {
      const selectionPromptKeyword = prompts.selection.prompt.split('<SELECTION>')[0].trim();
      if (selectionPromptKeyword && normalizedContent.startsWith(selectionPromptKeyword)) {
        return 'selection';
      }
    }

    // 检查是否是普通查询提示词
    if (prompts.query?.prompt) {
      const queryPromptKeyword = prompts.query.prompt.split('<SELECTION>')[0].trim();
      if (queryPromptKeyword && normalizedContent.startsWith(queryPromptKeyword)) {
        return 'query';
      }
    }

    return 'none';
  }

  /**
   * 提取提示文本中的系统消息内容
   *
   * 此函数扫描输入的提示文本，并提取被 {{system}} 和 {{end_system}} 标记包裹的内容，
   * 该内容通常作为系统级指令被单独处理。
   *
   * @param {string} promptText - 包含自定义系统标记的提示文本
   * @returns {string} 返回提取出的系统消息内容；如果不存在则返回空字符串
   * @example
   * // 输入 "请总结以下内容 {{system}}额外指令{{end_system}}"，返回 "额外指令"
   */
  function extractSystemContent(promptText) {
    if (!promptText) return '';
    const regex = /{{system}}([\s\S]*?){{end_system}}/; // 使用捕获组
    const match = promptText.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * 处理数学公式和Markdown
   * @param {string} text - 要处理的文本
   * @returns {string} 处理后的HTML
   */
  function processMathAndMarkdown(text) {
    // 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
    const preHandledText = fixBoldParsingIssue(text);
    
    // 对消息进行折叠处理，将从文本开头到首次出现 "\n# " 之前的部分折叠为可展开元素
    const foldedText = foldMessageContent(preHandledText);

    // 预处理数学表达式
    const { text: escapedText, mathExpressions } = preMathEscape(foldedText);

    // 处理未闭合的代码块
    let processedText = escapedText;
    const codeBlockRegex = /```/g;
    if (((processedText || '').match(codeBlockRegex) || []).length % 2 > 0) {
      processedText += '\n```';
    }
    
    // 配置marked
    marked.setOptions({
      breaks: true,
      gfm: true,
      sanitize: false,
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch (err) {
            return code;
          }
        }
        return code;
      }
    });

    // 设置表格渲染器
    const renderer = new marked.Renderer();
    renderer.table = function (header, body) {
      return `<table class="markdown-table">\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
    };
    marked.use({ renderer });

    // 渲染Markdown
    const renderedMarkdown = marked.parse(processedText);

    // 替换数学表达式
    return postMathReplace(renderedMarkdown, mathExpressions);
  }

  /**
   * 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
   * @param {string} text - 原始文本
   * @returns {string} 处理后的文本
   */
  function fixBoldParsingIssue(text) {
    // 在所有**前后添加零宽空格，以修复粗体解析问题
    return text.replace(/\*\*/g, '\u200B**\u200B');
  }

  /**
   * 根据正则折叠消息文本，使用自定义正则表达式和摘要文本
   * @param {string} text - 原始消息文本
   * @returns {string} 处理后的消息文本，其中符合条件的部分被包裹在一个折叠元素中
   */
  function foldMessageContent(text) {
    // 尝试从 Chrome 存储中获取折叠设置
    let regexPattern = /^([\s\S]*)<\/search>/; // 默认正则
    let summary = '搜索过程'; // 默认摘要文本
    
    // 应用正则表达式
    const match = text.match(regexPattern);
    if (!match || (match[1] && match[1].trim() === '')) {
      return text;
    }
    
    const foldedPart = match[1];
    const remainingPart = text.slice(match[0].length);
    
    // 将折叠部分包裹在 <blockquote> 中，以实现 Markdown 引用效果
    const quotedFoldedPart = `<blockquote>${foldedPart}</blockquote>`;
    return `<details class="folded-message"><summary>${summary}</summary><div>\n${quotedFoldedPart}</div></details>\n\n${remainingPart}`;
  }

  /**
   * 预处理数学表达式
   * @param {string} text - 原始文本
   * @returns {Object} 包含处理后的文本和数学表达式的对象
   */
  function preMathEscape(text) {
    let counter = 0;
    const mathExpressions = [];

    // 替换块级数学表达式
    text = text.replace(/(\\\[[\s\S]+?\\\])/g, (match, p1) => {
        const placeholder = `😎BLOCK_MATH_${counter}😎`;
        mathExpressions.push({ placeholder, content: p1.slice(2, -2), originalContent: p1, type: 'block' });
        counter++;
        return placeholder;
    });

    // 替换行内数学表达式
    text = text.replace(/(\\\([\s\S]+?\\\))/g, (match, p1) => {
        const placeholder = `😎INLINE_MATH_${counter}😎`;
        mathExpressions.push({ placeholder, content: p1.slice(2, -2), originalContent: p1, type: 'inline' });
        counter++;
        return placeholder;
    });

    return { text, mathExpressions };
  }

  /**
   * 后处理数学表达式
   * @param {string} text - 处理后的文本
   * @param {Array} mathExpressions - 数学表达式数组
   * @returns {string} 替换数学表达式后的文本
   */
  function postMathReplace(text, mathExpressions) {
    mathExpressions.forEach(({ placeholder, content, originalContent, type }) => {
        let rendered;
        try {
            if (type === 'block' || type === 'dollarblock') {
                rendered = katex.renderToString(content, { displayMode: true, throwOnError: true });
            } else if (type === 'inline' || type === 'dollarinline') {
                rendered = katex.renderToString(content, { displayMode: false, throwOnError: true });
            }
        } catch (e) {
            console.error('KaTeX error:', e);
            rendered = originalContent;
        }
        text = text.replace(placeholder, rendered);
    });

    return text;
  }
  
  // 返回公共API
  return {
    appendMessage,
    updateAIMessage,
    processMathAndMarkdown,
    addGroundingToMessage,
    getPromptTypeFromContent,
    extractSystemContent
  };
} 