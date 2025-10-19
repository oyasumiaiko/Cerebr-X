/**
 * 统一存储服务（Storage Service）
 *
 * 目标：
 * - 对外提供一致的 get/set/remove 接口
 * - 内部自动处理 chrome.storage.sync 的分片读写（超出单项 8KB 限制时）
 * - 提供 JSON 便捷接口，隐藏序列化细节
 * - 支持 area 选择：'sync' | 'local' | 'preferSync'（默认）
 * - 不做 local 回退，避免掩盖问题；由调用方或浏览器自身处理异常
 */

import {
  MAX_SYNC_ITEM_BYTES,
  DEFAULT_CHUNK_SUFFIX,
  getStringByteLength,
  splitStringToByteChunks,
  setChunksToSync,
  getChunksFromSync,
  removeChunksByPrefix
} from './sync_chunk.js';

// 分片相关后缀约定（基于主键 key 派生）：
// - metaKey: `${key}_chunks_meta`
// - chunkPrefix: `${key}_chunk_`
function deriveChunkKeys(key) {
  const safeKey = String(key);
  return {
    metaKey: `${safeKey}_chunks_meta`,
    chunkPrefix: `${safeKey}${DEFAULT_CHUNK_SUFFIX || '_chunk_'}`
  };
}

// 内部工具：向 sync 写入分片
async function setLargeToSync(key, serialized) {
  const { metaKey, chunkPrefix } = deriveChunkKeys(key);
  const maxBytesPerChunkData = MAX_SYNC_ITEM_BYTES - 1000; // 留余量
  const chunks = splitStringToByteChunks(serialized, maxBytesPerChunkData);
  // 先清理旧分片
  await removeChunksByPrefix(chunkPrefix);
  // 写入新分片与 meta
  await setChunksToSync(chunkPrefix, chunks, { [metaKey]: { count: chunks.length, updatedAt: Date.now() } });
}

// 内部工具：从 sync 读取分片
async function getLargeFromSync(key) {
  const { metaKey, chunkPrefix } = deriveChunkKeys(key);
  const metaWrap = await chrome.storage.sync.get([metaKey]);
  const meta = metaWrap[metaKey];
  if (!meta || !meta.count || meta.count <= 0) return null;
  return await getChunksFromSync(chunkPrefix, meta.count);
}

// 内部工具：从 sync 删除分片
async function removeLargeFromSync(key) {
  const { metaKey, chunkPrefix } = deriveChunkKeys(key);
  try { await chrome.storage.sync.remove([metaKey]); } catch (_) {}
  try { await removeChunksByPrefix(chunkPrefix); } catch (_) {}
}

export function createStorageService() {
  // 选择目标区域
  function normalizeArea(area) {
    const v = (area || 'sync').toLowerCase();
    return ['sync', 'local'].includes(v) ? v : 'sync';
  }

  // 字符串写入：根据区域自动分片/回退
  async function setString(key, value, options = {}) {
    const area = normalizeArea(options.area);
    const str = String(value ?? '');

    if (area === 'sync') {
      try {
        if (getStringByteLength(str) > (MAX_SYNC_ITEM_BYTES - 1000)) {
          await setLargeToSync(key, str);
        } else {
          await chrome.storage.sync.set({ [key]: str });
          // 清理可能存在的历史分片
          await removeLargeFromSync(key);
        }
        return true;
      } catch (e) {
        throw e;
      }
    }

    // local：直接写入 local
    await chrome.storage.local.set({ [key]: str });
    return true;
  }

  // 字符串读取：优先区域读取；对于 sync，若存在分片优先拼接
  async function getString(key, options = {}) {
    const area = normalizeArea(options.area);
    if (area === 'sync') {
      try {
        const large = await getLargeFromSync(key);
        if (typeof large === 'string') return large;
        const wrap = await chrome.storage.sync.get([key]);
        if (wrap && typeof wrap[key] === 'string') return wrap[key];
      } catch (_) {}
      return null;
    }
    // local
    const wrapLocal = await chrome.storage.local.get([key]);
    return (wrapLocal && typeof wrapLocal[key] === 'string') ? wrapLocal[key] : null;
  }

  async function remove(key, options = {}) {
    const area = normalizeArea(options.area);
    if (area === 'sync') {
      try { await chrome.storage.sync.remove([key]); } catch (_) {}
      try { await removeLargeFromSync(key); } catch (_) {}
      return true;
    }
    try { await chrome.storage.local.remove([key]); } catch (_) {}
    return true;
  }

  // JSON 便捷接口
  async function setJSON(key, obj, options = {}) {
    const str = JSON.stringify(obj ?? {});
    return setString(key, str, options);
  }

  async function getJSON(key, defaultValue = {}, options = {}) {
    const str = await getString(key, options);
    if (typeof str !== 'string') return defaultValue;
    try { return JSON.parse(str); } catch (_) { return defaultValue; }
  }

  return {
    setString,
    getString,
    setJSON,
    getJSON,
    remove
  };
}

// 默认导出一个单例，便于直接引入使用
export const storageService = createStorageService();
