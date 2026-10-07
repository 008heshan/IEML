/*
 * 门禁：**每一个子进程都要静默启动**（不许弹控制台窗口）。
 *
 * ## 为什么要有这条
 *
 *   `platform.rs` 里早就写了规矩：
 *
 *     「所以这里提供**唯一**的抑制入口。新增任何创建子进程的代码都应该用它，
 *       不要再各处手写 `0x0800_0000` —— 那个数字抄错一次就是一个新黑框，
 *       而且不会有任何报错提示你。」
 *
 *   —— 但这句话**是纸面约定，没有人强制**。
 *
 *   用户为此抱怨过两次：
 *     · 「安装 Forge 调出来个啥也没有的 cmd 是何意味」（那条注释就是为它写的）；
 *     · 「**不要再给我弹 cmd 了**」（2026-10-07，构建期间满屏闪窗）。
 *   而两次都没有任何检查替我们拦住"新加的那处忘了静默"。
 *
 *   ⇒ 规矩必须变成一条**会红的检查**，这才是这个仓库一贯的做法
 *     （见 `check-tooltips.mjs` 开头那段同样的推理）。
 *
 * ## 判据
 *
 *   在 `src-tauri/src/**.rs` 里找 `Command::new(`，然后看它所在的那条语句
 *   附近（前后 10 行）有没有 `hide_console` / `hide_console_async`。
 *
 *   · 有 ⇒ 过；
 *   · 没有 ⇒ **红**，并指名文件与行号，让加代码的人当场看到。
 *
 *   ## 逃生口（有意为之，且必须逐处写）
 *
 *   确实**需要**弹窗的（比如将来加"在这里打开终端"那种功能），在**同一个
 *   语句附近**写一行 `// spawn-ok: <理由>` 即可豁免。
 *   ★ 理由必须写在**这一处旁边**，不许整文件关掉 —— 那样等于没有门禁。
 *
 * ## 判据自己也会错（所以它自带自检）
 *
 *   "附近 10 行"这个窗口是**启发式**的：窗口太小会漏（`hide_console` 写在
 *   构造函数之前好几行的情况真的存在，见 `commands_real.rs` 那条带大段注释的），
 *   太大会误报。所以下面 `SELF_TEST` 拿人工样本把这条量法钉住 ——
 *   自检不过就直接红：**"量法错了"必须先于"量出结果"被发现**。
 *
 * 用法：
 *   node tools/gates/check-spawn-silent.mjs          # 查真实仓库
 *   node tools/gates/check-spawn-silent.mjs --list    # 只列出所有 spawn 点
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src-tauri', 'src');

/** 前后各看多少行（见文件头"判据自己也会错"那段） */
const WINDOW = 10;

/** 抑制入口的两个名字（`std::process::Command` 与 `tokio::process::Command` 各一个） */
const SUPPRESSORS = ['hide_console', 'hide_console_async'];

/** 豁免标记 */
const ESCAPE = 'spawn-ok:';

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
 * 找出一份源码里所有**没有静默**的 `Command::new`。
 * 返回 `[{ line, text }]`（line 是 1 基行号）。
 */
function findLoudSpawns(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('Command::new(')) continue;
    const from = Math.max(0, i - WINDOW);
    const to = Math.min(lines.length - 1, i + WINDOW);
    const near = lines.slice(from, to + 1).join('\n');
    if (SUPPRESSORS.some((s) => near.includes(s))) continue;
    if (near.includes(ESCAPE)) continue;
    hits.push({ line: i + 1, text: lines[i].trim() });
  }
  return hits;
}

/* ====================== 自检（量法本身） ====================== */

const SELF_TEST = [
  // [源码, 期望命中的"没静默"处数, 这条样本在测什么]
  ['let mut c = Command::new("cmd");\nhide_console(&mut c);', 0, '紧跟其后就静默 —— 要放过'],
  ['hide_console(&mut c);\nlet mut c = Command::new("cmd");', 0, '写在前面也算（真仓库里有这种形状）'],
  ['let mut c = Command::new("cmd");', 1, '一处都没有 —— 必须红'],
  ['let mut c = Command::new("taskkill");\n// 别的注释\nlet x = 1;', 1, '附近有普通注释不算豁免'],
  ['// spawn-ok: 用户要求在这里打开终端\nlet mut c = Command::new("cmd");', 0, '写了理由就豁免'],
  [
    'let a = Command::new("a");\nhide_console(&mut a);\n' + '\n'.repeat(30) + 'let b = Command::new("b");',
    1,
    '窗口是有边界的：隔了 30 行的另一处**不该**被上一处的 hide_console 救掉',
  ],
];

function selfTest() {
  const bad = [];
  for (const [src, want, why] of SELF_TEST) {
    const got = findLoudSpawns(src).length;
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

const loud = [];
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
  total += text.split(/\r?\n/).filter((l) => l.includes('Command::new(')).length;
  for (const hit of findLoudSpawns(text)) {
    loud.push({ file: relative(ROOT, file).replace(/\\/g, '/'), ...hit });
  }
}

if (process.argv.includes('--list')) {
  console.log(`共 ${total} 处 Command::new，其中 ${loud.length} 处没静默`);
  for (const o of loud) console.log(`  ${o.file}:${o.line}  ${o.text}`);
  process.exit(0);
}

if (loud.length === 0) {
  console.log(
    `✓ 子进程都会静默启动（扫了 ${files.length} 个 .rs，${total} 处 Command::new 都在附近调了 hide_console）`,
  );
  process.exit(0);
}

console.error(
  `\x1b[31m✗ 发现 ${loud.length} 处子进程**没有静默** —— Windows 上会弹出一个控制台窗口：\x1b[0m`,
);
for (const o of loud) console.error(`  · ${o.file}:${o.line}  ${o.text}`);
console.error(
  [
    '',
    '怎么改：',
    '  · `std::process::Command`  → `crate::platform::hide_console(&mut cmd);`',
    '  · `tokio::process::Command` → `crate::platform::hide_console_async(&mut cmd);`',
    '  两者都只是加上 `CREATE_NO_WINDOW`，对程序行为没有别的影响。',
    '',
    '  确实需要弹窗的（很少见）：在**这一处旁边**写一行',
    '      // spawn-ok: <为什么这里必须弹窗>',
    '  ★ 不许整文件豁免 —— 那样这条门禁就白设了。',
  ].join('\n'),
);
process.exit(1);
