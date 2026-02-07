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
