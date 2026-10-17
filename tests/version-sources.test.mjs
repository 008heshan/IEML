/**
 * 取版本要真的"互补"：一个源没有能装到当前实例的版本时，**回退去问另一个源**。
 * 实现：`src/domain/version-sources.ts`。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部……这样即使有资源里不
 *   允许第三方下载，也可以得到互补了」。
 *
 *   「全部」把两个源的结果合成了一张表，合并时**优先用能下载的那一份**
 *   （`resource-merge.ts::absorb`）。但取版本那一步原来只问 `preferred` 一份：
 *   那一份**没有能装到当前实例的版本**（或干脆问不到）时，界面就显示「无」——
 *   而另一个来源明明有。**这正是「全部」想解决的问题**。
 *
 * ## 三条不能含糊的地方（也是这个文件钉住的东西）
 *
 *   ① **回退要真的换一个身份去问**：两个平台的 id 体系完全不同（Modrinth 是
 *      base62，CurseForge 是数字）—— 拿 preferred 那份的 id 去问另一个源，
 *      只会把"我们拿错了标识"说成"上游没有"（这条错在 C-1 修过一次）。
 *      ⇒ 每个源必须用**它自己那一份**的 `project_id`。
 *   ② **回退要看得见**：用哪一份的版本必须在详情页说清（用户定的口径：
 *      来源信息放详情页，卡片上不放徽章）。
 *   ③ **两源的版本不许混进一张表**：回退是"换一批"，不是"两个列表拼起来"。
 *      都不可用时才叫真的没有 —— 但只要有一份**非空**，就宁可多列几条
 *      （`version-filter.ts` 那条"筛完不剩就退回全量"是同一条规矩）。
 *
 * ## 为什么能真跑
 *
 *   本机没有 DOM 测试环境，但取版本这件事的**判断**（问哪几个源、按什么顺序、
 *   哪一批算数、详情页怎么说）全在纯函数里；网络那一层由调用方注入
 *   （测试里换成假的 fetch），所以这套判据可以 `node --test` 真跑。
 *
 * 用法：node --test tests/version-sources.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { mergeHits, SOURCE_LABEL } = await import('../src/domain/resource-merge.ts');
const {
  versionSourcesToTry,
  lookupVersionsFrom,
  versionSourceNote,
} = await import('../src/domain/version-sources.ts');

/* ---------- 夹具：真机形状的命中（字段照搜索响应抄） ---------- */

function mr(over = {}) {
  return {
    project_id: 'AANobbMI',
    slug: 'sodium',
    title: 'Sodium',
    description: '现代渲染优化',
    categories: ['fabric'],
    project_type: 'mod',
    downloads: 5_600_000,
    icon_url: null,
    versions: ['1.21.1'],
    author: 'jellysquid3',
    distribution_allowed: null,
    page_url: 'https://modrinth.com/mod/sodium',
    ...over,
  };
}

function cf(over = {}) {
  return {
    project_id: '394468',
    slug: 'sodium',
    title: 'Sodium',
    description: '现代渲染优化',
    categories: ['fabric'],
    project_type: 'mod',
    downloads: 730_000,
    icon_url: null,
    versions: ['1.21.1'],
    author: 'jellysquid3',
    distribution_allowed: true,
    page_url: 'https://www.curseforge.com/minecraft/mc-mods/sodium',
    ...over,
  };
}

/** 一条版本（只要 `game_versions` 就能被"兼容"判据看懂） */
const ver = (id, game = '1.20.1') => ({ id, version_number: id, game_versions: [game] });

/** 两个源都收录的同一条（合并后一条、`preferred` 是 Modrinth） */
const bothSources = () => mergeHits({ modrinth: [mr()], curseforge: [cf()] })[0];

/** 只看 Modrinth 的那条（单源） */
const oneSource = () => mergeHits({ modrinth: [mr()] })[0];

/** 假的 fetch：按源给一批版本；`null` = 这个源报错 */
function fakeFetch(table) {
  const calls = [];
  const fetch_ = async (t) => {
    calls.push(t);
    const v = table[t.source];
    if (v === null) throw new Error('镜像不通');
    return v ?? [];
  };
  return { fetch: fetch_, calls };
}

/* ============================================================
   ① 该问哪几个源、按什么顺序、用什么身份
   ============================================================ */

test('★ 两个源都有 ⇒ preferred 先问，另一个在后，且**各用自己那一份的 project_id**', () => {
  const targets = versionSourcesToTry(bothSources().provenance, {
    source: 'modrinth',
    projectId: '调用方给的那一个',
  });
  assert.equal(targets.length, 2, '两个来源都收录了它 ⇒ 两份都值得问');
  assert.equal(targets[0].source, 'modrinth', 'preferred 必须排第一（先问能下载的那一份）');
  assert.equal(targets[1].source, 'curseforge');
  assert.equal(targets[0].projectId, 'AANobbMI', 'Modrinth 的身份是它自己那一份');
  assert.equal(
    targets[1].projectId,
    '394468',
    '★ 换源要换身份 —— 拿 Modrinth 的 id 去问 CF 只会得到"上游没有"',
  );
});

test('★ 单源命中 ⇒ 只问那一个源（绝拿它的 id 去问另一个源）', () => {
  const targets = versionSourcesToTry(oneSource().provenance, {
    source: 'modrinth',
    projectId: 'AANobbMI',
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].source, 'modrinth');
});

test('老路径（没有 provenance）⇒ 用调用方给的那一个源与 id', () => {
  const targets = versionSourcesToTry(null, { source: 'curseforge', projectId: '394468' });
  assert.deepEqual(targets, [{ source: 'curseforge', projectId: '394468' }]);
});

test('来源表里缺 project_id 的那个源**跳过**（不许拿别的 id 去问）', () => {
  const hit = bothSources();
  // 模拟"合并层只记了能不能下载、没记身份"的旧数据
  const prov = {
    ...hit.provenance,
    availability: hit.provenance.availability.map((a) => ({ ...a, project_id: undefined })),
  };
  const targets = versionSourcesToTry(prov, { source: 'modrinth', projectId: 'AANobbMI' });
  assert.equal(targets.length, 1, 'identity 缺失的源问不了 —— 跳过它，而不是编一个 id');
  assert.equal(targets[0].projectId, 'AANobbMI');
});

test('纯函数：不改调用方给的 provenance（目标表是新的）', () => {
  const hit = bothSources();
  const before = JSON.stringify(hit.provenance);
  const targets = versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'x' });
  targets[0].projectId = '被改坏了';
  assert.equal(JSON.stringify(hit.provenance), before);
});

/* ============================================================
   ② 回退的判据（这是这次要修的那一格）
   ============================================================ */

test('preferred 有可用版本 ⇒ 只用它，且**不白问第二个源**', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [ver('m1')], curseforge: [ver('c1')] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
  });
  assert.equal(got.source, 'modrinth');
  assert.equal(got.fellBack, false);
  assert.deepEqual(got.versions.map((v) => v.id), ['m1']);
  assert.equal(f.calls.length, 1, '拿到了就不该再问一遍 —— 那是一次白花的往返');
});

test('★★ preferred 一份都拿不到 ⇒ 回退问另一个源（用另一个源的身份）', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [], curseforge: [ver('c1'), ver('c2')] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
  });
  assert.equal(got.source, 'curseforge', 'Modrinth 那份没有 ⇒ 去问 CurseForge 那一份');
  assert.equal(got.fellBack, true, '★ 回退这件事要能被看出来（详情页要据此说清来源）');
  assert.deepEqual(got.versions.map((v) => v.id), ['c1', 'c2']);
  assert.deepEqual(
    f.calls.map((c) => c.projectId),
    ['AANobbMI', '394468'],
    '★ 第二次必须带**另一个源自己的 id**',
  );
  assert.deepEqual(got.tried.map((a) => a.source), ['modrinth', 'curseforge']);
  assert.ok(got.tried[0].count === 0 && got.tried[1].count === 2);
});

test('★★ preferred 有版本、但**没有能装到当前实例的** ⇒ 也回退（用户报的那个形状）', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [ver('m1', '1.21.1')], curseforge: [ver('c1', '1.20.1')] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
    // 判据由调用方给（`hasCompatibleVersion`，见 `components/version-filter.ts`）
    usable: (list) => list.some((v) => v.game_versions.includes('1.20.1')),
  });
  assert.equal(got.source, 'curseforge', '★ 那一份点不动当前实例 ⇒ 换另一份，而不是显示"无"');
  assert.equal(got.fellBack, true);
  assert.deepEqual(got.versions.map((v) => v.id), ['c1']);
  assert.equal(got.tried[0].usable, false);
  assert.equal(got.tried[1].usable, true);
});

test('preferred 问不到（报错）⇒ 回退，并把原因留下来', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: null, curseforge: [ver('c1')] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
  });
  assert.equal(got.source, 'curseforge');
  assert.equal(got.fellBack, true);
  assert.match(String(got.tried[0].error), /镜像不通/, '报错的原因要留着（详情页/日志要用）');
});

test('两个源都没有 ⇒ 这才叫"真的没有"（source 是 null）', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [], curseforge: [] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
  });
  assert.deepEqual(got.versions, []);
  assert.equal(got.source, null);
  assert.equal(got.fellBack, false);
  assert.equal(got.tried.length, 2, '问过哪两个也要记得住（说"都没有"时才站得住）');
});

test('★ 都不可用但有非空列表 ⇒ 宁可多列几条，**不许凭空说「无」**', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [ver('m1', '1.21.1')], curseforge: [] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
    usable: () => false, // 两份都不"可用"
  });
  assert.deepEqual(got.versions.map((v) => v.id), ['m1'], '有东西就得列出来（筛不筛是渲染层的事）');
  assert.equal(got.source, 'modrinth');
  assert.equal(got.fellBack, false, '还是 preferred 那一份，不算回退');
});

test('preferred 空、另一个也"不可用"但非空 ⇒ 展示它的，并标成回退', async () => {
  const hit = bothSources();
  const f = fakeFetch({ modrinth: [], curseforge: [ver('c1', '1.21.1')] });
  const got = await lookupVersionsFrom({
    targets: versionSourcesToTry(hit.provenance, { source: 'modrinth', projectId: 'AANobbMI' }),
    fetch: f.fetch,
    usable: () => false,
  });
  assert.deepEqual(got.versions.map((v) => v.id), ['c1']);
  assert.equal(got.source, 'curseforge');
  assert.equal(got.fellBack, true);
});

test('没有可问的目标（一个身份都没有）⇒ 空结果，不抛', async () => {
  const got = await lookupVersionsFrom({ targets: [], fetch: async () => [ver('x')] });
  assert.deepEqual(got.versions, []);
  assert.equal(got.source, null);
  assert.deepEqual(got.tried, []);
});

/* ============================================================
   ③ 详情页那一句：这一批版本来自哪一份、为什么换源
   ============================================================ */

test('★ 回退时要说清"版本来自哪一份 + 为什么"（不许让用户以为列表还是原来那份）', () => {
  const hit = bothSources();
  const note = versionSourceNote(hit.provenance, {
    source: 'curseforge',
    fellBack: true,
    tried: [
      { source: 'modrinth', count: 3, error: null, usable: false },
      { source: 'curseforge', count: 2, error: null, usable: true },
    ],
  });
  assert.ok(note, '回退必须说出来');
  assert.match(note, new RegExp(SOURCE_LABEL.curseforge));
  assert.match(note, new RegExp(SOURCE_LABEL.modrinth));
  assert.match(note, /没有能装到当前实例的版本/, `要说清为什么换源：${note}`);
});

test('回退是因为 preferred 问不到 ⇒ 把原因带出来', () => {
  const hit = bothSources();
  const note = versionSourceNote(hit.provenance, {
    source: 'curseforge',
    fellBack: true,
    tried: [
      { source: 'modrinth', count: 0, error: '镜像不通', usable: false },
      { source: 'curseforge', count: 2, error: null, usable: true },
    ],
  });
  assert.match(String(note), /镜像不通/, String(note));
});

test('没回退、但两个来源都收录了 ⇒ 也要说清这一批来自哪一个', () => {
  const hit = bothSources();
  const note = versionSourceNote(hit.provenance, {
    source: 'modrinth',
    fellBack: false,
    tried: [{ source: 'modrinth', count: 3, error: null, usable: true }],
  });
  assert.ok(note, '两个来源都有时，列表只来自其中一份 —— 不说清就是含糊');
  assert.match(String(note), new RegExp(SOURCE_LABEL.modrinth));
});

test('单源、没回退 ⇒ 不多说一个字（上面那行"来自 X"已经说过了）', () => {
  const hit = oneSource();
  const note = versionSourceNote(hit.provenance, {
    source: 'modrinth',
    fellBack: false,
    tried: [{ source: 'modrinth', count: 3, error: null, usable: true }],
  });
  assert.equal(note, null);
});

test('两个源都没给出来 ⇒ 说得出"都没有"，并把原因带上', () => {
  const hit = bothSources();
  const note = versionSourceNote(hit.provenance, {
    source: null,
    fellBack: false,
    tried: [
      { source: 'modrinth', count: 0, error: null, usable: false },
      { source: 'curseforge', count: 0, error: '连接超时', usable: false },
    ],
  });
  assert.match(String(note), /没有/, String(note));
  assert.match(String(note), /连接超时/, String(note));
});

test('来源措辞只有一份：详情页那句话里的源名就是 SOURCE_LABEL 里的那个', () => {
  const hit = bothSources();
  const note = String(
    versionSourceNote(hit.provenance, {
      source: 'curseforge',
      fellBack: true,
      tried: [{ source: 'modrinth', count: 0, error: null, usable: false }],
    }),
  );
  assert.ok(note.includes(SOURCE_LABEL.curseforge));
  assert.ok(!/CF|curseforge(?!)/.test(note.replace(SOURCE_LABEL.curseforge, '')), note);
});
