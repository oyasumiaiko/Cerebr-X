/**
 * 设置管理模块
 * 负责管理应用程序的所有用户界面设置，如主题、尺寸、字体大小等
 */

import { createThemeManager } from './theme_manager.js';
import { queueStorageSet, queueStoragePrime } from '../utils/storage_write_queue_bridge.js';

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
 * @param {HTMLElement} appContext.dom.sidebarPositionSwitch - 侧边栏位置开关元素
 * @param {HTMLElement} appContext.dom.stopAtTopSwitch - 滚动到顶部时停止开关元素
 * @param {HTMLElement} appContext.dom.showThoughtProcessSwitch - 显示思考过程开关元素
 * @param {HTMLElement} appContext.dom.resetSettingsButton - 重置设置按钮元素
 * @param {HTMLElement} appContext.dom.settingsMenu - 侧栏“...”下拉菜单容器
 * @param {HTMLElement} appContext.dom.escSettingsMenu - Esc 面板内的设置容器
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
  const autoRetrySwitch = dom.autoRetrySwitch;
  const sidebarPositionSwitch = dom.sidebarPositionSwitch;
  const stopAtTopSwitch = dom.stopAtTopSwitch;
  const showThoughtProcessSwitch = dom.showThoughtProcessSwitch;
  const resetSettingsButton = dom.resetSettingsButton;
  const settingsMenu = dom.settingsMenu;
  const settingsToggle = dom.settingsButton;
  const settingsBackButton = dom.settingsBackButton;
  const getEscSettingsMenu = () => dom.escSettingsMenu || document.getElementById('esc-settings-menu');
  const ensureEscSettingsMenu = () => {
    const existing = getEscSettingsMenu();
    if (existing) return existing;
    const container = document.createElement('div');
    container.id = 'esc-settings-menu';
    container.className = 'esc-settings-menu';
    dom.escSettingsMenu = container;
    return container;
  };

  // Services from appContext.services
  const messageSender = services.messageSender;
  // const themeManagerService = services.themeManager; // If themeManager is a shared service
  const uiManager = services.uiManager; // For closeExclusivePanels

  // Utils
  const showNotification = utils.showNotification;
  const closeExclusivePanels = utils.closeExclusivePanels;

  // 创建主题管理器 (could be a service in appContext too)
  const themeManager = createThemeManager();
  const isStandalone = !!appContext?.state?.isStandalone;

  // 默认设置
  const DEFAULT_SETTINGS = {
    theme: 'auto',  // 默认为自动跟随系统
    sidebarWidth: 800,
    // 全屏模式下的“内容列宽度”（影响全屏布局下消息与输入框的最大宽度）
    // 说明：历史版本中全屏布局复用了 sidebarWidth；这里新增独立配置以便分别调整。
    fullscreenWidth: 800,
    fontSize: 14,
    lineHeight: 1.5, // Added for better text readability control
    chatWidth: 100, // Percentage of sidebar width
    autoScroll: true,
    clearOnSearch: true, // This might be specific to a search feature, not a general setting
    shouldSendChatHistory: true,
    // 对话标题生成：默认关闭，避免未配置时触发额外请求
    autoGenerateConversationTitle: false,
    // 对话标题生成：是否覆盖总结类标题（保留[总结]前缀）
    autoGenerateTitleForSummary: true,
    // 对话标题生成：是否覆盖划词解释类标题（保留[划词解释]前缀）
    autoGenerateTitleForSelection: true,
    // 对话标题生成：默认跟随当前 API
    conversationTitleApi: 'follow_current',
    // 对话标题生成：默认提示词（用户可在设置中修改）
    conversationTitlePrompt: '请根据以下对话生成一个简短标题，尽量在20字以内，仅输出标题本身，不要任何前缀或引号。',
    // 是否在发送请求时回传 thoughtSignature 等签名字段（用于部分代理的推理校验/连续性）。
    // 说明：即使关闭该开关，Cerebr 仍会在接收响应时照常把 signature 存入历史，便于用户随时重新开启。
    shouldSendSignature: true,
    autoRetry: false,
    sidebarPosition: 'right', // 'left' 或 'right'
    stopAtTop: true, // 滚动到顶部时停止
    scaleFactor: 1, // Added default scaleFactor
    backgroundImageUrl: '',
    backgroundImageIntensity: 0.6,
    fullscreenBackgroundCover: false,
    backgroundOverallOpacity: 1,
    // 全屏滚动缩略图（MiniMap）：显示开关、宽度与透明度
    enableScrollMinimap: true,
    scrollMinimapWidth: 24,
    scrollMinimapOpacity: 0.94,
    scrollMinimapAutoHide: false,
    scrollMinimapMessageMode: 'proportional',
    // 在全屏/独立页面布局中隐藏原生滚动条（保留滚动能力）
    hideNativeScrollbarInFullscreen: false,
    // 是否启用 $ / $$ 作为数学公式分隔符（默认开启以保持兼容）
    enableDollarMath: true,
    // 是否在输入框 placeholder 中显示当前模型名
    showModelNameInPlaceholder: true
  };
  // 不需要持久化到 sync 的设置（大文本/临时值）
  const NON_SYNC_SETTINGS_KEYS = new Set(['backgroundImageUrl']);

  // 当前设置
  let currentSettings = {...DEFAULT_SETTINGS};
  let backgroundImageLoadToken = 0;
  let backgroundImageQueueState = { signature: '', pool: [], index: 0 };

  const getConversationTitleApiOptions = () => {
    const options = [{ label: '跟随当前 API', value: 'follow_current' }];
    const apiConfigs = services.apiManager?.getAllConfigs?.() || [];
    if (!Array.isArray(apiConfigs) || apiConfigs.length === 0) return options;

    apiConfigs.forEach((config) => {
      if (!config) return;
      const fallbackValue = `${config.baseUrl || ''}|${config.modelName || ''}`;
      const value = config.id || fallbackValue;
      const label = (config.displayName && String(config.displayName).trim())
        || (config.modelName && String(config.modelName).trim())
        || (config.baseUrl && String(config.baseUrl).trim())
        || value;
      options.push({ label, value });
    });

    return options;
  };

  function refreshConversationTitleApiOptions() {
    const select = dynamicElements.get('conversationTitleApi');
    if (!select) return;
    const currentValue = select.value
      || currentSettings.conversationTitleApi
      || DEFAULT_SETTINGS.conversationTitleApi;
    const options = getConversationTitleApiOptions();
    select.textContent = '';
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    if (currentValue && !options.some(opt => opt.value === currentValue)) {
      const extra = document.createElement('option');
      extra.value = currentValue;
      extra.textContent = currentValue;
      select.appendChild(extra);
    }
    select.value = currentValue || DEFAULT_SETTINGS.conversationTitleApi;
  }

  // 动态设置注册表：新增设置仅需在此处登记即可自动渲染与持久化
  // type: 'toggle' | 'range' | 'select'
  const SETTINGS_REGISTRY = [
    // 主题（复用现有隐藏下拉框，不额外渲染）
    {
      key: 'theme',
      type: 'select',
      id: 'theme-select',
      label: '主题选择',
      uiHidden: true,
      options: () => (themeManager.getAvailableThemes?.() || []).map(t => ({ label: t.name, value: t.id })),
      defaultValue: DEFAULT_SETTINGS.theme,
      apply: (v) => applyTheme(v)
    },
    {
      key: 'backgroundImageUrl',
      type: 'text',
      id: 'background-image-url',
      label: '背景图片',
      group: 'background',
      placeholder: '可粘贴多行，每行一个 URL/本机路径',
      defaultValue: DEFAULT_SETTINGS.backgroundImageUrl,
      apply: (v) => applyBackgroundImage(v),
      readFromUI: (el) => (el?.value ?? ''),
      writeToUI: (el, value) => {
        const val = (value ?? '');
        el.value = val;
        const container = el.closest('.background-image-setting');
        if (container) {
          container.classList.toggle('has-background-image', !!String(val).trim());
        }
      }
    },
    {
      key: 'backgroundImageIntensity',
      type: 'range',
      id: 'background-image-intensity',
      label: '图片浓度',
      group: 'background',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.backgroundImageIntensity,
      apply: (v) => applyBackgroundImageIntensity(v),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'backgroundOverallOpacity',
      type: 'range',
      id: 'background-overall-opacity',
      label: '背景透明度',
      group: 'background',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.backgroundOverallOpacity,
      apply: (v) => applyBackgroundOverallOpacity(v),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'fullscreenBackgroundCover',
      type: 'toggle',
      id: 'fullscreen-background-cover',
      label: '全屏背景铺满屏幕',
      group: 'background',
      defaultValue: DEFAULT_SETTINGS.fullscreenBackgroundCover,
      apply: (v) => applyFullscreenBackgroundCover(v)
    },
    // 自动滚动
    {
      key: 'autoScroll',
      type: 'toggle',
      id: 'auto-scroll-switch',
      label: '自动滚动',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.autoScroll,
      apply: (v) => applyAutoScroll(v)
    },
    // 滚动到顶部时停止
    {
      key: 'stopAtTop',
      type: 'toggle',
      id: 'stop-at-top-switch',
      label: '滚动到顶部时停止',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.stopAtTop,
      apply: (v) => applyStopAtTop(v)
    },
    // 划词搜索清空聊天
    {
      uiHidden: true,
      key: 'clearOnSearch',
      type: 'toggle',
      id: 'clear-on-search-switch',
      label: '划词搜索时清空聊天',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.clearOnSearch,
      apply: (v) => applyClearOnSearch(v)
    },
    // 发送聊天历史
    {
      key: 'shouldSendChatHistory',
      type: 'toggle',
      id: 'send-chat-history-switch',
      label: '发送聊天历史',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.shouldSendChatHistory,
      apply: (v) => applySendChatHistory(v)
    },
    {
      key: 'autoGenerateConversationTitle',
      type: 'toggle',
      id: 'auto-generate-conversation-title',
      label: '自动生成对话标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateConversationTitle
    },
    {
      key: 'autoGenerateTitleForSummary',
      type: 'toggle',
      id: 'auto-generate-title-summary',
      label: '对[总结]自动生成标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateTitleForSummary
    },
    {
      key: 'autoGenerateTitleForSelection',
      type: 'toggle',
      id: 'auto-generate-title-selection',
      label: '对[划词解释]自动生成标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateTitleForSelection
    },
    {
      key: 'conversationTitleApi',
      type: 'select',
      id: 'conversation-title-api',
      label: '对话标题生成 API',
      group: 'title',
      options: () => getConversationTitleApiOptions(),
      defaultValue: DEFAULT_SETTINGS.conversationTitleApi
    },
    {
      key: 'conversationTitlePrompt',
      type: 'textarea',
      id: 'conversation-title-prompt',
      label: '对话标题提示词',
      placeholder: '输入用于生成对话标题的提示词（系统提示词）',
      rows: 4,
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.conversationTitlePrompt,
      readFromUI: (el) => (el?.value || '').trim(),
      writeToUI: (el, value) => { if (el) el.value = value || ''; }
    },
    // 发送 signature（推理签名透传）
    {
      key: 'shouldSendSignature',
      type: 'toggle',
      id: 'send-signature-switch',
      label: '发送 signature（推理签名）',
      group: 'advanced',
      defaultValue: DEFAULT_SETTINGS.shouldSendSignature
    },
    {
      key: 'autoRetry',
      type: 'toggle',
      id: 'auto-retry-switch',
      label: '自动重试',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.autoRetry,
      apply: (v) => applyAutoRetry(v)
    },
    {
      key: 'showModelNameInPlaceholder',
      type: 'toggle',
      label: '输入框占位符显示模型名',
      group: 'input',
      defaultValue: DEFAULT_SETTINGS.showModelNameInPlaceholder,
      apply: (v) => applyShowModelNameInPlaceholder(v)
    },
    // 快捷设置：保留在“...”菜单中便于快速调整
    // 数学公式：是否使用 $ / $$ 作为分隔符
    {
      key: 'enableDollarMath',
      type: 'toggle',
      menu: 'quick',
      group: 'display',
      label: '使用 $ / $$ 作为公式分隔符',
      defaultValue: DEFAULT_SETTINGS.enableDollarMath
    },
    // 侧边栏位置（使用切换表示右侧）
    {
      key: 'sidebarPosition',
      type: 'toggle',
      menu: 'quick',
      group: 'layout',
      id: 'sidebar-position-switch',
      label: '侧栏在右侧显示',
      defaultValue: DEFAULT_SETTINGS.sidebarPosition,
      readFromUI: (el) => el?.checked ? 'right' : 'left',
      writeToUI: (el, v) => { if (el) el.checked = (v === 'right'); },
      apply: (v) => applySidebarPosition(v),
      standaloneHidden: true
    },
    // 侧边栏宽度
    {
      key: 'sidebarWidth',
      type: 'range',
      menu: 'quick',
      group: 'layout',
      id: 'sidebar-width',
      label: '侧栏宽度',
      min: 500,
      max: 2000,
      step: 50,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.sidebarWidth,
      apply: (v) => applySidebarWidth(v)
    },
    // 全屏模式内容宽度（仅影响全屏布局的居中内容区，不影响侧栏本身宽度）
    {
      key: 'fullscreenWidth',
      type: 'range',
      menu: 'quick',
      id: 'fullscreen-width',
      label: '全屏宽度',
      group: 'layout',
      min: 500,
      max: 2400,
      step: 50,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.fullscreenWidth,
      apply: (v) => applyFullscreenWidth(v)
    },
    {
      key: 'enableScrollMinimap',
      type: 'toggle',
      menu: 'quick',
      group: 'layout',
      label: '启用滚动缩略图',
      defaultValue: DEFAULT_SETTINGS.enableScrollMinimap,
      apply: (v) => applyScrollMinimapEnabled(v)
    },
    {
      key: 'scrollMinimapWidth',
      type: 'range',
      menu: 'quick',
      group: 'layout',
      label: '缩略图宽度',
      min: 14,
      max: 100,
      step: 1,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.scrollMinimapWidth,
      apply: (v) => applyScrollMinimapWidth(v)
    },
    {
      key: 'scrollMinimapOpacity',
      type: 'range',
      menu: 'quick',
      group: 'display',
      label: '缩略图透明度',
      min: 0.2,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.scrollMinimapOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      apply: (v) => applyScrollMinimapOpacity(v)
    },
    {
      key: 'scrollMinimapAutoHide',
      type: 'toggle',
      menu: 'quick',
      group: 'display',
      label: '缩略图自动隐藏',
      defaultValue: DEFAULT_SETTINGS.scrollMinimapAutoHide,
      apply: (v) => applyScrollMinimapAutoHide(v)
    },
    {
      key: 'scrollMinimapMessageMode',
      type: 'select',
      menu: 'quick',
      group: 'display',
      label: '缩略图消息模式',
      options: [
        { label: '按实际高度比例', value: 'proportional' },
        { label: '固定消息高度', value: 'fixed' }
      ],
      defaultValue: DEFAULT_SETTINGS.scrollMinimapMessageMode,
      apply: (v) => applyScrollMinimapMessageMode(v)
    },
    {
      key: 'hideNativeScrollbarInFullscreen',
      type: 'toggle',
      menu: 'quick',
      group: 'layout',
      label: '全屏隐藏原生滚动条',
      defaultValue: DEFAULT_SETTINGS.hideNativeScrollbarInFullscreen,
      apply: (v) => applyHideNativeScrollbarInFullscreen(v)
    },
    // 字体大小
    {
      key: 'fontSize',
      type: 'range',
      menu: 'quick',
      group: 'display',
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
      menu: 'quick',
      group: 'layout',
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

  function getActiveRegistry() {
    return SETTINGS_REGISTRY.filter(def => !(isStandalone && def.standaloneHidden));
  }

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
    for (const def of getActiveRegistry()) {
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
  function normalizeSettingValue(key, value) {
    if (key === 'fullscreenWidth') {
      return clampFullscreenWidth(value);
    }
    if (key === 'scrollMinimapWidth') {
      return clampScrollMinimapWidth(value);
    }
    if (key === 'scrollMinimapOpacity') {
      return clamp01(value, DEFAULT_SETTINGS.scrollMinimapOpacity);
    }
    if (key === 'scrollMinimapAutoHide') {
      return !!value;
    }
    if (key === 'scrollMinimapMessageMode') {
      return normalizeScrollMinimapMessageMode(value);
    }
    if (key === 'hideNativeScrollbarInFullscreen') {
      return !!value;
    }
    return value;
  }

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    const normalizedValue = normalizeSettingValue(key, value);
    currentSettings[key] = normalizedValue;
    // 应用
    const schema = getSchemaMap();
    if (schema[key]?.apply) {
      schema[key].apply(normalizedValue);
    }
    // 持久化
    saveSetting(key, normalizedValue);
    // 通知订阅者
    const set = subscribers.get(key);
    if (set) {
      set.forEach((cb) => {
        try { cb(normalizedValue); } catch (e) { console.error('订阅回调异常', e); }
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
    const quickContainer = settingsMenu || document.getElementById('settings-menu');
    const panelContainer = ensureEscSettingsMenu();
    if (!quickContainer && !panelContainer) return;

    const getElementId = (def) => def.id || `setting-${def.key}`;
    // 避免 Esc 设置容器未挂载时重复渲染导致控件重复
    const normalizeExistingElement = (elementId, preferredContainer) => {
      if (!elementId) return null;
      const candidates = [];
      if (quickContainer) candidates.push(...quickContainer.querySelectorAll(`#${elementId}`));
      if (panelContainer) candidates.push(...panelContainer.querySelectorAll(`#${elementId}`));
      if (!candidates.length) {
        const docEl = document.getElementById(elementId);
        if (docEl) candidates.push(docEl);
      }
      if (!candidates.length) return null;
      let keep = null;
      if (preferredContainer) {
        keep = preferredContainer.querySelector(`#${elementId}`);
      }
      if (!keep) keep = candidates[0];
      for (const el of candidates) {
        if (el === keep) continue;
        const item = el.closest('.menu-item');
        if (item && item.parentElement) {
          item.parentElement.removeChild(item);
        } else if (el.parentElement) {
          el.parentElement.removeChild(el);
        }
      }
      return keep;
    };

    if (quickContainer && panelContainer) {
      const themeSelector = panelContainer.querySelector('#theme-selector');
      if (themeSelector && !quickContainer.contains(themeSelector)) {
        quickContainer.insertBefore(themeSelector, quickContainer.firstChild);
      }
    }

    const ensureAutoSection = (container, scope) => {
      if (!container) return null;
      const selector = `.settings-auto-section[data-scope="${scope}"]`;
      let autoSection = container.querySelector(selector);
      if (!autoSection) {
        autoSection = document.createElement('div');
        autoSection.className = 'settings-auto-section';
        autoSection.dataset.scope = scope;
        if (scope === 'quick') {
          // 让主题/随机背景/停靠模式固定在菜单上方，快捷项放在其后，避免把按钮挤到列表下方。
          const anchor = container.querySelector('#dock-mode-toggle')
            || container.querySelector('#settings-random-background')
            || container.querySelector('#theme-selector');
          if (anchor?.nextSibling) {
            container.insertBefore(autoSection, anchor.nextSibling);
          } else {
            container.appendChild(autoSection);
          }
        } else {
          container.appendChild(autoSection);
        }
      }
      if (scope === 'quick') {
        const anchor = container.querySelector('#dock-mode-toggle')
          || container.querySelector('#settings-random-background')
          || container.querySelector('#theme-selector');
        if (anchor && anchor.nextSibling !== autoSection) {
          container.insertBefore(autoSection, anchor.nextSibling);
        }
      }
      return autoSection;
    };
    const GROUP_LABELS = {
      background: '背景',
      display: '显示',
      layout: '布局',
      behavior: '行为',
      input: '输入',
      title: '对话标题',
      advanced: '高级',
      other: '其他'
    };
    const normalizeGroupKey = (def) => {
      if (def && typeof def.group === 'string' && def.group.trim()) {
        return def.group.trim();
      }
      return 'other';
    };
    const ensureGroupSection = (autoSection, groupKey) => {
      if (!autoSection) return null;
      const key = groupKey || 'other';
      let groupEl = autoSection.querySelector(`.settings-group[data-group="${key}"]`);
      if (!groupEl) {
        groupEl = document.createElement('div');
        groupEl.className = 'settings-group';
        groupEl.dataset.group = key;

        const title = document.createElement('div');
        title.className = 'settings-group-title';
        title.textContent = GROUP_LABELS[key] || GROUP_LABELS.other;

        groupEl.appendChild(title);
        autoSection.appendChild(groupEl);
      }
      return groupEl;
    };
    const resolveContainer = (def) => {
      const wantsQuick = def.menu === 'quick';
      if (wantsQuick) {
        const target = quickContainer || panelContainer;
        if (!target) return { container: null, scope: null };
        const scope = target === quickContainer ? 'quick' : 'panel';
        return { container: target, scope };
      }
      if (!panelContainer) return { container: null, scope: null };
      return { container: panelContainer, scope: 'panel' };
    };

    // 为每个注册项生成控件（若页面已存在同ID控件则跳过；uiHidden=true 时不渲染控件）
    for (const def of getActiveRegistry()) {
      const elementId = getElementId(def);
      const preferredContainer = (def.menu === 'quick' && quickContainer) ? quickContainer : panelContainer;
      const existing = normalizeExistingElement(elementId, preferredContainer);
      if (def.uiHidden === true) {
        if (existing) {
          dynamicElements.set(def.key, existing);
        }
        // 不渲染 UI，但该设置仍会被加载/保存/应用（通过 applyAllSettings）
        continue;
      }
      const { container, scope } = resolveContainer(def);
      const autoSection = ensureAutoSection(container, scope);
      const targetSection = (scope === 'panel')
        ? ensureGroupSection(autoSection, normalizeGroupKey(def))
        : autoSection;
      if (existing) {
        dynamicElements.set(def.key, existing);
        const existingItem = existing.closest('.menu-item');
        if (targetSection && existingItem && existingItem.parentElement !== targetSection) {
          targetSection.appendChild(existingItem);
        }
        continue;
      }
      if (!autoSection || !targetSection) continue;

      const item = document.createElement('div');
      item.className = 'menu-item';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = def.label || def.key;
      item.appendChild(labelSpan);

      if (def.type === 'toggle') {
        item.classList.add('menu-item--toggle');
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
        targetSection.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'range') {
        item.classList.add('menu-item--range');
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
        targetSection.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'text' || def.type === 'textarea') {
        if (def.type === 'text' && def.id === 'background-image-url') {
          item.classList.add('background-image-setting');
          labelSpan.classList.add('background-image-label');

          const actions = document.createElement('div');
          actions.className = 'background-image-actions';

          const setWrapper = document.createElement('div');
          setWrapper.className = 'background-image-set-wrapper';

          const setButton = document.createElement('button');
          setButton.type = 'button';
          setButton.className = 'background-image-button background-image-button--set';
          setButton.textContent = '设置';
          setWrapper.appendChild(setButton);

          const popover = document.createElement('div');
          popover.className = 'background-image-popover';

          const input = document.createElement('textarea');
          input.id = def.id || `setting-${def.key}`;
          input.placeholder = def.placeholder || '';
          input.className = 'background-image-input';
          input.rows = 6;
          popover.appendChild(input);
          setWrapper.appendChild(popover);

          actions.appendChild(setWrapper);

          const clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'background-image-button background-image-button--clear';
          clearBtn.textContent = '清除';
          clearBtn.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            input.value = '';
            item.classList.remove('has-background-image');
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
          });
          actions.appendChild(clearBtn);

          item.appendChild(actions);
          targetSection.appendChild(item);

          dynamicElements.set(def.key, input);

          if (typeof def.writeToUI === 'function') {
            try { def.writeToUI(input, currentSettings[def.key]); } catch (_) {}
          }

          setButton.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            input.focus();
            input.select();
          });

          popover.addEventListener('click', (evt) => evt.stopPropagation());

          input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') {
              evt.stopPropagation();
              input.blur();
            }
          });

          input.addEventListener('input', () => {
            item.classList.toggle('has-background-image', !!input.value.trim());
          });

        } else {
          item.classList.add('menu-item--stack');
          const input = (def.type === 'textarea')
            ? document.createElement('textarea')
            : document.createElement('input');
          if (def.type !== 'textarea') {
            input.type = 'text';
          }
          input.id = def.id || `setting-${def.key}`;
          input.placeholder = def.placeholder || '';
          input.className = def.type === 'textarea'
            ? 'settings-text-input settings-textarea'
            : 'settings-text-input';
          if (def.type === 'textarea' && def.rows) {
            input.rows = Number(def.rows) || 3;
          }
          item.appendChild(input);

          if (def.key !== 'conversationTitlePrompt') {
            const actionBar = document.createElement('div');
            actionBar.className = 'settings-input-actions';
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'settings-input-clear';
            clearBtn.textContent = '清除';
            clearBtn.addEventListener('click', (evt) => {
              evt.preventDefault();
              evt.stopPropagation();
              input.value = '';
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            actionBar.appendChild(clearBtn);
            item.appendChild(actionBar);
          }

          targetSection.appendChild(item);
          dynamicElements.set(def.key, input);
        }
      } else if (def.type === 'select') {
        item.classList.add('menu-item--select');
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
        targetSection.appendChild(item);
        dynamicElements.set(def.key, select);
      }
    }
  }

  /**
   * 根据当前布局模式（侧栏 / 全屏）控制“宽度滑条”的显隐。
   *
   * 背景：历史版本只有一个 sidebarWidth，既用于侧栏宽度，也用于全屏布局的内容列宽度。
   * 本次新增 fullscreenWidth 后，为避免用户同时看到两个滑条造成困惑，需要按模式只展示一个：
   * - 侧栏模式：显示「侧栏宽度」，隐藏「全屏宽度」
   * - 全屏模式：显示「全屏宽度」，隐藏「侧栏宽度」
   *
   * 这里不移除节点，只切换 menu-item 的 display，避免重新渲染/重新绑定事件带来的状态抖动。
   */
  function updateWidthSlidersVisibility() {
    const root = document.documentElement;
    const isFullscreenLayout = isStandalone || !!root?.classList?.contains('fullscreen-mode');

    const sidebarWidthEl = dynamicElements.get('sidebarWidth') || document.getElementById('sidebar-width');
    const fullscreenWidthEl = dynamicElements.get('fullscreenWidth') || document.getElementById('fullscreen-width');

    const sidebarItem = sidebarWidthEl?.closest?.('.menu-item') || null;
    const fullscreenItem = fullscreenWidthEl?.closest?.('.menu-item') || null;

    if (sidebarItem) sidebarItem.style.display = isFullscreenLayout ? 'none' : '';
    if (fullscreenItem) fullscreenItem.style.display = isFullscreenLayout ? '' : 'none';
    syncFullscreenWidthControlBounds();
  }

  /**
   * 监听全屏模式 class 的变化，确保用户在切换全屏时设置面板能即时刷新显示的滑条。
   * 说明：全屏状态由 sidebar_events.js 通过切换 html.fullscreen-mode 实现，监听 class 最稳定。
   */
  function setupFullscreenModeObserver() {
    updateWidthSlidersVisibility();

    try {
      const root = document.documentElement;
      if (!root) return;

      const observer = new MutationObserver(() => {
        updateWidthSlidersVisibility();
      });

      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {
      console.warn('注册全屏模式监听失败（忽略）:', e);
    }
  }

  function formatDisplayValue(def, value) {
    if (typeof def.formatValue === 'function') {
      try {
        return def.formatValue(value);
      } catch (error) {
        console.error('格式化设置值失败', def.key, error);
      }
    }
    if (def.unit === 'px') return `${value}px`;
    if (def.unit === 'x') return `${Number(value).toFixed(1)}x`;
    if (def.unit) return `${value}${def.unit}`;
    return String(value);
  }
  
  // 初始化所有设置
  async function initSettings() {
    try {
      console.log('初始化设置...');
      const syncKeys = Object.keys(DEFAULT_SETTINGS).filter((key) => !NON_SYNC_SETTINGS_KEYS.has(key));
      const result = await chrome.storage.sync.get(syncKeys);
      let localResult = {};
      if (NON_SYNC_SETTINGS_KEYS.size) {
        localResult = await chrome.storage.local.get([...NON_SYNC_SETTINGS_KEYS]);
      }
      
      // 合并默认设置和已保存的设置
      currentSettings = {...DEFAULT_SETTINGS, ...result, ...localResult};
      // 用已持久化值初始化写入队列快照，避免重复写入
      queueStoragePrime('sync', result);
      queueStoragePrime('local', localResult);

      // 清理不应存入 sync 的大字段，避免占用同步配额
      if (NON_SYNC_SETTINGS_KEYS.size) {
        try {
          await chrome.storage.sync.remove([...NON_SYNC_SETTINGS_KEYS]);
        } catch (e) {
          console.warn('清理非同步设置失败（忽略）:', e);
        }
      }

      // 兼容旧版本：首次引入 fullscreenWidth 时，用已有的 sidebarWidth 作为初始值。
      // 这样升级后不会出现“全屏宽度突然变窄/变宽”的跳变体验。
      if (!Object.prototype.hasOwnProperty.call(result, 'fullscreenWidth')) {
        currentSettings.fullscreenWidth = currentSettings.sidebarWidth;
        try {
          await queueStorageSet('sync', { fullscreenWidth: currentSettings.fullscreenWidth }, { flush: 'now' });
        } catch (e) {
          console.warn('写入 fullscreenWidth 默认值失败（忽略）:', e);
        }
      }
      
      // 应用所有设置到UI
      applyAllSettings();
      
      console.log('设置初始化完成');
    } catch (error) {
      console.error('初始化设置失败:', error);
    }

    // 监听跨标签页 storage 变更，按键增量应用，避免状态漂移
    try {
      if (!chrome?.storage?.onChanged) return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' && areaName !== 'local') return;
        let mutated = false;
        Object.keys(changes).forEach((key) => {
          if (!(key in DEFAULT_SETTINGS)) return;
          if (areaName === 'sync' && NON_SYNC_SETTINGS_KEYS.has(key)) return;
          if (areaName === 'local' && !NON_SYNC_SETTINGS_KEYS.has(key)) return;
          const { newValue } = changes[key] || {};
          // 仅在值确实变化时应用
          if (typeof newValue === 'undefined') return;
          const normalizedValue = normalizeSettingValue(key, newValue);
          if (currentSettings[key] === normalizedValue) return;
          currentSettings[key] = normalizedValue;
          queueStoragePrime(areaName, { [key]: normalizedValue });
          // 按注册项 apply 与 UI 同步
          const def = getActiveRegistry().find(d => d.key === key);
          if (def) {
            try { if (typeof def.apply === 'function') def.apply(normalizedValue); } catch (e) { console.warn('应用存储变更失败', key, e); }
            const el = dynamicElements.get(key);
            try {
              const entry = generatedSchema[key];
              if (el && entry?.writeToUI) entry.writeToUI(el, normalizedValue);
            } catch (_) {}
          }
          mutated = true;
        });
        if (mutated) {
          // 某些 UI 派生项（如宽度/字体显示文本）需要刷新显示值
          try { applyAllSettings(); } catch (_) {}
        }
      });
    } catch (e) {
      console.warn('注册 storage 变更监听失败（忽略）：', e);
    }
  }
  
  // 保存单个设置（统一走写入队列）
  function saveSetting(key, value) {
    try {
      currentSettings[key] = value;
      const area = NON_SYNC_SETTINGS_KEYS.has(key) ? 'local' : 'sync';
      queueStorageSet(area, { [key]: value });
    } catch (error) {
      console.error(`保存设置${key}失败:`, error);
    }
  }
  
  // 应用所有设置到UI
  function applyAllSettings() {
    // 应用所有注册项设置（有 apply 的会被调用），并同步 UI
    getActiveRegistry().forEach(def => {
      const value = currentSettings[def.key] ?? def.defaultValue;
      const effectiveValue = normalizeSettingValue(def.key, value);
      if (typeof def.apply === 'function') {
        try { def.apply(effectiveValue); } catch (e) { console.error('应用设置失败', def.key, e); }
      }
      const el = dynamicElements.get(def.key);
      if (el) {
        const entry = generatedSchema[def.key];
        if (entry?.writeToUI) entry.writeToUI(el, effectiveValue);
      }
    });
  }

  function getThemeType(themeId) {
    const theme = themeManager.getThemeById?.(themeId);
    if (theme?.type) return theme.type;
    return '';
  }

  function isDarkThemeId(themeId) {
    const themeType = getThemeType(themeId);
    if (themeType === 'dark') return true;
    if (themeType === 'light') return false;
    if (themeType === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    // 兜底：兼容历史自定义主题 ID（未注册在主题管理器中）。
    const normalized = String(themeId || '').toLowerCase();
    return normalized.includes('dark')
      || normalized.includes('night')
      || normalized.includes('black')
      || normalized.includes('monokai')
      || normalized.includes('dracula');
  }

  function resolveThemeIdForTargetType(currentThemeId, targetType) {
    const normalizedTargetType = targetType === 'dark' ? 'dark' : 'light';
    const currentTheme = themeManager.getThemeById?.(currentThemeId);
    const allThemes = themeManager.getAvailableThemes?.() || [];
    const themeById = new Map(allThemes.map((theme) => [theme.id, theme]));
    if (!currentTheme) {
      return normalizedTargetType === 'dark' ? 'dark' : 'light';
    }
    if (currentTheme.type === normalizedTargetType) {
      return currentTheme.id;
    }

    // 优先按“同前缀 + light/dark 后缀”寻找配对主题。
    const candidateIds = [];
    const themeId = currentTheme.id;
    if (themeId.endsWith('-light')) {
      candidateIds.push(`${themeId.slice(0, -6)}-dark`);
    }
    if (themeId.endsWith('-dark')) {
      candidateIds.push(`${themeId.slice(0, -5)}-light`);
    }
    if (themeId.includes('-light-')) {
      candidateIds.push(themeId.replace('-light-', '-dark-'));
    }
    if (themeId.includes('-dark-')) {
      candidateIds.push(themeId.replace('-dark-', '-light-'));
    }

    // 对诸如 tokyo-night / tokyo-night-light 这类命名做“去后缀后匹配”。
    const baseId = themeId.replace(/-(light|dark)$/i, '');
    allThemes.forEach((theme) => {
      if (!theme || theme.type !== normalizedTargetType) return;
      const candidateBaseId = String(theme.id || '').replace(/-(light|dark)$/i, '');
      if (candidateBaseId === baseId) {
        candidateIds.push(theme.id);
      }
    });

    for (const candidateId of candidateIds) {
      const candidateTheme = themeById.get(candidateId);
      if (candidateTheme?.type === normalizedTargetType) {
        return candidateTheme.id;
      }
    }

    return normalizedTargetType === 'dark' ? 'dark' : 'light';
  }
  
  // 应用主题
  function applyTheme(themeValue) {
    // 使用主题管理器应用主题
    themeManager.applyTheme(themeValue);
    
    // 更新主题选择下拉框
    if (themeSelect) {
      themeSelect.value = themeValue;
    }
    
    // 更新开关状态：基于主题元数据判断深浅色，避免硬编码主题 ID 列表。
    if (themeSwitch) {
      const isAuto = themeValue === 'auto';
      
      if (isAuto) {
        // 如果是自动模式，根据系统设置决定开关状态
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        themeSwitch.checked = prefersDark;
      } else {
        themeSwitch.checked = isDarkThemeId(themeValue);
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

  function getSafeScaleFactor(value) {
    const numericValue = Number(value);
    return (Number.isFinite(numericValue) && numericValue > 0) ? numericValue : 1;
  }

  function getStandaloneBaseScale() {
    const dpr = Number(window.devicePixelRatio);
    return (Number.isFinite(dpr) && dpr > 0) ? 1 / dpr : 1;
  }

  function updateStandaloneScaleStyles(scaleFactor) {
    if (!isStandalone) return;
    const safeScaleFactor = getSafeScaleFactor(scaleFactor);
    const baseScale = getStandaloneBaseScale();
    const zoom = safeScaleFactor * baseScale;
    // 这里使用 zoom 而不是 transform，避免影响已有基于 transform 的动效
    document.documentElement.style.zoom = String(zoom);

    // 独立页面缩放会影响布局尺寸，用“虚拟视口”变量保持视觉填充与居中逻辑一致
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    const inverseZoom = zoom > 0 ? 1 / zoom : 1;
    document.documentElement.style.setProperty('--cerebr-viewport-width', `${viewportW * inverseZoom}px`);
    document.documentElement.style.setProperty('--cerebr-viewport-height', `${viewportH * inverseZoom}px`);
  }

  function getCurrentViewportWidthForFullscreenSetting() {
    const cssViewportWidthRaw = document.documentElement?.style?.getPropertyValue?.('--cerebr-viewport-width')
      || getComputedStyle(document.documentElement || document.body).getPropertyValue('--cerebr-viewport-width');
    const cssViewportWidth = parseFloat(cssViewportWidthRaw || '');
    if (Number.isFinite(cssViewportWidth) && cssViewportWidth > 0) {
      // 该变量在 standalone 下已包含缩放校正（含 DPR 维度），不要再重复乘 DPR。
      return cssViewportWidth;
    }

    // 嵌入模式没有 --cerebr-viewport-width 时，回退为“页面可视宽度 × DPR”，
    // 让滑条最大值与设置项的“物理像素语义”保持一致。
    const fallbackCssWidth = document.documentElement?.clientWidth || window.innerWidth || 0;
    if (!Number.isFinite(fallbackCssWidth) || fallbackCssWidth <= 0) return 0;
    const dpr = Number(window.devicePixelRatio);
    const safeDpr = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    return fallbackCssWidth * safeDpr;
  }

  function getFullscreenWidthBounds() {
    const fullscreenDef = SETTINGS_REGISTRY.find((def) => def.key === 'fullscreenWidth') || null;
    const configuredMin = Number(fullscreenDef?.min);
    const configuredMax = Number(fullscreenDef?.max);
    const min = Number.isFinite(configuredMin) ? Math.max(0, Math.round(configuredMin)) : 500;

    // 最大值跟随当前页面可见宽度（扣除左右各 15px 内边距），避免出现“视觉上无效”的超大像素值。
    const viewportWidth = Math.floor(getCurrentViewportWidthForFullscreenSetting());
    const viewportLimitedMax = viewportWidth - 30;
    const fallbackMax = Number.isFinite(configuredMax) ? Math.max(min, Math.round(configuredMax)) : Math.max(min, 2400);
    const max = Number.isFinite(viewportLimitedMax) && viewportLimitedMax > 0
      ? Math.max(min, viewportLimitedMax)
      : fallbackMax;

    return { min, max };
  }

  function clampFullscreenWidth(width) {
    const { min, max } = getFullscreenWidthBounds();
    const rawWidth = Number(width);
    const fallback = Number(currentSettings.fullscreenWidth);
    const base = Number.isFinite(rawWidth)
      ? rawWidth
      : (Number.isFinite(fallback) ? fallback : DEFAULT_SETTINGS.fullscreenWidth);
    return Math.round(Math.min(max, Math.max(min, base)));
  }

  function syncFullscreenWidthControlBounds(displayValue) {
    const fullscreenWidthEl = dynamicElements.get('fullscreenWidth') || document.getElementById('fullscreen-width');
    if (!fullscreenWidthEl) return;

    const { min, max } = getFullscreenWidthBounds();
    fullscreenWidthEl.min = String(min);
    fullscreenWidthEl.max = String(max);

    const targetValue = clampFullscreenWidth(
      displayValue !== undefined ? displayValue : currentSettings.fullscreenWidth
    );
    fullscreenWidthEl.value = String(targetValue);

    const valueSpan = fullscreenWidthEl.closest('.menu-item')?.querySelector('.setting-value');
    if (valueSpan) {
      valueSpan.textContent = `${targetValue}px`;
    }
  }

  // 应用全屏模式内容宽度
  // 说明：全屏布局通过 CSS 变量 --cerebr-fullscreen-width 控制“居中内容列”的最大宽度，
  // 与侧栏实际宽度（--cerebr-sidebar-width）拆分后可分别调整。
  function applyFullscreenWidth(width) {
    // 重要：全屏内容宽度需要与侧栏宽度保持相同的“缩放语义”：
    // - 侧栏宽度在 content.js 中会做缩放校正，确保宽度数值不随 scaleFactor 改变
    // - 全屏布局的内容列宽度如果直接使用 width，会随着 scaleFactor 一起被放大/缩小
    // 因此这里需要用 scaleFactor 进行反向校正，让用户看到/设置的「全屏宽度」保持“绝对像素”语义。
    const effectiveScaleFactor = getSafeScaleFactor(currentSettings.scaleFactor);
    const safeWidth = clampFullscreenWidth(width);
    const baseScale = isStandalone ? getStandaloneBaseScale() : 1;
    const correctionScale = effectiveScaleFactor * baseScale;
    const correctedWidth = safeWidth / (correctionScale || 1);
    document.documentElement.style.setProperty('--cerebr-fullscreen-width', `${correctedWidth}px`);
    syncFullscreenWidthControlBounds(safeWidth);
  }

  function previewFullscreenWidth(width) {
    const safeWidth = clampFullscreenWidth(width);
    applyFullscreenWidth(safeWidth);
    return safeWidth;
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

    // 在独立聊天页面中，本地直接应用缩放，保持与网页侧栏相同的视觉大小语义
    if (isStandalone) {
      updateStandaloneScaleStyles(value);
    }

    // 通知父窗口缩放比例变化（嵌入模式由 content.js 接管处理）
    notifyScaleFactorChange(value);

    // scaleFactor 变化会影响全屏内容宽度的“实际像素表现”，因此需要重新应用一次校正后的全屏宽度
    // 说明：这里不改变设置值本身（仍以“绝对像素”存储/显示），只刷新 CSS 变量。
    try {
      applyFullscreenWidth(currentSettings.fullscreenWidth);
    } catch (e) {
      console.warn('缩放变化后重新应用全屏宽度失败（忽略）:', e);
    }
  }

  function applyBackgroundImage(url, options = {}) {
    const { cacheBustToken = null } = options || {};
    const normalizedInput = typeof url === 'string' ? url.trim() : '';
    const token = ++backgroundImageLoadToken;

    if (!normalizedInput) {
      updateBackgroundImageCss('none', false, token);
      return;
    }

    if (/^\s*url\(/i.test(normalizedInput)) {
      const extracted = extractUrlFromCss(normalizedInput);
      updateBackgroundImageCss(normalizedInput, true, token, extracted || undefined);
      return;
    }

    const normalizedSource = normalizeBackgroundSource(normalizedInput);

    if (normalizedSource.kind === 'list') {
      loadBackgroundImageFromList(normalizedSource.url, token);
      return;
    }

    if (normalizedSource.kind === 'inline_list') {
      loadBackgroundImageFromInlineList(normalizedSource.list, token);
      return;
    }

    if (normalizedSource.kind === 'direct') {
      const targetUrl = maybeAppendCacheBuster(normalizedSource.url, cacheBustToken);
      const cssValue = createCssUrlValue(targetUrl);
      updateBackgroundImageCss(cssValue, true, token, targetUrl);
      return;
    }

    updateBackgroundImageCss('none', false, token);
  }

  function normalizeBackgroundSource(input) {
    const rawInput = typeof input === 'string' ? input : '';
    if (isInlineListSource(rawInput)) {
      return { kind: 'inline_list', list: parseBackgroundList(rawInput) };
    }
    const converted = convertPotentialWindowsPath(rawInput);
    if (isTxtListSource(converted)) {
      return { kind: 'list', url: converted };
    }
    return { kind: 'direct', url: converted };
  }

  function isInlineListSource(value) {
    if (!value || typeof value !== 'string') return false;
    return value.includes('\n');
  }

  function convertPotentialWindowsPath(input) {
    if (!input) return input;
    if (/^file:\/\//i.test(input)) return input;
    if (/^https?:\/\//i.test(input)) return input;
    if (/^data:/i.test(input)) return input;

    if (/^[a-zA-Z]:[\\/]/.test(input)) {
      const replaced = input.replace(/\\/g, '/');
      return `file:///${replaced}`;
    }

    if (/^\\\\/.test(input)) {
      const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '');
      return `file:////${cleaned}`;
    }

    return input;
  }

  function isTxtListSource(value) {
    if (!value) return false;
    const stripped = stripQueryAndHash(value).toLowerCase();
    return stripped.endsWith('.txt');
  }

  function stripQueryAndHash(value) {
    const idx = value.search(/[?#]/);
    return idx === -1 ? value : value.slice(0, idx);
  }

  function maybeAppendCacheBuster(resourceUrl, cacheBustToken) {
    if (!cacheBustToken) return resourceUrl;
    if (!/^(https?:)/i.test(resourceUrl)) return resourceUrl;
    const separator = resourceUrl.includes('?') ? '&' : '?';
    return `${resourceUrl}${separator}__cerebr_bg=${encodeURIComponent(String(cacheBustToken))}`;
  }

  async function loadBackgroundImageFromList(listUrl, token) {
    try {
      const response = await fetch(listUrl);
      if (!response.ok) {
        throw new Error(`请求失败: ${response.status}`);
      }
      const text = await response.text();
      if (token !== backgroundImageLoadToken) return;

      const rawCandidates = parseBackgroundList(text);
      const candidates = normalizeListCandidates(rawCandidates, listUrl);
      if (!candidates.length) {
        console.warn('背景图片列表为空:', listUrl);
        updateBackgroundImageCss('none', false, token);
        return;
      }

      const signature = computeListSignature(candidates, listUrl);
      await tryLoadQueuedBackground(candidates, signature, token);
    } catch (error) {
      if (token !== backgroundImageLoadToken) return;
      console.error('加载背景图片列表失败:', listUrl, error);
      updateBackgroundImageCss('none', false, token);
    }
  }

  async function loadBackgroundImageFromInlineList(list, token) {
    if (token !== backgroundImageLoadToken) return;
    const candidates = normalizeListCandidates(list);
    if (!candidates.length) {
      console.warn('背景图片列表为空');
      updateBackgroundImageCss('none', false, token);
      return;
    }
    const signature = computeListSignature(candidates, 'inline');
    await tryLoadQueuedBackground(candidates, signature, token);
  }

  async function tryLoadQueuedBackground(candidates, signature, token) {
    if (!Array.isArray(candidates) || !candidates.length) return;
    const total = candidates.length;
    let attempts = 0;
    while (attempts < total && token === backgroundImageLoadToken) {
      const candidate = getNextBackgroundCandidate(signature, candidates);
      attempts += 1;
      if (!candidate) continue;
      try {
        await ensureImageLoad(candidate);
        if (token !== backgroundImageLoadToken) return;
        const cssValue = createCssUrlValue(candidate);
        updateBackgroundImageCss(cssValue, true, token, candidate);
        return;
      } catch (error) {
        console.warn('背景图片加载失败，尝试下一张:', candidate, error);
      }
    }

    if (token === backgroundImageLoadToken) {
      console.warn('列表中的背景图片均无法加载');
      updateBackgroundImageCss('none', false, token);
    }
  }

  function parseBackgroundList(text) {
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !/^\s*(#|\/\/)/.test(line))
      .map(entry => sanitizeListEntry(entry))
      .filter(Boolean);
  }

  function normalizeListCandidates(list, baseUrl = null) {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => (baseUrl ? resolveAgainstBase(entry, baseUrl) : entry))
      .map((entry) => convertPotentialWindowsPath(entry))
      .filter(Boolean);
  }

  function computeListSignature(list, sourceKey) {
    const seed = String(sourceKey || 'inline');
    let hash = 0;
    const push = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
      }
    };
    push(seed);
    push('|');
    list.forEach((entry) => {
      push(String(entry));
      push('|');
    });
    return `${seed}:${list.length}:${hash.toString(16)}`;
  }

  function shuffleArray(list) {
    const arr = Array.isArray(list) ? [...list] : [];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getNextBackgroundCandidate(signature, candidates) {
    if (backgroundImageQueueState.signature !== signature || backgroundImageQueueState.pool.length === 0) {
      backgroundImageQueueState.signature = signature;
      backgroundImageQueueState.pool = shuffleArray(candidates);
      backgroundImageQueueState.index = 0;
    } else if (backgroundImageQueueState.index >= backgroundImageQueueState.pool.length) {
      backgroundImageQueueState.pool = shuffleArray(candidates);
      backgroundImageQueueState.index = 0;
    }
    const candidate = backgroundImageQueueState.pool[backgroundImageQueueState.index];
    backgroundImageQueueState.index += 1;
    return candidate;
  }

  function sanitizeListEntry(entry) {
    if (!entry) return '';
    if (/^\s*url\(/i.test(entry)) {
      return extractUrlFromCss(entry) || '';
    }
    return entry;
  }

  function resolveAgainstBase(candidate, baseUrl) {
    if (!candidate) return candidate;
    // Already absolute
    if (/^(https?:|file:|data:)/i.test(candidate)) return candidate;
    try {
      return new URL(candidate, baseUrl).href;
    } catch (_) {
      return candidate;
    }
  }

  function ensureImageLoad(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const cleanup = () => {
        img.onload = null;
        img.onerror = null;
      };
      img.onload = () => {
        cleanup();
        resolve(url);
      };
      img.onerror = (event) => {
        cleanup();
        reject(new Error(`无法加载图片: ${url}`));
      };
      img.src = url;
    });
  }

  function createCssUrlValue(resourceUrl) {
    const escaped = String(resourceUrl).replace(/['"\\]/g, '\\$&');
    return `url("${escaped}")`;
  }

  function extractUrlFromCss(cssValue) {
    if (!cssValue) return '';
    const match = cssValue.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    return match ? match[2] : '';
  }

  function updateBackgroundImageCss(cssValue, hasImage, token, debugUrl) {
    if (token !== backgroundImageLoadToken) return;
    document.documentElement.style.setProperty('--cerebr-background-image', cssValue || 'none');

    const targets = [document.documentElement, document.body];
    targets.forEach((node) => {
      if (!node) return;
      if (hasImage) {
        node.classList.add('has-custom-background-image');
      } else {
        node.classList.remove('has-custom-background-image');
      }
    });

    if (hasImage && debugUrl) {
      console.log('[Cerebr] 已加载背景图片:', debugUrl);
    }
  }

  function applyBackgroundImageIntensity(value) {
    const numeric = clamp01(value, DEFAULT_SETTINGS.backgroundImageIntensity);
    document.documentElement.style.setProperty('--cerebr-background-image-intensity', numeric);
  }

  function applyBackgroundOverallOpacity(value) {
    const numeric = clamp01(value, DEFAULT_SETTINGS.backgroundOverallOpacity);
    document.documentElement.style.setProperty('--cerebr-background-total-opacity', numeric);
  }

  /**
   * 全屏模式背景铺满开关：
   * - 关闭：保持 contain + 模糊填充（当前默认行为）
   * - 开启：使用 cover，取消模糊填充
   * @param {boolean} enabled
   */
  function applyFullscreenBackgroundCover(enabled) {
    const useCover = !!enabled;
    document.documentElement.style.setProperty('--cerebr-fullscreen-bg-size', useCover ? 'cover' : 'contain');
    document.documentElement.style.setProperty('--cerebr-fullscreen-blur-opacity', useCover ? '0' : '1');
  }

  function refreshBackgroundImage(options = {}) {
    const { silent = false } = options || {};
    const source = currentSettings.backgroundImageUrl || '';
    const trimmedSource = String(source).trim();

    if (!trimmedSource) {
      if (!silent && typeof showNotification === 'function') {
        showNotification({
          message: '请先在设置中配置背景图片来源',
          type: 'warning',
          duration: 2400
        });
      }
      return;
    }

    if (isInlineListSource(source)) {
      applyBackgroundImage(source);
      return;
    }

    const normalizedForCheck = convertPotentialWindowsPath(trimmedSource);
    if (isTxtListSource(normalizedForCheck)) {
      applyBackgroundImage(trimmedSource);
      return;
    }

    const cacheBustToken = Date.now().toString(36);
    applyBackgroundImage(trimmedSource, { cacheBustToken });
  }

  function clamp01(input, fallback = 0) {
    const n = Number(input);
    if (Number.isNaN(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  function getScrollMinimapWidthBounds() {
    const def = SETTINGS_REGISTRY.find((item) => item.key === 'scrollMinimapWidth') || null;
    const configuredMin = Number(def?.min);
    const configuredMax = Number(def?.max);
    const min = Number.isFinite(configuredMin) ? Math.max(8, Math.round(configuredMin)) : 14;
    const max = Number.isFinite(configuredMax) ? Math.max(min, Math.round(configuredMax)) : 100;
    return { min, max };
  }

  function clampScrollMinimapWidth(value) {
    const { min, max } = getScrollMinimapWidthBounds();
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.scrollMinimapWidth;
    return Math.round(Math.min(max, Math.max(min, numeric)));
  }

  function normalizeScrollMinimapMessageMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'fixed') return 'fixed';
    return 'proportional';
  }

  function computeMinimapIdleOpacity(_opacity) {
    // 自动隐藏语义：非悬停时完全透明，仅在 hover/focus/drag 时恢复可见。
    return 0;
  }

  function applyScrollMinimapEnabled(enabled) {
    const useMinimap = !!enabled;
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-enabled', useMinimap ? '1' : '0');
  }

  function applyScrollMinimapWidth(value) {
    const width = clampScrollMinimapWidth(value);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-width', `${width}px`);
  }

  function applyScrollMinimapOpacity(value) {
    const opacity = clamp01(value, DEFAULT_SETTINGS.scrollMinimapOpacity);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-opacity', String(opacity));
    document.documentElement.style.setProperty(
      '--cerebr-scroll-minimap-idle-opacity',
      String(computeMinimapIdleOpacity(opacity))
    );
  }

  function applyScrollMinimapAutoHide(enabled) {
    const autoHide = !!enabled;
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-autohide', autoHide ? '1' : '0');
  }

  function applyScrollMinimapMessageMode(value) {
    const mode = normalizeScrollMinimapMessageMode(value);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-message-mode', mode);
  }

  function applyHideNativeScrollbarInFullscreen(enabled) {
    document.documentElement.classList.toggle('hide-native-scrollbar-fullscreen', !!enabled);
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
  
  function applyAutoRetry(enabled) {
    const normalized = !!enabled;
    if (autoRetrySwitch) {
      autoRetrySwitch.checked = normalized;
    }

    if (messageSender && typeof messageSender.setAutoRetry === 'function') {
      messageSender.setAutoRetry(normalized);
    }
  }
  
  // 应用“输入框占位符显示模型名”设置
  function applyShowModelNameInPlaceholder(enabled) {
    // 这里主要用于立即刷新占位符文案
    if (utils?.updateMessageInputPlaceholder) {
      utils.updateMessageInputPlaceholder();
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
        const currentIsDark = isDarkThemeId(currentTheme);
        const targetType = this.checked ? 'dark' : 'light';
        const shouldSwitch = (targetType === 'dark' && !currentIsDark)
          || (targetType === 'light' && currentIsDark);
        const newTheme = shouldSwitch
          ? resolveThemeIdForTargetType(currentTheme, targetType)
          : currentTheme;
        
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

    // API 配置更新后刷新“对话标题生成 API”的下拉选项
    refreshConversationTitleApiOptions();
    window.addEventListener('apiConfigsUpdated', () => {
      refreshConversationTitleApiOptions();
    });
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

  // 设置全屏内容宽度
  function setFullscreenWidth(width) { setSetting('fullscreenWidth', width); }
  
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

  function setAutoRetry(enabled) { setSetting('autoRetry', enabled); }
  
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

    // 设置面板：按布局模式展示对应的宽度滑条（侧栏/全屏）
    setupFullscreenModeObserver();

    setupEventListeners();
    setupSystemThemeListener();
    window.addEventListener('resize', () => {
      if (isStandalone) {
        updateStandaloneScaleStyles(currentSettings.scaleFactor);
      }
      syncFullscreenWidthControlBounds();
      applyFullscreenWidth(currentSettings.fullscreenWidth);
    });
    return initSettings();
  }

  // Esc 面板初始化后同步设置项位置（保持菜单分区一致）
  function refreshSettingsContainers() {
    renderSettingsFromRegistry();
  }
  
  // 公开的API
  return {
    init,
    refreshSettingsContainers,
    getSettings,
    getSetting,
    subscribe,
    setTheme,
    setSidebarWidth,
    setFullscreenWidth,
    previewFullscreenWidth,
    getFullscreenWidthBounds,
    clampFullscreenWidth,
    setFontSize,
    setScaleFactor,
    setAutoScroll,
    setStopAtTop,
    setClearOnSearch,
    setSendChatHistory,
    setAutoRetry,
    setSidebarPosition,
    refreshBackgroundImage,
    applyTheme
  };
}
