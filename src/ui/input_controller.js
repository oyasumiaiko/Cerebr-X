/**
 * 输入控制器模块
 * 负责统一管理侧边栏输入框与图片容器的读写、状态查询和清理，降低业务逻辑与 DOM 的耦合。
 * @since 1.2.0
 */

/**
 * 创建输入控制器
 * @param {Object} appContext - 应用上下文，提供 DOM 与服务访问
 * @param {Object} appContext.dom - DOM 引用集合
 * @param {HTMLElement} appContext.dom.messageInput - 消息输入框元素
 * @param {HTMLElement} appContext.dom.imageContainer - 图片容器元素
 * @param {Object} appContext.services - 服务集合
 * @param {Object} appContext.services.uiManager - UI 管理器（用于重置高度等）
 * @returns {Object} 输入控制器实例
 * @property {() => string} getInputText 获取输入框文本内容（去除首尾空白）
 * @property {(text: string) => void} setInputText 设置输入框文本内容
 * @property {() => boolean} hasImages 输入区域是否包含图片
 * @property {() => string} getImagesHTML 获取输入区域图片的 HTML 片段
 * @property {() => boolean} hasScreenshot 是否包含页面截图图片（alt="page-screenshot.png"）
 * @property {() => void} clear 清空输入与图片，并重置输入高度
 * @property {() => void} focusToEnd 聚焦输入框并将光标移动到末尾
 */
export function createInputController(appContext) {
  const { dom, services } = appContext;
  const messageInput = dom.messageInput;
  const imageContainer = dom.imageContainer;

  /**
   * 获取输入文本
   * @returns {string} 输入文本内容
   */
  function getInputText() {
    try {
      return (messageInput?.textContent || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * 设置输入文本
   * @param {string} text 文本内容
   * @returns {void}
   */
  function setInputText(text) {
    if (!messageInput) return;
    try {
      messageInput.textContent = text || '';
    } catch (_) {}
  }

  /**
   * 是否包含图片
   * @returns {boolean}
   */
  function hasImages() {
    try {
      return !!imageContainer?.querySelector('.image-tag');
    } catch (_) {
      return false;
    }
  }

  /**
   * 获取图片 HTML
   * @returns {string}
   */
  function getImagesHTML() {
    try {
      return imageContainer?.innerHTML || '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 是否包含截图图片
   * @returns {boolean}
   */
  function hasScreenshot() {
    try {
      return !!imageContainer?.querySelector('img[alt="page-screenshot.png"]');
    } catch (_) {
      return false;
    }
  }

  /**
   * 清空输入与图片，并重置输入高度
   * @returns {void}
   */
  function clear() {
    try { if (messageInput) messageInput.innerHTML = ''; } catch (_) {}
    try { if (imageContainer) imageContainer.innerHTML = ''; } catch (_) {}
    try { services?.uiManager?.resetInputHeight?.(); } catch (_) {}
  }

  /**
   * 聚焦输入框并将光标移到末尾
   * @returns {void}
   */
  function focusToEnd() {
    if (!messageInput) return;
    try {
      messageInput.focus();
      const range = document.createRange();
      range.selectNodeContents(messageInput);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  return {
    getInputText,
    setInputText,
    hasImages,
    getImagesHTML,
    hasScreenshot,
    clear,
    focusToEnd
  };
}


