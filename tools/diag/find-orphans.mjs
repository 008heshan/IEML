/**
 * 找出**没有被任何地方引用**的源文件与"自认死代码"的标记。
 *
 * 用法：node tools/diag/find-orphans.mjs [--ts|--rs]
 *
 * 这不是门禁（不进 verify）——它是一次性的"清理体检"工具，
 * 输出交给人来判断：一个文件没被引用，可能是死代码，也可能是入口/被外部调用。
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
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const orphans = [];
  for (const f of files) {
    const name = basename(f);
    const stem = name.replace(/\.(ts|tsx|rs)$/, '');
    // 引用判据：别处出现 "stem" 这个词（import / mod / 路径字符串）
    const hits = text.split(name).length - 1 + (text.split(`${stem}.`).length - 1);
    const selfOnly = readFileSync(f, 'utf8').includes(stem) ? 1 : 0;
    if (hits <= selfOnly) orphans.push(relative(ROOT, f));
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
