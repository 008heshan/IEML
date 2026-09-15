/**
 * 多开实例：运行状态模型的回归测试（`src/state/store.ts`）
 * ------------------------------------------------------------------
 * 用法：`node --test tests/multi-instance.test.mjs`
 *
 * ★ 为什么单独钉这一组：
 *   在这之前，**"同一时刻只能有一个游戏在跑"这件事被写死在状态模型里** ——
 *   `running` 是一个槽（`{instanceId, …} | null`），后端也是一张单槽的表。
 *   于是"多开"不是界面改改就行：判据、状态、按钮三处都只装得下一个。
 *
 *   这次改动最容易犯的错不是"多开不了"，而是**多开之后停错游戏** ——
 *   停止命令以前不带参数（只有一个能停），改成表之后如果哪一处漏了实例 id，
 *   表现就是"点了停止，停掉的是另一个版本"。这种错在单开时永远看不出来。
 *
 *   所以这里钉住两件事：
 *     ① 两个实例**可以同时**在表里；
 *     ② 任何一次停止**只影响被点名的那一个**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { reducer, initialState, isInstanceRunning, runningInfo, runningCount, runningInstances } =
  await import('../src/state/store.ts');

/** 造一个最小可用的实例记录（测试只关心 id / 名字 / 运行态） */
const inst = (id, name) => ({
  id,
  mcVersion: '1.20.4',
  loader: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastPlayedAt: null,
  totalPlaySeconds: 0,
  diskBytes: 0,
  config: { name, slug: id, memoryMb: 4096 },
});

/** 从初始状态出发，按顺序跑一串 action */
function run(actions, base = {}) {
  const start = { ...initialState, ready: true, ...base };
  return actions.reduce((s, a) => reducer(s, a), start);
}

test('两个实例可以同时在跑（这就是"多开"本身）', () => {
  const s = run([
    { type: 'game/start', instanceId: 'a', pid: 111 },
    { type: 'game/start', instanceId: 'b', pid: 222 },
  ]);
  assert.equal(runningCount(s), 2, '两个实例都应该在运行表里');
  assert.equal(isInstanceRunning(s, 'a'), true);
  assert.equal(isInstanceRunning(s, 'b'), true);
});

test('停一个不影响另一个（多开之后最危险的错：停错游戏）', () => {
  const s = run([
    { type: 'game/start', instanceId: 'a', pid: 111 },
    { type: 'game/start', instanceId: 'b', pid: 222 },
    { type: 'game/stop', instanceId: 'a' },
  ]);
  assert.equal(isInstanceRunning(s, 'a'), false, 'a 应该被停掉');
  assert.equal(isInstanceRunning(s, 'b'), true, 'b 必须还在跑 —— 停 a 不能连坐 b');
  assert.equal(runningCount(s), 1);
});

test('同一个实例重复登记只算一个（后一次覆盖前一次）', () => {
  const s = run([
    { type: 'game/start', instanceId: 'a', pid: 111 },
    { type: 'game/start', instanceId: 'a', pid: 999 },
  ]);
  assert.equal(runningCount(s), 1);
  assert.equal(runningInfo(s, 'a')?.pid, 999);
});

test('game/sync 以后端的事实为准：本地多出来的会被清掉', () => {
  const s = run([
    { type: 'game/start', instanceId: 'a', pid: 111 },
    { type: 'game/start', instanceId: 'ghost', pid: 222 }, // 本地以为在跑，后端说没有
    {
      type: 'game/sync',
      list: [{ instance_id: 'a', pid: 111, started_at: 1_700_000_000 }],
    },
  ]);
  assert.equal(isInstanceRunning(s, 'a'), true);
  assert.equal(isInstanceRunning(s, 'ghost'), false, '后端没报的就不该留在表里');
  // ★ startedAt 用后端给的秒 → 毫秒（界面算"已运行多久"要靠它对齐）
  assert.equal(runningInfo(s, 'a')?.startedAt, 1_700_000_000 * 1000);
});

test('界面重新加载后：后端报回来的能在实例表里找到（否则界面上没有它的名字）', () => {
  const s = run(
    [
      {
        type: 'game/sync',
        list: [
          { instance_id: 'b', pid: 2, started_at: 1_700_000_100 },
          { instance_id: 'a', pid: 1, started_at: 1_700_000_000 },
        ],
      },
    ],
    { instances: [inst('a', 'A 版'), inst('b', 'B 版')] },
  );
  const list = runningInstances(s);
  assert.equal(list.length, 2);
  // 按启动时间排序（早的在前）—— 底栏的显示顺序要稳定
  assert.deepEqual(
    list.map((x) => x.inst.config.name),
    ['A 版', 'B 版'],
  );
});

test('实例被删掉之后，运行表里的残留不会让 runningInstances 崩（按 id 找不到就跳过）', () => {
  const s = run([{ type: 'game/start', instanceId: 'gone', pid: 1 }], { instances: [] });
  assert.equal(runningCount(s), 1, '表里确实还留着');
  assert.deepEqual(runningInstances(s), [], '但列不出实例 —— 这不许抛异常');
});

test('game/stop-all 一次清空（启动器退出收尾用）', () => {
  const s = run([
    { type: 'game/start', instanceId: 'a', pid: 1 },
    { type: 'game/start', instanceId: 'b', pid: 2 },
    { type: 'game/stop-all' },
  ]);
  assert.equal(runningCount(s), 0);
});

test('未知实例 = 没在跑（null / undefined 都不许当真）', () => {
  const s = run([{ type: 'game/start', instanceId: 'a', pid: 1 }]);
  assert.equal(isInstanceRunning(s, null), false);
  assert.equal(isInstanceRunning(s, undefined), false);
  assert.equal(isInstanceRunning(s, 'nope'), false);
  assert.equal(runningInfo(s, null), null);
});
