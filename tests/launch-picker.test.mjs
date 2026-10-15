/**
 * 版本选择器「平铺几张 / 要不要全部版本入口」的判据。
 * 实现：`src/domain/launch-picker.ts`（A+ 形态，用户 2026-10-16 选定）。
 *
 * ★ 为什么值得单独钉：本机只有 4 个版本，**永远走不到折叠那一支** ——
 *   没有这些用例，那条分支就只能靠"把阈值临时改小再点一下"来验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKER_MAX, pickerPlan } from '../src/domain/launch-picker.ts';

test('不超过上限：全部平铺，不出现入口', () => {
  for (const n of [0, 1, 2, 5, 6]) {
    const p = pickerPlan(n);
    assert.equal(p.shown, n, `${n} 个应当全部平铺`);
    assert.equal(p.hasMore, false, `${n} 个不该出现「全部版本」入口`);
  }
});

test('超过上限：平铺 max-1 张 + 入口卡（入口自己占一格）', () => {
  for (const n of [7, 8, 20, 200]) {
    const p = pickerPlan(n);
    assert.equal(p.shown, PICKER_MAX - 1, `${n} 个时平铺 ${PICKER_MAX - 1} 张`);
    assert.equal(p.hasMore, true, `${n} 个时必须有入口`);
    // ★ 卡片总数（含入口）不许超过上限 —— 折叠的全部意义就在这里
    assert.ok(p.shown + 1 <= PICKER_MAX, `卡片总数 ${p.shown + 1} 不该超过 ${PICKER_MAX}`);
  }
});

test('边界：刚好 6 个不折叠、7 个折叠', () => {
  assert.deepEqual(pickerPlan(6), { shown: 6, hasMore: false });
  assert.deepEqual(pickerPlan(7), { shown: 5, hasMore: true });
});

test('上限可覆盖（临时改阈值做真机验证时用得到）', () => {
  assert.deepEqual(pickerPlan(4, 2), { shown: 1, hasMore: true });
  assert.deepEqual(pickerPlan(2, 2), { shown: 2, hasMore: false });
});

test('脏输入按 0 处理，不许抛也不许画出负数张卡', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = pickerPlan(bad);
    assert.equal(p.shown, 0, `${String(bad)} 应当按 0 处理`);
    assert.equal(p.hasMore, false);
  }
  // 小数（理论上不该出现，但 floor 之后必须是整数）
  assert.deepEqual(pickerPlan(7.9), { shown: 5, hasMore: true });
});
