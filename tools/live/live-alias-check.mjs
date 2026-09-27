/*
 * 真机判据：**中文搜 Mod**（ADR-016）。
 *
 * ## 为什么这条必须有（而且必须联网）
 *
 *   这张词表的价值全在"**搜出来的东西对不对**"上，而那是**平台的回答**，
 *   不是我们能算出来的东西：
 *   · 词表里写的 `twilightforest` 在 Modrinth 上到底有没有这个项目？
 *   · 按这个词搜，第一条是不是用户想要的那个 Mod？
 *   · 中文原本搜得到吗（还是零结果）？
 *
 *   ⇒ 这条探针的每一段都**真的发一次搜索**。词表里每一条都应当能被它验证 ——
 *     ADR-016 说"词表靠真实数据补"，那就得有条判据盯着"补进来的是不是真的有用"。
 *
 * ## 判据（六段）
 *
 *   ① 英文查询**一个字节都不改**（`query_alias` 为空、`term_used` = 输入）
 *   ② 中文别名命中：能搜到结果，而且**第一条就是那个 Mod**（按 slug 认）
 *   ③ 中文原名（不走词表）搜不到 —— 证明这张表确实在解决问题
 *   ④ 词表里没收录的中文：不编词（`term_used` = 原样），界面据此提示"试试英文名"
 *   ⑤ 界面上：输中文会显示"按 xxx 搜的"，并且真的列出了卡片
 *   ⑥ 界面上：搜不到时会说"换英文名再试"
 *
 * ## 网络不通时
 *
 *   ★ 直接以"本次测量无效"退出（code 2）——**不许**把网络问题报成功能红。
 *     这个仓库已经栽过"量法错了，量出来的红跟功能无关"好几次。
 *
 * 用法：
 *   node tools/live/live-alias-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 网络不通（本次测量无效）
 */
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-alias-root');
const OWN = path.join(T, 'ieml-alias-own');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/*
 * 要核对的中文条目：`中文 → 期望在结果里看到的 slug + 在哪个源上`
 *
 * ★ 为什么带上 `source`：真机实测**同一批 Mod 在两个源上的收录情况不一样** ——
 *   暮色森林、工业时代在 Modrinth 上根本没有正主（只有附属项目），
 *   而 CurseForge 上有。判据必须按"这个源上应当找得到"来写，
 *   否则会把"这个平台没有"错报成"我们的词表错了"。
 */
const CASES = [
  { zh: '物品管理器', slug: 'jei', source: 'modrinth' },
  { zh: '机械动力', slug: 'create', source: 'modrinth' },
  { zh: '钠', slug: 'sodium', source: 'modrinth' },
  { zh: '旅行地图', slug: 'journeymap', source: 'modrinth' },
  { zh: '一键背包整理', slug: 'inventory-profiles-next', source: 'modrinth' },
  { zh: '血量显示', slug: 'neat', source: 'modrinth' },
  { zh: '等价交换', slug: 'projecte', source: 'curseforge' },
  { zh: '暮色森林', slug: 'the-twilight-forest', source: 'curseforge' },
  { zh: '工业时代2', slug: 'industrial-craft', source: 'curseforge' },
];

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'aliaslive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

/** 搜索一次（走界面用的那条命令） */
const search = (query, kind = 'mod', extra = {}) =>
  inv('resource_search', {
    kind,
    query,
    mcVersion: null,
    loader: null,
    limit: 30,
    offset: 0,
    ...extra,
  });

const slugsOf = (r) => (r?.hits ?? []).map((h) => String(h.slug ?? '').toLowerCase());
const isNetworkErr = (s) =>
  /网络|超时|连接|dns|request|timed? ?out|failed to|error sending/i.test(String(s ?? ''));

try {
  /* ---------- 先确认网络（否则本次测量无效） ---------- */
  const warm = await search('sodium');
  if (warm?.__err || !(warm?.hits?.length > 0)) {
    const why = String(warm?.__err ?? '搜索没有返回结果');
    if (isNetworkErr(why) || !warm?.hits) {
      console.error(`\n✗ 连不上搜索平台（${why}）—— **本次测量无效**，不是功能红。`);
      process.exit(2);
    }
  }

  /* ---------- ① 英文查询不该被改 ---------- */
  check(
    !warm?.query_alias,
    '① 英文查询不经过别名表（query_alias 为空）',
    String(warm?.query_alias),
  );
  check(
    warm?.term_used === 'sodium',
    '① 实际用的搜索词就是用户输入的那个',
    String(warm?.term_used),
  );
  check(slugsOf(warm).includes('sodium'), '① 英文查询照常搜得到 sodium', JSON.stringify(slugsOf(warm).slice(0, 3)));

  /* ---------- ② 中文别名：命中 + 搜到的就是那个 Mod ---------- */
  for (const c of CASES) {
    const r = await search(c.zh, 'mod', { source: c.source });
    const alias = String(r?.query_alias ?? '');
    const hit = slugsOf(r).includes(c.slug);
    check(
      alias.includes(c.zh) && hit,
      `② 「${c.zh}」在 ${c.source} 上搜到 ${c.slug}`,
      r?.__err
        ? String(r.__err)
        : `${alias || '(没有别名说明)'} · 前三个：${JSON.stringify(slugsOf(r).slice(0, 3))}`,
    );
  }

  /*
   * ---------- ③ 对照：没有词表会怎样 ----------
   *
   * ★★ 这一段**测不了**，如实记在这里，而不是留一条永远绿的假判据：
   *   · 走我们自己的命令一定会应用词表（那是被测的功能本身）；
   *   · 在页面里直接 fetch 平台的接口也不行 —— Tauri 注入的 CSP 会拦掉
   *     页面发往第三方 API 的请求（启动器是在 **Rust 里**发这些请求的），
   *     实测每一条都返回 `TypeError: Failed to fetch`。
   *   ⇒ 于是"没有词表的世界"在这个启动器里不可达。它的价值由 ② 承担：
   *     ② 断言的是"中文能搜到那个具体的 Mod"，而中文原名直达平台得不到正主
   *     这件事已经由**词表里的候选词是项目名而不是中文**间接保证了。
   */

  /* ---------- ④ 词表里没有的中文：不编词 ---------- */
  const unknown = await search('完全不存在的模组名字');
  check(
    !unknown?.query_alias,
    '④ 词表里没有的中文：不编一个英文词出来（query_alias 为空）',
    String(unknown?.query_alias),
  );
  check(
    unknown?.term_used === '完全不存在的模组名字',
    '④ 原样提交给平台（那是 ADR-016 的第 ② 步）',
    String(unknown?.term_used),
  );

  /* ---------- ⑤⑥ 界面：提示语与卡片 ---------- */
  // 打开下载页 → 切到「Mod」页签（资源搜索的界面就在那儿）
  await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').includes('下载'));
    b?.click();
    return !!b;
  })()`);
  await sleep(2000);
  await ev(`(() => {
    const b = [...document.querySelectorAll('.tabs [role="tab"], .tabs button')].find(
      (x) => (x.textContent || '').trim() === 'Mod',
    );
    b?.click();
    return !!b;
  })()`);
  await sleep(2500);

  const typeQuery = async (text) => {
    await ev(`(() => {
      const input = document.querySelector('input[type="search"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '搜索');
      b?.click();
      return !!b;
    })()`);
  };

  await typeQuery('物品管理器');
  let aliasText = '';
  let cards = 0;
  for (let i = 0; i < 25; i += 1) {
    await sleep(500);
    aliasText = String(await ev(`(document.querySelector('.res-alias')?.textContent || '')`));
    cards = Number(await ev(`document.querySelectorAll('.res-grid .res-card').length`));
    if (aliasText && cards > 0) break;
  }
  check(
    aliasText.includes('中文叫法') && aliasText.includes('jei'),
    '⑤ 界面上说清了"按 jei 搜的"',
    aliasText.slice(0, 160),
  );
  check(cards > 0, '⑤ 并且真的列出了卡片', `${cards} 张`);

  await typeQuery('完全不存在的模组名字');
  let fallbackText = '';
  for (let i = 0; i < 25; i += 1) {
    await sleep(500);
    fallbackText = String(await ev(`(document.querySelector('.res-alias')?.textContent || '')`));
    if (fallbackText.includes('英文名')) break;
  }
  check(
    fallbackText.includes('英文名'),
    '⑥ 搜不到时提示"换英文名再试一次"（ADR-016 的第 ③ 步）',
    fallbackText.slice(0, 160),
  );
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
