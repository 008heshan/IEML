#!/usr/bin/env node
/**
 * 门禁：**`Backend` 接口只许有扁平的函数成员**（不许出现 `news: { … }` 这种子对象）。
 *
 * ## 为什么（2026-10-15 真机踩过）
 *
 *   `src/bridge/index.ts` 的 `getBackend()` 在 Tauri 下返回的是一个**懒加载 Proxy**：
 *
 *   ```ts
 *   get(_target, prop: string) {
 *     return (...args) => ensure().then((b) => b[prop].apply(b, args));
 *   }
 *   ```
 *
 *   它对**任何**属性都返回一个函数。于是：
 *
 *     · `api.newsSync()`     → 拿到的函数被调用 → 转发给真后端 → 正常；
 *     · `api.news.load()`    → `api.news` 是个**函数**，`.load` 是 `undefined`
 *                              ⇒ 运行时「api.news.load is not a function」。
 *
 *   ★ 而 `tsc` 一个字都不说：`Backend` 里的类型声明写着 `news` 是个对象，
 *     代理却被断言成 `Backend` —— **类型在这里说了谎**。
 *     用户看到的是新闻页上那句"这次没能取到：… is not a function"。
 *
 *   ⇒ 判据就是这个文件：把 `src/bridge/types.ts` 里 `Backend` 接口的成员签出来，
 *     每一个都必须是**方法**（`名字(参数): 返回`），不许是属性（`名字: 类型`）。
 *
 * ## 为什么是静态判据而不是运行时测试
 *
 *   运行时要真的实例化 Tauri 代理（要 WebView、要 IPC），而"哪一天有人又加了个子对象"
 *   恰恰是最不该靠跑一次界面才发现的事 —— 与 `check-tooltips.mjs` 同一条理由。
 *
 * 用法：
 *   node tools/gates/check-backend-flat.mjs          # 查真实仓库
 *   node tools/gates/check-backend-flat.mjs --list   # 顺便列出所有成员
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), 'src', 'bridge', 'types.ts');
const text = readFileSync(FILE, 'utf8');

/** 从 `export interface Backend {` 起，按花括号配对取出接口体 */
function backendBody(src) {
  /*
   * ★ 必须锚住名字的**边界**：`export interface BackendInfo {` 的开头
   *   也是 `export interface Backend` —— 第一版用 `indexOf` 就抓到了那一份，
   *   于是量出来的是 BackendInfo 的三个字段（`kind` / `dataDir` / `version`）。
   *   ★ 这正是这个仓库反复记的那条：**量法自己有 bug 时，报出来的错看起来像被测代码的问题**。
   */
  const m = /export\s+interface\s+Backend\s*\{/.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 量一份源码：返回 `{ members, bad }`（`bad` = 不是方法的顶层成员）。
 *
 * ★ 抽成纯函数是为了能自检 —— 见下面 `SELF_TEST`。
 */
function measure(src) {
  const body = backendBody(src);
  if (body === null) return null;
  /* 去掉注释，免得注释里的例子被当成成员 */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  /*
   * 成员判据：**行首缩进 <= 2** 的行才算 `Backend` 的顶层成员。
   *   子对象内部的写法缩进更深（`  news: {` 之后是 `    load()…`），
   *   它们正是这条规矩要拦住的东西，所以不能被单独当成成员。
   */
  const members = [];
  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > 2) continue;
    const isMethod = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\(/.test(line);
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:(]/.exec(line);
    if (!m) continue;
    /* ★ 一个 `news: {` 会把花括号**打开**，子成员缩进更深、不会进这张表；
       所以"是不是方法"这一条判据同时也认得出"这东西是个子对象"。 */
    members.push({ name: m[1], isMethod, line: line.trim() });
  }
  return { members, bad: members.filter((x) => !x.isMethod) };
}

/* ====================== 自检（量法本身） ====================== */

const SELF_TEST = [
  [
    'export interface Backend {\n  a(): void;\n  b(x: number): Promise<string>;\n}',
    0,
    '全是扁平方法 ⇒ 放过',
  ],
  [
    'export interface Backend {\n  a(): void;\n  news: {\n    load(): void;\n  };\n}',
    1,
    '★ 子对象 ⇒ 必须红（这就是真机上那句 news.load is not a function）',
  ],
  [
    'export interface BackendInfo {\n  kind: string;\n  dataDir: string;\n}\nexport interface Backend {\n  a(): void;\n}',
    0,
    '★★ `BackendInfo` 不许被当成 `Backend` —— 第一版就是这么错的' +
      '（量出来的是 BackendInfo 的三个字段，报的却是"Backend 有问题"）',
  ],
  [
    'export interface Backend {\n  // news: { load(): void } 只是注释里举例\n  a(): void;\n}',
    0,
    '注释里的子对象不算',
  ],
  ['export interface Other {\n  a(): void;\n}', null, '找不到 Backend ⇒ 返回 null（调用方据此报"量法坏了"）'],
];

const selfProblems = [];
for (const [src, want, why] of SELF_TEST) {
  const got = measure(src);
  const n = got === null ? null : got.bad.length;
  if (n !== want) selfProblems.push(`${why}：期望 ${want} 处、实得 ${n} 处`);
}
if (selfProblems.length) {
  console.error('\x1b[31m✗ 门禁自检没过 —— 是**量法**坏了，不是代码坏了：\x1b[0m');
  for (const p of selfProblems) console.error('  · ' + p);
  process.exit(1);
}

/* ====================== 正式检查 ====================== */

const measured = measure(text);
if (measured === null) {
  console.error('✗ 在 src/bridge/types.ts 里找不到 `export interface Backend { … }`');
  console.error('  （它被改名/搬家了？这道门禁要跟着改，别直接删。）');
  process.exit(1);
}
const { members, bad } = measured;

if (members.length === 0) {
  console.error('✗ 一个成员都没量到 —— 是**量法**坏了，不是代码坏了（接口体没配对成功？）');
  process.exit(1);
}

if (process.argv.includes('--list')) {
  console.log(`Backend 顶层成员 ${members.length} 个：`);
  for (const m of members) console.log(`  ${m.isMethod ? '方法' : '⚠ 属性'}  ${m.line}`);
  process.exit(0);
}

if (bad.length === 0) {
  console.log(
    `✓ Backend 的 ${members.length} 个成员都是扁平方法（Tauri 下的懒加载代理才能转发得动）`,
  );
  process.exit(0);
}

console.error('✗ Backend 里有**不是方法**的顶层成员 —— 它们在 Tauri 下会静默坏掉：');
for (const b of bad) console.error(`  · ${b.line}`);
console.error(
  [
    '',
    '为什么：`getBackend()` 在 Tauri 下是个懒加载 Proxy，它的 `get` **一律返回一个函数**。',
    '  · 扁平方法 `api.newsSync()`         → 正常转发；',
    '  · 子对象   `api.news.load()`        → `api.news` 是函数、`.load` 是 undefined',
    '                                        ⇒ 运行时「… is not a function」，而 tsc 不报。',
    '',
    '改法：把它改成扁平方法（`news: { load() }` → `newsLoad()`），',
    '      并让两套实现（tauri.ts / web.ts）与调用点一起改。',
  ].join('\n'),
);
process.exit(1);
