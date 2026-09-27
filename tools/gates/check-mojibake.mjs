#!/usr/bin/env node
/**
 * 源码里**有没有被写坏的中文**（乱码检测）。
 * ------------------------------------------------------------------
 * ## 为什么要有这道门禁
 *
 *   这个仓库里已经**栽过两次**同一件事：用 PowerShell 的
 *   `Get-Content -Raw | ... | Set-Content -Encoding utf8` 去改一个带中文的源文件。
 *   Windows PowerShell 5.1 的 `Get-Content` 默认按 **ANSI（简体中文机器上是 GBK）**
 *   解码，而文件其实是 **UTF-8**：于是"读进来"的那一刻字符就已经错了，
 *   写回去只是把错误固化 —— 文件从此变成一串以 U+92A5 / U+951B / U+9428 开头
 *   的怪字（下面 `MARKS` 里就是它们本身）。
 *
 *   ★ 两次都是**事后才发现**的：一次靠人眼，一次靠 grep 输出看着不对。
 *     这不是"小心一点"能解决的 —— 它没有报错、没有编译失败（Rust 里那堆乱码
 *     仍然是合法的标识符与字符串），只有在用户界面上才会露出来。
 *
 * ## 判据（**只看特征字符，不猜编码**）
 *
 *   把 UTF-8 的字节按 GBK 解码，得到的那批字**几乎只可能**出现在这种事故里：
 *   它们集中在 `MARKS` 那二十来个字上，正常中文技术文档里出现它们的概率
 *   可以当作 0。
 *
 *   所以判据是：**文件里出现任意一个特征字 → 红**。
 *   反过来，"正常的中文"一个都不会命中（这条由自测里的正样本钉住）。
 *
 * ## 假阳性怎么办
 *
 *   真要写这些字（例如把这道门禁的说明写进文档里），在**同一行**加 `mojibake-ok`
 *   即可豁免 —— 但豁免必须**逐行**写，不许整文件关掉：那样等于没有门禁。
 *
 * 用法：
 *   node tools/gates/check-mojibake.mjs            # 查真实仓库
 *   node tools/gates/check-mojibake.mjs <目录>      # 自查（喂坏样本，证明它会红）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ROOT = process.argv[2] ? resolve(ROOT, process.argv[2]) : ROOT;

/**
 * "UTF-8 被当成 GBK 读"之后的**候选特征字** —— 算出来的，不是猜的。
 *
 * ## 为什么要算
 *
 *   第一版是手写一张"常见乱码字"表（鈥 锛 鐨 涓 …）。自测立刻打脸：
 *   拿 `"好了"` 的乱码 `"濂戒簡"` 喂进去，**一个字都没命中** ——
 *   门禁照绿。一张只有常见字的表会给"已经守住"的错觉，而它守不住的东西
 *   恰恰是最常出现的字。
 *
 * ## 怎么算
 *
 *   中文在 UTF-8 里是**三字节** `E4..E9 | 80..BF | 80..BF`。
 *   按 GBK 解时前两字节先配成一个字，第三字节又当下一对的首字节 ——
 *   所以乱码串里**至少一半**的字符来自"`E4..E9` + `80..BF`"这两字节的组合。
 *   把这两个字节的所有 384 种组合交给 GBK 解码，得到的字就是**这一段的完整集合**。
 *
 * ## ★ 但这一张表**只能当候选**（同一张表第二次打脸）
 *
 *   拿它直接判红，`CHANGELOG.md` 立刻报出 **213 行**"乱码"，全都是
 *   「浏」（浏览的浏）、「氓」这类**正正经经的中文**：因为 (E6 B5) 这个字节对
 *   既可能是「流」的前两字节，也是 GBK 里的「浏」。
 *   一张会冤枉正常文件的表，最后一定会被人关掉 —— 那等于没有门禁。
 *
 *   所以真正的判据是**能不能还原**（见 [`decodeAsDoubleEncodedUtf8`]）：
 *   乱码是"UTF-8 的字节被当成 GBK 解"的**可逆**结果，正常中文不是。
 *   候选表只用来"值得试一下"。
 */
function derivedMarks() {
  const marks = new Set();
  let dec;
  try {
    dec = new TextDecoder('gbk', { fatal: false, ignoreBOM: true });
  } catch {
    return null; // 本机 Node 没有 ICU 里的 GBK 表 → 由调用方如实说明
  }
  for (let b1 = 0xe4; b1 <= 0xe9; b1++) {
    for (let b2 = 0x80; b2 <= 0xbf; b2++) {
      // `stream: false` 会补齐尾部：两个字节正好构成一个 GBK 字
      const s = dec.decode(new Uint8Array([b1, b2]));
      if (s.length === 1 && s.codePointAt(0) > 0x2e80) marks.add(s);
    }
  }
  return marks.size > 100 ? marks : null;
}

/**
 * 算不出来时的**兜底**表（ICU 缺失的老 Node）。
 *
 * ★ 兜底是"少守一点"，这点必须**当场说出来**（见结尾那行提示）：
 *   悄悄换一张小表继续报绿，等于把门禁变成一句话术。
 */
const FALLBACK_MARKS = '鈥锛鐨涓浣鏄鍜鎴鎵鍦璁缁鍒鏂浠鐩褰鐢鈽閿欒繖涓€鐪嬭繃鏉ヤ簡'; // mojibake-ok

const MARK_SET = derivedMarks() ?? new Set([...FALLBACK_MARKS]);
const MARKS_DERIVED = MARK_SET.size > 100;

/**
 * GBK 的**反向表**（字 → 两个字节）—— 用来把一段文本"按 GBK 塞回字节"。
 *
 * 建成一次（约 2.4 万次解码）。`TextDecoder` 只有解码方向，所以反向表得自己攒 ——
 * 这比引一个 iconv 依赖划算：门禁不该为了它多背一个包。
 */
function gbkEncoder() {
  const map = new Map();
  let dec;
  try {
    dec = new TextDecoder('gbk', { fatal: false, ignoreBOM: true });
  } catch {
    return null;
  }
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
      if (b2 === 0x7f) continue;
      const s = dec.decode(new Uint8Array([b1, b2]));
      if (s.length === 1 && s.codePointAt(0) !== 0xfffd && !map.has(s)) {
        map.set(s, [b1, b2]);
      }
    }
  }
  return map.size > 10000 ? map : null;
}

const GBK_ENC = gbkEncoder();

/**
 * 一段字节解出来**像中文**吗（像就返回它，不像返回 `null`）。
 *
 * ★ 为什么要留一个"尾巴被吃掉"的口子：GBK 的一个字是**两**字节，而 UTF-8
 *   的一个中文是**三**字节 —— 于是乱码串的最后**半个字**会去咬后面那个 ASCII
 *   字符（`世` 的第三个字节 `8C` 咬住了结尾的 `"`）。0x22 不是合法 GBK 尾字节
 *   ⇒ 那半个字倒推不回去，严格解就会失败。
 *
 *   ⇒ 判据放宽成"**除了最尾巴，中间不许有解不开的地方**"。放这一点是为了不漏报
 *     （乱码后面常常紧跟标点或引号），而"中间不许有替换符 + 至少两个字 +
 *     不能有控制符/私用区"三条把精度守住。
 */
function looksLikeRecoveredChinese(bytes) {
  const junk = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ue000-\uf8ff]/;
  let back;
  let truncated = false;
  try {
    back = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    back = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
    truncated = true;
  }
  if (truncated) {
    // 只在"末尾那一个字符解不出"时接受；中间解不出说明这不是同一种坏法
    const trimmed = back.replace(/\ufffd+$/, '');
    if (trimmed === '' || trimmed.includes('\ufffd')) return null;
    back = trimmed;
  }
  if (junk.test(back)) return null;
  const cjk = [...back].filter((c) => {
    const n = c.codePointAt(0);
    return n >= 0x3400 && n <= 0x9fff;
  }).length;
  return { text: truncated ? `${back}…` : back, cjk };
}

/**
 * ★★ **真正的判据**：这一行是不是"UTF-8 字节被当成 GBK 读过一遍"。
 *
 *   做法就是**把这一步倒回去**：按 GBK 把每个字塞回字节 → 用 UTF-8 解一次。
 *   * 乱码：倒回去正好得到原来那串中文（`濂戒簡` → `好了`）→ **解得开**；
 *   * 正常中文：GBK 字节恰好也是合法 UTF-8 的概率极低，而且即使侥幸解开，
 *     得到的也是一串不成话的东西 —— 所以还要它**确实像中文**。
 *
 *   返回解出来的那段中文（用于打印给用户看），不是乱码则返回 `null`。
 *
 *   ★ U+FFFD 要**当成"这里丢了一个字节"**而不是"验不了"：
 *     真事故里它一定会出现 —— 被 GBK 读坏的中文后面紧跟一个 ASCII 标点时，
 *     GBK 解码器对那半个字给的就是 U+FFFD，而 PowerShell 会把它**原样写回文件**。
 *     所以按 U+FFFD 把这一行切成几段，每段各自倒推再拼起来（错位只影响那一个字节）。
 *     第一版把"含 U+FFFD"直接当成验不了 ⇒ 一条最普通的
 *     `let s = "好了";` 的乱码就漏掉了（自测抓出来的）。
 */
function decodeAsDoubleEncodedUtf8(line) {
  if (!GBK_ENC) return null;
  const pieces = [];
  let cjk = 0;

  for (const segment of line.split('\ufffd')) {
    if (segment === '') continue;
    const bytes = [];
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) {
        bytes.push(cp);
        continue;
      }
      const pair = GBK_ENC.get(ch);
      if (!pair) return null; // GBK 表里没有它（emoji 等）⇒ 这一行验证不了
      bytes.push(pair[0], pair[1]);
    }
    const got = looksLikeRecoveredChinese(bytes);
    if (got === null) return null;
    cjk += got.cjk;
    pieces.push(got.text);
  }

  if (cjk < 2) return null; // 至少得验出两个字来，否则不足以说是"中文被读坏了"
  return pieces.join('□'); // □ = 那半个倒推不回来的字（如实标出来）
}

/** 一行里有多少个"候选特征字"（只用来说明"值不值得验"，不用于判红） */
function markCount(line) {
  let n = 0;
  for (const ch of line) if (MARK_SET.has(ch)) n++;
  return n;
}

/** 只看这些后缀（源码 / 文档 / 脚本）；别的一律不碰 */
const EXTS = [
  '.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html',
  '.yml', '.yaml', '.toml', '.ps1', '.txt',
];

/**
 * 不扫的目录。
 *
 * ★ `.workbuddy` 在这里：它是**本机的笔记**（不进仓库、用户看不到），
 *   而它恰恰**如实记着**那次事故的原样输出 —— 扫它只会年年报同一处旧账。
 *   门禁要守的是**发出去的东西**（源码 / 文档 / 脚本），不是本地草稿。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'target', '.git', 'dist', 'build', '.pnpm-store', 'tmp',
  'gen', 'coverage', '.vite', '.workbuddy',
]);

/**
 * 一个文件：找出**确实是乱码**的行。
 *
 * 两道降噪，缺一不可（都是被真样本打出来的）：
 *   ① `MARK_SET` 里没有 → 连试都不试（正常文件 99% 的行在这里就过去了）；
 *   ② 试出来能还原成中文（[`decodeAsDoubleEncodedUtf8`]）才算 —— 「浏览」
 *      这种正经中文在①里会命中，在②里必然落空。
 */
function badLines(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('mojibake-ok')) continue;
    if (markCount(line) === 0) continue;
    const recovered = decodeAsDoubleEncodedUtf8(line);
    if (recovered === null) continue;
    hits.push({ line: i + 1, text: line.trim().slice(0, 100), recovered: recovered.slice(0, 100) });
  }
  return hits;
}

function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.toLowerCase().endsWith(x))) out.push(p);
  }
}

const files = [];
walk(SCAN_ROOT, files);

const problems = [];
for (const f of files) {
  let text;
  try {
    // ★ 去掉 BOM：本仓库的 `.ps1` **要求**带 BOM（另有一道门禁守着），
    //   而 BOM 在 GBK 表里没有对应 —— 不清掉的话这些文件一个都验不了。
    text = readFileSync(f, 'utf8').replace(/^\ufeff/, '');
  } catch {
    continue;
  }
  for (const h of badLines(text)) {
    problems.push(
      `${relative(ROOT, f)}:${h.line}\n        现在是：${h.text}\n        本该是：${h.recovered}`,
    );
  }
}

if (problems.length === 0) {
  console.log(
    `✓ 没有发现被写坏的中文（扫了 ${files.length} 个文本文件；` +
      `候选字 ${MARK_SET.size} 个${MARKS_DERIVED ? '（由 GBK 表算出）' : '（**兜底小表**）'}，` +
      `逐个用"塞回 GBK 再用 UTF-8 解"验过）`,
  );
  process.exit(0);
}
console.error('✗ 有文件的中文被写坏了（"UTF-8 的字节被当成 GBK 读过一遍"）：');
for (const p of problems.slice(0, 20)) console.error(`    ${p}`);
if (problems.length > 20) console.error(`    …… 还有 ${problems.length - 20} 处（另有 ${files.length} 个文件已扫）`);
console.error(
  '\n  改法：**不要**用 PowerShell 的 Get-Content/Set-Content 改带中文的源文件' +
    '（5.1 默认按 ANSI 解码）。用编辑器 / 本仓库的读写工具，或 git checkout 拿回来。',
);
process.exit(1);
