/**
 * 设置管理模块
 * 负责管理应用程序的所有用户界面设置，如主题、尺寸、字体大小等
 */

import { createThemeManager } from './theme_manager.js';

/**
 * 创建设置管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.themeSwitch - 主题切换开关元素
 * @param {HTMLElement} appContext.dom.themeSelect - 主题选择下拉框元素
 * @param {HTMLElement} appContext.dom.sidebarWidthSlider - 侧边栏宽度滑块元素
 * @param {HTMLElement} appContext.dom.widthValueDisplay - 宽度显示值元素
 * @param {HTMLElement} appContext.dom.fontSizeSlider - 字体大小滑块元素
 * @param {HTMLElement} appContext.dom.fontSizeValueDisplay - 字体大小显示值元素
 * @param {HTMLElement} appContext.dom.scaleFactorSlider - 缩放比例滑块元素
 * @param {HTMLElement} appContext.dom.scaleValueDisplay - 缩放比例显示值元素
 * @param {HTMLElement} appContext.dom.autoScrollSwitch - 自动滚动开关元素
 * @param {HTMLElement} appContext.dom.clearOnSearchSwitch - 划词搜索清空聊天开关元素
 * @param {HTMLElement} appContext.dom.sendChatHistorySwitch - 发送聊天历史开关元素
 * @param {HTMLElement} appContext.dom.showReferenceSwitch - 显示引用标记开关元素
 * @param {HTMLElement} appContext.dom.sidebarPositionSwitch - 侧边栏位置开关元素
 * @param {HTMLElement} appContext.dom.stopAtTopSwitch - 滚动到顶部时停止开关元素
 * @param {HTMLElement} appContext.dom.showThoughtProcessSwitch - 显示思考过程开关元素
 * @param {HTMLElement} appContext.dom.resetSettingsButton - 重置设置按钮元素
 * @param {HTMLElement} appContext.dom.settingsPanel - 设置面板元素
 * @param {HTMLElement} appContext.dom.settingsToggle - 设置面板切换按钮元素
 * @param {HTMLElement} appContext.dom.settingsBackButton - 设置面板返回按钮元素
 * @param {Function} appContext.services.messageSender.setSendChatHistory - 设置消息发送器的聊天历史开关状态
 * @param {Function} appContext.services.uiManager.closeExclusivePanels - 关闭独占面板的函数
 * @returns {Object} 设置管理器实例
 */
export function createSettingsManager(appContext) {
  // 从options中提取UI元素
  const {
    dom,
    services,
    utils
  } = appContext;

  // UI elements from appContext.dom
  const themeSwitch = dom.themeSwitch;
  const themeSelect = dom.themeSelect;
  const sidebarWidthSlider = dom.sidebarWidth;
  const widthValueDisplay = dom.widthValue;
  const fontSizeSlider = dom.fontSize;
  const fontSizeValueDisplay = dom.fontSizeValue;
  const scaleFactorSlider = dom.scaleFactor;
  const scaleValueDisplay = dom.scaleValue;
  const autoScrollSwitch = dom.autoScrollSwitch;
  const clearOnSearchSwitch = dom.clearOnSearchSwitch;
  const sendChatHistorySwitch = dom.sendChatHistorySwitch;
  const showReferenceSwitch = dom.showReferenceSwitch;
  const sidebarPositionSwitch = dom.sidebarPositionSwitch;
  const stopAtTopSwitch = dom.stopAtTopSwitch;
  const showThoughtProcessSwitch = dom.showThoughtProcessSwitch;
  const resetSettingsButton = dom.resetSettingsButton;
  const settingsPanel = dom.settingsMenu;
  const settingsToggle = dom.settingsButton;
  const settingsBackButton = dom.settingsBackButton;

  // Services from appContext.services
  const messageSender = services.messageSender;
  // const themeManagerService = services.themeManager; // If themeManager is a shared service
  const uiManager = services.uiManager; // For closeExclusivePanels

  // Utils
  const showNotification = utils.showNotification;
  const closeExclusivePanels = utils.closeExclusivePanels;

  // 创建主题管理器 (could be a service in appContext too)
  const themeManager = createThemeManager();

  // 默认设置
  const DEFAULT_SETTINGS = {
    theme: 'auto',  // 默认为自动跟随系统
    sidebarWidth: 800,
    fontSize: 14,
    lineHeight: 1.5, // Added for better text readability control
    chatWidth: 100, // Percentage of sidebar width
    autoScroll: true,
    clearOnSearch: true, // This might be specific to a search feature, not a general setting
    shouldSendChatHistory: true,
    showReference: true,
    sidebarPosition: 'right', // 'left' 或 'right'
    stopAtTop: true, // 滚动到顶部时停止
    scaleFactor: 1 // Added default scaleFactor
  };

  // 当前设置
  let currentSettings = {...DEFAULT_SETTINGS};

  // 动态设置注册表：新增设置仅需在此处登记即可自动渲染与持久化
  // type: 'toggle' | 'range' | 'select'
  const SETTINGS_REGISTRY = [
    // 主题（复用现有隐藏下拉框，不额外渲染）
    {
      key: 'theme',
      type: 'select',
      id: 'theme-select',
      label: '主题选择',
      options: () => (themeManager.getAvailableThemes?.() || []).map(t => ({ label: t.name, value: t.id })),
      defaultValue: DEFAULT_SETTINGS.theme,
      apply: (v) => applyTheme(v)
    },
    // 自动滚动
    {
      key: 'autoScroll',
      type: 'toggle',
      id: 'auto-scroll-switch',
      label: '自动滚动',
      defaultValue: DEFAULT_SETTINGS.autoScroll,
      apply: (v) => applyAutoScroll(v)
    },
    // 滚动到顶部时停止
    {
      key: 'stopAtTop',
      type: 'toggle',
      id: 'stop-at-top-switch',
      label: '滚动到顶部时停止',
      defaultValue: DEFAULT_SETTINGS.stopAtTop,
      apply: (v) => applyStopAtTop(v)
    },
    // 划词搜索清空聊天
    {
      key: 'clearOnSearch',
      type: 'toggle',
      id: 'clear-on-search-switch',
      label: '划词搜索时清空聊天',
      defaultValue: DEFAULT_SETTINGS.clearOnSearch,
      apply: (v) => applyClearOnSearch(v)
    },
    // 发送聊天历史
    {
      key: 'shouldSendChatHistory',
      type: 'toggle',
      id: 'send-chat-history-switch',
      label: '发送聊天历史',
      defaultValue: DEFAULT_SETTINGS.shouldSendChatHistory,
      apply: (v) => applySendChatHistory(v)
    },
    // 显示引用标记
    {
      key: 'showReference',
      type: 'toggle',
      id: 'show-reference-switch',
      label: '显示引用标记',
      defaultValue: DEFAULT_SETTINGS.showReference,
      apply: (v) => applyShowReference(v)
    },
    // 侧边栏位置（使用切换表示右侧）
    {
      key: 'sidebarPosition',
      type: 'toggle',
      id: 'sidebar-position-switch',
      label: '侧栏在右侧显示',
      defaultValue: DEFAULT_SETTINGS.sidebarPosition,
      readFromUI: (el) => el?.checked ? 'right' : 'left',
      writeToUI: (el, v) => { if (el) el.checked = (v === 'right'); },
      apply: (v) => applySidebarPosition(v)
    },
    // 侧边栏宽度
    {
      key: 'sidebarWidth',
      type: 'range',
      id: 'sidebar-width',
      label: '侧栏宽度',
      min: 500,
      max: 1500,
      step: 10,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.sidebarWidth,
      apply: (v) => applySidebarWidth(v)
    },
    // 字体大小
    {
      key: 'fontSize',
      type: 'range',
      id: 'font-size',
      label: '字体大小',
      min: 12,
      max: 24,
      step: 1,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.fontSize,
      apply: (v) => applyFontSize(v)
    },
    // 缩放比例
    {
      key: 'scaleFactor',
      type: 'range',
      id: 'scale-factor',
      label: '缩放比例',
      min: 0.5,
      max: 2,
      step: 0.1,
      unit: 'x',
      defaultValue: DEFAULT_SETTINGS.scaleFactor,
      apply: (v) => applyScaleFactor(v)
    },
    // // 行距（示例：页面原本没有控件则自动渲染）
    // {
    //   key: 'lineHeight',
    //   type: 'range',
    //   label: '行距',
    //   min: 1.2,
    //   max: 2.0,
    //   step: 0.1,
    //   unit: 'x',
    //   defaultValue: DEFAULT_SETTINGS.lineHeight,
    //   apply: (v) => { document.documentElement.style.setProperty('--cerebr-line-height', String(v)); }
    // }
  ];

  // 动态生成的元素映射（仅对注册表项）
  const dynamicElements = new Map(); // key -> HTMLInputElement | HTMLSelectElement
  
  // 订阅者注册表：用于跨模块监听设置变化
  /** @type {Map<string, Set<(value:any)=>void>>} */
  const subscribers = new Map();

  // 基于 schema 的通用设置定义（保留为空，统一由注册表生成）
  const SETTINGS_SCHEMA = {};

  // 由注册表构建 schema（仅针对动态生成的元素）
  let generatedSchema = {};
  function buildSchemaFromRegistry() {
    const map = {};
    for (const def of SETTINGS_REGISTRY) {
      // 如果页面已有同名控件（通过固定ID），则跳过自动生成schema（避免重复绑定）
      if (document.getElementById(def.id || `setting-${def.key}`)) {
        // 将其纳入schema（使用动态元素映射）
        map[def.key] = createSchemaEntryForDef(def);
        continue;
      }
      // 若未生成UI，稍后renderSettingsFromRegistry会创建元素并填充dynamicElements
      map[def.key] = createSchemaEntryForDef(def);
    }
    generatedSchema = map;
    return map;
  }

  function createSchemaEntryForDef(def) {
    return {
      element: () => dynamicElements.get(def.key) || null,
      readFromUI: (el) => {
        if (!el) return currentSettings[def.key];
        if (typeof def.readFromUI === 'function') return def.readFromUI(el);
        if (def.type === 'toggle') return !!el.checked;
        if (def.type === 'range') return parseFloat(el.value);
        if (def.type === 'select') return el.value;
        return el.value;
      },
      writeToUI: (el, v) => {
        if (!el) return;
        if (typeof def.writeToUI === 'function') { def.writeToUI(el, v); }
        else if (def.type === 'toggle') el.checked = !!v; else el.value = v;
        // 同步右侧显示值
        const valueSpan = el.closest('.menu-item')?.querySelector('.setting-value');
        if (valueSpan) {
          valueSpan.textContent = formatDisplayValue(def, v);
        }
      },
      apply: (v) => { if (typeof def.apply === 'function') def.apply(v); }
    };
  }

  function getSchemaMap() {
    return { ...SETTINGS_SCHEMA, ...generatedSchema };
  }

  /**
   * 统一设置更新入口
   * @param {string} key - 设置键
   * @param {any} value - 新值
   */
  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    currentSettings[key] = value;
    // 应用
    const schema = getSchemaMap();
    if (schema[key]?.apply) {
      schema[key].apply(value);
    }
    // 持久化
    saveSetting(key, value);
    // 通知订阅者
    const set = subscribers.get(key);
    if (set) {
      set.forEach((cb) => {
        try { cb(value); } catch (e) { console.error('订阅回调异常', e); }
      });
    }
  }

  /**
   * 从 schema 绑定 DOM 事件（统一 change 入口）
   */
  function bindSettingsFromSchema() {
    const schema = getSchemaMap();
    Object.keys(schema).forEach((key) => {
      const def = schema[key];
      const el = def.element?.();
      if (!el) return;
      // 避免重复绑定：先移除已存在的监听（若实现上无此需求，可忽略）
      el.addEventListener('change', (e) => {
        const newValue = def.readFromUI ? def.readFromUI(el) : e.target?.value;
        setSetting(key, newValue);
      });
      // 初始 UI 同步
      if (def.writeToUI) def.writeToUI(el, currentSettings[key]);
    });
  }

  // 渲染注册表定义到设置菜单
  function renderSettingsFromRegistry() {
    const container = settingsPanel || document.getElementById('settings-menu');
    if (!container) return;

    // 创建或获取动态区块容器
    let autoSection = container.querySelector('.settings-auto-section');
    if (!autoSection) {
      autoSection = document.createElement('div');
      autoSection.className = 'settings-auto-section';
      // 插入到主题选择器之后
      const themeSelector = container.querySelector('#theme-selector');
      if (themeSelector?.nextSibling) {
        container.insertBefore(autoSection, themeSelector.nextSibling);
      } else {
        container.appendChild(autoSection);
      }
    }

    // 为每个注册项生成控件（若页面已存在同ID控件则跳过）
    for (const def of SETTINGS_REGISTRY) {
      const existing = document.getElementById(def.id || `setting-${def.key}`);
      if (existing) {
        dynamicElements.set(def.key, existing);
        continue;
      }

      const item = document.createElement('div');
      item.className = 'menu-item';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = def.label || def.key;
      item.appendChild(labelSpan);

      if (def.type === 'toggle') {
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = def.id || `setting-${def.key}`;
        const slider = document.createElement('span');
        slider.className = 'slider';
        wrap.appendChild(input);
        wrap.appendChild(slider);
        item.appendChild(wrap);
        autoSection.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min ?? 0);
        input.max = String(def.max ?? 100);
        input.step = String(def.step ?? 1);
        input.id = def.id || `setting-${def.key}`;
        const valueSpan = document.createElement('span');
        valueSpan.className = 'setting-value';
        valueSpan.textContent = formatDisplayValue(def, currentSettings[def.key] ?? def.defaultValue);
        input.addEventListener('input', (e) => {
          valueSpan.textContent = formatDisplayValue(def, parseFloat(input.value));
        });
        item.appendChild(input);
        item.appendChild(valueSpan);
        autoSection.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'select') {
        const select = document.createElement('select');
        select.id = def.id || `setting-${def.key}`;
        const optionsArr = typeof def.options === 'function' ? def.options() : (def.options || []);
        optionsArr.forEach(opt => {
          const o = document.createElement('option');
          if (typeof opt === 'string') {
            o.value = opt; o.textContent = opt;
          } else {
            o.value = opt.value; o.textContent = opt.label;
          }
          select.appendChild(o);
        });
        item.appendChild(select);
        autoSection.appendChild(item);
        dynamicElements.set(def.key, select);
      }
    }
  }

  function formatDisplayValue(def, value) {
    if (def.unit === 'px') return `${value}px`;
    if (def.unit === 'x') return `${Number(value).toFixed(1)}x`;
    if (def.unit) return `${value}${def.unit}`;
    return String(value);
  }
  
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
    // 应用所有注册项设置（有 apply 的会被调用），并同步 UI
    SETTINGS_REGISTRY.forEach(def => {
      const value = currentSettings[def.key] ?? def.defaultValue;
      if (typeof def.apply === 'function') {
        try { def.apply(value); } catch (e) { console.error('应用设置失败', def.key, e); }
      }
      const el = dynamicElements.get(def.key);
      if (el) {
        const entry = generatedSchema[def.key];
        if (entry?.writeToUI) entry.writeToUI(el, value);
      }
    });
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
    if (sidebarWidthSlider) {
      sidebarWidthSlider.value = width;
    }
    
    if (widthValueDisplay) {
      widthValueDisplay.textContent = `${width}px`;
    }
    
    // 通知父窗口宽度变化
    notifySidebarWidthChange(width);
  }
  
  // 应用字体大小
  function applyFontSize(size) {
    document.documentElement.style.setProperty('--cerebr-font-size', `${size}px`);
    
    // 更新UI元素
    if (fontSizeSlider) {
      fontSizeSlider.value = size;
    }
    
    if (fontSizeValueDisplay) {
      fontSizeValueDisplay.textContent = `${size}px`;
    }
  }
  
  // 应用缩放比例
  function applyScaleFactor(value) {
    // 更新UI元素
    if (scaleFactorSlider) {
      scaleFactorSlider.value = value;
    }
    
    if (scaleValueDisplay) {
      scaleValueDisplay.textContent = `${value.toFixed(1)}x`;
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
  
  // 应用滚动到顶部时停止设置
  function applyStopAtTop(enabled) {
    // 更新UI元素
    if (stopAtTopSwitch) {
      stopAtTopSwitch.checked = enabled;
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
    if (messageSender) {
      messageSender.setSendChatHistory(enabled);
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
      // 选择变化由 schema 通用绑定处理
    }
    
    // 侧边栏宽度滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (sidebarWidthSlider) {
      sidebarWidthSlider.addEventListener('input', (e) => {
        if (widthValueDisplay) {
          widthValueDisplay.textContent = `${e.target.value}px`;
        }
      });
    }
    
    // 字体大小滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (fontSizeSlider) {
      fontSizeSlider.addEventListener('input', (e) => {
        if (fontSizeValueDisplay) {
          fontSizeValueDisplay.textContent = `${e.target.value}px`;
        }
      });
    }
    
    // 缩放比例滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (scaleFactorSlider) {
      scaleFactorSlider.addEventListener('input', (e) => {
        if (scaleValueDisplay) {
          scaleValueDisplay.textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
        }
      });
    }
    
    // 通用绑定（保存+应用+广播）
    bindSettingsFromSchema();
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
  
  // 设置主题（保留定制逻辑，下一步纳入 schema）
  function setTheme(theme) {
    const themeValue = theme === true ? 'dark' : theme === false ? 'light' : theme;
    currentSettings.theme = themeValue;
    applyTheme(themeValue);
    saveSetting('theme', themeValue);
    const set = subscribers.get('theme');
    if (set) set.forEach(cb => { try { cb(themeValue); } catch(e){ console.error(e);} });
  }
  
  // 设置侧边栏宽度
  function setSidebarWidth(width) { setSetting('sidebarWidth', width); }
  
  // 设置字体大小
  function setFontSize(size) { setSetting('fontSize', size); }
  
  // 设置缩放比例
  function setScaleFactor(value) { setSetting('scaleFactor', value); }
  
  // 设置自动滚动
  function setAutoScroll(enabled) { setSetting('autoScroll', enabled); }
  
  // 设置滚动到顶部时停止
  function setStopAtTop(enabled) { setSetting('stopAtTop', enabled); }
  
  // 设置划词搜索清空聊天
  function setClearOnSearch(enabled) { setSetting('clearOnSearch', enabled); }
  
  // 设置发送聊天历史
  function setSendChatHistory(enabled) { setSetting('shouldSendChatHistory', enabled); }
  
  // 设置显示引用标记
  function setShowReference(enabled) { setSetting('showReference', enabled); }
  
  // 设置侧边栏位置
  function setSidebarPosition(position) { console.log(`设置侧边栏位置: ${position}`); setSetting('sidebarPosition', position); }
  
  // 获取当前设置
  function getSettings() {
    return {...currentSettings};
  }
  
  // 获取单个设置
  function getSetting(key) {
    return currentSettings[key];
  }

  /**
   * 订阅设置变化
   * @param {string} key - 设置键
   * @param {(value:any)=>void} callback - 回调
   * @returns {() => void} 取消订阅函数
   */
  function subscribe(key, callback) {
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(callback);
    return () => {
      const set = subscribers.get(key);
      if (set) set.delete(callback);
    };
  }
  
  // 初始化
  function init() {
    // 先初始化主题管理器
    themeManager.init();
    
    // 先渲染基于注册表的动态设置项
    renderSettingsFromRegistry();
    // 基于注册表构建schema
    buildSchemaFromRegistry();

    setupEventListeners();
    setupSystemThemeListener();
    return initSettings();
  }
  
  // 公开的API
  return {
    init,
    getSettings,
    getSetting,
    subscribe,
    setTheme,
    setSidebarWidth,
    setFontSize,
    setScaleFactor,
    setAutoScroll,
    setStopAtTop,
    setClearOnSearch,
    setSendChatHistory,
    setShowReference,
    setSidebarPosition,
    updateReferenceVisibility,
    applyTheme
  };
} 