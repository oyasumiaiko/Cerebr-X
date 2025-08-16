/**
 * 图片处理模块 - 负责图片的预览、创建和管理
 * @module ImageHandler
 */

/**
 * 创建图片处理器实例
 * @param {Object} appContext - 应用上下文对象
 * @param {HTMLElement} appContext.dom.previewModal - 图片预览模态框元素
 * @param {HTMLElement} appContext.dom.previewImage - 预览图片元素
 * @param {HTMLElement} appContext.dom.previewCloseButton - 关闭按钮元素
 * @param {HTMLElement} appContext.dom.imageContainer - 图片容器元素
 * @param {HTMLElement} appContext.dom.messageInput - 消息输入框元素
 * @returns {Object} 图片处理API
 */
export function createImageHandler(appContext) {
  const {
    dom
  } = appContext;

  const previewModal = dom.previewModal;
  const previewImage = dom.previewImage;
  const closeButton = dom.previewCloseButton; // 已移除按钮，但保留引用以兼容旧代码
  const previewContent = null;

  // 预览图交互状态
  let currentScale = 1;
  let offsetX = 0; // 相对于容器左上角的偏移（px）
  let offsetY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartOffsetX = 0;
  let dragStartOffsetY = 0;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let lastOpenTimestampMs = 0;

  /**
   * 应用图像的平移和缩放变换
   * @private
   */
  /**
   * 更新图片布局：根据缩放与偏移设置 img 的大小与位置
   * @private
   */
  function updateImageLayout() {
    if (!previewModal || !previewImage) return;
    const displayWidth = Math.max(1, Math.round(naturalWidth * currentScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * currentScale));
    previewImage.style.width = `${displayWidth}px`;
    previewImage.style.height = `${displayHeight}px`;
    previewImage.style.left = `${Math.round(offsetX)}px`;
    previewImage.style.top = `${Math.round(offsetY)}px`;
  }

  /**
   * 重置图像的平移和缩放
   * @private
   */
  /**
   * 根据容器尺寸将图片重置为适配视窗，并居中
   * @private
   */
  function resetViewToFit() {
    if (!previewModal || !previewImage) return;
    const containerRect = previewModal.getBoundingClientRect();
    const maxW = containerRect.width;
    const maxH = containerRect.height;
    if (!naturalWidth || !naturalHeight || maxW <= 0 || maxH <= 0) return;
    // 适配缩放：以容器尺寸为基准
    currentScale = Math.min(maxW / naturalWidth, maxH / naturalHeight);
    const displayWidth = Math.max(1, Math.round(naturalWidth * currentScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * currentScale));
    // 居中图片（容器本身由 CSS 控制最大 90%，不强行改容器尺寸）
    offsetX = Math.round((maxW - displayWidth) / 2);
    offsetY = Math.round((maxH - displayHeight) / 2);

    // 基本样式
    previewModal.style.position = 'fixed';
    previewModal.style.overflow = 'hidden';
    previewImage.style.position = 'absolute';
    previewImage.style.maxWidth = 'none';
    previewImage.style.maxHeight = 'none';
    previewImage.style.transform = 'none';
    previewImage.style.imageRendering = 'auto';
    previewImage.style.cursor = 'grab';
    // 打开时不做任何过渡，避免从上一张的尺寸/位置过渡
    previewImage.style.transition = 'none';

    updateImageLayout();
  }
  const imageContainer = dom.imageContainer;
  const messageInput = dom.messageInput;

  /**
   * 显示图片预览
   * @param {string} base64Data - 图片的base64数据
   */
  function showImagePreview(base64Data) {
    // 先绑定，再设置 src，且对 dataURL/缓存命中做同步兜底
    const onLoad = () => {
      naturalWidth = previewImage.naturalWidth || 0;
      naturalHeight = previewImage.naturalHeight || 0;
      resetViewToFit();
      previewImage.removeEventListener('load', onLoad);
    };
    previewImage.addEventListener('load', onLoad);
    // 打开前重置样式，避免沿用上一张图的尺寸/位置并产生动画
    previewImage.style.transition = 'none';
    previewImage.style.left = '0px';
    previewImage.style.top = '0px';
    previewImage.style.width = 'auto';
    previewImage.style.height = 'auto';
    currentScale = 1;
    offsetX = 0;
    offsetY = 0;
    previewImage.src = base64Data;
    if (previewImage.complete && previewImage.naturalWidth) {
      onLoad();
    }
    // 避免打开这一击被关闭：记录打开时间
    lastOpenTimestampMs = performance.now();
    // 下一帧再展示，避免与当前 click 冲突
    requestAnimationFrame(() => {
      previewModal.classList.add('visible');
    });
  }

  /**
   * 隐藏图片预览
   */
  function hideImagePreview() {
    previewModal.classList.remove('visible');
    previewImage.src = '';
  }

  /**
   * 初始化图片预览相关事件
   */
  function initImagePreviewEvents() {
    // 单击关闭 + 背景点击关闭（与双击/拖拽解耦）
    let clickTimerId = null;
    let isDraggingOrMoved = false;
    let lastPointerDown = { x: 0, y: 0 };

    if (previewModal) {
      previewModal.addEventListener('click', (e) => {
        // 如果正在拖拽或发生了明显移动，不处理单击关闭
        if (isDraggingOrMoved) {
          isDraggingOrMoved = false;
          return;
        }
        // 刚打开的同一次点击忽略
        if (performance.now() - lastOpenTimestampMs < 250) {
          return;
        }
        // 延时以区分双击
        if (clickTimerId) clearTimeout(clickTimerId);
        clickTimerId = setTimeout(() => {
          hideImagePreview();
          clickTimerId = null;
        }, 180);
      });
    }

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (!previewModal.classList.contains('visible')) return;
      if (e.key === 'Escape') {
        hideImagePreview();
      }
    });

    // 拖拽平移
    if (previewModal && previewImage) {
      previewModal.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 仅左键
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartOffsetX = offsetX;
        dragStartOffsetY = offsetY;
        isDraggingOrMoved = false;
        lastPointerDown = { x: e.clientX, y: e.clientY };
        previewImage.style.cursor = 'grabbing';
        // 拖拽时关闭过渡避免延迟
        const prevTransition = previewImage.style.transition;
        previewImage.__prevTransition = prevTransition;
        previewImage.style.transition = 'none';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        // 以屏幕像素为单位，缩放/DPI 下保持跟手
        offsetX = dragStartOffsetX + dx;
        offsetY = dragStartOffsetY + dy;
        if (Math.abs(e.clientX - lastPointerDown.x) + Math.abs(e.clientY - lastPointerDown.y) > 5) {
          isDraggingOrMoved = true;
        }
        updateImageLayout();
      });

      window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        previewImage.style.cursor = 'grab';
        // 恢复为轻微过渡，后续滚轮/轻微拖动有平滑，但不影响下次打开
        previewImage.style.transition = 'left 100ms ease-out, top 100ms ease-out, width 100ms ease-out, height 100ms ease-out';
      });
    }

    // 滚轮缩放（全屏可用：在图像外则以屏幕中心为缩放中心）
    if (previewModal) {
      previewModal.addEventListener('wheel', (e) => {
        if (!previewModal.classList.contains('visible')) return;
        if (!previewModal || !previewImage) return;
        e.preventDefault();
        const containerRect = previewModal.getBoundingClientRect();
        const imgRect = previewImage.getBoundingClientRect();
        const pointerInsideImage = (
          e.clientX >= imgRect.left && e.clientX <= imgRect.right &&
          e.clientY >= imgRect.top && e.clientY <= imgRect.bottom
        );

        // 以鼠标为中心；若不在图像上，则以屏幕中心
        const pivotClientX = pointerInsideImage ? e.clientX : window.innerWidth / 2;
        const pivotClientY = pointerInsideImage ? e.clientY : window.innerHeight / 2;
        const pivotX = pivotClientX - containerRect.left; // 转为容器坐标
        const pivotY = pivotClientY - containerRect.top;

        // 平滑缩放（可按需调整灵敏度）
        const zoomFactor = Math.exp(-e.deltaY * 0.0015);
        const oldScale = currentScale;
        const newScale = Math.min(8, Math.max(0.2, oldScale * zoomFactor));
        if (newScale === oldScale) return;

        // 以 pivot 保持位置不变：offset' = P - (P - offset) * (S'/S)
        offsetX = pivotX - (pivotX - offsetX) * (newScale / oldScale);
        offsetY = pivotY - (pivotY - offsetY) * (newScale / oldScale);
        currentScale = newScale;
        updateImageLayout();
      }, { passive: false });
    }

    // 移除双击逻辑（按需恢复可在此添加）
  }

  /**
   * 处理图片标签，将内容和图片HTML转换为消息格式
   * @param {string} content - 文本内容
   * @param {string} imagesHTML - 图片HTML内容
   * @returns {Array|string} 处理后的消息格式
   */
  function processImageTags(content, imagesHTML) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = imagesHTML;
    const imageTags = tempDiv.querySelectorAll('.image-tag');

    if (imageTags.length > 0) {
      const result = [];
      // 先添加图片
      imageTags.forEach(tag => {
        const base64Data = tag.getAttribute('data-image');
        if (base64Data) {
          result.push({
            type: "image_url",
            image_url: {
              url: base64Data
            }
          });
        }
      });
      // 后添加文本内容
      if (content) {
        result.push({
          type: "text",
          text: content
        });
      }
      return result;
    }
    return content;
  }

  /**
   * 创建图片标签元素
   * @param {string} base64Data - 图片的base64数据
   * @param {string} fileName - 图片文件名
   * @returns {HTMLElement} 创建的图片标签元素
   */
  function createImageTag(base64Data, fileName) {
    const container = document.createElement('span');
    container.className = 'image-tag';
    container.contentEditable = false;
    container.setAttribute('data-image', base64Data);
    container.title = fileName || ''; // 添加悬停提示

    const thumbnail = document.createElement('img');
    thumbnail.src = base64Data;
    thumbnail.alt = fileName || '';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
    deleteBtn.title = '删除图片';

    // 点击删除按钮时移除整个标签
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      container.remove();
    });

    container.appendChild(thumbnail);
    container.appendChild(deleteBtn);

    // 点击图片区域预览图片
    thumbnail.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showImagePreview(base64Data);
    });

    return container;
  }

  /**
   * 添加图片到容器
   * @param {string} imageData - 图片的base64数据
   * @param {string} fileName - 图片文件名
   */
  function addImageToContainer(imageData, fileName) {
    const imageTag = createImageTag(imageData, fileName);
    imageContainer.appendChild(imageTag);
    // 触发输入事件以保证界面刷新
    messageInput.dispatchEvent(new Event('input'));
    console.log("图片插入到图片容器");
  }

  /**
   * 处理图片拖放事件
   * @param {Event} e - 拖放事件对象
   * @param {HTMLElement} target - 拖放目标元素
   */
  function handleImageDrop(e, target) {
    e.preventDefault();
    e.stopPropagation();

    try {
      // 处理文件拖放
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            addImageToContainer(reader.result, file.name);
          };
          reader.readAsDataURL(file);
          return;
        }
      }

      // 处理网页图片拖放
      const data = e.dataTransfer.getData('text/plain');
      if (data) {
        try {
          const imageData = JSON.parse(data);
          if (imageData.type === 'image') {
            addImageToContainer(imageData.data, imageData.name);
          }
        } catch (error) {
          console.error('处理拖放数据失败:', error);
        }
      }
    } catch (error) {
      console.error('处理拖放事件失败:', error);
    }
  }

  /**
   * 为元素绑定拖放事件监听器
   * @param {HTMLElement} elements - 需要绑定拖放事件的元素
   */
  function setupImageDropListeners(elements) {
    if (Array.isArray(elements)) {
      elements.forEach(element => {
        element.addEventListener('drop', (e) => handleImageDrop(e, element));
      });
    } else {
      console.error('setupImageDropListeners需要接收一个数组参数');
    }
  }

  // 立即初始化图片预览事件
  if (previewModal && previewImage) {
    initImagePreviewEvents();
  }

  // 返回公共API
  return {
    showImagePreview,
    hideImagePreview,
    processImageTags,
    createImageTag,
    addImageToContainer,
    handleImageDrop,
    setupImageDropListeners
  };
} 