/**
 * @file Manages a tree-structured chat history, including creating messages, 
 *       finding nodes, and retrieving conversation chains.
 * @since 1.0.0
 */

/**
 * 用于表示单条消息的类型
 * @typedef {Object} MessageNode
 * @property {string} id - 唯一的消息ID
 * @property {string} role - 消息角色 (e.g. 'user', 'ai', 'system')
 * @property {string} content - 消息内容
 * @property {string|null} parentId - 父节点ID
 * @property {Array<string>} children - 子节点ID列表
 */

/**
 * 聊天历史记录的数据结构
 * @typedef {Object} ChatHistory
 * @property {Array<MessageNode>} messages - 所有消息节点列表
 * @property {string|null} root - 根节点ID
 * @property {string|null} currentNode - 当前节点ID
 */

/**
 * 创建一个新的 MessageNode 对象
 * @param {string} role - 消息角色 (e.g. 'user', 'ai')
 * @param {string} content - 消息文本内容
 * @param {string|null} [parentId=null] - 父节点ID
 * @returns {MessageNode} - 新的消息节点
 * @example
 * const node = createMessageNode('user', 'Hello world');
 * console.log(node);
 */
function createMessageNode(role, content, parentId = null) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    role,
    content,
    parentId,
    children: [],
    timestamp: Date.now()
  };
}

/**
 * 在聊天历史中查找节点
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} nodeId - 待查找的节点ID
 * @returns {MessageNode|undefined} - 找到的节点或undefined
 */
function findMessageNode(chatHistory, nodeId) {
  return chatHistory.messages.find(msg => msg.id === nodeId);
}

/**
 * 将新消息添加到聊天历史中
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} role - 消息角色
 * @param {string} content - 消息内容
 * @param {string|null} [parentId=null] - 父节点ID
 * @returns {MessageNode} - 新添加的消息节点
 * @example
 * const node = addMessageToTree(chatHistory, 'user', 'Hello');
 */
function addMessageToTree(chatHistory, role, content, parentId = null) {
  const node = createMessageNode(role, content, parentId);
  chatHistory.messages.push(node);

  if (parentId) {
    const parentNode = findMessageNode(chatHistory, parentId);
    if (parentNode) {
      parentNode.children.push(node.id);
    }
  }

  if (!chatHistory.root) {
    chatHistory.root = node.id;
  }

  chatHistory.currentNode = node.id;
  return node;
}

/**
 * 获取当前对话的完整消息链（从根节点到当前节点）
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @returns {Array<MessageNode>} - 从最早到最新的消息节点数组
 * @example
 * const chain = getCurrentConversationChain(chatHistory);
 * console.log(chain);
 */
function getCurrentConversationChain(chatHistory) {
  const chain = [];
  let currentId = chatHistory.currentNode;

  while (currentId) {
    const node = findMessageNode(chatHistory, currentId);
    if (!node) break;
    chain.unshift(node);
    currentId = node.parentId;
  }

  return chain;
}

/**
 * 清空聊天历史记录
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @example
 * clearChatHistory(chatHistory);
 */
function clearChatHistory(chatHistory) {
  chatHistory.messages = [];
  chatHistory.root = null;
  chatHistory.currentNode = null;
}

/**
 * 新增：删除指定消息节点，并维护消息的继承关系
 * 如果删除的消息存在父节点，则：
 *   - 从父节点的 children 数组中移除该消息的 id
 *   - 将删除消息的子节点重新分派到该父节点（即更新子节点的 parentId 为父节点 id，并添加到父节点的 children 列表中）
 * 如果删除的消息为根节点，则：
 *   - 若只有一个子节点，将其设为新根；若有多个子节点，则将所有子节点的 parentId 设为 null，并选第一个作为新根
 * 同时，如果当前节点是被删除的消息，则更新为父节点或 null。
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} messageId - 待删除消息的ID
 * @returns {boolean} - 删除成功返回 true，否则返回 false
 */
function deleteMessageFromHistory(chatHistory, messageId) {
  const index = chatHistory.messages.findIndex(msg => msg.id === messageId);
  if (index === -1) return false;
  const message = chatHistory.messages[index];

  if (message.parentId) {
    const parent = chatHistory.messages.find(msg => msg.id === message.parentId);
    if (parent) {
      parent.children = parent.children.filter(childId => childId !== messageId);
      // 将删除节点的所有子节点重新分派给其父节点
      message.children.forEach(childId => {
        const child = chatHistory.messages.find(msg => msg.id === childId);
        if (child) {
          child.parentId = parent.id;
          parent.children.push(child.id);
        }
      });
    }
  } else {
    // 如果删除的是根节点
    if (message.children.length > 0) {
      if (message.children.length === 1) {
        const newRoot = chatHistory.messages.find(msg => msg.id === message.children[0]);
        chatHistory.root = newRoot ? newRoot.id : null;
        if (newRoot) newRoot.parentId = null;
      } else {
        const firstChild = chatHistory.messages.find(msg => msg.id === message.children[0]);
        chatHistory.root = firstChild ? firstChild.id : null;
        message.children.forEach(childId => {
          const child = chatHistory.messages.find(msg => msg.id === childId);
          if (child) {
            child.parentId = null;
          }
        });
      }
    } else {
      chatHistory.root = null;
    }
  }

  if (chatHistory.currentNode === messageId) {
    chatHistory.currentNode = message.parentId || null;
  }
  chatHistory.messages.splice(index, 1);
  return true;
}

/**
 * 创建一个新的 ChatHistory 对象以及相关操作函数
 * @returns {{
 *   chatHistory: ChatHistory,
 *   addMessageToTree: (role: string, content: string, parentId?: string|null) => MessageNode,
 *   getCurrentConversationChain: () => Array<MessageNode>,
 *   clearHistory: () => void,
 *   deleteMessage: (messageId: string) => boolean
 * }} - 工厂函数返回一组管理函数
 * @example
 * const { chatHistory, addMessageToTree, getCurrentConversationChain } = createChatHistoryManager();
 * addMessageToTree('user', 'Hello');
 */
export function createChatHistoryManager() {
  const chatHistory = {
    messages: [],
    root: null,
    currentNode: null
  };

  return {
    chatHistory,
    addMessageToTree: (role, content, parentId = null) => addMessageToTree(chatHistory, role, content, parentId),
    getCurrentConversationChain: () => getCurrentConversationChain(chatHistory),
    clearHistory: () => clearChatHistory(chatHistory),
    deleteMessage: (messageId) => deleteMessageFromHistory(chatHistory, messageId)
  };
} 