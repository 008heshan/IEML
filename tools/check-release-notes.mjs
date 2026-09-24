#!/usr/bin/env node
/**
 * 检查「更新日志」的正文是否符合**用户定下的格式**。
 * ------------------------------------------------------------------
 * 格式来自用户 2026-09-24 的原话（见 `src/data/release-notes.ts` 文件头，那是必读篇目）：
 *
 *   每一版固定五段：新增了 / 修复了 / 优化了 / 删除了 / 修改了
 *   · 顺序就是显示顺序，**没有内容的段不写**（不是留一个空标题）；
 *   · **每条开头重复一遍类别词**（段标题写「修复了」，条目就写「修复了…」）；
 *   · 言简意赅：一条一件事、一句话说完，**不写括号里的解释**。
 *
 * 为什么要机器检查：这份文件是**用户向文案**，格式靠"记得"是守不住的 ——
 * 这个仓库已经吃过一次同类亏（更新说明只推了标题那一行，而三条断言全都成立，
 * 见 `tools/release/verify-manifest.mjs` 头部）。这里把"格式"变成会红的判据。
 *
 * 用法：
 *   node tools/check-release-notes.mjs                    # 查真实文件
 *   node tools/check-release-notes.mjs <另一个 .ts 路径>   # 自查用（喂坏样本，证明它会红）
 */
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const FILE = arg ? (isAbsolute(arg) ? arg : resolve(ROOT, arg)) : join(ROOT, 'src', 'data', 'release-notes.ts');

/** 五段 + 它们的**规范顺序**（顺序不一致 = 显示出来的顺序不一致，用户会看出来） */
const ORDER = ['新增了', '修复了', '优化了', '删除了', '修改了'];
/** 一条太长就不是"言简意赅"了；上限定得比现有最长条目宽一些，只拦明显的啰嗦 */
const MAX_ITEM = 80;

let text;
try {
  text = readFileSync(FILE, 'utf8');
} catch (e) {
  console.error(`✗ 读不到更新日志文件：${FILE}（${e.message}）`);
  process.exit(1);
}

/*
 * 轻量解析（与仓库里其它工具同一套路：不引 TS 运行时，按源码文本抽）。
 *
 * ★ 两个自己踩过的坑（写第一版时都撞了）：
 *   ① 条目里类别词后面**没有空格**（中文里没必要），第一版按 `title + ' '` 判 → 全红；
 *   ② 第一版把整份文件当成"一个版本"去判段落顺序 → 版本之间重复的段落被报成乱序。
 *      所以必须**按版本切开**再各自判顺序。
 */
const versions = text
  .split(/version:\s*'/)
  .slice(1)
  .map((chunk) => {
    const version = chunk.slice(0, chunk.indexOf("'"));
    const groups = [];
    const groupRe = /title:\s*'([^']+)'\s*,\s*items:\s*\[([\s\S]*?)\]/g;
    for (const m of chunk.matchAll(groupRe)) {
      groups.push({ title: m[1], items: [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]) });
    }
    return { version, groups };
  })
  .filter((v) => v.groups.length > 0);

const problems = [];
let itemCount = 0;

if (versions.length === 0) {
  problems.push('一个版本都没解析出来 —— 文件形状变了？（本检查按 version/title/items 的形状解析）');
}

for (const v of versions) {
  const seen = [];
  for (const g of v.groups) {
    /* ① 段名必须是那五个之一 */
    const idx = ORDER.indexOf(g.title);
    if (idx < 0) {
      problems.push(`[${v.version}] 段名不在五段之内：「${g.title}」（只允许 ${ORDER.join(' / ')}）`);
      continue;
    }
    /* ② 同一版本内顺序必须与规范顺序一致（允许跳段，不允许乱序） */
    if (seen.length && idx <= seen[seen.length - 1]) {
      const prev = ORDER[seen[seen.length - 1]];
      problems.push(`[${v.version}] 段落顺序不对：「${g.title}」出现在「${prev}」后面`);
    }
    seen.push(idx);

    /* ③ 每段至少一条（空的段应当整段不写） */
    if (g.items.length === 0) problems.push(`[${v.version}] 「${g.title}」是空段 —— 没有内容就别写这一段`);

    /* ④ 每条以本段类别词开头；⑤ 别太长；⑥ 别写括号里的解释 */
    for (const it of g.items) {
      itemCount += 1;
      if (!it.startsWith(g.title)) {
        problems.push(`[${v.version}]「${g.title}」里这条没有以类别词开头：${it.slice(0, 30)}…`);
      }
      if (it.length > MAX_ITEM) {
        problems.push(`[${v.version}] 这条太长了（${it.length} 字 > ${MAX_ITEM}）：${it.slice(0, 30)}…`);
      }
      if (it.includes('（') || it.includes('(')) {
        problems.push(`[${v.version}] 这条里有括号 —— 用户要的是"只说事，不写括号里的解释"：${it.slice(0, 30)}…`);
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ 更新日志格式不合规（${FILE}）：`);
  for (const p of problems) console.error(`    ${p}`);
  console.error('\n  格式见 src/data/release-notes.ts 文件头（五段 + 每条类别词 + 言简意赅 + 不写括号解释）。');
  process.exit(1);
}
console.log(`✓ 更新日志格式合规：${versions.length} 个版本 / ${itemCount} 条（五段名、顺序、类别词、长度都过了）`);
