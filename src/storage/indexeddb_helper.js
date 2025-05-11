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
    const conversations = []; // 用于累积结果的数组
    const request = store.openCursor(); // 使用游标代替 getAll()

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        // 获取当前记录
        const conv = cursor.value;
        
        // 执行与之前相同的转换逻辑
        const messageIds = conv.messages ? conv.messages.map(msg => msg.id) : [];
        conversations.push({
          ...conv, // 保留原始对话对象的所有属性
          messageIds, // 添加处理过的 messageIds
          messages: undefined // 显式移除原始的 messages 数组
        });
        
        cursor.continue(); // 继续到下一条记录
      } else {
        // 没有更多记录了，游标遍历完成
        resolve(conversations);
      }
    };

    request.onerror = (event) => {
      // 处理游标请求期间的错误
      reject(event.target.error);
    };
  });
}

/**
 * 获取全部对话记录(包含完整消息内容)
 * @param {boolean} [loadFullContent=true] - 是否加载完整消息内容
 * @returns {Promise<Array<Object>>} 包含所有对话记录的数组
 */
export async function getAllConversations(loadFullContent = true) {
  const db = await openChatHistoryDB();
  
  // 获取所有会话基本信息
  const conversations = await new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // 如果不需要加载完整内容或没有会话，直接返回
  if (!loadFullContent || !conversations || conversations.length === 0) {
    return conversations;
  }

  // 加载所有引用的消息内容
  const transaction = db.transaction('messageContents', 'readonly');
  const contentStore = transaction.objectStore('messageContents');

  // 处理每个会话，使用 attachContentToMessage 替换重复逻辑
  for (const conversation of conversations) {
    if (conversation.messages) {
      for (let i = 0; i < conversation.messages.length; i++) {
        const msg = conversation.messages[i];
        if (msg.contentRef) {
          conversation.messages[i] = await attachContentToMessage(msg, contentStore);
        }
      }
    }
  }

  return conversations;
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
      
      // 如果消息内容是数组且包含图片
      const isLargeContent = (Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'));
      
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
 * 纯函数：从消息对象中加载并附加引用的消息内容，返回新的消息对象
 * @param {Object} msg - 原始消息对象
 * @param {IDBObjectStore} contentStore - 用于获取消息内容的对象仓库
 * @returns {Promise<Object>} 返回一个新消息对象，包含解引用后的内容
 */
async function attachContentToMessage(msg, contentStore) {
  if (!msg.contentRef) return msg;
  try {
    const contentRecord = await new Promise((resolve, reject) => {
      const request = contentStore.get(msg.contentRef);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (contentRecord) {
      return { ...msg, content: contentRecord.content };
    }
  } catch (error) {
    console.error(`加载消息内容失败: ${msg.contentRef}`, error);
  }
  return msg;
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
  
  // 遍历每条消息，利用纯函数附加引用的内容
  for (let i = 0; i < conversation.messages.length; i++) {
    const msg = conversation.messages[i];
    if (msg.contentRef) {
      conversation.messages[i] = await attachContentToMessage(msg, contentStore);
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

/**
 * 获取数据库存储统计信息
 * @returns {Promise<Object>} 包含数据库统计信息的对象
 */
export async function getDatabaseStats() {
  try {
    const db = await openChatHistoryDB();
    const encoder = new TextEncoder();
    
    // 获取所有会话
    const conversations = await getAllConversations(false);
    
    // 获取所有分离的消息内容
    const contentRefs = await new Promise((resolve, reject) => {
      const transaction = db.transaction('messageContents', 'readonly');
      const store = transaction.objectStore('messageContents');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    // 计算统计信息
    let totalMessages = 0;
    let totalImageMessages = 0;
    let totalTextSize = 0;
    let totalImageSize = 0;
    let largestMessage = 0;
    let oldestMessageDate = Date.now();
    let newestMessageDate = 0;
    
    // 分析会话数据
    conversations.forEach(conv => {
      if (conv.messages) {
        totalMessages += conv.messages.length;
        
        conv.messages.forEach(msg => {
          // 计算时间范围
          if (msg.timestamp) {
            oldestMessageDate = Math.min(oldestMessageDate, msg.timestamp);
            newestMessageDate = Math.max(newestMessageDate, msg.timestamp);
          }
          
          // 检查内容类型和大小
          if (msg.content) {
            if (typeof msg.content === 'string') {
              const size = encoder.encode(msg.content).length;
              totalTextSize += size;
              largestMessage = Math.max(largestMessage, size);
            } else if (Array.isArray(msg.content)) {
              // 处理图片和文本混合内容
              let msgSize = 0;
              msg.content.forEach(part => {
                if (part.type === 'text' && part.text) {
                  const textSize = encoder.encode(part.text).length;
                  msgSize += textSize;
                  totalTextSize += textSize;
                } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                  // 估算base64图片大小（大约是base64字符串长度的3/4）
                  const imageSize = Math.round((part.image_url.url.length * 3) / 4);
                  msgSize += imageSize;
                  totalImageSize += imageSize;
                  totalImageMessages++;
                }
              });
              largestMessage = Math.max(largestMessage, msgSize);
            }
          }
        });
      }
    });
    
    // 分析分离存储的内容
    contentRefs.forEach(ref => {
      if (ref.content) {
        if (typeof ref.content === 'string') {
          totalTextSize += encoder.encode(ref.content).length;
        } else if (Array.isArray(ref.content)) {
          ref.content.forEach(part => {
            if (part.type === 'text' && part.text) {
              totalTextSize += encoder.encode(part.text).length;
            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
              // 估算base64图片大小
              totalImageSize += Math.round((part.image_url.url.length * 3) / 4);
            }
          });
        }
      }
    });
    
    // 格式化大小为人类可读格式
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    };
    
    // 计算时间跨度
    const timeSpanDays = (newestMessageDate - oldestMessageDate) / (1000 * 60 * 60 * 24);
    
    return {
      conversationsCount: conversations.length,
      messagesCount: totalMessages,
      imageMessagesCount: totalImageMessages,
      messageContentRefsCount: contentRefs.length,
      totalTextSize: totalTextSize,
      totalTextSizeFormatted: formatSize(totalTextSize),
      totalImageSize: totalImageSize,
      totalImageSizeFormatted: formatSize(totalImageSize),
      totalSize: totalTextSize + totalImageSize,
      totalSizeFormatted: formatSize(totalTextSize + totalImageSize),
      largestMessageSize: largestMessage,
      largestMessageSizeFormatted: formatSize(largestMessage),
      oldestMessageDate: oldestMessageDate !== Date.now() ? new Date(oldestMessageDate) : null,
      newestMessageDate: newestMessageDate !== 0 ? new Date(newestMessageDate) : null,
      timeSpanDays: timeSpanDays > 0 ? Math.round(timeSpanDays) : 0
    };
  } catch (error) {
    console.error('获取数据库统计信息失败:', error);
    return {
      error: error.message,
      conversationsCount: 0,
      messagesCount: 0,
      totalSizeFormatted: '0 B'
    };
  }
} 