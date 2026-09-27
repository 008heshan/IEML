/*
 * 一次性排查：**"可用内存"这个数字能不能被稳定地测出变化**。
 *
 * 为什么要先问这个：在给"内存实时刷新"写判据之前，得知道"值会不会动"。
 * 如果一次 2 GB 的内存占用在 sysinfo 里看不出来，那条判据就会永远绿（等于没有）。
 *
 * 用法：node tools/probe/probe-memory-delta.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { invokeOn, launch } from '../live/lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'memdelta',
  env: { IEML_DATA_DIR: path.join(process.env.TEMP ?? '.', 'ieml-mem-root') },
  keepDataDir: true,
  settleMs: 2000,
});

const info = async () => {
  const r = await invokeOn(ev, 'machine_info');
  return r.ok ?? { __err: r.err };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hog = null;
try {
  const a = await info();
  console.log(`基线：可用 ${a.available_memory_gb} GB / 共 ${a.total_memory_gb} GB`);

  // 占 2 GB：Node 里 Buffer.alloc 会真的提交这块内存
  hog = spawn(
    process.execPath,
    ['-e', 'const b=Buffer.alloc(2*1024*1024*1024); b.fill(1); setTimeout(()=>{},90000);'],
    { stdio: 'ignore' },
  );
  await sleep(6000);
  const b = await info();
  console.log(`占 2 GB 之后：可用 ${b.available_memory_gb} GB（差 ${(a.available_memory_gb - b.available_memory_gb).toFixed(2)} GB）`);

  const c = await info();
  console.log(`再读一次（看噪声）：可用 ${c.available_memory_gb} GB（与上一次差 ${(b.available_memory_gb - c.available_memory_gb).toFixed(2)} GB）`);

  console.log(
    Math.abs(a.available_memory_gb - b.available_memory_gb) >= 0.5
      ? '✓ 变化够大（≥0.5 GB），可以据此写判据'
      : '✗ 变化太小 —— 别拿它当判据（会永远绿）',
  );
} finally {
  try {
    hog?.kill();
  } catch {}
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
}
