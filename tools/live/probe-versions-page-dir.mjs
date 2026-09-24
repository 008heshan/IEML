/**
 * 真机验证「版本列表」这一页的实例目录落在哪个盘（用户报的就是这一处）。
 * ------------------------------------------------------------------
 * 用户的原始动作：版本列表 → 某一行的 ⋯ →「打开目录」→ 弹 toast「已打开实例目录 <路径>」
 * 并让资源管理器打开那个目录。这个命令（`open_data_dir`）的路径来自
 * `AppPaths::instance_dir(slug)` —— 也就是本次修复要钉住的那一处。
 *
 * 判据（五条）：
 *   ① 版本列表页真的读到了实例（行数 = 清单里的条数）
 *   ② **每一行**解析到的游戏目录都在用户挑的那个盘（`D:\IEML\instances\…`）
 *   ③ 那些目录磁盘上**都存在**（老行为给出的两个实例路径是不存在的）
 *   ④ 按用户原动作点「打开目录」，给的路径也在 D 盘
 *   ⑤ 都不在启动器自己的家（`%APPDATA%\IEML\instances\…`）
 *
 * ★ 会真的弹一次资源管理器（这正是用户那个动作的一部分）—— 读完 toast 后按路径把它关掉。
 * ★ 用真实数据（不设沙盒变量）：用户报的就是"我这台机器上版本列表读的是别的盘"。
 *
 * 用法：node tools/live/probe-versions-page-dir.mjs "<exe>"
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, killIeml, launch, ps, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const APPDATA = process.env.APPDATA ?? '';
const C_INST = path.join(APPDATA, 'IEML', 'instances').toLowerCase();
const D_INST = 'd:\\ieml\\instances';

await killIeml();
const app = await launch({ exe: EXE, tag: 'versdir' });
const { ev } = app;

/* 进「版本列表」页 */
await ev(`[...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);
const rows = await ev(`[...document.querySelectorAll('.ver-item')].map((x)=>(x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50))`);
console.log('版本列表页的行：' + JSON.stringify(rows));

/* ---------- 先不下任何副作用地量每一行：preview_launch 的 --gameDir / natives ---------- */
const listed = await invokeOn(ev, 'list_instances', {});
const allRows = [];
for (const i of listed?.ok?.instances ?? []) {
  const req = {
    mc_version: i.mcVersion,
    loader_kind: i.loader ? i.loader.kind : null,
    loader_version: i.loader ? i.loader.version : null,
    username: 'PathProbe',
    account_uuid: null,
    memory_mb: i.config?.memoryMb ?? 2048,
    width: 854,
    height: 480,
    instance_slug: i.config?.slug ?? '',
    instance_id: i.id,
    extra_jvm_args: [],
    extra_game_args: [],
    window_title: null,
    join_server: null,
  };
  const r = await invokeOn(ev, 'preview_launch', { req });
  const m = /--gameDir\s+"?([^"\s]+)"?/.exec(r?.ok?.command ?? '');
  const gd = m ? m[1] : '';
  allRows.push({ 名称: i.config?.name, slug: req.instance_slug, 游戏目录: gd, 存在: gd ? existsSync(gd) : null, 出错: r?.err ?? null });
}
console.log('每一行各自解析到的游戏目录：');
for (const r of allRows) {
  console.log(`   ${r.名称}（${r.slug}）→ ${r.游戏目录}  存在=${r.存在}${r.出错 ? ' 出错=' + r.出错 : ''}`);
}

/* 第一行 → ⋯ →「打开目录」 */
const clicked = await ev(`(() => {
  const row = document.querySelector('.ver-item');
  if (!row) return '没有行';
  const btns = [...row.querySelectorAll('button')];
  const more = btns[btns.length - 1];
  if (!more) return '没有菜单按钮';
  more.click();
  return 'menu-clicked';
})()`);
console.log('点开行内菜单：' + clicked);
await sleep(600);
const opened = await ev(`(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const t = items.find((x) => (x.textContent || '').includes('打开目录'));
  if (!t) return { 找到: false, 菜单项: items.map((x) => (x.textContent || '').trim()) };
  t.click();
  return { 找到: true };
})()`);
console.log('点「打开目录」：' + JSON.stringify(opened));

/* 读 toast 里的路径（命令的返回值就是它） */
let toast = null;
for (let i = 0; i < 25; i += 1) {
  toast = await ev(`(() => {
    const t = [...document.querySelectorAll('.toast')].map((x) => ({
      title: (x.querySelector('.toast-t')||{}).textContent || '',
      desc: (x.querySelector('.toast-d')||{}).textContent || '',
    }));
    return t.length ? t : null;
  })()`);
  if (toast) break;
  await sleep(300);
}
console.log('toast：' + JSON.stringify(toast));

const dir = ((toast ?? []).find((t) => (t.title || '').includes('已打开')) ?? toast?.[0] ?? {}).desc ?? '';
console.log('★ 版本列表「打开目录」给出的路径：' + JSON.stringify(dir));

/* 把这个资源管理器窗口关掉（不留窗口在用户桌面上） */
if (dir) {
  const close = await ps(
    `$target='${dir}'; $sh=New-Object -ComObject Shell.Application; $n=0; foreach ($w in @($sh.Windows())) { try { if ($w.LocationURL -and ($w.LocationURL -replace 'file:///','' -replace '/','\\\\').ToLower().TrimEnd('\\') -eq $target.ToLower().TrimEnd('\\')) { $w.Quit(); $n++ } } catch {} }; "关了 $n 个窗口"`,
  );
  console.log('清理资源管理器窗口：' + close);
}

await app.close();

const lower = (s) => String(s ?? '').toLowerCase();
const dirLow = lower(dir);
const allRowsD = allRows.length > 0 && allRows.every((r) => lower(r.游戏目录).startsWith(D_INST + '\\'));
const allRowsExist = allRows.length > 0 && allRows.every((r) => r.存在 === true);
const c1 = Array.isArray(rows) && rows.length >= 1;
const c2 = dirLow.startsWith(D_INST + '\\');
const c3 = !dirLow.startsWith(C_INST + '\\');
const c4 = dir ? existsSync(dir) : false;
console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 版本列表读到了实例（${(rows ?? []).length} 行）`);
console.log(`${allRowsD ? '✓' : '✗'} ② **每一行**解析到的游戏目录都在 ${D_INST} 下（共 ${allRows.length} 行）`);
console.log(`${allRowsExist ? '✓' : '✗'} ③ 那些目录磁盘上都存在`);
console.log(`${c2 ? '✓' : '✗'} ④ 按用户原动作点「打开目录」给的路径也在 D 盘：${dir}`);
console.log(`${c3 ? '✓' : '✗'} ⑤ 都不在 %APPDATA%\\IEML\\instances 下（老行为才会那样）`);
process.exit(c1 && allRowsD && allRowsExist && c2 && c3 && c4 ? 0 : 1);
