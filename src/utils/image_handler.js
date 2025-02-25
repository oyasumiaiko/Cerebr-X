/**
 * 图片处理模块 - 负责图片的预览、创建和管理
 * @module ImageHandler
 */

/**
 * 创建图片处理器实例
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.previewModal - 图片预览模态框元素
 * @param {HTMLElement} options.previewImage - 预览图片元素
 * @param {HTMLElement} options.closeButton - 关闭按钮元素
 * @param {HTMLElement} options.imageContainer - 图片容器元素
 * @param {HTMLElement} options.messageInput - 消息输入框元素
 * @returns {Object} 图片处理API
 */
export function createImageHandler(options) {
  const {
    previewModal,
    previewImage,
    closeButton,
    imageContainer,
    messageInput
  } = options;

  /**
   * 显示图片预览
   * @param {string} base64Data - 图片的base64数据
   */
  function showImagePreview(base64Data) {
    previewImage.src = base64Data;
    previewModal.classList.add('visible');
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
    closeButton.addEventListener('click', hideImagePreview);
    previewModal.addEventListener('click', (e) => {
      if (previewModal === e.target) {
        hideImagePreview();
      }
    });
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
      // 添加文本内容
      if (content) {
        result.push({
          type: "text",
          text: content
        });
      }
      // 添加图片
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
  initImagePreviewEvents();

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