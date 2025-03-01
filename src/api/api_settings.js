/**
 * API 设置和请求处理模块
 * 负责管理 API 配置、UI 渲染以及构建和发送 API 请求
 */

/**
 * 创建 API 管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.apiSettings - API 设置面板元素
 * @param {HTMLElement} options.apiCards - API 卡片容器元素
 * @param {Function} options.closeExclusivePanels - 关闭其他面板的函数
 * @returns {Object} API 管理器实例
 */
export function createApiManager(options) {
  // 私有状态
  let apiConfigs = [];
  let selectedConfigIndex = 0;
  
  const { 
    apiSettings, 
    apiCards, 
    closeExclusivePanels 
  } = options;

  /**
   * 加载 API 配置
   * @returns {Promise<void>}
   */
  async function loadAPIConfigs() {
    try {
      const result = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
      if (result.apiConfigs && result.apiConfigs.length > 0) {
        apiConfigs = result.apiConfigs;
        selectedConfigIndex = result.selectedConfigIndex || 0;
      } else {
        // 创建默认配置
        apiConfigs = [{
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1/chat/completions',
          modelName: 'gpt-4o',
          displayName: '',
          temperature: 1,
          isFavorite: false  // 添加收藏状态字段
        }];
        selectedConfigIndex = 0;
        await saveAPIConfigs();
      }
    } catch (error) {
      console.error('加载 API 配置失败:', error);
      // 如果加载失败，也创建默认配置
      apiConfigs = [{
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        modelName: 'gpt-4o',
        displayName: '',
        temperature: 1,
        isFavorite: false  // 添加收藏状态字段
      }];
      selectedConfigIndex = 0;
    }

    // 暴露 apiConfigs 到 window 对象 (向后兼容)
    window.apiConfigs = apiConfigs;
    // 触发配置更新事件
    window.dispatchEvent(new Event('apiConfigsUpdated'));

    // 确保一定会渲染卡片和收藏列表
    renderAPICards();
    renderFavoriteApis();
  }

  /**
   * 保存配置到存储
   * @returns {Promise<void>}
   */
  async function saveAPIConfigs() {
    try {
      await chrome.storage.sync.set({
        apiConfigs,
        selectedConfigIndex
      });
      // 更新 window.apiConfigs 并触发事件 (向后兼容)
      window.apiConfigs = apiConfigs;
      window.dispatchEvent(new Event('apiConfigsUpdated'));
    } catch (error) {
      console.error('保存 API 配置失败:', error);
    }
  }

  /**
   * 渲染 API 卡片
   */
  function renderAPICards() {
    // 确保模板元素在
    const templateCard = document.querySelector('.api-card.template');
    if (!templateCard) {
      console.error('找不到模板卡片元素');
      return;
    }

    // 保存模板的副本
    const templateClone = templateCard.cloneNode(true);

    // 清空现有卡片
    apiCards.innerHTML = '';

    // 先重新添加模板（保持隐藏状态）
    apiCards.appendChild(templateClone);

    // 渲染实际的卡
    apiConfigs.forEach((config, index) => {
      const card = createAPICard(config, index, templateClone);
      apiCards.appendChild(card);
    });
  }

  /**
   * 创建并渲染单个 API 配置卡片
   * @param {Object} config - API 配置对象
   * @param {string} [config.apiKey] - API 密钥
   * @param {string} [config.baseUrl] - API 基础 URL
   * @param {string} [config.modelName] - 模型名称
   * @param {number} [config.temperature] - temperature 值（可为 0）
   * @param {boolean} [config.isFavorite] - 是否收藏
   * @param {number} index - 该配置在 apiConfigs 数组中的索引
   * @param {HTMLElement} templateCard - 用于克隆的卡片模板 DOM
   * @returns {HTMLElement} 渲染后的卡片元素
   */
  function createAPICard(config, index, templateCard) {
    // 克隆模板
    const template = templateCard.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';

    if (index === selectedConfigIndex) {
      template.classList.add('selected');
    }

    // 设置标题
    const titleElement = template.querySelector('.api-card-title');
    titleElement.textContent = config.displayName || config.modelName || config.baseUrl || '新配置';

    const apiKeyInput = template.querySelector('.api-key');
    const baseUrlInput = template.querySelector('.base-url');
    const displayNameInput = template.querySelector('.display-name');
    const modelNameInput = template.querySelector('.model-name');
    const temperatureInput = template.querySelector('.temperature');
    const temperatureValue = template.querySelector('.temperature-value');
    const apiForm = template.querySelector('.api-form');
    const favoriteBtn = template.querySelector('.favorite-btn');
    const togglePasswordBtn = template.querySelector('.toggle-password-btn');
    const selectBtn = template.querySelector('.select-btn');

    // 选择按钮点击事件
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 移除其他卡片的选中状态
      document.querySelectorAll('.api-card').forEach(card => {
        card.classList.remove('selected');
      });
      // 设置当前卡片为选中状态
      template.classList.add('selected');
      selectedConfigIndex = index;
      saveAPIConfigs();
      // 关闭设置菜单
      apiSettings.classList.remove('visible');
    });

    // 点击卡片只展开/折叠表单
    template.addEventListener('click', () => {
      template.classList.toggle('expanded');
    });

    // 添加密码切换按钮的点击事件监听器
    togglePasswordBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = apiKeyInput.type === 'password' ? 'text' : 'password';
      apiKeyInput.type = type;
      togglePasswordBtn.classList.toggle('visible');
    });

    // 添加点击外部自动隐藏密码的功能
    document.addEventListener('click', (e) => {
      // 如果点击的不是API Key输入框和切换按钮
      if (!apiKeyInput.contains(e.target) && !togglePasswordBtn.contains(e.target)) {
        // 如果当前是显示状态，则切换回密码状态
        if (apiKeyInput.type === 'text') {
          apiKeyInput.type = 'password';
          togglePasswordBtn.classList.remove('visible');
        }
      }
    });

    // 当输入框失去焦点时也隐藏密码
    apiKeyInput.addEventListener('blur', () => {
      if (apiKeyInput.type === 'text') {
        apiKeyInput.type = 'password';
        togglePasswordBtn.classList.remove('visible');
      }
    });

    // 使用 ?? 替代 || 来防止 0 被错误替换
    apiKeyInput.value = config.apiKey ?? '';
    baseUrlInput.value = config.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
    displayNameInput.value = config.displayName ?? '';
    modelNameInput.value = config.modelName ?? 'gpt-4o';
    temperatureInput.value = config.temperature ?? 1;
    temperatureValue.textContent = (config.temperature ?? 1).toFixed(1);

    // 监听温度变化
    temperatureInput.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      temperatureValue.textContent = value.toFixed(1);
      // 保存温度值
      apiConfigs[index] = {
        ...apiConfigs[index],
        temperature: value
      };
      saveAPIConfigs();
    });

    // 检查是否已收藏
    if (config.isFavorite) {
      favoriteBtn.classList.add('active');
    }

    // 收藏按钮点击事件
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 直接切换当前配置的收藏状态
      apiConfigs[index].isFavorite = !apiConfigs[index].isFavorite;

      if (apiConfigs[index].isFavorite) {
        favoriteBtn.classList.add('active');
      } else {
        favoriteBtn.classList.remove('active');
      }

      saveAPIConfigs();
      renderFavoriteApis();
    });

    // 阻止输入框和按钮点击事件冒泡
    const stopPropagation = (e) => e.stopPropagation();
    apiForm.addEventListener('click', stopPropagation);
    template.querySelector('.api-card-actions').addEventListener('click', stopPropagation);

    // 输入变化时保存
    [apiKeyInput, baseUrlInput, displayNameInput, modelNameInput, temperatureInput].forEach(input => {
      input.addEventListener('change', () => {
        apiConfigs[index] = {
          ...apiConfigs[index],
          apiKey: apiKeyInput.value,
          baseUrl: baseUrlInput.value,
          displayName: displayNameInput.value,
          modelName: modelNameInput.value,
          temperature: parseFloat(temperatureInput.value)
        };
        // 更新标题
        titleElement.textContent = apiConfigs[index].displayName || apiConfigs[index].modelName || apiConfigs[index].baseUrl || '新配置';
        saveAPIConfigs();
      });
    });

    // 复制配置
    template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      apiConfigs.push({ ...config });
      saveAPIConfigs();
      renderAPICards();
    });

    // 删除配置
    template.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (apiConfigs.length > 1) {
        apiConfigs.splice(index, 1);
        if (selectedConfigIndex >= apiConfigs.length) {
          selectedConfigIndex = apiConfigs.length - 1;
        }
        saveAPIConfigs();
        renderAPICards();
      }
    });

    // 处理自定义参数输入
    const customParamsInput = template.querySelector('.custom-params');
    if (customParamsInput) {
      customParamsInput.value = config.customParams || '';
      customParamsInput.addEventListener('change', () => {
        apiConfigs[index].customParams = customParamsInput.value;
        saveAPIConfigs();
      });
      // 当输入完成后，尝试格式化为美化后的 JSON 格式，并在格式错误时在UI上提示
      customParamsInput.addEventListener('blur', () => {
        // 如果输入内容为空，则不作解析
        if (customParamsInput.value.trim() === "") {
          customParamsInput.style.borderColor = "";
          let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
          if (errorElem) {
            errorElem.remove();
          }
          apiConfigs[index].customParams = "";
          saveAPIConfigs();
          return;
        }
        try {
          const parsed = JSON.parse(customParamsInput.value);
          // 格式化为两格缩进的 JSON 字符串
          customParamsInput.value = JSON.stringify(parsed, null, 2);
          apiConfigs[index].customParams = customParamsInput.value;
          // 如果存在错误提示，则移除
          let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
          if (errorElem) {
            errorElem.remove();
          }
          customParamsInput.style.borderColor = "";
          saveAPIConfigs();
        } catch (e) {
          // 设置红色边框
          customParamsInput.style.borderColor = "red";
          // 创建或更新错误提示元素
          let errorElem = customParamsInput.parentNode.querySelector('.custom-params-error');
          if (!errorElem) {
            errorElem = document.createElement("div");
            errorElem.className = "custom-params-error";
            errorElem.style.color = "red";
            errorElem.style.fontSize = "12px";
            errorElem.style.marginTop = "4px";
            customParamsInput.parentNode.appendChild(errorElem);
          }
          errorElem.textContent = "格式化失败：请检查 JSON 格式";
          console.error("自定义参数格式化失败:", e);
        }
      });
    }

    return template;
  }

  /**
   * 渲染收藏的API列表
   */
  function renderFavoriteApis() {
    const favoriteApisList = document.querySelector('.favorite-apis-list');
    if (!favoriteApisList) return;
    
    favoriteApisList.innerHTML = '';

    // 过滤出收藏的API
    const favoriteConfigs = apiConfigs.filter(config => config.isFavorite);

    if (favoriteConfigs.length === 0) {
      const emptyMessage = document.createElement('div');
      emptyMessage.style.padding = '4px 8px';
      emptyMessage.style.opacity = '0.7';
      emptyMessage.style.fontSize = '12px';
      emptyMessage.textContent = '暂无收藏的API';
      favoriteApisList.appendChild(emptyMessage);
      return;
    }

    // 获取当前使用的API配置
    const currentConfig = apiConfigs[selectedConfigIndex];

    favoriteConfigs.forEach((config) => {
      const item = document.createElement('div');
      item.className = 'favorite-api-item';

      // 检查是否是当前使用的API
      if (currentConfig &&
          currentConfig.apiKey === config.apiKey &&
          currentConfig.baseUrl === config.baseUrl &&
          currentConfig.modelName === config.modelName) {
        item.classList.add('current');
      }

      const apiName = document.createElement('span');
      apiName.className = 'api-name';
      apiName.textContent = config.displayName || config.modelName || config.baseUrl;

      item.appendChild(apiName);

      // 点击切换到该API配置
      item.addEventListener('click', () => {
        const configIndex = apiConfigs.findIndex(c =>
          c.apiKey === config.apiKey &&
          c.baseUrl === config.baseUrl &&
          c.modelName === config.modelName
        );

        if (configIndex !== -1) {
          selectedConfigIndex = configIndex;
          saveAPIConfigs();
          renderAPICards();
        }
      });

      favoriteApisList.appendChild(item);
    });
  }

  /**
   * 构建 API 请求
   * @param {Object} options - 请求选项
   * @param {Array} options.messages - 消息数组
   * @param {Object} options.config - API 配置
   * @param {Object} [options.overrides] - 覆盖默认设置的参数
   * @returns {Object} 请求体对象
   */
  function buildRequest({ messages, config, overrides = {} }) {
    // 构造请求基本结构
    let requestBody = {
      model: config.modelName,
      messages: messages,
      stream: true,
      temperature: config.temperature,
      top_p: 0.95,
      ...overrides // 允许覆盖默认参数
    };

    // 如果存在自定义参数，解析并合并
    if (config.customParams) {
      try {
        const extraParams = JSON.parse(config.customParams);
        requestBody = { ...requestBody, ...extraParams };
      } catch (e) {
        console.error("解析自定义参数 JSON 失败，请检查格式。", e);
      }
    }

    return requestBody;
  }

  /**
   * 发送 API 请求
   * @param {Object} options - 请求选项
   * @param {Object} options.requestBody - 请求体
   * @param {Object} options.config - API 配置
   * @param {AbortSignal} [options.signal] - 中止信号
   * @returns {Promise<Response>} Fetch 响应对象
   */
  async function sendRequest({ requestBody, config, signal }) {
    return fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal
    });
  }

  /**
   * 设置UI事件处理
   * @param {HTMLElement} apiSettingsToggle - API设置切换按钮
   * @param {HTMLElement} backButton - 返回按钮
   */
  function setupUIEventHandlers(apiSettingsToggle, backButton) {
    // 显示/隐藏 API 设置
    apiSettingsToggle.addEventListener('click', () => {
      const wasVisible = apiSettings.classList.contains('visible');
      closeExclusivePanels();

      if (!wasVisible) {
        apiSettings.classList.toggle('visible');
        renderAPICards();
      }
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
      apiSettings.classList.remove('visible');
    });
  }

  /**
   * 获取模型配置
   * @param {string} [promptType] - 提示词类型 
   * @param {Object} prompts - 提示词设置
   * @returns {Object} 选中的API配置
   */
  function getModelConfig(promptType, prompts) {
    // 检查特定提示词类型是否指定了特定模型
    let targetConfig = null;
    if (promptType && promptType !== 'none' && prompts?.[promptType]?.model) {
      const preferredModel = prompts[promptType].model;
      // 如果不是跟随当前设置，则查找对应的模型配置
      if (preferredModel !== 'follow_current') {
        targetConfig = apiConfigs.find(c => c.modelName === preferredModel);
        // 如果找到了目标配置，直接返回
        if (targetConfig) {
          return targetConfig;
        }
        // 如果没找到目标配置，记录警告
        console.warn(`找不到偏好模型 ${preferredModel} 的配置，将使用当前选中的配置`);
      }
    }

    // 如果没有特定模型配置或设置为跟随当前，使用当前选中的配置
    return apiConfigs[selectedConfigIndex];
  }

  /**
   * 从部分配置信息中获取完整的 API 配置
   * @param {Object} partialConfig - 部分 API 配置信息
   * @param {string} partialConfig.baseUrl - API 基础 URL
   * @param {string} partialConfig.modelName - 模型名称
   * @param {number} [partialConfig.temperature] - 温度值
   * @param {string} [partialConfig.customParams] - 自定义参数字符串
   * @returns {Object|null} 完整的 API 配置对象或 null
   */
  function getApiConfigFromPartial(partialConfig) {
    if (!partialConfig || !partialConfig.baseUrl || !partialConfig.modelName) {
      return null;
    }
    
    // 首先尝试按完全匹配查找配置
    let matchedConfig = apiConfigs.find(config => 
      config.baseUrl === partialConfig.baseUrl && 
      config.modelName === partialConfig.modelName
    );
    
    // 如果找到完全匹配，返回该配置
    if (matchedConfig) {
      return matchedConfig;
    }
    
    // 如果没有找到完全匹配，则尝试按 URL 匹配并创建新配置
    const urlMatchedConfig = apiConfigs.find(config => config.baseUrl === partialConfig.baseUrl);
    
    // 创建新的配置对象（优先使用匹配到的配置的 API 密钥，如果有的话）
    return {
      baseUrl: partialConfig.baseUrl,
      apiKey: urlMatchedConfig?.apiKey || apiConfigs[selectedConfigIndex]?.apiKey || '',
      modelName: partialConfig.modelName,
      displayName: partialConfig.displayName || '',
      temperature: partialConfig.temperature ?? 1.0,
      customParams: partialConfig.customParams || ''
    };
  }

  /**
   * 公共API接口
   */
  return {
    init: loadAPIConfigs,
    loadAPIConfigs,
    saveAPIConfigs,
    renderAPICards,
    renderFavoriteApis,
    buildRequest,
    sendRequest,
    setupUIEventHandlers,
    getModelConfig,
    getApiConfigFromPartial,
    
    // 获取和设置配置
    getSelectedConfig: () => apiConfigs[selectedConfigIndex],
    getAllConfigs: () => [...apiConfigs],
    getSelectedIndex: () => selectedConfigIndex,
    setSelectedIndex: (index) => {
      if (index >= 0 && index < apiConfigs.length) {
        selectedConfigIndex = index;
        saveAPIConfigs();
        return true;
      }
      return false;
    },
    
    // 添加新配置
    addConfig: (config) => {
      apiConfigs.push(config);
      saveAPIConfigs();
      renderAPICards();
    }
  };
} 