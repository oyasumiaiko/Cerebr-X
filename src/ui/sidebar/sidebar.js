import { PromptSettings } from '../../core/prompt_settings.js';
import { createChatHistoryManager } from '../../core/chat_history_manager.js';
import { initTreeDebugger } from '../../debug/tree_debugger.js';
import { createMessageProcessor } from '../../core/message_processor.js'; // 导入消息处理模块
import { createImageHandler } from '../../utils/image_handler.js'; // 导入图片处理模块
import { createChatHistoryUI } from '../chat_history_ui.js'; // 导入聊天历史UI模块
import { createApiManager } from '../../api/api_settings.js'; // 导入 API 设置模块
import { createMessageSender } from '../../core/message_sender.js'; // 导入消息发送模块
import { createSettingsManager } from '../settings_manager.js'; // 导入设置管理模块
import { createContextMenuManager } from '../context_menu_manager.js'; // 导入上下文菜单管理模块
import { createUIManager } from '../ui_manager.js'; // 导入UI管理模块
import { getAllConversationMetadata } from '../../storage/indexeddb_helper.js';

// 内存管理相关配置
const MEMORY_MANAGEMENT = {
    IDLE_CLEANUP_INTERVAL: 5 * 60 * 1000, // 5分钟检查一次空闲清理
    FORCED_CLEANUP_INTERVAL: 30 * 60 * 1000, // 30分钟强制清理一次
    USER_IDLE_THRESHOLD: 3 * 60 * 1000, // 3分钟无操作视为空闲
    lastUserActivity: Date.now(),
    // 调试开关 - 仅供开发使用，生产环境始终为true
    isEnabled: true
};

document.addEventListener('DOMContentLoaded', async () => {
    // DOM 元素获取
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const stopUpdateButton = document.getElementById('stop-update');
    const clearChatContextButton = document.getElementById('clear-chat-context');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const toggleTheme = document.getElementById('toggle-theme');
    const themeSwitch = document.getElementById('theme-switch');
    const themeSelect = document.getElementById('theme-select'); // 添加主题选择下拉框
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
    const inputContainer = document.getElementById('input-container');
    const regenerateButton = document.getElementById('regenerate-message');
    const autoScrollSwitch = document.getElementById('auto-scroll-switch');
    const clearOnSearchSwitch = document.getElementById('clear-on-search-switch');
    const scaleFactor = document.getElementById('scale-factor');
    const scaleValue = document.getElementById('scale-value');
    const chatHistoryMenuItem = document.getElementById('chat-history-menu');
    const deleteMessageButton = document.getElementById('delete-message');
    const quickSummary = document.getElementById('quick-summary');
    const clearChat = document.getElementById('clear-chat');
    const debugTreeButton = document.getElementById('debug-chat-tree-btn');
    const screenshotButton = document.getElementById('screenshot-button');
    const sidebarPositionSwitch = document.getElementById('sidebar-position-switch');
    const forkConversationButton = document.getElementById('fork-conversation');
    const emptyStateHistory = document.getElementById('empty-state-history');
    const emptyStateSummary = document.getElementById('empty-state-summary');
    const emptyStateTempMode = document.getElementById('empty-state-temp-mode');
    const emptyStateLoadUrl = document.getElementById('empty-state-load-url');
    const emptyStateScreenshot = document.getElementById('empty-state-screenshot');
    const emptyStateExtract = document.getElementById('empty-state-extract');
    const stopAtTopSwitch = document.getElementById('stop-at-top-switch');

    // 应用程序状态
    let isFullscreen = false; // 全屏模式
    let isComposing = false; // 跟踪输入法状态

    // 截屏按钮事件
    if(screenshotButton) {
        screenshotButton.addEventListener('click', () => {
            requestScreenshot();
        });
    }

    // 创建聊天历史管理器实例
    const {
        chatHistory,
        addMessageToTree,
        getCurrentConversationChain,
        clearHistory,
        deleteMessage
    } = createChatHistoryManager();

    // 初始化图片预览元素
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const closeButton = previewModal.querySelector('.image-preview-close');

    // 导入并初始化提示词设置
    const promptSettingsManager = new PromptSettings();

    // ====================== 第一阶段：创建基础模块 ======================
    
    /**
     * 滚动到底部函数
     * 在设置管理器初始化后使用，因此会先定义
     */
    function scrollToBottom() {
        // 使用可选链确保即使settingsManager尚未初始化也不会报错
        if (settingsManager?.getSetting('autoScroll') === false) {
            return;
        }
        
        if (!messageSender.getShouldAutoScroll()) {
            return;
        }

        requestAnimationFrame(() => {
            const stopAtTop = settingsManager?.getSetting('stopAtTop') === true;

            let top = chatContainer.scrollHeight;
            const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
            if (aiMessages.length > 0) {
                const latestAiMessage = aiMessages[aiMessages.length - 1];
                const rect = latestAiMessage.getBoundingClientRect();
                const containerRect = chatContainer.getBoundingClientRect();
                if (stopAtTop) {
                    top = latestAiMessage.offsetTop - 8;
                    messageSender.setShouldAutoScroll(false);
                }
                else {
                    // 获取计算后的样式，忽略元素的margin-bottom
                    const computedStyle = window.getComputedStyle(latestAiMessage);
                    const marginBottom = parseInt(computedStyle.marginBottom, 10);
                    top = latestAiMessage.offsetTop + rect.height - marginBottom;
                }
            }

            chatContainer.scrollTo({
                top: top,
                behavior: 'smooth'
            });

        });
    }
    
    /**
    /**
     * 关闭互斥面板函数
     * 由于存在循环依赖，我们先定义函数，后续再绑定实现
     */
    function closeExclusivePanels() {
        // 实现会在uiManager创建后绑定
        console.log("closeExclusivePanels被调用，但尚未绑定实现");
        return null;
    }
    
    /**
     * 删除消息内容函数
     * 由于依赖contextMenuManager，先定义后绑定实现
     */
    async function deleteMessageContent(messageElement) {
        if (!messageElement) return;
        
        const messageId = messageElement.getAttribute('data-message-id');
        // 从 DOM 中删除该消息元素
        messageElement.remove();

        if (!messageId) {
            console.error("未找到消息ID");
            if (contextMenuManager) contextMenuManager.hideContextMenu();
            return;
        }

        // 删除聊天历史中的消息，并更新继承关系
        const success = deleteMessage(messageId);
        if (!success) {
            console.error("删除消息失败: 未找到对应的消息节点");
        } else {
            // 更新并持久化聊天记录
            await chatHistoryUI.saveCurrentConversation(true);
        }
        
        if (contextMenuManager) contextMenuManager.hideContextMenu();
    }

    // ====================== 第一阶段：创建基础模块 ======================
    
    // 创建全局 cerebr 对象，用于在不同模块间共享数据
    window.cerebr = window.cerebr || {};
    // 将提示词设置暴露给全局对象，以便在其他模块中访问
    window.cerebr.settings = {
        prompts: () => promptSettingsManager.getPrompts()
    };
    // 初始化 pageInfo
    window.cerebr.pageInfo = null;
    
    // 监听提示词设置变化，更新全局对象
    document.addEventListener('promptSettingsUpdated', () => {
        window.cerebr.settings.prompts = promptSettingsManager.getPrompts();
    });

    // 创建图片处理器实例
    const imageHandler = createImageHandler({
        previewModal,
        previewImage,
        closeButton,
        imageContainer,
        messageInput
    });

    // 创建消息处理器实例
    const messageProcessor = createMessageProcessor({
        chatContainer: chatContainer,
        chatHistory: chatHistory,
        addMessageToTree: addMessageToTree,
        scrollToBottom: scrollToBottom,
        showImagePreview: imageHandler.showImagePreview,
        processImageTags: imageHandler.processImageTags,
        showReference: showReferenceSwitch.checked
    });

    // 创建聊天历史UI实例
    const chatHistoryUI = createChatHistoryUI({
        chatContainer: chatContainer,
        appendMessage: messageProcessor.appendMessage,
        chatHistory: chatHistory,
        clearHistory: clearHistory,
        getPrompts: () => promptSettingsManager.getPrompts(),
        createImageTag: imageHandler.createImageTag,
        getCurrentConversationChain: getCurrentConversationChain
    });

    // ====================== 第二阶段：创建有依赖关系的模块 ======================
    
    // 获取API设置相关DOM元素
    const apiSettings = document.getElementById('api-settings');
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const apiSettingsText = apiSettingsToggle.querySelector('span');
    const backButton = document.querySelector('.back-button');
    const apiCards = document.querySelector('.api-cards');

    // 创建UI管理器实例
    const uiManager = createUIManager({
        messageInput,
        settingsButton,
        settingsMenu,
        chatContainer,
        sendButton,
        inputContainer,
        promptSettings,
        promptSettingsToggle,
        collapseButton,
        chatHistoryUI,
        imageHandler,
        setShouldAutoScroll: (value) => messageSender.setShouldAutoScroll(value),
        renderFavoriteApis: null
    });
    
    // 重要：首先绑定closeExclusivePanels的实现
    closeExclusivePanels = function() {
        return uiManager.closeExclusivePanels();
    };
    
    // 创建API管理器实例（注意循环依赖已经解决）
    const apiManager = createApiManager({
        apiSettings,
        apiCards,
        closeExclusivePanels: closeExclusivePanels // 使用已绑定的函数
    });
    
    // 创建消息发送器实例
    const messageSender = createMessageSender({
        apiManager,
        messageProcessor,
        imageHandler,
        chatHistoryUI,
        getCurrentConversationChain,
        chatContainer,
        messageInput,
        imageContainer,
        scrollToBottom,
        getPrompts: () => promptSettingsManager.getPrompts(),
        uiManager // 添加 uiManager 实例
    });
    
    // 同步当前会话ID
    messageSender.setCurrentConversationId(chatHistoryUI.getCurrentConversationId());
    
    // 将消息发送器添加到全局对象，便于其他模块访问
    window.cerebr.messageSender = messageSender;

    // 创建上下文菜单管理器实例
    const contextMenuManager = createContextMenuManager({
        contextMenu,
        copyMessageButton,
        copyCodeButton,
        stopUpdateButton,
        regenerateButton,
        deleteMessageButton,
        clearChatContextButton,
        chatContainer,
        abortCurrentRequest: messageSender.abortCurrentRequest,
        deleteMessageContent,
        clearChatHistory: chatHistoryUI.clearChatHistory,
        sendMessage: messageSender.sendMessage,
        chatHistory,  // 添加聊天历史数据对象
        forkConversationButton,
        createForkConversation: chatHistoryUI.createForkConversation
    });
    
    // 创建设置管理器实例
    const settingsManager = createSettingsManager({
        themeSwitch,
        themeSelect, // 添加主题选择下拉框
        sidebarWidth,
        widthValue,
        fontSize,
        fontSizeValue,
        scaleFactor,
        scaleValue,
        autoScrollSwitch,
        clearOnSearchSwitch,
        sendChatHistorySwitch,
        showReferenceSwitch,
        sidebarPositionSwitch,
        stopAtTopSwitch,
        setMessageSenderChatHistory: messageSender.setSendChatHistory
    });
    
    // ====================== 第三阶段：解决循环依赖问题 ======================
    
    // 更新uiManager的依赖
    uiManager.renderFavoriteApis = () => apiManager.renderFavoriteApis();
    
    // ====================== 第四阶段：初始化模块 ======================
    
    // 初始化各模块
    contextMenuManager.init();
    uiManager.init();
    await settingsManager.init();
    
    // 设置 API 设置 UI 事件处理
    apiManager.setupUIEventHandlers(apiSettingsToggle, backButton);
    
    // 初始化 API 配置（确保这步不会漏掉）
    await apiManager.init();
    
    // 更新API设置菜单项文本显示当前API名称
    function updateApiMenuText() {
        const currentConfig = apiManager.getSelectedConfig();
        if (currentConfig) {
            apiSettingsText.textContent = currentConfig.displayName || currentConfig.modelName || 'API 设置';
        }
    }
    
    // 初始化时更新一次
    updateApiMenuText();
    
    // 监听API配置更新事件
    window.addEventListener('apiConfigsUpdated', updateApiMenuText);

    // ====================== 第五阶段：设置事件监听器 ======================

    // 监听引用标记开关变化
    showReferenceSwitch.addEventListener('change', (e) => {
        settingsManager.setShowReference(e.target.checked);
    });

    // 监听聊天历史开关变化
    sendChatHistorySwitch.addEventListener('change', (e) => {
        settingsManager.setSendChatHistory(e.target.checked);
    });

    // 添加空状态按钮事件监听器
    if (emptyStateHistory) {
        emptyStateHistory.addEventListener('click', () => {
            // 打开聊天历史面板
            closeExclusivePanels();
            chatHistoryUI.showChatHistoryPanel();
        });
    }

    if (emptyStateSummary) {
        emptyStateSummary.addEventListener('click', () => {
            // 执行快速总结功能
            messageSender.performQuickSummary();
        });
    }

    if (emptyStateTempMode) {
        emptyStateTempMode.addEventListener('click', () => {
            messageSender.toggleTemporaryMode();

            // 聚焦到输入框
            messageInput.focus();
            // 将光标定位到文本末尾
            const range = document.createRange();
            range.selectNodeContents(messageInput);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
    }

    if (emptyStateLoadUrl) {
        emptyStateLoadUrl.addEventListener('click', async () => {
            // 从 pageInfo 获取当前页面 URL
            const currentUrl = window.cerebr.pageInfo?.url;
            
            if (!currentUrl) {
                showNotification('未能获取当前页面URL');
                return;
            }
            
            // 获取所有对话元数据
            const histories = await getAllConversationMetadata();
            // 按时间倒序排序
            const sortedHistories = histories.sort((a, b) => b.endTime - a.endTime);
            
            /**
             * 根据当前 URL 生成候选的匹配 URL 列表：
             * 1. 原始 URL（包含查询参数）
             * 2. 去除查询参数后的 URL
             * 3. 依次去除路径中的最后一个 segment
             * 4. 当无更多有效路径时，加入仅使用域名的候选
             *
             * @param {string} urlString - 当前页面 URL 字符串
             * @returns {string[]} 候选 URL 数组，顺序按匹配优先级排列
             */
            function generateCandidateUrls(urlString) {
                const candidates = [];
                try {
                    const urlObj = new URL(urlString);
                    // 候选1：原始 URL
                    candidates.push(urlString);
                    // 候选2：去除查询参数后的 URL
                    const baseUrl = urlObj.origin + urlObj.pathname;
                    if (baseUrl !== urlString) {
                        candidates.push(baseUrl);
                    }
                    // 候选3：依次去除路径中的最后一个 segment
                    const segments = urlObj.pathname.split('/').filter(Boolean);
                    for (let i = segments.length - 1; i > 0; i--) {
                        const candidate = urlObj.origin + "/" + segments.slice(0, i).join('/');
                        if (!candidates.includes(candidate)) {
                            candidates.push(candidate);
                        }
                    }
                    // 最后加入仅使用域名的候选
                    if (!candidates.includes(urlObj.origin)) {
                        candidates.push(urlObj.origin);
                    }
                } catch (error) {
                    console.error("generateCandidateUrls error: ", error);
                }
                return candidates;
            }
            
            const currentHasParams = currentUrl.includes('?');
            let matchingConversation = null;
            if (currentHasParams) {
                // 当前 URL 含参数，先严格查找完全一致的带参数对话
                matchingConversation = sortedHistories.find(conv => conv.url === currentUrl);
                if (!matchingConversation) {
                    // 未找到完全一致的对话，再归一化比较（忽略参数）
                    const normalizedCurrent = new URL(currentUrl).origin + new URL(currentUrl).pathname;
                    matchingConversation = sortedHistories.find(conv => {
                        try {
                            const convUrlObj = new URL(conv.url);
                            return (convUrlObj.origin + convUrlObj.pathname) === normalizedCurrent;
                        } catch (error) {
                            return false;
                        }
                    });
                }
            } else {
                // 当前 URL 不含参数，使用候选 URL 逐步匹配
                const candidateUrls = generateCandidateUrls(currentUrl);
                console.log("候选 URL：", candidateUrls);
                for (const candidate of candidateUrls) {
                    matchingConversation = sortedHistories.find(conv => {
                        try {
                            const convUrlObj = new URL(conv.url);
                            const normalizedConv = convUrlObj.origin + convUrlObj.pathname;
                            return conv.url === candidate || normalizedConv === candidate;
                        } catch (error) {
                            return false;
                        }
                    });
                    if (matchingConversation) break;
                }
            }
            
            console.log('找到的匹配对话:', matchingConversation);
            
            if (matchingConversation) {
                // 加载找到的对话
                chatHistoryUI.loadConversationIntoChat(matchingConversation);
            } else {
                showNotification('未找到本页面的历史对话');
            }
        });
    }

    // 添加截图解释按钮事件监听器
    if (emptyStateScreenshot) {
        emptyStateScreenshot.addEventListener('click', () => {
            // 获取提示词设置
            const prompts = promptSettingsManager.getPrompts();
            
            // 发送截图请求
            requestScreenshot();
            
            // 等待截图出现后再发送消息
            waitForScreenshot().then(() => {
                // 设置输入框内容为截图解释的提示词
                messageInput.textContent = prompts.screenshot.prompt;
                messageSender.sendMessage();
            });
        });
    }

    // 添加提取关键信息按钮事件监听器
    if (emptyStateExtract) {
        emptyStateExtract.addEventListener('click', async () => {
            // 获取提示词设置
            const prompts = promptSettingsManager.getPrompts();

            // 设置输入框内容为提取关键信息的提示词
            messageInput.textContent = prompts.extract.prompt;
            // 聚焦到输入框
            //messageInput.focus();
            // 发送消息
            messageSender.sendMessage();
        });
    }

    // 添加全局键盘事件监听器，处理ESC键打开/关闭聊天记录窗口
    document.addEventListener('keydown', (e) => {
        // 检测ESC键
        if (e.key === 'Escape') {
            // 如果有输入法正在输入，不处理ESC
            if (isComposing) return;
            
            // 切换聊天记录窗口状态
            const isOpen = chatHistoryUI.isChatHistoryPanelOpen();
            if (isOpen) {
                closeExclusivePanels();
            } else {
                closeExclusivePanels();
                chatHistoryUI.showChatHistoryPanel();
            }
            
            // 阻止默认行为
            e.preventDefault();
        }
    });

    // 添加点击事件监听器，用于点击聊天记录窗口外区域关闭窗口
    document.addEventListener('click', (e) => {
        // 如果聊天记录窗口打开
        if (chatHistoryUI.isChatHistoryPanelOpen()) {
            if (chatContainer.contains(e.target)) {
                // 使用延时确保其他事件处理程序已执行完毕
                setTimeout(() => {
                    closeExclusivePanels();
                }, 0);
            }
        }
    });

    // 添加全屏切换功能
    fullscreenToggle.addEventListener('click', async () => {
        isFullscreen = !isFullscreen;
        // 直接向父窗口发送消息
        window.parent.postMessage({
            type: 'TOGGLE_FULLSCREEN_FROM_IFRAME',
            // isFullscreen: isFullscreen
        }, '*');
    });

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'DROP_IMAGE') {
            console.log('收到拖放图片数据');
            const imageData = event.data.imageData;
            if (imageData && imageData.data) {
                addImageToContainer(imageData.data, imageData.name);
            }
            if (event.data.explain) {
                messageSender.sendMessage();
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
            // 更新 window.cerebr.pageInfo
            window.cerebr.pageInfo = event.data;
            // 更新ChatHistoryUI中的页面信息
            chatHistoryUI.updatePageInfo(event.data);
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
            messageSender.performQuickSummary(event.data.selectedContent);
        } else if (event.data.type === 'QUICK_SUMMARY_COMMAND_QUERY') {
            messageSender.performQuickSummary(event.data.selectedContent, true);
        } else if (event.data.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
            messageSender.toggleTemporaryMode();
        }
    });

    // 处理换行和输入
    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

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
            
            if (e.altKey) {
                e.preventDefault();
                if (isComposing) return; // 如果正在输入法中则不处理
                requestScreenshot(); // 发起截屏请求
                waitForScreenshot().then(() => {
                    messageSender.sendMessage();
                });
                return;
            }

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
            messageSender.sendMessage();
        }
    });

    // 清空聊天记录功能
    clearChat.addEventListener('click', async () => {
        await chatHistoryUI.clearChatHistory();
        uiManager.toggleSettingsMenu(false);
        messageInput.focus();
    });

    // 快速总结功能
    quickSummary.addEventListener('click', () => messageSender.performQuickSummary());

    // 添加发送按钮点击事件
    sendButton.addEventListener('click', () => {
        messageSender.sendMessage();
    });

    // 点击聊天记录菜单项
    if (chatHistoryMenuItem) {
        chatHistoryMenuItem.addEventListener('click', () => {
            const isOpen = chatHistoryUI.isChatHistoryPanelOpen();
            closeExclusivePanels();
            if (!isOpen) {
                chatHistoryUI.showChatHistoryPanel();
            }
        });
    }

    // 调试聊天记录树按钮绑定
    if (debugTreeButton) {
        debugTreeButton.addEventListener('click', () => {
            // 使用当前聊天记录树 chatHistory（由 createChatHistoryManager() 提供）初始化调试窗口
            initTreeDebugger(chatHistory);
        });
    }

    // ====================== 内存管理设置 ======================
    
    // 初始化内存管理
    initMemoryManagement();
    
    /**
     * 初始化内存管理机制
     */
    function initMemoryManagement() {
        // 设置用户活动跟踪 - 使用事件委托减少事件监听器数量
        document.addEventListener('click', updateUserActivity);
        document.addEventListener('keypress', updateUserActivity);
        document.addEventListener('mousemove', throttle(updateUserActivity, 5000));
        
        // 设置定期清理定时器
        setInterval(checkAndCleanupMemory, MEMORY_MANAGEMENT.IDLE_CLEANUP_INTERVAL);
        setInterval(forcedMemoryCleanup, MEMORY_MANAGEMENT.FORCED_CLEANUP_INTERVAL);
        
        // 初始化时记录日志
        console.log(`内存管理系统已初始化: 空闲清理间隔=${MEMORY_MANAGEMENT.IDLE_CLEANUP_INTERVAL/1000}秒, 强制清理间隔=${MEMORY_MANAGEMENT.FORCED_CLEANUP_INTERVAL/60000}分钟`);
    }
    
    /**
     * 更新用户最后活动时间
     */
    function updateUserActivity() {
        MEMORY_MANAGEMENT.lastUserActivity = Date.now();
    }
    
    /**
     * 检查并清理内存（仅在用户空闲时）
     */
    function checkAndCleanupMemory() {
        if (!MEMORY_MANAGEMENT.isEnabled) return;
        
        const idleTime = Date.now() - MEMORY_MANAGEMENT.lastUserActivity;
        if (idleTime > MEMORY_MANAGEMENT.USER_IDLE_THRESHOLD) {
            console.log(`用户已空闲${(idleTime/1000).toFixed(0)}秒，执行内存清理`);
            chatHistoryUI.clearMemoryCache();
        }
    }
    
    /**
     * 强制执行内存清理，无论用户是否活跃
     */
    function forcedMemoryCleanup() {
        if (!MEMORY_MANAGEMENT.isEnabled) return;
        
        console.log('执行定期强制内存清理');
        chatHistoryUI.clearMemoryCache();
    }
    
    /**
     * 函数节流工具，限制函数调用频率
     * @param {Function} func - 要节流的函数
     * @param {number} limit - 最小调用间隔（毫秒）
     * @returns {Function} 节流后的函数
     */
    function throttle(func, limit) {
        let lastFunc;
        let lastRan;
        return function() {
            const context = this;
            const args = arguments;
            if (!lastRan) {
                func.apply(context, args);
                lastRan = Date.now();
            } else {
                clearTimeout(lastFunc);
                lastFunc = setTimeout(function() {
                    if ((Date.now() - lastRan) >= limit) {
                        func.apply(context, args);
                        lastRan = Date.now();
                    }
                }, limit - (Date.now() - lastRan));
            }
        };
    }

    // ====================== 辅助函数 ======================

    /**
     * 将图片数据生成图片标签后，统一添加到图片容器
     * @param {string} imageData - 图片数据（Base64编码）
     * @param {string} fileName - 图片文件名
     */
    function addImageToContainer(imageData, fileName) {
        const imageTag = imageHandler.createImageTag(imageData, fileName);
        imageContainer.appendChild(imageTag);
        // 触发输入事件以保证界面刷新
        messageInput.dispatchEvent(new Event('input'));
        console.log("图片插入到图片容器");
    }

    /**
     * 轮询等待 image-container 中出现截屏图片
     * 每 0.1 秒检查一次，最多等待 5 秒
     * @returns {Promise<void>}
     */
    function waitForScreenshot() {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const interval = setInterval(() => {
                const screenshotImg = imageContainer.querySelector('img[alt="page-screenshot.png"]');
                if (screenshotImg) {
                    clearInterval(interval);
                    resolve();
                } else if (Date.now() - startTime > 5000) { // 5秒超时
                    clearInterval(interval);
                    console.warn('等待截屏图片超时');
                    resolve();
                }
            }, 100);
        });
    }

    /**
     * 请求截屏
     */
    function requestScreenshot() {
        window.parent.postMessage({
            type: 'CAPTURE_SCREENSHOT'
        }, '*');
    }

    /**
     * 显示一个临时提示消息
     * @param {string} message - 要显示的消息内容
     * @param {number} [duration=2000] - 消息显示时长(ms)
     */
    function showNotification(message, duration = 2000) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 500);
        }, duration);
    }

    // ====================== 初始化时请求页面信息 ======================
    
    // 在初始化完成后，主动请求当前页面信息，确保在首次保存聊天记录时有正确的页面信息
    setTimeout(() => {
        console.log('初始化完成，主动请求当前页面信息');
        window.parent.postMessage({
            type: 'REQUEST_PAGE_INFO'
        }, '*');
    }, 500);
});