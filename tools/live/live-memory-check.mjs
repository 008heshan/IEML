/*
 * 真机判据：**内存实时刷新**（2026-09-28）。
 *
 * ## 为什么这条要真机验
 *
 *   界面上写着的东西与真实情况脱节：启动页写着"可用 12 GB"，而那是
 *   **启动那一刻**的读数 —— 用户照它选内存，游戏起不来（或者被系统换页拖死）。
 *
 * ## 判据（三段）
 *
 *   ① 启动页显示"可用 X / 共 Y GB"
 *   ② ★★ 在旁边真的占掉 2 GB 内存 → **界面上的数字自己变了**（≤40 秒内、降幅 ≥1 GB）
 *      —— 这条能红：把那个定时刷新删掉，它就会一直显示旧值
 *   ③ 放开内存 → 数字回升（说明它是双向实时的，不是"只降不升"）
 *
 * ★★ 2026-09-28 删掉了原来的 ④⑤ 两段（"版本列表上有「新建版本」、点它弹出创建弹窗"）：
 *   用户在截图里点名要求把这一页的「新建版本」「新装一个」「去下载页装一份」
 *   以及中间那个「新建/切换游戏目录」**全部删掉、永远不再加回来**。
 *   那两段判据守的正是被删掉的按钮，留着就是"守着不存在的东西"。
 *   ⇒ 现在由 `tools/live/live-version-page-actions-check.mjs` 守**新的**事实
 *     （那几个按钮不在，而右上角该在的三个还在）。
 *
 * ## 怎么"真的占内存"
 *
 *   起一个 Node 子进程 `Buffer.alloc(2GB).fill(1)` 并按住 90 秒 ——
 *   `probe-memory-delta.mjs` 实测过：sysinfo 能**稳定**看出这 2 GB（噪声 0.00 GB），
 *   所以这条判据不是"永远绿"的那种。
 *
 * 用法：
 *   node tools/live/live-memory-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-mem-live-root');
const OWN = path.join(T, 'ieml-mem-live-own');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 沙盒：一个实例（版本列表要有行，才验得了入口） ---------- */
rmSync(ROOT, { recursive: true, force: true });
rmSync(OWN, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
const MC = path.join(ROOT, '.minecraft');
const VER = path.join(MC, 'versions', '1.12.2');
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, '1.12.2.json'),
  JSON.stringify({ id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);
mkdirSync(path.join(ROOT, 'instances', 'mem-probe', 'game'), { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-mem',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '内存探针',
            slug: 'mem-probe',
            isolation: 'on',
            memoryMb: 2048,
            memorySource: 'global',
            javaMode: 'auto',
          },
          createdAt: null,
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      activeId: 'i-mem',
    },
    null,
    2,
  ),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'memlive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

/** 界面上显示的那两个数（"可用 X / 共 Y GB"） */
const shownMemory = () =>
  ev(`(() => {
    const t = document.body.innerText || '';
    const m = t.match(/可用[^0-9]*([0-9.]+)\\s*\\/\\s*([0-9.]+)\\s*GB/);
    return m ? { avail: Number(m[1]), total: Number(m[2]) } : null;
  })()`);

let hog = null;
try {
  /* ---------- ① 启动页上那个数 ---------- */
  const first = await shownMemory();
  check(
    first !== null && first.total > 0,
    '① 启动页显示"可用 X / 共 Y GB"',
    JSON.stringify(first),
  );

  /* ---------- ② 占 2 GB → 数字自己变 ---------- */
  hog = spawn(
    process.execPath,
    ['-e', 'const b=Buffer.alloc(2*1024*1024*1024); b.fill(1); setTimeout(()=>{},90000);'],
    { stdio: 'ignore' },
  );
  let dropped = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    const now = await shownMemory();
    if (now && first && first.avail - now.avail >= 1) {
      dropped = now;
      break;
    }
  }
  check(
    dropped !== null,
    '② ★★ 真的占掉 2 GB 之后，界面上的数字**自己变了**（≤40 秒内降了 ≥1 GB）',
    dropped ? `可用 ${first.avail} → ${dropped.avail} GB` : `一直是 ${JSON.stringify(await shownMemory())}`,
  );

  /* ---------- ③ 放开 → 回升（双向实时） ---------- */
  try {
    hog.kill();
  } catch {}
  hog = null;
  let back = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    const now = await shownMemory();
    if (now && dropped && now.avail - dropped.avail >= 1) {
      back = now;
      break;
    }
  }
  check(
    back !== null,
    '③ 放开内存之后数字**回升**（不是只降不升）',
    back ? `可用 ${dropped?.avail} → ${back.avail} GB` : `仍然 ${JSON.stringify(await shownMemory())}`,
  );
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  try {
    hog?.kill();
  } catch {}
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
