import { initTreeDebugger } from '../../debug/tree_debugger.js';
import { findMostRecentConversationMetadataByUrlCandidates } from '../../storage/indexeddb_helper.js';
import { packRemoteRepoViaApiExtension } from '../../utils/repomix.js';
import { generateCandidateUrls } from '../../utils/url_candidates.js';

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
  setupSlashFocusShortcut(appContext);
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
      const candidateUrls = generateCandidateUrls(currentUrl);

      // 性能优化：在游标遍历时直接完成“最匹配会话”的筛选，避免一次性拉取全部会话元数据并在 UI 层排序扫描。
      const matchingConversation = await findMostRecentConversationMetadataByUrlCandidates(candidateUrls);

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
    const randomBgButton = appContext.dom.emptyStateRandomBackground;

    // 左键：刷新随机背景图片
    randomBgButton.addEventListener('click', () => {
      const settingsManager = appContext.services.settingsManager;
      if (!settingsManager?.refreshBackgroundImage) {
        console.warn('随机背景图片按钮点击时缺少 refreshBackgroundImage 方法');
        return;
      }
      settingsManager.refreshBackgroundImage();
    });

    // 右键：复制当前背景图片到剪贴板
    randomBgButton.addEventListener('contextmenu', async (event) => {
      event.preventDefault();

      const showNotification = appContext.utils?.showNotification;

      // 检查 Clipboard API 支持
      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
        showNotification?.({
          message: '当前环境不支持复制图片到剪贴板',
          type: 'warning',
          duration: 2400
        });
        return;
      }

      let imageUrl = '';

      try {
        // 从 CSS 变量中解析当前背景图片 URL
        const style = getComputedStyle(document.documentElement);
        const cssValue = (style.getPropertyValue('--cerebr-background-image') || '').trim();
        if (!cssValue || cssValue === 'none') {
          showNotification?.({
            message: '当前没有背景图片可以复制',
            type: 'warning',
            duration: 2000
          });
          return;
        }

        const match = cssValue.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
        imageUrl = match && match[2] ? match[2] : '';
        if (!imageUrl) {
          showNotification?.({
            message: '无法解析当前背景图片地址',
            type: 'warning',
            duration: 2400
          });
          return;
        }

        // 先拉取原始图片二进制
        let blob;
        try {
          const response = await fetch(imageUrl);
          if (!response.ok) {
            throw new Error('请求失败: ' + response.status);
          }
          blob = await response.blob();
        } catch (error) {
          console.error('获取背景图片失败:', error);
          showNotification?.({
            message: '获取背景图片失败，无法复制到剪贴板',
            type: 'error',
            duration: 2600
          });
          return;
        }

        if (typeof ClipboardItem === 'undefined') {
          showNotification?.({
            message: '当前环境不支持图片剪贴板写入',
            type: 'error',
            duration: 2600
          });
          return;
        }

        // 若不是 PNG，则通过 Canvas 转换为 PNG，保证最终写入的是 PNG 图片
        const ensurePngBlob = (inputBlob) => {
          if (inputBlob.type === 'image/png') return Promise.resolve(inputBlob);

          return new Promise((resolve, reject) => {
            try {
              const img = new Image();
              const objectUrl = URL.createObjectURL(inputBlob);
              img.onload = () => {
                try {
                  const canvas = document.createElement('canvas');
                  canvas.width = img.width;
                  canvas.height = img.height;
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0);
                  URL.revokeObjectURL(objectUrl);

                  canvas.toBlob((pngBlob) => {
                    if (pngBlob) {
                      resolve(pngBlob);
                    } else {
                      reject(new Error('PNG 转码失败'));
                    }
                  }, 'image/png');
                } catch (e) {
                  URL.revokeObjectURL(objectUrl);
                  reject(e);
                }
              };
              img.onerror = (e) => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('图片加载失败，无法转为 PNG'));
              };
              // 尝试避免跨域污染画布
              img.crossOrigin = 'anonymous';
              img.src = objectUrl;
            } catch (e) {
              reject(e);
            }
          });
        };

        const pngBlob = await ensurePngBlob(blob);
        const item = new ClipboardItem({ 'image/png': pngBlob });
        await navigator.clipboard.write([item]);

        showNotification?.({
          message: '已将背景图片以 PNG 格式复制到剪贴板',
          type: 'success',
          duration: 2000
        });
      } catch (error) {
        console.error('复制背景图片到剪贴板失败:', error);
        showNotification?.({
          message: '复制背景图片失败（可能是浏览器限制或跨域图片），请稍后重试',
          type: 'error',
          duration: 3200
        });
      }
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
    const anyPanelOpen = chatOpen;

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
        openers: [
          appContext.dom.emptyStateHistory,
          appContext.dom.apiSettingsToggle,
          appContext.dom.promptSettingsToggle
        ]
      }
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

function setupSlashFocusShortcut(appContext) {
  // 处理侧栏全局“/”快捷键，未聚焦输入框时快速聚焦到输入框
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    if (appContext.state.isComposing) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    const inputEl = appContext.dom.messageInput;
    if (!inputEl) return;
    if (document.activeElement === inputEl) return;

    const target = e.target;
    const isEditableTarget = (
      target &&
      (
        target.isContentEditable ||
        target.closest?.('[contenteditable="true"]') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )
    );
    if (isEditableTarget) return;

    e.preventDefault();
    e.stopPropagation();

    appContext.services.inputController?.focusToEnd?.();
  });
}

/**
 * 将「全屏/侧栏」布局状态同步到 iframe 内部的 DOM，并更新相关入口的提示文案。
 *
 * 说明：
 * - 父页面（content script）负责真正把侧边栏容器扩展为 100vw/100vh；
 * - iframe 里只需要切换 html.fullscreen-mode，用来调整内部内容布局（居中宽度等）。
 * - 这里统一封装，避免不同入口（菜单项、左侧细长把手）各自维护一套状态导致漂移。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 * @param {boolean} isFullscreen
 */
function applyFullscreenMode(appContext, isFullscreen) {
  appContext.state.isFullscreen = !!isFullscreen;
  document.documentElement.classList.toggle('fullscreen-mode', appContext.state.isFullscreen);
  updateFullscreenToggleHints(appContext);
}

/**
 * 根据当前布局模式刷新「全屏」菜单项与左侧把手的提示文案。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function updateFullscreenToggleHints(appContext) {
  const isFullscreen = !!appContext.state.isFullscreen;

  const collapseButton = appContext.dom.collapseButton;
  if (collapseButton) {
    const label = isFullscreen ? '退出全屏（侧栏模式）' : '切换全屏（沉浸模式）';
    collapseButton.title = label;
    collapseButton.setAttribute('aria-label', label);
  }

  const fullscreenToggle = appContext.dom.fullscreenToggle;
  if (fullscreenToggle) {
    const text = fullscreenToggle.querySelector('span');
    if (text) {
      text.textContent = isFullscreen ? '侧栏模式' : '全屏模式';
    }
    const icon = fullscreenToggle.querySelector('i');
    if (icon) {
      icon.classList.remove('fa-expand', 'fa-compress');
      icon.classList.add(isFullscreen ? 'fa-compress' : 'fa-expand');
    }
  }
}

/**
 * 由 iframe 主动发起全屏切换请求（通知父页面执行真实的全屏/退出全屏）。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function requestToggleFullscreen(appContext) {
  if (appContext.state.isStandalone) {
    appContext.utils.showNotification('独立聊天页面始终为全屏布局');
    return;
  }

  // 先在 iframe 内即时切换布局（避免等待父页面处理消息造成“闪一下/不跟手”）
  applyFullscreenMode(appContext, !appContext.state.isFullscreen);
  window.parent.postMessage({ type: 'TOGGLE_FULLSCREEN_FROM_IFRAME' }, '*');
}

function setupFullscreenToggle(appContext) {
  // 初始化时用 DOM class 做一次兜底同步，避免 iframe 刷新导致提示文案与实际布局不一致
  if (!appContext.state.isStandalone) {
    appContext.state.isFullscreen = document.documentElement.classList.contains('fullscreen-mode');
  }
  updateFullscreenToggleHints(appContext);

  if (appContext.dom.fullscreenToggle) {
    appContext.dom.fullscreenToggle.addEventListener('click', () => requestToggleFullscreen(appContext));
  }

  // 左侧（或左侧布局时出现在右侧）的细长把手：改为切换「全屏/侧栏」布局
  if (appContext.dom.collapseButton) {
    appContext.dom.collapseButton.addEventListener('click', () => requestToggleFullscreen(appContext));
    appContext.dom.collapseButton.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      requestToggleFullscreen(appContext);
    });
  }
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
        applyFullscreenMode(appContext, data.isFullscreen);
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
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (appContext.state.isComposing) return;
    // 阻止默认行为，避免触发表单提交或换行等浏览器默认处理
    e.preventDefault();
    // 阻止事件传播，避免其他监听器（如全局或父级）误判为普通 Enter 而触发发送
    // 特别是 Alt+Enter 仅用于“添加到历史（未发送）”，不应触发其他逻辑
    e.stopPropagation();

    // 兼容右 Alt（AltGr）：
    // - 在部分键盘布局/浏览器实现中，右 Alt 会表现为 AltGraph；
    // - 此时 event.altKey 可能为 false，导致“右 Alt + Enter”被当作普通 Enter 直接发送；
    // - 因此这里将 AltGraph 也视为 Alt 修饰键，确保左右 Alt 行为一致。
    const hasAltGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    const hasAltModifier = e.altKey || hasAltGraph;

    if (hasAltModifier) {
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

      const selectionThreadManager = appContext.services.selectionThreadManager;
      const isThreadModeActive = selectionThreadManager?.isThreadModeActive?.();
      let appendedToThread = false;

      if (isThreadModeActive) {
        // 线程模式下的 Alt+Enter：附加到线程链路，避免误写入主对话。
        const threadId = selectionThreadManager?.getActiveThreadId?.() || '';
        const threadInfo = selectionThreadManager?.findThreadById?.(threadId);
        const threadAnnotation = threadInfo?.annotation || null;
        const anchorMessageId = threadInfo?.anchorMessageId || '';

        if (!threadId || !threadAnnotation || !anchorMessageId) {
          appContext.utils?.showNotification?.({ message: '划词线程状态异常，未能添加消息', type: 'warning' });
          selectionThreadManager?.exitThread?.();
          return;
        }

        const chatHistoryManager = appContext.services.chatHistoryManager;
        const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId) || null;
        if (!anchorNode) {
          appContext.utils?.showNotification?.({ message: '划词线程锚点已丢失，未能添加消息', type: 'warning' });
          selectionThreadManager?.exitThread?.();
          return;
        }

        let rootMessageId = threadAnnotation.rootMessageId || null;
        if (!rootMessageId) {
          const selectionText = threadAnnotation.selectionText || '';
          const content = selectionText ? `> ${selectionText}` : '>';
          const rootNode = chatHistoryManager.addMessageToTreeWithOptions(
            'user',
            content,
            anchorMessageId,
            { preserveCurrentNode: true }
          );
          if (!rootNode) {
            appContext.utils?.showNotification?.({ message: '创建划词线程锚点失败', type: 'warning' });
            return;
          }
          rootNode.threadId = threadId;
          rootNode.threadAnchorId = anchorMessageId;
          rootNode.threadSelectionText = selectionText;
          rootNode.threadHiddenSelection = true;
          rootNode.threadMatchIndex = Number.isFinite(threadAnnotation.matchIndex)
            ? threadAnnotation.matchIndex
            : 0;
          threadAnnotation.rootMessageId = rootNode.id;
          threadAnnotation.lastMessageId = rootNode.id;
          rootMessageId = rootNode.id;
        }

        const historyParentId = threadAnnotation.lastMessageId || rootMessageId || anchorMessageId;
        const threadHistoryPatch = {
          threadId,
          threadAnchorId: anchorMessageId,
          threadSelectionText: threadAnnotation.selectionText || '',
          threadRootId: rootMessageId
        };

        const newMessage = appContext.services.messageProcessor.appendMessage(
          text,
          'user',
          false,
          null,
          imagesHTML,
          null,
          null,
          null,
          {
            container: appContext.dom.threadContainer,
            historyParentId,
            preserveCurrentNode: true,
            historyPatch: threadHistoryPatch
          }
        );
        const newMessageId = newMessage?.getAttribute?.('data-message-id') || '';
        if (newMessageId) {
          threadAnnotation.lastMessageId = newMessageId;
        }
        if (appContext.dom.threadContainer) {
          appContext.dom.threadContainer.scrollTop = appContext.dom.threadContainer.scrollHeight;
        }
        appendedToThread = true;
      } else {
        appContext.services.messageProcessor.appendMessage(
          text,
          'user',
          false,
          null,
          imagesHTML
        );
      }

      try { appContext.dom.messageInput.innerHTML = ''; } catch (_) {}
      try { appContext.dom.imageContainer.innerHTML = ''; } catch (_) {}
      try { appContext.services.uiManager.resetInputHeight(); } catch (_) {}

      try {
        await appContext.services.chatHistoryUI.saveCurrentConversation(true);
        appContext.services.messageSender.setCurrentConversationId(
          appContext.services.chatHistoryUI.getCurrentConversationId()
        );
      } catch (_) {}

      appContext.utils.showNotification(appendedToThread ? '已添加到线程（未发送）' : '已添加到历史（未发送）');
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
        appContext.services.messageSender.sendMessage({
          originalMessageText: userMessageText,
          specificPromptType: 'selection',
          promptMeta: { selectionText: text },
          api: apiParam
        });
        return;
      }
    }
    // 兜底保护：若仍检测到 Alt/Ctrl/Meta 修饰键，则不发送，避免误发
    if (e.altKey || hasAltGraph || e.ctrlKey || e.metaKey) {
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
