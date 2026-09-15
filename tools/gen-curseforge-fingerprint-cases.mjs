/**
 * 生成 / 校验 **CurseForge 指纹（MurmurHash2）** 的跨语言判据表。
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/gen-curseforge-fingerprint-cases.mjs          # 打印（不写文件）
 *   node tools/gen-curseforge-fingerprint-cases.mjs --write  # 写进 tests/curseforge-fingerprint.cases.json
 *
 * ## 这个算法的可信度从哪来（不是"我觉得对"）
 *
 *   1. 算法按 CurseForge 官方文档：**MurmurHash2（32 位，种子 1）**，
 *      并把 `\t \n \r 空格` **全部剔除**后再算；
 *   2. 这份 JS 实现被**接口自己验证过**：用真实文件（CF 项目 1558643 的
 *      文件 #8600126）下载后算指纹，`POST /v1/fingerprints` 把那个文件
 *      **原样认了回来**（见 tools/probe-curseforge-deep.mjs 的第 ⑤ 节）。
 *      也就是说：算法错一个字节，接口就不会返回 exactMatch。
 *   3. 生成的向量表由 Rust 侧（`net::curseforge::fingerprint`）逐条对齐 ——
 *      两边不一致就红。这正是 ADR-051 立下的规矩：**同一判据只实现一次**，
 *      真的必须两份时，用同一张表钉住。
 */
import { writeFileSync } from 'node:fs';

const M = 0x5bd1e995;
const R = 24;

/** MurmurHash2（32 位，种子 1） */
function murmur2(data) {
  let h = (1 ^ data.length) >>> 0;
  let i = 0;
  const len = data.length;
  while (len - i >= 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    k = (k ^ (k >>> R)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    h = Math.imul(h, M) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
  }
  switch (len - i) {
    case 3:
      h = (h ^ (data[i + 2] << 16)) >>> 0;
    // falls through
    case 2:
      h = (h ^ (data[i + 1] << 8)) >>> 0;
    // falls through
    case 1:
      h = (h ^ data[i]) >>> 0;
      h = Math.imul(h, M) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, M) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

/** CurseForge 的指纹：先剔除空白字符，再算 MurmurHash2 */
export function fingerprint(buf) {
  const kept = [];
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || b === 32) continue;
    kept.push(b);
  }
  return murmur2(Uint8Array.from(kept));
}

const hex = (s) => Array.from(Buffer.from(s, 'utf8'));
const range = (n, f) => new Uint8Array(Array.from({ length: n }, (_, i) => f(i)));

const CASES = [
  ['空文件（剔完还是空）', new Uint8Array([])],
  ['只有空白：空格 / \\t / \\r / \\n 全剔除后是空', new Uint8Array(hex(' \t\r\n '))],
  ['单字节 a', new Uint8Array([0x61])],
  ['3 字节 abc（走 tail 分支）', new Uint8Array([0x61, 0x62, 0x63])],
  ['4 字节 abcd（正好一个 chunk，不进 tail）', new Uint8Array([0x61, 0x62, 0x63, 0x64])],
  ['5 字节 abcde（一个 chunk + 1 字节 tail）', new Uint8Array(hex('abcde'))],
  ['11 字节 hello world', new Uint8Array(hex('hello world'))],
  ['a\\tb\\nc\\rd e：空白剔除后等于 abcde', new Uint8Array(hex('a\tb\nc\rd e'))],
  ['中文（UTF-8 多字节，逐字节算）', new Uint8Array(hex('我的世界'))],
  ['全部 256 个字节值（里面正好有 4 个空白字符会被剔除）', range(256, (i) => i)],
  ['1024 个 0x5A', range(1024, () => 0x5a)],
  ['1023 个 0x00（长 tail）', range(1023, () => 0)],
];

const out = {
  _readme: [
    'CurseForge 指纹（MurmurHash2）的**跨语言判据表**（ADR-052）。',
    '',
    '算法：MurmurHash2（32 位，种子 1），先把 \\t \\n \\r 空格 全部剔除再算。',
    '这份向量由 tools/gen-curseforge-fingerprint-cases.mjs 生成，',
    '而那份 JS 实现**被 CurseForge 接口自己验证过**：',
    '下载真实文件（项目 1558643 / 文件 #8600126）算指纹，',
    'POST /v1/fingerprints 能把该文件原样认回来（见 tools/probe-curseforge-deep.mjs 第 ⑤ 节）。',
    '',
    '消费方：',
    '  · Rust  src-tauri/src/net/curseforge.rs 的 fingerprint_of_file（cargo test --lib net::curseforge）',
    '  · JS    本工具（--verify 模式逐条复算）',
    '两边不一致就红 —— 指纹算错的表现是"所有 Mod 都查不到更新"，',
    '而那是**静默**的（接口只会回一个空的 exactMatches）。',
  ],
  cases: CASES.map(([name, bytes]) => {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const v = fingerprint(b);
    return {
      name,
      bytes: b.length,
      inputHex: Buffer.from(b).toString('hex'),
      expectUnsigned: v,
      expectHex: `0x${v.toString(16).padStart(8, '0')}`,
    };
  }),
};

if (process.argv.includes('--verify')) {
  let bad = 0;
  for (const c of out.cases) {
    const got = fingerprint(new Uint8Array(Buffer.from(c.inputHex, 'hex')));
    if (got !== c.expectUnsigned) {
      console.log(`✗ ${c.name}：表里 ${c.expectUnsigned}，实算 ${got}`);
      bad++;
    }
  }
  console.log(bad === 0 ? `✓ ${out.cases.length} 条向量全部复算一致` : `${bad} 条不一致`);
  process.exit(bad === 0 ? 0 : 1);
}

const text = JSON.stringify(out, null, 2);
if (process.argv.includes('--write')) {
  writeFileSync('tests/curseforge-fingerprint.cases.json', `${text}\n`, 'utf8');
  console.log(`✓ 已写入 tests/curseforge-fingerprint.cases.json（${out.cases.length} 条）`);
} else {
  console.log(text);
}
