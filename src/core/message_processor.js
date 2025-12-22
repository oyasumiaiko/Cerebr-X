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
import { renderMarkdownSafe } from '../utils/markdown_renderer.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';

export function createMessageProcessor(appContext) {
  const {
    dom,
    services,
    utils
  } = appContext;

  const chatContainer = dom.chatContainer;
  const chatHistoryManager = services.chatHistoryManager;
  const imageHandler = services.imageHandler;
  const scrollToBottom = utils.scrollToBottom;
  
  // 保留占位：数学渲染现改为在 Markdown 渲染阶段由 KaTeX 完成

  /**
   * 设置或更新思考过程的显示区域
   * @param {HTMLElement} messageWrapperDiv - 包裹单条消息的顶层div (e.g., .message)
   * @param {string|null} rawThoughts - 原始的思考过程文本，为null则移除该区域
   * @param {Function} processMathAndMarkdownFn - 用于处理Markdown和数学的函数引用
   */
  function setupThoughtsDisplay(messageWrapperDiv, rawThoughts, processMathAndMarkdownFn) {
    let thoughtsContentDiv = messageWrapperDiv.querySelector('.thoughts-content');

    if (rawThoughts && rawThoughts.trim() !== '') {
      let thoughtsInnerContent;
      let expandButton;

      if (!thoughtsContentDiv) {
        thoughtsContentDiv = document.createElement('div');
        thoughtsContentDiv.className = 'thoughts-content'; // .expanded is toggled by button

        const thoughtsPrefix = document.createElement('div');
        thoughtsPrefix.className = 'thoughts-prefix';
        thoughtsPrefix.textContent = '思考摘要（不会发送）:';
        thoughtsContentDiv.appendChild(thoughtsPrefix);

        thoughtsInnerContent = document.createElement('div');
        thoughtsInnerContent.className = 'thoughts-inner-content';
        thoughtsContentDiv.appendChild(thoughtsInnerContent);

        expandButton = document.createElement('button');
        expandButton.className = 'expand-thoughts-btn';
        expandButton.setAttribute('type', 'button'); // Good practice for buttons
        expandButton.setAttribute('aria-label', '切换思考过程');
        expandButton.setAttribute('aria-expanded', 'false');
        // 使用 Font Awesome 图标 - 确保您的项目已包含 Font Awesome
        expandButton.innerHTML = '<i class="fa-light fa-arrows-from-line icon-expand"></i><i class="fa-light fa-arrows-to-line icon-collapse"></i>';
        expandButton.style.fontSize = '1.2em';
        
        expandButton.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent click from bubbling to messageDiv if it has listeners
          const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
          expandButton.setAttribute('aria-expanded', isExpanded.toString());
        });
        // 将按钮放在 thoughts-prefix 之后，但在 inner-content 之前，或根据CSS调整为绝对定位
        // For absolute positioning of button within thoughtsContentDiv, DOM order is less critical for visual.
        // Let's append it directly to thoughtsContentDiv. CSS handles positioning.
        thoughtsContentDiv.appendChild(expandButton);
        
        const textContentElement = messageWrapperDiv.querySelector('.text-content');
        if (textContentElement) {
             messageWrapperDiv.insertBefore(thoughtsContentDiv, textContentElement);
        } else {
             messageWrapperDiv.appendChild(thoughtsContentDiv); // Fallback
        }
      } else {
        // Thoughts section already exists, get its parts
        thoughtsInnerContent = thoughtsContentDiv.querySelector('.thoughts-inner-content');
        expandButton = thoughtsContentDiv.querySelector('.expand-thoughts-btn');
        // Reset expansion state if content is being updated (optional, depends on desired UX)
        // thoughtsContentDiv.classList.remove('expanded');
        // if(expandButton) expandButton.setAttribute('aria-expanded', 'false');
      }
      
      if (thoughtsInnerContent) {
          thoughtsInnerContent.innerHTML = processMathAndMarkdownFn(rawThoughts);
      }
      if (expandButton) { // Ensure button is visible if thoughts exist
          expandButton.style.display = ''; 
      }

    } else if (thoughtsContentDiv) {
      // No new thoughts, or thoughts are cleared, remove the entire thoughts section
      thoughtsContentDiv.remove();
    }
  }

  /**
   * 添加消息到聊天窗口
   * @param {string} text - 消息文本内容
  * @param {string} sender - 发送者 ('user' 或 'ai')
  * @param {boolean} skipHistory - 是否不更新历史记录
  * @param {DocumentFragment|null} fragment - 如使用文档片段则追加到此处，否则直接追加到聊天容器
  * @param {string|null} imagesHTML - 图片部分的 HTML 内容（可为空）
  * @param {string|null} [initialThoughtsRaw=null] - AI的初始思考过程文本 (可选)
  * @param {string|null} [messageIdToUpdate=null] - 如果是更新现有消息，则提供其ID
   * @param {{promptType?: string|null, promptMeta?: Object|null}|null} [meta=null] - 可选：写入历史节点的附加元信息（主要用于用户消息）
   * @returns {HTMLElement} 新生成或更新的消息元素
  */
  function appendMessage(text, sender, skipHistory = false, fragment = null, imagesHTML = null, initialThoughtsRaw = null, messageIdToUpdate = null, meta = null) {
    let messageDiv;
    let node;
    // 提前拆分 <think> 段落，确保正文与思考摘要分离
    let messageText = text;
    let thoughtsForMessage = initialThoughtsRaw;
    if (typeof messageText === 'string') {
      const thinkExtraction = extractThinkingFromText(messageText);
      if (thinkExtraction.thoughtText) {
        thoughtsForMessage = mergeThoughts(thoughtsForMessage, thinkExtraction.thoughtText);
        messageText = thinkExtraction.cleanText;
      }
    }

    if (messageIdToUpdate) {
      messageDiv = chatContainer.querySelector(`[data-message-id="${messageIdToUpdate}"]`);
      if (!messageDiv) {
        console.error('appendMessage: 试图更新的消息未找到 DOM 元素', messageIdToUpdate);
        // Create a new one if update target is missing, this indicates a potential logic flaw elsewhere
        messageDiv = document.createElement('div');
        messageDiv.classList.add('message', `${sender}-message`);
        if (fragment) messageDiv.classList.add('batch-load'); // if it was intended for a fragment
      }
      // For updates, main text and thoughts are handled by updateAIMessage or setupThoughtsDisplay called from there.
      // appendMessage when messageIdToUpdate is present is mostly for ensuring the messageDiv exists.
      // So, we'll mostly clear and let updateAIMessage fill.
      // However, this function signature with messageIdToUpdate might be part of a specific workflow.
      // For now, let's assume if messageIdToUpdate is given, it's for initial AI message shell creation in streaming.
      // And actual content updates will be handled by updateAIMessage.

    } else {
      messageDiv = document.createElement('div');
      messageDiv.classList.add('message', `${sender}-message`);
    }

    if (fragment && !messageIdToUpdate) {
      messageDiv.classList.add('batch-load');
    }

    messageDiv.setAttribute('data-original-text', messageText); // Main answer text
    // thoughtsForMessage is handled below by setupThoughtsDisplay

    if (imagesHTML && imagesHTML.trim() && !messageIdToUpdate) {
      const imageContentDiv = document.createElement('div');
      imageContentDiv.classList.add('image-content');
      imageContentDiv.innerHTML = imagesHTML;
      imageContentDiv.querySelectorAll('img').forEach(img => {
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          imageHandler.showImagePreview(img.src);
        });
      });
      messageDiv.appendChild(imageContentDiv);
    }
    
    // Setup thoughts display (handles creation/removal)
    // Pass `processMathAndMarkdown` from the outer scope
    setupThoughtsDisplay(messageDiv, thoughtsForMessage, processMathAndMarkdown);


    let textContentDiv = messageDiv.querySelector('.text-content');
    if (!textContentDiv) {
        textContentDiv = document.createElement('div');
        textContentDiv.classList.add('text-content');
        // Ensure textContentDiv is after thoughtsDiv if thoughtsDiv was added
        const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
        if (thoughtsDiv && thoughtsDiv.nextSibling) {
            messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
        } else {
            messageDiv.appendChild(textContentDiv);
        }
    }
    try {
      if (sender === 'user') {
        textContentDiv.innerText = messageText;
      } else {
        textContentDiv.innerHTML = processMathAndMarkdown(messageText);
      }
    } catch (error) {
      console.error('处理数学公式和Markdown失败:', error);
      textContentDiv.innerText = messageText;
    }
    
    messageDiv.querySelectorAll('a:not(.reference-number)').forEach(link => { // Avoid affecting reference links
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });

    messageDiv.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    bindInlineImagePreviews(messageDiv);

    // 数学公式已在渲染阶段通过 KaTeX 输出，无需二次 auto-render

    if (!messageIdToUpdate) {
      if (fragment) {
        fragment.appendChild(messageDiv);
      } else {
        chatContainer.appendChild(messageDiv);
      }
    }
    
    // 为消息元素添加双击事件监听器，用于展开/折叠 foldMessageContent 创建的 details 元素
    if (!messageDiv.dataset.dblclickListenerAdded) {
      messageDiv.addEventListener('dblclick', function(event) { // 使用 function 关键字使 this 指向 messageDiv
        const detailsElement = this.querySelector('details.folded-message');
        if (detailsElement) {
          const summaryElement = detailsElement.querySelector('summary');
          if (summaryElement && summaryElement.contains(event.target)) {
            return;
          }

          const scrollContainer = chatContainer; // chatContainer 来自外部作用域
          // const scrollYBefore = scrollContainer.scrollTop; // 不再需要
          // const rectBefore = this.getBoundingClientRect(); // 不再需要

          // 切换 details 元素的 open 状态
          if (detailsElement.hasAttribute('open')) {
            detailsElement.removeAttribute('open');
          } else {
            detailsElement.setAttribute('open', '');
          }

          // 使用 requestAnimationFrame 等待浏览器完成布局更新
          requestAnimationFrame(() => {
            const messageTopRelativeToViewport = this.getBoundingClientRect().top;
            const scrollContainerTopRelativeToViewport = scrollContainer.getBoundingClientRect().top;
            const offsetToScroll = messageTopRelativeToViewport - scrollContainerTopRelativeToViewport;
            scrollContainer.scrollTop += offsetToScroll;
          });
        }
      });
      messageDiv.dataset.dblclickListenerAdded = 'true';
    }
    
    if (!skipHistory) {
      if (messageIdToUpdate) {
        node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageIdToUpdate);
        if (node) {
          node.content = messageText; // Main answer
          if (thoughtsForMessage !== undefined) { // Allow setting thoughts to null/empty
             node.thoughtsRaw = thoughtsForMessage;
          }
        } else {
             console.warn(`appendMessage: History node not found for update: ${messageIdToUpdate}`);
        }
      } else {
        const processedContent = imageHandler.processImageTags(messageText, imagesHTML);
        node = chatHistoryManager.addMessageToTree(
          sender === 'user' ? 'user' : 'assistant',
          processedContent,
          chatHistoryManager.chatHistory.currentNode
        );
        if (thoughtsForMessage) {
          node.thoughtsRaw = thoughtsForMessage;
        }
        if (node) {
          node.hasInlineImages = (!imagesHTML && typeof messageText === 'string' && /<img/i.test(messageText));
        }
        // 将“指令类型”等元信息写入历史节点（只对用户消息生效）
        // 说明：这类信息一旦持久化，后续功能（例如对话标题生成）即可完全脱离“字符串/正则”猜测。
        if (node && node.role === 'user' && meta && typeof meta === 'object') {
          if (typeof meta.promptType === 'string') {
            node.promptType = meta.promptType;
          }
          if (meta.promptMeta && typeof meta.promptMeta === 'object') {
            node.promptMeta = meta.promptMeta;
          }
        }
        messageDiv.setAttribute('data-message-id', node.id);
        // 初次创建 AI 消息时插入一个空的 API footer，占位以便样式稳定
        if (sender === 'ai') {
          const apiFooter = document.createElement('div');
          apiFooter.className = 'api-footer';
          messageDiv.appendChild(apiFooter);
        }
      }

      if (sender === 'ai' && !messageIdToUpdate) {
        messageDiv.classList.add('updating');
      }
    }
    return messageDiv;
  }

  /**
   * 更新AI消息内容，包括思考过程和最终答案
   * @param {string} messageId - 要更新的消息的ID
   * @param {string} newAnswerContent - 最新的完整答案文本
   * @param {string|null} newThoughtsRaw - 最新的完整思考过程原始文本 (可选)
   * @param {Object|null} groundingMetadata - 引用元数据对象，包含引用信息
   */
  function updateAIMessage(messageId, newAnswerContent, newThoughtsRaw, groundingMetadata) {
    const messageDiv = chatContainer.querySelector(`[data-message-id="${messageId}"]`);
    const node = chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId);

    // 统一拆分 <think> 思考段落，保证思考摘要独立存储与展示
    let safeAnswerContent = newAnswerContent;
    let resolvedThoughts = newThoughtsRaw;
    let shouldUpdateThoughts = (newThoughtsRaw !== undefined);
    if (typeof safeAnswerContent === 'string') {
      const thinkExtraction = extractThinkingFromText(safeAnswerContent);
      safeAnswerContent = thinkExtraction.cleanText;
      if (thinkExtraction.thoughtText) {
        resolvedThoughts = mergeThoughts(resolvedThoughts, thinkExtraction.thoughtText);
        shouldUpdateThoughts = true;
      }
    }

    if (!messageDiv || !node) {
      console.error('updateAIMessage: 消息或历史节点未找到', messageId);
      // Fallback: if messageDiv doesn't exist, create it. This implies the initial appendMessage in stream handler failed or was skipped.
      // appendMessage(newAnswerContent, 'ai', false, null, null, newThoughtsRaw, messageId /* if we want to try to use this id */);
      return;
    }

    messageDiv.setAttribute('data-original-text', safeAnswerContent);
    // 思考过程文本由 setupThoughtsDisplay 统一处理

    // --- 同步历史记录中的内容结构（支持图片 + 文本的混合内容） ---
    try {
      // 提取当前消息中已有的图片 HTML（如果存在）
      const imageContentDiv = messageDiv.querySelector('.image-content');
      const imagesHTML = imageContentDiv ? imageContentDiv.innerHTML : null;
      // 使用与 appendMessage 相同的逻辑，将文本和图片转换为统一的消息内容格式
      const processedContent = imageHandler.processImageTags(safeAnswerContent, imagesHTML || '');
      node.content = processedContent;
    } catch (e) {
      console.warn('updateAIMessage: 处理图片标签失败，回退为纯文本内容:', e);
      node.content = safeAnswerContent;
    }
    node.hasInlineImages = (typeof safeAnswerContent === 'string' && /<img/i.test(safeAnswerContent));

    if (shouldUpdateThoughts) { // 允许显式将思考过程设置为 null/空字符串
      node.thoughtsRaw = resolvedThoughts;
    }
    if (groundingMetadata !== undefined) {
      node.groundingMetadata = groundingMetadata || null;
    }

    // Setup/Update thoughts display
    // Pass `processMathAndMarkdown` from the outer scope
    setupThoughtsDisplay(messageDiv, resolvedThoughts, processMathAndMarkdown);

    let textContentDiv = messageDiv.querySelector('.text-content');
    if (!textContentDiv) { // Should exist if appendMessage created it, but good to check
        textContentDiv = document.createElement('div');
        textContentDiv.classList.add('text-content');
        // Ensure textContentDiv is after thoughtsDiv if thoughtsDiv was added
        const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
        if (thoughtsDiv && thoughtsDiv.nextSibling) {
            messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
        } else {
            messageDiv.appendChild(textContentDiv);
        }
    }
    
    let processedText = safeAnswerContent;
    let htmlElements = [];
    let processedResult = safeAnswerContent;

    if (groundingMetadata) {
      processedResult = addGroundingToMessage(safeAnswerContent, groundingMetadata);
      if (typeof processedResult === 'object') {
        processedText = processedResult.text;
        htmlElements = processedResult.htmlElements;
      }
    }

    textContentDiv.innerHTML = processMathAndMarkdown(processedText);

    textContentDiv.querySelectorAll('a:not(.reference-number)').forEach(link => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });

    textContentDiv.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    bindInlineImagePreviews(messageDiv);

    if (groundingMetadata) {
      if (htmlElements && htmlElements.length > 0) {
        htmlElements.forEach(element => {
          const placeholder = element.placeholder;
          const html = element.html;
          textContentDiv.innerHTML = textContentDiv.innerHTML.replace(placeholder, html);
        });
      }
      textContentDiv.innerHTML = textContentDiv.innerHTML.replace(/\u200B😎REF_\d+😎\u200B/g, '');
      if (typeof processedResult === 'object' && processedResult.sources && processedResult.sources.length > 0) {
        // Ensure renderSourcesList appends to textContentDiv or an appropriate container within messageDiv
        const sourcesContainer = messageDiv.querySelector('.sources-list-container') || textContentDiv; 
        renderSourcesList(sourcesContainer, processedResult, groundingMetadata);
      }
    }
    scrollToBottom();
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
    const showReferenceSetting = appContext.services.settingsManager.getSetting('showReference');

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
                // Check if groundingChunks exists and if chunkIndex is valid
                const chunk = (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks[chunkIndex]) 
                                ? groundingMetadata.groundingChunks[chunkIndex] 
                                : null;
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

  function bindInlineImagePreviews(container) {
    if (!container) return;
    try {
      const previewTargets = container.querySelectorAll('.image-tag img, img.ai-inline-image');
      previewTargets.forEach(img => {
        if (img.dataset.previewBound === 'true') return;
        img.dataset.previewBound = 'true';
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          imageHandler.showImagePreview(img.src);
        });
      });
    } catch (e) {
      console.error('绑定图片预览失败:', e);
    }
  }

  /**
   * 切换美元符号数学渲染时，重新处理当前所有 AI 消息
   */
  function rerenderAiMessagesForMathSetting() {
    if (!chatContainer) return;
    const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
    if (!aiMessages.length) return;

    aiMessages.forEach((messageDiv) => {
      const messageId = messageDiv.getAttribute('data-message-id');
      const originalText = messageDiv.getAttribute('data-original-text');
      if (!messageId || typeof originalText !== 'string') return;

      const historyNode = chatHistoryManager?.chatHistory?.messages?.find(msg => msg.id === messageId);
      if (!historyNode) return;

      const hasRefsWithoutMetadata = !historyNode.groundingMetadata && messageDiv.querySelector('.reference-number');
      if (hasRefsWithoutMetadata) {
        console.warn('跳过重新渲染以避免丢失引用信息:', messageId);
        return;
      }

      try {
        updateAIMessage(messageId, originalText, historyNode.thoughtsRaw ?? null, historyNode.groundingMetadata ?? null);
      } catch (error) {
        console.error('重新渲染消息失败:', messageId, error);
      }
    });
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
    const settingsManager = appContext.services.settingsManager;
    const enableDollarMath = settingsManager?.getSetting?.('enableDollarMath');
    // 折叠“搜索过程/思考过程”等自定义片段
    const foldedText = foldMessageContent(text || '');
    // 使用纯函数式渲染管线（禁用内联 HTML、支持 KaTeX、严格 DOMPurify）
    return renderMarkdownSafe(foldedText, { allowDetails: true, enableDollarMath });
  }

  try {
    services.settingsManager?.subscribe?.('enableDollarMath', () => {
      rerenderAiMessagesForMathSetting();
    });
  } catch (error) {
    console.warn('订阅 enableDollarMath 设置变化失败:', error);
  }

  /**
   * 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
   * @param {string} text - 原始文本
   * @returns {string} 处理后的文本
   */
  // 旧的粗体修复、数学占位处理已内聚至 utils/markdown_renderer.js

  /**
   * 根据正则折叠消息文本，使用自定义正则表达式和摘要文本
   * @param {string} text - 原始消息文本
   * @returns {string} 处理后的消息文本，其中符合条件的部分被包裹在一个折叠元素中
   */
  function foldMessageContent(text) {
    if (typeof text !== 'string') return text;
    // 预先去掉 <think> 段落，思考摘要改由独立区域展示
    const { cleanText } = extractThinkingFromText(text);
    let normalizedText = cleanText;
    // 定义折叠配置
    const foldConfigs = [
      {
        regex: /^([\s\S]*)<\/search>/,
        summary: '搜索过程'
      }
    ];

    // 对每个配置应用折叠处理
    for (const config of foldConfigs) {
      const match = normalizedText.match(config.regex);
      if (match && match[1] && match[1].trim() !== '') {
        const foldedPart = match[1];
        const remainingPart = normalizedText.slice(match[0].length);
        const quotedFoldedPart = `<blockquote>${foldedPart}</blockquote>`;
        normalizedText = `<details class="folded-message"><summary>${config.summary}</summary><div>\n${quotedFoldedPart}</div></details>\n\n${remainingPart}`;
      }
    }

    return normalizedText;
  }

  /**
   * 预处理数学表达式
   * @param {string} text - 原始文本
   * @returns {Object} 包含处理后的文本和数学表达式的对象
   */
  // 数学预/后处理逻辑交由渲染器统一处理

  /**
   * 后处理数学表达式
   * @param {string} text - 处理后的文本
   * @param {Array} mathExpressions - 数学表达式数组
   * @returns {string} 替换数学表达式后的文本
   */
  // 参见 utils/markdown_renderer.js 中的 KaTeX 渲染
  
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
