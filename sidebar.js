import { PromptSettings } from './prompt_settings.js';
import { createChatHistoryManager } from './chat_history_manager.js';

document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const stopUpdateButton = document.getElementById('stop-update');
    const clearChatContextButton = document.getElementById('clear-chat-context');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const toggleTheme = document.getElementById('toggle-theme');
    const sidebarWidth = document.getElementById('sidebar-width');
    const fontSize = document.getElementById('font-size');
    const widthValue = document.getElementById('width-value');
    const fontSizeValue = document.getElementById('font-size-value');
    const collapseButton = document.getElementById('collapse-button');
    const feedbackButton = document.getElementById('feedback-button');
    const fullscreenToggle = document.getElementById('fullscreen-toggle');
    const sendButton = document.getElementById('send-button');
    const sendChatHistorySwitch = document.getElementById('send-chat-history-switch');
    let currentMessageElement = null;
    let isTemporaryMode = false; // 添加临时模式状态变量
    let isProcessingMessage = false; // 添加消息处理状态标志
    let shouldAutoScroll = true; // 控制是否自动滚动
    let isAutoScrollEnabled = true; // 自动滚动开关状态
    let currentController = null;  // 用于存储当前的 AbortController
    let isFullscreen = false; // 全屏模式
    let pageContent = null;  // 预存储的网页文本内容
    let shouldSendChatHistory = true; // 是否发送聊天历史
    let currentConversationId = null; // 当前会话ID
    let currentUrl = null; // 存储当前URL


    // Create ChatHistoryManager instance
    const {
        chatHistory,
        addMessageToTree,
        getCurrentConversationChain,
        clearHistory
    } = createChatHistoryManager();

    // 监听聊天历史开关变化
    sendChatHistorySwitch.addEventListener('change', (e) => {
        shouldSendChatHistory = e.target.checked;
        saveSettings('shouldSendChatHistory', shouldSendChatHistory);
    });

    // 添加全屏切换功能
    fullscreenToggle.addEventListener('click', async () => {
        isFullscreen = !isFullscreen;
        // 直接向父窗口发送消息
        window.parent.postMessage({
            type: 'TOGGLE_FULLSCREEN',
            isFullscreen: isFullscreen
        }, '*');
        settingsMenu.classList.remove('visible');
    });

    // 添加公共的图片处理函数
    function processImageTags(content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const imageTags = tempDiv.querySelectorAll('.image-tag');

        if (imageTags.length > 0) {
            const result = [];
            // 添加文本内容
            const textContent = content.replace(/<span class="image-tag"[^>]*>.*?<\/span>/g, '').trim();
            if (textContent) {
                result.push({
                    type: "text",
                    text: textContent
                });
            }
            // 添加图片
            imageTags.forEach(tag => {
                const base64Data = tag.getAttribute('data-image');
                if (base64Data) {
                    result.push({
                        type: "image_url",
                        image_url: {
                            url: base64Data
                        }
                    });
                }
            });
            return result;
        }
        return content;
    }

    // 修改 processMessageContent 函数
    function processMessageContent(msg) {
        if (typeof msg.content === 'string' && msg.content.includes('image-tag')) {
            return {
                ...msg,
                content: processImageTags(msg.content)
            };
        }
        return msg;
    }

    // 获取网页内容
    async function getPageContent() {
        try {
            console.log('getPageContent 发送获取网页内容请求');
            const response = await chrome.runtime.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR'
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }


    /**
     * 为消息添加引用标记和来源信息
     * @param {string} text - 原始消息文本
     * @param {Object} groundingMetadata - 引用元数据对象
     * @param {Array<Object>} groundingMetadata.groundingSupports - 引用支持数组
     * @param {Object} groundingMetadata.groundingSupports[].segment - 文本片段对象
     * @param {string} groundingMetadata.groundingSupports[].segment.text - 需要添加引用的文本
     * @param {Array<number>} groundingMetadata.groundingSupports[].groundingChunkIndices - 引用块索引数组
     * @param {Array<number>} groundingMetadata.groundingSupports[].confidenceScores - 置信度分数数组
     * @param {Array<Object>} groundingMetadata.groundingChunks - 引用块数组
     * @param {Object} groundingMetadata.groundingChunks[].web - 网页引用信息
     * @param {string} groundingMetadata.groundingChunks[].web.title - 网页标题
     * @param {string} groundingMetadata.groundingChunks[].web.uri - 网页URL
     * @param {Array<string>} groundingMetadata.webSearchQueries - 网页搜索查询数组
     * @returns {(string|Object)} 如果没有引用信息返回原文本，否则返回包含处理后文本和引用信息的对象
     * @returns {string} returns.text - 处理后的文本，包含引用标记占位符
     * @returns {Array<Object>} returns.htmlElements - HTML元素数组，用于替换占位符
     * @returns {Array<Object>} returns.htmlElements[].placeholder - 占位符字符串
     * @returns {string} returns.htmlElements[].html - 用于替换占位符的HTML字符串
     * @returns {Array<Object>} returns.sources - 排序后的引用来源数组
     * @returns {number} returns.sources[].refNumber - 引用编号
     * @returns {string} returns.sources[].domain - 来源网站域名
     * @returns {string} returns.sources[].url - 来源URL
     * @returns {Array<string>} returns.webSearchQueries - 网页搜索查询数组
     */
    function addGroundingToMessage(text, groundingMetadata) {
        if (!groundingMetadata?.groundingSupports) return text;

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

            // 替换文本并添加引用标记
            markedText = markedText.replace(regex, `$&${placeholder}`);
            htmlElements.push({
                placeholder,
                html: refGroup
            });

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
     * 获取提示词类型
     * @param {HTMLElement|string} content - 输入内容，可以是HTML元素或字符串
     * @returns {string} 提示词类型 ('image'|'pdf'|'summary'|'selection'|'query'|'system')
     */
    function getPromptTypeFromContent(content) {
        const prompts = promptSettingsManager.getPrompts();

        // 检查是否是PDF提示词
        if (prompts.pdf.prompt && content === prompts.pdf.prompt) {
            return 'pdf';
        }

        // 检查是否是页面总结提示词
        if (prompts.summary.prompt && content === prompts.summary.prompt) {
            return 'summary';
        }

        // 检查是否是划词搜索提示词
        if (prompts.selection.prompt && content.startsWith(prompts.selection.prompt.split('<SELECTION>')[0])) {
            return 'selection';
        }

        // 默认使用系统提示词的设置
        return 'system';
    }

    async function sendMessage() {
        shouldAutoScroll = true; // 新消息开始时重置自动滚动状态
        const message = messageInput.textContent.trim();
        const imageTags = messageInput.querySelectorAll('.image-tag');

        // Added: Determine the current prompt type from the user message.
        const currentPromptType = getPromptTypeFromContent(message);

        if (!message && imageTags.length === 0) return;

        let config = apiConfigs[selectedConfigIndex];
        if (!config?.baseUrl || !config?.apiKey) {
            appendMessage('请在设置中完善 API 配置', 'ai', true);
            return;
        }

        try {
            // 如果存在之前的请求，先中止它
            if (currentController) {
                currentController.abort();
                currentController = null;
            }

            // 设置处理状态为true
            isProcessingMessage = true;
        
            // 获取当前提示词设置
            const prompts = promptSettingsManager.getPrompts();

            // 生成新的请求ID
            const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // 如果没有文本内容，添加图片提示词
            if (messageInput.textContent.trim() === '') {
                messageInput.innerHTML += prompts.image.prompt;
        }

            // 先添加用户消息到界面和历史记录
            const userMessageDiv = appendMessage(messageInput.innerHTML, 'user');
            messageInput.innerHTML = '';
            adjustTextareaHeight(messageInput);

            // 添加加载状态消息
            const loadingMessage = appendMessage('正在处理...', 'ai', true);
            loadingMessage.classList.add('loading-message');

            // 如果不是临时模式，获取网页内容
            if (!isTemporaryMode) {
                loadingMessage.textContent = '正在获取网页内容...';
                const pageContentResponse = await getPageContent();
                if (pageContentResponse) {
                    pageContent = pageContentResponse;
                    // 创建字数统计元素
                    const footer = document.createElement('div');
                    footer.classList.add('content-length-footer');
                    const contentLength = pageContent.content ? pageContent.content.length : 0;
                    footer.textContent = `↑ ${contentLength.toLocaleString()}`;
                    // 添加到用户消息下方
                    userMessageDiv.appendChild(footer);
                } else {
                    pageContent = null;
                    console.error('获取网页内容失败。');
                }
            } else {
                pageContent = null;  // 临时模式下不使用网页内容
            }

            // 创建新的 AbortController
            currentController = new AbortController();
            const signal = currentController.signal;

            // Retrieve conversation chain from the manager
            const conversationChain = getCurrentConversationChain();
            const pageContentPrompt = pageContent
                ? `\n\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
                : '';

            // 组合完整的系统消息
            const systemMessage = {
                role: "system",
                content: prompts.system.prompt + pageContentPrompt
            };

            // 构建消息数组
            const messages = [];
            // 如果是第一条消息或第一条不是系统消息，添加系统消息
            if (conversationChain.length === 0 || conversationChain[0].role !== "system") {
                messages.push(systemMessage);
            }

            // 根据设置决定是否发送聊天历史
            const SendChatHistory = shouldSendChatHistory && currentPromptType !== 'selection';
            if (SendChatHistory) {
                messages.push(...conversationChain.map(node => ({
                    role: node.role,
                    content: node.content
                })));
            } else {
                // 只发送最后一条消息
                if (conversationChain.length > 0) {
                    const lastMessage = conversationChain[conversationChain.length - 1];
                    messages.push({
                        role: lastMessage.role,
                        content: lastMessage.content
                    });
                }
            }

            // 更新加载状态消息
            loadingMessage.textContent = '正在等待 AI 回复...';

            // 确定要使用的模型配置
            let targetConfig = null;
            // 获取最后一条消息
            const lastMessage = messages[messages.length - 1] || {};
            const lastMessageContent = lastMessage.content;

            // 检查最后一条消息是否包含图片
            const hasImage = Array.isArray(lastMessageContent) && 
                lastMessageContent.some(item => item.type === 'image_url');

            if (hasImage) {
                // 如果图片提示词的模型不是"跟随当前API设置"，则使用设置中指定的模型
                if (prompts.image?.model !== 'follow_current') {
                    // 查找对应模型的apiConfig
                    targetConfig = apiConfigs.find(c => c.modelName === prompts.image.model);
                }
            }
            else{
                // 检查最后一条消息的文字内容是否匹配其他提示词类型
                const promptType = getPromptTypeFromContent(lastMessageContent);
                if (prompts[promptType]?.model !== 'follow_current') {
                    targetConfig = apiConfigs.find(c => c.modelName === prompts[promptType].model);
                }
            }
            
            // 如果没找到目标配置，使用当前配置
            config = targetConfig || config;

            // 发送API请求
            const response = await fetch(config.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                    'X-Request-Id': requestId
                },
                body: JSON.stringify({
                    model: config.modelName,
                    messages: messages,
                    stream: true,
                    temperature: config.temperature,
                    top_p: 0.95,
                    // max_tokens: 8192,
                }),
                signal
            });

            if (!response.ok) {
                const error = await response.text();
                // 更新加载状态消息显示具体的错误信息
                if (loadingMessage) {
                    let errorDisplay = `API错误 (${response.status}): `;
                    try {
                        // 尝试解析错误JSON
                        const errorJson = JSON.parse(error);
                        errorDisplay += errorJson.error?.message || errorJson.message || error;
                    } catch {
                        // 如果不是JSON，直接显示错误文本
                        errorDisplay += error;
                    }
                    loadingMessage.textContent = errorDisplay;
                    loadingMessage.classList.add('error-message');
                }
                throw new Error(`API错误 (${response.status}): ${error}`);
        }

            const reader = response.body.getReader();
            let hasStartedResponse = false;
            let aiResponse = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = new TextDecoder().decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const content = line.slice(6);
                        if (content.trim() === '[DONE]') continue;
        try {
                            const data = JSON.parse(content);
                            const deltaContent = data.choices?.[0]?.delta?.content || data.choices?.[0]?.delta?.reasoning_content;
                            if (deltaContent) {
                                if (!hasStartedResponse) {
                                    // 移除加载状态消息
                                    loadingMessage.remove();
                                    hasStartedResponse = true;
                                }
                                aiResponse += deltaContent;
                                aiResponse = aiResponse.replace(/\nabla/g, '\\nabla');
                                // console.log(aiResponse);
                                updateAIMessage(aiResponse, data.choices?.[0]?.groundingMetadata);
                            }
                        } catch (e) {
                            console.error('解析响应出错:', e);
                        }
                    }
                }
            }

            // 消息处理完成后，自动保存会话
            saveCurrentConversation(true); // 指定为更新操作

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('发送消息失败:', error);
            // 更新加载状态消息显示错误
            if (loadingMessage) {
                loadingMessage.textContent = '发送失败: ' + error.message;
                loadingMessage.classList.add('error-message');
            }
            // 从 chatHistory 中移除最后一条记录（用户的问题）
            chatHistory.pop();
        } finally {
            // 无论成功还是失败，都重置处理状态
            isProcessingMessage = false;
            const lastMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastMessage) {
                lastMessage.classList.remove('updating');
            }
        }
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
                        const sourcesList = document.createElement('div');
                        sourcesList.className = 'sources-list';
                        sourcesList.innerHTML = '<h4>参考来源：</h4>';
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
                                        [${source.refNumber}] <a href="${source.url}" target="_blank">${source.domain}</a>
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

                            // 将进度条插入到source-item中
                            const sourceItem = li.querySelector('.source-item');
                            sourceItem.appendChild(confidenceBar);

                            ul.appendChild(li);
                        });

                        sourcesList.appendChild(ul);
                        lastMessage.appendChild(sourcesList);

                        // Add web search queries section if available
                        if (processedResult.webSearchQueries && processedResult.webSearchQueries.length > 0) {
                            const searchQueriesList = document.createElement('div');
                            searchQueriesList.className = 'search-queries-list';
                            searchQueriesList.innerHTML = '<h4>搜索查询：</h4>';
                            const ul = document.createElement('ul');

                            processedResult.webSearchQueries.forEach(query => {
                                const li = document.createElement('li');
                                li.textContent = query;
                                li.addEventListener('click', () => {
                                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                                    window.open(searchUrl, '_blank');
                                });
                                ul.appendChild(li);
                            });

                            searchQueriesList.appendChild(ul);
                            lastMessage.appendChild(searchQueriesList);
                        }
                    }
                }

                // 更新历史记录
                const messageId = lastMessage.getAttribute('data-message-id');
                if (messageId && chatHistory.messages) {
                    const node = chatHistory.messages.find(msg => msg.id === messageId);
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
    // 提取公共配置
    const MATH_DELIMITERS = {
        delimiters: [
            { left: '\\(', right: '\\)', display: false },  // 行内公式
            { left: '\\\\(', right: '\\\\)', display: false },  // 行内公式
            { left: '\\[', right: '\\]', display: true },   // 行间公式
            { left: '$$', right: '$$', display: true },     // 行间公式
            { left: '$', right: '$', display: false }       // 行内公式
        ],
        throwOnError: false
    };

    // 预处理数学表达式
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

        // 替换美元符号包围的块级数学表达式
        text = text.replace(/(\$\$[\s\S]+?\$\$)/g, (match, p1) => {
            const placeholder = `😎DOLLARBLOCK_MATH_${counter}😎`;
            mathExpressions.push({ placeholder, content: p1.slice(2, -2), originalContent: p1, type: 'dollarblock' });
            counter++;
            return placeholder;
        });

        // 替换美元符号包围的行内数学表达式
        text = text.replace(/(\$[^\$\n]+?\$)/g, (match, p1) => {
            const placeholder = `😎DOLLAR_MATH_${counter}😎`;
            mathExpressions.push({ placeholder, content: p1.slice(1, -1), originalContent: p1, type: 'dollarinline' });
            counter++;
            return placeholder;
        });

        return { text, mathExpressions };
    }

    // 后处理数学表达式
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

    // 处理数学公式和Markdown
    function processMathAndMarkdown(text) {
        // 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
        const preHandledText = fixBoldParsingIssue(text);

        // 预处理数学表达式
        const { text: escapedText, mathExpressions } = preMathEscape(preHandledText);

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

    // 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
    function fixBoldParsingIssue(text) {
        // 在所有**前后添加零宽空格，以修复粗体解析问题
        return text.replace(/\*\*/g, '\u200B**\u200B');
    }

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'DROP_IMAGE') {
            console.log('收到拖放图片数据');
            const imageData = event.data.imageData;
            if (imageData && imageData.data) {
                console.log('创建图片标签');
                const imageTag = createImageTag(imageData.data, imageData.name);

                // 确保输入框有焦点
                messageInput.focus();

                // 获取或创建选区
                const selection = window.getSelection();
                let range;

                // 检查是否有现有选区
                if (selection.rangeCount > 0) {
                    range = selection.getRangeAt(0);
                } else {
                    // 创建新的选区
                    range = document.createRange();
                    // 将选区设置到输入框的末尾
                    range.selectNodeContents(messageInput);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                }

                console.log('插入图片标签到输入框');
                // 插入图片标签
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
                console.log('图片插入完成');
            }
        } else if (event.data.type === 'FOCUS_INPUT') {
            messageInput.focus();
            const range = document.createRange();
            range.selectNodeContents(messageInput);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        } else if (event.data.type === 'URL_CHANGED') {
            console.log('收到URL_CHANGED消息:', event.data);
            // 更新存储的URL和域名
            currentUrl = event.data.url;
            // 清空页面内容，等待下次发送消息时重新获取
            pageContent = null;
        } else if (event.data.type === 'UPDATE_PLACEHOLDER') {
            console.log('收到更新placeholder消息:', event.data);
            if (messageInput) {
                messageInput.setAttribute('placeholder', event.data.placeholder);
                if (event.data.timeout) {
                    setTimeout(() => {
                        messageInput.setAttribute('placeholder', '输入消息...');
                    }, event.data.timeout);
                }
            }
        } else if (event.data.type === 'QUICK_SUMMARY_COMMAND') {
            performQuickSummary(event.data.selectedContent);
        } else if (event.data.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
            // 调用已有的toggle逻辑
            if (isTemporaryMode) {
                exitTemporaryMode();
            } else {
                enterTemporaryMode();
            }
        }
    });

    // 修改appendMessage函数，移除初始字数显示
    function appendMessage(text, sender, skipHistory = false, fragment = null) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', `${sender}-message`);

        // 如果是批量加载，添加特殊类名
        if (fragment) {
            messageDiv.classList.add('batch-load');
        }

        // 存储原始文本用于复制
        messageDiv.setAttribute('data-original-text', text);

        // 处理数学公式和 Markdown
        try {
            messageDiv.innerHTML = processMathAndMarkdown(text);
        } catch (error) {
            console.error('处理数学公式和Markdown失败:', error);
            messageDiv.innerHTML = text; // 出错时使用原始文本
        }

        // 处理消息中的链接
        messageDiv.querySelectorAll('a').forEach(link => {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        });

        // 处理代码块的语法高亮
        messageDiv.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });

        // 处理消息中的图片标签
        messageDiv.querySelectorAll('.image-tag').forEach(tag => {
            const img = tag.querySelector('img');
            const base64Data = tag.getAttribute('data-image');
            if (img && base64Data) {
                img.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showImagePreview(base64Data);
                });
            }
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
            // 修改这里：移除用户消息的强制滚动
            scrollToBottom(); // 统一使用自动滚动设置
        }

        // 更新聊天历史
        if (!skipHistory) {
            const processedContent = processImageTags(text);
            const node = addMessageToTree(
                sender === 'user' ? 'user' : 'assistant',
                processedContent,
                chatHistory.currentNode  // 添加 parentId 参数
            );

            // 为消息div添加节点ID
            messageDiv.setAttribute('data-message-id', node.id);

            if (sender === 'ai') {
                messageDiv.classList.add('updating');
            }
        }

        return messageDiv;
    }

    // 自动调整文本框高度
    function adjustTextareaHeight(textarea) {
        textarea.style.height = 'auto';
        const maxHeight = 200;
        const scrollHeight = textarea.scrollHeight;
        textarea.style.height = Math.min(scrollHeight, maxHeight) + 'px';
        textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    // 监听输入框变化
    messageInput.addEventListener('input', function () {
        adjustTextareaHeight(this);
        updateSendButtonState();

        // 处理 placeholder 的显示
        if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        }

        // 移除不必要的 br 标签
        const brElements = this.getElementsByTagName('br');
        Array.from(brElements).forEach(br => {
            if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                br.remove();
            }
        });
    });

    // 处理换行和输入
    let isComposing = false;  // 跟踪输入法状态

    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    // 添加临时模式相关函数
    function enterTemporaryMode() {
        isTemporaryMode = true;
        messageInput.classList.add('temporary-mode');
        document.body.classList.add('temporary-mode');
        messageInput.setAttribute('placeholder', '临时模式 - 不获取网页内容');
    }

    function exitTemporaryMode() {
        isTemporaryMode = false;
        messageInput.classList.remove('temporary-mode');
        document.body.classList.remove('temporary-mode');
        messageInput.setAttribute('placeholder', '输入消息...');
    }

    // 统一的键盘事件监听器
    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                // Shift+Enter 插入换行
                return;
            }
            
            if (isComposing) {
                // 如果正在使用输入法或正在处理消息，不发送消息
                return;
            }
            
            e.preventDefault();
            
            const text = this.textContent.trim();
            if (text || this.querySelector('.image-tag')) {  // 检查是否有文本或图片
                if (e.ctrlKey) {
                    // Ctrl+Enter: 将输入内容作为selection类型发送
                    const prompts = promptSettingsManager.getPrompts();
                    const selectionPrompt = prompts.selection.prompt;
                    if (selectionPrompt) {
                        this.textContent = selectionPrompt.replace('<SELECTION>', text);
                    }
                }
                // 发送消息
                sendMessage();
            }
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        } else if (e.key === '-') {
            // 检查输入框是否为空
            if (!this.textContent.trim() && !this.querySelector('.image-tag')) {
                e.preventDefault();
                if (isTemporaryMode) {
                    exitTemporaryMode();
                } else {
                    enterTemporaryMode();
                }
                console.log('临时模式状态:', isTemporaryMode); // 添加调试日志
            }
        }
    });

    // 设置菜单开关函数
    function toggleSettingsMenu(show) {
        if (show === undefined) {
            // 如果没有传参数，就切换当前状态
            settingsMenu.classList.toggle('visible');
        } else {
            // 否则设置为指定状态
            if (show) {
                settingsMenu.classList.add('visible');
            } else {
                settingsMenu.classList.remove('visible');
            }
        }

        // 每次打开菜单时重新渲染收藏的API列表
        if (settingsMenu.classList.contains('visible')) {
            renderFavoriteApis();
        }
    }

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            toggleSettingsMenu(false);
        }
    });

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSettingsMenu();
    });

    // 添加输入框的事件监听器
    messageInput.addEventListener('focus', () => {
        toggleSettingsMenu(false);
    });

    let closeTimeout;

    // 设置按钮悬停事件
    settingsButton.addEventListener('mouseenter', () => {
        toggleSettingsMenu(true);
    });

    // 设置按钮和菜单的鼠标离开事件
    const handleMouseLeave = (e) => {
        const toElement = e.relatedTarget;
        if (!settingsButton.contains(toElement) && !settingsMenu.contains(toElement)) {
            toggleSettingsMenu(false);
        }
    };

    settingsButton.addEventListener('mouseleave', handleMouseLeave);
    settingsMenu.addEventListener('mouseleave', handleMouseLeave);

    // 添加输入框的事件监听器
    messageInput.addEventListener('focus', () => {
        settingsMenu.classList.remove('visible');
    });

    // 主题切换
    const themeSwitch = document.getElementById('theme-switch');

    // 设置主题
    function setTheme(isDark) {
        // 获取根元素
        const root = document.documentElement;

        // 移除现有的主题类
        root.classList.remove('dark-theme', 'light-theme');

        // 添加新的主题类
        root.classList.add(isDark ? 'dark-theme' : 'light-theme');

        // 更新开关状态
        themeSwitch.checked = isDark;

        // 保存主题设置
        chrome.storage.sync.set({ theme: isDark ? 'dark' : 'light' });
    }

    // 初始化主题
    async function initTheme() {
        try {
            const result = await chrome.storage.sync.get('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDark = result.theme === 'dark' || (!result.theme && prefersDark);
            setTheme(isDark);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用系统主题
            setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
        }
    }

    // 监听主题切换
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        chrome.storage.sync.get('theme', (data) => {
            if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
                setTheme(e.matches);
            }
        });
    });

    // 初始化主题
    await initTheme();

    // API 设置功能
    const apiSettings = document.getElementById('api-settings');
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = document.querySelector('.back-button');
    const apiCards = document.querySelector('.api-cards');

    // 加载保存的 API 配置
    let apiConfigs = [];
    let selectedConfigIndex = 0;

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            const result = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
            if (result.apiConfigs && result.apiConfigs.length > 0) {
                apiConfigs = result.apiConfigs;
                selectedConfigIndex = result.selectedConfigIndex || 0;
            } else {
                // 创建默认配置
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-4o',
                    temperature: 1,
                    isFavorite: false  // 添加收藏状态字段
                }];
                selectedConfigIndex = 0;
                await saveAPIConfigs();
            }
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 如果加载失败，也创建默认配置
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o',
                temperature: 1,
                isFavorite: false  // 添加收藏状态字段
            }];
            selectedConfigIndex = 0;
        }

        // 暴露 apiConfigs 到 window 对象
        window.apiConfigs = apiConfigs;
        // 触发配置更新事件
        window.dispatchEvent(new Event('apiConfigsUpdated'));

        // 确保一定会渲染卡片和收藏列表
        renderAPICards();
        renderFavoriteApis();
    }

    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            await chrome.storage.sync.set({
                apiConfigs,
                selectedConfigIndex
            });
            // 更新 window.apiConfigs 并触发事件
            window.apiConfigs = apiConfigs;
            window.dispatchEvent(new Event('apiConfigsUpdated'));
        } catch (error) {
            console.error('保存 API 配置失败:', error);
        }
    }

    // 渲染 API 卡片
    function renderAPICards() {
        // 确保模板元素在
        const templateCard = document.querySelector('.api-card.template');
        if (!templateCard) {
            console.error('找不到模板卡片元素');
            return;
        }

        // 保存模板的副本
        const templateClone = templateCard.cloneNode(true);

        // 清空现有卡片
        apiCards.innerHTML = '';

        // 先重新添加模板（保持隐藏状态）
        apiCards.appendChild(templateClone);

        // 渲染实际的卡
        apiConfigs.forEach((config, index) => {
            const card = createAPICard(config, index, templateClone);
            apiCards.appendChild(card);
        });
    }

    /**
     * @function createAPICard
     * 创建并渲染单个 API 配置卡片
     * @param {Object} config - API 配置对象
     * @param {string} [config.apiKey] - API 密钥
     * @param {string} [config.baseUrl] - API 基础 URL
     * @param {string} [config.modelName] - 模型名称
     * @param {number} [config.temperature] - temperature 值（可为 0）
     * @param {boolean} [config.isFavorite] - 是否收藏
     * @param {number} index - 该配置在 apiConfigs 数组中的索引
     * @param {HTMLElement} templateCard - 用于克隆的卡片模板 DOM
     * @returns {HTMLElement} 渲染后的卡片元素
     * @throws {Error} 当复制或渲染卡片失败时抛出异常
     * @example
     * const card = createAPICard(apiConfigs[0], 0, document.querySelector('.api-card.template'));
     * document.querySelector('.api-cards').appendChild(card);
     * @since 1.0.0
     */
    function createAPICard(config, index, templateCard) {
        // 克隆模板
        const template = templateCard.cloneNode(true);
        template.classList.remove('template');
        template.style.display = '';

        if (index === selectedConfigIndex) {
            template.classList.add('selected');
        }

        // 设置标题
        const titleElement = template.querySelector('.api-card-title');
        titleElement.textContent = config.modelName || config.baseUrl || '新配置';

        const apiKeyInput = template.querySelector('.api-key');
        const baseUrlInput = template.querySelector('.base-url');
        const modelNameInput = template.querySelector('.model-name');
        const temperatureInput = template.querySelector('.temperature');
        const temperatureValue = template.querySelector('.temperature-value');
        const apiForm = template.querySelector('.api-form');
        const favoriteBtn = template.querySelector('.favorite-btn');
        const togglePasswordBtn = template.querySelector('.toggle-password-btn');
        const selectBtn = template.querySelector('.select-btn');

        // 选择按钮点击事件
        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 移除其他卡片的选中状态
            document.querySelectorAll('.api-card').forEach(card => {
                card.classList.remove('selected');
            });
            // 设置当前卡片为选中状态
            template.classList.add('selected');
            selectedConfigIndex = index;
            saveAPIConfigs();
            // 关闭设置菜单
            apiSettings.classList.remove('visible');
        });

        // 点击卡片只展开/折叠表单
        template.addEventListener('click', () => {
            template.classList.toggle('expanded');
        });

        // 添加密码切换按钮的点击事件监听器
        togglePasswordBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const type = apiKeyInput.type === 'password' ? 'text' : 'password';
            apiKeyInput.type = type;
            togglePasswordBtn.classList.toggle('visible');
        });

        // 添加点击外部自动隐藏密码的功能
        document.addEventListener('click', (e) => {
            // 如果点击的不是API Key输入框和切换按钮
            if (!apiKeyInput.contains(e.target) && !togglePasswordBtn.contains(e.target)) {
                // 如果当前是显示状态，则切换回密码状态
                if (apiKeyInput.type === 'text') {
                    apiKeyInput.type = 'password';
                    togglePasswordBtn.classList.remove('visible');
                }
            }
        });

        // 当输入框失去焦点时也隐藏密码
        apiKeyInput.addEventListener('blur', () => {
            if (apiKeyInput.type === 'text') {
                apiKeyInput.type = 'password';
                togglePasswordBtn.classList.remove('visible');
            }
        });

        // 使用 ?? 替代 || 来防止 0 被错误替换
        apiKeyInput.value = config.apiKey ?? '';
        baseUrlInput.value = config.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
        modelNameInput.value = config.modelName ?? 'gpt-4o';
        temperatureInput.value = config.temperature ?? 1;
        temperatureValue.textContent = (config.temperature ?? 1).toFixed(1);

        // 监听温度变化
        temperatureInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            temperatureValue.textContent = value.toFixed(1);
            // 保存温度值
            apiConfigs[index] = {
                ...apiConfigs[index],
                temperature: value
            };
            saveAPIConfigs();
        });

        // 检查是否已收藏
        if (config.isFavorite) {
            favoriteBtn.classList.add('active');
        }

        // 收藏按钮点击事件
        favoriteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 直接切换当前配置的收藏状态
            apiConfigs[index].isFavorite = !apiConfigs[index].isFavorite;

            if (apiConfigs[index].isFavorite) {
                favoriteBtn.classList.add('active');
            } else {
                favoriteBtn.classList.remove('active');
            }

            saveAPIConfigs();
            renderFavoriteApis();
        });

        // 阻止输入框和按钮点击事件冒泡
        const stopPropagation = (e) => e.stopPropagation();
        apiForm.addEventListener('click', stopPropagation);
        template.querySelector('.api-card-actions').addEventListener('click', stopPropagation);

        // 输入变化时保存
        [apiKeyInput, baseUrlInput, modelNameInput, temperatureInput].forEach(input => {
            input.addEventListener('change', () => {
                apiConfigs[index] = {
                    ...apiConfigs[index],
                    apiKey: apiKeyInput.value,
                    baseUrl: baseUrlInput.value,
                    modelName: modelNameInput.value,
                    temperature: parseFloat(temperatureInput.value)
                };
                // 更新标题
                titleElement.textContent = apiConfigs[index].modelName || apiConfigs[index].baseUrl || '新配置';
                saveAPIConfigs();
            });
        });

        // 复制配置
        template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            apiConfigs.push({ ...config });
            saveAPIConfigs();
            renderAPICards();
        });

        // 删除配置
        template.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (apiConfigs.length > 1) {
                apiConfigs.splice(index, 1);
                if (selectedConfigIndex >= apiConfigs.length) {
                    selectedConfigIndex = apiConfigs.length - 1;
                }
                saveAPIConfigs();
                renderAPICards();
            }
        });

        return template;
    }

    // 渲染收藏的API列表
    function renderFavoriteApis() {
        const favoriteApisList = document.querySelector('.favorite-apis-list');
        favoriteApisList.innerHTML = '';

        // 过滤出收藏的API
        const favoriteConfigs = apiConfigs.filter(config => config.isFavorite);

        if (favoriteConfigs.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.style.padding = '4px 8px';
            emptyMessage.style.opacity = '0.7';
            emptyMessage.style.fontSize = '12px';
            emptyMessage.textContent = '暂无收藏的API';
            favoriteApisList.appendChild(emptyMessage);
            return;
        }

        // 获取当前使用的API配置
        const currentConfig = apiConfigs[selectedConfigIndex];

        favoriteConfigs.forEach((config) => {
            const item = document.createElement('div');
            item.className = 'favorite-api-item';

            // 检查是否是当前使用的API
            if (currentConfig &&
                currentConfig.apiKey === config.apiKey &&
                currentConfig.baseUrl === config.baseUrl &&
                currentConfig.modelName === config.modelName) {
                item.classList.add('current');
            }

            const apiName = document.createElement('span');
            apiName.className = 'api-name';
            apiName.textContent = config.modelName || config.baseUrl;

            item.appendChild(apiName);

            // 点击切换到该API配置
            item.addEventListener('click', () => {
                const configIndex = apiConfigs.findIndex(c =>
                    c.apiKey === config.apiKey &&
                    c.baseUrl === config.baseUrl &&
                    c.modelName === config.modelName
                );

                if (configIndex !== -1) {
                    selectedConfigIndex = configIndex;
                    saveAPIConfigs();
                    renderAPICards();
                    toggleSettingsMenu(false);
                }
            });

            favoriteApisList.appendChild(item);
        });
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();

    // 显示/隐藏 API 设置
    apiSettingsToggle.addEventListener('click', () => {
        apiSettings.classList.add('visible');
        toggleSettingsMenu(false);
        // 确保每次打开设置时都重新渲染卡片
        renderAPICards();
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

    // 清空聊天记录功能，并保存当前对话至持久存储（每次聊天会话结束自动保存）
    function clearChatHistory() {
        // 保存当前对话，如果有消息
        if (chatHistory.messages.length > 0) {
            saveCurrentConversation(false); // 明确指定为非更新操作
        }
        // 如果有正在进行的请求，停止它
        if (currentController) {
            currentController.abort();
            currentController = null;
        }
        // 清空聊天容器
        chatContainer.innerHTML = '';
        // 清空当前页面的聊天历史记录
        clearHistory();
        // 重置当前会话ID
        currentConversationId = null;
    }

    const clearChat = document.getElementById('clear-chat');
    clearChat.addEventListener('click', () => {
        clearChatHistory();
        // 关闭设置菜单
        toggleSettingsMenu(false);
        // 聚焦输入框并将光标移到末尾
        messageInput.focus();
        // 移动光标到末尾
        const range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });

    // 添加获取页面类型的函数
    async function getDocumentType() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_DOCUMENT_TYPE'
            });
            return response?.contentType;
        } catch (error) {
            console.error('获取页面类型失败:', error);
            return null;
        }
    }

    // 导入并初始化提示词设置
    const promptSettingsManager = new PromptSettings();

    async function performQuickSummary(webpageSelection = null) {
        const wasTemporaryMode = isTemporaryMode;
        try {
            // 检查焦点是否在侧栏内
            const isSidebarFocused = document.hasFocus();
            const sidebarSelection = window.getSelection().toString().trim();

            // 获取选中的文本内容
            const selectedText = (isSidebarFocused && sidebarSelection) ?
                sidebarSelection :
                webpageSelection?.trim() || '';

            // 获取页面类型
            const contentType = await getDocumentType();
            const isPDF = contentType === 'application/pdf';

            // 获取当前提示词设置
            const prompts = promptSettingsManager.getPrompts();

            if (selectedText) {
                // 检查是否需要清空聊天记录
                const result = await chrome.storage.sync.get(['clearOnSearch']);
                if (result.clearOnSearch !== false) { // 默认为true
                    clearChatHistory();
                }

                // 根据模型名称决定使用哪个提示词
                const promptType = (prompts.selection.model || '').endsWith('-search') ? 'selection' : 'query';
                const prompt = prompts[promptType].prompt.replace('<SELECTION>', selectedText);
                messageInput.textContent = prompt;

                // 发送消息
                await sendMessage();
            } else {
                if (wasTemporaryMode) {
                    exitTemporaryMode();
                }
                clearChatHistory();

                // 为PDF文件使用自定义的PDF提示词
                if (isPDF) {
                    messageInput.textContent = prompts.pdf.prompt;
                } else {
                    messageInput.textContent = prompts.summary.prompt;
                }
                // 发送消息
                await sendMessage();
            }
        } catch (error) {
            console.error('获取选中文本失败:', error);
        } finally {
            // 如果之前是临时模式，恢复
            if (wasTemporaryMode) {
                enterTemporaryMode();
            }
        }
    }

    // 快速总结功能
    const quickSummary = document.getElementById('quick-summary');
    quickSummary.addEventListener('click', () => performQuickSummary());

    // 添加点击事件监听
    chatContainer.addEventListener('click', () => {
        // 击聊天区域时让输入框失去焦点
        messageInput.blur();
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点，阻止事件冒泡
        messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
        // 输入框失去焦点时，移除点击事件监听
        messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });

    // 右键菜单功能
    function showContextMenu(e, messageElement) {
        e.preventDefault();
        currentMessageElement = messageElement;

        // 设置菜单位置
        contextMenu.style.display = 'block';

        // 根据消息状态显示或隐藏停止更新按钮
        if (messageElement.classList.contains('updating')) {
            stopUpdateButton.style.display = 'flex';
        } else {
            stopUpdateButton.style.display = 'none';
        }

        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;

        // 确保菜单不超出视口
        let x = e.clientX;
        let y = e.clientY;

        if (x + menuWidth > window.innerWidth) {
            x = window.innerWidth - menuWidth;
        }

        if (y + menuHeight > window.innerHeight) {
            y = window.innerHeight - menuHeight;
        }

        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
    }

    // 添加停止更新按钮的点击事件处理
    stopUpdateButton.addEventListener('click', () => {
        if (currentController) {
            currentController.abort();  // 中止当前请求
            currentController = null;
            hideContextMenu();
        }
    });
    // 隐藏右键菜单
    function hideContextMenu() {
        contextMenu.style.display = 'none';
        currentMessageElement = null;
    }

    // 复制消息内容
    function copyMessageContent() {
        if (currentMessageElement) {
            // 获取存储的原始文本
            const originalText = currentMessageElement.getAttribute('data-original-text');
            navigator.clipboard.writeText(originalText).then(() => {
                hideContextMenu();
            }).catch(err => {
                console.error('复制失败:', err);
            });
        }
    }

    // 监听 AI 消息的右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        // 如果按住了Ctrl、Shift或Alt键，则不阻止默认行为，显示浏览器默认菜单
        if (e.ctrlKey || e.shiftKey || e.altKey) {
            return;
        }
        
        // 否则显示自定义上下文菜单
        e.preventDefault();
        const messageElement = e.target.closest('.ai-message');
        if (messageElement) {
            showContextMenu(e, messageElement);
        }
    });

    // 点击制按钮
    copyMessageButton.addEventListener('click', copyMessageContent);

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    // 滚动时隐藏菜单
    chatContainer.addEventListener('scroll', hideContextMenu);

    // 片粘贴功能
    messageInput.addEventListener('paste', async (e) => {
        e.preventDefault(); // 阻止默认粘贴行为

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            // 处理图片粘贴
            const file = imageItem.getAsFile();
            const reader = new FileReader();

            reader.onload = async () => {
                const base64Data = reader.result;
                const imageTag = createImageTag(base64Data, file.name);

                // 在光标位置插入图片标签
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面，并确保不会插入额外的换行
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 移除可能存在的多余行
                const brElements = messageInput.getElementsByTagName('br');
                Array.from(brElements).forEach(br => {
                    if (br.previousSibling && br.previousSibling.classList && br.previousSibling.classList.contains('image-tag')) {
                        br.remove();
                    }
                });

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            };

            reader.readAsDataURL(file);
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });

    // 处理图片标签的删除
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = window.getSelection();
            const range = selection.getRangeAt(0);
            const startContainer = range.startContainer;

            // 检查是否在图片标签旁边
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === '') {
                const previousSibling = startContainer.previousSibling;
                if (previousSibling && previousSibling.classList?.contains('image-tag')) {
                    e.preventDefault();
                    previousSibling.remove();

                    // 移除可能存在的多余换行
                    const brElements = messageInput.getElementsByTagName('br');
                    Array.from(brElements).forEach(br => {
                        if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                            br.remove();
                        }
                    });

                    // 触发输入事件以调整高度
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }
    });

    // 创建图片标签
    function createImageTag(base64Data, fileName) {
        const container = document.createElement('span');
        container.className = 'image-tag';
        container.contentEditable = false;
        container.setAttribute('data-image', base64Data);
        container.title = fileName || '图片'; // 添加悬停提示

        const thumbnail = document.createElement('img');
        thumbnail.src = base64Data;
        thumbnail.alt = fileName || '图片';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
        deleteBtn.title = '删除图片';

        // 点击删除按钮时除整个标签
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.remove();
            // 发输入事件以调整高度
            messageInput.dispatchEvent(new Event('input'));
        });

        container.appendChild(thumbnail);
        container.appendChild(deleteBtn);

        // 点击图片区域预览图片
        thumbnail.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showImagePreview(base64Data);
        });

        return container;
    }

    // 图片预览功能
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const closeButton = previewModal.querySelector('.image-preview-close');

    function showImagePreview(base64Data) {
        previewImage.src = base64Data;
        previewModal.classList.add('visible');
    }

    function hideImagePreview() {
        previewModal.classList.remove('visible');
        previewImage.src = '';
    }

    closeButton.addEventListener('click', hideImagePreview);
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            hideImagePreview();
        }
    });

    // 创建公共的图片处理函数
    function handleImageDrop(e, target) {
        e.preventDefault();
        e.stopPropagation();

        try {
            // 处理文件拖放
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64Data = reader.result;
                        const imageTag = createImageTag(base64Data, file.name);

                        // 确保输入框有焦点
                        messageInput.focus();

                        // 获取或创建选区
                        const selection = window.getSelection();
                        let range;

                        // 检查是否有现有选区
                        if (selection.rangeCount > 0) {
                            range = selection.getRangeAt(0);
                        } else {
                            // 创建新的选区
                            range = document.createRange();
                            // 将选区设置到输入框的末尾
                            range.selectNodeContents(messageInput);
                            range.collapse(false);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }

                        // 插入图片标签
                        range.deleteContents();
                        range.insertNode(imageTag);

                        // 移动光标到图片标签后面
                        const newRange = document.createRange();
                        newRange.setStartAfter(imageTag);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        // 触发输入事件以调整高度
                        messageInput.dispatchEvent(new Event('input'));
                    };
                    reader.readAsDataURL(file);
                    return;
                }
            }

            // 处理网页图片拖放
            const data = e.dataTransfer.getData('text/plain');
            if (data) {
                try {
                    const imageData = JSON.parse(data);
                    if (imageData.type === 'image') {
                        const imageTag = createImageTag(imageData.data, imageData.name);

                        // 确保输入框有焦点
                        messageInput.focus();

                        // 获取或创建选区
                        const selection = window.getSelection();
                        let range;

                        // 检查是否有现有选区
                        if (selection.rangeCount > 0) {
                            range = selection.getRangeAt(0);
                        } else {
                            // 创建新的选区
                            range = document.createRange();
                            // 将选区设置到输入框的末尾
                            range.selectNodeContents(messageInput);
                            range.collapse(false);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }

                        // 插入图片标签
                        range.deleteContents();
                        range.insertNode(imageTag);

                        // 移动光标到图片标签后面
                        const newRange = document.createRange();
                        newRange.setStartAfter(imageTag);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        // 触发输入事件以调整高度
                        messageInput.dispatchEvent(new Event('input'));
                    }
                } catch (error) {
                    console.error('处理拖放数据失败:', error);
                }
            }
        } catch (error) {
            console.error('处理拖放事件失败:', error);
        }
    }

    // 为输入框添加拖放事件监听器
    messageInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('drop', (e) => handleImageDrop(e, messageInput));

    // 为聊天区域添加拖放事件监听器
    chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('drop', (e) => handleImageDrop(e, chatContainer));

    // 阻止聊天区域的图片默认行为
    chatContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    // 初始化设置
    async function initSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'sidebarWidth', 
                'fontSize', 
                'scaleFactor', 
                'autoScroll', 
                'clearOnSearch',
                'shouldSendChatHistory',
                'showReference' // 添加新的配置键
            ]);
            if (result.sidebarWidth) {
                document.documentElement.style.setProperty('--cerebr-sidebar-width', `${result.sidebarWidth}px`);
                sidebarWidth.value = result.sidebarWidth;
                widthValue.textContent = `${result.sidebarWidth}px`;
            }
            if (result.fontSize) {
                document.documentElement.style.setProperty('--cerebr-font-size', `${result.fontSize}px`);
                fontSize.value = result.fontSize;
                fontSizeValue.textContent = `${result.fontSize}px`;
            }
            if (result.scaleFactor) {
                const scaleFactorElem = document.getElementById('scale-factor');
                const scaleValue = document.getElementById('scale-value');
                scaleFactorElem.value = result.scaleFactor;
                scaleValue.textContent = `${result.scaleFactor}x`;
            }
            // 初始化自动滚动开关状态
            if (result.autoScroll !== undefined) {
                isAutoScrollEnabled = result.autoScroll;
                const autoScrollSwitch = document.getElementById('auto-scroll-switch');
                if (autoScrollSwitch) {
                    autoScrollSwitch.checked = isAutoScrollEnabled;
                }
            }
            // 初始化划词搜索清空聊天设置
            const clearOnSearchSwitch = document.getElementById('clear-on-search-switch');
            if (clearOnSearchSwitch) {
                clearOnSearchSwitch.checked = result.clearOnSearch !== false; // 默认为true
            }
            // 初始化聊天历史开关状态
            if (result.shouldSendChatHistory !== undefined) {
                shouldSendChatHistory = result.shouldSendChatHistory;
                const sendChatHistorySwitch = document.getElementById('send-chat-history-switch');
                if (sendChatHistorySwitch) {
                    sendChatHistorySwitch.checked = shouldSendChatHistory;
                }
            }
            // 新增：初始化显示引用标记设置（默认显示）
            const showReferenceSwitch = document.getElementById('show-reference-switch');
            if (showReferenceSwitch) {
                if (result.showReference === undefined) {
                    showReferenceSwitch.checked = true;
                } else {
                    showReferenceSwitch.checked = result.showReference;
                }
                updateReferenceVisibility(showReferenceSwitch.checked);
                showReferenceSwitch.addEventListener('change', (e) => {
                    updateReferenceVisibility(e.target.checked);
                    saveSettings('showReference', e.target.checked);
                });
            }
        } catch (error) {
            console.error('初始化设置失败:', error);
        }
    }

    // 保存设置
    async function saveSettings(key, value) {
        try {
            await chrome.storage.sync.set({ [key]: value });
        } catch (error) {
            console.error('保存设置失败:', error);
        }
    }

    // 新增：切换引用标记显示/隐藏的函数
    function updateReferenceVisibility(shouldShow) {
        if (shouldShow) {
            document.body.classList.remove('hide-references');
        } else {
            document.body.classList.add('hide-references');
        }
    }

    // 监听侧栏宽度变化
    sidebarWidth.addEventListener('input', (e) => {
        const width = e.target.value;
        widthValue.textContent = `${width}px`;
    });

    sidebarWidth.addEventListener('change', (e) => {
        const width = e.target.value;
        document.documentElement.style.setProperty('--cerebr-sidebar-width', `${width}px`);
        saveSettings('sidebarWidth', width);
        // 通知父窗口宽度变化
        window.parent.postMessage({
            type: 'SIDEBAR_WIDTH_CHANGE',
            width: parseInt(width)
        }, '*');
    });

    // 监听字体大小变化
    fontSize.addEventListener('input', (e) => {
        const size = e.target.value;
        fontSizeValue.textContent = `${size}px`;
    });

    fontSize.addEventListener('change', (e) => {
        const size = e.target.value;
        document.documentElement.style.setProperty('--cerebr-font-size', `${size}px`);
        saveSettings('fontSize', size);
    });

    // 监听缩放比例变化
    const scaleFactor = document.getElementById('scale-factor');
    const scaleValue = document.getElementById('scale-value');

    scaleFactor.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        scaleValue.textContent = `${value.toFixed(1)}x`;
    });

    scaleFactor.addEventListener('change', (e) => {
        const value = parseFloat(e.target.value);
        window.parent.postMessage({
            type: 'SCALE_FACTOR_CHANGE',
            value: value
        }, '*');
        saveSettings('scaleFactor', value);
    });

    // 添加自动滚动开关事件监听
    const autoScrollSwitch = document.getElementById('auto-scroll-switch');
    if (autoScrollSwitch) {
        autoScrollSwitch.addEventListener('change', (e) => {
            isAutoScrollEnabled = e.target.checked;
            saveSettings('autoScroll', isAutoScrollEnabled);
        });
    }

    // 初始化设置
    await initSettings();

    // 添加滚轮事件监听
    chatContainer.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) { // 向上滚动
            shouldAutoScroll = false;
        }
    });

    // 简化滚动到底部的函数
    function scrollToBottom() { // 移除 force 参数
        if (!isAutoScrollEnabled) {
            return;
        }

        if (shouldAutoScroll) {
            requestAnimationFrame(() => {
                chatContainer.scrollTo({
                    top: chatContainer.scrollHeight,
                    behavior: 'smooth'
                });
            });
        }
    }

    // 添加收起按钮点击事件
    collapseButton.addEventListener('click', () => {
        window.parent.postMessage({
            type: 'CLOSE_SIDEBAR'
        }, '*');
    });

    // 添加划词搜索清空聊天开关事件监听
    const clearOnSearchSwitch = document.getElementById('clear-on-search-switch');
    if (clearOnSearchSwitch) {
        clearOnSearchSwitch.addEventListener('change', (e) => {
            saveSettings('clearOnSearch', e.target.checked);
        });
    }

    // 更新发送按钮状态
    function updateSendButtonState() {
        const hasContent = messageInput.textContent.trim() || messageInput.querySelector('.image-tag');
        sendButton.disabled = !hasContent;
    }

    // 添加发送按钮点击事件
    sendButton.addEventListener('click', () => {
        const text = messageInput.textContent.trim();
        if (text || messageInput.querySelector('.image-tag')) {
            sendMessage();
        }
    });

    // 初始化发送按钮状态
    updateSendButtonState();

    // 添加清空聊天右键菜单项的点击事件处理
    clearChatContextButton.addEventListener('click', () => {
        clearChatHistory();
        hideContextMenu();
    });

    /**
     * 保存或更新当前对话至持久存储 (使用 chrome.storage.local)
     * @param {boolean} [isUpdate=false] - 是否为更新操作
     * @returns {void}
     */
    function saveCurrentConversation(isUpdate = false) {
        if (chatHistory.messages.length === 0) return;
        const messages = chatHistory.messages.slice();
        const timestamps = messages.map(msg => msg.timestamp);
        const startTime = Math.min(...timestamps);
        const endTime = Math.max(...timestamps);
        
        // 找到第一条有文字内容的消息
        const firstMessageWithContent = messages.find(msg => msg.content?.trim());
        let summary = '';
        if (firstMessageWithContent?.content) {
            let content = firstMessageWithContent.content;
            // 替换预设模板为模板名称
            const prompts = promptSettingsManager.getPrompts();
            if (content.includes(prompts.selection.prompt)) {
                content = content.replace(prompts.selection.prompt, '[划词搜索]');
            }
            if (content.includes(prompts.pdf.prompt)) {
                content = content.replace(prompts.pdf.prompt, '[PDF总结]');
            }
            if (content.includes(prompts.summary.prompt)) {
                content = content.replace(prompts.summary.prompt, '[页面总结]');
            }
            if (content.includes(prompts.query.prompt)) {
                content = content.replace(prompts.query.prompt, '[划词解释]');
            }
            if (content.includes(prompts.image.prompt)) {
                content = content.replace(prompts.image.prompt, '[图片分析]');
            }
            summary = content.substring(0, 50);
        }
        
        const generateConversationId = () => `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const conversation = {
            id: isUpdate ? (currentConversationId || generateConversationId()) : generateConversationId(),
            url: currentUrl,
            startTime, 
            endTime,
            messages,
            summary,
            messageCount: messages.length
        };

        chrome.storage.local.get({ conversationHistories: [] }, (result) => {
            let histories = result.conversationHistories;
            
            if (isUpdate && currentConversationId) {
                const index = histories.findIndex(conv => conv.id === currentConversationId);
                if (index !== -1) {
                    histories[index] = conversation;
                }
            } else {
                histories.push(conversation);
                currentConversationId = conversation.id;
            }

            chrome.storage.local.set({ conversationHistories: histories }, () => {
                console.log(`已${isUpdate ? '更新' : '保存'}对话记录:`, conversation);
            });
        });
    }
    
    /**
     * 显示聊天记录面板，用于读取以前的对话记录
     */
    function showChatHistoryPanel() {
        let panel = document.getElementById('chat-history-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'chat-history-panel';
            
            // 添加标题栏
            const header = document.createElement('div');
            header.className = 'panel-header';
            
            const title = document.createElement('span');
            title.textContent = '聊天记录';
            title.className = 'panel-title';
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', () => { panel.remove(); });
            
            header.appendChild(title);
            header.appendChild(closeBtn);
            panel.appendChild(header);
            
            // 域名筛选输入框
            const filterContainer = document.createElement('div');
            filterContainer.className = 'filter-container';
            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.placeholder = '按域名筛选...';
            filterInput.addEventListener('input', () => {
                loadConversationHistories(panel, filterInput.value);
            });
            filterContainer.appendChild(filterInput);
            panel.appendChild(filterContainer);
            
            // 列表容器
            const listContainer = document.createElement('div');
            listContainer.id = 'chat-history-list';
            panel.appendChild(listContainer);
            document.body.appendChild(panel);

            // 添加存储变化监听器
            const storageChangeListener = (changes, areaName) => {
                if (areaName === 'local' && changes.conversationHistories) {
                    const filterInput = panel.querySelector('input[type="text"]');
                    if (filterInput) {
                        loadConversationHistories(panel, filterInput.value);
                    }
                }
            };

            // 添加监听器
            chrome.storage.onChanged.addListener(storageChangeListener);

            // 当面板关闭时移除监听器
            const originalClickHandler = closeBtn.onclick;
            closeBtn.onclick = () => {
                chrome.storage.onChanged.removeListener(storageChangeListener);
                if (originalClickHandler) {
                    originalClickHandler();
                }
                panel.remove();
            };
        }
        // 加载默认（不过滤）的对话记录列表
        loadConversationHistories(panel, '');
    }
    
    /**
     * 从存储中加载聊天记录，并填充到面板中
     * @param {HTMLElement} panel - 聊天记录面板
     * @param {string} filterText - 域名筛选内容
     */
    function loadConversationHistories(panel, filterText) {
        const listContainer = panel.querySelector('#chat-history-list');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        chrome.storage.local.get({ conversationHistories: [] }, (result) => {
            let histories = result.conversationHistories || [];
            if (filterText) {
                const lowerFilter = filterText.toLowerCase();
                histories = histories.filter(conv => {
                    const url = (conv.url || '').toLowerCase();
                    const summary = (conv.summary || '').toLowerCase();
                    const messagesContent = conv.messages && conv.messages.length
                        ? conv.messages.map(msg => msg.content || '').join(' ')
                        : '';
                    const lowerMessages = messagesContent.toLowerCase();
                    return url.includes(lowerFilter) || summary.includes(lowerFilter) || lowerMessages.includes(lowerFilter);
                });
            }

            if (histories.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.textContent = '暂无聊天记录';
                listContainer.appendChild(emptyMsg);
                return;
            }
            // 按结束时间降序排序
            histories.sort((a, b) => b.endTime - a.endTime);
            histories.forEach(conv => {
                const item = document.createElement('div');
                item.className = 'chat-history-item';
                
                const summaryDiv = document.createElement('div');
                summaryDiv.className = 'summary';
                summaryDiv.textContent = conv.summary;
                
                const infoDiv = document.createElement('div');
                infoDiv.className = 'info';
                const date = new Date(conv.startTime).toLocaleString();
                infoDiv.textContent = `消息数: ${conv.messageCount}，时间: ${date}，url: ${conv.url}`;
                

                item.appendChild(summaryDiv);
                item.appendChild(infoDiv);
                item.addEventListener('click', () => {
                    loadConversationIntoChat(conv);
                    // 保持聊天记录面板打开
                });
                listContainer.appendChild(item);
            });
        });
    }
    
    /**
     * 加载选中的对话记录到当前聊天窗口
     * @param {Object} conversation - 对话记录对象
     */
    function loadConversationIntoChat(conversation) {
        // 清空当前聊天容器
        chatContainer.innerHTML = '';
        // 遍历对话中的每条消息并显示，并确保 AI 消息的角色为 "ai"
        conversation.messages.forEach(msg => {
            const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
            appendMessage(msg.content, role, true);
        });
        // 清空当前对话管理（开始新会话）
        clearHistory();
    }

    // 添加聊天记录菜单项监听
    const chatHistoryMenuItem = document.getElementById('chat-history-menu');
    if (chatHistoryMenuItem) {
        chatHistoryMenuItem.addEventListener('click', () => {
            showChatHistoryPanel();
            toggleSettingsMenu(false);
        });
    }
});