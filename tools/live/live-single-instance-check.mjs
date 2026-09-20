/**
 * 真机验证：**单实例** —— IEML 正在跑时再双击一次，应该"调起已经在跑的那个"，
 * 而不是再开一个窗口。
 * ------------------------------------------------------------------
 * 为什么要有这条（它回答一个具体问题，不是一个泛泛的"冒烟测试"）：
 *
 *   ① 用户 2026-09-20 明确要求："当 IEML 正在运行时，如果再次双击快捷方式，
 *      我希望能调起正在运行的 IEML，而不是打开一个新的"；
 *   ② 这不只是体验问题：两个启动器同时写 `instances.json` / `prefs.json`，
 *      后写的会把先写的**整份覆盖**；同一份游戏目录被两个界面同时读改，
 *      看着都"成功"。
 *   ③ 它靠的是 `tauri-plugin-single-instance`：**插件必须第一个注册**，
 *      而且"能置前台"是插件替我们铺的一步（第二个实例退出前先
 *      `AllowSetForegroundWindow`）。谁把它挪走/删掉，界面上一点异常都没有 ——
 *      要等用户报"开了两个"才发现。所以留一条真机断言守着。
 *
 * 判据（四条，缺一条都等于没做到）：
 *   · 第二个实例**自己退出**（退出码 0），不留在后台；
 *   · 第一个实例**被还原**（最小化状态被解掉）；
 *   · 第一个实例的窗口**成为前台窗口**（这才是"调起"）；
 *   · 全程**只剩一个**进程。
 *
 * 用法：
 *   node tools/live/live-single-instance-check.mjs ["<exe>"]
 *   默认用桌面那份（`%USERPROFILE%\Desktop\IEML.exe`）。
 *
 * ★ 它只动**这个 exe** 的进程：不会碰开发机上别的 IEML（比如你自己开着的
 *   另一份、或者 target/debug 里的调试实例）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXE = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一段 PowerShell 并拿回它的 stdout */
const ps = (script) =>
  new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('close', () => resolve(out.trim()));
  });

const USER32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'`;

/** 只收掉**同一个 exe** 的残留实例（别去碰用户开着的另一份） */
const killSame = () =>
  ps(
    `Get-Process ieml -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' } | Stop-Process -Force`,
  );

/** 这个 exe 现在有几个实例在跑 */
const countSame = async () =>
  Number(
    await ps(
      `@(Get-Process ieml -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' }).Count`,
    ),
  );

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

console.log(`被测 exe：${EXE}\n`);

/*
 * ★★ 起手先看有没有人在用这一份，**有就拒绝跑** —— 不替用户关掉他正开着的启动器。
 *   （这条检查自己会起两个实例、最后再收掉，前提是起手时没人用这份 exe。）
 */
const running = await countSame();
if (running > 0) {
  console.error(
    `✗ 这个 exe 现在有 ${running} 个实例在跑 —— 请先关掉它再跑这条检查\n` +
      `  （它需要从"一个都没有"的状态起两次实例；替你关掉正在用的启动器不是它该做的事）`,
  );
  process.exit(2);
}

/* ---------- ① 起第一个实例 ---------- */
const a = spawn(EXE, [], { stdio: 'ignore', detached: false });
console.log(`· 第一个实例 PID ${a.pid}`);
let hwnd = 0;
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const h = Number(
    await ps(`(Get-Process -Id ${a.pid} -ErrorAction SilentlyContinue).MainWindowHandle`),
  );
  if (h > 0) {
    hwnd = h;
    break;
  }
}
check('第一个实例起来了并有主窗口', hwnd > 0, `hwnd=${hwnd}`);
if (hwnd === 0) {
  await killSame();
  process.exit(1);
}

/* ---------- ② 把它最小化（"它没在前台"的最常见形态） ---------- */
await ps(`${USER32}; [W.U]::ShowWindow([System.IntPtr]${hwnd}, 6) | Out-Null`);
await sleep(1500);
const iconicBefore = await ps(`${USER32}; [W.U]::IsIconic([System.IntPtr]${hwnd})`);
check('已把第一个实例最小化（模拟"再双击一次"之前的现场）', /true/i.test(iconicBefore), iconicBefore);

/* ---------- ③ 再开一次 = 用户再次双击快捷方式 ---------- */
const t0 = Date.now();
const b = spawn(EXE, [], { stdio: 'ignore', detached: false });
const bExit = await new Promise((resolve) => {
  b.on('exit', (code) => resolve(code));
  setTimeout(() => resolve('timeout'), 20000);
});
const ms = Date.now() - t0;
console.log(`· 第二个实例 PID ${b.pid} 退出码 ${bExit}（${ms} ms）`);
check('第二个实例自己退出了（没在后台多开一个）', bExit === 0, `退出码 ${bExit}`);

/* ---------- ④ 第一个实例被调起来了 ---------- */
await sleep(2500);
const after = await ps(`${USER32}
$iconic = [W.U]::IsIconic([System.IntPtr]${hwnd})
$fg = [W.U]::GetForegroundWindow()
$cnt = @(Get-Process ieml -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' }).Count
"iconic=$iconic;foreground=$fg;count=$cnt"`);
console.log(`· 之后：${after}`);
const iconic = /iconic=(\w+)/.exec(after)?.[1];
const fg = Number(/foreground=(\d+)/.exec(after)?.[1]);
const count = Number(/count=(\d+)/.exec(after)?.[1] ?? -1);
check('第一个实例被还原（不再最小化）', /false/i.test(String(iconic)), String(iconic));
check('第一个实例的窗口成为前台窗口（这就是"调起"）', fg === hwnd, `前台 ${fg} vs 目标 ${hwnd}`);
check('全程只剩一个实例', count === 1, `count=${count}`);

/* 收尾：把这个 exe 的实例关掉，别留在用户机器上 */
await killSame();
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
