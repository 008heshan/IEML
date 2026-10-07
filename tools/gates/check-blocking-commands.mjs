/*
 * 门禁：**Tauri 命令里不许把阻塞重活放在主线程上**。
 *
 * ## 为什么要有这条（用户 2026-10-08：「**删除版本的操作会使启动器变卡顿**」）
 *
 *   `delete_instance_files` / `delete_version_dir` 原来是 `pub fn`（**同步命令**），
 *   而 Tauri 的同步命令**跑在主线程**上。它们各干两件重活：
 *
 *     · `dir_size(&dir)` —— 递归遍历整棵目录树，每个文件一次 `metadata`。
 *       整合包目录实测有几千个文件 ⇒ **几万次系统调用**；
 *     · `trash::delete` / `remove_dir_all` —— 真的把几千个文件搬走/删掉。
 *
 *   ⇒ 主线程被占住的这几秒，界面**完全不动**。用户看到的就是"删除会卡顿"。
 *
 *   ★ 这个形状**靠人眼守不住**：`pub fn` 与 `pub async fn` 只差一个词，
 *     而阻塞调用写在里面完全合法、编译通过、单元测试也过 ——
 *     只有在真机上对着界面点一下才发现。
 *     ⇒ 与 `check-tooltips.mjs` / `check-spawn-silent.mjs` 同一条理由：
 *       规矩必须变成一条**会红的检查**。
 *
 * ## 判据
 *
 *   在 `src-tauri/src/**.rs` 里找 `#[tauri::command]` 之后那一个函数：
 *
 *     · 函数体里有阻塞重活，**并且把那段交给 `spawn_blocking` 了** ⇒ 过；
 *     · 函数体里有阻塞重活，**没有交给 `spawn_blocking`** ⇒ **红**；
 *     · 没有阻塞重活（只读一个小 JSON、拼个字符串）⇒ 过 ——
 *       那些真的不值得为它开后台线程。
 *
 *   ★★ **`pub async fn` 本身不算数**（这一点我第一版写错了，被自检当场抓到）：
 *     异步命令确实不在主线程，但它跑在 **tokio 的 worker 线程**上 ——
 *     而 worker 数量有限（默认等于核数）。在里面做阻塞调用会把 worker 占住，
 *     几个大删除就能把整个异步运行时堵死，那时**别的命令也会一起卡**。
 *     ⇒ 判据只认"有没有 `spawn_blocking`"（它给的是**专用于阻塞任务**的线程池，
 *       堵住它不影响别的命令）。这也是 `delete_instance_files` 实际采用的做法。
 *
 *   "阻塞重活"的判据是一张**具体**的表（不是"看起来重"）：
 *   `dir_size` / `remove_dir_all` / `trash::delete` / `copy_dir`……
 *   它们共同点是**耗时与目录内容成正比**。
 *   ★ 表是白名单式的：**新增重活要显式加进来**，而不是靠正则去猜
 *     （猜不准的判据会让人把门禁当成噪音，然后绕过它）。
 *
 *   ## 逃生口
 *
 *   确实必须在命令里同步做重活的（很少见），在那条语句附近写
 *       // block-ok: <为什么这里必须同步做>
 *   ★ 理由写在**这一处旁边**，不许整文件关掉。
 *
 * ## 判据自己也会错（自带自检）
 *
 *   "函数体到哪结束"是靠**花括号配对**数的，而注释与字符串里的 `{}` 会把它带偏。
 *   所以下面 `SELF_TEST` 拿人工样本把这条量法钉住 —— 自检不过就直接红：
 *   **"量法错了"必须先于"量出结果"被发现**。
 *
 * 用法：
 *   node tools/gates/check-blocking-commands.mjs          # 查真实仓库
 *   node tools/gates/check-blocking-commands.mjs --list    # 只列出所有命令
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src-tauri', 'src');

/**
 * 阻塞重活的判据表（**白名单式**：新增要显式加，见文件头）。
 * 每项是 [正则, 说明]。
 */
const HEAVY = [
  [/\bdir_size\s*\(/, '递归统计目录大小（每个文件一次 metadata）'],
  [/remove_dir_all\s*\(/, '递归删除整棵目录树'],
  [/trash::delete\s*\(/, '把整棵目录树搬进回收站'],
  [/copy_dir\w*\s*\(/, '递归复制整棵目录树'],
];

/** 豁免标记 */
const ESCAPE = 'block-ok:';

/** 递归收集 .rs 文件 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/**
 * 去掉注释与字符串字面量，只留代码骨架。
 *
 * ★ 为什么必须去：`dir_size` 这几个词**大量出现在注释里**
 *   （我上面那段说明就写了四五次）——不去掉的话，每条注释都会命中。
 *
 * ★★ 2026-10-08：这一版修了一个**自己造成的假阳性**。
 *   上一版在遇到 `"` 时"跳过整个字符串"，但**忘了把控制权交回去**
 *   —— `"` 那一行落进 `out` 之后，字符串**里面**的 `{}` 也一起留了下来。
 *   而 Rust 里到处都是 `format!("{}", x)`：实测 `commands_real.rs`
 *   去注释后 `{`=1215 / `}`=1212（差 3）⇒ **花括号配对整个漂掉**，
 *   于是 `#[tauri::command]` 后面"下一个 fn"被找到几百行之外，
 *   报出来的"命令签名"是一行结构体字段。
 *
 *   ⇒ 现在把字符串**整段丢掉**，并且自检里钉了一条带 `"{}"` 的样本。
 *     （真正的教训：**量法自己有 bug 时，报出来的错看起来像被测代码的问题**。）
 */
function stripCommentsAndStrings(text) {
  /*
   * ★★ 2026-10-08：这一版改成**逐字符、行数保持不变**的写法
   *   （注释/字符串里的非换行字符一律替换成**空格**）。
   *
   *   上一版是"丢掉整段、只补一个 `\n`"，于是**行数与原文对不上** ——
   *   `signature: rawLines[sig]` 直接读到 undefined 崩了。
   *   ⇒ 判据的坐标必须与它要报告的东西**同一个坐标系**：
   *     保行数之后，`lines[i]` 与 `rawLines[i]` 永远是同一行。
   *
   *   ★ 真正的教训（连着两次都在这一个函数上）：
   *     **量法自己有 bug 时，报出来的错看起来像被测代码的问题。**
   *     所以自检里既有 `format!("{}")` 那种花括号样本，也有行号对齐的要求。
   */
  const chars = [...text];
  const out = new Array(chars.length);
  let i = 0;
  const n = chars.length;
  const blank = (k) => (chars[k] === '\n' ? '\n' : chars[k] === '\r' ? '\r' : ' ');
  while (i < n) {
    const two = chars[i] + (chars[i + 1] ?? '');
    if (two === '//') {
      while (i < n && chars[i] !== '\n') { out[i] = blank(i); i++; }
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      out[i] = blank(i); out[i + 1] = blank(i + 1); i += 2;
      while (i < n && depth > 0) {
        if (chars[i] + (chars[i + 1] ?? '') === '/*') { depth++; out[i] = blank(i); out[i + 1] = blank(i + 1); i += 2; continue; }
        if (chars[i] + (chars[i + 1] ?? '') === '*/') { depth--; out[i] = blank(i); out[i + 1] = blank(i + 1); i += 2; continue; }
        out[i] = blank(i); i++;
      }
      continue;
    }
    if (chars[i] === '"') {
      out[i] = ' '; i++;
      while (i < n && chars[i] !== '"') {
        if (chars[i] === '\\') { out[i] = blank(i); i++; }
        if (i < n) { out[i] = blank(i); i++; }
      }
      if (i < n) { out[i] = ' '; i++; }
      continue;
    }
    out[i] = chars[i];
    i++;
  }
  return out.join('');
}

/**
 * 找出一份源码里所有 `#[tauri::command]` 命令，返回
 * `[{ line, signature, async, heavy: [说明] }]`。
 */
function findCommands(text) {
  const code = stripCommentsAndStrings(text);
  const lines = code.split(/\r?\n/);
  const rawLines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('#[tauri::command]')) continue;
    // 往下找那一个 fn 的签名（属性与签名之间可能隔着别的属性行）
    /*
     * ★★ 必须有**边界**。实测抓到过假阳性：文件里更早处一个不平衡的花括号
     *   把配对带偏，于是 `#[tauri::command]` 后面"下一个 fn"落在**很远的地方**
     *   （某个结构体之后），审的根本不是这条命令。
     *
     *   ⇒ 只在这几行之内找签名；一撞到 `}`（属性块结束）、另一个
     *     `#[tauri::command]`、或 `struct`/`enum`/`impl` 就放弃这一处。
     */
    let sig = i;
    const LIMIT = 12;
    let gaveUp = false;
    while (sig < lines.length && sig - i <= LIMIT) {
      if (/\bfn\s+\w+\s*\(/.test(lines[sig])) break;
      if (sig > i && /^\s*}/.test(lines[sig])) { gaveUp = true; break; }
      if (/\b(struct|enum|impl|trait)\b/.test(lines[sig])) { gaveUp = true; break; }
      sig++;
    }
    if (gaveUp || sig >= lines.length || sig - i > LIMIT) continue;
    /*
     * ★★ 必须确认这一行**真的是一个 fn 签名** —— 实测抓到过假阳性：
     *   某个 `#[tauri::command]` 后面接口/结构体的花括号配对一旦被带偏，
     *   配对结果会落在结构体字段上（`pub include_files: u64,`），
     *   于是那一行被当成"命令签名"审了一遍。
     *
     *   ⇒ 只认真的 `fn`（`fn` / `pub fn` / `pub async fn` 都行，
     *     但**行首必须是 fn 或修饰符**，不能是字段名）。
     */
    if (!/^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+\s*[(<]/.test(lines[sig])) {
      continue;
    }
    // 从签名往后做花括号配对，取函数体
    let depth = 0;
    let started = false;
    let end = sig;
    for (let k = sig; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      if (started && depth <= 0) { end = k; break; }
    }
    const body = lines.slice(sig, end + 1).join('\n');
    const heavy = HEAVY.filter(([re]) => re.test(body)).map(([, why]) => why);
    // ★ 判据只认 `spawn_blocking`（见文件头：async 本身不算数）
    const offloaded = /spawn_blocking\s*\(/.test(body);
    // 豁免：看**原始文本**里、函数体范围内有没有 block-ok
    const escaped = rawLines
      .slice(sig, end + 1)
      .some((l) => l.includes(ESCAPE));
    out.push({
      line: sig + 1,
      signature: rawLines[sig].trim(),
      async: /async\s+fn/.test(lines[sig]),
      heavy: offloaded || escaped ? [] : heavy,
    });
  }
  return out;
}

/* ====================== 自检（量法本身） ====================== */

const SELF_TEST = [
  // [源码, 期望"有问题"的命令数, 这条样本在测什么]
  [
    '#[tauri::command]\npub fn a() {\n  let x = dir_size(d);\n}',
    1,
    '同步 + 重活 + 没交后台 ⇒ 必须红',
  ],
  [
    '#[tauri::command]\npub async fn a() {\n  let x = dir_size(d);\n}',
    1,
    '★ **`async` 不算数**：异步里的阻塞调用会占住 tokio worker（我第一版判据在这里错了）',
  ],
  [
    '#[tauri::command]\npub async fn a() {\n  spawn_blocking(move || dir_size(d)).await\n}',
    0,
    '交给 spawn_blocking ⇒ 放过（这正是 `delete_instance_files` 的形状）',
  ],
  [
    '#[tauri::command]\npub fn a() {\n  let x = read(path);\n}',
    0,
    '没有阻塞重活 ⇒ 放过',
  ],
  [
    '#[tauri::command]\npub fn a() {\n  // dir_size 只是注释里提到\n  let x = 1;\n}',
    0,
    '★ 注释里的重活名字**不算** —— 不去注释的话每条说明都会误报',
  ],
  [
    '#[tauri::command]\npub fn a() {\n  // block-ok: 目录很小，同步做更简单\n  let x = dir_size(d);\n}',
    0,
    '写了理由就豁免',
  ],
  [
    '#[tauri::command]\npub fn a() {\n  if x { let s = "}"; }\n  let y = dir_size(d);\n}',
    1,
    '★ 字符串里的花括号不许把"函数体到哪结束"带偏',
  ],
  [
    '#[tauri::command]\npub async fn a() {\n  let m = format!("{}", n);\n}\n' + '// 填充\n'.repeat(40) +
      'pub struct S {\n  pub f: u64,\n}\n',
    0,
    '★★ `format!("{}")` 里的花括号必须被丢掉 —— 留着会让配对整个漂掉，' +
      '把几百行外的结构体字段当成"命令签名"（这就是实测那个假阳性）',
  ],
];

function selfTest() {
  const bad = [];
  for (const [src, want, why] of SELF_TEST) {
    const got = findCommands(src).filter((c) => c.heavy.length > 0).length;
    if (got !== want) bad.push(`${why}：期望 ${want} 处、实得 ${got} 处`);
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
let total = 0;
const files = [];
try {
  files.push(...walk(SRC));
} catch {
  console.error(`\x1b[31m✗ 找不到源码目录：${SRC}\x1b[0m`);
  process.exit(1);
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const cmds = findCommands(text);
  total += cmds.length;
  for (const c of cmds) {
    if (c.heavy.length > 0) {
      offenders.push({ file: relative(ROOT, file).replace(/\\/g, '/'), ...c });
    }
  }
}

if (process.argv.includes('--list')) {
  console.log(`共 ${total} 个 tauri 命令，其中 ${offenders.length} 个含未交后台的阻塞重活`);
  for (const o of offenders) console.log(`  ${o.file}:${o.line}  ${o.signature}`);
  process.exit(0);
}

if (offenders.length === 0) {
  console.log(
    `✓ 命令里的阻塞重活都交给了后台线程（扫了 ${files.length} 个 .rs，${total} 个 tauri 命令）`,
  );
  process.exit(0);
}

console.error(
  `\x1b[31m✗ 发现 ${offenders.length} 个 tauri 命令在**没交给后台线程**的情况下做阻塞重活 —— 界面会卡住：\x1b[0m`,
);
for (const o of offenders) {
  console.error(`  · ${o.file}:${o.line}  ${o.signature}`);
  for (const h of o.heavy) console.error(`      重活：${h}`);
}
console.error(
  [
    '',
    '怎么改（按推荐顺序）：',
    '  ① 命令改成 `pub async fn`，并把阻塞那一段交给后台线程：',
    '       tauri::async_runtime::spawn_blocking(move || { … }).await',
    '     ★ 只改成 async 还不够：阻塞调用会占住 tokio worker，',
    '       几个大删除就能把整个异步运行时堵住（那时别的命令也会一起卡）。',
    '  ② 确实必须同步做的（很少见）：在这一处旁边写',
    '       // block-ok: <为什么这里必须同步做>',
    '     ★ 不许整文件豁免 —— 那样这条门禁就白设了。',
  ].join('\n'),
);
process.exit(1);
