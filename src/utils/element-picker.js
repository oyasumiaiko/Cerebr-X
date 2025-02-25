class ElementPicker {
  constructor(options = {}) {
      // 配置选项
      this.options = {
          highlightColor: 'rgba(120, 170, 210, 0.6)',
          zIndex: 10000,
          ...options
      };
      
      // 临时状态(仅在picking过程中使用)
      this._state = {
          isPickingEnabled: false,
          highlightedElement: null,
          overlay: null,
          selectedCallback: null
      };
  }

  // 开始选择
  startPicking(callback) {
      if (this._state.isPickingEnabled) return;
      
      this._state.isPickingEnabled = true;
      this._state.selectedCallback = callback;
      
      // 创建高亮层
      this._state.overlay = this._createOverlay();
      document.body.appendChild(this._state.overlay);
      
      // 添加事件监听
      document.addEventListener('mousemove', this._handleMouseMove);
      document.addEventListener('click', this._handleClick);
      
      // 修改鼠标样式
      document.body.style.cursor = 'crosshair';
  }

  // 停止选择
  stopPicking() {
      if (!this._state.isPickingEnabled) return;
      
      // 移除事件监听
      document.removeEventListener('mousemove', this._handleMouseMove);
      document.removeEventListener('click', this._handleClick);
      
      // 清理DOM
      if (this._state.overlay) {
          this._state.overlay.remove();
      }
      
      // 恢复鼠标样式
      document.body.style.cursor = '';
      
      // 重置状态
      this._state = {
          isPickingEnabled: false,
          highlightedElement: null,
          overlay: null,
          selectedCallback: null
      };
  }

  // 创建高亮层
  _createOverlay() {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
          position: 'fixed',
          pointerEvents: 'none',
          zIndex: this.options.zIndex,
          background: this.options.highlightColor,
          transition: 'all 0.15s ease-out',
          boxShadow: 'rgb(0 0 0) 0px 0px 3px 0px',
          display: 'none'
      });
      return overlay;
  }

  // 更新高亮层位置
  _updateOverlay(element) {
      if (!element || !this._state.overlay) return;
      
      const rect = element.getBoundingClientRect();
      Object.assign(this._state.overlay.style, {
          display: 'block',
          width: rect.width + 'px',
          height: rect.height + 'px',
          left: rect.left + 'px',
          top: rect.top + 'px'
      });
  }

  // 生成选择器
  _generateSelector(element) {
      const path = [];
      while (element && element.nodeType === Node.ELEMENT_NODE) {
          let selector = element.tagName.toLowerCase();
          
          // 添加id
          if (element.id) {
              selector += '#' + element.id;
              path.unshift(selector);
              break;
          }
          
          // 添加类名
          if (element.className) {
              selector += '.' + Array.from(element.classList).join('.');
          }
          
          // 添加nth-child
          let index = 1;
          let sibling = element;
          while (sibling = sibling.previousElementSibling) {
              if (sibling.tagName === element.tagName) index++;
          }
          if (index > 1) selector += `:nth-of-type(${index})`;
          
          path.unshift(selector);
          element = element.parentElement;
      }
      
      return path.join(' > ');
  }

  // 事件处理器
  _handleMouseMove = (e) => {
      const element = document.elementFromPoint(e.clientX, e.clientY);
      if (element === this._state.highlightedElement) return;
      
      this._state.highlightedElement = element;
      this._updateOverlay(element);
  }

  _handleClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (this._state.highlightedElement && this._state.selectedCallback) {
          const selector = this._generateSelector(this._state.highlightedElement);
          this._state.selectedCallback({
              element: this._state.highlightedElement,
              selector: selector
          });
      }
      
      this.stopPicking();
  }
}