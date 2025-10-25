console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

// 全局变量，用于存储当前选中的文本
let currentSelection = "";
// 存储已附加监听器的 iframe 窗口，防止重复操作
const monitoredFrames = new WeakSet();

/**
 * 统一的选区变化处理函数
 * 当任何地方的选区发生变化时被调用
 */
function handleGlobalSelectionChange() {
    setTimeout(() => {
        let activeSelectionText = "";
        let activeSelectionSource = "main"; // 默认来源是主窗口

        // 1. 遍历页面上所有 iframe，检查它们的选区
        document.querySelectorAll('iframe').forEach(iframe => {
            // 精准排除您自己的侧边栏 iframe
            if (iframe.classList.contains('cerebr-sidebar__iframe')) {
                return; // 跳过
            }

            try {
                const iframeWindow = iframe.contentWindow;
                if (iframeWindow) {
                    const iframeSelection = iframeWindow.getSelection();
                    if (iframeSelection && !iframeSelection.isCollapsed) {
                        const text = iframeSelection.toString().trim();
                        if (text) {
                            activeSelectionText = text;
                            activeSelectionSource = iframe.src || "iframe"; // 记录来源
                        }
                    }
                }
            } catch (e) {
                // 忽略跨域等错误
            }
        });

        // 2. 如果所有 iframe 内都没有选区，再检查主窗口的选区
        if (!activeSelectionText) {
            try {
                const mainSelection = window.getSelection();
                if (mainSelection && !mainSelection.isCollapsed) {
                    activeSelectionText = mainSelection.toString().trim();
                    activeSelectionSource = "main";
                }
            } catch (e) {
                // 忽略错误
            }
        }
        
        // 3. 只有在文本内容确实发生变化时才更新状态并打印日志
        if (activeSelectionText !== currentSelection) {
            currentSelection = activeSelectionText;
            // console.log(`[Cerebr Selection] Updated from "${activeSelectionSource}":`, `"${currentSelection}"`);
            
            // 在这里可以触发您插件的其他逻辑，例如：
            // if (currentSelection) {
            //   showMyPopup(currentSelection);
            // } else {
            //   hideMyPopup();
            // }
        }
    }, 0);
}

/**
 * 扫描并为新出现的 iframe 附加监听器
 */
function monitorNewFrames() {
  document.querySelectorAll('iframe').forEach(iframe => {
      // 排除您自己的侧边栏 iframe
      if (iframe.classList.contains('cerebr-sidebar__iframe')) {
          return;
      }

      try {
          const iframeWindow = iframe.contentWindow;
          // 确保 iframe 可访问且尚未被监控
          if (iframeWindow && !monitoredFrames.has(iframeWindow)) {
              console.log('[Cerebr Selection] New generic iframe found, attaching listener to:', iframe.src || 'inline frame');
              monitoredFrames.add(iframeWindow);
              // 为 iframe 内部的 document 附加监听器
              iframeWindow.document.addEventListener('selectionchange', handleGlobalSelectionChange);
          }
      } catch (e) {
          // 忽略因跨域策略而无法访问的 iframe
      }
  });
}

class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 800;  // 默认值改为800px
    this.scaleFactor = 1.0;
    this.initialized = false;
    this.lastUrl = window.location.href;
    this.isFullscreen = false;
    this.sidebarPosition = 'right'; // 默认侧边栏位置为右侧
    // console.log('CerebrSidebar 实例创建');
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
      style.left = `calc(10px * var(--scale-ratio, 1))`;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(-100% - calc(10px * var(--scale-ratio, 1))))`);
      this.sidebar.style.setProperty('--box-shadow-visible', `2px 0 15px rgba(0,0,0,0.1)`);
    } else {
      style.right = `calc(10px * var(--scale-ratio, 1))`;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(100% + calc(10px * var(--scale-ratio, 1))))`);
      this.sidebar.style.setProperty('--box-shadow-visible', `-2px 0 15px rgba(0,0,0,0.1)`);
    }
    
    // 如果侧边栏没有显示，立即应用隐藏的变换
    if (!this.isVisible) {
      this.sidebar.style.transform = `var(--transform-hidden)`;
    }

    chrome.storage.sync.set({ sidebarPosition: this.sidebarPosition });
    
    // console.log(`侧边栏位置已更新为: ${position}, 可见状态: ${this.isVisible}`);
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
        const iframe = sidebar.sidebar?.querySelector('.cerebr-sidebar__iframe');
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
      // console.log('开始初始化侧边栏');

      // 从存储中加载宽度、缩放因子和位置
      const result = await chrome.storage.sync.get(['sidebarWidth', 'scaleFactor', 'sidebarPosition']);
      this.sidebarWidth = result.sidebarWidth || 800; // 确保默认值一致
      this.scaleFactor = result.scaleFactor || 1.0;
      this.sidebarPosition = result.sidebarPosition || 'right';
      
      // console.log(`初始化侧边栏: 宽度=${this.sidebarWidth}, 缩放=${this.scaleFactor}, 位置=${this.sidebarPosition}`);

      const container = document.createElement('cerebr-root');
      container.style.display = 'contents'; // 让容器内元素透出

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
          top: calc(10px * var(--scale-ratio, 1));
          width: calc(${this.sidebarWidth}px * var(--scale-ratio, 1) / ${this.scaleFactor});
          height: calc(100vh - calc(20px * var(--scale-ratio, 1)));
          color: var(--cerebr-text-color, #000000);
          z-index: 2147483647;
          border-radius: calc(12px * var(--scale-ratio, 1));
          overflow: hidden;
          visibility: hidden;
          opacity: 0;
          transform: var(--transform-hidden);
          pointer-events: none;
          isolation: isolate;
          /* border: 1px solid rgba(255, 255, 255, 0.1); */
          contain: layout style;
          /* Delay visibility toggle so content stays rendered throughout the slide animation */
          transition: transform 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease, visibility 0s linear 0.3s;
        }
        .cerebr-sidebar.visible {
          pointer-events: auto;
          visibility: visible;
          opacity: 1;
          transform: translateX(0) !important;
          box-shadow: var(--box-shadow-visible);
          transition: transform 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease, visibility 0s linear 0s;
        }

        .cerebr-sidebar.capturing {
          opacity: 0 !important;
          visibility: visible;
        }

        .cerebr-sidebar.visible.capturing {
          opacity: 0 !important;
          pointer-events: none !important;
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
          /* 避免在深色宿主页面被强制套白底（Chrome 的“可读性”行为） */
          color-scheme: auto;
          z-index: 1;
          opacity: 1;
          transition: opacity 140ms ease;
          pointer-events: auto;
        }

        .cerebr-sidebar.capturing .cerebr-sidebar__iframe {
          opacity: 0;
          pointer-events: none;
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
      let restoreTimeoutId = null;

      const scheduleRestore = () => {
        if (restoreTimeoutId) return;

        restoreTimeoutId = setTimeout(() => {
          restoreTimeoutId = null;

          if (!root.contains(container)) {
            console.log('检测到侧边栏被移除，正在恢复...');
            root.appendChild(container);
          }
        }, 500);
      };

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const removedNodes = Array.from(mutation.removedNodes);
            if (removedNodes.includes(container)) {
              scheduleRestore();
            }
          }
        }
      });

      observer.observe(root, {
        childList: true
      });

      // console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        // console.log('侧边栏初始化完成');
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
        const newWidth = Math.min(Math.max(500, startWidth - diff / scale), 2000);
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
          // console.log('收到请求页面信息消息');
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
            // console.log('已发送当前页面信息到侧边栏');
          }
          break;
        case 'REQUEST_COMPUTER_USE_SNAPSHOT':
          (async () => {
            const iframeEl = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
            if (!iframeEl) return;
            try {
              const dataUrl = await captureScreenshotForComputerUse();
              iframeEl.contentWindow.postMessage({
                type: 'COMPUTER_USE_SNAPSHOT_RESULT',
                requestId: event.data.requestId,
                success: true,
                dataURL: dataUrl
              }, '*');
            } catch (error) {
              iframeEl.contentWindow.postMessage({
                type: 'COMPUTER_USE_SNAPSHOT_RESULT',
                requestId: event.data.requestId,
                success: false,
                error: error.message || '截图失败'
              }, '*');
            }
          })();
          break;
        case 'PERFORM_COMPUTER_USE_ACTION':
          (async () => {
            const iframeEl = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
            if (!iframeEl) return;
            try {
              const result = await performComputerUseAction(event.data.action);
              iframeEl.contentWindow.postMessage({
                type: 'COMPUTER_USE_ACTION_RESULT',
                requestId: event.data.requestId,
                ...result,
              }, '*');
            } catch (error) {
              console.error('执行电脑操作动作失败:', error);
              iframeEl.contentWindow.postMessage({
                type: 'COMPUTER_USE_ACTION_RESULT',
                requestId: event.data.requestId,
                success: false,
                error: error?.message || '执行电脑操作动作失败',
              }, '*');
            }
          })();
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

      // console.log(`切换侧边栏: ${wasVisible} -> ${this.isVisible}, 位置: ${this.sidebarPosition}`);

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
    // console.log('初始化拖放功能');

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
      
      // 通知iframe进入全屏模式
      this.notifyIframeFullscreenState(true);
    } else {
      // 退出全屏模式
      this.sidebar.classList.remove('fullscreen');
      
      // 恢复侧边栏位置
      this.updatePosition(this.sidebarPosition);

      // 恢复父文档滚动条
      document.documentElement.style.overflow = '';

      // 如果侧边栏在全屏时是打开的，此时并不会自动关闭，
      // 只有在用户显式调用 toggle(false) 时才会关闭。
      
      // 通知iframe退出全屏模式
      this.notifyIframeFullscreenState(false);
    }

    // 如果是全屏模式，确保侧边栏可见
    if (this.isFullscreen && !this.sidebar.classList.contains('visible')) {
      this.sidebar.classList.add('visible');
      this.isVisible = true;
    }
  }
  
  // 通知iframe全屏状态变化
  notifyIframeFullscreenState(isFullscreen) {
    const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');
    if (iframe && iframe.contentWindow) {
      try {
        iframe.contentWindow.postMessage({
          type: 'FULLSCREEN_STATE_CHANGED',
          isFullscreen: isFullscreen
        }, '*');
      } catch (error) {
        console.log('通知iframe全屏状态失败:', error);
      }
    }
  }
}

let sidebar;
try {
  sidebar = new CerebrSidebar();
  // console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}
// 创建选择器实例
const picker = new ElementPicker({
  highlightColor: 'rgba(255, 0, 0, 0.3)',
  zIndex: 10000
});

let _iframe = null;
let iframe = (_iframe || (_iframe = sidebar.sidebar?.querySelector('.cerebr-sidebar__iframe')));

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type != 'PING') {
    // console.log('content.js 收到消息:', message.type);
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
        let selectedContent = currentSelection;
        iframe.contentWindow.postMessage({
            type: 'QUICK_SUMMARY_COMMAND',
            selectedContent: selectedContent
        }, '*');
        break;
      case 'QUICK_SUMMARY_QUERY':
        sidebar.toggle(true);  // 明确传入 true 表示打开
        let selectedContentQuery = currentSelection;
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
      case 'ADD_PAGE_CONTENT_TO_CONTEXT':
        try {
          // 确保侧边栏已打开
          sidebar.toggle(true);

          // 显示占位提示
          try { sendPlaceholderUpdate('正在获取网页内容...'); } catch (_) {}

          // 复用现有提取函数
          extractPageContent()
            .then(content => {
              if (!content || !content.title || !content.url || !content.content) return;

              const composed = `已附加网页内容：\n标题：${content.title}\nURL：${content.url}\n内容：${content.content}`;

              const iframe = sidebar.sidebar?.querySelector('.cerebr-sidebar__iframe');
              if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({
                  type: 'ADD_TEXT_TO_CONTEXT',
                  text: composed
                }, '*');
              }

              // 恢复占位
              try { sendPlaceholderUpdate('已添加网页内容到历史（未发送）', 2000); } catch (_) {}
            })
            .catch(err => {
              console.error('通过快捷键添加网页内容失败:', err);
              try { sendPlaceholderUpdate('提取网页内容失败', 2000); } catch (_) {}
            });
        } catch (e) {
          console.error('处理 ADD_PAGE_CONTENT_TO_CONTEXT 失败:', e);
        }
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

  // console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    // console.log('Background 响应:', response);
  }).catch(error => {
    console.log('发送消息失败:', error);
    if (retryCount < maxRetries) {
      // console.log(`${retryDelay}ms 后重试...`);
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

// ========================================================================
//  启动选区监听 (添加到 content.js 文件末尾)
// ========================================================================

function startSelectionMonitoring() {
  // 1. 为顶层主窗口附加监听器
  console.log('[Cerebr Selection] Attaching listener to the main window.');
  document.addEventListener('selectionchange', handleGlobalSelectionChange);

  // 2. 启动一个定时器，持续扫描新出现的 iframe
  console.log('[Cerebr Selection] Starting generic iframe scanner...');
  setInterval(monitorNewFrames, 1500); // 每 1.5 秒扫描一次
}

// 确保在所有初始化逻辑后启动监听
startSelectionMonitoring();

// window.addEventListener('error', (event) => {
//   console.error('全局错误:', event.error);
// });

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});

// PDF 内容缓存
const pdfContentCache = new Map();

/**
 * 提取重要的DOM结构（移除不需要的元素），仅保留对内容有意义的部分
 * @returns {string} 清理后的DOM结构的outerHTML
 */
function extractImportantDOM() {
  const clone = document.body.cloneNode(true);
  const selectorsToRemove = [
    'script', 'style', 'nav', 'header', 'footer',
    'iframe', 'noscript', 'video',
    '[role="complementary"]', '[role="navigation"]',
    '.sidebar', '.nav', '.footer', '.header',
    '.immersive-translate-target-inner', 'img', 'svg'
  ];
  selectorsToRemove.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });
  
  // 遍历所有元素，清理每个节点的属性，仅保留允许的属性（例如只保留 id、class、href、title、placeholder、alt）
  const allowedAttributes = new Set(['id', 'class', 'href', 'title', 'placeholder', 'alt']);
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i];
      if (!allowedAttributes.has(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  // 添加：删除所有注释节点（这些注释会被序列化为转义字符如 \x3C!--css-build:shady--> ）
  const commentWalker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT, null, false);
  let commentNode;
  while (commentNode = commentWalker.nextNode()) {
    commentNode.parentNode.removeChild(commentNode);
  }

  return clone.outerHTML;
}

async function extractPageContent() {
  console.log('extractPageContent 开始提取页面内容');

  // 检查是否是PDF或者iframe中的PDF
  if (document.contentType === 'application/pdf' ||
      (window.location.href.includes('.pdf') ||
       document.querySelector('iframe[src*="pdf.js"]') ||
       document.querySelector('iframe[src*=".pdf"]'))) {
    console.log('检测到PDF文件，尝试提取PDF内容');
    
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
      // 验证缓存内容是否有效
      if (cachedContent && typeof cachedContent.url === 'string' && typeof cachedContent.title === 'string' && typeof cachedContent.content === 'string') {
        return cachedContent;
      } else {
        console.warn('缓存的PDF内容无效，移除缓存并重新提取', cachedContent);
        pdfContentCache.delete(pdfUrl); // 移除无效条目
        // 继续执行提取逻辑
      }
    }

    console.log('缓存中没有找到PDF内容或缓存无效，开始提取');
    const pdfResult = await extractTextFromPDF(pdfUrl); // pdfResult 是 { fullText, chapters } 或 null
    if (pdfResult && typeof pdfResult.fullText === 'string') {
      console.log('将PDF内容存入缓存');
      const resultToCache = {
        title: document.title || pdfUrl, // 为标题提供备用值
        url: pdfUrl,
        content: pdfResult.fullText, // 已知为字符串
        chapters: pdfResult.chapters || [], // 为章节提供备用值
        isPDF: true
      };
      pdfContentCache.set(pdfUrl, resultToCache);
      return resultToCache;
    } else {
      console.error(`extractTextFromPDF 对 ${pdfUrl} 返回 null 或无效结果。`);
      // 明确返回 null 以指示提取失败
      return null; 
    }
  }

  // 执行HTML页面内容提取逻辑
  console.log('非PDF，执行HTML页面内容提取逻辑（包含Shadow DOM支持）');


  const texts = [];
  // 选择器，用于跳过不应提取文本的元素
  // 标签名选择器（小写）
  const tagSelectorsToSkip = [
    'script', 'style', 'noscript', 'canvas', 'video', 'audio', 'embed', 'object',
    'img', 'svg', 'map', 'area', 'track', 'applet',
    'nav', 'footer', 'header', 'aside', // 常见的非主要内容区域
    'iframe', // iframe 由后续的专用逻辑处理
    'cerebr-root' // 跳过扩展自身的UI根元素
  ];
  // CSS选择器 (用于 element.matches)
  const cssSelectorsToSkip = [
    '[role="complementary"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
    '[aria-hidden="true"]', // 跳过明确标记为隐藏的元素
    // '.sidebar', '.nav', '.menu', '.toc', '.pagination', '.breadcrumb', '.toolbar', '.status-bar',
    '.footer', '.header', // 常见的类名
    '.ad', '.ads', '.advertisement', '[class*="advert"]', '[id*="advert"]', // 广告
    // '.popup', '.modal', '.dialog', '[role="dialog"]', '[role="alertdialog"]', // 弹窗和对话框
    '.immersive-translate-target-inner', // 项目特定的类
    '[data-nosnippet]' // Google no-snippet attribute
  ];

  function shouldSkipElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagSelectorsToSkip.includes(tagName)) {
      return true;
    }
    try {
      if (cssSelectorsToSkip.some(selector => element.matches(selector))) {
        return true;
      }
    } catch (e) {
      // console.warn('Error matching selector for skip:', element.tagName, e.message);
    }
    // 检查计算样式是否为 display: none
    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
        // console.log('Skipping non-visible element:', element.tagName, element.id, element.className);
        return true;
    }
    return false;
  }

  function extractTextRecursively(node) {
    if (shouldSkipElement(node)) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const trimmedText = node.textContent.trim();
      if (trimmedText) {
        texts.push(trimmedText);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      // 优先处理 Light DOM 子节点
      for (const child of node.childNodes) {
        extractTextRecursively(child);
      }
      // 然后处理 Shadow DOM (仅对 Element 节点)
      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot && node.shadowRoot.mode === 'open') {
        // console.log('Extracting from open shadowRoot of:', node.tagName);
        for (const shadowChild of node.shadowRoot.childNodes) {
          extractTextRecursively(shadowChild);
        }
      }
    }
  }

  // 从 document.body 开始递归提取文本
  extractTextRecursively(document.body);

  let mainContent = texts.join(' ').replace(/\s+/g, ' ').trim();

  // 新增：提取 iframe 内容 (此部分逻辑基本不变，但主内容提取已包含 Shadow DOM)
  let iframeContent = '';
  const iframes = document.querySelectorAll('iframe');
  console.log('页面中的iframe数量:', iframes.length);
  for (const iframe of iframes) {
    // 跳过Cerebr侧边栏的iframe
    if (iframe.classList.contains('cerebr-sidebar__iframe')) {
        console.log('跳过Cerebr侧边栏的iframe:', iframe.id || iframe.className);
        continue;
    }
    console.log('尝试处理iframe:', iframe.id || iframe.src);
    try {
      // 检查iframe是否可访问
      if (iframe.contentDocument || iframe.contentWindow) {
        const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
        // 确保iframe body存在
        if (iframeDocument && iframeDocument.body) {
          const iframeBodyStyle = iframe.contentWindow.getComputedStyle(iframeDocument.body);
          if (iframeBodyStyle.display === 'none' || iframeBodyStyle.visibility === 'hidden') {
            console.log('跳过隐藏或不可见的iframe body:', iframe.id || iframe.src);
            continue;
          }
          const content = iframeDocument.body.innerText;
          if (content && content.trim()) {
            console.log('成功从iframe中提取内容 (前100字符):', content.substring(0,100) + "...");
            iframeContent += content.trim() + '\n\n'; // 添加换行符分隔不同iframe的内容
          } else {
            console.log('iframe内容为空:', iframe.id || iframe.src);
          }
        } else {
          console.log('无法访问iframe的body:', iframe.id || iframe.src);
        }
      } else {
         console.log('无法访问iframe的document或window对象:', iframe.id || iframe.src);
      }
    } catch (e) {
      console.warn('无法访问该iframe内容 (可能是跨域):', iframe.id || iframe.src, e.message);
    }
  }

  if (iframeContent) {
    mainContent += '\n\n--- iFrame Content ---\n\n' + iframeContent.trim();
  }
  
  const result = {
    title: document.title || window.location.href, // 为标题提供备用值
    url: window.location.href,
    content: mainContent,
    selectedText: currentSelection
  };
  
  // console.log('最终提取的内容 (前200字符):', result.content.substring(0,200));
  return result;
}


function sendPlaceholderUpdate(message, timeout = 0) {
  console.log('发送placeholder更新:', message);
  if (iframe) {
    iframe.contentWindow.postMessage({
      type: 'UPDATE_PLACEHOLDER',
      placeholder: message,
      timeout: timeout
    }, '*');
  }
};

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

async function downloadPDFData(url) {
  console.log('开始下载PDF:', url);
  // 获取PDF文件的初始信息
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

  return completeData;
}

async function parsePDFData(completeData) {
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

  return fullText;
}

async function extractTextFromPDF(url) {
  try {
    // 下载PDF文件
    sendPlaceholderUpdate('正在下载PDF文件...');
    const completeData = await downloadPDFData(url);
    console.log('PDF下载完成');

    // 克隆 PDF 数据，避免后续调用因 ArrayBuffer 被转移而失败
    const dataForText = new Uint8Array(completeData.buffer.slice(0));
    const dataForChapters = new Uint8Array(completeData.buffer.slice(0));

    // 解析PDF文本
    sendPlaceholderUpdate('正在解析PDF文件...');
    const fullText = await parsePDFData(dataForText);

    // 解析PDF章节
    const chapters = await extractChaptersFromPDFData(dataForChapters);

    console.log('PDF文本提取完成，总文本长度:', fullText.length);
    sendPlaceholderUpdate('PDF处理完成', 2000);
    return { fullText, chapters };
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

// 新增：从PDF数据解析章节内容的辅助函数
async function extractChaptersFromPDFData(completeData) {
  console.log('开始解析PDF章节内容');
  const fullPageTexts = await parsePDFToPageTexts(completeData);
  console.log('成功提取每页文本, 页数:', fullPageTexts.length);
  
  // 克隆数据用于获取目录(书签)，不影响后续使用
  const freshDataForOutline = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshDataForOutline });
  const pdf = await loadingTask.promise;
  
  // 获取目录书签
  let outline = await pdf.getOutline();
  if (!outline) {
    console.log('未检测到书签，使用默认章节');
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);
  const chapters = splitPdfTextByChapters(fullPageTexts, processedOutline);
  console.log('切分后的章节数据:', chapters);
  return chapters;
}

// ====================== 网页截图功能 ======================

const SIDEBAR_CAPTURE_FADE_MS = 140;
const SIDEBAR_CAPTURE_WAIT_MS = SIDEBAR_CAPTURE_FADE_MS + 120;

/**
 * 捕获当前可见标签页的屏幕截图并发送到侧边栏。
 * 截图前会先隐藏侧边栏，并在等待两帧后再进行截图，最后恢复侧边栏显示。
 */
function withSidebarHidden(task) {
  const sidebarElement = sidebar?.sidebar;
  const original = sidebarElement
    ? {
        pointerEvents: sidebarElement.style.pointerEvents
      }
    : null;

  if (sidebarElement) {
    sidebarElement.classList.add('capturing');
    sidebarElement.style.pointerEvents = 'none';
  }

  const restore = () => {
    if (sidebarElement && original) {
      sidebarElement.classList.remove('capturing');
      sidebarElement.style.pointerEvents = original.pointerEvents || '';
    }
  };

  try {
    const result = task();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function waitForSidebarFadeOut() {
  return new Promise((resolve) => {
    const sidebarElement = sidebar?.sidebar;
    if (!sidebarElement) {
      resolve();
      return;
    }
    let resolved = false;
    const maxWait = SIDEBAR_CAPTURE_WAIT_MS;
    const start = performance.now();

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const inspect = () => {
      if (resolved) return;
      const styles = window.getComputedStyle(sidebarElement);
      const opacity = Number.parseFloat(styles.opacity || '0');
      if (opacity <= 0.02 || styles.visibility === 'hidden') {
        finalize();
        return;
      }
      if (performance.now() - start >= maxWait) {
        finalize();
        return;
      }
      requestAnimationFrame(inspect);
    };

    requestAnimationFrame(inspect);
    setTimeout(finalize, maxWait + 80);
  });
}

function captureAndDropScreenshot() {
  return withSidebarHidden(() => new Promise((resolve) => {
    function waitCaptureWithAnimationFrame(waitFramesCount) {
      requestAnimationFrame(() => {
        if (waitFramesCount > 0) {
          waitCaptureWithAnimationFrame(waitFramesCount - 1);
        } else {
          chrome.runtime.sendMessage({ action: 'capture_visible_tab' }, (response) => {
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
            resolve();
          });
        }
      });
    }

    waitForSidebarFadeOut().then(() => {
      waitCaptureWithAnimationFrame(5);
    });
  }));
}

/**
 * 捕获页面截图供 Computer Use 调用
 * @returns {Promise<string>} dataURL
 */
function captureScreenshotForComputerUse() {
  return withSidebarHidden(() => new Promise((resolve, reject) => {
    try {
      waitForSidebarFadeOut().then(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            chrome.runtime.sendMessage({ action: 'capture_visible_tab' }, (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (response?.success && response.dataURL) {
                resolve(response.dataURL);
              } else {
                reject(new Error(response?.error || '截图失败'));
              }
            });
          });
        });
      });
    } catch (error) {
      reject(error);
    }
  }));
}

function buildCssSelector(element) {
  if (!element || !(element instanceof Element)) return '';
  const path = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    }
    if (current.classList.length > 0) {
      selector += '.' + Array.from(current.classList).join('.');
    }
    let index = 1;
    let sibling = current;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === current.tagName) index += 1;
    }
    if (index > 1) {
      selector += `:nth-of-type(${index})`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

function flashClickOverlay(clientX, clientY) {
  try {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = 2147483647;
    overlay.style.width = '32px';
    overlay.style.height = '32px';
    overlay.style.border = '2px solid #0d99ff';
    overlay.style.borderRadius = '50%';
    overlay.style.boxShadow = '0 0 12px rgba(13, 153, 255, 0.6)';
    overlay.style.background = 'rgba(13, 153, 255, 0.15)';
    overlay.style.transform = 'translate(-50%, -50%) scale(1)';
    overlay.style.opacity = '1';
    overlay.style.transition = 'all 0.4s ease-out';
    overlay.style.left = `${clientX}px`;
    overlay.style.top = `${clientY}px`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.style.opacity = '0';
      overlay.style.transform = 'translate(-50%, -50%) scale(1.4)';
    });
    setTimeout(() => overlay.remove(), 450);
  } catch (error) {
    console.warn('绘制点击高亮失败:', error);
  }
}

function getViewportPoint(normalizedX, normalizedY) {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (!viewportWidth || !viewportHeight) {
    return null;
  }
  const clientX = (Number(normalizedX) / 1000) * viewportWidth;
  const clientY = (Number(normalizedY) / 1000) * viewportHeight;
  return { clientX, clientY };
}

function performNormalizedClick(normalizedX, normalizedY) {
  return withSidebarHidden(() => {
    const point = getViewportPoint(normalizedX, normalizedY);
    if (!point) {
      return { success: false, error: '无法获取视口尺寸' };
    }
    const { clientX, clientY } = point;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) {
      return { success: false, error: '未找到可点击元素' };
    }
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window,
      button: 0
    };
    try {
      target.dispatchEvent(new MouseEvent('mousemove', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));
      flashClickOverlay(clientX, clientY);
      return { success: true, selector: buildCssSelector(target) };
    } catch (error) {
      console.error('执行归一化点击失败:', error);
      return { success: false, error: error.message || '执行点击失败' };
    }
  });
}

function performHoverAt(normalizedX, normalizedY) {
  return withSidebarHidden(() => {
    const point = getViewportPoint(normalizedX, normalizedY);
    if (!point) {
      return { success: false, error: '无法获取视口尺寸' };
    }
    const { clientX, clientY } = point;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) {
      return { success: false, error: '未找到目标元素' };
    }
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window
    };
    try {
      target.dispatchEvent(new MouseEvent('mousemove', eventInit));
      target.dispatchEvent(new MouseEvent('mouseover', eventInit));
      target.dispatchEvent(new MouseEvent('mouseenter', eventInit));
      return { success: true, selector: buildCssSelector(target) };
    } catch (error) {
      console.error('执行 hover 失败:', error);
      return { success: false, error: error.message || '执行 hover 失败' };
    }
  });
}

function setValueForElement(element, text, clearBefore) {
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  const isInputLike = tag === 'input' || tag === 'textarea';
  const isContentEditable = element.isContentEditable;
  if (!isInputLike && !isContentEditable) {
    try {
      element.focus();
    } catch (_) {}
    return false;
  }

  const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  if (isInputLike) {
    const previousValue = element.value;
    const nextValue = clearBefore ? text : `${previousValue || ''}${text}`;
    if (valueSetter) {
      valueSetter.call(element, nextValue);
    } else {
      element.value = nextValue;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (isContentEditable) {
    if (clearBefore) {
      element.textContent = '';
    }
    element.focus();
    document.execCommand('insertText', false, text);
  }
  return true;
}

function performTypeTextAt(args = {}) {
  const { x, y, text = '', press_enter = true, clear_before_typing = true } = args;
  if (typeof x !== 'number' || typeof y !== 'number') {
    return { success: false, error: 'type_text_at 缺少坐标参数' };
  }
  return withSidebarHidden(() => {
    const point = getViewportPoint(x, y);
    if (!point) {
      return { success: false, error: '无法获取视口尺寸' };
    }
    const { clientX, clientY } = point;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) {
      return { success: false, error: '未找到目标元素' };
    }
    try {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
      target.focus?.();
      setValueForElement(target, text, clear_before_typing !== false);
      if (press_enter !== false) {
        const active = document.activeElement || target;
        ['keydown', 'keypress', 'keyup'].forEach(type => {
          active.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true }));
        });
      }
      return { success: true, selector: buildCssSelector(target) };
    } catch (error) {
      console.error('执行 type_text_at 失败:', error);
      return { success: false, error: error.message || '输入文本失败' };
    }
  });
}

function parseKeySequence(keys) {
  if (!keys) return [];
  return String(keys)
    .split(/\s*\+\s*/)
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
}

function performKeyCombination(args = {}) {
  const sequence = parseKeySequence(args.keys);
  if (!sequence.length) {
    return { success: false, error: 'key_combination 缺少 keys 参数' };
  }
  return withSidebarHidden(() => {
    const active = document.activeElement || document.body;
    const modifiers = ['control', 'ctrl', 'alt', 'shift', 'meta', 'command'];
    const down = new Set();
    const normalizeKey = (key) => {
      if (!key) return '';
      if (key === 'ctrl') return 'Control';
      if (key === 'command') return 'Meta';
      const lower = key.toLowerCase();
      if (modifiers.includes(lower)) {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      if (lower.length === 1) return lower;
      switch (lower) {
        case 'enter':
          return 'Enter';
        case 'escape':
        case 'esc':
          return 'Escape';
        case 'tab':
          return 'Tab';
        case 'space':
        case 'spacebar':
          return ' '; // Space key
        default:
          return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
    };
    try {
      sequence.forEach(key => {
        const normalized = normalizeKey(key);
        const eventInit = { key: normalized, code: normalized, bubbles: true };
        modifiers.forEach(mod => { if (down.has(mod)) eventInit[`${mod}Key`] = true; });
        active.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        down.add(key);
      });
      [...sequence].reverse().forEach(key => {
        const normalized = normalizeKey(key);
        const eventInit = { key: normalized, code: normalized, bubbles: true };
        modifiers.forEach(mod => { if (down.has(mod)) eventInit[`${mod}Key`] = true; });
        active.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        down.delete(key);
      });
      return { success: true };
    } catch (error) {
      console.error('执行快捷键失败:', error);
      return { success: false, error: error.message || '执行快捷键失败' };
    }
  });
}

function performScrollDocument(direction = 'down') {
  const distance = 800;
  const normalized = String(direction || '').toLowerCase();
  return withSidebarHidden(() => {
    switch (normalized) {
      case 'up':
        window.scrollBy(0, -distance);
        break;
      case 'down':
        window.scrollBy(0, distance);
        break;
      case 'left':
        window.scrollBy(-distance, 0);
        break;
      case 'right':
        window.scrollBy(distance, 0);
        break;
      default:
        return { success: false, error: `未知的滚动方向: ${direction}` };
    }
    return { success: true };
  });
}

function performScrollAt(args = {}) {
  const { x, y, direction = 'down', magnitude = 800 } = args;
  const point = getViewportPoint(x, y);
  if (!point) {
    return { success: false, error: '无法获取视口尺寸' };
  }
  return withSidebarHidden(() => {
    const { clientX, clientY } = point;
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) {
      return { success: false, error: '未找到目标元素' };
    }
    const delta = Number(magnitude) || 800;
    try {
      const dir = String(direction || '').toLowerCase();
      const applyScroll = (dx, dy) => {
        if (typeof target.scrollBy === 'function') {
          target.scrollBy(dx, dy);
        } else {
          target.scrollLeft = (target.scrollLeft || 0) + dx;
          target.scrollTop = (target.scrollTop || 0) + dy;
        }
      };
      switch (dir) {
        case 'up':
          applyScroll(0, -delta);
          break;
        case 'down':
          applyScroll(0, delta);
          break;
        case 'left':
          applyScroll(-delta, 0);
          break;
        case 'right':
          applyScroll(delta, 0);
          break;
        default:
          return { success: false, error: `未知的滚动方向: ${direction}` };
      }
      return { success: true, selector: buildCssSelector(target) };
    } catch (error) {
      console.error('局部滚动失败:', error);
      return { success: false, error: error.message || '局部滚动失败' };
    }
  });
}

function performDragAndDrop(args = {}) {
  const { x, y, destination_x, destination_y } = args;
  const startPoint = getViewportPoint(x, y);
  const endPoint = getViewportPoint(destination_x, destination_y);
  if (!startPoint || !endPoint) {
    return { success: false, error: '拖拽坐标无效' };
  }
  return withSidebarHidden(() => {
    const source = document.elementFromPoint(startPoint.clientX, startPoint.clientY);
    if (!source) {
      return { success: false, error: '未找到拖拽起始元素' };
    }
    try {
      const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startPoint.clientX, clientY: startPoint.clientY, button: 0 });
      source.dispatchEvent(mousedown);
      const mousemove = new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: endPoint.clientX, clientY: endPoint.clientY, buttons: 1 });
      document.dispatchEvent(mousemove);
      const mouseup = new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: endPoint.clientX, clientY: endPoint.clientY, button: 0 });
      document.dispatchEvent(mouseup);
      return { success: true, selector: buildCssSelector(source) };
    } catch (error) {
      console.error('拖拽失败:', error);
      return { success: false, error: error.message || '拖拽失败' };
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performComputerUseAction(action = {}) {
  const name = action?.name;
  const args = action?.args || {};
  switch (name) {
    case 'open_web_browser':
      return { success: true, info: '浏览器已处于激活状态' };
    case 'wait_5_seconds':
      await delay(5000);
      return { success: true };
    case 'go_back':
      setTimeout(() => window.history.back(), 0);
      return { success: true, navigation: true };
    case 'go_forward':
      setTimeout(() => window.history.forward(), 0);
      return { success: true, navigation: true };
    case 'search':
      setTimeout(() => { window.location.href = 'https://www.google.com'; }, 0);
      return { success: true, navigation: true };
    case 'navigate':
      if (!args.url) {
        return { success: false, error: 'navigate 缺少 url 参数' };
      }
      setTimeout(() => { window.location.href = args.url; }, 0);
      return { success: true, navigation: true };
    case 'click_at':
      return performNormalizedClick(args.x, args.y);
    case 'hover_at':
      return performHoverAt(args.x, args.y);
    case 'type_text_at':
      return performTypeTextAt(args);
    case 'key_combination':
      return performKeyCombination(args);
    case 'scroll_document':
      return performScrollDocument(args.direction);
    case 'scroll_at':
      return performScrollAt(args);
    case 'drag_and_drop':
      return performDragAndDrop(args);
    default:
      return { success: false, error: `暂不支持的动作：${name}` };
  }
}

// ====================== 临时调试用 ======================

// 调试功能：暴露几个调试函数方便查看PDF提取和DOM提取结果
window.cerebrDebug = {
  /**
   * 调试提取PDF内容
   * @param {string} [pdfUrl] - 可选的PDF URL，默认为当前页面URL
   * @returns {Promise<string|undefined>} 提取的PDF文本内容
   */
  debugExtractPDF: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 内容, URL: ${pdfUrl}`);
    try {
      const pdfText = await extractTextFromPDF(pdfUrl);
      console.log("Debug: PDF 内容提取结果:", pdfText);
      return pdfText;
    } catch (error) {
      console.error("Debug: PDF 内容提取失败:", error);
    }
  },
  debugExtractPDFOutline: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 大纲, URL: ${pdfUrl}`);
    try {
      const outline = await extractPdfOutlineChapters(pdfUrl);
      console.log("Debug: PDF 大纲提取结果:", outline);
      return outline;
    } catch (error) {
      console.error("Debug: PDF 大纲提取失败:", error);
    }
  },
  debugExtractPdfChapters: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 章节, URL: ${pdfUrl}`);
    try {
      const chapters = await debugExtractPdfChapters(pdfUrl);
      console.log("Debug: PDF 章节提取结果:", chapters);
      return chapters;
    } catch (error) {
      console.error("Debug: PDF 章节提取失败:", error);
    }
  },
  /**
   * 调试提取重要DOM结构
   * @returns {string} 清理过的重要DOM结构
   */
  debugExtractDOM: function() {
    console.log("Debug: 开始提取重要的 DOM 结构");
    const dom = extractImportantDOM();
    console.log("Debug: 提取后的 DOM:", dom);
    return dom;
  },
  /**
   * 调试提取可见 DOM 树（JSON 格式）
   * @returns {Object} 可见 DOM 树的 JSON 结构
   */
  debugExtractVisibleDOM: function() {
    console.log("Debug: 开始提取可见 DOM 树（JSON 格式）");
    const domTree = extractVisibleDOMTree(document.body);
    console.log("Debug: 可见 DOM 树：", JSON.stringify(domTree, null, 2));
    return domTree;
  },
  /**
   * 将 JSON DOM 树转换为 HTML 字符串
   * @param {Object} jsonNode - 使用 extractVisibleDOMTree() 提取出的 JSON DOM 节点
   * @returns {string} 生成的 HTML 字符串
   */
  debugExtractVisibleHTMLString: function() {
    console.log("Debug: 开始生成清洁的可见 HTML 字符串");
    const domTree = extractVisibleDOMTree(document.body);
    const htmlString = jsonDomToHtml(domTree);
    console.log("Debug: 可见 HTML 字符串：", htmlString);
    return htmlString;
  },
};

/**
 * 遍历 DOM 并返回简化后的 JSON 结构，仅保留对用户可见的部分
 * @param {HTMLElement} root - 待遍历的根节点
 * @returns {Object|null} 简化后的 DOM 结构树
 */
function extractVisibleDOMTree(root) {
  const allowedAttributes = ['id', 'class', 'href', 'title', 'placeholder', 'alt'];
  
  function serializeNode(node) {
    const computedStyle = window.getComputedStyle(node);
    // 如果节点样式设置为不可见，则返回null
    if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
      return null;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }

    const serialized = {
      tag: node.tagName.toLowerCase()
    };

    // 记录允许的属性
    if (node.attributes && node.attributes.length > 0) {
      serialized.attributes = {};
      Array.from(node.attributes).forEach(attr => {
        if (allowedAttributes.includes(attr.name)) {
          serialized.attributes[attr.name] = attr.value;
        }
      });
    }

    // 保存文本内容（仅当没有子元素时，认为是直接文本）
    const textContent = node.textContent.trim();
    if (textContent && node.children.length === 0) {
      serialized.text = textContent;
    }

    // 递归处理子元素
    const children = [];
    Array.from(node.children).forEach(child => {
      const childSerialized = serializeNode(child);
      if (childSerialized !== null) {
        children.push(childSerialized);
      }
    });
    if (children.length) {
      serialized.children = children;
    }
    return serialized;
  }

  return serializeNode(root);
}

// ====================== 新增：将 JSON DOM 树转换为 HTML 字符串 ======================

/**
 * 将 JSON DOM 树转换为 HTML 字符串
 * @param {Object} jsonNode - 使用 extractVisibleDOMTree() 提取出的 JSON DOM 节点
 * @returns {string} 生成的 HTML 字符串
 */
function jsonDomToHtml(jsonNode) {
  if (!jsonNode) return "";
  let attrStr = "";
  if (jsonNode.attributes) {
    for (const key in jsonNode.attributes) {
      attrStr += ` ${key}="${jsonNode.attributes[key]}"`;
    }
  }
  let innerHtml = "";
  // 如果节点有直接文本，则作为 inner HTML
  if (jsonNode.text) {
    innerHtml = jsonNode.text;
  }
  // 递归处理子节点
  if (jsonNode.children && jsonNode.children.length) {
    innerHtml += jsonNode.children.map(child => jsonDomToHtml(child)).join("");
  }
  return `<${jsonNode.tag}${attrStr}>${innerHtml}</${jsonNode.tag}>`;
}

// ====================== 新增：根据指定参数查询页面返回目标 DOM 片段 ======================

/**
 * 根据指定参数查询页面返回目标 DOM 片段。
 * @param {Object} params - 包含查询参数的对象，包括 query、target、maxDistance
 * @returns {string} 目标 DOM 片段的 outerHTML
 */
function extractDomByQuery(params) {
  const query = params.query || "";
  const targetSelector = params.target;
  const maxDistance = params.maxDistance;

  // 在页面中遍历所有可见元素，寻找首个 innerText 包含关键词 query 的锚点
  const allElements = Array.from(document.querySelectorAll("body *"));
  let anchorCandidate = null;
  for (const el of allElements) {
    // 仅考虑非空文本，并简单判断其 innerText 是否包含关键词（可扩展更复杂判定）
    if (el.innerText && el.innerText.includes(query)) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        anchorCandidate = el;
        break;
      }
    }
  }

  if (!anchorCandidate) {
    return `找不到包含关键词 "${query}" 的锚点元素。`;
  }

  // 获取锚点元素中心位置
  const anchorRect = anchorCandidate.getBoundingClientRect();
  const anchorCenter = {
    x: anchorRect.left + anchorRect.width / 2,
    y: anchorRect.top + anchorRect.height / 2
  };

  // 查找所有满足目标选择器的元素
  const candidates = Array.from(document.querySelectorAll(targetSelector));
  let bestCandidate = null;
  let bestDistance = Infinity;
  for (const cand of candidates) {
    const rect = cand.getBoundingClientRect();
    const candCenter = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
    const distance = Math.sqrt(Math.pow(anchorCenter.x - candCenter.x, 2) + Math.pow(anchorCenter.y - candCenter.y, 2));
    if (distance < bestDistance && distance <= maxDistance) {
      bestDistance = distance;
      bestCandidate = cand;
    }
  }

  if (bestCandidate) {
    return bestCandidate.outerHTML;
  } else {
    return `未在锚点 "${query}" 附近找到符合选择器 "${targetSelector}" 的目标元素。`;
  }
}

// ====================== 新增：提取当前视口内的 DOM 结构 ======================

/**
 * 判断元素是否至少部分位于视口中（只要有一部分可见就算）
 * @param {Element} el - 待检测的 DOM 元素
 * @returns {boolean} 如果元素至少部分可见返回 true，否则返回 false
 */
function isPartiallyInViewport(el) {
  const rect = el.getBoundingClientRect();
  // 如果元素的底部在视口上方、顶部在视口下方、右侧在视口左侧或左侧在视口右侧，则完全不可见
  return !(rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth);
}

/**
 * 递归提取当前视口内的 DOM 结构，只构建那些至少部分可见的节点。
 * 如果一个节点不在视口（即完全不可见），则直接返回 null，且不处理其子节点。
 *
 * 注意：对于文本节点，如果文本非空，则直接返回文本；其他节点只保留部分属性（如 id、class、href、title）。
 *
 * @param {Node} node - 待处理的节点
 * @returns {Object|string|null} 
 *   - 如果节点完全不可见则返回 null，
 *   - 如果是文本节点则返回文本内容，
 *   - 否则返回包含 tag、allowed attributes 以及 children（仅包含可见子节点）的结构化对象。
 */
function extractVisibleViewportDOMTree(node) {
  // 如果是文本节点，返回非空文本内容（否则忽略）
  if (node.nodeType === Node.TEXT_NODE) {
    const trimmed = node.textContent.trim();
    return trimmed ? trimmed : null;
  }
  
  // 非元素节点直接跳过
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  
  // 检查当前元素是否至少部分在视口中
  if (!isPartiallyInViewport(node)) {
    // 如果当前节点完全不在视口，则不进一步处理其子节点
    return null;
  }
  
  // 构造当前节点的结构化表示
  const obj = {
    tag: node.tagName.toLowerCase()
  };
  
  // 只保留部分允许的属性，避免信息过多
  const allowedAttrs = ['id', 'class', 'href', 'title'];
  if (node.attributes && node.attributes.length > 0) {
    obj.attributes = {};
    Array.from(node.attributes).forEach(attr => {
      if (allowedAttrs.includes(attr.name)) {
        obj.attributes[attr.name] = attr.value;
      }
    });
  }
  
  // 递归处理子节点：只包含那些至少部分可见的子元素
  const children = [];
  Array.from(node.childNodes).forEach(child => {
    const childData = extractVisibleViewportDOMTree(child);
    if (childData !== null) {
      children.push(childData);
    }
  });
  if (children.length > 0) {
    obj.children = children;
  }
  
  return obj;
}

// ====================== 新增：PDF结构章节工具函数 ======================

/**
 * 异步处理 PDF 书签，提取章节信息并获取页码
 * @param {Object} pdf - PDF.js 的 PDF 文档对象
 * @param {Array} outline - PDF.js 返回的书签数组
 * @returns {Promise<Array<{chapterTitle: string, pageNumber: (number|null), children: Array}>>}
 */
async function processPdfOutlineEx(pdf, outline) {
  if (!outline) return [];
  const result = [];
  for (const item of outline) {
    let pageNumber = null;
    if (item.dest) {
      try {
        // 如果 dest 是字符串，先通过 getDestination 获取数组，否则直接使用
        const destArray = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (destArray) {
          const pageRef = destArray[0];
          const pageIndex = await pdf.getPageIndex(pageRef);
          // PDF 页码通常从1开始
          pageNumber = pageIndex + 1;
        }
      } catch (e) {
        console.error('获取页码失败:', e);
      }
    }
    const children = await processPdfOutlineEx(pdf, item.items);
    result.push({
      chapterTitle: item.title || '未命名章节',
      pageNumber: pageNumber,
      children: children
    });
  }
  return result;
}

/**
 * 异步提取PDF文件的元数据和结构信息，从PDF书签中分出章节，并获取章节页码。
 * 此函数复用已有的 downloadPDFData 函数处理PDF数据，并利用 PDF.js 获取PDF目录和元数据。
 * 
 * @param {string} pdfUrl - PDF文件的URL
 * @param {Object} [options] - 可选配置
 * @returns {Promise<{title: string, url: string, metadata: Object, outline: Array}>}
 * @example
 * extractPdfOutlineChapters('https://example.com/sample.pdf').then(result => {
 *   console.log(result.outline);
 * });
 */
async function extractPdfOutlineChapters(pdfUrl, options = {}) {
  // 复用已有的下载函数获取完整PDF数据
  const completeData = await downloadPDFData(pdfUrl);

  // 使用PDF.js加载PDF文档
  const loadingTask = pdfjsLib.getDocument({ data: completeData });
  const pdf = await loadingTask.promise;

  // 提取元数据
  let meta = {};
  try {
    const metaResult = await pdf.getMetadata();
    meta = {
      info: metaResult.info,
      metadata: metaResult.metadata
    };
  } catch (e) {
    console.error('获取PDF元数据失败:', e);
  }

  // 尝试获取PDF的目录（书签）
  let outline = await pdf.getOutline();
  if (!outline) {
    // 没有书签时，构造默认单章节
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);

  // 返回PDF的基本信息、元数据和章节结构
  return {
    title: meta.metadata ? meta.metadata.get('DC:title') || meta.info.Title || pdf.fingerprint || '未知标题' : pdf.fingerprint || '未知标题',
    url: pdfUrl,
    metadata: meta,
    outline: processedOutline
  };
}

// ====================== 结束：PDF结构章节工具函数 ======================

// ====================== 新增：根据章节切分PDF文本 ======================
/**
 * 根据完整的页文本数组和章节outline切分PDF文本，按章节层次返回结构化的章节内容
 * @param {string[]} fullPageTexts - PDF每页的文本数组，索引0对应页1
 * @param {Array<{chapterTitle: string, pageNumber: (number|null), children: Array}>} outline - 章节outline，章节的 pageNumber 为起始页（从1计数）
 * @returns {Array<{chapterTitle: string, pageNumber: number, content: string, children: Array}>} 切分后的章节内容数据
 * @example
 * const chapters = splitPdfTextByChapters(fullPageTexts, outline);
 */
function splitPdfTextByChapters(fullPageTexts, outline) {
  const totalPages = fullPageTexts.length;
  // 筛选出有效的章节（有pageNumber），并按pageNumber排序
  const sortedOutline = outline.filter(item => item.pageNumber !== null).sort((a, b) => a.pageNumber - b.pageNumber);
  const chapters = [];
  for (let i = 0; i < sortedOutline.length; i++) {
    const chapter = sortedOutline[i];
    const start = chapter.pageNumber; // 起始页
    // 下一个章节的起始页，或者若没有则取总页数+1
    const end = (i < sortedOutline.length - 1) ? sortedOutline[i + 1].pageNumber : totalPages + 1;
    // 截取从 start 到 end-1 页的内容
    const content = fullPageTexts.slice(start - 1, end - 1).join('\n');

    // 如果该章节有子章节，则递归切分
    let children = [];
    if (chapter.children && chapter.children.length > 0) {
      children = splitPdfTextByChapters(fullPageTexts, chapter.children);
    }

    chapters.push({
      chapterTitle: chapter.chapterTitle,
      pageNumber: chapter.pageNumber,
      content: content,
      children: children
    });
  }
  return chapters;
}

// ====================== 新增：从PDF数据解析每页文本 ======================
/**
 * 解析完整的PDF数据，返回每一页的文本数组，数组索引0对应第1页
 * @param {Uint8Array} completeData - 下载的PDF数据
 * @returns {Promise<string[]>} 每页的文本数组
 * @example
 * const pageTexts = await parsePDFToPageTexts(completeData);
 */
async function parsePDFToPageTexts(completeData) {
  console.log('开始解析PDF为页文本数组');
  // 克隆数据，确保传递给pdf.js的ArrayBuffer是新的
  const freshData = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshData });
  const pdf = await loadingTask.promise;
  console.log('PDF加载成功，总页数:', pdf.numPages);
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    sendPlaceholderUpdate(`正在提取第 ${i} 页文本...`);
    console.log(`开始处理第 ${i} 页`);
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
    pageTexts.push(pageText);
  }
  return pageTexts;
}

// ====================== 新增：从PDF数据提取并切分章节文本 ======================
/**
 * 从给定的PDF URL中下载数据，提取每页文本，并结合目录将PDF文本按章节切分
 * @param {string} pdfUrl - PDF文件的URL
 * @returns {Promise<Array<{chapterTitle: string, pageNumber: number, content: string, children: Array}>>} 切分后的章节结构数据
 * @example
 * const chapters = await window.cerebrDebug.debugExtractPdfChapters('https://example.com/sample.pdf');
 */
async function debugExtractPdfChapters(pdfUrl) {
  pdfUrl = pdfUrl || window.location.href;
  console.log(`开始提取PDF章节数据, URL: ${pdfUrl}`);
  
  // 下载PDF数据
  const completeData = await downloadPDFData(pdfUrl);
  console.log('PDF下载完成，开始解析每页文本');
  
  // 获取每页文本数组；这里无需额外克隆，因为parsePDFToPageTexts内部会克隆数据
  const fullPageTexts = await parsePDFToPageTexts(completeData);
  console.log('成功提取每页文本, 页数:', fullPageTexts.length);
  
  // 为了获取目录和元数据，克隆PDF数据，不影响后续使用
  const freshDataForOutline = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshDataForOutline });
  const pdf = await loadingTask.promise;
  
  // 获取目录(书签)
  let outline = await pdf.getOutline();
  if (!outline) {
    console.log('未检测到书签，使用默认章节');
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);
  console.log('目录处理结果:', processedOutline);
  
  // 根据章节信息切分文本，每个章节起始页由outline中的pageNumber获得
  const chapters = splitPdfTextByChapters(fullPageTexts, processedOutline);
  
  console.log('切分后的章节数据:', chapters);
  return chapters;
}
