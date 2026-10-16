/**
 * `domain/pack-loader.ts` 的自测 —— **整合包卡片上"加载器"那一格**的判据。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户截图：「curseforge 的整合包，不显示整合包的模组
 *   加载器类型」）。
 *
 *   用户看到的是每张卡片上一个只有「—」的小方块 —— 那一格一直在渲染，
 *   只是 CF 那条路上值是空的。
 *
 *   两条判据必须活着（缺一条就会退回原来的样子）：
 *     ① **取不到就是 `null`**（不是 `'—'`）—— 由调用方决定"不渲染那一格"，
 *        免得让人以为"加载器是空的"，而事实是"我们没这个信息"；
 *     ② **两个源同一套取值**：小写规范串（`fabric`/`forge`/`neoforge`/`quilt`），
 *        与 Modrinth 的 `categories` 逐字节同形状 —— 不许为来源另造措辞。
 *
 * 用法：node --test tests/pack-loader.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { packLoaderOf, PACK_LOADER_IDS } = await import('../src/domain/pack-loader.ts');

/* ---------- ① 真机形状：Modrinth 的 `categories` 本来就是混装的 ---------- */

test('Modrinth 的命中里挑得出加载器（真机形状）', () => {
  // 实测（2026-10-17，modrinth/v2/search?query=sodium）：
  //   Sodium       → [fabric, neoforge, optimization, quilt]
  //   Better Adventures++ → [adventure, fabric, quilt]
  assert.equal(packLoaderOf(['fabric', 'neoforge', 'optimization', 'quilt']), 'fabric');
  assert.equal(packLoaderOf(['adventure', 'fabric', 'quilt']), 'fabric');
  assert.equal(packLoaderOf(['forge']), 'forge');
  assert.equal(packLoaderOf(['adventure', 'challenging', 'fabric', 'lightweight']), 'fabric');
});

test('CurseForge 的内容分类**不是**加载器（挑不出来）', () => {
  /*
   * 实测（2026-10-17，mod.mcimirror.top/curseforge/v1/mods/search?classId=4471）：
   *   ATM10         → [Exploration, Extra Large, Magic, Tech, Quests]（+ 后端补的 neoforge）
   *   DeceasedCraft → [Combat / PvP, Adventure and RPG, Exploration, Multiplayer,
   *                    Hardcore, Tech, Quests]（+ forge）
   * ★ 这里喂的是**只有内容分类**的那一份（= 改动前后端给 CF 填的东西）——
   *   它必须返回 null，否则说明判据把"分类"当成了"加载器"。
   */
  assert.equal(
    packLoaderOf(['Exploration', 'Extra Large', 'Magic', 'Tech', 'Quests']),
    null,
    '★ CF 的 categories 是内容分类，一个加载器都不在里面',
  );
  assert.equal(
    packLoaderOf([
      'Combat / PvP',
      'Adventure and RPG',
      'Exploration',
      'Multiplayer',
      'Hardcore',
      'Tech',
      'Quests',
    ]),
    null,
  );
  // 容易混进去的近义词也不许被当成加载器
  assert.equal(packLoaderOf(['Forge-like', 'Fabricated', 'Quilted', 'NeoForged']), null);
});

/* ---------- ② 取不到 ⇒ null（**不是** '—'） ---------- */

test('取不到加载器时返回 null，绝不返回破折号', () => {
  for (const input of [
    [],
    null,
    undefined,
    ['Quests', 'Tech'], // SkyFactory 4 那种老包（实测：gameVersions 里没加载器）
  ]) {
    const got = packLoaderOf(input);
    assert.equal(got, null, `这个输入必须得到 null：${JSON.stringify(input)}`);
    assert.notEqual(got, '—', '★ 不许再兜底成破折号 —— 那会让人以为"加载器是空"');
  }
});

/* ---------- ③ 两个源同一套取值（小写规范串） ---------- */

test('取值只会是那四个规范串（大小写归一，显示用的就是它）', () => {
  assert.deepEqual([...PACK_LOADER_IDS], ['fabric', 'forge', 'neoforge', 'quilt']);
  // CF 上游给的是 `NeoForge` / `Fabric` 这种首字母大写 —— 归一到规范串
  assert.equal(packLoaderOf(['1.21.1', 'NeoForge']), 'neoforge');
  assert.equal(packLoaderOf(['Fabric']), 'fabric');
  assert.equal(packLoaderOf(['QUILT']), 'quilt');
  assert.equal(packLoaderOf(['  Forge  ']), 'forge', '前后空白也要归一');
  // 输出永远在这四个里（调用方直接把它显示出来）
  for (const input of [['Fabric'], ['NeoForge'], ['forge'], ['Quilt']]) {
    const got = packLoaderOf(input);
    assert.ok(PACK_LOADER_IDS.includes(got), `${got} 不在规范串表里`);
    assert.equal(got, got.toLowerCase(), '规范串必须是小写');
  }
});

test('多个加载器时取**上游数组里最先出现的**那个（顺序由上游定，我们不改排序）', () => {
  /*
   * 实测（2026-10-17）：`Immersed With Shaders` 的
   * `gameVersions` 里同时有 Fabric + Forge + NeoForge。
   * 显示哪一个都不算错，但"同一个输入永远同一个输出"是必须的
   * （否则每次刷新卡片上的字会跳）。
   */
  assert.equal(packLoaderOf(['Fabric', 'Forge', 'NeoForge']), 'fabric');
  assert.equal(packLoaderOf(['Forge', 'Fabric']), 'forge');
  assert.equal(packLoaderOf(['fabric', 'forge']), 'fabric');
  // 幂等：同一个输入问两次必须一样
  const input = ['1.20.1', 'Forge', 'Fabric'];
  assert.equal(packLoaderOf(input), packLoaderOf(input));
  // 不影响输入（纯函数、不改调用方的数组）
  const arr = ['Fabric', 'Forge'];
  packLoaderOf(arr);
  assert.deepEqual(arr, ['Fabric', 'Forge']);
});

test('加载器排在内容分类**后面**时也照样挑得出来（后端就是这么并的）', () => {
  // 后端 `categories_with_loaders` 把加载器**追加在末尾**，
  // 好让资源浏览器那三格 `categories.slice(0, 3)` 仍然是内容分类。
  const cf = ['Exploration', 'Extra Large', 'Magic', 'Tech', 'Quests', 'neoforge'];
  assert.equal(packLoaderOf(cf), 'neoforge');
  assert.deepEqual(cf.slice(0, 3), ['Exploration', 'Extra Large', 'Magic']);
});
