/**
 * IndexedDB 工具模块，用于存储聊天记录
 */

/**
 * 打开或创建 "ChatHistoryDB" 数据库以及 "conversations" 和 "messageContents" 对象存储
 * @returns {Promise<IDBDatabase>}
 */
export function openChatHistoryDB() {
  return new Promise((resolve, reject) => {
    // v3: 为性能优化新增 conversations.endTime 与 conversations.url 索引
    // - endTime：用于快速按“最近对话”分页加载（避免全量扫描 + 排序）
    // - url：用于“按当前 URL 快速筛选历史会话”（按前缀范围查询）
    const request = indexedDB.open('ChatHistoryDB', 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      const tx = event.target.transaction;
      
      // 创建或确保存在对话存储
      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        store.createIndex('startTime', 'startTime', { unique: false });
        store.createIndex('endTime', 'endTime', { unique: false });
        store.createIndex('url', 'url', { unique: false });
      } else {
        // 既有数据库升级：补齐缺失索引（必须在 onupgradeneeded 的 transaction 内完成）
        try {
          const store = tx.objectStore('conversations');
          if (store && !store.indexNames.contains('startTime')) {
            store.createIndex('startTime', 'startTime', { unique: false });
          }
          if (store && !store.indexNames.contains('endTime')) {
            store.createIndex('endTime', 'endTime', { unique: false });
          }
          if (store && !store.indexNames.contains('url')) {
            store.createIndex('url', 'url', { unique: false });
          }
        } catch (e) {
          console.warn('升级 conversations 索引失败（可能由浏览器兼容性/事务状态导致）:', e);
        }
      }
      
      // 创建或确保存在消息内容存储
      if (!db.objectStoreNames.contains('messageContents')) {
        const store = db.createObjectStore('messageContents', { keyPath: 'id' });
        store.createIndex('conversationId', 'conversationId', { unique: false });
      } else {
        // 兼容旧库：补齐 messageContents.conversationId 索引
        try {
          const store = tx.objectStore('messageContents');
          if (store && !store.indexNames.contains('conversationId')) {
            store.createIndex('conversationId', 'conversationId', { unique: false });
          }
        } catch (_) {}
      }
      
      // 从数据库版本1升级到版本2的逻辑
      if (event.oldVersion === 1) {
        console.log('升级数据库：将聊天内容分离存储');
        // 不需要迁移数据，因为版本1的数据格式与版本2兼容
      }

      if (event.oldVersion < 3) {
        console.log('升级数据库：为 conversations 增加 endTime/url 索引（提升历史列表与 URL 筛选性能）');
      }
    };
  });
}

/**
 * 将 conversations 表中的完整会话对象压缩为“列表/筛选用”的轻量元数据。
 *
 * 注意：
 * - IndexedDB 的 cursor.value / store.get 会把整条记录结构化克隆出来（可能包含 messages 大数组）。
 *   这里做“压缩”主要是为了：
 *   1) 降低上层 UI 的内存占用；
 *   2) 避免上层误用 messages 导致额外遍历。
 * - 这不会减少数据库读取成本，但能显著减少 JS 堆里长期保留的数据量。
 *
 * @param {Object} conv
 * @returns {{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number}}
 */
function compactConversationToMetadata(conv) {
  const id = conv?.id || '';
  const url = typeof conv?.url === 'string' ? conv.url : '';
  const title = typeof conv?.title === 'string' ? conv.title : '';
  const summary = typeof conv?.summary === 'string' ? conv.summary : '';
  const startTime = Number(conv?.startTime) || 0;
  const endTime = Number(conv?.endTime) || 0;
  const messageCount = Number(conv?.messageCount) || (Array.isArray(conv?.messages) ? conv.messages.length : 0) || 0;
  return { id, url, title, summary, startTime, endTime, messageCount };
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
 * 批量按 id 读取会话“轻量元数据”。
 * @param {string[]} ids
 * @returns {Promise<Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number}>>}
 */
export async function getConversationMetadataByIds(ids) {
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (idList.length === 0) return [];

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  const tasks = idList.map((id) => new Promise((resolve) => {
    try {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result ? compactConversationToMetadata(request.result) : null);
      request.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  }));

  const results = await Promise.all(tasks);
  return results.filter(Boolean);
}

/**
 * 按 endTime 倒序分页读取会话“轻量元数据”。
 *
 * 说明：
 * - 优先使用 conversations.endTime 索引；若索引不存在，则回退为全量扫描（仅作为兜底）。
 * - 该分页 cursor 设计为“尽量稳定”：用 endTime + seenIds 解决同一 endTime 重复值导致的翻页重复/遗漏问题。
 *
 * @param {Object} options
 * @param {number} [options.limit=50]
 * @param {{endTime:number, seenIds:string[]}|null} [options.cursor=null]
 * @param {string[]|Set<string>} [options.excludeIds=[]] - 需要跳过的会话 id（例如置顶会话）
 * @returns {Promise<{items: Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number}>, cursor: {endTime:number, seenIds:string[]} | null, hasMore: boolean}>}
 */
export async function getConversationMetadataPageByEndTimeDesc(options = {}) {
  const limit = Math.max(0, Number(options.limit) || 50);
  if (limit === 0) return { items: [], cursor: null, hasMore: false };

  const cursorIn = options.cursor && typeof options.cursor === 'object' ? options.cursor : null;
  const cursorEndTime = cursorIn && Number.isFinite(Number(cursorIn.endTime)) ? Number(cursorIn.endTime) : null;
  const cursorSeenIds = new Set(Array.isArray(cursorIn?.seenIds) ? cursorIn.seenIds : []);

  const excludeIds = (() => {
    if (options.excludeIds instanceof Set) return options.excludeIds;
    if (Array.isArray(options.excludeIds)) return new Set(options.excludeIds.filter(Boolean));
    return new Set();
  })();

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  // 优先走 endTime 索引（v3+）
  let endTimeIndex = null;
  try {
    if (store.indexNames.contains('endTime')) {
      endTimeIndex = store.index('endTime');
    }
  } catch (_) {
    endTimeIndex = null;
  }

  // --- 索引不可用：兜底为全量扫描（仅保证功能正确，不保证性能） ---
  if (!endTimeIndex) {
    const all = await new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor();
      req.onsuccess = (event) => {
        const c = event.target.result;
        if (!c) {
          resolve(out);
          return;
        }
        out.push(compactConversationToMetadata(c.value));
        c.continue();
      };
      req.onerror = (event) => reject(event.target.error);
    });

    const filtered = all.filter((item) => item && item.id && !excludeIds.has(item.id));
    filtered.sort((a, b) => (Number(b.endTime) || 0) - (Number(a.endTime) || 0));
    const items = filtered.slice(0, limit);
    return { items, cursor: null, hasMore: filtered.length > items.length };
  }

  const keyRange = cursorEndTime != null ? IDBKeyRange.upperBound(cursorEndTime) : null;
  const items = [];
  let hasMore = false;

  // 分页：记录“最后一条返回记录的 endTime”以及该 endTime 下已返回过的 id 集合
  let lastReturnedEndTime = null;
  let lastReturnedIdsAtEndTime = [];

  return await new Promise((resolve, reject) => {
    const request = endTimeIndex.openCursor(keyRange, 'prev');
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve({ items, cursor: null, hasMore: false });
        return;
      }

      const conv = cursor.value;
      const meta = compactConversationToMetadata(conv);

      // 跳过：置顶/排除项
      if (!meta.id || excludeIds.has(meta.id)) {
        cursor.continue();
        return;
      }

      // 跳过：同一个 endTime 下已返回过的 id（用于稳定翻页）
      const metaEndTime = Number(meta.endTime) || 0;
      if (cursorEndTime != null && metaEndTime === cursorEndTime && cursorSeenIds.has(meta.id)) {
        cursor.continue();
        return;
      }

      items.push(meta);

      if (lastReturnedEndTime == null || metaEndTime !== lastReturnedEndTime) {
        lastReturnedEndTime = metaEndTime;
        lastReturnedIdsAtEndTime = [meta.id];
      } else {
        lastReturnedIdsAtEndTime.push(meta.id);
      }

      if (items.length >= limit) {
        hasMore = true;

        // 生成下一页 cursor
        const nextEndTime = lastReturnedEndTime == null ? metaEndTime : lastReturnedEndTime;
        const nextSeenIds = (() => {
          // 若下一页仍停留在同一个 endTime，需要把旧 seenIds 合并进去，避免重复
          if (cursorEndTime != null && nextEndTime === cursorEndTime) {
            const merged = new Set(cursorSeenIds);
            lastReturnedIdsAtEndTime.forEach((id) => merged.add(id));
            return Array.from(merged);
          }
          return lastReturnedIdsAtEndTime.slice();
        })();

        resolve({
          items,
          cursor: { endTime: nextEndTime, seenIds: nextSeenIds },
          hasMore
        });
        return;
      }

      cursor.continue();
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 按“URL 前缀候选列表”筛选出匹配的会话元数据，并标注匹配等级。
 *
 * 说明：
 * - 若存在 conversations.url 索引（v3+），则用前缀范围查询以避免全库扫描；
 * - 匹配等级以 candidateUrls 的索引为准：越靠前越“严格/具体”；
 * - 同一会话只会分配到最严格的那个等级（去重逻辑：先处理更严格的 candidate）。
 *
 * @param {string[]} candidateUrls
 * @returns {Promise<Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, urlMatchLevel:number, urlMatchPrefix:string}>>}
 */
export async function listConversationMetadataByUrlCandidates(candidateUrls) {
  const candidates = Array.isArray(candidateUrls)
    ? candidateUrls.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  if (candidates.length === 0) return [];

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  let urlIndex = null;
  try {
    if (store.indexNames.contains('url')) {
      urlIndex = store.index('url');
    }
  } catch (_) {
    urlIndex = null;
  }

  // v3+：优先用 url 索引按前缀查
  if (urlIndex) {
    const seenIds = new Set();
    const results = [];

    // 逐个 candidate 查询：先严格后宽松，确保“等级”分配稳定
    for (let level = 0; level < candidates.length; level += 1) {
      const prefix = candidates[level];
      const upper = `${prefix}\uffff`;
      const range = IDBKeyRange.bound(prefix, upper, false, false);

      await new Promise((resolve, reject) => {
        const req = urlIndex.openCursor(range);
        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve();
            return;
          }
          const conv = cursor.value;
          const meta = compactConversationToMetadata(conv);
          if (meta.id && !seenIds.has(meta.id)) {
            seenIds.add(meta.id);
            results.push({
              ...meta,
              urlMatchLevel: level,
              urlMatchPrefix: prefix
            });
          }
          cursor.continue();
        };
        req.onerror = (event) => reject(event.target.error);
      });
    }

    return results;
  }

  // 兜底：全量扫描（仅保证功能正确，不保证性能）
  return await new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      const conv = cursor.value;
      const meta = compactConversationToMetadata(conv);
      const url = meta.url || '';
      const level = candidates.findIndex((prefix) => url.startsWith(prefix));
      if (level >= 0) {
        out.push({
          ...meta,
          urlMatchLevel: level,
          urlMatchPrefix: candidates[level]
        });
      }
      cursor.continue();
    };
    req.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 根据一组 URL 候选前缀，从 IndexedDB 中找出“最适合继续对话”的会话元数据。
 *
 * 设计背景：
 * - “继续本页对话”只需要定位到一个会话（通常是最近的一条），不需要把所有会话都搬到内存里再排序；
 * - 旧实现会先取出全部会话元数据并在 UI 层做排序/扫描；
 * - 这里将匹配逻辑下沉到游标遍历过程中，避免：
 *   - 额外的数组构建与排序开销；
 *   - 为每条会话计算 messageIds（这在会话很多/消息很多时会显著拖慢）。
 *
 * 匹配规则：
 * - candidateUrls 为“从严格到宽松”的前缀列表；
 * - 优先命中更严格的 candidate；
 * - 在同一个 candidate 下，选择 endTime 最大的会话；
 * - endTime 相同则保留更早遇到的记录（等价于稳定排序后的选择结果）。
 *
 * 返回值：
 * - 返回一个“精简版”会话对象（仅包含 id/url/startTime/endTime/title），以降低对象复制与内存占用；
 * - 调用方如需完整 messages，请再用 getConversationById 加载。
 *
 * @param {string[]} candidateUrls
 * @returns {Promise<({id:string, url?:string, startTime?:number, endTime?:number, title?:string}|null)>}
 */
export async function findMostRecentConversationMetadataByUrlCandidates(candidateUrls) {
  const candidates = Array.isArray(candidateUrls)
    ? candidateUrls.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  if (candidates.length === 0) return null;

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  // v3+：若存在 url 索引，优先走“前缀范围查询”，避免全量扫描
  let urlIndex = null;
  try {
    if (store.indexNames.contains('url')) {
      urlIndex = store.index('url');
    }
  } catch (_) {
    urlIndex = null;
  }

  if (urlIndex) {
    for (let level = 0; level < candidates.length; level += 1) {
      const prefix = candidates[level];
      const upper = `${prefix}\uffff`;
      const range = IDBKeyRange.bound(prefix, upper, false, false);

      const best = await new Promise((resolve, reject) => {
        let bestMeta = null;
        let bestEndTime = -1;
        const req = urlIndex.openCursor(range);
        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(bestMeta);
            return;
          }
          const conv = cursor.value;
          const endTime = Number(conv?.endTime) || 0;
          if (!bestMeta || endTime > bestEndTime) {
            bestMeta = {
              id: conv?.id,
              url: conv?.url,
              startTime: conv?.startTime,
              endTime: conv?.endTime,
              title: conv?.title
            };
            bestEndTime = endTime;
          }
          cursor.continue();
        };
        req.onerror = (event) => reject(event.target.error);
      });

      if (best) return best;
    }
    return null;
  }

  // 兜底：无 url 索引时，回退为全量扫描
  return await new Promise((resolve, reject) => {
    const bestByIndex = new Array(candidates.length).fill(null);
    const bestEndTimeByIndex = new Array(candidates.length).fill(-1);

    const request = store.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        for (let i = 0; i < bestByIndex.length; i += 1) {
          if (bestByIndex[i]) {
            resolve(bestByIndex[i]);
            return;
          }
        }
        resolve(null);
        return;
      }

      const conv = cursor.value;
      const url = conv?.url;
      if (typeof url === 'string' && url.length > 0) {
        for (let i = 0; i < candidates.length; i += 1) {
          const candidate = candidates[i];
          if (!url.startsWith(candidate)) continue;

          const endTime = Number(conv?.endTime) || 0;
          if (!bestByIndex[i] || endTime > bestEndTimeByIndex[i]) {
            bestByIndex[i] = {
              id: conv?.id,
              url: conv?.url,
              startTime: conv?.startTime,
              endTime: conv?.endTime,
              title: conv?.title
            };
            bestEndTimeByIndex[i] = endTime;
          }
          break;
        }
      }

      cursor.continue();
    };

    request.onerror = (event) => {
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
      } else {
        // 不再是大型内容：如存在历史 contentRef，需要清理引用并删除旧的分离内容。
        //
        // 重要：当 msg.content 不存在（例如 UI/缓存为了省内存主动释放了 content，只保留 contentRef）时，
        // 我们无法判定它是否“真的不再需要分离”，此时绝不能删除 messageContents 记录，否则会造成图片/大段内容丢失。
        // 只有在“明确提供了 content 且判断为非大型内容”的情况下，才执行清理。
        if (messageToStore.contentRef) {
          const contentMissing = (msg.content === undefined || msg.content === null);
          if (!contentMissing) {
            const refId = messageToStore.contentRef;
            try {
              await new Promise((resolve, reject) => {
                const delReq = contentStore.delete(refId);
                delReq.onsuccess = () => resolve();
                delReq.onerror = () => reject(delReq.error);
              });
            } catch (e) {
              console.warn('删除过期内容引用失败:', refId, e);
            }
            delete messageToStore.contentRef;
          }
        }
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
 * 扫描 messageContents 表，删除未被任何消息引用的内容，避免遗留的 base64 或孤儿记录撑爆存储
 * @returns {Promise<{ removed: number, total: number }>}
 */
export async function purgeOrphanMessageContents() {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(['conversations', 'messageContents'], 'readwrite');
  const conversationStore = transaction.objectStore('conversations');
  const contentStore = transaction.objectStore('messageContents');

  // 收集所有会话中仍在使用的 contentRef ID
  const usedRefs = new Set();
  await new Promise((resolve, reject) => {
    const request = conversationStore.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const conv = cursor.value;
        if (conv?.messages && Array.isArray(conv.messages)) {
          conv.messages.forEach((msg) => {
            if (msg?.contentRef) usedRefs.add(msg.contentRef);
          });
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });

  // 遍历 messageContents，删除不在引用集合中的记录
  let removed = 0;
  let total = 0;
  await new Promise((resolve, reject) => {
    const request = contentStore.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        total += 1;
        const key = cursor.primaryKey;
        if (!usedRefs.has(key)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });

  return { removed, total };
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
    let conversationCount = 0;
    const domainCounts = new Map();
    
    // 分析会话数据
    conversations.forEach(conv => {
      conversationCount++;
      // 统计域名
      if (conv.url) {
        try {
          const u = new URL(conv.url);
          const host = u.hostname || 'unknown';
          domainCounts.set(host, (domainCounts.get(host) || 0) + 1);
        } catch {}
      }
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
    
    // 生成域名 Top 10
    const topDomains = Array.from(domainCounts.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    // 格式化大小为人类可读格式
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    };
    
    // 计算时间跨度
    const timeSpanDays = (newestMessageDate - oldestMessageDate) / (1000 * 60 * 60 * 24);
    
    const conversationsCount = conversations.length;
    const avgMessagesPerConversation = conversationsCount > 0 ? (totalMessages / conversationsCount) : 0;
    const avgTextBytesPerMessage = totalMessages > 0 ? (totalTextSize / totalMessages) : 0;

    return {
      conversationsCount,
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
      timeSpanDays: timeSpanDays > 0 ? Math.round(timeSpanDays) : 0,
      avgMessagesPerConversation,
      avgTextBytesPerMessage,
      avgTextBytesPerMessageFormatted: formatSize(Math.round(avgTextBytesPerMessage)),
      topDomains
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
