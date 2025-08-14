/**
 * 通用的 chrome.storage.sync 分片读写工具
 * 统一基于“按字节切分字符串”的策略，避免单项 8KB 限制
 */

/**
 * 每项最大字节（留余量），chrome.storage.sync.QUOTA_BYTES_PER_ITEM = 8192
 * 保守使用 8000 字节，避免键名和元数据开销导致越界
 */
export const MAX_SYNC_ITEM_BYTES = 8000;

/**
 * 默认分片键后缀
 */
export const DEFAULT_CHUNK_SUFFIX = '_chunk_';

/**
 * 计算字符串的字节长度（UTF-8）
 * @param {string} str
 * @returns {number}
 */
export function getStringByteLength(str) {
  return new TextEncoder().encode(str || '').length;
}

/**
 * 将字符串按字节上限切分为多个片段
 * @param {string} str - 待分片的字符串
 * @param {number} maxBytesPerChunk - 每片最大字节数（建议 < MAX_SYNC_ITEM_BYTES）
 * @returns {string[]} 分片后的字符串数组
 */
export function splitStringToByteChunks(str, maxBytesPerChunk) {
  const text = String(str || '');
  const chunks = [];
  let charOffset = 0;
  while (charOffset < text.length) {
    let currentChunkStr = '';
    let currentChunkByteLen = 0;
    let currentEnd = charOffset;
    while (currentEnd < text.length) {
      const nextChar = text[currentEnd];
      const bytes = getStringByteLength(nextChar);
      if (currentChunkByteLen + bytes > maxBytesPerChunk) {
        break;
      }
      currentChunkStr += nextChar;
      currentChunkByteLen += bytes;
      currentEnd++;
    }
    if (!currentChunkStr) break;
    chunks.push(currentChunkStr);
    charOffset = currentEnd;
  }
  return chunks;
}

/**
 * 批量写入分片到 chrome.storage.sync
 * @param {string} chunkKeyBase - 分片键前缀（不含序号）
 * @param {string[]} chunks - 分片字符串数组
 * @returns {Promise<void>}
 */
export async function setChunksToSync(chunkKeyBase, chunks) {
  const ops = [];
  chunks.forEach((val, idx) => {
    const key = `${chunkKeyBase}${idx}`;
    ops.push(chrome.storage.sync.set({ [key]: val }));
  });
  await Promise.all(ops);
}

/**
 * 读取指定数量的分片并按序拼接
 * @param {string} chunkKeyBase - 分片键前缀（不含序号）
 * @param {number} count - 分片数量
 * @returns {Promise<string>} 拼接后的完整字符串
 */
export async function getChunksFromSync(chunkKeyBase, count) {
  const keys = Array.from({ length: count }, (_, i) => `${chunkKeyBase}${i}`);
  const result = await new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, items => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(items);
    });
  });
  return keys.map(k => result[k] || '').join('');
}

/**
 * 根据前缀删除所有分片键
 * @param {string} chunkKeyPrefix - 分片键前缀（包含后缀）
 * @returns {Promise<void>}
 */
export async function removeChunksByPrefix(chunkKeyPrefix) {
  const all = await chrome.storage.sync.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(chunkKeyPrefix));
  if (keys.length > 0) {
    await chrome.storage.sync.remove(keys);
  }
}


