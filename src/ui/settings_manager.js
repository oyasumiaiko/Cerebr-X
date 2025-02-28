/**
 * 设置管理模块
 * 负责管理应用程序的所有用户界面设置，如主题、尺寸、字体大小等
 */

import { createThemeManager } from './theme_manager.js';

/**
 * 创建设置管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.themeSwitch - 主题切换开关元素
 * @param {HTMLElement} options.themeSelect - 主题选择下拉框元素
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
 * @param {HTMLElement} options.sidebarPositionSwitch - 侧边栏位置开关元素
 * @param {Function} options.setMessageSenderChatHistory - 设置消息发送器的聊天历史开关状态
 * @returns {Object} 设置管理器实例
 */
export function createSettingsManager(options) {
  // 从options中提取UI元素
  const {
    themeSwitch,
    themeSelect,
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
    sidebarPositionSwitch,
    setMessageSenderChatHistory
  } = options;

  // 创建主题管理器
  const themeManager = createThemeManager();

  // 默认设置
  const DEFAULT_SETTINGS = {
    theme: 'auto',  // 默认为自动跟随系统
    sidebarWidth: 800,
    fontSize: 14,
    scaleFactor: 1.0,
    autoScroll: true,
    clearOnSearch: true,
    shouldSendChatHistory: true,
    showReference: true,
    sidebarPosition: 'right' // 'left' 或 'right'
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
    
    // 应用侧边栏位置设置
    applySidebarPosition(currentSettings.sidebarPosition);
  }
  
  // 应用主题
  function applyTheme(themeValue) {
    // 使用主题管理器应用主题
    themeManager.applyTheme(themeValue);
    
    // 更新主题选择下拉框
    if (themeSelect) {
      themeSelect.value = themeValue;
    }
    
    // 更新开关状态 - 仅当使用dark主题或其变种时才打开开关
    if (themeSwitch) {
      const isDark = themeValue === 'dark' || 
                     themeValue.includes('dark') || 
                     themeValue === 'monokai' || 
                     themeValue === 'nord' || 
                     themeValue === 'vscode-dark' || 
                     themeValue === 'night-blue';
      
      const isAuto = themeValue === 'auto';
      
      if (isAuto) {
        // 如果是自动模式，根据系统设置决定开关状态
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        themeSwitch.checked = prefersDark;
      } else {
        themeSwitch.checked = isDark;
      }
    }
    
    // 通知主题管理器主题变更
    themeManager.notifyThemeChange(themeValue);
    
    // 更新主题预览卡片活动状态（不会重新渲染导致菜单关闭）
    updateThemePreviewActiveState(themeValue);
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
  
  // 应用侧边栏位置设置
  function applySidebarPosition(position) {
    // 更新UI元素
    if (sidebarPositionSwitch) {
      sidebarPositionSwitch.checked = position === 'right';
    }
    
    const collapseButton = document.getElementById('collapse-button');
    if (collapseButton) {
      if (position === 'left') {
        collapseButton.classList.add('position-left');
      } else {
        collapseButton.classList.remove('position-left');
      }
    }
    
    // 通知父窗口侧边栏位置变化
    notifySidebarPositionChange(position);
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
  
  // 通知侧边栏位置变化
  function notifySidebarPositionChange(position) {
    console.log(`发送侧边栏位置变化通知: ${position}`);
    window.parent.postMessage({
      type: 'SIDEBAR_POSITION_CHANGE',
      position: position
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
    // 主题切换监听
    if (themeSwitch) {
      themeSwitch.addEventListener('change', function() {
        // 获取当前选择的主题
        const currentTheme = themeSelect ? themeSelect.value : 'auto';
        
        if (currentTheme === 'auto') {
          // 自动模式下不改变主题，仅调整反馈UI
          applyTheme('auto');
          return;
        }
        
        // 查找是否存在对应的亮色/暗色主题对
        const isCurrentlyDark = currentTheme.includes('dark') || 
                               currentTheme === 'monokai' || 
                               currentTheme === 'nord' || 
                               currentTheme === 'vscode-dark' || 
                               currentTheme === 'night-blue';
        
        let newTheme = currentTheme;
        
        // 尝试切换到对应的明暗主题
        if (this.checked && !isCurrentlyDark) {
          // 切换到暗色
          if (currentTheme === 'light') newTheme = 'dark';
          else if (currentTheme === 'github-light') newTheme = 'github-dark';
          else if (currentTheme === 'solarized-light') newTheme = 'solarized-dark';
          else newTheme = 'dark'; // 默认暗色
        } else if (!this.checked && isCurrentlyDark) {
          // 切换到亮色
          if (currentTheme === 'dark') newTheme = 'light';
          else if (currentTheme === 'github-dark') newTheme = 'github-light';
          else if (currentTheme === 'solarized-dark') newTheme = 'solarized-light';
          else newTheme = 'light'; // 默认亮色
        }
        
        if (newTheme !== currentTheme) {
          setTheme(newTheme);
          if (themeSelect) {
            themeSelect.value = newTheme;
          }
        }
      });
    }
    
    // 主题选择下拉框监听
    if (themeSelect) {
      // 初始化主题选项
      populateThemeOptions();
      
      themeSelect.addEventListener('change', function() {
        const selectedTheme = this.value;
        setTheme(selectedTheme);
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
    
    // 侧边栏位置开关
    if (sidebarPositionSwitch) {
      sidebarPositionSwitch.addEventListener('change', (e) => {
        setSidebarPosition(e.target.checked ? 'right' : 'left');
      });
    }
  }
  
  // 填充主题选项
  function populateThemeOptions() {
    if (!themeSelect) return;
    
    // 清空现有选项
    themeSelect.innerHTML = '';
    
    // 获取所有可用主题
    const themes = themeManager.getAvailableThemes();
    
    // 添加主题选项
    themes.forEach(theme => {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.name;
      if (theme.description) {
        option.title = theme.description;
      }
      themeSelect.appendChild(option);
    });
    
    // 设置当前选中的主题
    themeSelect.value = currentSettings.theme;
    
    // 渲染主题预览卡片
    updateThemePreview();
  }
  
  // 更新主题预览，在主题变更后调用
  function updateThemePreview() {
    const previewContainer = document.querySelector('.theme-preview-grid');
    if (previewContainer) {
      themeManager.renderThemePreview(previewContainer, (themeId) => {
        setTheme(themeId);
        if (themeSelect) {
          themeSelect.value = themeId;
        }
      });
    }
  }
  
  // 只更新主题预览卡片的active状态，不重新渲染预览网格
  function updateThemePreviewActiveState(themeId) {
    const previewCards = document.querySelectorAll('.theme-preview-card');
    if (previewCards.length === 0) return; // 如果没有预览卡片，不做任何操作
    
    // 移除所有卡片的active类
    previewCards.forEach(card => {
      card.classList.remove('active');
    });
    
    // 为当前主题的卡片添加active类
    const activeCard = document.querySelector(`.theme-preview-card[data-theme-id="${themeId}"]`);
    if (activeCard) {
      activeCard.classList.add('active');
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
  
  // 设置侧边栏位置
  function setSidebarPosition(position) {
    console.log(`设置侧边栏位置: ${position}`);
    currentSettings.sidebarPosition = position;
    applySidebarPosition(position);
    saveSetting('sidebarPosition', position);
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
    // 先初始化主题管理器
    themeManager.init();
    
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
    setSidebarPosition,
    updateReferenceVisibility,
    applyTheme
  };
} 