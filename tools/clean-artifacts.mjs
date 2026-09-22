/**
 * 清理构建与测试的废弃产物（用户：「**清理一下构建的废弃产物**」）。
 *
 * ## 第一次我查错了地方
 *
 *   我先去看 `dist/assets`，报出"5 个孤儿" —— **那是错的**：
 *   它们是动态导入的 chunk，只被主 bundle 引用（见 ADR-025 的 25.2）。
 *   真正堆东西的地方是 **`src-tauri/target/release/bundle/nsis/`**：
 *   **31 个历史安装包、113 MB**（beta.28 一路到 rc.1，每次构建都留一个）。
 *   我是打安装程序时才看到的 —— 这也说明"清理"这类事**得先看清楚谁在长**。
 *
 * ## 这个脚本清什么
 *
 *   · `bundle/**` 里**非当前版本**的安装包与签名（当前版本从 package.json 读，不写死）；
 *   · `%TEMP%` 里本项目真机测试留下的目录（`ieml-*`、`IEML-*-updater-*`）。
 *
 * ★ 不碰：`target/debug`、`target/release/ieml.exe`、`dist/`（那些是**当前产物**，
 *   清掉会让下次构建变慢甚至让门禁的"exe 内嵌前端一致性"读不到东西）。
 *
 * 用法：`node tools/clean-artifacts.mjs [--dry]`
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DRY = process.argv.includes('--dry');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const BUNDLE = 'src-tauri/target/release/bundle';

let freed = 0;
let removed = 0;
const log = [];

/* ---------- ① bundle 里的历史安装包 ---------- */
function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

for (const f of walk(BUNDLE)) {
  const base = f.split(/[\\/]/).pop() ?? '';
  // 当前版本的安装包 / 签名 / 更新包都留着
  if (base.includes(version)) continue;
  const size = statSync(f).size;
  if (!DRY) rmSync(f, { force: true });
  freed += size;
  removed += 1;
  log.push(`  bundle: ${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

/* ---------- ② %TEMP% 里的测试/更新残留 ---------- */
const tmp = tmpdir();
for (const name of readdirSync(tmp)) {
  if (!/^ieml-|^IEML-.*-updater-/i.test(name)) continue;
  const p = join(tmp, name);
  let size = 0;
  try {
    for (const f of walk(p)) size += statSync(f).size;
  } catch {
    /* 目录可能刚被别人删了 */
  }
  if (!DRY) rmSync(p, { recursive: true, force: true });
  freed += size;
  removed += 1;
}

console.log(log.slice(0, 6).join('\n') + (log.length > 6 ? `\n  …（bundle 里还有 ${log.length - 6} 个）` : ''));
console.log(
  `${DRY ? '[dry] 会删' : '已删'} ${removed} 项，回收 ${(freed / 1024 / 1024).toFixed(1)} MB` +
    `（保留当前版本 ${version} 的产物与 dist/、target/ 里的 exe）`,
);
