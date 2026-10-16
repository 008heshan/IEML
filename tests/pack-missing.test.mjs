/**
 * 整合包"缺了哪几个 mod"的判据。
 * 实现：`src/domain/pack-missing.ts`（与 Rust `domain/pack_plan.rs` 镜像）。
 *
 * ★★ 为什么值得单独钉（2026-10-16 真机事故）：整合包 `Better MC [FABRIC] - BMC2`
 *   装完之后游戏里弹出包自带的「Missing Mods」窗口（Balm / FallingTree /
 *   FTB Teams / Fabrication / Paintings ++），而启动器报的是「安装完成」。
 *   根因是 CurseForge 的**解析地址**那一段把失败的条目不声不响地丢了。
 *
 *   这条链上最危险的错是**沉默**：少的东西没人报、报的数不对、或者给出一个
 *   点了必然失败的「重试」按钮。这三种都不报错、只是让人上当 —— 所以钉在这里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  missingLabel,
  missingSummary,
  planMissing,
  repairEntry,
  splitByRetryable,
} from '../src/domain/pack-missing.ts';

/** 一条正常条目（有地址、有 CurseForge 身份） */
const ok = (path, project_id = 1, file_id = 2) => ({
  path,
  url: 'https://example.invalid/x.jar',
  reason: '',
  project_id,
  file_id,
});

/** 一条"地址没解析出来"的条目（事故里那 5 个的形状） */
const unresolved = (path, reason = '上游接口超时', project_id = 531761, file_id = 4741360) => ({
  path,
  url: '',
  reason,
  project_id,
  file_id,
});

test('只有没地址的条目算缺 —— 有地址的一个都不许进缺失清单', () => {
  const missing = planMissing([ok('mods/ok.jar'), unresolved('mods/balm-fabric-7.2.1.jar')]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, 'balm-fabric-7.2.1.jar');
  assert.equal(missing[0].path, 'mods/balm-fabric-7.2.1.jar');
});

test('缺的那条要带得出**原因**，不是只有一个计数', () => {
  const [m] = planMissing([unresolved('mods/x.jar', '文件 4741360 的信息查不到：连接超时')]);
  assert.ok(m.reason.includes('连接超时'), `原因要带上游原话：${m.reason}`);
  assert.ok(m.reason.includes('没解析出下载地址'), `要说清是哪一类问题：${m.reason}`);
});

test('没有原因时给一句通用解释，不许留空', () => {
  const [m] = planMissing([{ path: 'mods/x.jar', url: '' }]);
  assert.ok(m.reason.length > 0);
  assert.ok(m.reason.includes('下载地址'));
});

test('有 CurseForge 身份 ⇒ 能重试；没有 ⇒ 不能（不给点了必然失败的按钮）', () => {
  const [cf] = planMissing([unresolved('mods/a.jar')]);
  assert.equal(cf.retryable, true, '有 project_id + file_id ⇒ 以后能重新解析地址');
  const [local] = planMissing([{ path: 'mods/b.jar', url: '' }]);
  assert.equal(local.retryable, false, '拖进来的 .mrpack 没身份 ⇒ 重试也没用');
  // 只有一半身份（脏数据）也不算能重试
  const [half] = planMissing([{ path: 'mods/c.jar', url: '', project_id: 7, file_id: 0 }]);
  assert.equal(half.retryable, false);
});

test('全都有地址 ⇒ 缺失为空、界面那句是空串（不显示一句空话）', () => {
  const missing = planMissing([ok('mods/a.jar'), ok('mods/b.jar', 3, 4)]);
  assert.deepEqual(missing, []);
  assert.equal(missingSummary(missing), '');
  assert.deepEqual(repairEntry(missing), { show: false, label: '', detail: '' });
});

test('界面那句最多点名 3 个 + 「等 N 个」，N 是**总数**不是"另外几个"', () => {
  /*
   * ★ 这一句的输入是 `planMissing` 的**产物**（不是原始清单条目）：
   *   界面上拿到的就是后端算好的这张表。用错形状测出来的"通过"是假的。
   */
  const many = planMissing([1, 2, 3, 4, 5].map((i) => unresolved(`mods/m${i}.jar`, 'r', 1, i)));
  const s = missingSummary(many);
  assert.ok(s.includes('5 个文件没下下来'), s);
  assert.ok(s.includes('等 5 个'), `超过 3 个要如实说总数：${s}`);
  assert.ok(s.includes('m1.jar') && s.includes('m3.jar'), `点名要取文件名而不是全路径：${s}`);
  assert.ok(!s.includes('m4.jar'), `只点名前 3 个：${s}`);
  // 正好 3 个时不出现"等"
  const three = planMissing([1, 2, 3].map((i) => unresolved(`mods/m${i}.jar`, 'r', 1, i)));
  assert.ok(!missingSummary(three).includes('等 '), missingSummary(three));
});

test('能重试的和只能人工下的**必须分开说**', () => {
  // ★ 用 planMissing 真算一遍（不手搓 MissingFile）：这样测的是**同一口径**
  const list = planMissing([
    unresolved('mods/a.jar'), // 有身份 ⇒ 能重试
    { path: 'mods/b.jar', url: '', project_id: 0, file_id: 0 }, // 没身份 ⇒ 只能人工
    unresolved('mods/c.jar'), // 有身份 ⇒ 能重试
  ]);
  assert.deepEqual(splitByRetryable(list), { retryable: 2, manual: 1 });
  const e = repairEntry(list);
  assert.equal(e.show, true, '有能重试的 ⇒ 给入口');
  assert.ok(e.detail.includes('2 个可以再试'), e.detail);
  assert.ok(e.detail.includes('另有 1 个要你自己去整合包网站下'), e.detail);
});

test('★ 全都只能人工下 ⇒ **不给**「重新下载」入口，只解释为什么', () => {
  const list = [
    { path: 'mods/a.jar', name: 'a.jar', reason: '作者不允许第三方下载', retryable: false },
    { path: 'mods/b.jar', name: 'b.jar', reason: '作者不允许第三方下载', retryable: false },
  ];
  const e = repairEntry(list);
  assert.equal(e.show, false, '点了必然失败的按钮比不摆更糟');
  assert.ok(e.detail.includes('2 个'), e.detail);
  assert.ok(e.detail.includes('mods'), `要告诉他文件放哪：${e.detail}`);
});

test('显示名取最后一段（Windows 反斜杠也认），空路径不抛', () => {
  assert.equal(missingLabel('mods/a.jar'), 'a.jar');
  assert.equal(missingLabel('mods\\a.jar'), 'a.jar');
  assert.equal(missingLabel(''), '');
  assert.equal(missingLabel(undefined), '');
});

test('脏输入（undefined / 空数组）按"没有缺失"处理，不抛也不编', () => {
  assert.deepEqual(planMissing(undefined), []);
  assert.deepEqual(planMissing([]), []);
  assert.equal(missingSummary(undefined), '');
  assert.deepEqual(splitByRetryable(undefined), { retryable: 0, manual: 0 });
  assert.equal(repairEntry(undefined).show, false);
});
