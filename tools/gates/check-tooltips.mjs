/*
 * 门禁：**界面里不许有悬停提示**（用户 2026-09-26：「去掉所有悬停显示描述」）。
 *
 * ## 为什么要有这条
 *
 *   这一轮把 60 多处 `title=`（HTML 的悬停气泡）全部删掉了。删的过程本身就说明
 *   "靠人眼守不住"：
 *     · 第一遍按"排除组件名单"删（黑名单）⇒ 漏掉的 `EmptyState` 的**可见标题**
 *       被当成悬停提示删了，`tsc` 才报出来；
 *     · 第二遍按小写 HTML 标签白名单删 ⇒ `Button`（`...rest` 摊到 `<button>` 上）
 *       一个都没删到，dry-run 报 0 处而**看起来像成功**。
 *   两次都是"删错了"或"没删全"，而两次都不会自己变红。
 *   ⇒ 规矩必须变成一条会红的检查，这才是这个仓库一贯的做法。
 *
 * ## 判据
 *
 *   只有**会透传到 DOM 元素**的 `title` 才算悬停提示：
 *     · 小写 HTML 标签（`div` / `span` / `button` / `img` / `svg` …）；
 *     · 把 `...rest` 摊到真元素上的组件（`Button` / `Input` / `Select` / `Textarea`）。
 *   `Note` / `EmptyState` / `Modal` / `confirm` 的 `title` 是**画在界面上的标题**，
 *   不在此列 —— 白名单只列 DOM 侧，新组件不会被误伤。
 *
 * ## 判据自己也会错（所以它自带自检）
 *
 *   扫描器是"从 `<Tag` 扫到标签结束的 `>`，配对括号/字符串/模板串/注释"——
 *   第一版用全局括号计数，在真文件里计数会漂，`Button` 上的 title 一处都找不到。
 *   所以下面 `SELF_TEST` 拿 7 个人工样本喂它（含跨行标签、模板串插值、
 *   注释里的假标签），自检不过就直接红 —— "量法错了"必须先于"量出结果"被发现。
 *
 * 用法：node tools/gates/check-tooltips.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 悬停提示会落到的**小写 HTML 标签** */
const HTML_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'button', 'canvas', 'code', 'dd', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'i', 'iframe', 'img', 'input', 'label', 'li', 'main',
  'nav', 'ol', 'option', 'p', 'pre', 'section', 'select', 'small', 'source', 'span',
  'strong', 'summary', 'svg', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'tr', 'ul', 'video',
]);

/** 把 `...rest` 摊到真元素上的组件（`title` 会变成悬停提示） */
const FORWARDING_COMPONENTS = new Set(['Button', 'Input', 'Select', 'Textarea']);

/** 注释区间（块注释与行注释）—— 注释里的 `title=` 不算悬停提示 */
function commentRegions(text) {
  const regions = [];
  let mode = 'code';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'line') {
      if (c === '\n') { regions.push([start, i]); mode = 'code'; }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { regions.push([start, i + 2]); mode = 'code'; i += 1; }
      continue;
    }
    if (mode === 'single') { if (c === '\\') { i += 1; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'double') { if (c === '\\') { i += 1; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'tick') {
      if (c === '\\') { i += 1; continue; }
      if (c === '`') { mode = 'code'; continue; }
      /* ★ 模板串里的 `${…}` 里可能有块注释（如 `${块注释 a}`），交回 code 处理 */
      if (c === '$' && n === '{') { mode = 'code'; i += 1; }
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; start = i; i += 1; continue; }
    if (c === '/' && n === '*') { mode = 'block'; start = i; i += 1; continue; }
    if (c === "'") { mode = 'single'; continue; }
    if (c === '"') { mode = 'double'; continue; }
    if (c === '`') { mode = 'tick'; continue; }
  }
  if (mode === 'line' || mode === 'block') regions.push([start, text.length]);
  return regions;
}

function inComment(regions, idx) {
  return regions.some(([a, b]) => idx >= a && idx < b);
}

/** 从 `<Tag` 扫到标签结束的 `>`；返回这个标签内所有 `title=` 的下标。 */
function scanTag(text, start) {
  const hits = [];
  let i = start + 1;
  const m = /^([A-Za-z][\w.]*)/.exec(text.slice(i));
  if (!m) return { hits, end: start + 1 };
  const tag = m[1];
  i += tag.length;
  /** 层栈：`expr` = 花括号表达式，`tick` = 模板串 */
  const stack = [];
  let mode = 'code';
  for (; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'single') { if (c === '\\') { i += 1; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'double') { if (c === '\\') { i += 1; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'tick') {
      if (c === '\\') { i += 1; continue; }
      if (c === '`') { mode = 'code'; stack.pop(); continue; }
      if (c === '$' && n === '{') { stack.push('expr'); mode = 'code'; i += 1; }
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i += 1; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i += 1; continue; }
    if (c === "'") { mode = 'single'; continue; }
    if (c === '"') { mode = 'double'; continue; }
    if (c === '`') { stack.push('tick'); mode = 'tick'; continue; }
    if (c === '{') { stack.push('expr'); continue; }
    if (c === '}') {
      stack.pop();
      mode = stack[stack.length - 1] === 'tick' ? 'tick' : 'code';
      continue;
    }
    /* ★ `>` 只在"不在任何括号/模板串里"时才算标签结束 —— 属性里的箭头函数靠这条 */
    if (stack.length === 0 && c === '>') return { hits, end: i + 1, tag };
    if (stack.length === 0 && text.startsWith('title=', i) && !/[\w$.-]/.test(text[i - 1] ?? '')) {
      hits.push(i);
    }
  }
  return { hits, end: text.length, tag };
}

/** 判据本体：给一份源码，返回所有悬停提示。 */
export function findHoverTitles(text) {
  const regions = commentRegions(text);
  const out = [];
  const seen = new Set();
  /*
   * ★ `<title>…</title>`（SVG 里那种）**也是**悬停提示 —— 鼠标停在图标上会弹出它。
   *   它不是"HTML 属性"，所以上面那两套名单都盖不到它，单独列一条。
   *   （文档标题 `index.html` 不在此列：那份文件不扫，它是标签页名字，不是悬停。）
   */
  const titleEl = /<title[\s>]/g;
  let tm;
  while ((tm = titleEl.exec(text))) {
    if (inComment(regions, tm.index)) continue;
    out.push({ index: tm.index, tag: 'title', line: text.slice(0, tm.index).split('\n').length });
  }
  const re = /<([A-Za-z][\w.]*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (inComment(regions, m.index)) continue;
    const { hits, end, tag } = scanTag(text, m.index);
    if (!HTML_TAGS.has(tag) && !FORWARDING_COMPONENTS.has(tag)) {
      re.lastIndex = Math.max(re.lastIndex, end);
      continue;
    }
    for (const h of hits) {
      if (seen.has(h) || inComment(regions, h)) continue;
      seen.add(h);
      out.push({ index: h, tag, line: text.slice(0, h).split('\n').length });
    }
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out.sort((a, b) => a.index - b.index);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/* ====================== 自检：量法必须先生效 ====================== */

const SELF_TEST = [
  ['<Button title="x">y</Button>', 1],
  ['<button title="x">y</button>', 1],
  ['<Note title="可见标题">y</Note>', 0],
  ['<EmptyState title="空" desc="d" />', 0],
  ['<Button\n  size="sm"\n  title="跨行"\n>\ny\n</Button>', 1],
  ["<button title={a ? `x ${b}` : undefined}>y</button>", 1],
  ['{/* <div title="注释里的假标签"> */}\n<Note title="真的标题" />', 0],
  ['<div className="a" title={`模板 ${x} 结束`}>y</div>', 1],
  /* ★ SVG 里的 <title> 子元素也是悬停提示 */
  ['<svg viewBox="0 0 24 24"><title>图标说明</title><path d="M0 0" /></svg>', 1],
];

function selfTest() {
  const bad = [];
  for (const [src, want] of SELF_TEST) {
    const got = findHoverTitles(src).length;
    if (got !== want) bad.push(`「${src.replace(/\n/g, '⏎')}」期望 ${want} 处、实得 ${got} 处`);
  }
  return bad;
}

const problems = selfTest();
if (problems.length) {
  console.error('\x1b[31m✗ 门禁自检没过 —— 是**量法**坏了，不是代码坏了：\x1b[0m');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

/* ====================== 正式检查 ====================== */

const offenders = [];
for (const file of walk(join(process.cwd(), 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const hit of findHoverTitles(text)) {
    offenders.push({ file: file.replace(/\\/g, '/').replace(process.cwd().replace(/\\/g, '/') + '/', ''), ...hit });
  }
}

if (offenders.length === 0) {
  console.log('✓ 没有悬停提示（`title=` 只出现在可见标题组件上）');
  process.exit(0);
}

console.error(`\x1b[31m✗ 发现 ${offenders.length} 处悬停提示 —— 用户要求"去掉所有悬停显示描述"：\x1b[0m`);
for (const o of offenders) console.error(`  · ${o.file}:${o.line}  <${o.tag}>`);
console.error(
  [
    '',
    '怎么改：',
    '  · 理由/说明 → 写成**看得见**的一行小字（如 `.field-hint` / `.res-hint`）；',
    '  · 纯装饰性的描述 → 直接删掉；',
    '  · 图标按钮的无障碍名字 → 用 `aria-label`（`SegmentOption.title` 只喂它），',
    '    它**不是**悬停提示。',
    '  · `Note` / `EmptyState` / `Modal` 的 `title` 是画在界面上的标题，不受影响。',
  ].join('\n'),
);
process.exit(1);
