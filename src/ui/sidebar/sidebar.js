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
            emptyStateHistory: document.getElementById('empty-state-history'),
            emptyStateSummary: document.getElementById('empty-state-summary'),
            emptyStateTempMode: document.getElementById('empty-state-temp-mode'),
            emptyStateLoadUrl: document.getElementById('empty-state-load-url'),
            emptyStateScreenshot: document.getElementById('empty-state-screenshot'),
            emptyStateExtract: document.getElementById('empty-state-extract'),
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
            console.log("图片插入到图片容器");
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

    appContext.services.imageHandler = createImageHandler(appContext);

    appContext.services.messageProcessor = createMessageProcessor(appContext);
    appContext.services.chatHistoryUI = createChatHistoryUI(appContext);

    appContext.services.uiManager = createUIManager(appContext);
    appContext.services.apiManager = createApiManager(appContext);
    
    appContext.services.messageSender = createMessageSender(appContext);
    appContext.services.messageSender.setCurrentConversationId(appContext.services.chatHistoryUI.getCurrentConversationId());
    window.cerebr.messageSender = appContext.services.messageSender;

    appContext.services.contextMenuManager = createContextMenuManager(appContext);
    appContext.services.settingsManager = createSettingsManager(appContext);

    appContext.services.contextMenuManager.init();
    appContext.services.uiManager.init();
    await appContext.services.settingsManager.init();
    appContext.services.apiManager.setupUIEventHandlers(appContext);
    await appContext.services.apiManager.init();

    function updateApiMenuText() {
        const currentConfig = appContext.services.apiManager.getSelectedConfig();
        if (currentConfig) {
            appContext.dom.apiSettingsText.textContent = currentConfig.displayName || currentConfig.modelName || 'API 设置';
        }
    }
    updateApiMenuText();
    window.addEventListener('apiConfigsUpdated', updateApiMenuText);

    appContext.dom.showReferenceSwitch.addEventListener('change', (e) => {
        appContext.services.settingsManager.setShowReference(e.target.checked);
    });

    appContext.dom.sendChatHistorySwitch.addEventListener('change', (e) => {
        appContext.services.settingsManager.setSendChatHistory(e.target.checked);
    });

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
            const histories = await getAllConversationMetadata();
            const sortedHistories = histories.sort((a, b) => b.endTime - a.endTime);
            
            function generateCandidateUrls(urlString) {
                const candidates = [];
                try {
                    const urlObj = new URL(urlString);
                    candidates.push(urlString);
                    const baseUrl = urlObj.origin + urlObj.pathname;
                    if (baseUrl !== urlString) candidates.push(baseUrl);
                    const segments = urlObj.pathname.split('/').filter(Boolean);
                    for (let i = segments.length - 1; i > 0; i--) {
                        const candidate = urlObj.origin + "/" + segments.slice(0, i).join('/');
                        if (!candidates.includes(candidate)) candidates.push(candidate);
                    }
                    if (!candidates.includes(urlObj.origin)) candidates.push(urlObj.origin);
                } catch (error) { console.error("generateCandidateUrls error: ", error); }
                return candidates;
            }

            let matchingConversation = null;
            if (currentUrl.includes('?')) {
                matchingConversation = sortedHistories.find(conv => conv.url === currentUrl);
                if (!matchingConversation) {
                    const normalizedCurrent = new URL(currentUrl).origin + new URL(currentUrl).pathname;
                    matchingConversation = sortedHistories.find(conv => {
                        try {
                            const convUrlObj = new URL(conv.url);
                            return (convUrlObj.origin + convUrlObj.pathname) === normalizedCurrent;
                        } catch { return false; }
                    });
                }
            } else {
                const candidateUrls = generateCandidateUrls(currentUrl);
                for (const candidate of candidateUrls) {
                    matchingConversation = sortedHistories.find(conv => {
                         try {
                            const convUrlObj = new URL(conv.url);
                            const normalizedConv = convUrlObj.origin + convUrlObj.pathname;
                            return conv.url === candidate || normalizedConv === candidate;
                        } catch { return false; }
                    });
                    if (matchingConversation) break;
                }
            }
            
            if (matchingConversation) {
                appContext.services.chatHistoryUI.loadConversationIntoChat(matchingConversation);
            } else {
                appContext.utils.showNotification('未找到本页面的历史对话');
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
                const repoUrl = appContext.state.pageInfo?.url?.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+/)?.[0];
                if (repoUrl) {
                    const content = await packRemoteRepoViaApiExtension(repoUrl);
                    appContext.dom.messageInput.textContent = content + `\n---\n
以上是当前 GitHub 仓库的全部内容

​**​核心任务:​**​ 生成一份​**​深度​**​、​**​结构化​**​的仓库总结报告。​**​最高优先级:​**​ 兼顾​**​宏观概览​**​与​**​关键技术细节​**​，提供​**​深刻洞察​**​，使读者能​**​快速、完整​**​地把握项目。

​**​报告必须包含以下部分 (按此结构和标题输出):​**​

1.  ​**​## 1. 核心目标与价值​**​
    *   精炼定义项目解决的核心问题及独特价值。

2.  ​**​## 2. 主要功能与特性​**​
    *   详尽列举核心功能。
    *   简述关键功能的实现原理（若可推断）。
    *   突出创新或亮点功能。

3.  ​**​## 3. 技术栈与架构​**​
    *   识别主要技术栈（语言、框架、库）。
    *   分析核心架构设计（模式、思想）。
    *   推断技术选型考量（性能、效率、生态等，需注明推断）。

4.  ​**​## 4. 代码结构与关键模块​**​
    *   描述主要目录结构及其用途。
    *   识别并解释​**​核心代码模块/文件​**​的作用与重要性（深入细节）。

5.  ​**​## 5. 安装、配置与使用指南​**​
    *   概述安装和配置步骤。
    *   提供简洁的核心用法示例或 API 调用。

6.  ​**​## 6. 项目状态与维护​**​
    *   评估活跃度、维护情况（基于 commit、issue、PR、发布）。

7.  ​**​## 7. 目标用户与适用场景​**​
    *   定义主要用户画像。
    *   描述典型应用场景。

​**​高级分析要求 (必须包含，并单独设为第 8 部分):​**​

8.  ​**​## 8. 洞察、与补充视角​**​
    *   ​**​分析性洞察:​**​ 提供对项目设计优劣、潜在影响的深刻见解，而非简单罗列。
    *   ​**​关键补充信息:​**​ ​**​主动思考并补充​**​ 任何对于全面理解此仓库​**​至关重要但容易被忽略​**​的方面（例如：特定的设计权衡、未在文档中明确说明的依赖关系、与其他技术的关键集成点等）。

​**​输出格式:​**​
*   ​**​严格使用 Markdown​**​，包含清晰的二级标题 (##)。
*   语言​**​专业、精炼、准确​**​。

​**​执行。​**​`;
                    appContext.services.messageSender.sendMessage();
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
        if (appContext.services.chatHistoryUI.isChatHistoryPanelOpen()) {
            if (appContext.dom.chatContainer.contains(e.target)) {
                setTimeout(() => {
                    appContext.services.uiManager.closeExclusivePanels();
                }, 0);
            }
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
                const range = document.createRange();
                range.selectNodeContents(appContext.dom.messageInput);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
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
                break;
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
        console.log(`内存管理系统已初始化: 空闲清理间隔=${mmConfig.IDLE_CLEANUP_INTERVAL/1000}秒, 强制清理间隔=${mmConfig.FORCED_CLEANUP_INTERVAL/60000}分钟`);
    }
    function updateUserActivity() {
        appContext.state.memoryManagement.lastUserActivity = Date.now();
    }
    function checkAndCleanupMemory() {
        const mmState = appContext.state.memoryManagement;
        if (!mmState.isEnabled) return;
        const idleTime = Date.now() - mmState.lastUserActivity;
        if (idleTime > mmState.USER_IDLE_THRESHOLD) {
            console.log(`用户已空闲${(idleTime/1000).toFixed(0)}秒，执行内存清理`);
            appContext.services.chatHistoryUI.clearMemoryCache();
        }
    }
    function forcedMemoryCleanup() {
        if (!appContext.state.memoryManagement.isEnabled) return;
        console.log('执行定期强制内存清理');
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
        console.log('初始化完成，主动请求当前页面信息');
        window.parent.postMessage({ type: 'REQUEST_PAGE_INFO' }, '*');
    }, 500);
});