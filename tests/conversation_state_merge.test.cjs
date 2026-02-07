const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadMergeRulesModule() {
  const filePath = path.resolve(__dirname, '../src/ui/conversation_state_merge.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeConversationApiLock trims fields and drops empty payload', async () => {
  const { normalizeConversationApiLock } = await loadMergeRulesModule();

  assert.equal(normalizeConversationApiLock(null), null);
  assert.equal(
    normalizeConversationApiLock({ id: '   ', displayName: '', modelName: '  ', baseUrl: '' }),
    null
  );

  assert.deepEqual(
    normalizeConversationApiLock({
      id: '  cfg_1  ',
      displayName: '  主力模型 ',
      modelName: ' gpt-4o-mini ',
      baseUrl: ' https://api.example.com '
    }),
    {
      id: 'cfg_1',
      displayName: '主力模型',
      modelName: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com'
    }
  );
});

test('mergeConversationApiLockState prefers memory state when available', async () => {
  const { mergeConversationApiLockState } = await loadMergeRulesModule();

  const result = mergeConversationApiLockState({
    memoryApiLock: { id: 'mem-id', displayName: '内存锁', modelName: 'm1', baseUrl: 'u1' },
    storedApiLock: { id: 'db-id', displayName: '数据库锁', modelName: 'm2', baseUrl: 'u2' },
    preserveExistingApiLock: true
  });

  assert.equal(result.source, 'memory');
  assert.deepEqual(result.apiLock, {
    id: 'mem-id',
    displayName: '内存锁',
    modelName: 'm1',
    baseUrl: 'u1'
  });
});

test('mergeConversationApiLockState falls back to stored state when preserve is enabled', async () => {
  const { mergeConversationApiLockState } = await loadMergeRulesModule();

  const result = mergeConversationApiLockState({
    memoryApiLock: null,
    storedApiLock: { id: ' db-id ', displayName: ' 历史锁 ', modelName: ' m2 ', baseUrl: ' u2 ' },
    preserveExistingApiLock: true
  });

  assert.equal(result.source, 'stored');
  assert.deepEqual(result.apiLock, {
    id: 'db-id',
    displayName: '历史锁',
    modelName: 'm2',
    baseUrl: 'u2'
  });
});

test('mergeConversationApiLockState clears lock when preserve is disabled and memory is empty', async () => {
  const { mergeConversationApiLockState } = await loadMergeRulesModule();

  const result = mergeConversationApiLockState({
    memoryApiLock: { id: '   ', displayName: '', modelName: '', baseUrl: '' },
    storedApiLock: { id: 'db-id', displayName: '历史锁', modelName: 'm2', baseUrl: 'u2' },
    preserveExistingApiLock: false
  });

  assert.equal(result.source, 'none');
  assert.equal(result.apiLock, null);
});

test('mergeConversationSaveMetadataState keeps start-page metadata for new conversation', async () => {
  const { mergeConversationSaveMetadataState } = await loadMergeRulesModule();

  const result = mergeConversationSaveMetadataState({
    isUpdate: false,
    startPageMeta: { url: ' https://example.com ', title: ' 首页 ' },
    summaryCandidate: '自动摘要'
  });

  assert.deepEqual(result, {
    urlToSave: 'https://example.com',
    titleToSave: '首页',
    summaryToSave: '自动摘要',
    summarySourceToSave: 'default',
    parentConversationIdToSave: null,
    forkedFromMessageIdToSave: null
  });
});

test('mergeConversationSaveMetadataState preserves existing summary and branch metadata on update', async () => {
  const { mergeConversationSaveMetadataState } = await loadMergeRulesModule();

  const result = mergeConversationSaveMetadataState({
    isUpdate: true,
    startPageMeta: { url: 'https://new.example', title: '新标题' },
    summaryCandidate: '新自动摘要',
    summaryFromExistingTitle: '按旧标题重算',
    existingConversation: {
      url: ' https://old.example ',
      title: ' 旧标题 ',
      summary: '用户手动命名',
      summarySource: ' manual ',
      parentConversationId: ' parent-1 ',
      forkedFromMessageId: ' msg-1 '
    }
  });

  assert.deepEqual(result, {
    urlToSave: 'https://old.example',
    titleToSave: '旧标题',
    summaryToSave: '用户手动命名',
    summarySourceToSave: 'manual',
    parentConversationIdToSave: 'parent-1',
    forkedFromMessageIdToSave: 'msg-1'
  });
});

test('mergeConversationSaveMetadataState uses summaryFromExistingTitle when existing summary is empty', async () => {
  const { mergeConversationSaveMetadataState } = await loadMergeRulesModule();

  const result = mergeConversationSaveMetadataState({
    isUpdate: true,
    startPageMeta: { url: 'https://new.example', title: '新标题' },
    summaryCandidate: '新自动摘要',
    summaryFromExistingTitle: '按旧标题重算',
    existingConversation: {
      url: 'https://old.example',
      title: '旧标题',
      summary: '',
      summarySource: '   ',
      parentConversationId: '',
      forkedFromMessageId: ''
    }
  });

  assert.deepEqual(result, {
    urlToSave: 'https://old.example',
    titleToSave: '旧标题',
    summaryToSave: '按旧标题重算',
    summarySourceToSave: null,
    parentConversationIdToSave: null,
    forkedFromMessageIdToSave: null
  });
});
