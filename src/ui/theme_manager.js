/**
 * 主题管理模块
 * 提供多种预设主题和主题切换功能
 * @module theme_manager
 */

/**
 * 创建主题管理器
 * @returns {Object} 主题管理器实例
 */
export function createThemeManager() {
  /**
   * 预设主题配置
   * 每个主题包含名称、描述和CSS变量配置
   * @type {Array<Object>}
   */
  const PREDEFINED_THEMES = [
    {
      id: 'auto',
      name: '跟随系统',
      description: '自动跟随系统深浅色模式设置',
      variables: {} // 自动模式不需要变量，会根据系统设置选择light或dark
    },
    {
      id: 'light',
      name: '浅色',
      description: '默认浅色主题',
      variables: {
        '--cerebr-opacity': '0.6',
        '--cerebr-bg-color': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-text-color': '#222',
        '--cerebr-message-user-bg': 'rgba(227, 242, 253, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(248, 248, 248, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#666',
        '--cerebr-border-color': '#e1e4e8',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.02)',
        '--cerebr-background-color': '#ffffff',
        '--cerebr-blue': 'rgb(0, 105, 255)'
      }
    },
    {
      id: 'dark',
      name: '深色',
      description: '默认深色主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(38, 43, 51, var(--cerebr-opacity))',
        '--cerebr-text-color': '#abb2bf',
        '--cerebr-message-user-bg': 'rgba(62, 68, 81, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(44, 49, 60, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(33, 37, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#abb2bf',
        '--cerebr-border-color': '#30363d',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-background-color': '#21252b'
      }
    },
    {
      id: 'github-light',
      name: 'GitHub Light',
      description: 'GitHub 风格浅色主题',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(246, 248, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#24292e',
        '--cerebr-message-user-bg': 'rgba(221, 244, 255, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#6a737d',
        '--cerebr-border-color': '#e1e4e8',
        '--cerebr-hover-color': 'rgba(3, 102, 214, 0.05)',
        '--cerebr-background-color': '#f6f8fa',
        '--cerebr-blue': '#0366d6'
      }
    },
    {
      id: 'github-dark',
      name: 'GitHub Dark',
      description: 'GitHub 风格深色主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(13, 17, 23, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c9d1d9',
        '--cerebr-message-user-bg': 'rgba(33, 38, 45, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(22, 27, 34, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(13, 17, 23, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#8b949e',
        '--cerebr-border-color': '#30363d',
        '--cerebr-hover-color': 'rgba(56, 139, 253, 0.1)',
        '--cerebr-background-color': '#0d1117',
        '--cerebr-blue': '#58a6ff'
      }
    },
    {
      id: 'vscode-dark',
      name: 'VS Code Dark+',
      description: 'Visual Studio Code 深色主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(30, 30, 30, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d4d4d4',
        '--cerebr-message-user-bg': 'rgba(37, 37, 38, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(45, 45, 45, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(51, 51, 51, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#cccccc',
        '--cerebr-border-color': '#404040',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-background-color': '#1e1e1e',
        '--cerebr-blue': '#569cd6'
      }
    },
    {
      id: 'night-blue',
      name: '夜空蓝',
      description: '深蓝色夜间主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(25, 30, 42, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0e0e0',
        '--cerebr-message-user-bg': 'rgba(44, 52, 73, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(32, 39, 55, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(21, 25, 36, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a0a0a0',
        '--cerebr-border-color': '#2d384a',
        '--cerebr-hover-color': 'rgba(100, 149, 237, 0.1)',
        '--cerebr-background-color': '#191e2a',
        '--cerebr-blue': '#61afef'
      }
    },
    {
      id: 'monokai',
      name: 'Monokai',
      description: '经典 Monokai 主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(39, 40, 34, var(--cerebr-opacity))',
        '--cerebr-text-color': '#f8f8f2',
        '--cerebr-message-user-bg': 'rgba(73, 72, 62, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(49, 50, 43, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(29, 30, 25, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a6e22e',
        '--cerebr-border-color': '#49483e',
        '--cerebr-hover-color': 'rgba(166, 226, 46, 0.1)',
        '--cerebr-background-color': '#272822',
        '--cerebr-blue': '#66d9ef'
      }
    },
    {
      id: 'solarized-light',
      name: 'Solarized Light',
      description: '护眼浅色主题',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(253, 246, 227, var(--cerebr-opacity))',
        '--cerebr-text-color': '#657b83',
        '--cerebr-message-user-bg': 'rgba(238, 232, 213, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(253, 246, 227, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(238, 232, 213, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#839496',
        '--cerebr-border-color': '#eee8d5',
        '--cerebr-hover-color': 'rgba(38, 139, 210, 0.1)',
        '--cerebr-background-color': '#fdf6e3',
        '--cerebr-blue': '#268bd2'
      }
    },
    {
      id: 'solarized-dark',
      name: 'Solarized Dark',
      description: '护眼深色主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(0, 43, 54, var(--cerebr-opacity))',
        '--cerebr-text-color': '#93a1a1',
        '--cerebr-message-user-bg': 'rgba(7, 54, 66, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(0, 43, 54, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(0, 33, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#839496',
        '--cerebr-border-color': '#073642',
        '--cerebr-hover-color': 'rgba(38, 139, 210, 0.1)',
        '--cerebr-background-color': '#002b36',
        '--cerebr-blue': '#268bd2'
      }
    },
    {
      id: 'nord',
      name: 'Nord',
      description: '北欧风格主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(46, 52, 64, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d8dee9',
        '--cerebr-message-user-bg': 'rgba(59, 66, 82, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(67, 76, 94, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(46, 52, 64, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#81a1c1',
        '--cerebr-border-color': '#3b4252',
        '--cerebr-hover-color': 'rgba(136, 192, 208, 0.1)',
        '--cerebr-background-color': '#2e3440',
        '--cerebr-blue': '#88c0d0'
      }
    }
  ];

  /**
   * 获取所有可用主题
   * @returns {Array<Object>} 主题列表
   */
  function getAvailableThemes() {
    return PREDEFINED_THEMES;
  }

  /**
   * 根据ID获取主题
   * @param {string} themeId - 主题ID
   * @returns {Object|null} 主题对象或null（未找到时）
   */
  function getThemeById(themeId) {
    return PREDEFINED_THEMES.find(theme => theme.id === themeId) || null;
  }

  /**
   * 应用主题到DOM
   * @param {string} themeId - 主题ID
   * @returns {boolean} 是否成功应用主题
   */
  function applyTheme(themeId) {
    const theme = getThemeById(themeId);
    if (!theme) return false;

    const root = document.documentElement;
    
    // 清除所有主题相关的类
    root.classList.remove('dark-theme', 'light-theme');
    
    // 应用主题类和变量
    if (themeId === 'auto') {
      // 跟随系统主题
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(prefersDark ? 'dark-theme' : 'light-theme');
      
      // 应用对应主题的CSS变量
      const systemTheme = getThemeById(prefersDark ? 'dark' : 'light');
      Object.entries(systemTheme.variables).forEach(([key, value]) => {
        root.style.setProperty(key, value);
      });
    } else {
      // 为dark主题及其变种添加dark-theme类，其他添加light-theme类
      if (themeId === 'dark' || themeId.includes('dark') || themeId === 'monokai' || themeId === 'nord' || themeId === 'vscode-dark' || themeId === 'night-blue') {
        root.classList.add('dark-theme');
      } else {
        root.classList.add('light-theme');
      }
      
      // 应用主题CSS变量
      Object.entries(theme.variables).forEach(([key, value]) => {
        root.style.setProperty(key, value);
      });
    }
    
    return true;
  }

  /**
   * 通知父窗口主题变化
   * @param {string} themeId - 主题ID
   */
  function notifyThemeChange(themeId) {
    window.parent.postMessage({
      type: 'THEME_CHANGE',
      themeId: themeId
    }, '*');
  }

  /**
   * 设置监听系统主题变化事件
   */
  function setupSystemThemeListener() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    // 当系统主题变化且当前使用的是自动主题时，更新主题
    const handleThemeChange = (e) => {
      const currentThemeId = document.documentElement.getAttribute('data-theme') || 'auto';
      if (currentThemeId === 'auto') {
        applyTheme('auto');
      }
    };
    
    // 添加事件监听
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleThemeChange);
    } else if (mediaQuery.addListener) {
      // 兼容性处理
      mediaQuery.addListener(handleThemeChange);
    }
  }

  // 初始化函数
  function init() {
    setupSystemThemeListener();
  }

  // 返回主题管理器接口
  return {
    getAvailableThemes,
    getThemeById,
    applyTheme,
    notifyThemeChange,
    init
  };
} 