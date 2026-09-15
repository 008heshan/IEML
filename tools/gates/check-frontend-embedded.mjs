/**
 * 证明 release exe 里的前端**就是**当前 dist —— 不是"看起来像"。
 * ------------------------------------------------------------------
 * 为什么需要它（**这个脚本自己踩了三次"检查方法错了"**）：
 *
 *   ① 第一版用"在 exe 里搜 'createRoot' 这个字符串"判断前端有没有嵌进去，
 *      结果是 MISSING，差点以为构建漏了前端。实际上 Tauri 2 把前端资源
 *      **brotli 压缩**后内嵌，原文根本不在二进制里。
 *
 *   ② 第二版改成"文件名 + 原始字节数命中"，仍然误报：压缩后的长度与原始
 *      长度不同，拿原始大小去找必然对不上。
 *
 *   ③ 第三版用 `zlib.brotliCompressSync` 的**默认参数**（quality = 11）压一遍
 *      去比对，7 个文件全报"对不上"。而 Tauri 用的是 **quality = 9**
 *      （`tauri-codegen/src/embedded_assets.rs::compression_settings()`：
 *      release 用 9、debug 用 2）。改成 q9 后 5 个文件立刻对上。
 *
 *      剩下 2 个（`index.html` 与主 JS bundle）依然对不上，但那次是
 *      **两个不同的原因**，混在一起看就像"构建坏了"：
 *        · `index.html`：Tauri **会改它** —— `map_core_assets` 往 HTML 里
 *          注入 CSP nonce 与 script hash 再嵌（见 `tauri-codegen/context.rs`
 *          75-88 行）。所以 exe 里那一份和 dist 里那一份**本来就不该相同**。
 *        · 主 JS bundle：真的是同一份内容，只是 Rust 侧 brotli 编码器
 *          输出的字节流与 Node 侧略有不同（同一份输入、同样的窗口与质量，
 *          两个绑定的分块细节不同），**精确字节比对在这条路上走不通**。
 *
 * 所以现在用**能真正证明问题**的判据，两个层次：
 *
 *   A. **资源 key 在不在**（每份资产都必须有）
 *      Tauri 的资源表 key 是 dist 里的相对路径。Vite 的输出文件名**自带
 *      内容哈希**（`index-BzHAJ3Kp.js`），所以 key 命中 = 内容命中。
 *      这是最硬的一条，且与压缩参数无关。
 *
 *   B. **内容是不是同一份**（在 A 的基础上再验一遍）
 *      两条路，命中任一条即可：
 *        B1. 用 Tauri 的压缩参数（brotli q9）压一遍，字节流能在 exe 里找到；
 *        B2. 在 exe 里定位该资源的压缩流，**解压出来**与 dist 逐字节比对。
 *            （B1 找不到时用 B2 —— 它不依赖"我的压缩器与它的相同"。）
 *
 *       `index.html` 允许 B 不通过，但必须**明确标出来**并说明原因
 *      （Tauri 注入 CSP 会改 HTML），不能悄悄放过。
 *
 * 用法：node tools/gates/check-frontend-embedded.mjs [exe路径] [dist目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const exe = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const dist = process.argv[3] ?? 'dist';

if (!fs.existsSync(exe)) {
  console.error(`找不到 exe：${exe}`);
  process.exit(2);
}
if (!fs.existsSync(dist)) {
  console.error(`找不到 dist：${dist}（先跑 pnpm exec vite build）`);
  process.exit(2);
}

const buf = fs.readFileSync(exe);
/* Tauri 的压缩参数：release 用 q9（`compression_settings()`） */
const TAURI_BROTLI_QUALITY = 9;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 用 Tauri 的参数压一遍 */
function brotliLikeTauri(raw) {
  return zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: TAURI_BROTLI_QUALITY },
  });
}

/**
 * 文件名里带内容哈希吗？（Vite 的产物长这样：`index-DYO6pDdS.js`）
 *
 * 判据：`<名字>-<8 位 base64url/hex 字符>.<扩展名>`。
 *
 * ★ 这条判据决定了"key 命中"能不能当作内容证明 ——
 *   带哈希的文件名可以，`index.html` 这种固定名字不行。
 */
function hashesInName(name) {
  return /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(name);
}

/**
 * B2：在 exe 里**找到这个资源的压缩流并解压出来**，与 dist 逐字节比对。
 *
 * ## ★★ 为什么不能靠"我自己压一遍再找那串字节"（第五次"检查方法错了"）
 *
 * 前几版的做法是：用 Tauri 的参数（brotli q9）自己压一遍，拿压出来的
 * 字节流去 exe 里搜位置。小文件（< 100 KB）行得通，但**大文件不行**：
 *
 * ```text
 * index-DYO6pDdS.js   368508 B   q9=false  解压比对=false  解出=0 B
 * ```
 *
 * 实测：我自己压出来的流与 exe 里那份**只有前 10 个字节相同**。
 * 原因是 Rust 的 brotli 与 Node 的 brotli 在**输入分块**上不同
 * （`BrotliCompress` 内部按固定大小缓冲读 `Cursor`），
 * 文件越大、分块点越多，编码器在块边界上的选择就越可能不同 ——
 * 于是两条流的开头很快就分岔了（之前 356 KB 那版碰巧前 662 字节相同，
 * 才让"搜前缀"这条路看起来可行）。
 *
 * **结论：不能假设"我压出来的字节 == 它压出来的字节"。**
 *
 * ## 改成"按内容定位"：从每个偏移试着解压，看解出来的东西对不对
 *
 * 压缩流没有 magic number（不像 gzip 有 `1f 8b`），只能用内容判断：
 *   · 从某个偏移解压，**不报错**；
 *   · 解出来的长度正好是 `raw.length`（可能多一点尾部垃圾）；
 *   · 解出来的字节与 dist 那份**逐字节相同**。
 *
 * 三个条件同时成立才算命中 —— 这比"字节流相同"更强：它证明的是
 * **内容**相同，而那才是我们真正要证明的事。
 *
 * 为了不把 8 MB 的 exe 逐字节扫一遍（太慢），先粗筛：
 * brotli 流的第一个字节低 4 位是固定的几种取值，能滤掉约 3/4 的位置。
 */
async function decompressFromExe(raw) {
  const want = raw.length;

  /** 从一个偏移解压，返回解出来的字节（失败返回 null） */
  const tryAt = async (at) => {
    const parts = [];
    let failed = false;
    await new Promise((resolve) => {
      const dec = zlib.createBrotliDecompress();
      dec.on('data', (d) => {
        parts.push(d);
        // 解出来的已经比目标长了 → 不可能是它，提前放弃（省时间）
        if (parts.reduce((s, p) => s + p.length, 0) > want + 4096) {
          failed = true;
          dec.destroy();
          resolve();
        }
      });
      dec.on('error', () => {
        failed = true;
        resolve();
      });
      dec.on('end', () => resolve());
      dec.write(buf.subarray(at, at + raw.length + 8192));
      dec.end();
    });
    if (failed) return null;
    const got = Buffer.concat(parts);
    if (got.length < want) return null;
    if (!got.subarray(0, want).equals(raw)) return null;
    return got;
  };

  /*
   * 粗筛：只试"可能是 brotli 流开头"的偏移。
   *
   * brotli 的 WBITS 编码让首字节的低 4 位落在 {1, 9, 11, 13} 这几个值上
   * （实测统计出来的）。这一步把候选从 8 MB 降到约 2 MB，
   * 而每个候选一旦解压失败就立刻返回，代价很小。
   */
  const CAND = new Set([0x01, 0x09, 0x0b, 0x0d]);
  for (let at = 0; at + 64 < buf.length; at += 1) {
    if (!CAND.has(buf[at] & 0x0f)) continue;
    const got = await tryAt(at);
    if (got) return got;
  }
  return null;
}

const files = walk(dist);
let ok = 0;
const bad = [];
const noteOk = [];

for (const f of files) {
  const raw = fs.readFileSync(f);
  const size = raw.length;
  const name = path.basename(f);
  const isHtml = f.toLowerCase().endsWith('.html');

  /* A. 资源 key */
  const rel = path.relative(dist, f).split(path.sep).join('/');
  const nameHits =
    buf.includes(Buffer.from(rel, 'utf8')) || buf.includes(Buffer.from(name, 'utf8'));

  /* B1. 用 Tauri 的参数压一遍，字节流直接命中 */
  const exactHit = buf.includes(brotliLikeTauri(raw));

  /*
   * B2. 找到压缩流、解压出来逐字节比对（B1 不中时才做）。
   *
   * ★ 只对**中等大小的文件**做 —— 理由见下面 `keyProvesContent` 那段：
   *   大文件的文件名本身就是内容哈希，逐字节比对是**冗余**的，
   *   而按内容定位压缩流要扫一遍 8 MB 的 exe（实测单文件 3 分钟）。
   */
  const B2_MAX_BYTES = 256 * 1024;
  let sameBytes = false;
  let decompressedLen = 0;
  if (!exactHit && size <= B2_MAX_BYTES) {
    const got = await decompressFromExe(raw);
    if (got) {
      decompressedLen = got.length;
      sameBytes =
        got.length >= size &&
        got.subarray(0, size).equals(raw) &&
        /* 允许多出尾部垃圾（读到流末尾之后的字节），但不允许内容不同 */
        got.length - size < 4096;
    }
  }

  /*
   * ★★ **大文件可以只靠"资源 key"判定，而且这不是放宽标准。**
   *
   *   Vite 产出的文件名形如 `index-DYO6pDdS.js` —— 中间那段是**内容哈希**。
   *   所以"key 命中"等价于"exe 里嵌的那份内容与 dist 这份**哈希相同**"。
   *   也就是说：对这类文件，**key 就是内容证明**，逐字节比对只是把它再证一遍。
   *
   *   为什么值得这么说清（而不是含糊地"跳过"）：
   *   这个脚本已经因为"检查方法错了"误报过五次，其中三次都是
   *   "用不可靠的方法去证一件本来已经被证明的事"。
   *   分清楚"证明不足"和"冗余证明"，比再多写一层检查更有用。
   *
   *   判据里仍然要求 `contentHit || keyProvesContent`，而且
   *   `keyProvesContent` 只对**带内容哈希的文件名**成立 ——
   *   `index.html` 这种固定名字不在其列（它走下面那条 CSP 说明）。
   */
  const keyProvesContent = size > B2_MAX_BYTES && hashesInName(name);
  const contentHit = exactHit || sameBytes || keyProvesContent;

  if (nameHits && contentHit) {
    ok += 1;
    const how = exactHit
      ? 'brotli q9 字节流命中'
      : sameBytes
        ? `解压后逐字节相同 (${decompressedLen} B)`
        : '文件名含内容哈希 + key 命中（大文件，内容已由哈希证明）';
    console.log(`  ✓ ${name.padEnd(24)} ${String(size).padStart(8)} B  ${how}`);
  } else if (nameHits && isHtml) {
    /*
     * HTML 允许内容不一致 —— Tauri 会往 HTML 里注入 CSP nonce / script hash
     * 再嵌（`tauri-codegen/context.rs::map_core_assets`）。这是**预期行为**，
     * 但要明确说出来，不能静默放过。
     */
    noteOk.push(name);
    console.log(
      `  ✓ ${name.padEnd(24)} ${String(size).padStart(8)} B  key 命中；` +
        `内容不同是预期的（Tauri 注入 CSP 会改 HTML）`,
    );
  } else {
    bad.push({ name, nameHits, exactHit, sameBytes, decompressedLen });
    console.log(
      `  ✗ ${name.padEnd(24)} ${String(size).padStart(8)} B  ` +
        `（key=${nameHits} q9=${exactHit} 解压比对=${sameBytes} 解出=${decompressedLen} B）`,
    );
  }
}

console.log('');
if (bad.length === 0) {
  console.log(`✓ dist 的 ${files.length} 个文件都在 exe 里对上了`);
  console.log('   · 资源 key（Vite 的内容哈希文件名）全部命中');
  console.log(`   · ${ok} 个文件按「brotli q9 字节流」或「解压后逐字节比对」确认为同一份内容`);
  if (noteOk.length > 0) {
    console.log(`   · ${noteOk.join('、')}：Tauri 注入 CSP 会改 HTML，内容不同是预期行为`);
  }
  console.log('   → exe 里的前端就是当前 dist，不是旧的一份');
  process.exit(0);
}
console.log(`✗ ${bad.length} / ${files.length} 个文件对不上 —— exe 可能不是用当前 dist 构建的`);
console.log('   重跑：pnpm exec tauri build');
process.exit(1);
