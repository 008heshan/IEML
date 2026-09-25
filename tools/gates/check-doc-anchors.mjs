/*
 * 门禁：`docs/DECISIONS.md` 里的**站内锚点必须真的存在**。
 *
 * ## 为什么值得一条门禁
 *
 * 2026-09-25 通读文档时撞到一个死锚点：
 *
 *     [ADR-020](#adr-020主页即当前实例概览)
 *
 * 而 ADR-020 的标题从**第一天**起就是"加载器识别必须用「libraries 坐标 + 排除条件」"
 * ——「主页即当前实例概览」这个说法在全文里**根本不存在**。也就是说：
 * 谁顺着那个链接去找"为什么概览页被收窄"，会点到空气，然后开始怀疑自己记错了。
 *
 * ★ 更值得记的是**它为什么会出现**：ADR 的标题里带全角括号、空格、`★`，
 *   GitHub 生成的锚点是"标题去掉标点、空格换连字符、字母转小写"。
 *   人**手写不出**这个规则（本仓库里同一份文件的锚点写法就有好几种），
 *   所以这类链接**只能靠机器对**。
 *
 * ## 判据
 *
 *   1. 扫 `docs/*.md` 里所有 `](#...)` 形式的站内链接；
 *   2. 对每一份**被链接的文件**（默认同一份文件，也支持 `./DECISIONS.md#…`）
 *      按 GitHub 的规则算出全部标题的锚点；
 *   3. 链接目标不在集合里 → 报出来（附"最接近的几个候选"，省得人去猜）。
 *
 * 用法：node tools/gates/check-doc-anchors.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const DOCS = 'docs';

/**
 * GitHub 的标题 → 锚点规则（**照 github-slugger 的实现抄的，别自己发明**）。
 *
 * ★★ 这里踩过一次，值得记：第一版我把"空格"写成了 JS 的 `\s` —— 而 JS 的 `\s`
 *   **包含全角空格 U+3000**，GitHub 用的却是 ASCII 那一组 `[ \t\n\r\f\v]`。
 *   本仓库的 ADR 标题恰好用全角空格分隔（`## ADR-027　整合包…`），
 *   于是我的算法多出一个连字符、把仓库里**本来正确**的 12 个链接全判成死锚点。
 *   → **判据的工具本身也会骗人**：红了先怀疑量法（这个仓库的老规矩）。
 *
 * 规则：
 *   · 字母 / 数字 / 连接符（含下划线）/ 组合符号 / 短横线 **保留**；
 *   · ASCII 空白 → 连字符；
 *   · 其余（标点、`★`、全角空格、全角括号……）**直接删掉**，不换成连字符。
 */
const slug = (title) =>
  title
    .trim()
    .toLowerCase()
    .replace(/[\p{Letter}\p{Number}\p{Mark}\p{Connector_Punctuation}\p{Dash_Punctuation}]+/gu, (m) => m)
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\p{Connector_Punctuation}\p{Dash_Punctuation} \t\n\r\f\v-]/gu, '')
    .replace(/[ \t\n\r\f\v]/g, '-');

/** 收一份 md 里所有标题的锚点 */
function anchorsOf(file) {
  const text = readFileSync(file, 'utf8');
  const set = new Set();
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  return set;
}

const files = existsSync(DOCS)
  ? readdirSync(DOCS).filter((f) => f.endsWith('.md')).map((f) => join(DOCS, f))
  : [];
// 根目录的 README 也常引用 docs 里的锚点
if (existsSync('README.md')) files.push('README.md');

const problems = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const own = anchorsOf(file);
  // 缓存：别的 md 的锚点集合（按需算）
  const cache = new Map([[file, own]]);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 形如 ](./DECISIONS.md#xxx) 或 ](#xxx)
    const re = /\]\(([^)\s]*)#([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const target = m[1];
      const anchor = m[2];
      checked += 1;
      let set;
      if (target === '' || target === undefined) {
        set = own;
      } else {
        // 只处理同仓的 md（http 链接与图片不管）
        if (/^https?:/i.test(target)) continue;
        const rel = target.replace(/^\.\//, '');
        const path = rel === '' ? file : join(rel.startsWith('docs') ? '.' : DOCS, rel);
        if (!cache.has(path)) {
          if (!existsSync(path)) {
            problems.push({ file, line: i + 1, anchor, why: `链接的文件不存在：${target}` });
            continue;
          }
          cache.set(path, anchorsOf(path));
        }
        set = cache.get(path);
      }
      if (!set.has(anchor)) {
        // 找几个最接近的候选，省得人去全文搜
        const key = anchor.slice(0, 10);
        const near = [...set].filter((a) => a.startsWith(key) || a.includes(key)).slice(0, 3);
        problems.push({
          file,
          line: i + 1,
          anchor,
          why: near.length ? `没有这个锚点；最接近的：${near.map((n) => '#' + n).join(' 、 ')}` : '没有这个锚点',
        });
      }
    }
  }
}

console.log(`  扫了 ${files.length} 份文档，站内锚点 ${checked} 处`);

for (const p of problems) {
  console.log(`  ✗ ${relative(root, p.file)}:${p.line}  #${p.anchor}`);
  console.log(`      ${p.why}`);
}

if (problems.length === 0) {
  console.log('  ✓ 站内锚点全部指向真实标题');
  process.exit(0);
}
console.error('');
console.error(`✗ ${problems.length} 个死锚点 —— 点进去是空气，读的人会先怀疑自己。`);
console.error('  修：把链接改成候选里那个真实锚点（或删掉这个链接）。');
console.error('');
process.exit(1);
