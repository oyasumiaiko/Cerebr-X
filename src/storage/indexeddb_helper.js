/**
 * IndexedDB 工具模块，用于存储聊天记录
 */

/**
 * 打开或创建 "ChatHistoryDB" 数据库以及 "conversations" 和 "messageContents" 对象存储
 * @returns {Promise<IDBDatabase>}
 */
export function openChatHistoryDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ChatHistoryDB', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      
      // 创建或确保存在对话存储
      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        store.createIndex('startTime', 'startTime', { unique: false });
      }
      
      // 创建或确保存在消息内容存储
      if (!db.objectStoreNames.contains('messageContents')) {
        const store = db.createObjectStore('messageContents', { keyPath: 'id' });
        store.createIndex('conversationId', 'conversationId', { unique: false });
      }
      
      // 从数据库版本1升级到版本2的逻辑
      if (event.oldVersion === 1) {
        console.log('升级数据库：将聊天内容分离存储');
        // 不需要迁移数据，因为版本1的数据格式与版本2兼容
      }
    };
  });
}

/**
 * 获取全部对话记录元数据（不包含消息内容）
 * @returns {Promise<Array<Object>>} 包含所有对话记录元数据的数组
 */
export async function getAllConversationMetadata() {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.getAll();
    request.onsuccess = () => {
      // 返回元数据，过滤掉消息内容
      const conversations = request.result.map(conv => {
        // 只保留消息ID列表，不包含完整消息内容
        const messageIds = conv.messages ? conv.messages.map(msg => msg.id) : [];
        return {
          ...conv,
          // 只保留消息ID的数组，不包含完整内容
          messageIds,
          // 删除完整的消息数组以减少内存使用
          messages: undefined
        };
      });
      resolve(conversations);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取全部对话记录(包含完整消息内容)
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
 * 添加或更新一条对话记录，支持将大型消息内容分离存储
 * @param {Object} conversation - 对话记录对象
 * @param {boolean} [separateContent=true] - 是否将大型消息内容分离存储
 * @returns {Promise<void>}
 */
export async function putConversation(conversation, separateContent = true) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(['conversations', 'messageContents'], 'readwrite');
  const conversationStore = transaction.objectStore('conversations');
  const contentStore = transaction.objectStore('messageContents');

  // 复制会话对象，避免修改原始对象
  const conversationToStore = { ...conversation };
  
  if (separateContent && conversationToStore.messages && conversationToStore.messages.length > 0) {
    // 保存消息中的大型内容到单独的存储中
    const messagesWithRefs = [];
    
    // 处理每条消息
    for (const msg of conversationToStore.messages) {
      const messageToStore = { ...msg };
      
      // 如果消息内容是数组且包含图片，或者消息内容字符串超过10KB
      const isLargeContent = 
        (Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url')) ||
        (typeof msg.content === 'string' && msg.content.length > 10240);
      
      if (isLargeContent) {
        // 创建内容引用对象
        const contentRef = {
          id: `content_${msg.id}`,
          conversationId: conversationToStore.id,
          messageId: msg.id,
          content: msg.content
        };
        
        // 将大型内容保存到单独的存储中
        await new Promise((resolve, reject) => {
          const request = contentStore.put(contentRef);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
        
        // 将消息内容替换为引用
        messageToStore.contentRef = contentRef.id;
        // 删除原内容以减少内存使用
        delete messageToStore.content;
      }
      
      messagesWithRefs.push(messageToStore);
    }
    
    // 更新要存储的会话对象，使用引用替换后的消息数组
    conversationToStore.messages = messagesWithRefs;
  }

  return new Promise((resolve, reject) => {
    const request = conversationStore.put(conversationToStore);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除指定 id 的对话记录及其相关内容
 * @param {string} conversationId - 要删除的对话记录 id
 * @returns {Promise<void>}
 */
export async function deleteConversation(conversationId) {
  const db = await openChatHistoryDB();
  
  // 先获取会话数据，以便删除相关的消息内容
  const conversation = await getConversationById(conversationId);
  
  const transaction = db.transaction(['conversations', 'messageContents'], 'readwrite');
  const conversationStore = transaction.objectStore('conversations');
  const contentStore = transaction.objectStore('messageContents');
  
  // 删除相关的消息内容
  if (conversation && conversation.messages) {
    for (const msg of conversation.messages) {
      if (msg.contentRef) {
        await new Promise((resolve, reject) => {
          const request = contentStore.delete(msg.contentRef);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
    }
  }
  
  // 删除会话记录
  return new Promise((resolve, reject) => {
    const request = conversationStore.delete(conversationId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据对话 ID 获取单条对话记录，可选择是否加载完整消息内容
 * @param {string} conversationId - 要查找的对话记录 id
 * @param {boolean} [loadFullContent=true] - 是否加载完整消息内容
 * @returns {Promise<Object|null>} 返回匹配的对话记录对象，如果不存在则返回 null
 */
export async function getConversationById(conversationId, loadFullContent = true) {
  const db = await openChatHistoryDB();
  
  // 获取会话基本信息
  const conversation = await new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.get(conversationId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  
  // 如果不需要加载完整内容或会话不存在，直接返回
  if (!loadFullContent || !conversation || !conversation.messages) {
    return conversation;
  }
  
  // 加载引用的消息内容
  const transaction = db.transaction('messageContents', 'readonly');
  const contentStore = transaction.objectStore('messageContents');
  
  for (let i = 0; i < conversation.messages.length; i++) {
    const msg = conversation.messages[i];
    if (msg.contentRef) {
      try {
        // 加载引用的内容
        const contentRef = await new Promise((resolve, reject) => {
          const request = contentStore.get(msg.contentRef);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        
        if (contentRef) {
          // 恢复原始内容
          msg.content = contentRef.content;
        }
      } catch (error) {
        console.error(`加载消息内容失败: ${msg.contentRef}`, error);
      }
    }
  }
  
  return conversation;
}

/**
 * 加载指定消息的内容
 * @param {string} contentRefId - 内容引用ID
 * @returns {Promise<any>} 消息内容
 */
export async function loadMessageContent(contentRefId) {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('messageContents', 'readonly');
    const store = transaction.objectStore('messageContents');
    const request = store.get(contentRefId);
    request.onsuccess = () => {
      if (request.result) {
        resolve(request.result.content);
      } else {
        reject(new Error(`找不到内容引用: ${contentRefId}`));
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 释放指定会话的内存
 * @param {Object} conversation - 对话记录对象
 * @returns {Object} 释放内存后的对话记录对象
 */
export function releaseConversationMemory(conversation) {
  if (!conversation || !conversation.messages) {
    return conversation;
  }
  
  // 创建一个新对象，避免修改原始对象
  const lightConversation = { ...conversation };
  
  // 替换消息内容为引用
  lightConversation.messages = conversation.messages.map(msg => {
    const lightMsg = { ...msg };
    
    // 如果消息有内容且没有contentRef，创建引用
    if (lightMsg.content && !lightMsg.contentRef) {
      lightMsg.contentRef = `content_${lightMsg.id}`;
      delete lightMsg.content;
    }
    
    return lightMsg;
  });
  
  return lightConversation;
} 