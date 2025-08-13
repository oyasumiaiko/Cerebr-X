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
export function createApiManager(appContext) {
  // 私有状态
  let apiConfigs = [];
  let selectedConfigIndex = 0;
  // 用于存储每个配置下次应使用的 API Key 索引 (内存中)
  const apiKeyUsageIndex = {};

  const {
    dom,
    // services, // services.uiManager can be used for closeExclusivePanels
    utils // utils.closeExclusivePanels (which might call uiManager internally)
  } = appContext;

  const apiSettingsPanel = dom.apiSettingsPanel; // Use renamed dom property
  const apiCardsContainer = dom.apiCardsContainer;
  const closeExclusivePanels = utils.closeExclusivePanels; // Or services.uiManager.closeExclusivePanels if preferred & ready

  // 为每个 API 配置提供稳定 ID
  function generateUUID() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (_) {}
    const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  }

  /**
   * 加载 API 配置
   * @returns {Promise<void>}
   */
  async function loadAPIConfigs() {
    try {
      const result = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
      if (result.apiConfigs && result.apiConfigs.length > 0) {
        apiConfigs = result.apiConfigs.map(config => ({ ...config }));
        selectedConfigIndex = result.selectedConfigIndex || 0;

        let needResave = false;
        // 兼容旧格式：如果 apiKey 是带逗号的字符串，则转换为数组；并确保有 id
        apiConfigs.forEach(config => {
          if (!config.id) { config.id = generateUUID(); needResave = true; }
          if (typeof config.apiKey === 'string' && config.apiKey.includes(',')) {
            config.apiKey = config.apiKey.split(',').map(k => k.trim()).filter(Boolean);
          }
          // 初始化 apiKeyUsageIndex
          if (Array.isArray(config.apiKey) && config.apiKey.length > 0) {
             const configId = getConfigIdentifier(config); // 使用唯一标识符
             apiKeyUsageIndex[configId] = 0;
          }
        });
        if (needResave) { await saveAPIConfigs(); }

      } else {
        // 创建默认配置
        apiConfigs = [{
          id: generateUUID(),
          apiKey: '', // 初始为空字符串
          baseUrl: 'https://api.openai.com/v1/chat/completions',
          modelName: 'gpt-4o',
          displayName: '',
          temperature: 1,
          isFavorite: false, // 添加收藏状态字段
          customParams: '',
          maxChatHistory: 500
        }];
        selectedConfigIndex = 0;
        await saveAPIConfigs();
      }
    } catch (error) {
      console.error('加载 API 配置失败:', error);
      // 如果加载失败，也创建默认配置
      apiConfigs = [{
        id: generateUUID(),
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        modelName: 'gpt-4o',
        displayName: '',
        temperature: 1,
        isFavorite: false,
        customParams: '',
        maxChatHistory: 500
      }];
      selectedConfigIndex = 0;
    }

    // 暴露 apiConfigs 到 window 对象 (向后兼容)
    window.apiConfigs = apiConfigs;
    // 触发配置更新事件
    (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));

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
      // 移除临时的 nextApiKeyIndex 状态再保存
      const configsToSave = apiConfigs.map(({ ...config }) => {
        // delete config.nextApiKeyIndex; // 不在 config 对象中保存索引
        return config;
      });
      await chrome.storage.sync.set({
        apiConfigs: configsToSave,
        selectedConfigIndex
      });
      // 更新 window.apiConfigs 并触发事件 (向后兼容)
      window.apiConfigs = apiConfigs; // 保持内存中的对象包含索引
      (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));
    } catch (error) {
      console.error('保存 API 配置失败:', error);
    }
  }

  /**
   * 生成配置的唯一标识符
   * @param {Object} config - API 配置对象
   * @returns {string} 唯一标识符
   */
  function getConfigIdentifier(config) {
    // 使用 baseUrl 和 modelName 组合作为唯一标识符
    return `${config.baseUrl}|${config.modelName}`;
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
    apiCardsContainer.innerHTML = '';

    // 先重新添加模板（保持隐藏状态）
    apiCardsContainer.appendChild(templateClone);

    // 渲染实际的卡
    apiConfigs.forEach((config, index) => {
      const card = createAPICard(config, index, templateClone);
      apiCardsContainer.appendChild(card);
    });
  }

  /**
   * 创建并渲染单个 API 配置卡片
   * @param {Object} config - API 配置对象
   * @param {string | string[]} [config.apiKey] - API 密钥 (可以是单个字符串或字符串数组)
   * @param {string} [config.baseUrl] - API 基础 URL
   * @param {string} [config.modelName] - 模型名称
   * @param {number} [config.temperature] - temperature 值（可为 0）
   * @param {boolean} [config.isFavorite] - 是否收藏
   * @param {string} [config.customParams] - 自定义参数
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
    const customParamsInput = template.querySelector('.custom-params');

    // 在 temperature 设置后添加最大聊天历史设置
    const maxHistoryGroup = document.createElement('div');
    maxHistoryGroup.className = 'form-group';
    
    const maxHistoryHeader = document.createElement('div');
    maxHistoryHeader.className = 'form-group-header';
    
    const maxHistoryLabel = document.createElement('label');
    maxHistoryLabel.textContent = '最大聊天历史';
    
    const maxHistoryValue = document.createElement('span');
    maxHistoryValue.className = 'max-history-value temperature-value';
    
    maxHistoryHeader.appendChild(maxHistoryLabel);
    maxHistoryHeader.appendChild(maxHistoryValue);
    
    const maxHistoryInput = document.createElement('input');
    maxHistoryInput.type = 'range';
    maxHistoryInput.className = 'max-chat-history temperature';
    maxHistoryInput.min = '10';
    maxHistoryInput.max = '500';
    maxHistoryInput.step = '5';

    // 初始化值与显示：500 => 无限制；其余按条数显示
    const currentMax = Number.isFinite(config.maxChatHistory) ? config.maxChatHistory : 500;
    const isUnlimited = currentMax >= 500;
    const clamped = Math.min(499, Math.max(10, isUnlimited ? 499 : currentMax));
    maxHistoryInput.value = isUnlimited ? '500' : String(clamped);
    maxHistoryValue.textContent = isUnlimited ? '无限制' : `${clamped}条`;
    
    maxHistoryGroup.appendChild(maxHistoryHeader);
    maxHistoryGroup.appendChild(maxHistoryInput);
    
    // 在自定义参数之前插入最大聊天历史设置
    const customParamsGroup = apiForm.querySelector('.form-group:last-child');
    apiForm.insertBefore(maxHistoryGroup, customParamsGroup);
    
    // 添加事件监听
    maxHistoryInput.addEventListener('input', () => {
      const v = parseInt(maxHistoryInput.value, 10);
      if (v >= 500) {
        maxHistoryValue.textContent = '无限制';
      } else {
        maxHistoryValue.textContent = `${v}条`;
      }
    });
    
    maxHistoryInput.addEventListener('change', () => {
      const v = parseInt(maxHistoryInput.value, 10);
      // 500 代表关闭限制，保存为一个极大值，message_sender 会按此视为“发送全部”
      apiConfigs[index].maxChatHistory = (v >= 500) ? 2147483647 : v;
      saveAPIConfigs();
    });

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
      apiSettingsPanel.classList.remove('visible');
       // 更新收藏列表状态
      renderFavoriteApis();
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

    // --- API Key 显示逻辑 ---
    if (Array.isArray(config.apiKey)) {
      apiKeyInput.value = config.apiKey.join(',');
    } else {
      apiKeyInput.value = config.apiKey ?? '';
    }
    // ------------------------

    baseUrlInput.value = config.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
    displayNameInput.value = config.displayName ?? '';
    modelNameInput.value = config.modelName ?? 'gpt-4o';
    temperatureInput.value = config.temperature ?? 1;
    temperatureValue.textContent = (config.temperature ?? 1).toFixed(1);
    customParamsInput.value = config.customParams || '';

    // 监听温度变化
    temperatureInput.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      temperatureValue.textContent = value.toFixed(1);
      apiConfigs[index].temperature = value;
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
      favoriteBtn.classList.toggle('active', apiConfigs[index].isFavorite);
      saveAPIConfigs();
      renderFavoriteApis();
    });

    // 阻止输入框和按钮点击事件冒泡
    const stopPropagation = (e) => e.stopPropagation();
    apiForm.addEventListener('click', stopPropagation);
    template.querySelector('.api-card-actions').addEventListener('click', stopPropagation);

    // --- 输入变化时保存 ---
    [baseUrlInput, displayNameInput, modelNameInput].forEach(input => {
      input.addEventListener('change', () => {
        apiConfigs[index] = {
          ...apiConfigs[index],
          baseUrl: baseUrlInput.value,
          displayName: displayNameInput.value,
          modelName: modelNameInput.value,
        };
        // 更新标题
        titleElement.textContent = apiConfigs[index].displayName || apiConfigs[index].modelName || apiConfigs[index].baseUrl || '新配置';
        saveAPIConfigs();
      });
    });

    // API Key 输入变化处理
    apiKeyInput.addEventListener('change', () => {
        const rawValue = apiKeyInput.value.trim();
        let newApiKeyValue;
        if (rawValue.includes(',')) {
            newApiKeyValue = rawValue.split(',').map(k => k.trim()).filter(Boolean);
            // 如果解析后只有一个key或没有key，则存为字符串
            if (newApiKeyValue.length <= 1) {
                newApiKeyValue = newApiKeyValue[0] || '';
            }
        } else {
            newApiKeyValue = rawValue;
        }

        apiConfigs[index].apiKey = newApiKeyValue;

        // 更新或初始化轮询索引状态
        const configId = getConfigIdentifier(apiConfigs[index]);
        if (Array.isArray(newApiKeyValue) && newApiKeyValue.length > 0) {
            apiKeyUsageIndex[configId] = 0; // 重置索引
        } else {
            delete apiKeyUsageIndex[configId]; // 删除不再需要的索引
        }

        saveAPIConfigs();
    });

    // 自定义参数处理
    customParamsInput.addEventListener('change', () => {
      apiConfigs[index].customParams = customParamsInput.value;
      saveAPIConfigs();
    });
    customParamsInput.addEventListener('blur', () => {
      const value = customParamsInput.value.trim();
       const errorElemId = `custom-params-error-${index}`;
       let errorElem = customParamsInput.parentNode.querySelector(`#${errorElemId}`);

      if (value === "") {
        customParamsInput.style.borderColor = "";
        if (errorElem) errorElem.remove();
        apiConfigs[index].customParams = "";
        saveAPIConfigs();
        return;
      }
      try {
        const parsed = JSON.parse(value);
        customParamsInput.value = JSON.stringify(parsed, null, 2);
        apiConfigs[index].customParams = customParamsInput.value;
        if (errorElem) errorElem.remove();
        customParamsInput.style.borderColor = "";
        saveAPIConfigs();
      } catch (e) {
        customParamsInput.style.borderColor = "red";
        if (!errorElem) {
          errorElem = document.createElement("div");
          errorElem.id = errorElemId; // 添加唯一ID
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

    // 复制配置
    template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const newConfig = { ...config, id: generateUUID() };
      // 重置 apiKey 轮询状态 (如果复制的是多 key 配置)
      const newConfigId = getConfigIdentifier(newConfig);
      if (Array.isArray(newConfig.apiKey) && newConfig.apiKey.length > 0) {
          apiKeyUsageIndex[newConfigId] = 0;
      }
      apiConfigs.push(newConfig);
      saveAPIConfigs();
      renderAPICards();
    });

    // 删除配置
    template.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (apiConfigs.length > 1) {
        const deletedConfig = apiConfigs.splice(index, 1)[0];
        // 删除对应的轮询状态
        const deletedConfigId = getConfigIdentifier(deletedConfig);
        delete apiKeyUsageIndex[deletedConfigId];

        if (selectedConfigIndex >= apiConfigs.length) {
          selectedConfigIndex = apiConfigs.length - 1;
        }
        // 如果删除的是当前选中的，需要更新选中项状态
        if (index === selectedConfigIndex && apiConfigs.length > 0) {
             // 默认选中第一个，或者最后一个如果索引超出
             selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));
        } else if (index < selectedConfigIndex) {
             // 如果删除的是选中项之前的，索引要减一
             selectedConfigIndex--;
        }

        saveAPIConfigs();
        renderAPICards();
        renderFavoriteApis(); // 更新收藏列表状态
      }
    });

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

      // 当前使用的API：按 id 对比
      if (currentConfig && currentConfig.id && config.id && currentConfig.id === config.id) {
        item.classList.add('current');
      }
      // ----------------------------------------------------------

      const apiName = document.createElement('span');
      apiName.className = 'api-name';
      apiName.textContent = config.displayName || config.modelName || config.baseUrl;

      item.appendChild(apiName);

      // 点击切换到该API配置
      item.addEventListener('click', () => {
        // --- 按 id 查找索引 ---
        const configIndex = apiConfigs.findIndex(c => c.id && c.id === config.id);

        if (configIndex !== -1 && configIndex !== selectedConfigIndex) {
          selectedConfigIndex = configIndex;
          saveAPIConfigs();
          renderAPICards(); // 重新渲染卡片以更新选中状态
          // 更新收藏列表状态
          renderFavoriteApis();
        }
         // 关闭设置菜单
        apiSettingsPanel.classList.remove('visible');
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
    let requestBody = {};

    if (config.baseUrl === 'genai') {
      // Gemini API 请求格式
      const contents = messages.map(msg => {
        // Gemini API 使用 'user' 和 'model' 角色
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        // Gemini API 将 'system' 消息作为单独的 systemInstruction
        if (msg.role === 'system') {
          return null; // 在后面单独处理
        }

        const parts = [];
        if (Array.isArray(msg.content)) { // OpenAI Vision 格式 (文本和/或图片)
          msg.content.forEach(item => {
            if (item.type === 'text') {
              parts.push({ text: item.text });
            } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              const dataUrl = item.image_url.url;
              // 从 dataUrl 中提取 mime_type 和 base64 数据
              // dataUrl 格式: "data:[<mime_type>];base64,<data>"
              // 支持常见的图片类型: jpeg, png, gif, webp
              const match = dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
              if (match) {
                parts.push({
                  inline_data: {
                    mime_type: match[1], // 例如 "image/jpeg"
                    data: match[2]       // Base64 编码的图片数据
                  }
                });
              } else {
                console.warn('不支持的图片数据URL格式或MIME类型 (Gemini):', dataUrl.substring(0, 30) + "...");
                // 如果格式不匹配，可以考虑将原始文本作为回退（如果适用）
                // 或者在此处不添加任何 part，具体取决于期望的行为
              }
            }
          });
        } else if (typeof msg.content === 'string') { // 纯文本消息
          parts.push({ text: msg.content });
        } else {
            console.warn('未知的消息内容格式 (Gemini):', msg.content);
        }
        
        // 只有当 parts 数组不为空时才创建 content 对象
        if (parts.length > 0) {
            return { role: role, parts: parts };
        }
        return null; // 如果没有有效的 parts，则不为此消息创建 content entry
      }).filter(Boolean); // 过滤掉 null (例如 system 消息或无效消息)

      requestBody = {
        contents: contents,
        generationConfig: {
          responseMimeType: "text/plain",
          temperature: config.temperature ?? 1.0,
          topP: 0.95, // Gemini 使用 topP 而不是 top_p
        },
        ...overrides
      };

      // 处理 system 消息
      const systemMessage = messages.find(msg => msg.role === 'system');
      if (systemMessage && systemMessage.content) {
        requestBody.systemInstruction = {
          // 根据Gemini API文档，systemInstruction是Content类型，其role是可选的 ('user'或'model')
          // 对于系统指令，通常不指定role或留空
          parts: [{ text: systemMessage.content }]
        };
      }
       // 如果存在自定义参数，解析并合并到 generationConfig
      if (config.customParams) {
        try {
          const allCustomParams = JSON.parse(config.customParams);
          const { tools, ...generationCustomParams } = allCustomParams; // 分离 tools 和其他参数

          if (tools && Array.isArray(tools)) {
            requestBody.tools = tools; // 将 tools 添加到请求体的根级别
          }
          
          // 将剩余的自定义参数合并到 generationConfig
          if (Object.keys(generationCustomParams).length > 0) {
            requestBody.generationConfig = { 
              ...requestBody.generationConfig, 
              ...generationCustomParams 
            };
          }
        } catch (e) {
          console.error("解析自定义参数 JSON 失败 (Gemini)，请检查格式。", e);
        }
      }

    } else {
      // 其他 API (如 OpenAI) 请求格式
      requestBody = {
        model: config.modelName,
        messages: messages, // OpenAI API可以直接处理包含图片数组的 messages
        stream: true,
        temperature: config.temperature ?? 1.0, // 确保有默认值
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
   * @throws {Error} 如果 API Key 无效或缺失
   */
  async function sendRequest({ requestBody, config, signal }) {
    let selectedKey = '';
    const configId = getConfigIdentifier(config);

    // --- API Key 选择逻辑 ---
    if (Array.isArray(config.apiKey) && config.apiKey.length > 0) {
      // 轮询获取 Key
      const currentIndex = apiKeyUsageIndex[configId] || 0;
      selectedKey = config.apiKey[currentIndex];
      // 更新下次使用的索引
      apiKeyUsageIndex[configId] = (currentIndex + 1) % config.apiKey.length;
    } else if (typeof config.apiKey === 'string' && config.apiKey) {
      // 单个 Key
      selectedKey = config.apiKey;
    } else {
      // 没有有效的 Key
      console.error('API Key 缺失或无效:', config);
      throw new Error(`API Key for ${config.displayName || config.modelName} is missing or invalid.`);
    }
    // ------------------------

    if (!selectedKey) {
         console.error('Selected API Key is empty:', config);
         throw new Error(`Selected API Key for ${config.displayName || config.modelName} is empty.`);
    }

    let endpointUrl = config.baseUrl;
    const headers = {
      'Content-Type': 'application/json',
    };

    if (config.baseUrl === 'genai') {
      // Gemini API endpoint 和 key 参数
      // modelName 示例: "gemini-2.5-flash-preview-0520" or "gemini-2.5-pro-preview-0506"
      endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.modelName}:streamGenerateContent?key=${selectedKey}&alt=sse`;
      // Gemini API 不需要 Authorization Bearer token header
    } else {
      // 其他 API (如 OpenAI)
      headers['Authorization'] = `Bearer ${selectedKey}`;
    }

    return fetch(endpointUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody),
      signal
    });
  }

  /**
   * 设置UI事件处理
   * @param {HTMLElement} apiSettingsToggle - API设置切换按钮
   * @param {HTMLElement} backButton - 返回按钮
   */
  function setupUIEventHandlers(appContextForSetup) {
    const currentAppContext = appContextForSetup || appContext;
    const toggleButton = currentAppContext.dom.apiSettingsToggle;
    const panel = currentAppContext.dom.apiSettingsPanel;
    const backButtonElement = currentAppContext.dom.apiSettingsBackButton;

    // 显示/隐藏 API 设置
    toggleButton.addEventListener('click', () => {
      const wasVisible = panel.classList.contains('visible');
      (currentAppContext.utils.closeExclusivePanels || currentAppContext.services.uiManager.closeExclusivePanels)();

      if (!wasVisible) {
        panel.classList.toggle('visible');
        loadAPIConfigs().then(() => {
            renderAPICards(); // 确保加载最新配置后渲染
            renderFavoriteApis();
        });
      }
    });

    // 返回聊天界面
    backButtonElement.addEventListener('click', () => {
      panel.classList.remove('visible');
    });
  }

  /**
   * 获取模型配置
   * @param {string} [promptType] - 提示词类型
   * @param {Object} promptsConfig - 提示词设置
   * @param {number} [messagesCount] - 当前对话的消息数量 (可选)
   * @returns {Object} 选中的API配置
   */
  function getModelConfig(promptType, promptsConfig, messagesCount) {
    const SHORT_CONVO_DISPLAY_NAME = "[S]"; // 用于短对话的配置标识
    const MEDIUM_CONVO_DISPLAY_NAME = "[M]"; // 用于中等长度对话的配置标识

    // 2. 检查特定提示词类型是否指定了特定模型 (原有逻辑)
    if (promptType && promptsConfig && promptsConfig[promptType]?.model) {
      const preferredValue = String(promptsConfig[promptType].model || '').trim();
      if (preferredValue) {
        // 支持 id 优先；回退 displayName；再回退 modelName
        let config = apiConfigs.find(c => c.id && c.id === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.displayName || '').trim() === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.modelName || '').trim() === preferredValue);
        if (config) {
          console.log(`根据 promptType "${promptType}" 使用配置: ${config.displayName || config.modelName}`);
          return config;
        }
        console.log(`未找到 promptType "${promptType}" 指定的配置 "${preferredValue}"，将使用默认选中配置。`);
      }
    }

    // 1. 检查对话长度并尝试查找特定配置
    if (messagesCount !== undefined) {
      if (messagesCount < 50) {
        const shortConvoConfig = apiConfigs.find(c => c.displayName?.includes(SHORT_CONVO_DISPLAY_NAME));
        if (shortConvoConfig) {
          console.log(`使用短对话配置: ${shortConvoConfig.displayName}`);
          return shortConvoConfig;
        }
        console.log(`未找到displayName包含"${SHORT_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      } else if (messagesCount < 300) {
        const mediumConvoConfig = apiConfigs.find(c => c.displayName?.includes(MEDIUM_CONVO_DISPLAY_NAME));
        if (mediumConvoConfig) {
          console.log(`使用中等长度对话配置: ${mediumConvoConfig.displayName}`);
          return mediumConvoConfig;
        }
        console.log(`未找到displayName包含"${MEDIUM_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      }
    }
    // 3. 如果没有特定模型配置或找不到，使用当前选中的配置 (原有逻辑)
    const selectedConfig = apiConfigs[selectedConfigIndex] || apiConfigs[0]; // 保证总有返回值
    console.log(`使用当前选中配置: ${selectedConfig?.displayName || selectedConfig?.modelName}`);
    return selectedConfig;
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

    // 尝试按 baseUrl 和 modelName 查找现有配置
    let matchedConfig = apiConfigs.find(config =>
      (partialConfig.id && config.id === partialConfig.id) ||
      (config.baseUrl === partialConfig.baseUrl && config.modelName === partialConfig.modelName)
    );

    // 如果找到完全匹配，返回该配置 (确保包含 apiKey 和轮询状态)
    if (matchedConfig) {
        // 确保返回的对象有 apiKey 和可能的轮询状态
        const configId = getConfigIdentifier(matchedConfig);
        return {
            ...matchedConfig,
            // nextApiKeyIndex: apiKeyUsageIndex[configId] || 0 // 附加轮询状态
        };
    }

    // 如果没有找到完全匹配，尝试仅按 URL 匹配以获取可能的 API Key
    const urlMatchedConfig = apiConfigs.find(config => config.baseUrl === partialConfig.baseUrl);

    // 获取当前选中配置的 apiKey 作为备选
    const currentSelectedConfig = apiConfigs[selectedConfigIndex];
    const fallbackApiKey = currentSelectedConfig ? currentSelectedConfig.apiKey : '';

    // 创建新的配置对象
    const newConfig = {
      baseUrl: partialConfig.baseUrl,
      // 优先使用 URL 匹配到的配置的 apiKey，其次是当前选中的，最后是空字符串
      // 注意：这里 apiKey 可能是数组或字符串
      apiKey: urlMatchedConfig?.apiKey || fallbackApiKey || '',
      modelName: partialConfig.modelName,
      displayName: partialConfig.displayName || '',
      temperature: partialConfig.temperature ?? 1.0,
      customParams: partialConfig.customParams || '',
      maxChatHistory: 500, // 添加默认值
      // isFavorite: false // 新创建的默认不收藏
    };

     // 初始化新配置的轮询状态
    const newConfigId = getConfigIdentifier(newConfig);
    if (Array.isArray(newConfig.apiKey) && newConfig.apiKey.length > 0) {
         apiKeyUsageIndex[newConfigId] = 0;
    }

    return newConfig;
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
    getSelectedConfig: () => {
        const config = apiConfigs[selectedConfigIndex];
        // if (config) {
        //     const configId = getConfigIdentifier(config);
        //     // 返回时附加当前的轮询索引
        //     return { ...config, nextApiKeyIndex: apiKeyUsageIndex[configId] || 0 };
        // }
        return config; // 返回内存中的配置对象
    },
    getAllConfigs: () => [...apiConfigs], // 返回包含轮询状态的配置副本
    getSelectedIndex: () => selectedConfigIndex,
    setSelectedIndex: (index) => {
      if (index >= 0 && index < apiConfigs.length) {
        selectedConfigIndex = index;
        saveAPIConfigs(); // 保存选中的索引
        renderAPICards(); // 更新卡片选中状态
        renderFavoriteApis(); // 更新收藏列表选中状态
        return true;
      }
      return false;
    },

    // 添加新配置
    addConfig: (config) => {
        // 确保新配置有必要的字段
        const newConfig = {
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1/chat/completions',
            modelName: 'new-model',
            displayName: '新配置',
            temperature: 1,
            isFavorite: false,
            customParams: '',
            maxChatHistory: 500, // 添加默认值
            ...config // 允许传入部分或完整配置覆盖默认值
        };
        // 处理传入的 apiKey 格式
        if (typeof newConfig.apiKey === 'string' && newConfig.apiKey.includes(',')) {
            newConfig.apiKey = newConfig.apiKey.split(',').map(k => k.trim()).filter(Boolean);
        }
         // 初始化轮询状态
        const newConfigId = getConfigIdentifier(newConfig);
        if (Array.isArray(newConfig.apiKey) && newConfig.apiKey.length > 0) {
            apiKeyUsageIndex[newConfigId] = 0;
        }

        apiConfigs.push(newConfig);
        saveAPIConfigs();
        renderAPICards();
        renderFavoriteApis();
    }
  };
} 