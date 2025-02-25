/**
 * IndexedDB 工具模块，用于存储聊天记录
 */

/**
 * 打开或创建 "ChatHistoryDB" 数据库以及 "conversations" 对象存储
 * @returns {Promise<IDBDatabase>}
 */
export function openChatHistoryDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ChatHistoryDB', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        store.createIndex('startTime', 'startTime', { unique: false });
      }
    };
  });
}

/**
 * 获取全部对话记录
 * @returns {Promise<Array<Object>>} 包含所有对话记录的数组
 */
export async function getAllConversations() {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 添加或更新一条对话记录
 * @param {Object} conversation - 对话记录对象
 * @returns {Promise<void>}
 */
export async function putConversation(conversation) {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readwrite');
    const store = transaction.objectStore('conversations');
    const request = store.put(conversation);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除指定 id 的对话记录
 * @param {string} conversationId - 要删除的对话记录 id
 * @returns {Promise<void>}
 */
export async function deleteConversation(conversationId) {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readwrite');
    const store = transaction.objectStore('conversations');
    const request = store.delete(conversationId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据对话 ID 获取单条对话记录
 * @param {string} conversationId - 要查找的对话记录 id
 * @returns {Promise<Object|null>} 返回匹配的对话记录对象，如果不存在则返回 null
 */
export async function getConversationById(conversationId) {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.get(conversationId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
} 