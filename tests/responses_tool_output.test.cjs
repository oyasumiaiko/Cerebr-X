const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesToolOutputModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_tool_output.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('stringifyResponsesToolOutputValue 默认把对象转成 pretty JSON', async () => {
  const { stringifyResponsesToolOutputValue } = await loadResponsesToolOutputModule();
  const text = stringifyResponsesToolOutputValue({ ok: true, value: { a: 1 } });
  assert.match(text, /"ok": true/);
  assert.match(text, /"a": 1/);
});

test('stringifyResponsesToolOutputValue 能处理循环引用与 bigint', async () => {
  const { stringifyResponsesToolOutputValue } = await loadResponsesToolOutputModule();
  const value = { count: 123n };
  value.self = value;
  const text = stringifyResponsesToolOutputValue(value);
  assert.match(text, /123n/);
  assert.match(text, /\[Circular\]/);
});

test('truncateResponsesToolOutputText 使用 Codex 风格的中间截断标记', async () => {
  const { truncateResponsesToolOutputText } = await loadResponsesToolOutputModule();
  const source = `${'A'.repeat(6000)}${'B'.repeat(6000)}`;
  const truncated = truncateResponsesToolOutputText(source, 250);
  assert.notEqual(truncated, source);
  assert.match(truncated, /tokens truncated/);
  assert.match(truncated, /^A+/);
  assert.match(truncated, /B+$/);
});

test('buildResponsesToolOutputContentItems 会把长文本切成多个 input_text item', async () => {
  const { buildResponsesToolOutputContentItems } = await loadResponsesToolOutputModule();
  const items = buildResponsesToolOutputContentItems('x'.repeat(7000), { maxTokens: 5000, chunkChars: 2000 });
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    type: 'input_text',
    text: 'x'.repeat(2000)
  });
});

test('formatResponsesToolOutputForDisplay 能拼回 input_text 分块', async () => {
  const { formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const text = formatResponsesToolOutputForDisplay([
    { type: 'input_text', text: '{\n  "ok": true,' },
    { type: 'input_text', text: '\n  "value": 1\n}' }
  ]);
  assert.equal(text, '{\n  "ok": true,\n  "value": 1\n}');
});
