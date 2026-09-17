/*
 * 守 PowerShell 脚本的编码：**带中文的 .ps1 必须有 UTF-8 BOM**。
 *
 * ## 为什么值得一条门禁
 *
 * PowerShell 5.1 读 `.ps1` 时，如果文件没有 BOM，就按**系统 ANSI 代码页**解码
 * （这台中文机器上是 GBK）。UTF-8 的中文注释被当成 GBK 解 → 出现半个汉字、
 * 引号配对被破坏 → **解析失败**，而报错信息长这样：
 *
 *     Unexpected token '}' in expression or statement.
 *     At E:\IEML\tools\env\cargo-manual-msvc.ps1:11 char:1
 *
 * 报的是第 11 行那个无辜的 `}`，真凶是第 1 行的中文注释。**这个坑在本仓库
 * 已经踩过三次**（`.ps1` 无 BOM、`Set-Content` 写坏中文、`Get-Content` 读坏 JSON），
 * 每次都花时间在错误的方向上找。
 *
 * ## 为什么容易复发
 *
 * 用带 BOM 的编辑器改完没事，但**任何"以 UTF-8 无 BOM 重新落盘"的工具**
 * （本仓库里是 AI 的 write/edit 工具、以及 node 的 writeFileSync）都会把 BOM 悄悄
 * 抹掉 —— 而文件内容看起来完全正常，diff 里也看不出来。所以只能靠检查。
 *
 * 纯 ASCII 的 .ps1 不需要 BOM（没有可被误解码的字节），这里不报。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const BOM = [0xef, 0xbb, 0xbf];

/** 只扫真正会被 PowerShell 执行的目录，别把 node_modules 之类的拖进来 */
const SCAN_DIRS = ['tools', 'scripts'];
const SKIP = new Set(['node_modules', 'target', 'dist', '.git']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.ps1')) out.push(p);
  }
  return out;
}

const files = [...walk(join(root, 'tools')), ...walk(join(root, 'scripts'))];
if (files.length === 0) {
  console.log('  （tools/ 下没有 .ps1，跳过）');
  process.exit(0);
}

const broken = [];
for (const f of files) {
  const buf = readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  // 去掉 BOM 后再判断有没有非 ASCII —— BOM 自己那几个字节不算内容
  const text = buf.subarray(hasBom ? 3 : 0).toString('utf8');
  const nonAscii = /[^\x00-\x7F]/.test(text);
  const rel = relative(root, f).replace(/\\/g, '/');
  if (nonAscii && !hasBom) broken.push(rel);
  else if (nonAscii) console.log(`  ✓ ${rel}  BOM 有`);
  else console.log(`  · ${rel}  纯 ASCII，不需要 BOM`);
}

if (broken.length === 0) {
  console.log(`  ${files.length} 个 PowerShell 脚本编码都正确`);
  process.exit(0);
}

console.error('');
console.error(`✗ ${broken.length} 个含中文的 .ps1 没有 UTF-8 BOM —— PowerShell 5.1 会按 GBK 解码，直接解析失败：`);
for (const f of broken) console.error(`    ${f}`);
console.error('');
console.error('  修（会保留原内容，只在最前面加三个字节）：');
console.error('    $p = "tools/env/xxx.ps1"');
console.error('    $b = [IO.File]::ReadAllBytes((Resolve-Path $p))');
console.error('    [IO.File]::WriteAllBytes((Resolve-Path $p), ([byte[]](0xEF,0xBB,0xBF) + $b))');
console.error('');
process.exit(1);
