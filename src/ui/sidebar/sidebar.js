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

document.addEventListener('DOMContentLoaded', async () => {
    const appContext = {
        dom: {
            chatContainer: document.getElementById('chat-container'),
            messageInput: document.getElementById('message-input'),
            contextMenu: document.getElementById('context-menu'),
            copyMessageButton: document.getElementById('copy-message'),
            stopUpdateButton: document.getElementById('stop-update'),
            clearChatContextButton: document.getElementById('clear-chat-context'),
            settingsButton: document.getElementById('settings-button'),
            settingsMenu: document.getElementById('settings-menu'),
            themeSwitch: document.getElementById('theme-switch'),
            themeSelect: document.getElementById('theme-select'),
            sidebarWidth: document.getElementById('sidebar-width'),
            fontSize: document.getElementById('font-size'),
            widthValue: document.getElementById('width-value'),
            fontSizeValue: document.getElementById('font-size-value'),
            collapseButton: document.getElementById('collapse-button'),
            fullscreenToggle: document.getElementById('fullscreen-toggle'),
            sendButton: document.getElementById('send-button'),
            sendChatHistorySwitch: document.getElementById('send-chat-history-switch'),
            showReferenceSwitch: document.getElementById('show-reference-switch'),
            copyCodeButton: document.getElementById('copy-code'),
            imageContainer: document.getElementById('image-container'),
            promptSettingsToggle: document.getElementById('prompt-settings-toggle'),
            promptSettingsPanel: document.getElementById('prompt-settings'),
            inputContainer: document.getElementById('input-container'),
            regenerateButton: document.getElementById('regenerate-message'),
            autoScrollSwitch: document.getElementById('auto-scroll-switch'),
            clearOnSearchSwitch: document.getElementById('clear-on-search-switch'),
            scaleFactor: document.getElementById('scale-factor'),
            scaleValue: document.getElementById('scale-value'),
            chatHistoryMenuItem: document.getElementById('chat-history-menu'),
            deleteMessageButton: document.getElementById('delete-message'),
            quickSummary: document.getElementById('quick-summary'),
            clearChat: document.getElementById('clear-chat'),
            debugTreeButton: document.getElementById('debug-chat-tree-btn'),
            screenshotButton: document.getElementById('screenshot-button'),
            sidebarPositionSwitch: document.getElementById('sidebar-position-switch'),
            forkConversationButton: document.getElementById('fork-conversation'),
            copyAsImageButton: document.getElementById('copy-as-image'),
            emptyStateHistory: document.getElementById('empty-state-history'),
            emptyStateSummary: document.getElementById('empty-state-summary'),
            emptyStateTempMode: document.getElementById('empty-state-temp-mode'),
            emptyStateLoadUrl: document.getElementById('empty-state-load-url'),
            emptyStateScreenshot: document.getElementById('empty-state-screenshot'),
            emptyStateExtract: document.getElementById('empty-state-extract'),
            statusDot: document.getElementById('status-dot'),
            stopAtTopSwitch: document.getElementById('stop-at-top-switch'),
            repomixButton: document.getElementById('empty-state-repomix'),
            apiSettingsPanel: document.getElementById('api-settings'),
            apiSettingsToggle: document.getElementById('api-settings-toggle'),
            apiSettingsText: document.getElementById('api-settings-toggle').querySelector('span'),
            apiSettingsBackButton: document.querySelector('#api-settings .back-button'),
            apiCardsContainer: document.querySelector('#api-settings .api-cards'),
            previewModal: document.querySelector('.image-preview-modal'),
            previewImage: document.querySelector('.image-preview-modal img'),
            previewCloseButton: document.querySelector('.image-preview-modal .image-preview-close'),
            promptSettingsBackButton: document.querySelector('#prompt-settings .back-button'),
            resetPromptsButton: document.getElementById('reset-prompts'),
            savePromptsButton: document.getElementById('save-prompts'),
            selectionPrompt: document.getElementById('selection-prompt'),
            systemPrompt: document.getElementById('system-prompt'),
            pdfPrompt: document.getElementById('pdf-prompt'),
            summaryPrompt: document.getElementById('summary-prompt'),
            queryPrompt: document.getElementById('query-prompt'),
            imagePrompt: document.getElementById('image-prompt'),
            screenshotPrompt: document.getElementById('screenshot-prompt'),
            extractPrompt: document.getElementById('extract-prompt'),
            urlRulesPrompt: document.getElementById('url-rules-prompt'),
            urlRulesList: document.getElementById('url-rules-list'),
            showThoughtProcessSwitch: document.getElementById('show-thought-process-switch'),
            resetSettingsButton: document.getElementById('reset-settings-button'),
            settingsBackButton: document.querySelector('#settings-menu .back-button')
        },
        services: {},
        state: {
            isFullscreen: false,
            isComposing: false,
            pageInfo: null,
            memoryManagement: {
                IDLE_CLEANUP_INTERVAL: 5 * 60 * 1000,
                FORCED_CLEANUP_INTERVAL: 30 * 60 * 1000,
                USER_IDLE_THRESHOLD: 3 * 60 * 1000,
                lastUserActivity: Date.now(),
                isEnabled: true
            }
        },
        utils: {}
    };

    function initializeAppContextUtils() {
        appContext.utils.scrollToBottom = () => {
            const settingsManager = appContext.services.settingsManager;
            const messageSender = appContext.services.messageSender;
            const chatContainer = appContext.dom.chatContainer;

            if (settingsManager?.getSetting('autoScroll') === false) return;
            if (!messageSender?.getShouldAutoScroll()) return;

        requestAnimationFrame(() => {
            const stopAtTop = settingsManager?.getSetting('stopAtTop') === true;
            let top = chatContainer.scrollHeight;
            const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
            if (aiMessages.length > 0) {
                const latestAiMessage = aiMessages[aiMessages.length - 1];
                const rect = latestAiMessage.getBoundingClientRect();
                if (stopAtTop) {
                    top = latestAiMessage.offsetTop - 8;
                    messageSender.setShouldAutoScroll(false);
                    } else {
                    const computedStyle = window.getComputedStyle(latestAiMessage);
                    const marginBottom = parseInt(computedStyle.marginBottom, 10);
                    top = latestAiMessage.offsetTop + rect.height - marginBottom;
                }
            }
                chatContainer.scrollTo({ top, behavior: 'smooth' });
            });
        };

        appContext.utils.closeExclusivePanels = () => {
            return appContext.services.uiManager?.closeExclusivePanels();
        };

        appContext.utils.deleteMessageContent = async (messageElement) => {
        if (!messageElement) return;
        const messageId = messageElement.getAttribute('data-message-id');
        messageElement.remove();

            const chatHistoryManager = appContext.services.chatHistoryManager;
            const contextMenuManager = appContext.services.contextMenuManager;
            const chatHistoryUI = appContext.services.chatHistoryUI;

        if (!messageId) {
            console.error("未找到消息ID");
                contextMenuManager?.hideContextMenu();
            return;
        }

            const success = chatHistoryManager.deleteMessage(messageId);
        if (!success) {
            console.error("删除消息失败: 未找到对应的消息节点");
        } else {
            await chatHistoryUI.saveCurrentConversation(true);
        }
            contextMenuManager?.hideContextMenu();
        };
        
        appContext.utils.showNotification = (message, duration = 2000) => {
            const notification = document.createElement('div');
            notification.className = 'notification';
            notification.textContent = message;
            document.body.appendChild(notification);
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, duration);
        };

        appContext.utils.requestScreenshot = () => {
            window.parent.postMessage({ type: 'CAPTURE_SCREENSHOT' }, '*');
        };

        appContext.utils.waitForScreenshot = () => {
            return new Promise((resolve) => {
                const startTime = Date.now();
                const interval = setInterval(() => {
                    const screenshotImg = appContext.dom.imageContainer.querySelector('img[alt="page-screenshot.png"]');
                    if (screenshotImg) {
                        clearInterval(interval);
                        resolve();
                    } else if (Date.now() - startTime > 5000) {
                        clearInterval(interval);
                        console.warn('等待截屏图片超时');
                        resolve();
                    }
                }, 100);
            });
        };
        
        appContext.utils.addImageToContainer = (imageData, fileName) => {
            const imageTag = appContext.services.imageHandler.createImageTag(imageData, fileName);
            appContext.dom.imageContainer.appendChild(imageTag);
            appContext.dom.messageInput.dispatchEvent(new Event('input'));
            // console.log("图片插入到图片容器");
        };
    }
    initializeAppContextUtils();

    window.cerebr = window.cerebr || {};
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

    appContext.services.messageSender = createMessageSender(appContext);
    appContext.services.messageSender.setCurrentConversationId(appContext.services.chatHistoryUI.getCurrentConversationId());
    window.cerebr.messageSender = appContext.services.messageSender;
    appContext.services.uiManager = createUIManager(appContext);

    appContext.services.contextMenuManager = createContextMenuManager(appContext);

    appContext.services.contextMenuManager.init();
    appContext.services.uiManager.init();
    await appContext.services.settingsManager.init();
    appContext.services.apiManager.setupUIEventHandlers(appContext);
    await appContext.services.apiManager.init();

    // 初始化左上状态同心点：亮起=获取网页内容；熄灭=未获取网页内容（纯对话）
    (function initStatusDot() {
        const dot = appContext.dom.statusDot;
        if (!dot) return;
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
        if (appContext.dom.emptyStateTempMode) {
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

    if (appContext.dom.emptyStateSummary) {
        appContext.dom.emptyStateSummary.addEventListener('click', () => {
            appContext.services.messageSender.performQuickSummary();
        });
    }

    if (appContext.dom.emptyStateTempMode) {
        appContext.dom.emptyStateTempMode.addEventListener('click', () => {
            appContext.services.messageSender.toggleTemporaryMode();
            appContext.dom.messageInput.focus();
            const range = document.createRange();
            range.selectNodeContents(appContext.dom.messageInput);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
    }

    if (appContext.dom.emptyStateLoadUrl) {
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
    

    if (appContext.dom.emptyStateScreenshot) {
        appContext.dom.emptyStateScreenshot.addEventListener('click', () => {
            const prompts = appContext.services.promptSettingsManager.getPrompts();
            appContext.utils.requestScreenshot();
            appContext.utils.waitForScreenshot().then(() => {
                appContext.dom.messageInput.textContent = prompts.screenshot.prompt;
                appContext.services.messageSender.sendMessage();
            });
        });
    }

    if (appContext.dom.emptyStateExtract) {
        appContext.dom.emptyStateExtract.addEventListener('click', async () => {
            const prompts = appContext.services.promptSettingsManager.getPrompts();
            appContext.dom.messageInput.textContent = prompts.extract.prompt;
            appContext.services.messageSender.sendMessage();
        });
    }

    if (appContext.dom.repomixButton) {
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
                                appContext.dom.messageInput.textContent = '全面分析介绍总结当前仓库的结构、内容、原理、核心逻辑的实现';
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
            const isOpen = appContext.services.chatHistoryUI.isChatHistoryPanelOpen();
            appContext.services.uiManager.closeExclusivePanels();
            if (!isOpen) {
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
            // { panel: appContext.dom.settingsMenu, toggle: appContext.dom.settingsButton, openers: [] },
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
        appContext.state.isFullscreen = !appContext.state.isFullscreen;
        window.parent.postMessage({ type: 'TOGGLE_FULLSCREEN_FROM_IFRAME' }, '*');
    });
    
    if(appContext.dom.screenshotButton) {
        appContext.dom.screenshotButton.addEventListener('click', () => {
            appContext.utils.requestScreenshot();
        });
    }

    window.addEventListener('message', (event) => {
        const { data } = event;
        switch (data.type) {
            case 'DROP_IMAGE':
                if (data.imageData?.data) {
                    appContext.utils.addImageToContainer(data.imageData.data, data.imageData.name);
                }
                if (data.explain) {
                    appContext.services.messageSender.sendMessage();
                }
                break;
            case 'FOCUS_INPUT':
                appContext.dom.messageInput.focus();
                setTimeout(() => {
            const range = document.createRange();
                    range.selectNodeContents(appContext.dom.messageInput);
            range.collapse(false);
            const selection = window.getSelection();
                    if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
                    }
                }, 0);
                break;
            case 'URL_CHANGED':
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
                appContext.services.messageSender.performQuickSummary(data.selectedContent);
                break;
            case 'QUICK_SUMMARY_COMMAND_QUERY':
                appContext.services.messageSender.performQuickSummary(data.selectedContent, true);
                break;
            case 'TOGGLE_TEMP_MODE_FROM_EXTENSION':
                appContext.services.messageSender.toggleTemporaryMode();
                // 同步徽标
                if (appContext.dom.modeIndicator) {
                    setTimeout(() => {
                        const isOn = appContext.services.messageSender.getTemporaryModeState?.();
                        appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
                    }, 0);
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

    appContext.dom.messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            if (e.shiftKey) return;
            if (appContext.state.isComposing) return;
            e.preventDefault();
            
            if (e.altKey) {
                if (appContext.state.isComposing) return;
                appContext.utils.requestScreenshot();
                appContext.utils.waitForScreenshot().then(() => {
                    appContext.services.messageSender.sendMessage();
                });
                return;
            }

            const text = this.textContent.trim();
            if (e.ctrlKey) {
                const prompts = appContext.services.promptSettingsManager.getPrompts();
                const selectionPromptText = prompts.selection.prompt;
                if (selectionPromptText) {
                    const userMessageText = selectionPromptText.replace('<SELECTION>', text);
                    appContext.services.messageSender.sendMessage({ originalMessageText: userMessageText, specificPromptType: 'selection' });
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
        window.parent.postMessage({ type: 'REQUEST_PAGE_INFO' }, '*');
    }, 500);
});