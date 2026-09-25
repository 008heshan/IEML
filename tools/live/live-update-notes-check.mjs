/*
 * 真机判据：「更新日志」页**实时读更新说明**这条链路真的通。
 *
 * ★★ 2026-09-26 用户：「**这个版本更新列表可以改成实时获取吗，点进去就刷新**」。
 *
 *   这条链路里有两段**只在真机上才成立**的东西，单测覆盖不到：
 *     ① Rust 侧的 `fetch_update_notes` 真的能匿名读到清单（跨域、302 跳
 *        `asset.cnb.cool`、TLS —— 这些在 Node 里测不出来，浏览器里也未必一样）；
 *     ② 页面进得去、卡片显示的是**当前版本**、并且标记了"已刷新"。
 *
 *   ★ 它**故意不验"有没有新版本"** —— 那取决于线上此刻是什么版本，
 *     是环境的属性、不是代码的属性（"判据不能比事实更窄"的反面：也不能更宽）。
 *
 * 用法：node tools/live/live-update-notes-check.mjs ["<exe>"]
 * 退出码：0 = 全通；1 = 有判据不成立；2 = 用户正在用启动器（不打扰，没测）
 */
import { clickNav, invokeOn, killIeml, launch, ps, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';

/* ★ 不替用户关掉他正在用的启动器（同 `live-single-instance-check.mjs` 的规矩） */
const running = ps('(Get-Process ieml -ErrorAction SilentlyContinue | Measure-Object).Count').trim();
if (running && running !== '0') {
  console.error(`有 ${running} 个 ieml 进程在跑 —— 先关掉再跑这个检查（我不替你关）。`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

const { ev, close } = await launch({ exe: EXE, tag: 'updnotes' });

try {
  /* ---------- ① 命令本身：真的能读到清单 ---------- */
  console.log('① 后端命令 `fetch_update_notes`');
  const r = await invokeOn(ev, 'fetch_update_notes', {});
  const got = r?.ok ?? null;
  check(!!got && !r.err, '命令返回了东西', r.err ? `错误：${r.err}` : '');
  if (got) {
    check(
      /^\d+\.\d+\.\d+/.test(String(got.version)),
      '版本号形状对',
      `version=${got.version}`,
    );
    check(
      typeof got.notes === 'string' && got.notes.length > 200,
      '说明正文有实质内容（> 200 字）',
      `${String(got.notes).length} 字`,
    );
    check(
      String(got.notes).includes('##'),
      '正文是 Markdown 的一节（有 `## ` 标题行）',
    );
    check(!!got.pubDate, '带上了发布时间', `pubDate=${got.pubDate}`);
    /* ★ 字段名契约：snake_case 漏出去的话这里会是 undefined（这个仓库栽过三次） */
    check(
      Object.prototype.hasOwnProperty.call(got, 'pubDate'),
      '字段名是 camelCase（跨 IPC 契约）',
      `实际字段：${Object.keys(got).join(', ')}`,
    );
  }

  /* ---------- ② 页面上：进得去、第一张卡是当前版本 ---------- */
  console.log('\n② 「更新日志」页');
  await clickNav(ev, '更新日志');
  await sleep(3500); // 进页面会自动拉一次
  const view = await ev(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const first = cards[0];
    const title = first?.querySelector('.card-title')?.textContent?.trim() ?? '';
    const chips = [...(first?.querySelectorAll('.chip') ?? [])].map((c) => c.textContent.trim());
    const items = [...document.querySelectorAll('.rel-list li')].map((li) => li.textContent.trim());
    return {
      pageTitle: document.querySelector('.page-title')?.textContent?.trim() ?? '',
      cardTitle: title,
      chips,
      itemCount: items.length,
      firstItem: items[0] ?? '',
      bodyText: (document.querySelector('.content')?.textContent ?? '').slice(0, 4000),
      hasRefreshBtn: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('刷新')),
    };
  })()`);

  check(view?.pageTitle === '更新日志', '进到了更新日志页', `pageTitle=${view?.pageTitle}`);
  check(view?.itemCount > 0, '页面上有更新说明条目', `${view?.itemCount} 条`);
  check(view?.hasRefreshBtn === true, '有「刷新」按钮');

  /* 当前版本：从页面上的「关于」拿不到时就问后端 */
  const info = await invokeOn(ev, 'app_info', {});
  const version = info?.ok?.version ?? '';
  check(
    String(view?.cardTitle).includes(version),
    '第一张卡就是**当前版本**（不是只到上一版）',
    `卡片=${view?.cardTitle} / 当前=${version}`,
  );

  /*
   * ★★ 这一条是这次的"用户原话"判据：实时那份到手后，卡片上会挂「已刷新」。
   *   没有它 = 页面还在用构建时打进包里的那份（而包里那份可能缺当前版本）。
   */
  check(
    (view?.chips ?? []).includes('已刷新'),
    '说明是**刚从线上读回来的**（卡片标了「已刷新」）',
    `卡片上的角标：${JSON.stringify(view?.chips)}`,
  );

  /* ---------- ③ 手动点「刷新」不会把它弄坏 ---------- */
  console.log('\n③ 手动刷新');
  await ev(
    `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('刷新'))?.click()`,
  );
  await sleep(3000);
  const again = await ev(`(() => {
    const first = document.querySelector('.card');
    return {
      chips: [...(first?.querySelectorAll('.chip') ?? [])].map((c) => c.textContent.trim()),
      itemCount: document.querySelectorAll('.rel-list li').length,
      said: (document.querySelector('.content')?.textContent ?? '').includes('没能从更新通道读到最新说明'),
    };
  })()`);
  check((again?.itemCount ?? 0) > 0, '刷新之后内容还在（不是清空重来）', `${again?.itemCount} 条`);
  check(again?.said !== true, '没有出现"读不到"的提示');
} finally {
  await close();
  await killIeml();
}

console.log(`\n${fail === 0 ? `✓ 全通（${pass} 条判据）` : `✗ ${fail} / ${pass + fail} 条不成立`}`);
process.exit(fail ? 1 : 0);
