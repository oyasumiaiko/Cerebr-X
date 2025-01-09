document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const toggleTheme = document.getElementById('toggle-theme');
    const sidebarWidth = document.getElementById('sidebar-width');
    const fontSize = document.getElementById('font-size');
    const widthValue = document.getElementById('width-value');
    const fontSizeValue = document.getElementById('font-size-value');
    const collapseButton = document.getElementById('collapse-button');
    let currentMessageElement = null;
    let isTemporaryMode = false; // 添加临时模式状态变量
    let isProcessingMessage = false; // 添加消息处理状态标志
    let shouldAutoScroll = true; // 添加自动滚动状态
    let lastUserScrollTime = 0; // 添加最后用户滚动时间
    let lastProgrammaticScroll = 0; // 添加最后程序滚动时间

    // 聊天历史记录变量
    let chatHistory = [];
    let responseContexts = new Map();  // 存储每个请求的上下文
    let pageContent = null;  // 保留pageContent变量，但移除webpageSwitch相关代码

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

    // 提取公共配置
    const MATH_DELIMITERS = {
        regex: /(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g,
        // regex: /(\$\$[\s\S]+?\$\$)|(\$[^\s$][^$]*?\$)|(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g,
        renderConfig: {
            delimiters: [
                { left: '\\(', right: '\\)', display: false },  // 行内公式
                { left: '\\\\(', right: '\\\\)', display: false },  // 行内公式
                { left: '\\[', right: '\\]', display: true },   // 行间公式
                // {left: '$$', right: '$$', display: true},     // 行间公式（备用）
                // {left: '$', right: '$', display: false}       // 行内公式（备用）
            ],
            throwOnError: false
        }
    };

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

    async function sendMessage() {
        // 如果正在处理消息，直接返回
        if (isProcessingMessage) {
            return;
        }

        const message = messageInput.textContent.trim();
        const imageTags = messageInput.querySelectorAll('.image-tag');

        if (!message && imageTags.length === 0) return;

        const config = apiConfigs[selectedConfigIndex];
        if (!config?.baseUrl || !config?.apiKey) {
            appendMessage('请在设置中完善 API 配置', 'ai', true);
            return;
        }

        try {
            // 设置处理状态为true
            isProcessingMessage = true;

            // 生成新的请求ID
            const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            // 创建该请求的上下文
            responseContexts.set(requestId, {
                aiResponse: '',
                isValid: true
            });

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

            // 构建消息内容
            let messageContent;

            // 如果有图片，构建包含文本和图片的数组格式
            if (imageTags.length > 0) {
                messageContent = [];
                // 添加文本内容（如果有）
                if (message) {
                    messageContent.push({
                        type: "text",
                        text: message
                    });
                }
                // 添加图片
                imageTags.forEach(tag => {
                    const base64Data = tag.getAttribute('data-image');
                    if (base64Data) {
                        messageContent.push({
                            type: "image_url",
                            image_url: {
                                url: base64Data
                            }
                        });
                    }
                });
            } else {
                // 如果没有图片，直接使用文本内容
                messageContent = message;
            }

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: messageContent
            };

            // 构建消息数组（不包括当前用户消息）
            const messages = [...chatHistory.slice(0, -1)];  // 排除刚刚添加的用户消息

            // 添加系统消息
            const systemMessage = {
                role: "system",
                content: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$美元符号包裹数学公式。用户语言是 ${navigator.language}。请优先使用 ${navigator.language} 语言回答用户问题。${pageContent ?
                    `\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}` :
                    ''
                    }`
            };

            // 如果是第一条消息或第一条不是系统消息，添加系统消息
            if (messages.length === 0 || messages[0].role !== "system") {
                messages.unshift(systemMessage);
            }

            // 更新加载状态消息
            loadingMessage.textContent = '正在等待 AI 回复...';

            // 发送API请求
            const response = await fetch(config.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                    'X-Request-Id': requestId  // 添加请求ID到header
                },
                body: JSON.stringify({
                    model: config.modelName || "gpt-4o",
                    messages: [...messages, userMessage],
                    stream: true,
                    temperature: config.temperature || 1,
                    top_p: 0.95,
                    max_tokens: 4096,
                })
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

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    responseContexts.delete(requestId);
                    break;
                }

                const chunk = new TextDecoder().decode(value);
                const lines = chunk.split('\n');

                const context = responseContexts.get(requestId);
                if (context?.isValid) {
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const content = line.slice(6);
                            if (content.trim() === '[DONE]') continue;

                            try {
                                const data = JSON.parse(content);
                                if (data.choices?.[0]?.delta?.content) {
                                    if (!hasStartedResponse) {
                                        // 移除加载状态消息
                                        loadingMessage.remove();
                                        hasStartedResponse = true;
                                    }
                                    context.aiResponse += data.choices[0].delta.content;
                                    updateAIMessage(context.aiResponse, requestId);
                                }
                            } catch (e) {
                                console.error('解析响应出错:', e);
                            }
                        }
                    }
                } else {
                    console.log('请求已过期，忽略响应内容');
                }
            }
        } catch (error) {
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
        }
    }

    function updateAIMessage(text, requestId) {
        const context = responseContexts.get(requestId);
        if (!context?.isValid) {
            console.log('忽略过期响应:', requestId);
            return;
        }

        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        let rawText = text;

        if (lastMessage) {
            // 获取当前显示的文本
            const currentText = lastMessage.getAttribute('data-original-text') || '';
            // 如果新文本比当前文本长，说明有新内容需要更新
            if (text.length > currentText.length) {
                // 更新原始文本属性
                lastMessage.setAttribute('data-original-text', text);

                // 处理数学公式和Markdown
                lastMessage.innerHTML = processMathAndMarkdown(text);

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

                // 更新历史记录
                if (chatHistory.length > 0) {
                    chatHistory[chatHistory.length - 1].content = rawText;
                }

                // 根据shouldAutoScroll决定是否滚动
                scrollToBottom();
            }
        } else {
            appendMessage(rawText, 'ai');
        }
    }

    // 提取公共的数学公式处理函数
    function processMathAndMarkdown(text) {
        const mathExpressions = [];
        let mathIndex = 0;
        text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

        // 临时替换数学公式
        text = text.replace(MATH_DELIMITERS.regex, (match) => {
            // 只替换不在 \n 后面的 abla_
            match = match.replace(/(?<!\\n)abla_/g, '\\nabla_');

            // 如果是普通括号形式公式，转换为 \(...\) 形式
            if (match.startsWith('(') && match.endsWith(')') && !match.startsWith('\\(')) {
                console.log('警告：请使用 \\(...\\) 来表示行内公式');
            }
            const placeholder = `%%MATH_EXPRESSION_${mathIndex}%%`;
            mathExpressions.push(match);
            mathIndex++;
            return placeholder;
        });

        // 配 marked
        marked.setOptions({
            breaks: true,
            gfm: true,
            sanitize: false,
            highlight: function (code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(code, { language: lang }).value;
                    } catch (err) { }
                }
                return hljs.highlightAuto(code).value;
            }
        });

        text = text.replace(/:\s\*\*/g, ':**');

        // 渲染 Markdown
        let html = marked.parse(text);

        // 恢复数学公式
        html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => mathExpressions[index]);

        return html;
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
            console.log('[收到URL变化]', event.data.url);
            // 加载新URL的聊天记录
            loadChatHistory(event.data.url);
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
        messageDiv.innerHTML = processMathAndMarkdown(text);

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
        renderMathInElement(messageDiv, MATH_DELIMITERS.renderConfig);

        // 如果提供了文档片段，添加到片段中；否则直接添加到聊天容器
        if (fragment) {
            fragment.appendChild(messageDiv);
        } else {
            chatContainer.appendChild(messageDiv);
            // 只在发送新消息时强制滚动，其他情况根据shouldAutoScroll决定
            if (sender === 'user' && !skipHistory) {
                scrollToBottom(true); // 用户新消息强制滚动
            } else {
                scrollToBottom(); // AI回复根据shouldAutoScroll决定
            }
        }

        // 更新聊天历史
        if (!skipHistory) {
            chatHistory.push({
                role: sender === 'user' ? 'user' : 'assistant',
                content: processImageTags(text)
            });
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
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isComposing || isProcessingMessage) {
                // 如果正在使用输入法或正在处理消息，不发送消息
                return;
            }
            e.preventDefault();
            const text = this.textContent.trim();
            if (text || this.querySelector('.image-tag')) {  // 检查是否有文本或图片
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
    let favoriteApis = [];  // 存储收藏的API配置

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            const result = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex', 'favoriteApis']);
            if (result.apiConfigs && result.apiConfigs.length > 0) {
                apiConfigs = result.apiConfigs;
                selectedConfigIndex = result.selectedConfigIndex || 0;
                favoriteApis = result.favoriteApis || [];
            } else {
                // 创建默认配置
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-4o',
                    temperature: 1
                }];
                selectedConfigIndex = 0;
                favoriteApis = [];
                await saveAPIConfigs();
            }
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 如果加载失败，也创建默认配置
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o',
                temperature: 1
            }];
            selectedConfigIndex = 0;
            favoriteApis = [];
        }

        // 确保一定会渲染卡片和收藏列表
        renderAPICards();
        renderFavoriteApis();
    }

    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            await chrome.storage.sync.set({
                apiConfigs,
                selectedConfigIndex,
                favoriteApis
            });
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

    // 创建 API 卡片
    function createAPICard(config, index, templateCard) {
        // 克隆模板
        const template = templateCard.cloneNode(true);
        template.classList.remove('template');
        template.style.display = '';

        if (index === selectedConfigIndex) {
            template.classList.add('selected');
        }

        const apiKeyInput = template.querySelector('.api-key');
        const baseUrlInput = template.querySelector('.base-url');
        const modelNameInput = template.querySelector('.model-name');
        const temperatureInput = template.querySelector('.temperature');
        const temperatureValue = template.querySelector('.temperature-value');
        const apiForm = template.querySelector('.api-form');
        const favoriteBtn = template.querySelector('.favorite-btn');

        apiKeyInput.value = config.apiKey || '';
        baseUrlInput.value = config.baseUrl || 'https://api.openai.com/v1/chat/completions';
        modelNameInput.value = config.modelName || 'gpt-4o';
        temperatureInput.value = config.temperature || 1;
        temperatureValue.textContent = (config.temperature || 1).toFixed(1);

        // 监听温度变化
        temperatureInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            temperatureValue.textContent = value.toFixed(1);
        });

        // 检查是否已收藏
        const isFavorite = favoriteApis.some(favConfig =>
            favConfig.apiKey === config.apiKey &&
            favConfig.baseUrl === config.baseUrl &&
            favConfig.modelName === config.modelName
        );
        if (isFavorite) {
            favoriteBtn.classList.add('active');
        }

        // 收藏按钮点击事件
        favoriteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentConfig = {
                apiKey: apiKeyInput.value,
                baseUrl: baseUrlInput.value,
                modelName: modelNameInput.value,
                temperature: temperatureInput.value
            };

            const existingIndex = favoriteApis.findIndex(favConfig =>
                favConfig.apiKey === currentConfig.apiKey &&
                favConfig.baseUrl === currentConfig.baseUrl &&
                favConfig.modelName === currentConfig.modelName
            );

            if (existingIndex === -1) {
                // 添加到收藏
                favoriteApis.push(currentConfig);
                favoriteBtn.classList.add('active');
            } else {
                // 取消收藏
                favoriteApis.splice(existingIndex, 1);
                favoriteBtn.classList.remove('active');
            }

            saveAPIConfigs();
            renderFavoriteApis();
        });

        // 阻止输入框和按钮点击事件冒泡
        const stopPropagation = (e) => e.stopPropagation();
        apiForm.addEventListener('click', stopPropagation);
        template.querySelector('.card-actions').addEventListener('click', stopPropagation);

        // 输入变化时保存
        [apiKeyInput, baseUrlInput, modelNameInput, temperatureInput].forEach(input => {
            input.addEventListener('change', () => {
                apiConfigs[index] = {
                    apiKey: apiKeyInput.value,
                    baseUrl: baseUrlInput.value,
                    modelName: modelNameInput.value,
                    temperature: parseFloat(temperatureInput.value)
                };
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

        // 选择配置
        template.addEventListener('click', () => {
            selectedConfigIndex = index;
            saveAPIConfigs();
            document.querySelectorAll('.api-card').forEach(card => {
                card.classList.remove('selected');
            });
            template.classList.add('selected');
            // 关闭设置页面
            apiSettings.classList.remove('visible');
        });

        return template;
    }

    // 渲染收藏的API列表
    function renderFavoriteApis() {
        const favoriteApisList = document.querySelector('.favorite-apis-list');
        favoriteApisList.innerHTML = '';

        if (favoriteApis.length === 0) {
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

        favoriteApis.forEach((config) => {
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

    // 清空聊天记录功能
    const clearChat = document.getElementById('clear-chat');
    clearChat.addEventListener('click', () => {
        // 清空聊天容器
        chatContainer.innerHTML = '';
        // 清空当前页面的聊天历史记录
        chatHistory = [];
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

    // 修改快速总结功能
    async function performQuickSummary(selectedContent = null) {
        const wasTemporaryMode = isTemporaryMode;
        try {
            // 检查焦点是否在侧栏内
            const isSidebarFocused = document.hasFocus();
            const sidebarSelection = window.getSelection().toString().trim();

            console.log('isSidebarFocused:', isSidebarFocused);
            console.log('sidebarSelection:', sidebarSelection);

            // 只有当焦点在侧栏内且有选中文本时，才使用侧栏的选中文本
            if (isSidebarFocused && sidebarSelection) {
                messageInput.textContent = sidebarSelection;
                await sendMessage();
                return;
            }

            // 获取页面上选中的文本
            // 清空聊天记录
            chatContainer.innerHTML = '';
            chatHistory = [];

            // 关闭设置菜单
            toggleSettingsMenu(false);

            // 构建总结请求
            const trimmedText = selectedContent?.trim() || '';
            const isQuestion = trimmedText.endsWith('?') ||
                trimmedText.endsWith('？') ||
                trimmedText.endsWith('吗');
            const currentModel = apiConfigs[selectedConfigIndex]?.modelName || '';
            const isSearchModel = currentModel.endsWith('-search');

            if (trimmedText) {
                if(isSearchModel) messageInput.textContent += `搜索，`;
                messageInput.textContent += isQuestion ? `"${trimmedText}"` : `"${trimmedText}"是什么？`;
            } else {
                if (wasTemporaryMode) {
                    exitTemporaryMode();
                }
                messageInput.textContent = `请总结这个页面的主要内容。`;
            }
            // 发送消息
            await sendMessage();
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
            const result = await chrome.storage.sync.get(['sidebarWidth', 'fontSize', 'scaleFactor']);
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
                const scaleFactor = document.getElementById('scale-factor');
                const scaleValue = document.getElementById('scale-value');
                scaleFactor.value = result.scaleFactor;
                scaleValue.textContent = `${result.scaleFactor}x`;
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

    // 初始化设置
    await initSettings();

    // 添加检查是否在底部的函数
    function isNearBottom() {
        const threshold = 100; // 距离底部的阈值，单位像素
        const scrollBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
        return scrollBottom <= threshold;
    }

    // 添加滚动事件监听
    chatContainer.addEventListener('scroll', (e) => {
        // 如果这次滚动是由程序触发的（在500ms内有程序滚动），忽略它
        if (Date.now() - lastProgrammaticScroll < 100) {
            return;
        }
        shouldAutoScroll = isNearBottom();
    });

    // 添加滚轮事件监听
    chatContainer.addEventListener('wheel', (e) => {
        // 如果用户向上滚动
        if (e.deltaY < 0) {
            lastUserScrollTime = Date.now();
            shouldAutoScroll = false;
        }
    });

    // 修改滚动到底部的函数
    function scrollToBottom(force = false) {
        // 如果在用户最后向上滚动后的500ms内，且不是强制滚动，则不执行
        if (!force && Date.now() - lastUserScrollTime < 500) {
            return;
        }

        if (force || shouldAutoScroll) {
            lastProgrammaticScroll = Date.now();
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
});