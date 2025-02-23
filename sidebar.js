import { PromptSettings } from './prompt_settings.js';
import { createChatHistoryManager } from './chat_history_manager.js';
import { getAllConversations, putConversation, deleteConversation, getConversationById } from './indexeddb_helper.js';
import { initTreeDebugger } from './tree_debugger.js';
import { GoogleGenerativeAI } from './lib/generative-ai.js'; // 导入生成式 AI 模块

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
    const showReferenceSwitch = document.getElementById('show-reference-switch');
    const copyCodeButton = document.getElementById('copy-code');
    const imageContainer = document.getElementById('image-container');
    const promptSettingsToggle = document.getElementById('prompt-settings-toggle');
    const promptSettings = document.getElementById('prompt-settings');
    
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
    let currentPageInfo = null;
    let currentCodeBlock = null;

    /**
     * 迁移旧有的 chrome.storage.local 对话记录到 IndexedDB
     * @returns {Promise<void>}
     */
    async function migrateLocalHistoriesToIndexedDB() {
        return new Promise((resolve) => {
            chrome.storage.local.get({ conversationHistories: [] }, async (result) => {
                const localHistories = result.conversationHistories;
                if (localHistories && localHistories.length > 0) {
                    console.log("检测到 local storage 中已有对话记录，开始迁移到 IndexedDB...");
                    for (const conv of localHistories) {
                        try {
                            await putConversation(conv);
                        } catch (error) {
                            console.error("迁移对话记录失败:", conv.id, error);
                        }
                    }
                    chrome.storage.local.remove("conversationHistories", () => {
                        console.log("迁移完成：已从 chrome.storage.local 移除 conversationHistories");
                        resolve();
                    });
                } else {
                    console.log("没有检测到需要迁移的 local storage 对话记录");
                    resolve();
                }
            });
        });
    }

    // 执行对话记录的迁移
    await migrateLocalHistoriesToIndexedDB();

    // Create ChatHistoryManager instance
    const {
        chatHistory,
        addMessageToTree,
        getCurrentConversationChain,
        clearHistory,
        deleteMessage
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
    });

    // 添加公共的图片处理函数
    function processImageTags(content, imagesHTML) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = imagesHTML;
        const imageTags = tempDiv.querySelectorAll('.image-tag');

        if (imageTags.length > 0) {
            const result = [];
            // 添加文本内容
            if (content) {
                result.push({
                    type: "text",
                    text: content
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

            if (showReferenceSwitch.checked) {
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
     * 获取提示词类型
     * @param {HTMLElement|string} content - 输入内容，可以是HTML元素或字符串
     * @returns {string} 提示词类型 ('image'|'pdf'|'summary'|'selection'|'query'|'system')
     */
    function getPromptTypeFromContent(content) {
        // 如果content是空字符串，就判断为图片提示词
        const prompts = promptSettingsManager.getPrompts();

        // 检查是否是PDF提示词
        if (prompts.pdf.prompt && content === prompts.pdf.prompt) {
            return 'pdf';
        }

        // 检查是否是页面总结提示词
        if (prompts.summary.prompt && content === prompts.summary.prompt) {
            return 'summary';
        }

        // 检查是否是划词搜索提示词，将 selection prompt 中的 "<SELECTION>" 移除后进行匹配
        if (prompts.selection.prompt) {
            const selectionPromptKeyword = prompts.selection.prompt.split('<SELECTION>')[0];
            if (selectionPromptKeyword && content.startsWith(selectionPromptKeyword)) {
                return 'selection';
            }
        }

        return 'none';
    }

    // 在 getPromptTypeFromContent 函数之后，新增如下辅助函数

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


    //这段逻辑太扯淡了，需要重构
    //为什么扯淡：
    //1. 本来应该用参数传递的消息，居然绕了一大圈，先append到界面，再清空，再获取消息内容

    // 怎么重构：
    //1. 用参数传递消息，不要绕一大圈




    async function sendMessage() {
        
        function clearMessageInput() {
            messageInput.innerHTML = '';
            imageContainer.innerHTML = '';
        }

        function checkAPI(){
            let config = apiConfigs[selectedConfigIndex];
            if (!config?.baseUrl || !config?.apiKey) {
                appendMessage('请在设置中完善 API 配置', 'ai', true);
                return;
            }    
        }
        
        const imageTags = imageContainer.querySelectorAll('.image-tag');
        let messageText = messageInput.textContent;
        
        // 如果消息为空且没有图片标签，则不发送消息
        const isEmptyMessage = !messageText && imageTags.length === 0;

        // 获取当前提示词设置
        const prompts = promptSettingsManager.getPrompts();
        const currentPromptType = imageTags.length > 0 && messageText === '' ? 'image' : getPromptTypeFromContent(messageText);

        // 提前创建 loadingMessage 配合finally使用
        let loadingMessage;

        try {
            // 开始处理消息
            isProcessingMessage = true;
            shouldAutoScroll = true;

            // 如果存在之前的请求，先中止它
            if (currentController) {
                currentController.abort();
                currentController = null;
            }

            // 创建新的 AbortController
            currentController = new AbortController();
            const signal = currentController.signal;

            // 当开始生成时，给聊天容器添加 glow 效果
            chatContainer.classList.add('auto-scroll-glow');

            // 提取提示词中注入的系统消息
            const systemMessageRegex = /{{system}}([\s\S]*?){{end_system}}/g;
            const injectedSystemMessages = [];
            messageText = messageText.replace(systemMessageRegex, (match, capture) => {
                injectedSystemMessages.push(capture);
                console.log('捕获注入的系统消息：', injectedSystemMessages);
                return '';
            });

            let userMessageDiv;
            if (!isEmptyMessage) {
                // 添加用户消息，同时包含文本和图片区域
                userMessageDiv = appendMessage(messageText, 'user', false, null, imageContainer.innerHTML);
            }

            clearMessageInput();
            adjustTextareaHeight(messageInput);

            // 添加加载状态消息
            loadingMessage = appendMessage('正在处理...', 'ai', true);
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
                    userMessageDiv?.appendChild(footer);
                } else {
                    pageContent = null;
                    console.error('获取网页内容失败。');
                }
            } else {
                pageContent = null;  // 临时模式下不使用网页内容
            }

            // 构建消息数组
            const messages = [];

            const pageContentPrompt = pageContent
                ? `\n\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
                : '';

            // 组合系统消息+注入的系统消息+网页内容
            let systemMessageContent = prompts.system.prompt;
            systemMessageContent += "\n" + injectedSystemMessages.join('\n');
            systemMessageContent += pageContentPrompt;

            // 构建系统消息对象
            const systemMessage = {
                role: "system",
                content: systemMessageContent
            };
            
            // 将系统消息添加到消息数组
            messages.push(systemMessage);

            // 获取当前会话链
            const conversationChain = getCurrentConversationChain();

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

            // 确定要使用的模型配置
            let targetConfig = null;
            // 只判断一次 prompttype，重用之前的 currentPromptType
            if (currentPromptType !== 'none' && prompts[currentPromptType] && prompts[currentPromptType].model !== 'follow_current') {
                targetConfig = apiConfigs.find(c => c.modelName === prompts[currentPromptType].model);
            }

            // 如果没找到目标配置，使用当前配置
            const config = targetConfig || apiConfigs[selectedConfigIndex];

            // 更新加载状态消息
            loadingMessage.textContent = '正在等待 AI 回复...';

            // 构造 API 请求体
            let requestBody = {
                model: config.modelName,
                messages: messages,
                stream: true,
                temperature: config.temperature,
                top_p: 0.95,
            };

            // 如果存在自定义参数，则尝试解析 JSON 字符串并合并到请求体中
            if (config.customParams) {
                try {
                    const extraParams = JSON.parse(config.customParams);
                    requestBody = { ...requestBody, ...extraParams };
                } catch (e) {
                    console.error("解析自定义参数 JSON 失败，请检查格式。", e);
                }
            }

            // 发送API请求
            const response = await fetch(config.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(requestBody),
                signal
            });

            if (!response.ok) {
                const error = await response.text();
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
                                    // First tokens received: remove the loading message and auto-scroll immediately.
                                    loadingMessage.remove();
                                    hasStartedResponse = true;
                                    scrollToBottom(); // <-- New call to ensure auto-scroll on first tokens.
                                }
                                aiResponse += deltaContent;
                                aiResponse = aiResponse.replace(/\nabla/g, '\\nabla');
                                updateAIMessage(aiResponse, data.choices?.[0]?.groundingMetadata);
                            }
                        } catch (e) {
                            console.error('解析响应出错:', e);
                        }
                    }
                }
            }

            // 消息处理完成后，自动保存会话
            if (currentConversationId) {
                saveCurrentConversation(true); // 更新现有会话记录
            } else {
                saveCurrentConversation(false); // 新会话，生成新的 conversation id
            }

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
        } finally {
            // 无论成功还是失败，都重置处理状态
            isProcessingMessage = false;
            shouldAutoScroll = false;
            // 当生成结束时，移除 glow 效果
            chatContainer.classList.remove('auto-scroll-glow');
            // 当生成结束时，移除 loading 效果
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

                        sourcesList.appendChild(ul);
                        lastMessage.appendChild(sourcesList);

                        // Add web search queries section if available
                        if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
                            const searchQueriesList = document.createElement('div');
                            searchQueriesList.className = 'search-queries-list';
                            searchQueriesList.innerHTML = '<h4>搜索查询：</h4>';
                            const ul = document.createElement('ul');

                            groundingMetadata.webSearchQueries.forEach(query => {
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

        // // 替换美元符号包围的块级数学表达式
        // text = text.replace(/(\$\$[\s\S]+?\$\$)/g, (match, p1) => {
        //     const placeholder = `😎DOLLARBLOCK_MATH_${counter}😎`;
        //     mathExpressions.push({ placeholder, content: p1.slice(2, -2), originalContent: p1, type: 'dollarblock' });
        //     counter++;
        //     return placeholder;
        // });

        // // 替换美元符号包围的行内数学表达式
        // text = text.replace(/(\$[^\$\n]+?\$)/g, (match, p1) => {
        //     const placeholder = `😎DOLLAR_MATH_${counter}😎`;
        //     mathExpressions.push({ placeholder, content: p1.slice(1, -1), originalContent: p1, type: 'dollarinline' });
        //     counter++;
        //     return placeholder;
        // });

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

    // 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
    function fixBoldParsingIssue(text) {
        // 在所有**前后添加零宽空格，以修复粗体解析问题
        return text.replace(/\*\*/g, '\u200B**\u200B');
    }

    /**
     * 根据正则折叠消息文本，将从文本开头到首次出现 "\n# " 之间的部分折叠为可展开元素。
     * @param {string} text - 原始消息文本
     * @returns {string} 处理后的消息文本，其中符合条件的部分被包裹在一个折叠元素中
     * @example
     * // 输入 "简介内容\n# 正文开始"，返回格式化后的HTML，其中"简介内容"被折叠
     */
    function foldMessageContent(text) {
        const regex = /^([\s\S]*?)(?=\n# )/;
        const match = text.match(regex);
        if (!match || match[1].trim() === '') {
            return text;
        }
        const foldedPart = match[1];
        const remainingPart = text.slice(match[1].length);
        // 将折叠部分包裹在 <blockquote> 中，以实现 Markdown 引用效果
        const quotedFoldedPart = `<blockquote>${foldedPart}</blockquote>`;
        return `<details class="folded-message"><summary>搜索过程</summary><div>\n${quotedFoldedPart}</div></details>\n${remainingPart}`;
    }

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'DROP_IMAGE') {
            console.log('收到拖放图片数据');
            const imageData = event.data.imageData;
            if (imageData && imageData.data) {
                addImageToContainer(imageData.data, imageData.name);
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
            currentPageInfo = event.data;
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
        } else if (event.data.type === 'QUICK_SUMMARY_COMMAND_QUERY') {
            performQuickSummary(event.data.selectedContent, true);
        } else if (event.data.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
            // 调用已有的toggle逻辑
            if (isTemporaryMode) {
                exitTemporaryMode();
            } else {
                enterTemporaryMode();
            }
        }
    });

    /**
     * 添加消息到聊天窗口，同时支持文本和图片区域。
     * @param {string} text - 文本消息内容
     * @param {string} sender - 消息发送者 ('user' 或 'ai')
     * @param {boolean} skipHistory - 是否不更新历史记录
     * @param {HTMLElement|null} fragment - 如使用文档片段则追加到此处，否则直接追加到聊天容器
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
                    showImagePreview(img.src);
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
            const processedContent = processImageTags(text, imagesHTML);
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
        if (this.textContent.trim() === '') {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        }
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
        toggleSettingsMenu(false);
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

        // 新增：处理自定义参数输入
        const customParamsInput = template.querySelector('.custom-params');
        if (customParamsInput) {
            customParamsInput.value = config.customParams || '';
            customParamsInput.addEventListener('change', () => {
                apiConfigs[index].customParams = customParamsInput.value;
                saveAPIConfigs();
            });
            // 当输入完成后，尝试格式化为美化后的 JSON 格式，并在格式错误时在UI上提示
            customParamsInput.addEventListener('blur', () => {
                // 如果输入内容为空，则不作解析
                if (customParamsInput.value.trim() === "") {
                    customParamsInput.style.borderColor = "";
                    let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
                    if (errorElem) {
                        errorElem.remove();
                    }
                    apiConfigs[index].customParams = "";
                    saveAPIConfigs();
                    return;
                }
                try {
                    const parsed = JSON.parse(customParamsInput.value);
                    // 格式化为两格缩进的 JSON 字符串
                    customParamsInput.value = JSON.stringify(parsed, null, 2);
                    apiConfigs[index].customParams = customParamsInput.value;
                    // 如果存在错误提示，则移除
                    let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
                    if (errorElem) {
                        errorElem.remove();
                    }
                    customParamsInput.style.borderColor = "";
                    saveAPIConfigs();
                } catch (e) {
                    // 设置红色边框
                    customParamsInput.style.borderColor = "red";
                    // 创建或更新错误提示元素
                    let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
                    if (!errorElem) {
                        errorElem = document.createElement("div");
                        errorElem.className = "custom-params-error";
                        errorElem.style.color = "red";
                        errorElem.style.fontSize = "12px";
                        errorElem.style.marginTop = "4px";
                        customParamsInput.parentNode.appendChild(errorElem);
                    }
                    errorElem.textContent = "格式化失败：请检查 JSON 格式";
                    console.error("自定义参数格式化失败:", e);
                }
            });
        }

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
                }
            });

            favoriteApisList.appendChild(item);
        });
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();

    // 显示/隐藏 API 设置
    apiSettingsToggle.addEventListener('click', () => {
        const wasVisible = apiSettings.classList.contains('visible');
        closeExclusivePanels();

        if (!wasVisible) {
            apiSettings.classList.toggle('visible');
            renderAPICards();
        }
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

    // 清空聊天记录功能，并保存当前对话至持久存储（每次聊天会话结束自动保存）
    async function clearChatHistory() { // 改为 async 函数
        // 如果有消息，等待保存完成
        if (chatHistory.messages.length > 0) {
            await saveCurrentConversation(true);
        }
        // 如果有正在进行的请求，则中止更新
        if (currentController) {
            currentController.abort();
            currentController = null;
        }
        // 清空聊天容器和内存中的聊天记录
        chatContainer.innerHTML = '';
        clearHistory();
        // 重置当前会话ID，确保下次发送新消息创建新会话
        currentConversationId = null;
    }

    const clearChat = document.getElementById('clear-chat');
    clearChat.addEventListener('click', async () => {
        await clearChatHistory();
        toggleSettingsMenu(false);
        messageInput.focus();
        // 移动光标到输入框末尾
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

    async function performQuickSummary(webpageSelection = null, forceQuery = false) {
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
                    await clearChatHistory();
                }

                // 根据模型名称决定使用哪个提示词
                // 新增：forceQuery为true时, 强制使用 'query' 提示词
                const promptType = forceQuery ? 'query' : ((prompts.selection.model || '').endsWith('-search') ? 'selection' : 'query');
                const prompt = prompts[promptType].prompt.replace('<SELECTION>', selectedText);
                messageInput.textContent = prompt;

                // 发送消息
                await sendMessage();
            } else {
                if (wasTemporaryMode) {
                    exitTemporaryMode();
                }
                await clearChatHistory();

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

    // 修改右键菜单显示逻辑
    function showContextMenu(e, messageElement) {
        e.preventDefault();
        currentMessageElement = messageElement;

        // 设置菜单位置
        contextMenu.style.display = 'block';

        // 获取点击的代码块元素
        const codeBlock = e.target.closest('pre code');
        const copyCodeButton = document.getElementById('copy-code');

        // 根据消息状态显示或隐藏停止更新按钮
        if (messageElement.classList.contains('updating')) {
            stopUpdateButton.style.display = 'flex';
        } else {
            stopUpdateButton.style.display = 'none';
        }

        // 根据是否点击代码块显示或隐藏复制代码按钮
        if (codeBlock) {
            copyCodeButton.style.display = 'flex';
            currentCodeBlock = codeBlock;
        } else {
            copyCodeButton.style.display = 'none';
            currentCodeBlock = null;
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

    // 添加复制代码块功能
    function copyCodeContent() {
        if (currentCodeBlock) {
            const codeContent = currentCodeBlock.textContent;
            navigator.clipboard.writeText(codeContent).then(() => {
                hideContextMenu();
            }).catch(err => {
                console.error('复制失败:', err);
            });
        }
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

    // 监听消息（用户或 AI）右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        // 如果按住了Ctrl、Shift或Alt键，则显示默认菜单
        if (e.ctrlKey || e.shiftKey || e.altKey) {
            return;
        }
        // 修改：允许用户和 AI 消息都触发右键菜单
        const messageElement = e.target.closest('.message');
        if (messageElement) {
        e.preventDefault();
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
                addImageToContainer(reader.result, file.name);
            };
            reader.readAsDataURL(file);
        } else {
            // 修改：处理纯文本粘贴，避免插入富文本
            const text = e.clipboardData.getData('text/plain');
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                range.deleteContents();
                const textNode = document.createTextNode(text);
                range.insertNode(textNode);
                // 移动光标到新插入的文本节点之后
                range.setStartAfter(textNode);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    });


    // 创建图片标签
    function createImageTag(base64Data, fileName) {
        const container = document.createElement('span');
        container.className = 'image-tag';
        container.contentEditable = false;
        container.setAttribute('data-image', base64Data);
        container.title = fileName || ''; // 添加悬停提示

        const thumbnail = document.createElement('img');
        thumbnail.src = base64Data;
        thumbnail.alt = fileName || '';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
        deleteBtn.title = '删除图片';

        // 点击删除按钮时除整个标签
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.remove();
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
                        addImageToContainer(reader.result, file.name);
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
                        addImageToContainer(imageData.data, imageData.name);
                    }
                } catch (error) {
                    console.error('处理拖放数据失败:', error);
                }
            }
        } catch (error) {
            console.error('处理拖放事件失败:', error);
        }
    }

    messageInput.addEventListener('drop', (e) => handleImageDrop(e, messageInput));

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

    // 修改滚轮事件监听：
    // 当用户向上滚动时，禁用自动滚动；
    // 当用户向下滚动时，检查离底部距离，如果距离小于50px，则重新启用自动滚动
    chatContainer.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) { // 向上滚动
            shouldAutoScroll = false;
        } else if (e.deltaY > 0) { // 向下滚动时检查底部距离
            const threshold = 50; // 距离底部小于50px认为接近底部
            const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
            if (distanceFromBottom < threshold) {
                shouldAutoScroll = true;
            }
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
                    behavior: 'auto' // 取消平滑滚动，立即滚动到底部
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
    clearChatContextButton.addEventListener('click', async () => {
        await clearChatHistory();
        hideContextMenu();
    });





    /**
     * 提取消息的纯文本内容
     * @param {Object} msg - 消息对象
     * @returns {string} 纯文本内容
     */
    function extractMessagePlainText(msg) {
        if (typeof msg.content === 'string') {
            return msg.content.trim();
        } else if (Array.isArray(msg.content)) {
            return msg.content.map(part => part.type === 'image_url' ? '[图片]' : part.text.trim()).join(' ');
        }
        return '';
    }

    /**
     * 保存或更新当前对话至持久存储 (使用 chrome.storage.local)
     * @param {boolean} [isUpdate=false] - 是否为更新操作
     * @returns {void}
     */
    async function saveCurrentConversation(isUpdate = false) {
        if (chatHistory.messages.length === 0) return;
        const messages = chatHistory.messages.slice();
        const timestamps = messages.map(msg => msg.timestamp);
        const startTime = Math.min(...timestamps);
        const endTime = Math.max(...timestamps);

        // 提取第一条消息的纯文本内容
        const firstMessageTextContent = extractMessagePlainText(messages.find(msg => extractMessagePlainText(msg) !== ''));
        
        let summary = '';
        if (firstMessageTextContent) {
            // 使用 getPlainText 转换为字符串
            let content = firstMessageTextContent;
            const prompts = promptSettingsManager.getPrompts();
            
            // 替换预设模板为模板名称
            const selectionPrompt = prompts.selection.prompt.split('<SELECTION>');
            const selectionPromptPrefix = selectionPrompt[0].trim();
            if (content.includes(selectionPromptPrefix)) {
                content = content.replace(selectionPromptPrefix, '[搜索]');
                if (selectionPrompt.length > 1) {
                    content = content.replace(selectionPrompt[1], '');
                }
            }
            
            const queryPrompt = prompts.query.prompt.split('<SELECTION>');
            const queryPromptPrefix = queryPrompt[0].trim();
            if (content.includes(queryPromptPrefix)) {
                content = content.replace(queryPromptPrefix, '[解释]');
                if (queryPrompt.length > 1) {
                    content = content.replace(queryPrompt[1], '');
                }
            }

            if (content.includes(prompts.pdf.prompt)) {
                content = content.replace(prompts.pdf.prompt, '[PDF总结]');
            }
            if (content.includes(prompts.summary.prompt)) {
                content = content.replace(prompts.summary.prompt, '[总结]');
            }
            summary = content.substring(0, 50);
        }

        let urlToSave = currentPageInfo.url;
        let titleToSave = currentPageInfo.title;
        // 如果是更新操作并且已存在记录，则固定使用首次保存的 url
        if (isUpdate && currentConversationId) {
            try {
                const existingConversation = await getConversationById(currentConversationId);
                if (existingConversation) {
                    urlToSave = existingConversation.url;
                    titleToSave = existingConversation.title;
                }
            } catch (error) {
                console.error("获取会话记录失败:", error);
            }
        }

        const generateConversationId = () => `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const conversation = {
            id: isUpdate ? (currentConversationId || generateConversationId()) : generateConversationId(),
            url: urlToSave,
            title: titleToSave,
            startTime,
            endTime,
            messages,
            summary,
            messageCount: messages.length
        };

        // 使用 IndexedDB 存储对话记录
        await putConversation(conversation);
        currentConversationId = conversation.id;
        console.log(`已${isUpdate ? '更新' : '保存'}对话记录:`, conversation);
    }

    /**
     * 显示聊天记录面板，用于读取以前的对话记录
     */
    function showChatHistoryPanel() {
        let panel = document.getElementById('chat-history-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'chat-history-panel';

            // 添加标题栏（包含标题、备份、还原和关闭按钮在同一行）
            const header = document.createElement('div');
            header.className = 'panel-header';

            const title = document.createElement('span');
            title.textContent = '聊天记录';
            title.className = 'panel-title';

            // 创建按钮容器，将备份、还原和关闭按钮放在同一行，样式与关闭按钮一致
            const headerActions = document.createElement('div');
            headerActions.className = 'header-actions';

            const refreshButton = document.createElement('button');
            refreshButton.textContent = '刷新';
            refreshButton.addEventListener('click', refreshChatHistory);

            const backupButton = document.createElement('button');
            backupButton.textContent = '备份';
            backupButton.addEventListener('click', backupConversations);

            const restoreButton = document.createElement('button');
            restoreButton.textContent = '还原';
            restoreButton.addEventListener('click', restoreConversations);

            const closeBtn = document.createElement('button');
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', () => { panel.remove(); });

            headerActions.appendChild(refreshButton);
            headerActions.appendChild(backupButton);
            headerActions.appendChild(restoreButton);
            headerActions.appendChild(closeBtn);

            header.appendChild(title);
            header.appendChild(headerActions);
            panel.appendChild(header);

            // 域名筛选输入框
            const filterContainer = document.createElement('div');
            filterContainer.className = 'filter-container';
            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.placeholder = '筛选...';
            let debounceTimer;
            filterInput.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    loadConversationHistories(panel, filterInput.value);
                }, 300);
            });
            filterContainer.appendChild(filterInput);
            panel.appendChild(filterContainer);

            // 列表容器
            const listContainer = document.createElement('div');
            listContainer.id = 'chat-history-list';
            panel.appendChild(listContainer);
            document.body.appendChild(panel);

            // --- Modified: Close panel only when clicking on chat-container ---
            chatContainer.addEventListener('click', function onChatContainerClick(event) {
                closeChatHistoryPanel();
                chatContainer.removeEventListener('click', onChatContainerClick);
            });
            // --- End Modified ---
        }
        // 加载默认（不过滤）的对话记录列表
        loadConversationHistories(panel, '');

        // 设置面板显示，并触发 CSS 淡入动画
        panel.style.display = 'flex';  // 面板采用 flex 布局
        void panel.offsetWidth;         // 强制重排，让 CSS transition 起效
        panel.classList.add('visible');
    }

    /**
     * 格式化相对时间字符串
     * @param {Date} date - 日期对象
     * @returns {string} 相对时间描述，例如 "5分钟前"、"2小时前"、"3天前"、"2周前"、"4月前"
     */
    function formatRelativeTime(date) {
        const now = new Date();
        const diff = now - date; // 毫秒差
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return `${seconds}秒前`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}分钟前`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}小时前`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}天前`;
        const weeks = Math.floor(days / 7);
        if (weeks < 4) return `${weeks}周前`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}月前`;
        const years = Math.floor(days / 365);
        return `${years}年前`;
    }

    /**
     * 根据日期生成分组标签
     * @param {Date} date - 日期对象
     * @returns {string} 分组标签，如 "今天"、"昨天"、"本周"、"上周"、"本月" 或 "YYYY年M月"
     */
    function getGroupLabel(date) {
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return "今天";
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return "昨天";
        // 以星期一为一周起点
        const day = now.getDay(); // 0代表星期日
        const diffToMonday = (day === 0 ? 6 : day - 1);
        const monday = new Date(now);
        monday.setDate(now.getDate() - diffToMonday);
        if (date >= monday) return "本周";
        const lastMonday = new Date(monday);
        lastMonday.setDate(monday.getDate() - 7);
        if (date >= lastMonday) return "上周";
        if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
            return "本月";
        }
        return `${date.getFullYear()}年${date.getMonth() + 1}月`;
    }

    // ----------------------------------------
    // 修改聊天记录加载函数 loadConversationHistories
    // ----------------------------------------
    function loadConversationHistories(panel, filterText) {
        const listContainer = panel.querySelector('#chat-history-list');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        getAllConversations().then(histories => {
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

            // 根据会话的开始时间进行分组
            const groups = {};
            const groupLatestTime = {}; // 用于记录各分组中最新的会话时间以便排序
            histories.forEach(conv => {
                const convDate = new Date(conv.startTime);
                const groupLabel = getGroupLabel(convDate);
                if (!groups[groupLabel]) {
                    groups[groupLabel] = [];
                    groupLatestTime[groupLabel] = convDate.getTime();
                } else {
                    groupLatestTime[groupLabel] = Math.max(groupLatestTime[groupLabel], convDate.getTime());
                }
                groups[groupLabel].push(conv);
            });

            // 根据每个分组中最新的时间降序排序分组
            const sortedGroupLabels = Object.keys(groups).sort((a, b) => groupLatestTime[b] - groupLatestTime[a]);

            sortedGroupLabels.forEach(groupLabel => {
                // 创建分组标题
                const groupHeader = document.createElement('div');
                groupHeader.className = 'chat-history-group-header';
                groupHeader.textContent = groupLabel;
                listContainer.appendChild(groupHeader);

                groups[groupLabel].forEach(conv => {
                    const item = document.createElement('div');
                    item.className = 'chat-history-item';

                    const summaryDiv = document.createElement('div');
                    summaryDiv.className = 'summary';
                    let displaySummary = conv.summary;
                    if (filterText && filterText.trim() !== "") {
                        const regex = new RegExp(`(${filterText})`, 'gi');
                        displaySummary = displaySummary.replace(regex, '<mark>$1</mark>');
                    }
                    summaryDiv.innerHTML = displaySummary;
                    const infoDiv = document.createElement('div');
                    infoDiv.className = 'info';
                    const convDate = new Date(conv.startTime);
                    const relativeTime = formatRelativeTime(convDate);

                    // 提取 URL 中的 domain
                    let domain = '';
                    if (conv.url) {
                        try {
                            const urlObj = new URL(conv.url);
                            domain = urlObj.hostname;
                        } catch (error) {
                            domain = conv.url;
                        }
                    } else {
                        domain = '未知';
                    }

                    let title = conv.title;

                    const displayInfos = [relativeTime, `消息数: ${conv.messageCount}`, domain].filter(Boolean).join(' · ');
                    infoDiv.textContent = displayInfos;
                    // 新增：鼠标悬停显示具体的日期时间

                    const details = [convDate.toLocaleString(), title, conv.url].filter(Boolean).join('\n');
                    infoDiv.title = details;

                    item.appendChild(summaryDiv);
                    item.appendChild(infoDiv);

                    // 如果有筛选关键字, 尝试提取所有匹配关键字附近的内容作为 snippet
                    if (filterText && filterText.trim() !== "") {
                        let snippets = [];
                        let totalMatches = 0;
                        // 对 filterText 进行转义，避免正则特殊字符问题
                        const escapedFilter = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const lowerFilter = filterText.toLowerCase();
                        // 预先构造用于高亮的正则对象
                        const highlightRegex = new RegExp(escapedFilter, 'gi');
                        if (conv.messages && Array.isArray(conv.messages)) {
                            for (const msg of conv.messages) {
                                const plainText = extractMessagePlainText(msg);
                                if (plainText) {
                                    const content = plainText;
                                    const contentLower = content.toLowerCase();
                                    // 若当前消息中未包含关键字，则跳过
                                    if (contentLower.indexOf(lowerFilter) === -1) continue;
                                    let startIndex = 0;
                                    while (true) {
                                        const index = contentLower.indexOf(lowerFilter, startIndex);
                                        if (index === -1) break;
                                        totalMatches++;
                                        if (snippets.length < 5) {
                                            const snippetStart = Math.max(0, index - 30);
                                            const snippetEnd = Math.min(content.length, index + filterText.length + 30);
                                            let snippet = content.substring(snippetStart, snippetEnd);
                                            // 高亮 snippet 中所有匹配关键字，复用 highlightRegex
                                            snippet = snippet.replace(highlightRegex, '<mark>$&</mark>');
                                            snippets.push(snippet);
                                        }
                                        startIndex = index + 1;
                                    }
                                }
                            }
                        }
                        if (snippets.length > 0) {
                            const snippetDiv = document.createElement('div');
                            snippetDiv.className = 'highlight-snippet';
                            let displaySnippets = snippets.map(s => '…' + s + '…');
                            if (totalMatches > snippets.length) {
                                displaySnippets.push(`…… 共 ${totalMatches} 匹配`);
                            }
                            snippetDiv.innerHTML = displaySnippets.join('<br>');
                            item.appendChild(snippetDiv);
                        }
                    }

                    // 添加聊天记录项的点击事件（加载对话）
                    item.addEventListener('click', () => {
                        loadConversationIntoChat(conv);
                        // 保持聊天记录面板打开
                    });
                    // 新增：添加右键事件，显示删除菜单
                    item.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        showChatHistoryItemContextMenu(e, conv.id);
                    });

                    listContainer.appendChild(item);
                });
            });
        }).catch(err => {
            console.error("加载聊天记录失败", err);
        });
    }

    /**
     * 加载选中的对话记录到当前聊天窗口
     * @param {Object} conversation - 对话记录对象
     */
    function loadConversationIntoChat(conversation) {
        // 清空当前聊天容器
        chatContainer.innerHTML = '';
        // 遍历对话中的每条消息并显示
        conversation.messages.forEach(msg => {
            const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
            let messageElem = null;

            if (Array.isArray(msg.content)) {
                const imagesHTML = document.createElement('div');
                let textContent = '';

                msg.content.forEach(part => {
                    if (part.type === 'text') {
                        textContent = part.text;
                    } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                        const imageTag = createImageTag(part.image_url.url, null);
                        imagesHTML.appendChild(imageTag);
                    }
                });

                messageElem = appendMessage(textContent, role, true, null, imagesHTML.innerHTML);
            } else {
                messageElem = appendMessage(msg.content, role, true);
            }
            
            messageElem.setAttribute('data-message-id', msg.id);
        });
        // 恢复加载的对话历史到聊天管理器
        chatHistory.messages = conversation.messages.slice();
        // 若存在消息，则设置第一条消息的 id 为根节点
        chatHistory.root = conversation.messages.length > 0 ? conversation.messages[0].id : null;
        // 将 currentNode 更新为最后一条消息的 id
        chatHistory.currentNode = conversation.messages.length > 0 ? conversation.messages[conversation.messages.length - 1].id : null;
        // 保存加载的对话记录ID，用于后续更新操作
        currentConversationId = conversation.id;
    }

    // 添加聊天记录菜单项监听
    const chatHistoryMenuItem = document.getElementById('chat-history-menu');
    if (chatHistoryMenuItem) {
        chatHistoryMenuItem.addEventListener('click', () => {
            closeExclusivePanels();
            showChatHistoryPanel();
        });
    }

    // 在 DOMContentLoaded 内部，新增如下两个辅助函数

    /**
     * 显示聊天记录项的右键菜单
     * @param {MouseEvent} e - 右键事件
     * @param {string} conversationId - 对话记录ID
     */
    function showChatHistoryItemContextMenu(e, conversationId) {
        e.preventDefault();
        // 如果已存在菜单，则删除
        const existingMenu = document.getElementById('chat-history-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }
        // 创建菜单容器
        const menu = document.createElement('div');
        menu.id = 'chat-history-context-menu';
        // 动态设置菜单位置
        menu.style.top = e.clientY + 'px';
        menu.style.left = e.clientX + 'px';
        // 添加 CSS 类，设置其他样式
        menu.classList.add('chat-history-context-menu');

        const deleteOption = document.createElement('div');
        deleteOption.textContent = '删除聊天记录';
        deleteOption.classList.add('chat-history-context-menu-option');

        deleteOption.addEventListener('click', async () => {
            await deleteConversation(conversationId);
            menu.remove();

            // 刷新聊天记录面板
            const panel = document.getElementById('chat-history-panel');
            if (panel) {
                const filterInput = panel.querySelector('input[type="text"]');
                loadConversationHistories(panel, filterInput ? filterInput.value : '');
            }
        });

        menu.appendChild(deleteOption);
        document.body.appendChild(menu);

        // 点击其他地方时移除菜单
        document.addEventListener('click', function onDocClick() {
            if (menu.parentElement) {
                menu.remove();
            }
            document.removeEventListener('click', onDocClick);
        });
    }

    copyCodeButton.addEventListener('click', copyCodeContent);
    const deleteMessageButton = document.getElementById('delete-message');
    if (deleteMessageButton) {
        deleteMessageButton.addEventListener('click', deleteMessageContent);
    }

    /**
     * 删除指定消息的函数，更新 UI 和聊天历史树（维护继承关系）
     */
    function deleteMessageContent() {
        if (!currentMessageElement) return;
        const messageId = currentMessageElement.getAttribute('data-message-id');
        if (!messageId) {
            console.error("未找到消息ID, 无法删除消息");
            hideContextMenu();
            return;
        }

        // 从 DOM 中删除该消息元素
        currentMessageElement.remove();

        // 删除聊天历史中的消息，并更新继承关系
        const success = deleteMessage(messageId);
        if (!success) {
            console.error("删除消息失败: 未找到对应的消息节点");
        } else {
            // 更新并持久化聊天记录
            saveCurrentConversation(true);
        }
        hideContextMenu();
    }

    // 调试聊天记录树按钮绑定（该按钮在 sidebar.html 中设置了 id="debug-chat-tree-btn"）
    const debugTreeButton = document.getElementById('debug-chat-tree-btn');
    if (debugTreeButton) {
        debugTreeButton.addEventListener('click', () => {
            // 使用当前聊天记录树 chatHistory（由 createChatHistoryManager() 提供）初始化调试窗口
            initTreeDebugger(chatHistory);
        });
    }

    // 在DOM加载后（例如在 document.addEventListener('DOMContentLoaded', async () => { 内部合适位置新增如下代码）

    /**
     * 备份当前 IndexedDB 中的所有对话记录为 JSON 文件
     * @returns {Promise<void>}
     */
    async function backupConversations() {
        try {
            const allConversations = await getAllConversations();
            const jsonStr = JSON.stringify(allConversations, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            // 创建临时下载链接
            const a = document.createElement('a');
            a.href = url;
            a.download = 'chat_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            // alert('备份成功！');
        } catch (error) {
            console.error('备份失败:', error);
            alert('备份失败，请检查浏览器控制台。');
        }
    }

    /** 
     * 刷新聊天记录
     */
    function refreshChatHistory() {
        const panel = document.getElementById('chat-history-panel');
        if (panel) {
            const filterInput = panel.querySelector('input[type="text"]');
            loadConversationHistories(panel, filterInput ? filterInput.value : '');
        }
    }

    /**
     * 从备份文件中还原对话记录，仅增量还原（根据 id 检查，不覆盖已有记录）
     */
    function restoreConversations() {
        // 创建一个 file input 元素用于选择文件
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const backupData = JSON.parse(text);
                if (!Array.isArray(backupData)) {
                    alert('备份文件格式不正确！');
                    return;
                }
                let countAdded = 0;
                for (const conv of backupData) {
                    try {
                        const existing = await getConversationById(conv.id);
                        if (!existing) {
                            await putConversation(conv);
                            countAdded++;
                        }
                    } catch (error) {
                        console.error(`还原对话 ${conv.id} 时出错:`, error);
                    }
                }
                alert(`还原完成，新增 ${countAdded} 条记录。`);
            } catch (error) {
                console.error('读取备份文件失败:', error);
                alert('读取备份文件失败，请检查文件格式。');
            }
        });
        input.click();
    }

    // 新增：辅助函数 将图片数据生成图片标签后，统一添加到图片容器
    function addImageToContainer(imageData, fileName) {
        const imageTag = createImageTag(imageData, fileName);
        imageContainer.appendChild(imageTag);
        // 触发输入事件以保证界面刷新
        messageInput.dispatchEvent(new Event('input'));
        console.log("图片插入到图片容器");
    }

    // 新增：dummy 方法，用于显示已发送的图片消息（先删除旧的显示方式，后续再改）
    function dummyDisplayImageMessage() {
        return "[图片消息已删除]";
    }

    // 新增：统一关闭聊天记录面板的函数
    function closeChatHistoryPanel() {
        const panel = document.getElementById('chat-history-panel');
        if (panel && panel.classList.contains('visible')) {
            panel.classList.remove('visible');
            panel.addEventListener('transitionend', function handler(e) {
                if (e.propertyName === 'opacity' && !panel.classList.contains('visible')) {
                    panel.style.display = 'none';
                    panel.removeEventListener('transitionend', handler);
                }
            });
        }
    }

    // ----- 修改 5：新增切换函数 -----
    function toggleChatHistoryPanel() {
        const panel = document.getElementById('chat-history-panel');
        if (panel && panel.classList.contains('visible')) {
            closeChatHistoryPanel();
        } else {
            showChatHistoryPanel();
        }
    }

    // ----- 修改 2：增加全局 ESC 键监听，实现面板切换 -----
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape'){
            toggleChatHistoryPanel();
            e.preventDefault();
        }
    });

    // 新增互斥面板切换函数
    function closeExclusivePanels() {
        // 定义需要互斥的面板ID列表
        const panels = ['chat-history-panel', 'api-settings', 'prompt-settings'];
        closeChatHistoryPanel();
        panels.forEach(pid => {
            const panel = document.getElementById(pid);
            if (panel && panel.classList.contains('visible')) {
                panel.classList.remove('visible');
            }
        });
    }

    // 显示/隐藏提示词设置面板
    promptSettingsToggle.addEventListener('click', () => {
        const wasVisible = promptSettings.classList.contains('visible');
        closeExclusivePanels();

        if (!wasVisible) {
            promptSettings.classList.toggle('visible');
        }
    });
});