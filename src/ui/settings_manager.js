/**
 * 设置管理模块
 * 负责管理应用程序的所有用户界面设置，如主题、尺寸、字体大小等
 */

/**
 * 创建设置管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.themeSwitch - 主题切换开关元素
 * @param {HTMLElement} options.sidebarWidth - 侧边栏宽度滑块元素
 * @param {HTMLElement} options.widthValue - 宽度显示值元素
 * @param {HTMLElement} options.fontSize - 字体大小滑块元素
 * @param {HTMLElement} options.fontSizeValue - 字体大小显示值元素
 * @param {HTMLElement} options.scaleFactor - 缩放比例滑块元素 
 * @param {HTMLElement} options.scaleValue - 缩放比例显示值元素
 * @param {HTMLElement} options.autoScrollSwitch - 自动滚动开关元素
 * @param {HTMLElement} options.clearOnSearchSwitch - 划词搜索清空聊天开关元素
 * @param {HTMLElement} options.sendChatHistorySwitch - 发送聊天历史开关元素
 * @param {HTMLElement} options.showReferenceSwitch - 显示引用标记开关元素
 * @param {Function} options.setMessageSenderChatHistory - 设置消息发送器的聊天历史开关状态
 * @returns {Object} 设置管理器实例
 */
export function createSettingsManager(options) {
  // 从options中提取UI元素
  const {
    themeSwitch,
    sidebarWidth,
    widthValue,
    fontSize,
    fontSizeValue,
    scaleFactor,
    scaleValue,
    autoScrollSwitch,
    clearOnSearchSwitch,
    sendChatHistorySwitch,
    showReferenceSwitch,
    setMessageSenderChatHistory
  } = options;

  // 默认设置
  const DEFAULT_SETTINGS = {
    theme: 'auto',  // 'light', 'dark', 'auto'
    sidebarWidth: 800,
    fontSize: 14,
    scaleFactor: 1.0,
    autoScroll: true,
    clearOnSearch: true,
    shouldSendChatHistory: true,
    showReference: true
  };

  // 当前设置
  let currentSettings = {...DEFAULT_SETTINGS};
  
  // 初始化所有设置
  async function initSettings() {
    try {
      console.log('初始化设置...');
      const result = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
      
      // 合并默认设置和已保存的设置
      currentSettings = {...DEFAULT_SETTINGS, ...result};
      
      // 应用所有设置到UI
      applyAllSettings();
      
      console.log('设置初始化完成');
    } catch (error) {
      console.error('初始化设置失败:', error);
    }
  }
  
  // 保存单个设置
  async function saveSetting(key, value) {
    try {
      currentSettings[key] = value;
      await chrome.storage.sync.set({ [key]: value });
    } catch (error) {
      console.error(`保存设置${key}失败:`, error);
    }
  }
  
  // 应用所有设置到UI
  function applyAllSettings() {
    // 应用主题
    applyTheme(currentSettings.theme);
    
    // 应用侧边栏宽度
    applySidebarWidth(currentSettings.sidebarWidth);
    
    // 应用字体大小
    applyFontSize(currentSettings.fontSize);
    
    // 应用缩放比例
    applyScaleFactor(currentSettings.scaleFactor);
    
    // 应用自动滚动设置
    applyAutoScroll(currentSettings.autoScroll);
    
    // 应用划词搜索清空聊天设置
    applyClearOnSearch(currentSettings.clearOnSearch);
    
    // 应用发送聊天历史设置
    applySendChatHistory(currentSettings.shouldSendChatHistory);
    
    // 应用显示引用标记设置
    applyShowReference(currentSettings.showReference);
  }
  
  // 应用主题
  function applyTheme(themeValue) {
    const root = document.documentElement;
    root.classList.remove('dark-theme', 'light-theme');
    
    let isDark = false;
    
    if (themeValue === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      isDark = prefersDark;
    } else {
      isDark = themeValue === 'dark';
    }
    
    root.classList.add(isDark ? 'dark-theme' : 'light-theme');
    
    // 更新开关状态
    if (themeSwitch) {
      themeSwitch.checked = isDark;
    }
  }
  
  // 应用侧边栏宽度
  function applySidebarWidth(width) {
    document.documentElement.style.setProperty('--cerebr-sidebar-width', `${width}px`);
    
    // 更新UI元素
    if (sidebarWidth) {
      sidebarWidth.value = width;
    }
    
    if (widthValue) {
      widthValue.textContent = `${width}px`;
    }
    
    // 通知父窗口宽度变化
    notifySidebarWidthChange(width);
  }
  
  // 应用字体大小
  function applyFontSize(size) {
    document.documentElement.style.setProperty('--cerebr-font-size', `${size}px`);
    
    // 更新UI元素
    if (fontSize) {
      fontSize.value = size;
    }
    
    if (fontSizeValue) {
      fontSizeValue.textContent = `${size}px`;
    }
  }
  
  // 应用缩放比例
  function applyScaleFactor(value) {
    // 更新UI元素
    if (scaleFactor) {
      scaleFactor.value = value;
    }
    
    if (scaleValue) {
      scaleValue.textContent = `${value.toFixed(1)}x`;
    }
    
    // 通知父窗口缩放比例变化
    notifyScaleFactorChange(value);
  }
  
  // 应用自动滚动设置
  function applyAutoScroll(enabled) {
    // 更新UI元素
    if (autoScrollSwitch) {
      autoScrollSwitch.checked = enabled;
    }
  }
  
  // 应用划词搜索清空聊天设置
  function applyClearOnSearch(enabled) {
    // 更新UI元素
    if (clearOnSearchSwitch) {
      clearOnSearchSwitch.checked = enabled;
    }
  }
  
  // 应用发送聊天历史设置
  function applySendChatHistory(enabled) {
    // 更新UI元素
    if (sendChatHistorySwitch) {
      sendChatHistorySwitch.checked = enabled;
    }
    
    // 更新消息发送器设置
    if (setMessageSenderChatHistory) {
      setMessageSenderChatHistory(enabled);
    }
  }
  
  // 应用显示引用标记设置
  function applyShowReference(enabled) {
    updateReferenceVisibility(enabled);
    
    // 更新UI元素
    if (showReferenceSwitch) {
      showReferenceSwitch.checked = enabled;
    }
  }
  
  // 更新引用标记可见性
  function updateReferenceVisibility(shouldShow) {
    if (shouldShow) {
      document.body.classList.remove('hide-references');
    } else {
      document.body.classList.add('hide-references');
    }
  }
  
  // 通知侧边栏宽度变化
  function notifySidebarWidthChange(width) {
    window.parent.postMessage({
      type: 'SIDEBAR_WIDTH_CHANGE',
      width: parseInt(width)
    }, '*');
  }
  
  // 通知缩放比例变化
  function notifyScaleFactorChange(value) {
    window.parent.postMessage({
      type: 'SCALE_FACTOR_CHANGE',
      value: value
    }, '*');
  }
  
  // 监听系统主题变化
  function setupSystemThemeListener() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (currentSettings.theme === 'auto') {
        applyTheme('auto');
      }
    });
  }
  
  // 设置UI元素事件处理
  function setupEventListeners() {
    // 主题开关
    if (themeSwitch) {
      themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked ? 'dark' : 'light');
      });
    }
    
    // 侧边栏宽度滑块
    if (sidebarWidth) {
      sidebarWidth.addEventListener('input', (e) => {
        if (widthValue) {
          widthValue.textContent = `${e.target.value}px`;
        }
      });
      
      sidebarWidth.addEventListener('change', (e) => {
        setSidebarWidth(parseInt(e.target.value));
      });
    }
    
    // 字体大小滑块
    if (fontSize) {
      fontSize.addEventListener('input', (e) => {
        if (fontSizeValue) {
          fontSizeValue.textContent = `${e.target.value}px`;
        }
      });
      
      fontSize.addEventListener('change', (e) => {
        setFontSize(parseInt(e.target.value));
      });
    }
    
    // 缩放比例滑块
    if (scaleFactor) {
      scaleFactor.addEventListener('input', (e) => {
        if (scaleValue) {
          scaleValue.textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
        }
      });
      
      scaleFactor.addEventListener('change', (e) => {
        setScaleFactor(parseFloat(e.target.value));
      });
    }
    
    // 自动滚动开关
    if (autoScrollSwitch) {
      autoScrollSwitch.addEventListener('change', (e) => {
        setAutoScroll(e.target.checked);
      });
    }
    
    // 划词搜索清空聊天开关
    if (clearOnSearchSwitch) {
      clearOnSearchSwitch.addEventListener('change', (e) => {
        setClearOnSearch(e.target.checked);
      });
    }
    
    // 发送聊天历史开关
    if (sendChatHistorySwitch) {
      sendChatHistorySwitch.addEventListener('change', (e) => {
        setSendChatHistory(e.target.checked);
      });
    }
    
    // 显示引用标记开关
    if (showReferenceSwitch) {
      showReferenceSwitch.addEventListener('change', (e) => {
        setShowReference(e.target.checked);
      });
    }
  }
  
  // ===== 设置操作方法 =====
  
  // 设置主题
  function setTheme(theme) {
    const themeValue = theme === true ? 'dark' : theme === false ? 'light' : theme;
    currentSettings.theme = themeValue;
    applyTheme(themeValue);
    saveSetting('theme', themeValue);
  }
  
  // 设置侧边栏宽度
  function setSidebarWidth(width) {
    currentSettings.sidebarWidth = width;
    applySidebarWidth(width);
    saveSetting('sidebarWidth', width);
  }
  
  // 设置字体大小
  function setFontSize(size) {
    currentSettings.fontSize = size;
    applyFontSize(size);
    saveSetting('fontSize', size);
  }
  
  // 设置缩放比例
  function setScaleFactor(value) {
    currentSettings.scaleFactor = value;
    applyScaleFactor(value);
    saveSetting('scaleFactor', value);
  }
  
  // 设置自动滚动
  function setAutoScroll(enabled) {
    currentSettings.autoScroll = enabled;
    applyAutoScroll(enabled);
    saveSetting('autoScroll', enabled);
  }
  
  // 设置划词搜索清空聊天
  function setClearOnSearch(enabled) {
    currentSettings.clearOnSearch = enabled;
    applyClearOnSearch(enabled);
    saveSetting('clearOnSearch', enabled);
  }
  
  // 设置发送聊天历史
  function setSendChatHistory(enabled) {
    currentSettings.shouldSendChatHistory = enabled;
    applySendChatHistory(enabled);
    saveSetting('shouldSendChatHistory', enabled);
  }
  
  // 设置显示引用标记
  function setShowReference(enabled) {
    currentSettings.showReference = enabled;
    applyShowReference(enabled);
    saveSetting('showReference', enabled);
  }
  
  // 获取当前设置
  function getSettings() {
    return {...currentSettings};
  }
  
  // 获取单个设置
  function getSetting(key) {
    return currentSettings[key];
  }
  
  // 初始化
  function init() {
    setupEventListeners();
    setupSystemThemeListener();
    return initSettings();
  }
  
  // 公开的API
  return {
    init,
    getSettings,
    getSetting,
    setTheme,
    setSidebarWidth,
    setFontSize,
    setScaleFactor,
    setAutoScroll,
    setClearOnSearch,
    setSendChatHistory,
    setShowReference,
    updateReferenceVisibility,
    applyTheme
  };
} 