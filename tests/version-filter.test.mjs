/**
 * `version-filter.ts` 的自测 —— **"整合包不筛、其余筛"这条判据必须活着**。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-08（用户：「**少世代分组的大版本**」）。
 *
 *   真机现象：整合包 `Fabulously Optimized` 的标题写着「全部版本（37 个）」，
 *   而下面**只有一个 `1.20` 分组** —— 因为请求里带了当前实例的 MC 版本
 *   （`1.20.1`），后端一筛，整个跨世代的版本谱系就只剩一组。
 *
 *   ★ 这条判据原来**藏在接口请求参数的一个 spread 里**
 *     （`...(target ? { mcVersion: target.mcVersion, loader } : {})`），
 *     从代码上完全看不出"整合包为什么不该筛"。提取成函数 + 这个测试，
 *     下一个人想"顺手统一成一种规则"时才会撞到墙上。
 *
 * 用法：node --test tests/version-filter.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { filterVersionsForInstance } = await import('../src/components/version-filter.ts');

/** 一个整合包在真机上的形状：同一个包，跨好几个世代各有一串 */
const PACK = [
  { id: 'a', game_versions: ['1.21.1'] },
  { id: 'b', game_versions: ['1.20.1'] },
  { id: 'c', game_versions: ['1.19.2'] },
  { id: 'd', game_versions: ['1.16.5'] },
];

const TARGET = { mcVersion: '1.20.1' };

test('★★ 整合包：**一个都不筛** —— 否则跨世代的版本谱系会只剩一组', () => {
  const got = filterVersionsForInstance(PACK, { projectType: 'modpack', target: TARGET });
  assert.equal(got.length, PACK.length, '整合包必须保留全部版本（分组才有意义）');
  assert.equal(got[0].id, 'a', '顺序也要原样保留（排序是渲染层的事）');
});

test('★ 整合包：没有目标实例时同样原样返回（这一条本来就不会错，但别退化了）', () => {
  const got = filterVersionsForInstance(PACK, { projectType: 'modpack', target: null });
  assert.equal(got.length, PACK.length);
});

test('Mod / 其余种类：**按当前实例筛**（不兼容的列出来只会让人点错）', () => {
  const got = filterVersionsForInstance(PACK, { projectType: 'mod', target: TARGET });
  assert.deepEqual(
    got.map((v) => v.id),
    ['b'],
    '只留 game_versions 含 1.20.1 的那一条',
  );
});

test('没有目标实例 ⇒ 不筛（"有哪些版本"本身就是要给用户看的信息）', () => {
  const got = filterVersionsForInstance(PACK, { projectType: 'mod', target: null });
  assert.equal(got.length, PACK.length);
});

test('★ 筛完一个不剩 ⇒ **退回全量**，不是显示"无"', () => {
  /*
   * 真机会遇到：实例是 `1.20.1`，而这个项目只标了 `1.20`
   * （前缀不同、实际能跑）。显示"无"会让用户以为"这个装不了"。
   */
  const only120 = [{ id: 'x', game_versions: ['1.20'] }];
  const got = filterVersionsForInstance(only120, { projectType: 'mod', target: TARGET });
  assert.equal(got.length, 1, '读不到 ≠ 没有：宁可多列，也不要凭空说没有');
});

test('缺 game_versions 的条目：不崩，且算作"筛掉"', () => {
  const mixed = [{ id: 'no-gv' }, { id: 'ok', game_versions: ['1.20.1'] }];
  const got = filterVersionsForInstance(mixed, { projectType: 'mod', target: TARGET });
  assert.deepEqual(got.map((v) => v.id), ['ok']);
});

test('projectType 认不出（null）⇒ 按"其余种类"处理（保守：筛）', () => {
  const got = filterVersionsForInstance(PACK, { projectType: null, target: TARGET });
  assert.deepEqual(got.map((v) => v.id), ['b']);
});
