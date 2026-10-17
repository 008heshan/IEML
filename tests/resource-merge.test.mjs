/**
 * `domain/resource-merge.ts` 的自测 —— **「全部」来源**下两个源怎么合并。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部，并且默认为全部，
 *   这样即使有资源里不允许第三方下载，也可以得到互补了」。
 *
 * ## 这套判据为什么必须能真跑（而不是写在组件里）
 *
 *   合并/去重/优先级这三件事，一旦写错，症状是**界面看起来完全正常**：
 *   少了一条（硬合并掉了）、装错了源（优先级反了）、把"下不了"说成"能下"
 *   （判据写成了 `=== true`）—— 三者都不会报错，只有玩家装不上才会发现。
 *   而本机**没有 DOM 测试环境**（`node --test` 只吃纯逻辑），
 *   所以判据提成纯函数放在这里，由这个文件钉住。
 *
 * ## 四条口径（用户已定，别再改）
 *
 *   ① **不按名字硬合并**：同名但作者不同 = 两个不同的项目，两条都要在；
 *   ② **名字与作者都相同**才合成一条，并在详情页标「两个来源都有」；
 *   ③ 合成那一条**优先用能下载的那一份**（CurseForge 的作者可以禁止第三方下载）；
 *   ④ 两源都不能下载时**如实说**，不许假装有。
 *
 * 用法：node --test tests/resource-merge.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  mergeHits,
  mergeIdentity,
  sortHits,
  isDirectlyDownloadable,
  describeSource,
  SOURCE_LABEL,
} = await import('../src/domain/resource-merge.ts');

/* ---------- 真机形状的夹具（字段照 2026-10-17 的搜索响应抄） ---------- */

/** Modrinth 的一条命中（`distribution_allowed` 永远是 null = 没有这个概念） */
function mr(over = {}) {
  return {
    project_id: 'AANobbMI',
    slug: 'sodium',
    title: 'Sodium',
    description: '现代渲染优化',
    categories: ['fabric', 'optimization'],
    project_type: 'mod',
    downloads: 5_600_000,
    icon_url: 'https://cdn.modrinth.com/data/AANobbMI/icon.webp',
    versions: ['1.21.1'],
    author: 'jellysquid3',
    distribution_allowed: null,
    page_url: 'https://modrinth.com/mod/sodium',
    ...over,
  };
}

/** CurseForge 的一条命中（`distribution_allowed` 是真值；`false` = 作者禁止分发） */
function cf(over = {}) {
  return {
    project_id: '394468',
    slug: 'sodium',
    title: 'Sodium',
    description: '现代渲染优化',
    categories: ['fabric', 'optimization'],
    project_type: 'mod',
    downloads: 730_000,
    icon_url: 'https://media.forgecdn.net/avatars/394468.png',
    versions: ['1.21.1'],
    author: 'jellysquid3',
    distribution_allowed: true,
    page_url: 'https://www.curseforge.com/minecraft/mc-mods/sodium',
    ...over,
  };
}

const ids = (list) => list.map((h) => h.project_id);

/* ============================================================
   ① 不按名字硬合并
   ============================================================ */

test('同名但作者不同 ⇒ 两条（名字不是身份）', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'mr-sodium', author: 'jellysquid3' })],
    curseforge: [cf({ project_id: 'cf-sodium-fork', author: 'someone-else' })],
  });
  assert.equal(merged.length, 2, '★ 不许按名字硬合并 —— 同名不同作者是两个项目');
  assert.deepEqual(ids(merged), ['mr-sodium', 'cf-sodium-fork']);
});

test('作者相同但名字不同 ⇒ 两条', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'mr-a', title: 'Sodium' })],
    curseforge: [cf({ project_id: 'cf-b', title: 'Sodium Extra' })],
  });
  assert.equal(merged.length, 2);
});

test('slug 相同但作者不同 ⇒ 仍然是两条（slug 也不是身份）', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'mr-1', author: 'a' })],
    curseforge: [cf({ project_id: 'cf-1', author: 'b' })],
  });
  assert.equal(merged.length, 2, '★ 判据是"名字 + 作者"，不是 slug，也不是 project_id');
});

test('标题为空时不参与合并（否则所有无名条目会糊成一条）', () => {
  assert.equal(mergeIdentity(mr({ title: '' })), null);
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'm1', title: '' }), mr({ project_id: 'm2', title: '' })],
    curseforge: [cf({ project_id: 'c1', title: '' })],
  });
  assert.equal(merged.length, 3, '没有名字的条目各自保留，不许互相合并');
});

test('身份归一：前后空白 / 连续空白 / 大小写不算差异', () => {
  const a = mergeIdentity(mr({ title: 'Sodium', author: 'jellysquid3' }));
  const b = mergeIdentity(cf({ title: '  Sodium  ', author: 'JellySquid3' }));
  assert.equal(a, b, '同一份东西在两个平台上大小写/空白不一致是常态');
});

/* ============================================================
   ② 名字与作者都相同 ⇒ 合成一条，来源保留成"两个都有"
   ============================================================ */

test('名字 + 作者都相同 ⇒ 合成一条，并记下"两个来源都有"', () => {
  const merged = mergeHits({ modrinth: [mr()], curseforge: [cf()] });
  assert.equal(merged.length, 1, '两个源同一份资源只该出现一次');
  const [only] = merged;
  assert.deepEqual(only.provenance.sources, ['modrinth', 'curseforge']);
  assert.ok(only.provenance.preferred, '必须说得出来安装时该走哪一条');
  assert.ok(
    only.provenance.sources.includes(only.provenance.preferred),
    'preferred 必须是 sources 里的一个（不许指向一个没说过的源）',
  );
});

test('单源命中也要带来源字段（详情页与安装都靠它）', () => {
  const [onlyMr] = mergeHits({ modrinth: [mr()] });
  assert.deepEqual(onlyMr.provenance.sources, ['modrinth']);
  assert.equal(onlyMr.provenance.preferred, 'modrinth');
  assert.equal(onlyMr.provenance.downloadable, true);

  const [onlyCf] = mergeHits({ curseforge: [cf()] });
  assert.deepEqual(onlyCf.provenance.sources, ['curseforge']);
  assert.equal(onlyCf.provenance.preferred, 'curseforge');
});

test('来源字段不会被合并丢掉（availability 逐源记着能不能下）', () => {
  const merged = mergeHits({ modrinth: [mr()], curseforge: [cf({ distribution_allowed: false })] });
  assert.equal(merged.length, 1);
  const prov = merged[0].provenance;
  assert.equal(prov.availability.length, 2);
  assert.deepEqual(
    prov.availability.map((a) => a.source),
    ['modrinth', 'curseforge'],
  );
  assert.deepEqual(
    prov.availability.map((a) => a.downloadable),
    [true, false],
  );
});

test('★★ 每一份的**身份**也要记着（取版本回退时要用另一个源自己的 id）', () => {
  /*
   * 2026-10-17（取版本互补）：`preferred` 那一份没有能装到当前实例的版本时，
   * 界面要回退去问另一个源 —— 而两个平台的 id 体系完全不同，
   * 拿 Modrinth 的 base62 id 去问 CurseForge 只会得到"上游没有"。
   * ⇒ 合并时就得把**每一份自己的** project_id 记下来（整条替换之后再拿不到）。
   */
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'AANobbMI' })],
    curseforge: [cf({ project_id: '394468' })],
  });
  assert.equal(merged.length, 1, '先把"这是同一条"确认了，下面的断言才有意义');
  const prov = merged[0].provenance;
  assert.equal(
    prov.availability.find((a) => a.source === 'modrinth')?.project_id,
    'AANobbMI',
  );
  assert.equal(
    prov.availability.find((a) => a.source === 'curseforge')?.project_id,
    '394468',
    '★ 合并后那一条身上只剩 preferred 的 id —— 另一份的必须在 availability 里',
  );
});

test('单源命中也记着身份（老路径 / 只有一个来源时同样要能回退判据用）', () => {
  const [onlyCf] = mergeHits({ curseforge: [cf({ project_id: '394468' })] });
  assert.equal(onlyCf.provenance.availability[0].project_id, '394468');
});

/* ============================================================
   ③ 优先用**能下载**的那一份
   ============================================================ */

test('CurseForge 作者禁止第三方下载 ⇒ 用 Modrinth 那一份（重点）', () => {
  /*
   * 用户原话：「这样即使有资源里不允许第三方下载，也可以得到互补了」。
   * 实测形状：CF 的项目 `allowModDistribution = false` ⇒ 文件 `downloadUrl` 是 null
   * （见 `net/curseforge.rs` 文件头，热门 50 个里就有 1 个）。
   */
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'MR' })],
    curseforge: [cf({ project_id: 'CF', distribution_allowed: false })],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].project_id, 'MR', '★ 合并后要保留**能下载**的那一份的数据');
  assert.equal(merged[0].provenance.preferred, 'modrinth');
  assert.equal(merged[0].provenance.downloadable, true);
});

test('反过来也成立：Modrinth 那份不能下、CurseForge 能下 ⇒ 用 CurseForge', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'MR', distribution_allowed: false })],
    curseforge: [cf({ project_id: 'CF' })],
  });
  assert.equal(merged[0].project_id, 'CF');
  assert.equal(merged[0].provenance.preferred, 'curseforge');
  assert.equal(merged[0].provenance.downloadable, true);
});

test('两份都能下时顺序固定（同一个输入永远同一个输出，界面不会跳）', () => {
  const run = () =>
    mergeHits({
      modrinth: [mr({ project_id: 'MR' })],
      curseforge: [cf({ project_id: 'CF' })],
    })[0];
  const a = run();
  const b = run();
  assert.equal(a.project_id, b.project_id);
  assert.equal(a.provenance.preferred, b.provenance.preferred);
});

/* ============================================================
   ④ 两源都不能下载 ⇒ 如实说（不许假装有）
   ============================================================ */

test('两个来源都不能直接下载时如实标出来', () => {
  const merged = mergeHits({
    modrinth: [mr({ distribution_allowed: false })],
    curseforge: [cf({ distribution_allowed: false })],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].provenance.downloadable, false, '★ 不许假装能下');
  const said = describeSource(merged[0].provenance);
  assert.match(said.text, /两个来源都有/);
  assert.ok(said.warning, '不能下的时候必须给出一句话，不能沉默');
  assert.match(said.warning, /两个来源都不能直接下载/);
});

test('单个来源不能下时，措辞说的是"这个来源"，不是"两个来源"', () => {
  const [only] = mergeHits({ curseforge: [cf({ distribution_allowed: false })] });
  assert.equal(only.provenance.downloadable, false);
  const said = describeSource(only.provenance);
  assert.match(said.text, /CurseForge/);
  assert.ok(said.warning);
  assert.match(said.warning, /不能直接下载/);
  assert.doesNotMatch(said.warning, /两个来源/);
});

test('两个来源都有、但有一份下不了 ⇒ 说明用的是哪一份（不许含糊）', () => {
  const merged = mergeHits({
    modrinth: [mr()],
    curseforge: [cf({ distribution_allowed: false })],
  });
  const said = describeSource(merged[0].provenance);
  assert.match(said.text, /两个来源都有/);
  assert.ok(said.warning, '有一份下不了这件事必须说出来，否则用户不知道为什么会换源');
  assert.match(said.warning, /CurseForge/);
  assert.match(said.warning, /Modrinth/);
});

test('两源都能下时不多说一个字（没有警告）', () => {
  const merged = mergeHits({ modrinth: [mr()], curseforge: [cf()] });
  const said = describeSource(merged[0].provenance);
  assert.equal(said.warning, null);
  assert.match(said.text, /两个来源都有/);
});

test('没有 provenance 的老路径（单源搜索）仍然说得出一个来源', () => {
  const said = describeSource(null, 'curseforge');
  assert.match(said.text, /CurseForge/);
  assert.equal(said.warning, null);
});

/* ============================================================
   ⑤ 分页合并：两源同时前进，交错排列，再按当前排序重排
   ============================================================ */

test('交错合并：第 N 页 = 各源第 N 页交替排（不是一段 Modrinth 接一段 CF）', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'm0', title: 'A', author: 'a' }), mr({ project_id: 'm1', title: 'B', author: 'b' })],
    curseforge: [cf({ project_id: 'c0', title: 'C', author: 'c' }), cf({ project_id: 'c1', title: 'D', author: 'd' })],
  });
  assert.deepEqual(ids(merged), ['m0', 'c0', 'm1', 'c1']);
});

test('某一源这一页没有了 ⇒ 另一源的照样都在（互补，不许整页消失）', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'm0', title: 'A', author: 'a' }), mr({ project_id: 'm1', title: 'B', author: 'b' })],
    curseforge: [],
  });
  assert.deepEqual(ids(merged), ['m0', 'm1']);
});

test('两个源都空 / 缺一侧都不抛异常', () => {
  assert.deepEqual(mergeHits({}), []);
  assert.deepEqual(mergeHits({ modrinth: null, curseforge: undefined }), []);
});

/* ============================================================
   ⑥ 排序（沿用现有的 热门 / 最新 / 最多下载）
   ============================================================ */

test('热门 = 合并后的原顺序（稳定，不重排）', () => {
  const merged = mergeHits({
    modrinth: [mr({ project_id: 'm0', title: 'A', author: 'a', downloads: 1 })],
    curseforge: [cf({ project_id: 'c0', title: 'C', author: 'c', downloads: 9 })],
  });
  const sorted = sortHits(merged, 'hot', (h) => h);
  assert.deepEqual(ids(sorted), ['m0', 'c0']);
});

test('最多下载 = 降序，且同值保持原来的相对顺序（稳定排序）', () => {
  const list = [
    { id: 'a', downloads: 5 },
    { id: 'b', downloads: 9 },
    { id: 'c', downloads: 5 },
    { id: 'd', downloads: 7 },
  ].map((x) => mr({ project_id: x.id, title: x.id, author: 'same', downloads: x.downloads }));
  const sorted = sortHits(list, 'downloads', (h) => h);
  assert.deepEqual(ids(sorted), ['b', 'd', 'a', 'c'], '同值 5 的两条顺序必须保持 a 在 c 前');
  // 纯函数：不改输入
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd']);
});

test('最新 = 上游给的次序反过来（上游没有发布时间字段，这是现状口径）', () => {
  const list = ['a', 'b', 'c'].map((id) => mr({ project_id: id, title: id, author: 'same' }));
  const sorted = sortHits(list, 'new', (h) => h);
  assert.deepEqual(ids(sorted), ['c', 'b', 'a']);
  assert.deepEqual(ids(list), ['a', 'b', 'c'], '不改输入');
});

test('排序后来源字段一个都不掉', () => {
  const merged = mergeHits({ modrinth: [mr()], curseforge: [cf()] });
  for (const sort of ['hot', 'new', 'downloads']) {
    const sorted = sortHits(merged, sort, (h) => h);
    assert.equal(sorted.length, 1);
    assert.deepEqual(sorted[0].provenance.sources, ['modrinth', 'curseforge']);
  }
});

/* ============================================================
   ⑦ 最小的几处常识
   ============================================================ */

test('能不能下载的判据只看数据，不按"哪个源"分两套', () => {
  assert.equal(isDirectlyDownloadable('curseforge', cf({ distribution_allowed: false })), false);
  assert.equal(isDirectlyDownloadable('curseforge', cf({ distribution_allowed: true })), true);
  assert.equal(isDirectlyDownloadable('curseforge', cf({ distribution_allowed: null })), true);
  assert.equal(isDirectlyDownloadable('modrinth', mr()), true, 'null = 没有这个概念 = 能下');
  assert.equal(isDirectlyDownloadable('modrinth', mr({ distribution_allowed: false })), false);
});

test('两个源的显示名只有一份（详情页与切换器共用）', () => {
  assert.deepEqual(SOURCE_LABEL, { modrinth: 'Modrinth', curseforge: 'CurseForge' });
});

/* ============================================================
   ⑧ 「全部」这一页怎么读（错误 / 总数 / 别名提示来自哪一份）
   ============================================================ */

const { pagesFromBoth } = await import('../src/domain/resource-merge.ts');

/** 后端 `resource_search_both` 的回包（字段名照 `bridge/tauri.ts::BothSearch`） */
function both(over = {}) {
  return {
    modrinth: { hits: [mr()], total_hits: 100, offset: 0, limit: 20, source: 'modrinth' },
    curseforge: { hits: [cf()], total_hits: 250, offset: 0, limit: 20, source: 'curseforge' },
    modrinth_error: null,
    curseforge_error: null,
    ...over,
  };
}

test('两边都成 ⇒ 没有错误，总数取**较大的那个**（不是相加）', () => {
  const got = pagesFromBoth(both());
  assert.equal(got.sideError, null);
  assert.equal(got.totalHits, 250, '相加（350）是编的 —— 同一条资源可能两边都在');
  assert.equal(got.pages.modrinth.length, 1);
  assert.equal(got.pages.curseforge.length, 1);
});

test('一边没查成 ⇒ 说清是哪一边、为什么（不许当成"那个源没有"）', () => {
  const got = pagesFromBoth(both({ curseforge: null, curseforge_error: '镜像不通' }));
  assert.ok(got.sideError, '必须有一句原因 —— 沉默就等于说"CF 上没有"');
  assert.match(got.sideError, /CurseForge/);
  assert.match(got.sideError, /镜像不通/);
  assert.deepEqual(got.pages.curseforge, [], '没查成的那一侧是空数组，不是 undefined');
  assert.equal(got.totalHits, 100, '只有一边在时，基数就是那一边的总数');
});

test('Modrinth 没查成时，别名提示退到 CurseForge 那一份（不是没有提示）', () => {
  const cfAlias = {
    ...both({
      modrinth: null,
      modrinth_error: '官方超时',
    }).curseforge,
    query_alias: '「钠」是中文叫法，按 sodium 搜的',
    term_used: 'sodium',
  };
  const got = pagesFromBoth(both({ modrinth: null, modrinth_error: '官方超时', curseforge: cfAlias }));
  assert.equal(got.lead?.term_used, 'sodium');
  assert.match(String(got.lead?.query_alias), /sodium/);
  assert.match(String(got.sideError), /Modrinth/);
});

test('两源都是空页 ⇒ 不抛异常，也不编一个总数', () => {
  const got = pagesFromBoth({
    modrinth: null,
    curseforge: null,
    modrinth_error: null,
    curseforge_error: null,
  });
  assert.deepEqual(got.pages, { modrinth: [], curseforge: [] });
  assert.equal(got.totalHits, 0);
  assert.equal(got.lead, null);
});
