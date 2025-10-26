import { initTreeDebugger } from '../../debug/tree_debugger.js';
import { getAllConversationMetadata } from '../../storage/indexeddb_helper.js';
import { packRemoteRepoViaApiExtension } from '../../utils/repomix.js';

/**
 * 注册侧边栏所需的事件绑定与交互逻辑。
 * 以 setup* 函数形式拆分，便于后续在个别功能上做替换或测试。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext - 侧边栏上下文对象。
 */
export function registerSidebarEventHandlers(appContext) {
  setupOpenStandaloneHandler(appContext);
  setupStatusDot(appContext);
  setupApiMenuWatcher(appContext);
  setupEmptyStateHandlers(appContext);
  setupRepomixButton(appContext);
  setupGlobalEscapeHandler(appContext);
  setupClickAwayHandler(appContext);
  setupFullscreenToggle(appContext);
  setupScreenshotButton(appContext);
  setupWindowMessageHandlers(appContext);
  setupTempModeIndicator(appContext);
  setupMessageInputHandlers(appContext);
  setupChatActionButtons(appContext);
  setupDebugButton(appContext);
  setupMemoryManagement(appContext);
  scheduleInitialRequests(appContext);
}

/**
 * 处理“打开独立页面”入口按钮。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupOpenStandaloneHandler(appContext) {
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
        appContext.utils.showNotification({ message: '无法打开独立聊天页面', type: 'error' });
      }
      appContext.services.uiManager.toggleSettingsMenu(false);
    });
  }
}

/**
 * 管理左上角状态点（网页内容模式/临时模式）的展示与交互。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupStatusDot(appContext) {
  const dot = appContext.dom.statusDot;
  if (!dot) return;
  if (appContext.state.isStandalone) {
    dot.style.display = 'none';
    return;
  }

  const sender = appContext.services.messageSender;
  const refresh = () => {
    const isTemp = sender.getTemporaryModeState?.() === true;
    if (isTemp) {
      dot.classList.remove('on');
      dot.title = '未获取网页内容（纯对话）';
    } else {
      dot.classList.add('on');
      dot.title = '获取网页内容';
    }
  };

  dot.addEventListener('click', () => {
    sender.toggleTemporaryMode();
    refresh();
  });

  refresh();
  window.addEventListener('message', (event) => {
    if (event?.data?.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
      setTimeout(refresh, 0);
    }
  });
  document.addEventListener('TEMP_MODE_CHANGED', () => setTimeout(refresh, 0));
  if (appContext.dom.emptyStateTempMode && !appContext.state.isStandalone) {
    appContext.dom.emptyStateTempMode.addEventListener('click', () => setTimeout(refresh, 0));
  }
}

function setupApiMenuWatcher(appContext) {
  const updateApiMenuText = () => {
    const currentConfig = appContext.services.apiManager.getSelectedConfig();
    if (currentConfig) {
      appContext.dom.apiSettingsText.textContent = currentConfig.displayName || currentConfig.modelName || 'API 设置';
    }
  };
  updateApiMenuText();
  window.addEventListener('apiConfigsUpdated', updateApiMenuText);
}

/**
 * 空态入口相关的按钮交互（历史、总结、加载会话等）。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupEmptyStateHandlers(appContext) {
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
        appContext.utils.showNotification({ message: '未能获取当前页面URL', type: 'warning' });
        return;
      }

      const histories = await getAllConversationMetadata();
      const sortedHistories = histories.sort((a, b) => b.endTime - a.endTime);

      function generateCandidateUrls(urlString) {
        const candidates = new Set();
        try {
          const urlObj = new URL(urlString);
          const origin = urlObj.origin;

          let current = urlString;

          while (current.length > origin.length) {
            candidates.add(current);

            const searchArea = current.substring(origin.length);
            const lastDelimiterIndexInSearchArea = Math.max(
              searchArea.lastIndexOf('/'),
              searchArea.lastIndexOf('?'),
              searchArea.lastIndexOf('&'),
              searchArea.lastIndexOf('#')
            );

            if (lastDelimiterIndexInSearchArea === -1) {
              break;
            }

            const delimiterIndex = origin.length + lastDelimiterIndexInSearchArea;
            current = current.substring(0, delimiterIndex);

            if (current === origin + '/') {
              current = origin;
            }
          }

          candidates.add(origin);
        } catch (error) {
          console.error('generateCandidateUrls error: ', error);
          if (urlString) candidates.add(urlString);
        }
        return Array.from(candidates);
      }

      const candidateUrls = generateCandidateUrls(currentUrl);
      let matchingConversation = null;

      for (const candidate of candidateUrls) {
        const match = sortedHistories.find((conv) => {
          try {
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

      if (matchingConversation) {
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

  if (appContext.dom.emptyStateRandomBackground) {
    appContext.dom.emptyStateRandomBackground.addEventListener('click', () => {
      const settingsManager = appContext.services.settingsManager;
      if (!settingsManager?.refreshBackgroundImage) {
        console.warn('随机背景图片按钮点击时缺少 refreshBackgroundImage 方法');
        return;
      }
      settingsManager.refreshBackgroundImage();
    });
  }
}

/**
 * GitHub 仓库总结按钮：调用远端打包接口并把内容插入对话。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupRepomixButton(appContext) {
  if (appContext.dom.repomixButton && !appContext.state.isStandalone) {
    appContext.dom.repomixButton.addEventListener('click', async () => {
      const isGithubRepo = appContext.state.pageInfo?.url?.includes('github.com');
      if (!isGithubRepo) return;

      const repoUrl = appContext.state.pageInfo?.url;
      if (!repoUrl) return;

      const toast = appContext.utils.showNotification({
        message: '正在打包仓库...',
        showProgress: true,
        progress: 0.12,
        autoClose: false
      });

      let progressValue = 0.12;
      const progressTimer = setInterval(() => {
        progressValue = Math.min(0.6, progressValue + 0.07);
        toast.update({ progress: progressValue });
        if (progressValue >= 0.6) {
          clearInterval(progressTimer);
        }
      }, 700);

      try {
        const content = await packRemoteRepoViaApiExtension(repoUrl);
        clearInterval(progressTimer);

        if (!content) {
          toast.update({
            message: '未能打包仓库内容或内容为空。',
            type: 'warning',
            showProgress: false,
            autoClose: true,
            duration: 3200
          });
          return;
        }

        toast.update({ message: '仓库打包完成，正在插入内容...', progress: 0.85, progressMode: 'determinate' });

        const messageElement = appContext.services.messageProcessor.appendMessage(
          content,
          'user',
          false,
          null,
          null
        );

        if (!messageElement) {
          toast.update({
            message: '无法将仓库内容添加到对话中。',
            type: 'error',
            showProgress: false,
            autoClose: true,
            duration: 3200
          });
          return;
        }

        appContext.services.inputController.setInputText('全面分析介绍总结当前仓库的结构、内容、原理、核心逻辑的实现');
        appContext.dom.messageInput.focus();

        toast.update({
          message: '仓库内容已添加到当前对话。',
          progress: 1,
          autoClose: true,
          duration: 2200
        });
      } catch (error) {
        clearInterval(progressTimer);
        console.error('处理 repomixButton 点击事件失败:', error);
        toast.update({
          message: '打包仓库时发生错误。',
          type: 'error',
          showProgress: false,
          autoClose: true,
          duration: 3200
        });
      }
    });
  }
}

function setupGlobalEscapeHandler(appContext) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (appContext.state.isComposing) return;
    // 若存在统一确认对话框，交由对话框自身处理，不在此处影响面板状态
    if (document.querySelector('.confirm-overlay')) {
      return;
    }

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
  });
}

function setupClickAwayHandler(appContext) {
  document.addEventListener('click', (e) => {
    // 若存在统一确认对话框，避免点击外部逻辑误关面板
    if (document.querySelector('.confirm-overlay')) {
      return;
    }
    const target = e.target;

    const panelsAndToggles = [
      {
        panel: document.getElementById('chat-history-panel'),
        toggle: appContext.dom.chatHistoryMenuItem,
        openers: [appContext.dom.emptyStateHistory]
      },
      { panel: appContext.dom.apiSettingsPanel, toggle: appContext.dom.apiSettingsToggle, openers: [] },
      { panel: appContext.dom.promptSettingsPanel, toggle: appContext.dom.promptSettingsToggle, openers: [] },
      { panel: appContext.dom.computerUsePanel, toggle: appContext.dom.computerUseMenuItem, openers: [] }
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
      if (pt.openers && pt.openers.some((opener) => opener && opener.contains(target))) {
        clickInsideManagedElement = true;
        break;
      }
    }

    if (!clickInsideManagedElement) {
      appContext.services.uiManager.closeExclusivePanels();
    }
  });
}

function setupFullscreenToggle(appContext) {
  if (!appContext.dom.fullscreenToggle) return;

  appContext.dom.fullscreenToggle.addEventListener('click', async () => {
    if (appContext.state.isStandalone) {
      appContext.utils.showNotification('独立聊天页面始终为全屏布局');
      return;
    }
    appContext.state.isFullscreen = !appContext.state.isFullscreen;

    if (appContext.state.isFullscreen) {
      document.documentElement.classList.add('fullscreen-mode');
    } else {
      document.documentElement.classList.remove('fullscreen-mode');
    }

    window.parent.postMessage({ type: 'TOGGLE_FULLSCREEN_FROM_IFRAME' }, '*');
  });
}

function setupScreenshotButton(appContext) {
  if (!appContext.dom.screenshotButton) return;
  appContext.dom.screenshotButton.addEventListener('click', () => {
    appContext.utils.requestScreenshot();
  });
}

/**
 * 监听来自 content script / background 的消息，完成状态同步与快捷操作。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupWindowMessageHandlers(appContext) {
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

            appContext.services.messageProcessor.appendMessage(
              text,
              'user',
              false,
              null,
              ''
            );

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
        if (appContext.dom.repomixButton) {
          const isGithubRepo = data.url?.includes('github.com');
          appContext.dom.repomixButton.style.display = isGithubRepo ? 'block' : 'none';
        }
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
          appContext.utils.showNotification({ message: '独立聊天页面不支持网页总结', type: 'warning' });
          break;
        }
        appContext.services.messageSender.performQuickSummary(data.selectedContent);
        break;
      case 'QUICK_SUMMARY_COMMAND_QUERY':
        if (appContext.state.isStandalone) {
          appContext.utils.showNotification({ message: '独立聊天页面不支持网页总结', type: 'warning' });
          break;
        }
        appContext.services.messageSender.performQuickSummary(data.selectedContent, true);
        break;
      case 'TOGGLE_TEMP_MODE_FROM_EXTENSION':
        if (appContext.state.isStandalone) {
          break;
        }
        appContext.services.messageSender.toggleTemporaryMode();
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
        appContext.state.isFullscreen = data.isFullscreen;
        if (data.isFullscreen) {
          document.documentElement.classList.add('fullscreen-mode');
        } else {
          document.documentElement.classList.remove('fullscreen-mode');
        }
        break;
      case 'COMPUTER_USE_SNAPSHOT_RESULT':
        appContext.services.computerUseTool?.handleSnapshotResult(data);
        break;
      case 'COMPUTER_USE_ACTION_RESULT':
        appContext.services.computerUseTool?.handleActionResult(data);
        break;
      case 'COMPUTER_USE_SESSION_STATE':
        appContext.services.computerUseTool?.handleSessionState?.(data);
        break;
      case 'COMPUTER_USE_FORCE_OPEN':
        appContext.utils.closeExclusivePanels?.();
        appContext.services.computerUseTool?.openPanel?.();
        break;
      default:
        break;
    }
  });
}

function setupTempModeIndicator(appContext) {
  document.addEventListener('TEMP_MODE_CHANGED', (e) => {
    const isOn = !!e?.detail?.isOn;
    if (appContext?.dom?.modeIndicator) {
      appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
      appContext.dom.modeIndicator.title = isOn ? '仅对话模式中，点击退出' : '点击进入仅对话模式';
    }
  });
}

/**
 * 统一处理输入框的组合键、重新生成等逻辑。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupMessageInputHandlers(appContext) {
  const input = appContext.dom.messageInput;
  if (!input) return;

  input.addEventListener('compositionstart', () => { appContext.state.isComposing = true; });
  input.addEventListener('compositionend', () => { appContext.state.isComposing = false; });

  input.addEventListener('keydown', async function (e) {
    const computerUseTool = appContext.services.computerUseTool;
    const usingComputerUse = computerUseTool?.isInputActive?.();
    if (usingComputerUse) {
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        computerUseTool.submitInstruction?.();
      }
      return;
    }

    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (appContext.state.isComposing) return;
    // 阻止默认行为，避免触发表单提交或换行等浏览器默认处理
    e.preventDefault();
    // 阻止事件传播，避免其他监听器（如全局或父级）误判为普通 Enter 而触发发送
    // 特别是 Alt+Enter 仅用于“添加到历史（未发送）”，不应触发其他逻辑
    e.stopPropagation();

    if (e.altKey) {
      // Alt+Enter：只添加到历史，不发送
      // 说明：有些环境下可能还存在捕获阶段/冒泡阶段的监听，显式阻断
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (appContext.state.isComposing) return;
      const text = (this.textContent || '').trim();
      const imagesHTML = appContext.dom.imageContainer?.innerHTML || '';
      const hasImages = !!appContext.dom.imageContainer?.querySelector('.image-tag');
      if (!text && !hasImages) {
        // 没有任何内容时，不进行添加，给出轻提示
        appContext.utils?.showNotification?.({ message: '没有可添加的内容', type: 'warning' });
        return;
      }

      appContext.services.messageProcessor.appendMessage(
        text,
        'user',
        false,
        null,
        imagesHTML
      );

      try { appContext.dom.messageInput.innerHTML = ''; } catch (_) {}
      try { appContext.dom.imageContainer.innerHTML = ''; } catch (_) {}
      try { appContext.services.uiManager.resetInputHeight(); } catch (_) {}

      try {
        await appContext.services.chatHistoryUI.saveCurrentConversation(true);
        appContext.services.messageSender.setCurrentConversationId(
          appContext.services.chatHistoryUI.getCurrentConversationId()
        );
      } catch (_) {}

      appContext.utils.showNotification('已添加到历史（未发送）');
      return;
    }

    const text = this.textContent.trim();
    const hasImagesInInput = !!appContext.dom.imageContainer?.querySelector('.image-tag');

    if (!text && !hasImagesInInput) {
      try {
        const lastMessage = appContext.dom.chatContainer.querySelector('.message:last-child');
        if (!lastMessage) {
          appContext.utils.showNotification({ message: '没有可用的历史用户消息', type: 'warning' });
          return;
        }
        if (!lastMessage.classList?.contains('user-message')) {
          appContext.utils.showNotification({ message: '最后一条消息不是用户消息，未发送', type: 'warning' });
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
    // 兜底保护：若仍检测到 Alt/Ctrl/Meta 修饰键，则不发送，避免误发
    if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    appContext.services.messageSender.sendMessage();
  });
}

function setupChatActionButtons(appContext) {
  appContext.dom.clearChat.addEventListener('click', async () => {
    await appContext.services.chatHistoryUI.clearChatHistory();
    appContext.services.uiManager.toggleSettingsMenu(false);
    appContext.dom.messageInput.focus();
  });

  appContext.dom.quickSummary.addEventListener('click', () => appContext.services.messageSender.performQuickSummary());
  appContext.dom.sendButton.addEventListener('click', () => {
    if (appContext.services.computerUseTool?.isInputActive?.()) {
      appContext.services.computerUseTool.submitInstruction?.();
      return;
    }
    appContext.services.messageSender.sendMessage();
  });

  if (appContext.dom.chatHistoryMenuItem) {
    appContext.dom.chatHistoryMenuItem.addEventListener('click', () => {
      const isOpen = appContext.services.chatHistoryUI.isChatHistoryPanelOpen();
      appContext.services.uiManager.closeExclusivePanels();
      if (!isOpen) {
        appContext.services.chatHistoryUI.showChatHistoryPanel();
      }
    });
  }
}

function setupDebugButton(appContext) {
  if (!appContext.dom.debugTreeButton) return;
  appContext.dom.debugTreeButton.addEventListener('click', () => {
    initTreeDebugger(appContext.services.chatHistoryManager.chatHistory);
  });
}

/**
 * 启动前端内存管理逻辑：统计用户活跃度并定期清理缓存。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupMemoryManagement(appContext) {
  const mmConfig = appContext.state.memoryManagement;

  const updateUserActivity = () => {
    appContext.state.memoryManagement.lastUserActivity = Date.now();
  };

  const throttle = (func, limit) => {
    let lastFunc;
    let lastRan;
    return function (...args) {
      const context = this;
      if (!lastRan) {
        func.apply(context, args);
        lastRan = Date.now();
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(function () {
          if ((Date.now() - lastRan) >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        }, limit - (Date.now() - lastRan));
      }
    };
  };

  const checkAndCleanupMemory = () => {
    const mmState = appContext.state.memoryManagement;
    if (!mmState.isEnabled) return;
    const idleTime = Date.now() - mmState.lastUserActivity;
    if (idleTime > mmState.USER_IDLE_THRESHOLD) {
      appContext.services.chatHistoryUI.clearMemoryCache();
    }
  };

  const forcedMemoryCleanup = () => {
    if (!appContext.state.memoryManagement.isEnabled) return;
    appContext.services.chatHistoryUI.clearMemoryCache();
  };

  document.addEventListener('click', updateUserActivity);
  document.addEventListener('keypress', updateUserActivity);
  document.addEventListener('mousemove', throttle(updateUserActivity, 5000));
  setInterval(checkAndCleanupMemory, mmConfig.IDLE_CLEANUP_INTERVAL);
  setInterval(forcedMemoryCleanup, mmConfig.FORCED_CLEANUP_INTERVAL);
}

function scheduleInitialRequests(appContext) {
  setTimeout(() => {
    if (!appContext.state.isStandalone) {
      window.parent.postMessage({ type: 'REQUEST_PAGE_INFO' }, '*');
    }

    if (appContext.state.isFullscreen) {
      document.documentElement.classList.add('fullscreen-mode');
    }
  }, 500);
}
