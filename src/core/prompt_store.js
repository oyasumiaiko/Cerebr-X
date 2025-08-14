/**
 * 提示词存储模块（无UI依赖）
 * - 负责从 chrome.storage.sync 读取/写入提示词配置
 * - 支持按类型分块存储以绕过单项字节限制
 * - 提供旧数据迁移能力（从 {prompts} 老格式迁移到分类型键）
 *
 * 偏函数式实现，便于复用与测试。
 * @since 1.1.0
 */

/** @typedef {Object} PromptItem
 * @property {string} prompt 提示词内容
 * @property {string} model 偏好模型（或 'follow_current'）
 */

/**
 * 常量定义
 */
export const PROMPT_KEY_PREFIX = 'prompt_';
export const PROMPT_CHUNK_KEY_PREFIX_SUFFIX = '_chunk_';

import {
  MAX_SYNC_ITEM_BYTES,
  DEFAULT_CHUNK_SUFFIX,
  getStringByteLength,
  splitStringToByteChunks,
  setChunksToSync,
  getChunksFromSync,
  removeChunksByPrefix
} from '../utils/sync_chunk.js';

/**
 * 获取字符串的UTF-8字节长度
 * @param {string} str - 输入字符串
 * @returns {number} 字符串的UTF-8字节长度
 */
// 统一改用 ../utils/sync_chunk.js 提供的实现

/**
 * 迁移旧格式的提示词设置到新格式
 * 旧格式：chrome.storage.sync 下存在 { prompts: { [type]: { prompt, model } } }
 * 新格式：每个类型使用独立 key 'prompt_${type}'
 * @returns {Promise<void>}
 */
export async function migrateOldPromptSettings() {
  try {
    const oldData = await new Promise(resolve => {
      chrome.storage.sync.get(['prompts'], result => resolve(result.prompts));
    });

    if (!oldData) return;

    const migrationTasks = Object.entries(oldData).map(([type, settings]) =>
      new Promise(resolve => {
        chrome.storage.sync.set({ [`${PROMPT_KEY_PREFIX}${type}`]: settings }, resolve);
      })
    );
    await Promise.all(migrationTasks);

    await new Promise(resolve => chrome.storage.sync.remove(['prompts'], resolve));
  } catch (error) {
    console.error('迁移提示词设置时出错:', error);
  }
}

/**
 * 读取所有指定类型的提示词配置（自动组装分块）
 * @param {Array<string>} types - 提示词类型列表
 * @returns {Promise<Object<string, PromptItem>>} map: type -> { prompt, model }
 */
export async function loadAllPromptSettings(types) {
  const results = await Promise.all(types.map(type => loadPromptByType(type)));
  const map = {};
  results.forEach(([type, item]) => { map[type] = item; });
  return map;
}

/**
 * 读取单个类型的提示词配置
 * @param {string} type 提示词类型
 * @returns {Promise<[string, PromptItem]>}
 */
export async function loadPromptByType(type) {
  const mainKey = `${PROMPT_KEY_PREFIX}${type}`;
  return new Promise(resolve => {
    chrome.storage.sync.get([mainKey], async (result) => {
      if (chrome.runtime.lastError) {
        console.error(`Error loading prompt ${type}:`, chrome.runtime.lastError.message);
        resolve([type, { prompt: '', model: 'follow_current' }]);
        return;
      }

      let settings = result[mainKey];
      if (settings && settings.isChunked && typeof settings.chunkCount === 'number' && settings.chunkCount > 0) {
        const chunkKeyBase = `${PROMPT_KEY_PREFIX}${type}${DEFAULT_CHUNK_SUFFIX}`;
        try {
          const fullPrompt = await getChunksFromSync(chunkKeyBase, settings.chunkCount);
          settings = { prompt: fullPrompt, model: settings.model };
        } catch (e) {
          console.error(`读取分块失败: ${type}`, e);
          settings = { prompt: '', model: 'follow_current' };
        }
      }

      if (!settings) settings = { prompt: '', model: 'follow_current' };
      resolve([type, settings]);
    });
  });
}

/**
 * 清除指定类型提示词的所有分块
 * @param {string} type 提示词类型
 * @returns {Promise<void>}
 */
export async function clearChunksForType(type) {
  try {
    const chunkPrefix = `${PROMPT_KEY_PREFIX}${type}${DEFAULT_CHUNK_SUFFIX}`;
    await removeChunksByPrefix(chunkPrefix);
  } catch (e) {
    console.error(`Exception while clearing chunks for type ${type}:`, e);
  }
}

/**
 * 批量保存提示词（自动分块）
 * @param {Object<string, PromptItem>} items 待保存数据（来自UI）
 * @param {Object<string, PromptItem>} previousSavedState 之前已保存状态（用于回退部分失败场景）
 * @returns {Promise<Object<string, PromptItem>>} 实际保存后的新状态（可能包含回退）
 */
export async function savePromptSettingsBulk(items, previousSavedState = {}) {
  const newState = {};
  const saveOps = [];

  for (const type in items) {
    const item = items[type];
    const mainKey = `${PROMPT_KEY_PREFIX}${type}`;

    await clearChunksForType(type);

    const itemToStore = { prompt: item.prompt, model: item.model };
    const itemBytes = getStringByteLength(JSON.stringify(itemToStore));

    if (itemBytes < MAX_SYNC_ITEM_BYTES) {
      // 直接存储
      saveOps.push(chrome.storage.sync.set({ [mainKey]: itemToStore }));
      newState[type] = { prompt: item.prompt, model: item.model };
      continue;
    }

    // 分块存储
    const chunkKeyBase = `${PROMPT_KEY_PREFIX}${type}${DEFAULT_CHUNK_SUFFIX}`;
    const promptToChunk = item.prompt || '';
    const maxBytesPerChunkData = MAX_SYNC_ITEM_BYTES - 1000; // 预留开销
    const chunks = splitStringToByteChunks(promptToChunk, maxBytesPerChunkData);

    if (chunks.length > 0) {
      await setChunksToSync(chunkKeyBase, chunks);
      saveOps.push(chrome.storage.sync.set({ [mainKey]: { model: item.model, isChunked: true, chunkCount: chunks.length } }));
      newState[type] = { prompt: item.prompt, model: item.model };
    } else if ((promptToChunk || '').length > 0) {
      console.warn(`Prompt 过长且分块失败，未保存: ${type}`);
      newState[type] = previousSavedState[type] || { prompt: '', model: item.model };
    } else {
      newState[type] = { prompt: '', model: item.model };
    }
  }

  await Promise.all(saveOps.map(op => op && op.catch?.(e => { throw e; })));
  return newState;
}


