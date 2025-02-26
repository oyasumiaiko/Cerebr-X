console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 800;  // 默认值改为800px
    this.scaleFactor = 1.0;
    this.initialized = false;
    this.lastUrl = window.location.href;
    this.isFullscreen = false;
    this.sidebarPosition = 'right'; // 默认侧边栏位置为右侧
    console.log('CerebrSidebar 实例创建');
    this.initializeSidebar();
    this.setupUrlChangeListener();
    this.setupDragAndDrop();
  }

  // 添加统一的宽度更新方法
  updateWidth(width) {
    this.sidebarWidth = width;
    this.sidebar.style.width = `calc(${this.sidebarWidth}px * var(--scale-ratio, 1) / ${this.scaleFactor})`;
    chrome.storage.sync.set({ sidebarWidth: this.sidebarWidth });
  }

  // 添加更新侧边栏位置的方法
  updatePosition(position) {
    this.sidebarPosition = position;
    if (!this.sidebar) return; // 确保sidebar已经创建
    if (this.isFullscreen) return; // 全屏模式不改变位置

    const style = this.sidebar.style;
    // 移除两侧的定位
    style.left = '';
    style.right = '';
    
    // 设置新的定位和变换
    if (position === 'left') {
      style.left = `calc(20px * var(--scale-ratio, 1))`;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(-100% - calc(20px * var(--scale-ratio, 1))))`);
      this.sidebar.style.setProperty('--box-shadow-visible', `2px 0 15px rgba(0,0,0,0.1)`);
    } else {
      style.right = `calc(20px * var(--scale-ratio, 1))`;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(100% + calc(20px * var(--scale-ratio, 1))))`);
      this.sidebar.style.setProperty('--box-shadow-visible', `-2px 0 15px rgba(0,0,0,0.1)`);
    }
    
    // 如果侧边栏没有显示，立即应用隐藏的变换
    if (!this.isVisible) {
      this.sidebar.style.transform = `var(--transform-hidden)`;
    }

    chrome.storage.sync.set({ sidebarPosition: this.sidebarPosition });
    
    console.log(`侧边栏位置已更新为: ${position}, 可见状态: ${this.isVisible}`);
  }

  setupUrlChangeListener() {
    let lastUrl = window.location.href;

    // 检查URL是否发生实质性变化
    const hasUrlChanged = (currentUrl) => {
      if (currentUrl === lastUrl) return false;
      if (document.contentType === 'application/pdf') return false;

      const oldUrl = new URL(lastUrl);
      const newUrl = new URL(currentUrl);
      return oldUrl.pathname !== newUrl.pathname || oldUrl.search !== newUrl.search;
    };

    // 处理URL变化
    const handleUrlChange = () => {
      const currentUrl = window.location.href;
      if (hasUrlChanged(currentUrl)) {
        console.log('URL变化:', '从:', lastUrl, '到:', currentUrl);
        lastUrl = currentUrl;

        // 获取iframe并发送消息
        const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
        if (iframe) {
          console.log('发送URL变化消息到iframe');
          iframe.contentWindow.postMessage({
            type: 'URL_CHANGED',
            url: currentUrl,
            title: document.title,
            referrer: document.referrer,
            lastModified: document.lastModified,
            lang: document.documentElement.lang,
            charset: document.characterSet
          }, '*');
        }
      }
    };

    // 监听popstate事件
    window.addEventListener('popstate', () => {
      console.log('popstate事件触发');
      handleUrlChange();
    });

    // 重写history方法
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      console.log('pushState被调用');
      handleUrlChange();
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      console.log('replaceState被调用');
      handleUrlChange();
    };

    // 添加定期检查
    setInterval(handleUrlChange, 1000);
  }

  async initializeSidebar() {
    try {
      console.log('开始初始化侧边栏');

      // 从存储中加载宽度、缩放因子和位置
      const result = await chrome.storage.sync.get(['sidebarWidth', 'scaleFactor', 'sidebarPosition']);
      this.sidebarWidth = result.sidebarWidth || 800; // 确保默认值一致
      this.scaleFactor = result.scaleFactor || 1.0;
      this.sidebarPosition = result.sidebarPosition || 'right';
      
      console.log(`初始化侧边栏: 宽度=${this.sidebarWidth}, 缩放=${this.scaleFactor}, 位置=${this.sidebarPosition}`);

      const container = document.createElement('cerebr-root');

      // 防止外部JavaScript访问和修改我们的元素
      Object.defineProperty(container, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      // 使用closed模式的shadowRoot以增加隔离性
      const shadow = container.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
          contain: style layout size;
        }
          
        .cerebr-sidebar {
          --transform-hidden: translateX(calc(100% + calc(20px * var(--scale-ratio, 1))));
          --box-shadow-visible: -2px 0 15px rgba(0,0,0,0.1);
          
          position: fixed;
          top: calc(20px * var(--scale-ratio, 1));
          width: calc(${this.sidebarWidth}px * var(--scale-ratio, 1) / ${this.scaleFactor});
          height: calc(100vh - calc(40px * var(--scale-ratio, 1)));
          color: var(--cerebr-text-color, #000000);
          z-index: 2147483647;
          border-radius: calc(12px * var(--scale-ratio, 1));
          overflow: hidden;
          visibility: hidden;
          transform: var(--transform-hidden);
          pointer-events: none;
          isolation: isolate;
          /* border: 1px solid rgba(255, 255, 255, 0.1); */
          contain: layout style;
          transition: transform 0.3s ease, visibility 0.3s ease, box-shadow 0.3s ease;
        }

        .cerebr-sidebar.visible {
          pointer-events: auto;
          visibility: visible;
          transform: translateX(0) !important;
          box-shadow: var(--box-shadow-visible);
        }

        .cerebr-sidebar__content {
          height: 100%;
          overflow: auto;
          border-radius: calc(12px * var(--scale-ratio, 1));
          position: relative;
          background: rgba(255, 255, 255, 0);
          backdrop-filter: blur(120px) saturate(250%);
          contain: layout style;
          pointer-events: auto;
        }
        .cerebr-sidebar__content {
          height: 100%;
          overflow: hidden;
          border-radius: 0;
          contain: style layout size;
        }

        .cerebr-sidebar.fullscreen {
          transition: all 0s !important;

          top: 0px;
          left: 0px !important;
          right: 0px !important;
          width: 100vw !important;
          height: 100vh;
          margin-right: 0;
          margin-left: 0;
          border-radius: 0;
          transform: translateX(0) !important;
        }
        .cerebr-sidebar.fullscreen.visible {
          transform: translateX(0) !important;
          box-shadow: none !important;
        }
        .cerebr-sidebar.fullscreen .cerebr-sidebar__content {
          border-radius: 0;
        }


        .cerebr-sidebar__iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: transparent;
          position: relative;
          transform-origin: top left;
          box-sizing: border-box;
        }
      `;

      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';

      // 防止外部JavaScript访问和修改侧边栏
      Object.defineProperty(this.sidebar, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      const header = document.createElement('div');
      header.className = 'cerebr-sidebar__header';

      const resizer = document.createElement('div');
      resizer.className = 'cerebr-sidebar__resizer';

      const content = document.createElement('div');
      content.className = 'cerebr-sidebar__content';

      const iframe = document.createElement('iframe');
      iframe.className = 'cerebr-sidebar__iframe';
      iframe.src = chrome.runtime.getURL('src/ui/sidebar/sidebar.html');
      iframe.allow = 'clipboard-write';

      content.appendChild(iframe);
      this.sidebar.appendChild(header);
      this.sidebar.appendChild(resizer);
      this.sidebar.appendChild(content);

      // 添加侧边栏到DOM
      shadow.appendChild(style);
      shadow.appendChild(this.sidebar);

      // 添加到文档并保护它
      const root = document.documentElement;
      root.appendChild(container);

      // 设置侧边栏位置 - 在添加到DOM之后设置
      this.updatePosition(this.sidebarPosition);

      // 添加 ResizeObserver 监听大小变化
      const scaleObserver = new ResizeObserver(entries => {
        this.updateScale();
      });

      scaleObserver.observe(content);

      // 使用MutationObserver确保我们的元素不会被移除
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const removedNodes = Array.from(mutation.removedNodes);
            if (removedNodes.includes(container)) {
              console.log('检测到侧边栏被移除，正在恢复...');
              root.appendChild(container);
            }
          }
        }
      });

      observer.observe(root, {
        childList: true
      });

      console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        console.log('侧边栏初始化完成');
      });

      // 延迟发送 URL_CHANGED 消息，等待 iframe 加载完毕
      iframe.addEventListener('load', () => {
         iframe.contentWindow.postMessage({
           type: 'URL_CHANGED',
           url: window.location.href,
           title: document.title,
           referrer: document.referrer,
           lastModified: document.lastModified,
           lang: document.documentElement.lang,
           charset: document.characterSet
         }, '*');
      });
    } catch (error) {
      console.error('初始化侧边栏失败:', error);
    }
  }

  setupEventListeners(resizer) {
    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
      // 如果是全屏模式，不允许调整大小
      if (this.isFullscreen) return;

      startX = e.clientX;
      startWidth = this.sidebarWidth;

      const handleMouseMove = (e) => {
        // 如果是全屏模式，不允许调整大小
        if (this.isFullscreen) return;

        const diff = this.sidebarPosition === 'left' ? 
          e.clientX - startX : // 左侧模式：拖动距离为正时增加宽度
          startX - e.clientX;  // 右侧模式：拖动距离为负时增加宽度
        
        const scale = this.scaleFactor / window.devicePixelRatio;
        const newWidth = Math.min(Math.max(500, startWidth - diff / scale), 1500);
        this.updateWidth(newWidth);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    });


    // 监听来自 iframe 的消息
    window.addEventListener('message', (event) => {
      switch (event.data.type) {
        case 'SIDEBAR_WIDTH_CHANGE':
          this.updateWidth(event.data.width);
          break;

        case 'SCALE_FACTOR_CHANGE':
          this.scaleFactor = event.data.value;
          this.updateScale();
          chrome.storage.sync.set({ scaleFactor: this.scaleFactor });
          break;

        case 'SIDEBAR_POSITION_CHANGE':
          this.updatePosition(event.data.position);
          break;

        case 'CLOSE_SIDEBAR':
          this.toggle(false);  // 明确传入 false 表示关闭
          break;

        case 'TOGGLE_FULLSCREEN_FROM_IFRAME':
          console.log('处理全屏切换消息:', event.data.isFullscreen);
          this.toggleFullscreen();
          break;
        case 'CAPTURE_SCREENSHOT':
          captureAndDropScreenshot();
          break;
        case 'REQUEST_PAGE_INFO':
          console.log('收到请求页面信息消息');
          const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
          if (iframe) {
            iframe.contentWindow.postMessage({
              type: 'URL_CHANGED',
              url: window.location.href,
              title: document.title,
              referrer: document.referrer,
              lastModified: document.lastModified,
              lang: document.documentElement.lang,
              charset: document.characterSet
            }, '*');
            console.log('已发送当前页面信息到侧边栏');
          }
          break;
      }
    });
  }

  // 添加聚焦方法
  focusInput() {
    const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
    if (iframe) {
      iframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, '*');
    }
  }
  /**
   * 切换侧边栏的显示状态
   * @param {boolean|null} forceShow - 明确指定显示(true)或隐藏(false)，或为null时取反当前状态
   */
  toggle(forceShow = null) {
    if (!this.initialized) return;

    try {
      const wasVisible = this.isVisible;

      // 根据 forceShow 参数分别处理
      if (forceShow === null) {
        // 没有指定强制显示/隐藏时，切换当前状态
        this.isVisible = !this.isVisible;
      } else {
        // 明确指定了显示/隐藏状态
        this.isVisible = forceShow;
      }

      // 如果之前和现在都是显示状态，无需操作
      if (wasVisible && this.isVisible && !this.isFullscreen) return;

      console.log(`切换侧边栏: ${wasVisible} -> ${this.isVisible}, 位置: ${this.sidebarPosition}`);

      // 根据当前显示状态更新侧边栏
      if (this.isVisible) {
        // 显示侧边栏前，先将 display 设为 'block'
        this.sidebar.style.display = 'block';
        // 强制重排（读取 offsetWidth ）以确保初始状态被应用
        this.sidebar.offsetWidth;
        this.sidebar.classList.add('visible');

        // 如果当前为全屏模式，则隐藏滚动条
        if (this.isFullscreen) {
          document.documentElement.style.overflow = 'hidden';
        }

        // 如果之前是隐藏状态，则聚焦输入框
        if (!wasVisible) {
          this.focusInput();
        }
      } else {
        // 隐藏侧边栏：先移除 visible 类
        this.sidebar.classList.remove('visible');
        
        // 恢复隐藏时的变换
        setTimeout(() => {
          if (!this.isVisible) {
            this.sidebar.style.transform = `var(--transform-hidden)`;
          }
        }, 50);

        // 如果当前为全屏模式，关闭侧边栏时需要还原滚动条状态
        if (this.isFullscreen) {
          document.documentElement.style.overflow = '';
        }

        // 当侧边栏关闭时，确保不聚焦侧栏内的输入框
        const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
        if (iframe) {
          iframe.contentWindow.postMessage({ type: 'BLUR_INPUT' }, '*');
        }
        // 当动画过渡结束后，再把 display 设置为 none
        this.sidebar.addEventListener('transitionend', (e) => {
          if (!this.sidebar.classList.contains('visible')) {
            this.sidebar.style.display = 'none';
          }
        }, { once: true });
      }
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }

  setupDragAndDrop() {
    console.log('初始化拖放功能');

    // 存储最后一次设置的图片数据
    let lastImageData = null;

    // 检查是否在侧边栏范围内的函数
    const isInSidebarBounds = (x, y) => {
      if (!this.sidebar) return false;
      const sidebarRect = this.sidebar.getBoundingClientRect();
      return (
        x >= sidebarRect.left &&
        x <= sidebarRect.right &&
        y >= sidebarRect.top &&
        y <= sidebarRect.bottom
      );
    };

    // 监听页面上的所有图片
    document.addEventListener('dragstart', (e) => {
      console.log('拖动开始，目标元素:', e.target.tagName);
      const img = e.target;
      if (img.tagName === 'IMG') {
        console.log('检测到图片拖动，图片src:', img.src);
        // 尝试直接获取图片的 src
        try {
          // 对于跨域图片，尝试使用 fetch 获取
          console.log('尝试获取图片数据');
          fetch(img.src)
            .then(response => response.blob())
            .then(blob => {
              console.log('成功获取图片blob数据，大小:', blob.size);
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64Data = reader.result;
                console.log('成功转换为base64数据');
                const imageData = {
                  type: 'image',
                  data: base64Data,
                  name: img.alt || '拖放图片'
                };
                console.log('设置拖动数据:', imageData.name);
                lastImageData = imageData;  // 保存最后一次的图片数据
                e.dataTransfer.setData('text/plain', JSON.stringify(imageData));
                e.dataTransfer.effectAllowed = 'copy';  // 设置拖动效果为复制
              };
              reader.readAsDataURL(blob);
            })
            .catch(error => {
              console.error('获取图片数据失败:', error);
              // 如果 fetch 失败，回退到 canvas 方法
              console.log('尝试使用Canvas方法获取图片数据');
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const base64Data = canvas.toDataURL(img.src.match(/\.png$/i) ? 'image/png' : 'image/jpeg');
                console.log('成功使用Canvas获取图片数据');
                const imageData = {
                  type: 'image',
                  data: base64Data,
                  name: img.alt || '拖放图片'
                };
                console.log('设置拖动数据:', imageData.name);
                lastImageData = imageData;  // 保存最后一次的图片数据
                e.dataTransfer.setData('text/plain', JSON.stringify(imageData));
                e.dataTransfer.effectAllowed = 'copy';  // 设置拖动效果为复制
              } catch (canvasError) {
                console.error('Canvas获取图片数据失败:', canvasError);
              }
            });
        } catch (error) {
          console.error('处理图片拖动失败:', error);
        }
      }
    });

    // 监听拖动结束事件
    document.addEventListener('dragend', (e) => {
      const inSidebar = isInSidebarBounds(e.clientX, e.clientY);
      console.log('拖动结束，是否在侧边栏内:', inSidebar, '坐标:', e.clientX, e.clientY);

      const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
      if (iframe && inSidebar && lastImageData && this.isVisible) {  // 确保侧边栏可见
        console.log('在侧边栏内放下，发送图片数据到iframe');
        iframe.contentWindow.postMessage({
          type: 'DROP_IMAGE',
          imageData: lastImageData
        }, '*');
      }
      // 重置状态
      lastImageData = null;
    });
  }

  updateScale() {
    const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
    if (iframe) {
      const baseScale = 1 / window.devicePixelRatio;
      const scale = baseScale * this.scaleFactor;
      iframe.style.transformOrigin = 'top left';
      iframe.style.zoom = `${scale}`;
      iframe.style.width = `${100}%`;
      iframe.style.height = `${100}%`;
      this.sidebar.style.setProperty('--scale-ratio', scale);
      this.updateWidth(this.sidebarWidth);
    }
  }

  // 添加全屏模式切换方法
  toggleFullscreen(isFullscreen) {
    // 如果isFullscreen为undefined，则根据当前状态切换
    if (isFullscreen === undefined) {
      isFullscreen = !this.isFullscreen;
    }
    console.log('切换全屏模式:', isFullscreen);
    this.isFullscreen = isFullscreen;

    // 在全屏模式下，为了让侧边栏覆盖整个页面并"忽视"父窗口滚动条，
    // 可以强制隐藏父页面的滚动条
    if (this.isFullscreen) {
      // 将侧边栏切换为全屏
      this.sidebar.classList.add('fullscreen');
      
      // 清除位置相关的样式
      this.sidebar.style.left = '';
      this.sidebar.style.right = '';
      
      // 清除变换，确保侧边栏可见
      this.sidebar.style.transform = 'translateX(0)';

      // 隐藏父文档滚动条
      document.documentElement.style.overflow = 'hidden';

      // 如果侧边栏当前不可见，需要先显示侧边栏
      if (!this.isVisible) {
        this.toggle(true);
      }
    } else {
      // 退出全屏模式
      this.sidebar.classList.remove('fullscreen');
      
      // 恢复侧边栏位置
      this.updatePosition(this.sidebarPosition);

      // 恢复父文档滚动条
      document.documentElement.style.overflow = '';

      // 如果侧边栏在全屏时是打开的，此时并不会自动关闭，
      // 只有在用户显式调用 toggle(false) 时才会关闭。
    }

    // 如果是全屏模式，确保侧边栏可见
    if (this.isFullscreen && !this.sidebar.classList.contains('visible')) {
      this.sidebar.classList.add('visible');
      this.isVisible = true;
    }
  }
}

let sidebar;
try {
  sidebar = new CerebrSidebar();
  console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}
// 创建选择器实例
const picker = new ElementPicker({
  highlightColor: 'rgba(255, 0, 0, 0.3)',
  zIndex: 10000
});

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type != 'REQUEST_STARTED' && message.type != 'REQUEST_COMPLETED' &&
    message.type != 'REQUEST_FAILED' && message.type != 'PING') {
    console.log('content.js 收到消息:', message.type);
  }

  // 处理 PING 消息
  if (message.type === 'PING') {
    sendResponse(true);
    return true;
  }

  // 检查侧边栏实例是否存在
  if (!sidebar) {
    console.error('侧边栏实例不存在');
    sendResponse({ success: false, error: 'Sidebar instance not found' });
    return true;
  }

  // 处理获取页面类型请求
  if (message.type === 'GET_DOCUMENT_TYPE') {
    sendResponse({ contentType: document.contentType });
    return true;
  }

  // 处理获取页面内容请求
  if (message.type === 'GET_PAGE_CONTENT_INTERNAL') {
    console.log('收到获取页面内容请求');
    isProcessing = true;

    extractPageContent().then(content => {
      isProcessing = false;
      sendResponse(content);
    }).catch(error => {
      console.error('提取页面内容失败:', error);
      isProcessing = false;
      sendResponse(null);
    });

    return true;
  }

  try {
    // 接收来自background.js的消息
    const iframe = sidebar.sidebar?.querySelector('.cerebr-sidebar__iframe');

    switch (message.type) {
      case 'TOGGLE_SIDEBAR_onClicked':
        sidebar.toggle();  // 不传参数表示切换状态
        break;
      case 'OPEN_SIDEBAR':
        sidebar.toggle(true);  // 明确传入 true 表示打开
        break;
      case 'CLOSE_SIDEBAR':
        sidebar.toggle(false);  // 明确传入 false 表示关闭
        break;
      case 'TOGGLE_FULLSCREEN_FROM_BACKGROUND':
        sidebar.toggleFullscreen();  // 切换全屏状态
        break;
      case 'QUICK_SUMMARY':
        sidebar.toggle(true);  // 明确传入 true 表示打开
        let selectedContent = window.getSelection().toString();
        iframe.contentWindow.postMessage({
            type: 'QUICK_SUMMARY_COMMAND',
            selectedContent: selectedContent
        }, '*');
        break;
      case 'QUICK_SUMMARY_QUERY':
        sidebar.toggle(true);  // 明确传入 true 表示打开
        let selectedContentQuery = window.getSelection().toString();
        iframe.contentWindow.postMessage({
            type: 'QUICK_SUMMARY_COMMAND_QUERY',
            selectedContent: selectedContentQuery
        }, '*');
        break;
      case 'CLEAR_CHAT':
        iframe?.contentWindow?.postMessage({ type: 'CLEAR_CHAT_COMMAND' }, '*');
        break;
      case 'TOGGLE_TEMP_MODE':
        iframe?.contentWindow?.postMessage({ type: 'TOGGLE_TEMP_MODE_FROM_EXTENSION' }, '*');
        break;
      case 'EXPLAIN_IMAGE':
        if (iframe && message.imageData) {
          iframe.contentWindow.postMessage({
            type: 'DROP_IMAGE',
            imageData: message.imageData,
            explain: true
          }, '*');
        }
        break;
      case 'CAPTURE_SCREENSHOT':
        captureAndDropScreenshot();
        break;
    }

    sendResponse({ success: true, status: sidebar.isVisible });
  } catch (error) {
    console.error(`处理${message.type}命令失败:`, error);
    sendResponse({ success: false, error: error.message });
  }
  return true;
});

const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000;

  console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    console.log('Background 响应:', response);
  }).catch(error => {
    console.log('发送消息失败:', error);
    if (retryCount < maxRetries) {
      console.log(`${retryDelay}ms 后重试...`);
      setTimeout(() => sendInitMessage(retryCount + 1), retryDelay);
    } else {
      console.error('达最大重试次数，初始化消息发送失败');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendInitMessage, 500);
  });
} else {
  setTimeout(sendInitMessage, 500);
}

window.addEventListener('error', (event) => {
  console.error('全局错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});

// 网络请求状态管理
class RequestManager {
  constructor() {
    this.pendingRequests = new Set();
    this.isInitialRequestsCompleted = false;
    this.lastRequestCompletedTime = null;
    this.requestCompletionTimer = null;
    this.relayRequestCompletedTime = 300;
  }

  checkRequestsCompletion() {
    const now = Date.now();
    if (this.lastRequestCompletedTime && (now - this.lastRequestCompletedTime) >= this.relayRequestCompletedTime) {
      this.isInitialRequestsCompleted = true;
    }
  }

  resetCompletionTimer() {
    if (this.requestCompletionTimer) {
      clearTimeout(this.requestCompletionTimer);
    }
    this.lastRequestCompletedTime = Date.now();
    this.requestCompletionTimer = setTimeout(() => this.checkRequestsCompletion(), this.relayRequestCompletedTime);
  }

  handleRequestStarted(requestId) {
    this.pendingRequests.add(requestId);
  }

  handleRequestCompleted(requestId, isInitialRequestsCompleted) {
    this.pendingRequests.delete(requestId);
    this.resetCompletionTimer();

    if (isInitialRequestsCompleted) {
      this.isInitialRequestsCompleted = true;
    }
  }

  handleRequestFailed(requestId) {
    this.pendingRequests.delete(requestId);
    this.resetCompletionTimer();
  }

  isRequestsCompleted() {
    return this.lastRequestCompletedTime &&
      (Date.now() - this.lastRequestCompletedTime) >= this.relayRequestCompletedTime;
  }

  getPendingRequestsCount() {
    return this.pendingRequests.size;
  }

  getWaitTimeInSeconds() {
    if (!this.lastRequestCompletedTime) return 0;
    return Math.floor((this.relayRequestCompletedTime - (Date.now() - this.lastRequestCompletedTime)) / 1000);
  }
}

const requestManager = new RequestManager();

// 监听来自 background.js 的网络请求状态更新
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 处理网络请求状态更新
  if (message.type === 'REQUEST_STARTED') {
    requestManager.handleRequestStarted(message.requestId);
  }
  else if (message.type === 'REQUEST_COMPLETED') {
    requestManager.handleRequestCompleted(message.requestId, message.isInitialRequestsCompleted);
  }
  else if (message.type === 'REQUEST_FAILED') {
    requestManager.handleRequestFailed(message.requestId);
    console.log('请求失败，待处理请求数:', requestManager.getPendingRequestsCount());
  }
  return true;
});

// PDF 内容缓存
const pdfContentCache = new Map();

async function waitForContent() {
  return new Promise((resolve) => {
    const checkContent = () => {
      // 检查是否有主要内容元素
      const mainElements = document.querySelectorAll('body, p, h2, article, [role="article"], [role="main"], [data-testid="tweet"]');

      // 检查网络请求是否都已完成
      const requestsCompleted = requestManager.isRequestsCompleted();

      if (mainElements.length > 0 && requestsCompleted) {
        console.log(`页面内容已加载，网络请求已完成（已稳定${requestManager.relayRequestCompletedTime}秒无新请求）`);
        resolve();
      } else {
        const reason = [];
        if (mainElements.length === 0) reason.push('主要内容未找到');
        if (!requestsCompleted) {
          const pendingCount = requestManager.getPendingRequestsCount();
          if (pendingCount > 0) {
            reason.push(`还有 ${pendingCount} 个网络请求未完成`);
          }
          const waitTime = requestManager.getWaitTimeInSeconds();
          if (waitTime > 0) {
            reason.push(`等待请求稳定，剩余 ${waitTime} 秒`);
          } else if (!requestManager.lastRequestCompletedTime) {
            reason.push('等待首个请求完成');
          }
        }
        console.log('等待页面加载...', reason.join(', '));
        setTimeout(checkContent, 1000);
      }
    };

    // 开始检查
    setTimeout(checkContent, 1000);
  });
}

async function extractPageContent() {
  console.log('extractPageContent 开始提取页面内容');

  // 检查是否是PDF或者iframe中的PDF
  if (document.contentType === 'application/pdf' ||
      (window.location.href.includes('.pdf') ||
       document.querySelector('iframe[src*="pdf.js"]') ||
       document.querySelector('iframe[src*=".pdf"]'))) {
    console.log('检测到PDF文件，尝试提取PDF内容');
    
    // 确定PDF URL
    let pdfUrl = window.location.href;
    
    // 如果是iframe中的PDF，尝试提取实际的PDF URL
    const pdfIframe = document.querySelector('iframe[src*="pdf.js"]') || document.querySelector('iframe[src*=".pdf"]');
    if (pdfIframe) {
      const iframeSrc = pdfIframe.src;
      // 尝试从iframe src中提取实际的PDF URL
      const urlMatch = iframeSrc.match(/[?&]file=([^&]+)/);
      if (urlMatch) {
        pdfUrl = decodeURIComponent(urlMatch[1]);
        console.log('从iframe中提取到PDF URL:', pdfUrl);
      }
    }

    // 检查缓存
    if (pdfContentCache.has(pdfUrl)) {
      console.log('从缓存中获取PDF内容');
      const cachedContent = pdfContentCache.get(pdfUrl);
      return {
        title: document.title,
        url: pdfUrl,
        content: cachedContent
      };
    }

    console.log('缓存中没有找到PDF内容，开始提取');
    const pdfText = await extractTextFromPDF(pdfUrl);
    if (pdfText) {
      // 将内容存入缓存
      console.log('将PDF内容存入缓存');
      pdfContentCache.set(pdfUrl, pdfText);
      return {
        title: document.title,
        url: pdfUrl,
        content: pdfText
      };
    }
  }

  // 等待内容加载和网络请求完成
  await waitForContent();

  // 创建一个文档片段来处理内容
  const tempContainer = document.createElement('div');
  tempContainer.innerHTML = document.body.innerHTML;

  // 移除不需要的元素
  const selectorsToRemove = [
    'script', 'style', 'nav', 'header', 'footer',
    'iframe', 'noscript', 'img', 'svg', 'video',
    '[role="complementary"]', '[role="navigation"]',
    '.sidebar', '.nav', '.footer', '.header',
    '.immersive-translate-target-inner',
  ];

  // 使用DocumentFragment优化DOM操作，一次性移除所有不需要的元素
  const fragment = document.createDocumentFragment();
  fragment.appendChild(tempContainer);
  const elementsToRemove = fragment.querySelectorAll(selectorsToRemove.join(','));
  elementsToRemove.forEach(element => element.remove());

  // 使用TreeWalker替代手动遍历，性能更好
  const texts = [];
  const treeWalker = document.createTreeWalker(
    fragment,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );

  // 预分配合理大小的数组以避免扩容
  const estimatedTextNodes = Math.min(tempContainer.getElementsByTagName('*').length * 2, 10000);
  texts.length = estimatedTextNodes;
  
  let i = 0;
  while (treeWalker.nextNode()) {
    texts[i++] = treeWalker.currentNode.textContent.trim();
  }
  texts.length = i; // 截断到实际长度

  // 改进文本处理逻辑
  let mainContent = texts
    // .filter(text => text.length > 0)  // 过滤掉空字符串
    .join(' ')
    // .replace(/[\u200B-\u200D\uFEFF]/g, '')  // 移除零宽字符
    // .replace(/\s*​\s*/g, ' ')  // 处理特殊的空格字符
    .replace(/\s+/g, ' ')  // 将多个空白字符替换为单个空格
    // .trim();

  // 检查提取的内容是否足够
  if (mainContent.length < 40) {
    console.log('提取的内容太少，返回 null');
    return null;
  }

  console.log('=== 处理后的 mainContent ===');
  console.log(mainContent);
  console.log('=== mainContent 长度 ===', mainContent.length);

  // console.log('页面内容提取完成，内容:', mainContent);
  // console.log('页面内容提取完成，内容长度:', mainContent.length);

  return {
    title: document.title,
    url: window.location.href,
    content: mainContent
  };
}

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

async function extractTextFromPDF(url) {
  try {
    // 使用已存在的 sidebar 实例
    if (!sidebar || !sidebar.sidebar) {
      console.error('侧边栏实例不存在');
      return null;
    }

    // 获取iframe
    const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
    if (!iframe) {
      console.error('找不到iframe元素');
      return null;
    }

    // 发送更新placeholder消息
    const sendPlaceholderUpdate = (message, timeout = 0) => {
      console.log('发送placeholder更新:', message);
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: message,
        timeout: timeout
      }, '*');
    };

    sendPlaceholderUpdate('正在下载PDF文件...');

    console.log('开始下载PDF:', url);
    // 首先获取PDF文件的初始信息
    const initResponse = await chrome.runtime.sendMessage({
      action: 'downloadPDF',
      url: url
    });

    if (!initResponse.success) {
      console.error('PDF初始化失败，响应:', initResponse);
      sendPlaceholderUpdate('PDF下载失败', 2000);
      throw new Error('PDF初始化失败');
    }

    const { totalChunks, totalSize } = initResponse;
    console.log(`PDF文件大小: ${totalSize} bytes, 总块数: ${totalChunks}`);

    // 分块接收数据
    const chunks = new Array(totalChunks);
    for (let i = 0; i < totalChunks; i++) {
      sendPlaceholderUpdate(`正在下载PDF文件 (${Math.round((i + 1) / totalChunks * 100)}%)...`);

      const chunkResponse = await chrome.runtime.sendMessage({
        action: 'getPDFChunk',
        url: url,
        chunkIndex: i
      });

      if (!chunkResponse.success) {
        sendPlaceholderUpdate('PDF下载失败', 2000);
        throw new Error(`获取PDF块 ${i} 失败`);
      }

      chunks[i] = new Uint8Array(chunkResponse.data);
    }

    // 合并所有块
    const completeData = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      completeData.set(chunk, offset);
      offset += chunk.length;
    }

    sendPlaceholderUpdate('正在解析PDF文件...');

    console.log('开始解析PDF文件');
    const loadingTask = pdfjsLib.getDocument({ data: completeData });
    const pdf = await loadingTask.promise;
    console.log('PDF加载成功，总页数:', pdf.numPages);

    let fullText = '';
    // 遍历所有页面
    for (let i = 1; i <= pdf.numPages; i++) {
      sendPlaceholderUpdate(`正在提取文本 (${i}/${pdf.numPages})...`);
      console.log(`开始处理第 ${i}/${pdf.numPages} 页`);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
      fullText += pageText + '\n';
    }

    console.log('PDF文本提取完成，总文本长度:', fullText.length);
    sendPlaceholderUpdate('PDF处理完成', 2000);
    return fullText;
  } catch (error) {
    console.error('PDF处理过程中出错:', error);
    console.error('错误堆栈:', error.stack);
    if (sidebar && sidebar.sidebar) {
      const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_PLACEHOLDER',
          placeholder: 'PDF处理失败',
          timeout: 2000
        }, '*');
      }
    }
    return null;
  }
}

// --- 修改截图功能，使用 captureVisibleTab 截取屏幕开始 ---
/**
 * 捕获当前可见标签页的屏幕截图并发送到侧边栏。
 * 截图前会先隐藏侧边栏，并在等待两帧后再进行截图，最后恢复侧边栏显示。
 */
function captureAndDropScreenshot() {
  const sidebarVisibility = sidebar.sidebar.style.visibility; // 保存侧边栏原始可见状态
  sidebar.sidebar.style.transition = 'none'; // 设置侧边栏无过渡效果
  sidebar.sidebar.style.visibility = 'hidden'; // 立即隐藏侧边栏

  /**
   * 递归地执行 requestAnimationFrame，并在指定次数后执行截屏操作。
   * @param {number} waitFramesCount 递归层级，控制等待的帧数。
   */
  function waitCaptureWithAnimationFrame(waitFramesCount) {
    requestAnimationFrame(() => {
      if (waitFramesCount > 0) {
        // 递归调用，减少递归层级
        waitCaptureWithAnimationFrame(waitFramesCount - 1);
      } else {
        // 达到指定递归层级后，执行截屏操作
        chrome.runtime.sendMessage({ action: 'capture_visible_tab' }, (response) => {
          sidebar.sidebar.style.visibility = sidebarVisibility; // 截图完成后恢复侧边栏显示
          sidebar.sidebar.style.transition = '';
          const iframe = sidebar.sidebar?.querySelector('.cerebr-sidebar__iframe');
          if (response && response.success && response.dataURL) {
            console.log('页面截图完成，发送到侧边栏');
            if (iframe) {
              iframe.contentWindow.postMessage({
                type: 'DROP_IMAGE',
                imageData: { data: response.dataURL, name: 'page-screenshot.png' },
              }, '*');
            }
          } else {
            console.error('屏幕截图失败:', response && response.error);
          }
        });
      }
    });
  }

  waitCaptureWithAnimationFrame(5); // 初始调用，设置递归层级为 5，实现等待五帧的效果
}
// --- 修改截图功能，使用 captureVisibleTab 截取屏幕结束 ---