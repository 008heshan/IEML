/**
 * 找出**没有被任何地方引用**的源文件与"自认死代码"的标记。
 *
 * 用法：node tools/diag/find-orphans.mjs [--ts|--rs]
 *
 * 这不是门禁（不进 verify）——它是一次性的"清理体检"工具，
 * 输出交给人来判断：一个文件没被引用，可能是死代码，也可能是入口/被外部调用。
 *
 * ★★ **2026-09-25：这条工具的判据以前是坏的，它输出的全是假阳性。**
 *   公开化清理时跑它，报了 24 个前端 + 9 个 Rust 文件"没人引用"，
 *   而 `DownloadPage.tsx` / `platform.rs` / `AppShell.tsx` 这些核心文件都在名单里 ——
 *   显然不对。查下去是两个叠加的错：
 *     ① `name.replace(/\.(ts|tsx|rs)$/, '')`：`(ts|tsx)` 的**交替从左往右**匹配，
 *        `Foo.tsx` 里 `ts` 先命中、`$` 只锚到 `ts` 前 ⇒ stem 仍是 `Foo.tsx`；
 *     ② 更根本的是**方向错了**：前端 import 写的是 `'../pages/DownloadPage'`
 *        （**不带扩展名**），所以 `split('DownloadPage.tsx')` 永远为 0。
 *     ⇒ hits 恒为 0、selfOnly 恒为 1 ⇒ `hits <= selfOnly` **永远成立** ⇒ 全部报成孤儿。
 *   ⇒ 教训：**一个从不报错的工具，比没有工具更危险** —— 它给出的"结论"会被当真。
 *     现在按真实引用写法匹配（TS：`'…/Stem'`；Rust：`mod stem;` / `::stem`），
 *     并且**排除自己这个文件**（否则文件名出现在自己注释里就算"有人引用"）。
 *
 * ★ 看到 `mod.rs` / `main.rs` / `lib.rs` / `main.tsx` / `vite-env.d.ts` 出现在
 *   "没人引用"里是**正常的**：它们是模块根或入口，本来就不该被别人 import。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const only = process.argv.includes('--ts') ? 'ts' : process.argv.includes('--rs') ? 'rs' : 'all';

function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'target' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

function report(label, files, entryPatterns) {
  /*
   * ★★ 2026-09-25 整个判据重写（这条工具以前**只会输出假阳性**，见文末记录）。
   *
   *   旧判据：`text.split(name).length - 1 + (text.split(`${stem}.`).length - 1)`
   *   两个致命问题，实测都在：
   *     ① `name.replace(/\.(ts|tsx|rs)$/, '')` —— `(ts|tsx)` 的**交替从左往右**匹配，
   *        `Foo.tsx` 里 `ts` 先命中、`$` 只锚到 `ts` 前，stem 变成 `Foo.tsx`；
   *     ② 更要命的是**方向错了**：前端 import 写的是 `'../pages/DownloadPage'`
   *        （**不带扩展名**），所以 `split('DownloadPage.tsx')` **永远为 0**。
   *     ⇒ hits 恒为 0、`selfOnly` 恒为 1 ⇒ `hits <= selfOnly` **永远成立**
   *     ⇒ 每个文件都被报成孤儿（实测 24 个前端 + 9 个 Rust，连 `platform.rs` 都在里面）。
   *
   *   新判据按**真实的引用写法**匹配，且**排除自己这个文件**（否则文件名出现在
   *   自己的注释里就会被当成"有人引用"）：
   *     · TS/TSX：`'…/Stem'` 或 `"…/Stem"`（可带 `.ts`/`.tsx` 后缀）
   *     · Rust：`mod stem;` / `use …::stem` / `crate::…::stem`
   */
  const orphans = [];
  for (const f of files) {
    const name = basename(f);
    const stem = name.replace(/\.(?:ts|tsx|rs)$/, '');
    const isRust = name.endsWith('.rs');
    // ★ 每次排除**自己这个文件**：否则文件名出现在自己的注释里就会被当成"有人引用"
    const text = files
      .filter((x) => x !== f)
      .map((x) => readFileSync(x, 'utf8'))
      .join('\n');
    let hits;
    if (isRust) {
      // Rust：模块声明与路径引用
      const re = new RegExp(String.raw`(?:^|\n)\s*(?:pub\s+)?mod\s+${stem}\s*;|::${stem}\b`);
      hits = re.test(text) ? 1 : 0;
    } else {
      // TS/TSX：import / export-from 里的相对路径（带不带扩展名都算）
      const re = new RegExp(String.raw`['"][^'"]*/${stem}(?:\.tsx?)?['"]`);
      hits = re.test(text) ? 1 : 0;
    }
    if (hits === 0) orphans.push(relative(ROOT, f));
  }
  console.log(`\n=== ${label}：没有任何地方引用的 ${orphans.length} 个 ===`);
  for (const o of orphans) console.log(`  ${entryPatterns.some((p) => o.includes(p)) ? '(入口?) ' : '        '}${o}`);
}

if (only === 'ts' || only === 'all') {
  report('前端', walk(join(ROOT, 'src'), ['.ts', '.tsx']), ['main.tsx']);
}
if (only === 'rs' || only === 'all') {
  report('Rust', walk(join(ROOT, 'src-tauri', 'src'), ['.rs']), ['main.rs', 'lib.rs']);
}

/* ---------- 自认死代码的标记 ---------- */
if (only === 'rs' || only === 'all') {
  const files = walk(join(ROOT, 'src-tauri', 'src'), ['.rs']);
  console.log('\n=== #[allow(dead_code)] 标记（自认死代码）===');
  let n = 0;
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (l.includes('allow(dead_code)')) {
        n++;
        console.log(`  ${relative(ROOT, f)}:${i + 1}  ${l.trim()}`);
        console.log(`       下一行：${(lines[i + 1] ?? '').trim()}`);
      }
    });
  }
  console.log(`  共 ${n} 处`);
}
