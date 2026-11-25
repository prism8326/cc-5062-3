import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../js/checks.js';

test('颜料内核全部数值/模型检查通过', () => {
  const { results, failed, allPass } = runChecks();
  for (const r of results) {
    // 让每个检查在 TAP 输出中可见
    if (!r.pass) console.error('FAIL', r.id, r.detail);
  }
  assert.equal(
    allPass,
    true,
    `失败检查：\n${failed.map((f) => ` - ${f.id}: ${f.detail}`).join('\n')}`
  );
});
