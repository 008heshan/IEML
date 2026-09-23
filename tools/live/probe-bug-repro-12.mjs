/**
 * 真机证明 A-5 的机制：**光启动一次，实例清单里那 7 个字段就没了**
 * ------------------------------------------------------------------
 * 依据：`AppContext.tsx:675-680` —— 读到实例列表之后，250ms 会 `saveInstances(...)` 回写一遍。
 * 做法：沙盒里手写一份带全部"前端专有字段"的 instances.json → 启动 → 等 6 秒 → 再读同一份文件。
 * 判据：写之前这些键在，写之后**只剩 Rust 结构体那 6 个**。
 * 用法：node tools/live/probe-bug-repro-12.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9981;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a5-root');
const OWN = path.join(T, 'ieml-a5-own');
const PROFILE = path.join(T, 'ieml-a5-prof');
const FILE = path.join(ROOT, 'instances.json');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(OWN, 'instances'), { recursive: true });
writeFileSync(
  FILE,
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-a5',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '探针·七个字段',
            slug: 'probe-a5',
            isolation: 'auto',
            memoryMb: 2048,
            memorySource: 'auto',
            javaMode: 'path',
            /* ↓↓↓ 前端有、Rust 结构体里没有的 7 个字段 ↓↓↓ */
            joinServer: '1.2.3.4:abc',
            javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
            javaRange: { min: 17, max: 21 },
            jvmArgs: '-XX:+UseG1GC',
            gameArgs: '--demo',
            windowTitle: '我的窗口标题',
            customInfo: '自定义信息',
          },
          createdAt: new Date().toISOString(),
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      active_id: null,
    },
    null,
    2,
  ),
);
const keysOf = () => {
  const j = JSON.parse(readFileSync(FILE, 'utf8'));
  return Object.keys(j.instances?.[0]?.config ?? {});
};
const before = keysOf();
console.log('启动前 config 的键（' + before.length + ' 个）：' + JSON.stringify(before));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
spawn(EXE, [], {
  env: {
    ...process.env,
    IEML_DATA_DIR: ROOT,
    IEML_OWN_DIR: OWN,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});
/* 等它起来 + 那次 250ms 回写 */
await sleep(9000);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
const after = keysOf();
console.log('启动并自动回写之后 config 的键（' + after.length + ' 个）：' + JSON.stringify(after));
const lost = before.filter((k) => !after.includes(k));
console.log('\n===== 判据 =====');
console.log('  丢掉的键：' + JSON.stringify(lost));
console.log(
  lost.length >= 5
    ? '★★ A-5 机制级真机确认：**一次启动就够了** —— 那次自动回写把前端专有字段全丢了。'
    : '（这次没丢，见上面两组键）',
);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
