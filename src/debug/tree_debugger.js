/**
 * @file tree_debugger.js
 * @description 提供函数以树状可视化形式调试当前聊天记录树结构。
 * @since 1.0.0
 */

/**
 * 获取指定 id 的消息节点
 * @param {Array<Object>} messages - 聊天记录中的所有消息数组
 * @param {string} id - 消息的 id
 * @returns {Object|null} 找到的消息节点或 null
 */
function getMessageNodeById(messages, id) {
  return messages.find(msg => msg.id === id) || null;
}

/**
 * 递归构建树形结构的 HTML 元素，用于显示聊天记录树
 * 为了增强可视化效果，增加了点击节点折叠/展开子树的功能
 * @param {Array<Object>} messages - 聊天记录中的所有消息数组
 * @param {string} nodeId - 当前节点 id
 * @returns {HTMLElement} <li> 元素，包含当前节点信息及其子节点的嵌套列表
 */
function createTreeItem(messages, nodeId) {
  const node = getMessageNodeById(messages, nodeId);
  const li = document.createElement('li');
  if (!node) {
    li.textContent = '未找到节点 ' + nodeId;
    return li;
  }
  // 创建一个 span 用于显示节点信息
  const label = document.createElement('span');
  label.innerHTML = `[${node.role}] ${node.content.substring(0, 30)} (${node.id})`;
  li.appendChild(label);
  
  if (node.children && node.children.length > 0) {
    const ul = document.createElement('ul');
    ul.style.display = 'block';
    node.children.forEach(childId => {
      ul.appendChild(createTreeItem(messages, childId));
    });
    li.appendChild(ul);
    // 添加点击事件以折叠/展开子树
    label.style.cursor = 'pointer';
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      ul.style.display = (ul.style.display === 'none' ? 'block' : 'none');
    });
  }
  return li;
}

/**
 * 将聊天记录树以树状结构显示到指定容器中
 * @param {HTMLElement} container - 用于显示树状内容的容器元素
 * @param {Object} chatHistory - 当前聊天记录树对象，包含 messages、root、currentNode 属性
 */
export function displayChatHistoryTree(container, chatHistory) {
  container.innerHTML = ''; // 清空容器内容

  if (!chatHistory.root) {
    container.textContent = '聊天记录为空';
    return;
  }
  
  const ul = document.createElement('ul');
  ul.appendChild(createTreeItem(chatHistory.messages, chatHistory.root));
  container.appendChild(ul);
}

/**
 * 初始化聊天记录树调试窗口，构建一个固定定位的调试面板来可视化聊天记录树
 * @param {Object} chatHistory - 当前聊天记录树对象，通常由 chatHistoryManager 提供
 */
export function initTreeDebugger(chatHistory) {
  // 查找或创建调试窗口容器
  let debuggerContainer = document.getElementById('tree-debugger-container');
  if (!debuggerContainer) {
    debuggerContainer = document.createElement('div');
    debuggerContainer.id = 'tree-debugger-container';
    debuggerContainer.style.position = 'fixed';
    debuggerContainer.style.top = '5%';
    debuggerContainer.style.left = '5%';
    debuggerContainer.style.width = '90%';
    debuggerContainer.style.height = '90%';
    debuggerContainer.style.backgroundColor = 'rgb(240, 240, 240)';
    debuggerContainer.style.border = '1px solid rgb(204, 204, 204)';
    debuggerContainer.style.padding = '8px';
    debuggerContainer.style.overflowY = 'auto';
    debuggerContainer.style.zIndex = 9999;

    // 添加标题栏和关闭按钮
    const titleBar = document.createElement('div');
    titleBar.style.display = 'flex';
    titleBar.style.justifyContent = 'space-between';
    titleBar.style.alignItems = 'center';
    titleBar.style.marginBottom = '8px';

    const title = document.createElement('span');
    title.textContent = '聊天记录树调试';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => {
      debuggerContainer.style.display = 'none';
    });

    titleBar.appendChild(title);
    titleBar.appendChild(closeBtn);
    debuggerContainer.appendChild(titleBar);

    // 添加刷新按钮
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '刷新';
    refreshBtn.style.cursor = 'pointer';
    refreshBtn.style.marginBottom = '8px';
    refreshBtn.addEventListener('click', () => {
      displayTree();
    });
    debuggerContainer.appendChild(refreshBtn);

    // 添加选项卡用于切换视图
    const tabContainer = document.createElement('div');
    tabContainer.style.display = 'flex';
    tabContainer.style.marginBottom = '8px';
    
    const rawArrayTab = document.createElement('button');
    rawArrayTab.textContent = '数组视图';
    rawArrayTab.style.flex = '1';
    rawArrayTab.style.cursor = 'pointer';
    
    const dependencyTab = document.createElement('button');
    dependencyTab.textContent = '依赖视图';
    dependencyTab.style.flex = '1';
    dependencyTab.style.cursor = 'pointer';
    
    tabContainer.appendChild(rawArrayTab);
    tabContainer.appendChild(dependencyTab);
    debuggerContainer.appendChild(tabContainer);
    
    // 内容容器，用于显示调试内容
    const contentContainer = document.createElement('div');
    contentContainer.id = 'tree-debugger-content';
    debuggerContainer.appendChild(contentContainer);
    
    let activeTab = 'raw'; // 默认激活 raw 数组视图
    
    rawArrayTab.addEventListener('click', () => {
      activeTab = 'raw';
      updateContent();
    });
    
    dependencyTab.addEventListener('click', () => {
      activeTab = 'dependency';
      updateContent();
    });
    
    function updateContent() {
      contentContainer.innerHTML = '';
      if (activeTab === 'raw') {
        updateRawArrayView(chatHistory, contentContainer);
      } else if (activeTab === 'dependency') {
        updateDependencyView(chatHistory, contentContainer);
      }
    }
    updateContent();

    document.body.appendChild(debuggerContainer);
  } else {
    debuggerContainer.style.display = 'block';
  }
  displayTree();

  /**
   * 内部函数：更新调试窗口内容
   */
  function displayTree() {
    const contentContainer = document.getElementById('tree-debugger-content');
    displayChatHistoryTree(contentContainer, chatHistory);
  }
}

/**
 * 更新原始数组视图，将聊天记录 messages 数组格式化显示
 * @param {Object} chatHistory - 当前聊天记录树对象
 * @param {HTMLElement} container - 内容容器
 */
function updateRawArrayView(chatHistory, container) {
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordWrap = 'break-word';
  pre.textContent = JSON.stringify(chatHistory.messages, null, 2);
  container.appendChild(pre);
}

/**
 * 更新依赖视图，使用 Cytoscape.js 展示每个消息的依赖关系（父子关系）
 * 节点显示：[消息类型] 消息内容前15个字符 (消息id)
 * 边表示父子关系
 * @param {Object} chatHistory - 当前聊天记录树对象
 * @param {HTMLElement} container - 内容容器
 */
function updateDependencyView(chatHistory, container) {
  // 清空内容容器
  container.innerHTML = '';
  // 确保传入的容器填满空间
  container.style.height = '100%';
  
  // 创建 Cytoscape.js 容器，使其填满传入容器
  const cyContainer = document.createElement('div');
  cyContainer.style.width = '100%';
  cyContainer.style.height = '100%';
  container.appendChild(cyContainer);
  
  // 构造 Cytoscape 节点与边数据
  const elements = [];
  
  // 先收集所有存在的消息 id
  const messageIds = new Set(chatHistory.messages.map(msg => msg.id));
  
  chatHistory.messages.forEach(msg => {
    // 节点显示：消息内容前15个字符、消息类型及消息 id
    const label = `[${msg.role}] ${msg.content.substring(0, 15)} (${msg.id})`;
    elements.push({
      data: { id: msg.id, label: label }
    });
    // 如果存在 parentId 并且该父节点存在，则添加一条边，从父节点指向当前消息
    if (msg.parentId && messageIds.has(msg.parentId)) {
      elements.push({
        data: { id: `${msg.parentId}-${msg.id}`, source: msg.parentId, target: msg.id }
      });
    }
  });
  
  // 初始化 Cytoscape 实例
  const cy = window.cytoscape({
    container: cyContainer,
    elements: elements,
    style: [
      {
        selector: 'node',
        style: {
          'shape': 'rectangle',                 // 使用方形节点
          'label': 'data(label)',
          'background-color': '#67a9cf',
          'text-valign': 'center',
          'color': '#fff',
          'font-size': '10px',
          'text-wrap': 'none',                  // 不换行，让节点宽度完全根据内容自适应
          'width': 'label',                     // 节点宽度自适应标签内容宽度
          'height': 'label',                    // 节点高度自适应标签内容高度
          'padding': '10px'                     // 内边距可为节点增加额外空间
        }
      },
      {
        selector: 'edge',
        style: {
          'width': 2,
          'line-color': '#ccc',
          'target-arrow-color': '#ccc',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier'               // 平滑曲线
        }
      }
    ],
    layout: {
      name: 'dagre',                        // 使用 dagre 布局，使图更紧凑和自适应
      rankDir: 'TB',                        // 从上到下
      nodeSep: 20,                          // 节点间隔
      edgeSep: 10,                          // 边间隔
      rankSep: 40,                          // 层间间隔
      animate: true,                        // 启用布局动画
      animationDuration: 500                // 动画时长
    }
  });
} 