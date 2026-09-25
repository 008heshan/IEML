/**
 * 诊断（不是判据）：**现在到底哪些地方说 D:、哪些地方说 E:**
 * ------------------------------------------------------------------
 * 用户 2026-09-25：「我把目录从D盘的目录改成E盘的目录，读的还是D盘的目录」。
 *
 * 记账文件已经是 E:\IEML，所以后端**按理**都该读 E:；这个脚本把每一个
 * 会暴露路径的面都抓一遍，看是谁还在说 D: —— 不猜，逐个列出来。
 *
 * 用法：node tools/live/diag-what-root-is-used.mjs "<exe>"
 */
import { readFileSync } from 'node:fs';
import { clickNav, invokeOn, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const RECORD = (process.env.APPDATA ?? '') + '\\IEML\\datadir.txt';

const record = (() => {
  try {
    return readFileSync(RECORD, 'utf8').trim();
  } catch (e) {
    return '(读不到) ' + e.message;
  }
})();
console.log('记账文件 datadir.txt = ' + record + '\n');

await killIeml();
const app = await launch({ exe: EXE, tag: 'whichroot', settleMs: 3800 });
const ev = app.ev;

/* ---------- 后端：会暴露路径的命令 ---------- */
const mi = (await invokeOn(ev, 'machine_info', {}))?.ok ?? {};
console.log('【后端 machine_info】');
console.log('  data_dir      = ' + mi.data_dir);
console.log('  version_count = ' + mi.version_count);

const health = (await invokeOn(ev, 'instance_health', {}))?.ok ?? [];
console.log('\n【后端 instance_health】（前 3 个）');
for (const h of health.slice(0, 3)) {
  console.log('  ' + JSON.stringify(h));
}

const li = (await invokeOn(ev, 'list_instances', {}))?.ok ?? {};
const first = (li.instances ?? [])[0];
console.log('\n【后端 list_instances】条目数 = ' + (li.instances ?? []).length);
if (first) {
  console.log('  第一个条目的字段里有没有绝对路径：');
  for (const [k, v] of Object.entries(first)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && /[A-Za-z]:\\/.test(s)) console.log('    ★ ' + k + ' = ' + s);
  }
  console.log('  （上面没有 ★ 行 = 账本里没有写死盘符）');
}

/* ---------- 后端：启动命令预览（最能说明"游戏从哪个目录起来"） ---------- */
if (first) {
  const req = {
    mc_version: first.mcVersion,
    loader_kind: first.loader ? first.loader.kind ?? null : null,
    loader_version: first.loader ? first.loader.version ?? null : null,
    username: '诊断',
    account_uuid: null,
    memory_mb: 2048,
    width: 854,
    height: 480,
    instance_slug: first.config.slug,
    instance_id: first.id,
    extra_jvm_args: [],
    extra_game_args: [],
    window_title: null,
    join_server: null,
  };
  const pv = await invokeOn(ev, 'preview_launch', { req });
  console.log('\n【后端 preview_launch】（' + first.config.slug + '）');
  if (pv.err) console.log('  失败：' + pv.err);
  else {
    console.log('  java        = ' + pv.ok.java);
    console.log('  natives_dir = ' + pv.ok.natives_dir);
    console.log('  summary     = ' + pv.ok.summary);
    const cmd = String(pv.ok.command ?? '');
    const gameDir = /--gameDir\s+"?([^"\\]*(?:\\.[^"\\]*)*)"?/.exec(cmd);
    console.log('  --gameDir   = ' + (gameDir ? gameDir[1] : '(没解析出来)'));
    const assetIdx = cmd.indexOf('--assetIndex');
    if (assetIdx > 0) console.log('  命令里的 D:/E: 计数：D=' + (cmd.match(/D:\\\\/g) ?? []).length + '  E=' + (cmd.match(/E:\\\\/g) ?? []).length);
  }
}

/* ---------- 界面：每一页的可见文字里，D: 和 E: 各出现几次 ---------- */
console.log('\n【界面每一页的可见文字】');
for (const page of ['启动', '版本列表', '设置', '关于']) {
  await clickNav(ev, page);
  await sleep(1100);
  const txt = await ev('document.body.innerText');
  const d = (txt.match(/D:\\IEML/g) ?? []).length;
  const e = (txt.match(/E:\\IEML/g) ?? []).length;
  console.log(`  ${page}：D:\\IEML 出现 ${d} 次，E:\\IEML 出现 ${e} 次`);
  if (d > 0) {
    const lines = txt.split('\n').filter((l) => l.includes('D:\\IEML'));
    for (const l of lines.slice(0, 4)) console.log('      ← ' + l.trim().slice(0, 120));
  }
}

await app.close();
