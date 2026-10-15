/**
 * MC 新闻页的判据（用户：「从我的网站里调取版本更新内容」→「网站更新了版本大图功能，
 * 启动器同步一下」→「其实这些东西应该保存在启动器的数据文件夹里的」）。
 *
 * ## 被测的是什么
 *
 *   启动器把用户网站烘好的三份东西（清单 / 中文正文 / 版本大图）同步到**数据目录**，
 *   解析与校验全在 `src/domain/mc-news.ts`。这个文件钉住的就是那一层：
 *   它吃掉的是站点 JSON 的**原文**（字符串），吐出来的是能直接渲染的行。
 *
 * ## 为什么它值得 15 条判据
 *
 *   这一页出错的样子是"**内容不对，但不报错**"：
 *     · 正文树读漏一层 ⇒ 用户看到的更新内容比 Wiki 少一截，界面一切正常；
 *     · 正文读成空文档 ⇒ 点开是一张什么都没有的卡，看起来像"这一版真没更新"；
 *     · 站点改了字段名 ⇒ 整页空白，而控制台一个字都不说；
 *     · 日期按时区算 ⇒ 同一份数据在两台机器上显示差一天。
 *   所以下面四类断言缺一不可：**真实形状的解析**、**逐句不丢**、**坏输入不许变半成品**、
 *   **纯函数的行为**。
 *
 * ★ 样本是 `tests/mc-news.fixtures.json` —— 从**线上真实数据**里切的一小段
 *   （清单是完整的，正文只留「方块」那一组 + 两条用来测 `sub` 写法的条目）。
 *   自己编一个"看起来像"的样本，正是字段改名能躲过去的原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEWS_CHUNK,
  bakedAgeDays,
  docRowCount,
  flattenText,
  formatNewsDate,
  formatSyncTime,
  moreRowsLabel,
  newsKindLabel,
  nextVisible,
  parseNewsDoc,
  parseNewsManifest,
  sectionRows,
  visibleSections,
} from '../src/domain/mc-news.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = JSON.parse(readFileSync(join(ROOT, 'tests', 'mc-news.fixtures.json'), 'utf8'));

/* 站点给的是**文本**（数据目录里的文件原文），判据也只吃文本 */
const MANIFEST_TEXT = JSON.stringify(FX.manifest);
const DOC_TEXT = JSON.stringify(FX.doc);

/* ---------- ① 清单 ---------- */

test('★★ 线上清单能解析出"最新正式版"（解析不出来这一页就是空的）', () => {
  const m = parseNewsManifest(MANIFEST_TEXT);
  assert.ok(m, '真实清单解析失败');
  assert.equal(m.release.version, '26.3');
  assert.equal(m.release.kind, 'release');
  assert.match(formatNewsDate(m.release.date), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(m.snapshot, '快照那一档没了');
  assert.equal(m.snapshot.version, '26.4-snapshot-4');
});

test('★ 清单里每一版都要有能显示的一句话（中文首段或英文摘要，不能两样都空）', () => {
  const m = parseNewsManifest(MANIFEST_TEXT);
  for (const e of [m.release, m.snapshot].filter(Boolean)) {
    assert.ok(
      flattenText(e.wiki.introLead) || flattenText(e.shortText),
      `${e.version} 既没有中文首段也没有英文摘要 —— 卡片上会是一句空话`,
    );
  }
});

test('★ "有没有中文全文"只看 wiki.has —— 清单可能留着文件名而条目还没建好', () => {
  const m = parseNewsManifest(MANIFEST_TEXT);
  assert.equal(m.release.hasDoc, true, '线上这份 26.3 有中文条目');

  /* 同一份形状，只把 has 改成 false：文件名还在，但不该再认它 */
  const fake = {
    latest: { version: '9.9', wiki: { has: false, file: 'wiki/9.9.json' }, image: { file: 'img/9.9.jpg' } },
  };
  assert.equal(parseNewsManifest(JSON.stringify(fake)).release.hasDoc, false);
  /* has 为真但没有文件名同样不算 */
  const noFile = { latest: { version: '9.9', wiki: { has: true, file: '  ' } } };
  assert.equal(parseNewsManifest(JSON.stringify(noFile)).release.hasDoc, false);
});

test('清单里读不出"最新正式版"就整份不认（宁走空状态，也不画一张没版本号的卡）', () => {
  assert.equal(parseNewsManifest(''), null);
  assert.equal(parseNewsManifest('不是 JSON'), null);
  assert.equal(parseNewsManifest('[]'), null);
  assert.equal(parseNewsManifest('{}'), null);
  assert.equal(parseNewsManifest(JSON.stringify({ snapshot: { version: '1.0' } })), null);
  assert.ok(parseNewsManifest(JSON.stringify({ latest: { version: '1.0' } })), '只要正式版在就算能用');
});

/* ---------- ② 正文：一个字都不许读漏 ---------- */

/** 独立地把站点那份树里"所有的字"收出来（不经过被测代码，才能当判据） */
function collectTexts(raw) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const t = flattenText(node.text);
    if (t) out.push(t);
    for (const c of Array.isArray(node.children) ? node.children : []) walk(c);
    /* `sub` 是上游"更细一层"的另一种写法：字符串数组，或者带 text 的对象数组 */
    for (const s of Array.isArray(node.sub) ? node.sub : []) {
      const st = flattenText(typeof s === 'string' ? s : s?.text);
      if (st) out.push(st);
    }
  };
  for (const sec of Array.isArray(raw?.sections) ? raw.sections : []) {
    for (const it of Array.isArray(sec.items) ? sec.items : []) walk(it);
  }
  return out;
}

test('★★ 真实正文里的每一句话都要出现在渲染出来的行里（少一句就是"更新内容被吃了"）', () => {
  const doc = parseNewsDoc(DOC_TEXT);
  assert.ok(doc, '真实形状的正文解析失败');
  const shown = new Set(doc.sections.flatMap((s) => sectionRows(s).map((r) => r.text)));
  const missing = collectTexts(FX.doc).filter((t) => !shown.has(t));
  assert.deepEqual(missing, [], `${missing.length} 句话没被渲染出来：${missing.slice(0, 3).join(' / ')}`);
});

test('★ 行数与树里实际的字数一致（分块显示靠这个数，算错"还有 N 行"就对不上）', () => {
  const doc = parseNewsDoc(DOC_TEXT);
  assert.equal(docRowCount(doc), collectTexts(FX.doc).length);
  assert.ok(docRowCount(doc) > 10, '样本本身应当有十几行，否则这条判据是空的');
});

test('★ 那棵**三层**的树：第 3 层也在（随手写两层渲染就会丢它）', () => {
  const doc = parseNewsDoc(DOC_TEXT);
  const rows = doc.sections.flatMap((s) => sectionRows(s));
  /* 真实数据里：方块 → 杨木原木 → "可以合成对应种类的 悬挂式告示牌 。" */
  const deep = rows.find((r) => r.text.includes('悬挂式告示牌'));
  assert.ok(deep, '第 3 层的那句话没读出来');
  assert.ok(deep.depth >= 2, `第 3 层的 depth 应该 ≥ 2，实际 ${deep.depth}`);
});

test('★ 上游的两种"下一层"写法都认：children 与 sub', () => {
  const doc = parseNewsDoc(DOC_TEXT);
  const rows = doc.sections.flatMap((s) => sectionRows(s)).map((r) => r.text);
  assert.ok(rows.includes('顺序按你摆的顺序来。'), 'sub 里那行没读出来');
  assert.ok(rows.includes('一条没有子节点的条目。'), '没有子节点的条目丢了');
});

test('★★ 空的 / 形状不对的正文一律返回 null（不是"空文档"——那会显示成一张空卡）', () => {
  assert.equal(parseNewsDoc(''), null);
  assert.equal(parseNewsDoc('不是 JSON'), null);
  assert.equal(parseNewsDoc('{}'), null);
  assert.equal(parseNewsDoc(JSON.stringify({ version: '1.0', sections: [] })), null);
  assert.equal(parseNewsDoc(JSON.stringify({ version: '1.0', sections: [{ title: '新内容', items: [] }] })), null);
  assert.equal(
    parseNewsDoc(JSON.stringify({ version: '1.0', sections: [{ title: '新内容', items: [{ text: '   ' }] }] })),
    null,
    '只有空白的条目不算内容',
  );
});

/* ---------- ③ 日期与"多久没同步" ---------- */

test('★ 版本日期按 UTC 取（同一个 ISO 在两台机器上必须显示同一天）', () => {
  assert.equal(formatNewsDate('2026-09-15T11:23:02.000Z'), '2026-09-15');
  /* 23:30Z 在 UTC+8 已经是"第二天"了 —— 这里仍然按 UTC 显示，理由见函数注释 */
  assert.equal(formatNewsDate('2026-09-15T23:30:00.000Z'), '2026-09-15');
  assert.equal(formatNewsDate('2026-10-13'), '2026-10-13');
  assert.equal(formatNewsDate(''), '');
  assert.equal(formatNewsDate('不是日期'), '不是日期', '不许显示 Invalid Date');
});

test('★ "上次同步"是给人看的本地时间；没有记录时给空串（不编一个时间出来）', () => {
  const t = formatSyncTime(Date.UTC(2026, 9, 15, 11, 52));
  assert.match(t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `形状不对：${t}`);
  assert.equal(formatSyncTime(0), '');
  assert.equal(formatSyncTime(undefined), '');
  assert.equal(formatSyncTime(Number.NaN), '');
});

test('★ "网站那份几天前烘的"：超过阈值才提示，日期读不出来时**不提示**（不猜）', () => {
  assert.equal(bakedAgeDays('2026-10-15', new Date('2026-10-15T20:00:00Z')), 0);
  assert.equal(bakedAgeDays('2026-10-15', new Date('2026-10-22T00:00:00Z')), 7);
  assert.equal(bakedAgeDays('', new Date()), null);
  assert.equal(bakedAgeDays('昨天', new Date()), null);
  assert.equal(bakedAgeDays('2026-11-01', new Date('2026-10-15T00:00:00Z')), 0, '未来日期算 0 天，不是负数');
});

/* ---------- ④ 拍平与分块 ---------- */

const DOC = {
  version: '9.9',
  sections: [
    {
      title: '新内容',
      items: [
        { text: '方块', group: true, children: [{ text: '杨树树叶', children: [{ text: '闪着光。' }] }] },
        { text: '物品', group: true, children: [{ text: '新食物' }] },
      ],
    },
    { title: '更改', items: [{ text: '改了唱片机' }] },
  ],
};

test('拍平：分组行与条目行分开，层级逐层 +1', () => {
  const doc = parseNewsDoc(JSON.stringify(DOC));
  assert.deepEqual(
    sectionRows(doc.sections[0]).map((r) => [r.kind, r.text, r.depth]),
    [
      ['group', '方块', 0],
      ['entry', '杨树树叶', 1],
      ['entry', '闪着光。', 2],
      ['group', '物品', 0],
      ['entry', '新食物', 1],
    ],
  );
});

test('★ 分块显示：第 N 批只多露 NEWS_CHUNK 行，最后一批停在总数上', () => {
  assert.equal(nextVisible(0, 1000), NEWS_CHUNK);
  assert.equal(nextVisible(NEWS_CHUNK, 1000), NEWS_CHUNK * 2);
  assert.equal(nextVisible(900, 1000), 1000, '不许越过总数');
  assert.equal(nextVisible(0, 3), 3);
  assert.equal(moreRowsLabel(0), '', '没有剩余时按钮不该有字');
  assert.equal(moreRowsLabel(7), '继续显示（还有 7 行）');
});

test('★ 只露前几行时，**节标题跟着它自己那几行**（不是把后一节的内容提前露出来）', () => {
  const doc = parseNewsDoc(JSON.stringify(DOC));
  assert.deepEqual(visibleSections(doc, 0), []);
  const one = visibleSections(doc, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].title, '新内容');
  assert.deepEqual(one[0].rows.map((r) => r.text), ['方块']);

  const all = visibleSections(doc, 99);
  assert.deepEqual(all.map((g) => g.title), ['新内容', '更改']);
  assert.equal(all.reduce((n, g) => n + g.rows.length, 0), docRowCount(doc));
});

test('卡片右上角那个标签是人话', () => {
  assert.equal(newsKindLabel('release'), '最新正式版');
  assert.equal(newsKindLabel('snapshot'), '最新快照');
});

test('★ 真机上那份清单的复本：解析出来的版本号与图片一起进了卡片（不依赖网络）', () => {
  const m = parseNewsManifest(MANIFEST_TEXT);
  /* 断言"清单里确实带着图"——版本大图功能是这一版被点名要的东西；
     形状变了（比如站点把 image 挪走）这条会红，而不是页面上悄悄没图 */
  for (const key of ['latest', 'snapshot']) {
    assert.ok(FX.manifest[key]?.image?.file, `${key} 那一档在清单里没有 image.file`);
  }
  assert.equal(m.release.version, FX.manifest.latest.version);
});
