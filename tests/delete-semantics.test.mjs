/**
 * 删除语义的回归测试（`src/domain/delete.ts`）
 * ------------------------------------------------------------------
 * 用法：`node --test tests/delete-semantics.test.mjs`
 *
 * ★ 为什么单独测这个：用户界面里曾经出现过**明确的谎话** ——
 *   三处删除确认框都写着"存档与配置会一起删除，此操作不可撤销"，
 *   而后端当时一个字节都没删。反过来也很容易犯错：文案说"不可撤销"，
 *   实际却进了回收站（让用户以为没救、不敢删）。
 *
 *   所以这里钉住的是**文案与行为同源**：凡是说"永久删除"的，
 *   `permanent` 必须是 true；凡是说"回收站"的，`permanent` 必须是 false。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  describeDelete,
  deleteIntent,
  trashUnavailablePrompt,
  PERMANENT_WARNING,
} = await import('../src/domain/delete.ts');

test('默认（没按 Shift）：进回收站，文案不许说"不可撤销"', () => {
  const copy = describeDelete({
    what: '这 3 个 Mod',
    items: ['Sodium', 'Lithium', 'Iris'],
    bytes: 3 * 1024 * 1024,
    intent: deleteIntent({ shiftKey: false }),
  });
  assert.equal(copy.permanent, false, '默认必须是回收站，不能直接永久删');
  assert.match(copy.message, /回收站/, '要明确告诉用户会进回收站');
  assert.doesNotMatch(
    copy.message,
    /不可撤销|无法恢复|找不到/,
    '★ 进回收站却写"不可撤销"就是撒谎 —— 用户会因此不敢删',
  );
  assert.equal(copy.doneVerb, '已移到回收站');
});

test('按住 Shift：永久删除，文案必须明确警告', () => {
  const copy = describeDelete({
    what: '「1.20.1 Forge」',
    intent: deleteIntent({ shiftKey: true }),
  });
  assert.equal(copy.permanent, true, 'Shift = 用户表达了"我知道我在干什么"');
  assert.match(copy.message, /Shift/, '要指出是 Shift 触发的，否则用户不知道刚才按了什么');
  assert.match(copy.message, /永久删除|找不回来/, '永久删必须写明后果');
  assert.equal(copy.doneVerb, '已永久删除');
});

test('清单与大小来自真实数据，没有就一律不写（不编数字）', () => {
  const a = describeDelete({
    what: '「测试实例」',
    items: ['实例目录 instances/foo/（存档在里面）'],
    note: '共享的游戏文件不会被删除。',
    intent: { shift: false },
  });
  assert.match(a.message, /instances\/foo\//, '真实路径要写进去');
  assert.match(a.message, /共享的游戏文件/, 'note 不能丢');

  const b = describeDelete({ what: '这个 Java', intent: { shift: false } });
  assert.doesNotMatch(b.message, /B\b/, '★ 没有大小数据时不许编一个出来');
  assert.match(b.message, /确定删除这个 Java？/);
});

test('大小只在有真实值时出现，并按可读单位格式化', () => {
  const withBytes = describeDelete({
    what: '这个 Java',
    bytes: 200 * 1024 * 1024,
    intent: { shift: false },
  });
  assert.match(withBytes.message, /200 MB/);

  const zero = describeDelete({ what: '这个 Java', bytes: 0, intent: { shift: false } });
  assert.doesNotMatch(zero.message, /磁盘上约/, '0 字节没有信息量，不要写');
});

test('清单条目不会出现重复的 · 前缀', () => {
  const copy = describeDelete({
    what: 'x',
    items: ['· 已经带点了', '没带点'],
    intent: { shift: false },
  });
  assert.match(copy.message, /· 已经带点了/);
  assert.match(copy.message, /· 没带点/);
  assert.doesNotMatch(copy.message, /· · /, '不要出现「· ·」这种双重前缀');
});

test('deleteIntent 能吃下 undefined（键盘触发 / 程序调用时没有事件）', () => {
  assert.equal(deleteIntent(undefined).shift, false);
  assert.equal(deleteIntent(null).shift, false);
  assert.equal(deleteIntent({}).shift, false);
  assert.equal(deleteIntent({ shiftKey: true }).shift, true);
});

test('回收站不可用时的提示会带上后端原话，并问要不要永久删', () => {
  const msg = trashUnavailablePrompt(new Error('这个位置可能没有回收站'));
  assert.match(msg, /这个位置可能没有回收站/, '★ 后端原话不能被吞掉 —— 用户要看到真实原因');
  assert.match(msg, /永久删除/);
  assert.match(trashUnavailablePrompt('纯字符串错误'), /纯字符串错误/);
});

test('PERMANENT_WARNING 说的是"跳过回收站"', () => {
  assert.match(PERMANENT_WARNING, /跳过回收站/);
  assert.match(PERMANENT_WARNING, /找不回来/);
});
