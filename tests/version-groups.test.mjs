/**
 * 「版本清单按世代分组」的判据（2026-09-26）。
 *
 * ★★ 用户截图：那一列里「快照」出现了**两次**，`26.1` / `26.2` 也各出现了两次
 *   ——「这个快照的显示非常混乱」。
 *
 *   根因：分组是**按顺序切开**的（只把相邻的同键行并起来），而上游清单里
 *   同一世代的版本**并不相邻**：
 *     · `26.2` 后面跟着 `26.2-rc-2`（落在"快照"键上），再往后又是别的 `26.2`；
 *     · 周快照 `25w14a` 与预发布 `1.21.2-pre1` 共用 `snap` 键，中间隔着正式版。
 *   ⇒ 同一个键被切成好几段，看着就像"同一档出现了好几次"。
 *
 * ## 判据怎么写的
 *
 *   `versionFamily` / `groupByFamily` **搬到了 `src/components/version-family.ts`**：
 *   `.tsx` 里的东西跑不进 `node --test`（Node 只剥离 `.ts`），
 *   搬出来之后这里能**真的调它们**，而不是只会读源码。
 *   （搬家之前只能"查算法形状"—— 那种判据挡不住"算法写对了但键算错了"。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupByFamily, versionFamily } from '../src/components/version-family.ts';

test('★ 世代键：正式版 / 预发布 / 周快照 / 愚人节各归各档', () => {
  assert.equal(versionFamily('26.4').key, '26.4');
  assert.equal(versionFamily('26.1').key, '26.1');
  /*
   * ★★★★ 2026-09-26 口径**统一成一条**：带 `主.次` 的版本，
   *   它自己的 `-rc` / `-pre` / `-snapshot` 预发布**归它那条线**。
   *   老口径把 `1.21.2-pre1` 丢进「快照」而 `26.2-rc-2` 留在 `26.2` ——
   *   同一代的东西被拆到两处，正是用户说的"乱"。
   */
  assert.equal(versionFamily('26.2-rc-2').key, '26.2');
  assert.equal(versionFamily('26.2-pre-6').key, '26.2');
  assert.equal(versionFamily('1.21.2-pre1').key, '1.21', '预发布跟它自己的线走，不进「快照」');
  assert.equal(versionFamily('1.21-rc1').key, '1.21');
  // 周快照（`25w14a`）不属于任何正式版线 ⇒ 单独一档
  assert.equal(versionFamily('25w14a').key, 'snap');
  assert.equal(versionFamily('24w03a').key, 'snap');
  // 愚人节排在版本线 / 快照之前判（`15w14a` 长得就像普通快照）
  assert.equal(versionFamily('15w14a').key, 'april');
  assert.equal(versionFamily('1.RV-Pre1').key, 'april');
});

test('★★ 上游清单里"同一世代不相邻"是常态（这条是那个 bug 的现场还原）', () => {
  /*
   * 这不是编的序列：它按"新→旧"混着正式版、预发布、周快照，
   * 复现的正是用户截图里"快照 / 26.1 / 26.2 各出现两次"的形状
   * （周快照 `25w14a` 与 `24w03a` **中间隔着别的东西**，所以只并相邻会切出两组）。
   */
  const upstream = [
    '26.4',
    '26.4-rc-1',
    '26.3',
    '26.3-pre-2',
    '25w14a',
    '1.21.2',
    '24w03a',
    '1.21.1',
  ].map((id) => ({ id }));

  // ① 先证明"只并相邻"确实会切出重复的键（老实现就是这个结果）
  const adjacentOnly = [];
  for (const r of upstream) {
    const fam = versionFamily(r.id);
    const last = adjacentOnly[adjacentOnly.length - 1];
    if (last && last.key === fam.key) last.items.push(r.id);
    else adjacentOnly.push({ key: fam.key, items: [r.id] });
  }
  const keysAdjacent = adjacentOnly.map((g) => g.key);
  assert.ok(
    new Set(keysAdjacent).size < keysAdjacent.length,
    `这组数据本来就该暴露"重复分组"：${keysAdjacent.join(' / ')}`,
  );

  // ② 按 key 合并之后：**每个世代只有一组**，而且条数对得上
  const merged = new Map();
  for (const r of upstream) {
    const fam = versionFamily(r.id);
    const hit = merged.get(fam.key);
    if (hit) hit.items.push(r.id);
    else merged.set(fam.key, { key: fam.key, items: [r.id] });
  }
  const keys = [...merged.keys()];
  assert.equal(new Set(keys).size, keys.length, `不许有重复的组键：${keys.join(' / ')}`);
  const total = [...merged.values()].reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, upstream.length, '合并之后一条都不能丢');
  // 两个周快照被隔开，合并后**同一组**（这是"快照出现两次"的直接修法）
  assert.deepEqual(merged.get('snap')?.items, ['25w14a', '24w03a'], '两个周快照要并成一组');
  // 预发布跟着自己的线走（不再掉进「快照」）
  assert.deepEqual(merged.get('26.4')?.items, ['26.4', '26.4-rc-1']);
});

test('★★ 分组实现必须是"按 key 合并"，不许退回"只并相邻"', () => {
  /*
   * ★ 这一条现在**直接调真函数**（见文件头：`.tsx` 跑不进测试，所以搬了家）。
   *   断言的是**结果**：
   *     · 每个世代只出一组（不许重复）；
   *     · 一条都不丢；
   *     · 组内顺序 = 上游顺序（只合并、不重排）。
   */
  const upstream = [
    '26.4',
    '26.3',
    '26.2',
    '26.2-rc-2',
    '26.2-pre-6',
    '26.1',
    '26.1-rc-1',
    '25w14a',
    '1.21.2-pre1',
    '1.21.1',
  ].map((id) => ({ id }));

  const groups = groupByFamily(upstream, (r) => r.id);
  const keys = groups.map((g) => g.fam.key);
  assert.equal(new Set(keys).size, keys.length, `每个世代只该出一组：${keys.join(' / ')}`);
  assert.equal(
    groups.reduce((n, g) => n + g.rows.length, 0),
    upstream.length,
    '合并之后一条都不能丢',
  );
  // 快照那一组：只有**周快照**（预发布跟自己的线走，不在这里 —— 见上面那条判据）
  const snap = groups.find((g) => g.fam.key === 'snap');
  assert.deepEqual(snap?.rows.map((r) => r.id), ['25w14a'], '「快照」只收周快照');
  // 预发布与它那条线并在一起，且**按上游顺序**
  const line = groups.find((g) => g.fam.key === '26.2');
  assert.deepEqual(
    line?.rows.map((r) => r.id),
    ['26.2', '26.2-rc-2', '26.2-pre-6'],
    '同一世代的行要**按上游顺序**并到一起',
  );
  // 组出现的位置 = **首次出现**的位置（26.4 那组在最前，不因为合并而跑到后面）
  assert.equal(groups[0]?.fam.key, '26.4', `第一组该是 26.4：${keys.join(' / ')}`);
});

test('★ 纯逻辑不许再搬回 `.tsx`（那会让上面的判据跑不起来）', () => {
  /*
   * ★ 这条是**防复发**：`VersionIcon.tsx` 里一旦又出现 `groupByFamily` 的定义，
   *   tests 就再也 import 不到它 —— 那时候判据只能退回"查源码形状"，弱得多。
   */
  const icon = readFileSync(new URL('../src/components/VersionIcon.tsx', import.meta.url), 'utf8');
  assert.ok(
    !/export function groupByFamily/.test(icon),
    'groupByFamily 又搬回 VersionIcon.tsx 了 —— 纯逻辑请留在 version-family.ts（否则它跑不进测试）',
  );
  assert.ok(
    !/export function versionFamily/.test(icon),
    'versionFamily 又搬回 VersionIcon.tsx 了 —— 同上',
  );
  // 而 re-export 必须留着（老 import 路径 `./VersionIcon` 还在用）
  assert.match(icon, /export \{ groupByFamily, versionFamily/, 're-export 别删：老路径还在用');
});
