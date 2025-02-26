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
        '--cerebr-highlight': 'rgb(0, 105, 255)'
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
        '--cerebr-background-color': '#21252b',
        '--cerebr-highlight': '#61afef'
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
        '--cerebr-highlight': '#0366d6'
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
        '--cerebr-highlight': '#58a6ff'
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
        '--cerebr-highlight': '#569cd6'
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
        '--cerebr-highlight': '#61afef'
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
        '--cerebr-highlight': '#66d9ef'
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
        '--cerebr-highlight': '#268bd2'
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
        '--cerebr-highlight': '#268bd2'
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
        '--cerebr-highlight': '#88c0d0'
      }
    },
    {
      id: 'dracula',
      name: 'Dracula',
      description: '经典吸血鬼深色主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 42, 54, var(--cerebr-opacity))',
        '--cerebr-text-color': '#f8f8f2',
        '--cerebr-message-user-bg': 'rgba(68, 71, 90, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(56, 58, 75, var(--cerebr-opacity))', 
        '--cerebr-input-bg': 'rgba(34, 35, 48, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#bd93f9',
        '--cerebr-border-color': '#44475a',
        '--cerebr-hover-color': 'rgba(189, 147, 249, 0.1)',
        '--cerebr-background-color': '#282a36',
        '--cerebr-highlight': '#8be9fd'
      }
    },
    {
      id: 'tokyo-night',
      name: 'Tokyo Night',
      description: '东京之夜深色主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(26, 27, 38, var(--cerebr-opacity))',
        '--cerebr-text-color': '#a9b1d6',
        '--cerebr-message-user-bg': 'rgba(36, 40, 59, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(32, 34, 48, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(24, 25, 36, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#bb9af7',
        '--cerebr-border-color': '#292e42',
        '--cerebr-hover-color': 'rgba(103, 110, 149, 0.1)',
        '--cerebr-background-color': '#1a1b26',
        '--cerebr-highlight': '#7aa2f7'
      }
    },
    {
      id: 'tokyo-night-light',
      name: 'Tokyo Night Day',
      description: '东京白日浅色主题',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(224, 222, 244, var(--cerebr-opacity))',
        '--cerebr-text-color': '#343b58',
        '--cerebr-message-user-bg': 'rgba(196, 204, 229, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(210, 212, 228, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(229, 233, 240, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#5a4a78',
        '--cerebr-border-color': '#cbcadf',
        '--cerebr-hover-color': 'rgba(90, 74, 120, 0.05)',
        '--cerebr-background-color': '#e1e2e7',
        '--cerebr-highlight': '#34548a'
      }
    },
    {
      id: 'material-ocean',
      name: 'Material Ocean',
      description: '深海蓝材质主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(15, 17, 26, var(--cerebr-opacity))',
        '--cerebr-text-color': '#8f93a2',
        '--cerebr-message-user-bg': 'rgba(35, 40, 52, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(28, 32, 43, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(20, 23, 31, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#84ffff',
        '--cerebr-border-color': '#1f2233',
        '--cerebr-hover-color': 'rgba(84, 207, 216, 0.1)',
        '--cerebr-background-color': '#0f111a',
        '--cerebr-highlight': '#82aaff'
      }
    },
    {
      id: 'material-lighter',
      name: 'Material Lighter',
      description: '浅色材质主题',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(250, 250, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#546e7a',
        '--cerebr-message-user-bg': 'rgba(227, 242, 253, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(240, 240, 240, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#00bcd4',
        '--cerebr-border-color': '#e7eaec',
        '--cerebr-hover-color': 'rgba(0, 188, 212, 0.05)',
        '--cerebr-background-color': '#fafafa',
        '--cerebr-highlight': '#2196f3'
      }
    },
    {
      id: 'synthwave',
      name: 'Synthwave',
      description: '复古赛博朋克主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(39, 16, 62, var(--cerebr-opacity))',
        '--cerebr-text-color': '#ff7edb',
        '--cerebr-message-user-bg': 'rgba(54, 22, 87, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(45, 19, 72, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(34, 14, 54, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#36f9f6',
        '--cerebr-border-color': '#482a74',
        '--cerebr-hover-color': 'rgba(255, 126, 219, 0.15)',
        '--cerebr-background-color': '#2a1b3d',
        '--cerebr-highlight': '#36f9f6'
      }
    },
    {
      id: 'apple-light',
      name: 'Apple Light',
      description: 'macOS浅色主题',
      variables: {
        '--cerebr-opacity': '0.65',
        '--cerebr-bg-color': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-text-color': '#333333',
        '--cerebr-message-user-bg': 'rgba(209, 232, 255, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(240, 240, 247, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(248, 248, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#007aff',
        '--cerebr-border-color': '#e4e4e4',
        '--cerebr-hover-color': 'rgba(0, 122, 255, 0.05)',
        '--cerebr-background-color': '#ffffff',
        '--cerebr-highlight': '#007aff'
      }
    },
    {
      id: 'apple-dark',
      name: 'Apple Dark',
      description: 'macOS深色主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(28, 28, 30, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e4e4e4',
        '--cerebr-message-user-bg': 'rgba(50, 50, 56, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 40, 45, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(36, 36, 38, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#0a84ff',
        '--cerebr-border-color': '#3d3d41',
        '--cerebr-hover-color': 'rgba(10, 132, 255, 0.1)',
        '--cerebr-background-color': '#1c1c1e',
        '--cerebr-highlight': '#0a84ff'
      }
    },
    {
      id: 'gruvbox-dark',
      name: 'Gruvbox Dark',
      description: '复古暖色调深色主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 40, 40, var(--cerebr-opacity))',
        '--cerebr-text-color': '#ebdbb2',
        '--cerebr-message-user-bg': 'rgba(60, 56, 54, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(50, 48, 47, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(45, 43, 42, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#b8bb26',
        '--cerebr-border-color': '#504945',
        '--cerebr-hover-color': 'rgba(251, 73, 52, 0.1)',
        '--cerebr-background-color': '#282828',
        '--cerebr-highlight': '#83a598'
      }
    },
    {
      id: 'gruvbox-light',
      name: 'Gruvbox Light',
      description: '复古暖色调浅色主题',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(251, 241, 199, var(--cerebr-opacity))',
        '--cerebr-text-color': '#3c3836',
        '--cerebr-message-user-bg': 'rgba(235, 219, 178, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(242, 229, 188, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(249, 245, 215, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#9d0006',
        '--cerebr-border-color': '#d5c4a1',
        '--cerebr-hover-color': 'rgba(157, 0, 6, 0.05)',
        '--cerebr-background-color': '#fbf1c7',
        '--cerebr-highlight': '#076678'
      }
    },
    {
      id: 'ayu-mirage',
      name: 'Ayu Mirage',
      description: '柔和中性色调主题',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(31, 33, 42, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c7c8c2',
        '--cerebr-message-user-bg': 'rgba(44, 48, 58, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(38, 41, 50, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(26, 28, 35, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ffcc66',
        '--cerebr-border-color': '#373e4c',
        '--cerebr-hover-color': 'rgba(255, 204, 102, 0.1)',
        '--cerebr-background-color': '#1f212a',
        '--cerebr-highlight': '#5ccfe6'
      }
    },
    {
      id: 'ayu-light',
      name: 'Ayu Light',
      description: '柔和浅色调主题',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(250, 250, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#5c6166',
        '--cerebr-message-user-bg': 'rgba(235, 239, 242, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ff9940',
        '--cerebr-border-color': '#eee',
        '--cerebr-hover-color': 'rgba(255, 153, 64, 0.05)',
        '--cerebr-background-color': '#fafafa',
        '--cerebr-highlight': '#55b4d4'
      }
    },
    {
      id: 'catppuccin-mocha',
      name: 'Catppuccin Mocha',
      description: '柔和深色咖啡主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(30, 30, 46, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cdd6f4',
        '--cerebr-message-user-bg': 'rgba(49, 50, 68, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 40, 58, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(24, 24, 38, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#cba6f7',
        '--cerebr-border-color': '#45475a',
        '--cerebr-hover-color': 'rgba(203, 166, 247, 0.1)',
        '--cerebr-background-color': '#1e1e2e',
        '--cerebr-highlight': '#89b4fa'
      }
    },
    {
      id: 'catppuccin-latte',
      name: 'Catppuccin Latte',
      description: '柔和浅色奶茶主题',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(239, 241, 245, var(--cerebr-opacity))',
        '--cerebr-text-color': '#4c4f69',
        '--cerebr-message-user-bg': 'rgba(220, 224, 232, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(230, 233, 239, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(249, 250, 251, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#8839ef',
        '--cerebr-border-color': '#bcc0cc',
        '--cerebr-hover-color': 'rgba(136, 57, 239, 0.05)',
        '--cerebr-background-color': '#eff1f5',
        '--cerebr-highlight': '#1e66f5'
      }
    },
    {
      id: 'onedark-pro',
      name: 'One Dark Pro',
      description: '专业深色开发主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 44, 52, var(--cerebr-opacity))',
        '--cerebr-text-color': '#abb2bf',
        '--cerebr-message-user-bg': 'rgba(55, 61, 72, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(47, 52, 61, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(33, 37, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c678dd',
        '--cerebr-border-color': '#3e4451',
        '--cerebr-hover-color': 'rgba(198, 120, 221, 0.1)',
        '--cerebr-background-color': '#282c34',
        '--cerebr-highlight': '#61afef'
      }
    },
    {
      id: 'palenight',
      name: 'Palenight',
      description: '紫色调深夜主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(41, 45, 62, var(--cerebr-opacity))',
        '--cerebr-text-color': '#bfc7d5',
        '--cerebr-message-user-bg': 'rgba(59, 66, 86, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(50, 55, 73, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(34, 38, 53, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c792ea',
        '--cerebr-border-color': '#4e5579',
        '--cerebr-hover-color': 'rgba(199, 146, 234, 0.1)',
        '--cerebr-background-color': '#292d3e',
        '--cerebr-highlight': '#82aaff'
      }
    },
    {
      id: 'rosepine',
      name: 'Rosé Pine',
      description: '舒适柔和深色主题',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(25, 23, 36, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0def4',
        '--cerebr-message-user-bg': 'rgba(42, 39, 57, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(33, 30, 46, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(19, 17, 29, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c4a7e7',
        '--cerebr-border-color': '#42384d',
        '--cerebr-hover-color': 'rgba(196, 167, 231, 0.1)',
        '--cerebr-background-color': '#191724',
        '--cerebr-highlight': '#9ccfd8'
      }
    },
    {
      id: 'rosepine-dawn',
      name: 'Rosé Pine Dawn',
      description: '舒适柔和浅色主题',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(250, 244, 237, var(--cerebr-opacity))',
        '--cerebr-text-color': '#575279',
        '--cerebr-message-user-bg': 'rgba(236, 226, 216, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(242, 236, 229, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 250, 243, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#907aa9',
        '--cerebr-border-color': '#e5e0d9',
        '--cerebr-hover-color': 'rgba(144, 122, 169, 0.05)',
        '--cerebr-background-color': '#faf4ed',
        '--cerebr-highlight': '#56949f'
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
    
    // 更新data-theme属性，供主题预览识别当前主题
    root.setAttribute('data-theme', themeId);
    
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

  /**
   * 渲染主题预览卡片
   * @param {HTMLElement} container - 预览卡片容器元素
   * @param {Function} onThemeSelect - 主题选择回调函数
   */
  function renderThemePreview(container, onThemeSelect) {
    if (!container) return;
    
    // 清空容器
    container.innerHTML = '';
    
    // 获取当前主题ID
    const currentThemeId = document.documentElement.getAttribute('data-theme') || 'auto';
    
    // 检测系统深浅色模式，用于auto主题的预览
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    // 为所有预设主题创建预览卡片
    PREDEFINED_THEMES.forEach(theme => {
      const themeId = theme.id;
      
      // 创建预览卡片
      const previewCard = document.createElement('div');
      previewCard.className = 'theme-preview-card';
      previewCard.setAttribute('data-theme-id', themeId);
      
      if (themeId === currentThemeId) {
        previewCard.classList.add('active');
      }
      
      // 设置预览卡片的CSS变量
      let themeVars;
      
      // 为auto主题特殊处理，使用系统当前深浅模式对应的主题变量
      if (themeId === 'auto') {
        const systemTheme = getThemeById(prefersDark ? 'dark' : 'light');
        themeVars = systemTheme.variables;
        
        // 为auto主题预览卡片添加标识
        previewCard.classList.add(prefersDark ? 'dark-mode' : 'light-mode');
      } else {
        themeVars = theme.variables;
      }
      
      previewCard.style.setProperty('--preview-bg', themeVars['--cerebr-bg-color'] || '#ffffff');
      previewCard.style.setProperty('--preview-body-bg', themeVars['--cerebr-background-color'] || '#ffffff');
      previewCard.style.setProperty('--preview-user-msg', themeVars['--cerebr-message-user-bg'] || '#e1f5fe');
      previewCard.style.setProperty('--preview-ai-msg', themeVars['--cerebr-message-ai-bg'] || '#f5f5f5');
      
      // 创建预览内容
      const previewContent = document.createElement('div');
      previewContent.className = 'theme-preview-content';
      
      // 创建顶部栏
      const header = document.createElement('div');
      header.className = 'theme-preview-header';
      
      // 创建消息区域
      const messagesContainer = document.createElement('div');
      messagesContainer.className = 'theme-preview-messages';
      
      // 添加模拟消息
      const aiMessage1 = document.createElement('div');
      aiMessage1.className = 'theme-preview-message ai';
      
      const userMessage = document.createElement('div');
      userMessage.className = 'theme-preview-message user';
      
      const aiMessage2 = document.createElement('div');
      aiMessage2.className = 'theme-preview-message ai';
      
      messagesContainer.appendChild(aiMessage1);
      messagesContainer.appendChild(userMessage);
      messagesContainer.appendChild(aiMessage2);
      
      // 创建主题名称
      const themeName = document.createElement('div');
      themeName.className = 'theme-preview-card-name';
      themeName.textContent = theme.name;
      
      // 为auto主题添加系统模式指示
      if (themeId === 'auto') {
        const modeIndicator = document.createElement('span');
        modeIndicator.className = 'auto-theme-indicator';
        modeIndicator.textContent = prefersDark ? ' (当前: 深色)' : ' (当前: 浅色)';
        themeName.appendChild(modeIndicator);
      }
      
      // 组装预览卡片
      previewContent.appendChild(header);
      previewContent.appendChild(messagesContainer);
      previewCard.appendChild(previewContent);
      previewCard.appendChild(themeName);
      
      // 添加点击事件
      previewCard.addEventListener('click', () => {
        // 移除其他卡片的active类
        document.querySelectorAll('.theme-preview-card.active').forEach(card => {
          card.classList.remove('active');
        });
        
        // 为当前卡片添加active类
        previewCard.classList.add('active');
        
        // 调用回调函数
        if (typeof onThemeSelect === 'function') {
          onThemeSelect(themeId);
        }
      });
      
      // 添加到容器
      container.appendChild(previewCard);
    });
  }

  /**
   * 初始化函数
   * @param {string} [initialThemeId] - 初始应用的主题ID，若未提供则使用'auto'
   */
  function init(initialThemeId) {
    setupSystemThemeListener();
    
    // 应用初始主题
    const themeToApply = initialThemeId || document.documentElement.getAttribute('data-theme') || 'auto';
    applyTheme(themeToApply);
  }

  // 返回主题管理器接口
  return {
    getAvailableThemes,
    getThemeById,
    applyTheme,
    notifyThemeChange,
    renderThemePreview,
    init
  };
} 