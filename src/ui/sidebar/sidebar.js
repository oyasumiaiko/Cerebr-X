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
import { packRemoteRepoViaApiExtension } from '../../utils/repomix.js';
import { createInputController } from '../input_controller.js';
import { createSidebarAppContext, registerSidebarUtilities, applyStandaloneAdjustments } from './sidebar_app_context.js';

document.addEventListener('DOMContentLoaded', async () => {
    const currentUrl = new URL(window.location.href);
    const hashQuery = currentUrl.hash.startsWith('#') ? currentUrl.hash.substring(1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const standaloneParam = (
        currentUrl.searchParams.get('mode') === 'standalone' ||
        currentUrl.searchParams.get('standalone') === '1' ||
        hashParams.get('mode') === 'standalone' ||
        hashParams.get('standalone') === '1' ||
        currentUrl.hash.includes('standalone')
    );
    let isStandalone = standaloneParam;
    try {
        if (!isStandalone) {
            isStandalone = window.parent === window;
        }
    } catch (_) {
        // 在跨域场景下访问 window.parent 可能抛异常，此处忽略并视为嵌入模式
    }
    if (document?.body) {
        document.body.classList.toggle('standalone-mode', isStandalone);
    }
    if (document?.documentElement) {
        document.documentElement.classList.toggle('standalone-mode', isStandalone);
    }

    const appContext = createSidebarAppContext(isStandalone);
    registerSidebarUtilities(appContext);
    // 初次与后续窗口/内容变化时更新高度变量
    appContext.utils.updateInputContainerHeightVar();
    window.addEventListener('resize', appContext.utils.updateInputContainerHeightVar);
    const resizeObserver = new ResizeObserver(() => appContext.utils.updateInputContainerHeightVar());
    const inputEl = document.getElementById('input-container');
    if (inputEl) resizeObserver.observe(inputEl);

    window.cerebr = window.cerebr || {};
    window.cerebr.environment = isStandalone ? 'standalone' : 'embedded';
    window.cerebr.settings = {
        prompts: () => appContext.services.promptSettingsManager?.getPrompts()
    };
    window.cerebr.pageInfo = appContext.state.pageInfo;
    document.addEventListener('promptSettingsUpdated', () => {
        if (appContext.services.promptSettingsManager) {
            window.cerebr.settings.prompts = appContext.services.promptSettingsManager.getPrompts();
        }
    });

    const { chatHistory, addMessageToTree, getCurrentConversationChain, clearHistory, deleteMessage } = createChatHistoryManager(appContext);
    appContext.services.chatHistoryManager = { chatHistory, addMessageToTree, getCurrentConversationChain, clearHistory, deleteMessage };
    
    appContext.services.promptSettingsManager = new PromptSettings(appContext);
    appContext.services.settingsManager = createSettingsManager(appContext);
    appContext.services.imageHandler = createImageHandler(appContext);
    appContext.services.apiManager = createApiManager(appContext);

    appContext.services.messageProcessor = createMessageProcessor(appContext);
    appContext.services.chatHistoryUI = createChatHistoryUI(appContext);

    // 新增：输入控制器，供消息发送等逻辑层统一读取/清理输入
    appContext.services.inputController = createInputController(appContext);

    appContext.services.messageSender = createMessageSender(appContext);
    appContext.services.messageSender.setCurrentConversationId(appContext.services.chatHistoryUI.getCurrentConversationId());
    if (appContext.state.isStandalone) {
        try {
            appContext.services.messageSender.enterTemporaryMode();
        } catch (error) {
            console.error('独立聊天页面初始化临时模式失败:', error);
        }
    }
    window.cerebr.messageSender = appContext.services.messageSender;
    appContext.services.uiManager = createUIManager(appContext);

    appContext.services.contextMenuManager = createContextMenuManager(appContext);

    appContext.services.contextMenuManager.init();
    appContext.services.uiManager.init();
    if (appContext.dom.openStandalonePage && !appContext.state.isStandalone) {
        appContext.dom.openStandalonePage.addEventListener('click', async () => {
            try {
                await new Promise((resolve, reject) => {
                    try {
                        chrome.runtime.sendMessage({ type: 'OPEN_STANDALONE_CHAT' }, (response) => {
                            const runtimeError = chrome.runtime.lastError;
                            if (runtimeError) {
                                reject(new Error(runtimeError.message));
                                return;
                            }
                            if (response?.status === 'error') {
                                reject(new Error(response.message || 'unknown error'));
                                return;
                            }
                            resolve(response);
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
                appContext.utils.showNotification('已在新标签页打开独立聊天');
            } catch (error) {
                console.error('打开独立聊天页面失败:', error);
                appContext.utils.showNotification('无法打开独立聊天页面');
            }
            appContext.services.uiManager.toggleSettingsMenu(false);
        });
    }
    await appContext.services.settingsManager.init();
    applyStandaloneAdjustments(appContext);
    appContext.services.apiManager.setupUIEventHandlers(appContext);
    await appContext.services.apiManager.init();

    // 初始化左上状态同心点：亮起=获取网页内容；熄灭=未获取网页内容（纯对话）
    (function initStatusDot() {
        const dot = appContext.dom.statusDot;
        if (!dot) return;
        if (appContext.state.isStandalone) {
            dot.style.display = 'none';
            return;
        }
        const sender = appContext.services.messageSender;
        function refresh() {
            const isTemp = sender.getTemporaryModeState?.() === true;
            // 非临时模式会获取网页内容 => 亮起；临时模式 => 熄灭
            if (isTemp) {
                dot.classList.remove('on');
                dot.title = '未获取网页内容（纯对话）';
            } else {
                dot.classList.add('on');
                dot.title = '获取网页内容';
            }
        }
        // 点击切换（可选，保留单点控制）
        dot.addEventListener('click', () => {
            sender.toggleTemporaryMode();
            refresh();
        });
        // 首次渲染
        refresh();
        // 外部消息切换
        window.addEventListener('message', (event) => {
            if (event?.data?.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
                setTimeout(refresh, 0);
            }
        });
        // 内部事件切换
        document.addEventListener('TEMP_MODE_CHANGED', () => setTimeout(refresh, 0));
        if (appContext.dom.emptyStateTempMode && !appContext.state.isStandalone) {
            appContext.dom.emptyStateTempMode.addEventListener('click', () => setTimeout(refresh, 0));
        }
    })();

    function updateApiMenuText() {
        const currentConfig = appContext.services.apiManager.getSelectedConfig();
        if (currentConfig) {
            appContext.dom.apiSettingsText.textContent = currentConfig.displayName || currentConfig.modelName || 'API 设置';
        }
    }
    updateApiMenuText();
    window.addEventListener('apiConfigsUpdated', updateApiMenuText);

    // 移除重复事件绑定：改为由 settings_manager.js 的通用 schema 统一绑定与持久化

    if (appContext.dom.emptyStateHistory) {
        appContext.dom.emptyStateHistory.addEventListener('click', () => {
            appContext.services.uiManager.closeExclusivePanels();
            appContext.services.chatHistoryUI.showChatHistoryPanel();
        });
    }

    if (appContext.dom.emptyStateSummary && !appContext.state.isStandalone) {
        appContext.dom.emptyStateSummary.addEventListener('click', () => {
            appContext.services.messageSender.performQuickSummary();
        });
    }

    if (appContext.dom.emptyStateTempMode && !appContext.state.isStandalone) {
        appContext.dom.emptyStateTempMode.addEventListener('click', () => {
            appContext.services.messageSender.toggleTemporaryMode();
            appContext.services.inputController.focusToEnd();
        });
    }

    if (appContext.dom.emptyStateLoadUrl && !appContext.state.isStandalone) {
        appContext.dom.emptyStateLoadUrl.addEventListener('click', async () => {
            const currentUrl = appContext.state.pageInfo?.url;
            if (!currentUrl) {
                appContext.utils.showNotification('未能获取当前页面URL');
                return;
            }
    
            // 1. 获取并排序历史记录（最新的在前）
            const histories = await getAllConversationMetadata();
            const sortedHistories = histories.sort((a, b) => b.endTime - a.endTime);
    
            /**
             * 生成候选 URL 列表 (更新版：使用 /, ?, &, # 作为分隔符)
             */
            function generateCandidateUrls(urlString) {
                const candidates = new Set();
                try {
                    const urlObj = new URL(urlString);
                    const origin = urlObj.origin;
    
                    let current = urlString;
    
                    while (current.length > origin.length) {
                        candidates.add(current);
    
                        const searchArea = current.substring(origin.length);
                        
                        // 使用结构性分隔符: /, ?, &, #
                        const lastDelimiterIndexInSearchArea = Math.max(
                            searchArea.lastIndexOf('/'),
                            searchArea.lastIndexOf('?'),
                            searchArea.lastIndexOf('&'),
                            searchArea.lastIndexOf('#') // <-- 添加了 Hash
                        );
    
                        if (lastDelimiterIndexInSearchArea === -1) {
                            break;
                        }
    
                        const delimiterIndex = origin.length + lastDelimiterIndexInSearchArea;
                        current = current.substring(0, delimiterIndex);
    
                        // 避免产生 "origin/" 这样的无效中间态
                        if (current === origin + '/') {
                            current = origin;
                        }
                    }
    
                    candidates.add(origin);
    
                } catch (error) {
                    console.error("generateCandidateUrls error: ", error);
                    if (urlString) candidates.add(urlString);
                }
                return Array.from(candidates);
            }
    
            // 2. 生成候选 URL 列表
            const candidateUrls = generateCandidateUrls(currentUrl);
            // console.log("Candidates:", candidateUrls); // 用于调试
    
            // 3. 匹配逻辑 (保持不变)
            let matchingConversation = null;
    
            for (const candidate of candidateUrls) {
                const match = sortedHistories.find(conv => {
                    try {
                        // 实现“前缀匹配”
                        return conv.url.startsWith(candidate);
                    } catch {
                        return false;
                    }
                });
    
                if (match) {
                    matchingConversation = match;
                    break;
                }
            }
    
            // 4. 加载对话或提示
            if (matchingConversation) {
                // console.log("Loading matched conversation:", matchingConversation.url);
                appContext.services.chatHistoryUI.loadConversationIntoChat(matchingConversation);
            } else {
                appContext.utils.showNotification('未找到本页面的相关历史对话');
            }
        });
    }
    

    if (appContext.dom.emptyStateScreenshot && !appContext.state.isStandalone) {
        appContext.dom.emptyStateScreenshot.addEventListener('click', () => {
            const prompts = appContext.services.promptSettingsManager.getPrompts();
            appContext.utils.requestScreenshot();
            appContext.utils.waitForScreenshot().then(() => {
                appContext.dom.messageInput.textContent = prompts.screenshot.prompt;
                appContext.services.messageSender.sendMessage({ api: prompts.screenshot?.model });
            });
        });
    }

    if (appContext.dom.emptyStateExtract && !appContext.state.isStandalone) {
        appContext.dom.emptyStateExtract.addEventListener('click', async () => {
            const prompts = appContext.services.promptSettingsManager.getPrompts();
            appContext.dom.messageInput.textContent = prompts.extract.prompt;
            appContext.services.messageSender.sendMessage({ api: prompts.extract?.model });
        });
    }

    if (appContext.dom.repomixButton && !appContext.state.isStandalone) {
        appContext.dom.repomixButton.addEventListener('click', async () => {
            const isGithubRepo = appContext.state.pageInfo?.url?.includes('github.com');
            if (isGithubRepo) {
                const repoUrl = appContext.state.pageInfo?.url;
                if (repoUrl) {
                    try {
                        appContext.utils.showNotification('正在打包仓库...', 3000);
                        const content = await packRemoteRepoViaApiExtension(repoUrl);
                        
                        if (content) {
                            const messageElement = appContext.services.messageProcessor.appendMessage(
                                content, 
                                'user', 
                                false, // skipHistory = false, so it's added to history
                                null,  // fragment = null, append to main chat container
                                null   // imagesHTML = null
                            );

                            if (messageElement) {
                                // 用户添加的DOM操作：先设置输入框内容并聚焦
                                appContext.services.inputController.setInputText('全面分析介绍总结当前仓库的结构、内容、原理、核心逻辑的实现');
                                appContext.dom.messageInput.focus();
                                
                                appContext.utils.showNotification('仓库内容已添加到当前对话。', 2000);
                                // 移除了 scrollToBottom，因为用户可能想查看输入框内容并立即发送
                            } else {
                                appContext.utils.showNotification('无法将仓库内容添加到对话中。', 3000);
                            }
                        } else {
                            appContext.utils.showNotification('未能打包仓库内容或内容为空。', 3000);
                        }
                    } catch (error) {
                        console.error("处理 repomixButton 点击事件失败:", error);
                        appContext.utils.showNotification('打包仓库时发生错误。', 3000);
                    }
                }
            }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (appContext.state.isComposing) return;
            const chatOpen = appContext.services.chatHistoryUI.isChatHistoryPanelOpen();
            const apiOpen = appContext.dom.apiSettingsPanel?.classList.contains('visible');
            const promptOpen = appContext.dom.promptSettingsPanel?.classList.contains('visible');
            const anyPanelOpen = chatOpen || apiOpen || promptOpen;

            if (anyPanelOpen) {
                appContext.services.uiManager.closeExclusivePanels();
            } else {
                appContext.services.chatHistoryUI.showChatHistoryPanel();
            }
            e.preventDefault();
        }
    });

    document.addEventListener('click', (e) => {
        const target = e.target;

        // List of panel elements, their toggles, and other known opener buttons
        const panelsAndToggles = [
            { 
                panel: document.getElementById('chat-history-panel'), 
                toggle: appContext.dom.chatHistoryMenuItem, 
                openers: [appContext.dom.emptyStateHistory] // Add emptyStateHistory as an opener
            },
            { panel: appContext.dom.apiSettingsPanel, toggle: appContext.dom.apiSettingsToggle, openers: [] },
            { panel: appContext.dom.promptSettingsPanel, toggle: appContext.dom.promptSettingsToggle, openers: [] },
            // 设置菜单不参与互斥，不纳入 auto-close 列表
            // { panel: appContext.dom.contextMenu, toggle: null, openers: [] } 
        ];

        let clickInsideManagedElement = false;
        for (const pt of panelsAndToggles) {
            if (pt.panel && (pt.panel.classList.contains('visible') || pt.panel.style.display !== 'none') && pt.panel.contains(target)) {
                clickInsideManagedElement = true;
                break;
            }
            if (pt.toggle && pt.toggle.contains(target)) {
                clickInsideManagedElement = true;
                break;
            }
            // Check additional opener buttons
            if (pt.openers && pt.openers.some(opener => opener && opener.contains(target))) {
                clickInsideManagedElement = true;
                break;
            }
        }

        if (!clickInsideManagedElement) {
            appContext.services.uiManager.closeExclusivePanels();
        }
    });

    appContext.dom.fullscreenToggle.addEventListener('click', async () => {
        if (appContext.state.isStandalone) {
            appContext.utils.showNotification('独立聊天页面始终为全屏布局');
            return;
        }
        appContext.state.isFullscreen = !appContext.state.isFullscreen;
        
        // 根据全屏状态添加或移除CSS类
        if (appContext.state.isFullscreen) {
            document.documentElement.classList.add('fullscreen-mode');
        } else {
            document.documentElement.classList.remove('fullscreen-mode');
        }
        
        window.parent.postMessage({ type: 'TOGGLE_FULLSCREEN_FROM_IFRAME' }, '*');
    });
    
    if(appContext.dom.screenshotButton) {
        appContext.dom.screenshotButton.addEventListener('click', () => {
            appContext.utils.requestScreenshot();
        });
    }

    window.addEventListener('message', (event) => {
        const { data } = event;
        if (!data?.type) {
            return;
        }

        switch (data.type) {
            case 'ADD_TEXT_TO_CONTEXT':
                if (appContext.state.isStandalone) {
                    break;
                }
                (async () => {
                    try {
                        const text = (data.text || '').trim();
                        if (!text) return;

                        // 添加为用户消息到历史，但不发送
                        appContext.services.messageProcessor.appendMessage(
                            text,
                            'user',
                            false,
                            null,
                            ''
                        );

                        // 立即保存当前会话并同步当前会话 ID
                        try {
                            await appContext.services.chatHistoryUI.saveCurrentConversation(true);
                            appContext.services.messageSender.setCurrentConversationId(
                                appContext.services.chatHistoryUI.getCurrentConversationId()
                            );
                        } catch (_) {}

                        appContext.utils.showNotification('已添加网页内容到历史（未发送）');
                    } catch (err) {
                        console.error('添加文本到上下文失败:', err);
                    }
                })();
                break;
            case 'DROP_IMAGE':
                if (data.imageData?.data) {
                    appContext.utils.addImageToContainer(data.imageData.data, data.imageData.name);
                }
                if (data.explain) {
                    appContext.services.messageSender.sendMessage();
                }
                break;
            case 'FOCUS_INPUT':
                appContext.services.inputController.focusToEnd();
                break;
            case 'URL_CHANGED':
                if (appContext.state.isStandalone) {
                    break;
                }
                appContext.state.pageInfo = data;
                window.cerebr.pageInfo = data;
                appContext.services.chatHistoryUI.updatePageInfo(data);
                const isGithubRepo = data.url?.includes('github.com');
                appContext.dom.repomixButton.style.display = isGithubRepo ? 'block' : 'none';
                break;
            case 'UPDATE_PLACEHOLDER':
                if (appContext.dom.messageInput) {
                    appContext.dom.messageInput.setAttribute('placeholder', data.placeholder);
                    if (data.timeout) {
                    setTimeout(() => {
                            appContext.dom.messageInput.setAttribute('placeholder', '输入消息...');
                        }, data.timeout);
                    }
                }
                break;
            case 'QUICK_SUMMARY_COMMAND':
                if (appContext.state.isStandalone) {
                    appContext.utils.showNotification('独立聊天页面不支持网页总结');
                    break;
                }
                appContext.services.messageSender.performQuickSummary(data.selectedContent);
                break;
            case 'QUICK_SUMMARY_COMMAND_QUERY':
                if (appContext.state.isStandalone) {
                    appContext.utils.showNotification('独立聊天页面不支持网页总结');
                    break;
                }
                appContext.services.messageSender.performQuickSummary(data.selectedContent, true);
                break;
            case 'TOGGLE_TEMP_MODE_FROM_EXTENSION':
                if (appContext.state.isStandalone) {
                    break;
                }
                appContext.services.messageSender.toggleTemporaryMode();
                // 同步徽标
                if (appContext.dom.modeIndicator) {
                    setTimeout(() => {
                        const isOn = appContext.services.messageSender.getTemporaryModeState?.();
                        appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
                    }, 0);
                }
                break;
            case 'FULLSCREEN_STATE_CHANGED':
                if (appContext.state.isStandalone) {
                    break;
                }
                // 同步全屏状态
                appContext.state.isFullscreen = data.isFullscreen;
                
                // 根据全屏状态添加或移除CSS类
                if (data.isFullscreen) {
                    document.documentElement.classList.add('fullscreen-mode');
                } else {
                    document.documentElement.classList.remove('fullscreen-mode');
                }
                break;
        }
    });

    // 监听内部事件同步徽标状态
    document.addEventListener('TEMP_MODE_CHANGED', (e) => {
        const isOn = !!e?.detail?.isOn;
        if (appContext?.dom?.modeIndicator) {
            appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
            appContext.dom.modeIndicator.title = isOn ? '仅对话模式中，点击退出' : '点击进入仅对话模式';
        }
    });

    appContext.dom.messageInput.addEventListener('compositionstart', () => { appContext.state.isComposing = true; });
    appContext.dom.messageInput.addEventListener('compositionend', () => { appContext.state.isComposing = false; });

    appContext.dom.messageInput.addEventListener('keydown', async function (e) {
        if (e.key === 'Enter') {
            if (e.shiftKey) return;
            if (appContext.state.isComposing) return;
            e.preventDefault();
            
            if (e.altKey) {
                if (appContext.state.isComposing) return;
                const text = (this.textContent || '').trim();
                const imagesHTML = appContext.dom.imageContainer?.innerHTML || '';
                const hasImages = !!appContext.dom.imageContainer?.querySelector('.image-tag');
                if (!text && !hasImages) return;

                // 加入到消息列表与历史，但不发送
                appContext.services.messageProcessor.appendMessage(
                    text,
                    'user',
                    false,
                    null,
                    imagesHTML
                );

                // 清空输入与图片，并重置高度
                try { appContext.dom.messageInput.innerHTML = ''; } catch (_) {}
                try { appContext.dom.imageContainer.innerHTML = ''; } catch (_) {}
                try { appContext.services.uiManager.resetInputHeight(); } catch (_) {}

                // 立即保存当前会话并同步当前会话 ID
                try {
                    await appContext.services.chatHistoryUI.saveCurrentConversation(true);
                    appContext.services.messageSender.setCurrentConversationId(
                        appContext.services.chatHistoryUI.getCurrentConversationId()
                    );
                } catch (_) {}

                // 反馈提示并滚动
                appContext.utils.showNotification('已添加到历史（未发送）');
                // appContext.utils.scrollToBottom();
                return;
            }

            const text = this.textContent.trim();
            const hasImagesInInput = !!appContext.dom.imageContainer?.querySelector('.image-tag');

            // 空输入：仅在最后一条为用户消息时，直接以当前完整历史触发生成（不新增用户消息）
            if (!text && !hasImagesInInput) {
                try {
                    const lastMessage = appContext.dom.chatContainer.querySelector('.message:last-child');
                    if (!lastMessage) {
                        appContext.utils.showNotification('没有可用的历史用户消息');
                        return;
                    }
                    if (!lastMessage.classList?.contains('user-message')) {
                        appContext.utils.showNotification('最后一条消息不是用户消息，未发送');
                        return;
                    }
                    appContext.services.messageSender.sendMessage({
                        originalMessageText: '',
                        forceSendFullHistory: true
                    });
                } catch (err) {
                    console.error('空输入触发生成失败:', err);
                }
                return;
            }
            if (e.ctrlKey) {
                const prompts = appContext.services.promptSettingsManager.getPrompts();
                const selectionPromptText = prompts.selection.prompt;
                if (selectionPromptText) {
                    const userMessageText = selectionPromptText.replace('<SELECTION>', text);
                    const apiPref = (prompts.selection?.model || '').trim();
                    const apiParam = apiPref || 'follow_current';
                    appContext.services.messageSender.sendMessage({ originalMessageText: userMessageText, specificPromptType: 'selection', api: apiParam });
                    return;
                }
            }
            appContext.services.messageSender.sendMessage();
        }
    });

    appContext.dom.clearChat.addEventListener('click', async () => {
        await appContext.services.chatHistoryUI.clearChatHistory();
        appContext.services.uiManager.toggleSettingsMenu(false);
        appContext.dom.messageInput.focus();
    });

    appContext.dom.quickSummary.addEventListener('click', () => appContext.services.messageSender.performQuickSummary());
    appContext.dom.sendButton.addEventListener('click', () => appContext.services.messageSender.sendMessage());

    if (appContext.dom.chatHistoryMenuItem) {
        appContext.dom.chatHistoryMenuItem.addEventListener('click', () => {
            const isOpen = appContext.services.chatHistoryUI.isChatHistoryPanelOpen();
            appContext.services.uiManager.closeExclusivePanels();
            if (!isOpen) {
                appContext.services.chatHistoryUI.showChatHistoryPanel();
            }
        });
    }

    if (appContext.dom.debugTreeButton) {
        appContext.dom.debugTreeButton.addEventListener('click', () => {
            initTreeDebugger(appContext.services.chatHistoryManager.chatHistory);
        });
    }

    function initMemoryManagement() {
        const mmConfig = appContext.state.memoryManagement;
        document.addEventListener('click', updateUserActivity);
        document.addEventListener('keypress', updateUserActivity);
        document.addEventListener('mousemove', throttle(updateUserActivity, 5000));
        setInterval(checkAndCleanupMemory, mmConfig.IDLE_CLEANUP_INTERVAL);
        setInterval(forcedMemoryCleanup, mmConfig.FORCED_CLEANUP_INTERVAL);
        //console.log(`内存管理系统已初始化: 空闲清理间隔=${mmConfig.IDLE_CLEANUP_INTERVAL/1000}秒, 强制清理间隔=${mmConfig.FORCED_CLEANUP_INTERVAL/60000}分钟`);
    }
    function updateUserActivity() {
        appContext.state.memoryManagement.lastUserActivity = Date.now();
    }
    function checkAndCleanupMemory() {
        const mmState = appContext.state.memoryManagement;
        if (!mmState.isEnabled) return;
        const idleTime = Date.now() - mmState.lastUserActivity;
        if (idleTime > mmState.USER_IDLE_THRESHOLD) {
            //console.log(`用户已空闲${(idleTime/1000).toFixed(0)}秒，执行内存清理`);
            appContext.services.chatHistoryUI.clearMemoryCache();
        }
    }
    function forcedMemoryCleanup() {
        if (!appContext.state.memoryManagement.isEnabled) return;
        //console.log('执行定期强制内存清理');
        appContext.services.chatHistoryUI.clearMemoryCache();
    }
    function throttle(func, limit) {
        let lastFunc;
        let lastRan;
        return function(...args) {
            const context = this;
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
    initMemoryManagement();

    setTimeout(() => {
        //console.log('初始化完成，主动请求当前页面信息');
        if (!appContext.state.isStandalone) {
            window.parent.postMessage({ type: 'REQUEST_PAGE_INFO' }, '*');
        }
        
        // 检查是否已经在全屏模式
        if (appContext.state.isFullscreen) {
            document.documentElement.classList.add('fullscreen-mode');
        }
    }, 500);
});
