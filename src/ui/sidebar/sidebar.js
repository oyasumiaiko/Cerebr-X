import { createSidebarAppContext, registerSidebarUtilities } from './sidebar_app_context.js';
import { initializeSidebarServices } from './sidebar_bootstrap.js';
import { registerSidebarEventHandlers } from './sidebar_events.js';

/**
 * 页面 DOM 就绪后执行整体启动流程：检测模式 -> 构建上下文 -> 初始化服务 -> 注册事件。
 */
document.addEventListener('DOMContentLoaded', async () => {
  const isStandalone = detectStandaloneMode();
  applyStandaloneClasses(isStandalone);

  const appContext = createSidebarAppContext(isStandalone);
  registerSidebarUtilities(appContext);
  setupLayoutObservers(appContext);
  exposeGlobals(appContext, isStandalone);

  await initializeSidebarServices(appContext);
  registerSidebarEventHandlers(appContext);
});

/**
 * 识别当前页面是否运行在独立聊天模式下。
 * @returns {boolean} 是否独立模式。
 */
function detectStandaloneMode() {
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
    // 跨域场景下访问 window.parent 可能抛异常，忽略并视为嵌入模式
  }
  return isStandalone;
}

/**
 * 根据模式为根节点 / body 添加或移除独立模式样式类。
 * @param {boolean} isStandalone - 独立模式标记。
 */
function applyStandaloneClasses(isStandalone) {
  if (document?.body) {
    document.body.classList.toggle('standalone-mode', isStandalone);
  }
  if (document?.documentElement) {
    document.documentElement.classList.toggle('standalone-mode', isStandalone);
  }
}

/**
 * 建立输入容器高度的观察者，保持 CSS 变量与布局同步。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupLayoutObservers(appContext) {
  appContext.utils.updateInputContainerHeightVar();
  window.addEventListener('resize', appContext.utils.updateInputContainerHeightVar);
  const resizeObserver = new ResizeObserver(() => appContext.utils.updateInputContainerHeightVar());
  const inputEl = document.getElementById('input-container');
  if (inputEl) resizeObserver.observe(inputEl);
}

/**
 * 暴露简化后的全局对象，供外部调试或内容脚本访问。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 * @param {boolean} isStandalone - 当前环境标记。
 */
function exposeGlobals(appContext, isStandalone) {
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
}
