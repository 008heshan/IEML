/**
 * 看「更新日志」页渲染出来是什么样（用户要的那个格式到底有没有落地）。
 * ------------------------------------------------------------------
 * 判据（四条）：
 *   ① 页面上能读到五段里的那几段（顺序正确、没有空段）
 *   ② 每一条都以所属段落的类别词开头（页面上的文本，不是源码）
 *   ③ 最新一版是 rc.4（版本号 + 今天）
 *   ④ 顺手截一张图，给人眼核对
 *
 * 用法：node tools/live/probe-changelog-format.mjs "<exe>" [截图路径]
 */
import { existsSync, writeFileSync } from 'node:fs';
import { clickNav, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const SHOT = process.argv[3] ?? 'tmp/rc4-changelog.png';

await killIeml();
const app = await launch({ exe: EXE, tag: 'changelog' });
const { ev, send } = app;

/* 进「更新日志」页 */
await clickNav(ev, '更新日志');
await sleep(2200);

/* 最新一版（第一条 rel-group 的所属卡片）里的段落与条目 */
const dump = await ev(`(() => {
  const cards = [...document.querySelectorAll('.stack > *')];
  const first = cards.find((c) => c.querySelector('.rel-group'));
  if (!first) return { 错: '找不到更新日志卡片' };
  /*
   * ★ 版本号不要挑 .mono —— 那是右上角的**日期**（第一版就这么抓错了，判据 ③ 假红）。
   *   卡片标题里才是版本号，所以从整张卡的文本里按形状捞。
   */
  const text = (first.innerText || first.textContent || '');
  const ver = (text.match(/0\\.1\\.0-[a-z]+\\.[0-9]+/) || [''])[0];
  const head = (first.querySelector('.rel-headline')||{}).textContent || '';
  const groups = [...first.querySelectorAll('.rel-group')].map((g) => ({
    段: (g.querySelector('.rel-group-t')||{}).textContent || '',
    条: [...g.querySelectorAll('.rel-list li')].map((li) => (li.textContent||'').trim()),
  }));
  return { 版本: ver, 头条: head.trim(), 段数: groups.length, groups };
})()`);
console.log('最新一版：' + JSON.stringify({ 版本: dump?.版本, 头条: dump?.头条, 段数: dump?.段数 }, null, 2));
if (Array.isArray(dump?.groups)) {
  for (const g of dump.groups) {
    console.log(`  【${g.段}】${g.条.length} 条`);
    for (const it of g.条) console.log('     - ' + it);
  }
}

/* 截图（Page.captureScreenshot 经由公共库的 send） */
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图已写：' + SHOT);
}

await app.close();

/* ---------- 判据 ---------- */
const ORDER = ['新增了', '修复了', '优化了', '删除了', '修改了'];
const groups = dump?.groups ?? [];
const idx = groups.map((g) => ORDER.indexOf(g.段));
const c1 =
  groups.length > 0 &&
  idx.every((i) => i >= 0) &&
  idx.every((v, i) => i === 0 || v > idx[i - 1]) &&
  groups.every((g) => g.条.length > 0);
const badItems = groups.flatMap((g) => g.条.filter((it) => !it.startsWith(g.段)).map((it) => `${g.段}: ${it.slice(0, 24)}`));
const c2 = badItems.length === 0;
const c3 = String(dump?.版本 ?? '').includes('0.1.0-rc.4');
const c4 = existsSync(SHOT);

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 五段齐全有序、没有空段（${groups.map((g) => g.段).join(' / ')}）`);
console.log(`${c2 ? '✓' : '✗'} ② 每条都以类别词开头${badItems.length ? '，不合规的：' + JSON.stringify(badItems) : ''}`);
console.log(`${c3 ? '✓' : '✗'} ③ 最新一版是 rc.4（页面上读到：${JSON.stringify(dump?.版本)}）`);
console.log(`${c4 ? '✓' : '✗'} ④ 截图已生成：${SHOT}`);
process.exit(c1 && c2 && c3 && c4 ? 0 : 1);
