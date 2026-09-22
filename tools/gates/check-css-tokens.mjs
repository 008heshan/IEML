/**
 * 加一条"令牌引用必须存在"的静态门禁。
 *
 * 由来（2026-09-22）：`var(--ease)` 被用了 13 处，而 `--ease` **从来没定义过** ——
 * CSS 自定义属性缺失时，整条声明在**计算值阶段**失效（`transition` 变 `unset`），
 * 于是那些过渡**一直是瞬变**。代码读起来完全正常，只有真机看动画才发现。
 *
 * 这个脚本把所有 `var(--x)` 的引用与 `:root` 里声明过的令牌对一遍，
 * 白名单只留"运行时会由 JS 设上"的那几个（`--ambient-image` / `--glass-tint` …）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 运行时由 JS 注入的令牌（CSS 里查不到是正常的） */
const RUNTIME = new Set([
  '--ambient-image',
  '--glass-tint',
  '--glass-lum',
  '--glass-lens-url',
  '--topbar-h',
  '--z-boot',
  '--z-toast',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk('src/styles'), ...walk('src/ui')];
const declared = new Set();
const used = new Map(); // token -> [file:line]

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  text.split('\n').forEach((line, i) => {
    // 声明（`--x: ...;`）
    for (const m of line.matchAll(/(^|[\s{;(])(--[a-z0-9-]+)\s*:/gi)) declared.add(m[2]);
    // 引用（`var(--x` 或 `var(--x,`）
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const tok = m[1];
      /*
       * ★ 只在 **.css** 里强制，且跳过"不完整"的令牌名。
       *   两个已知的非引用情形：
       *     · TS 里用模板拼名字（`var(--ambient-${x})`）→ 抓到的是半截 `--ambient-`；
       *     · 注释里举例（`颜色一律走 var(--ambient-*)`）→ 同上。
       *   所以：末尾是 `-` 的一律不算引用；.ts/.tsx 只统计不判红。
       */
      if (tok.endsWith('-')) continue;
      const inCss = f.endsWith('.css');
      if (!used.has(tok)) used.set(tok, []);
      used.get(tok).push(`${f}:${i + 1}${inCss ? '' : '（脚本，仅供参考）'}`);
      if (!inCss) continue;
      used.get(tok).enforce = true;
    }
  });
}

const missing = [];
for (const [tok, where] of used) {
  if (declared.has(tok) || RUNTIME.has(tok)) continue;
  const cssOnly = where.filter((w) => !w.includes('（脚本'));
  if (cssOnly.length === 0) continue; // 只有脚本里用到 → 不判红
  missing.push(`${tok} —— 被引用于 ${cssOnly.slice(0, 3).join(' / ')}${cssOnly.length > 3 ? ` 等 ${cssOnly.length} 处` : ''}`);
}

if (missing.length) {
  console.error('✗ 有 var() 引用了**没有定义**的令牌（声明会在计算值阶段失效）：\n');
  for (const m of missing) console.error('   ' + m);
  console.error('\n修法：在 tokens.css 的 :root 里定义它，或把引用改成已存在的令牌。');
  process.exit(1);
}
console.log(`✓ 令牌引用全部有定义（引用 ${used.size} 个，声明 ${declared.size} 个）`);
