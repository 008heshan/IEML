/*
 * 解压 DSH 会话记录（session.v3.jsonl.zstd）并读内容。
 *
 * ★ 关键：这是**多帧 zstd**（每追加一次写一个独立帧，实测 1.4 MB 里有 1188 帧）。
 *   `zstdDecompressSync` 和 `createZstdDecompress()` **都只解第一帧**，
 *   直接用会拿到"1 条记录、0.0 MB"，看起来像会话是空的 —— 其实内容都在后面。
 *   所以这里按魔数扫出每个帧的偏移，逐帧解。
 *
 * 用法: node tools/diag/read-dsh-session.mjs <path> [info|user|tail|grep <关键词>]
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function frameOffsets(b) {
  const out = [];
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === ZSTD_MAGIC[0] && b[i + 1] === ZSTD_MAGIC[1] &&
        b[i + 2] === ZSTD_MAGIC[2] && b[i + 3] === ZSTD_MAGIC[3]) out.push(i);
  }
  return out;
}

/** 逐帧解压。误命中的魔数会解压失败，跳过即可；末尾不完整的帧同理。 */
export function decompressSession(path) {
  const b = readFileSync(path);
  const offs = frameOffsets(b);
  const parts = [];
  let okFrames = 0;
  for (const off of offs) {
    try {
      parts.push(zlib.zstdDecompressSync(b.subarray(off)).toString('utf8'));
      okFrames++;
    } catch { /* 误命中或截断帧 */ }
  }
  return { text: parts.join(''), frames: offs.length, okFrames };
}

function pickContent(r) {
  // ★ DSH v3 的实际结构是 `{type, seq, time, data:{content:[{type:'text',text}], role}}`
  const d = r.data ?? r;
  let c = d.content ?? d.message?.content ?? d.text ?? d.summary;
  if (Array.isArray(c)) {
    c = c.map((x) => (typeof x === 'string' ? x : x.text ?? x.content ?? '')).join(' ');
  }
  if (c == null) return '';
  return (typeof c === 'string' ? c : JSON.stringify(c)).replace(/\s+/g, ' ').trim();
}

function roleOf(r) {
  return r.data?.role ?? r.role ?? r.message?.role ?? r.type ?? '(无)';
}

const isMain = process.argv[1]?.endsWith('read-dsh-session.mjs');
if (isMain) {
  const path = process.argv[2];
  const mode = process.argv[3] ?? 'info';
  const { text, frames, okFrames } = decompressSession(path);
  const lines = text.split('\n').filter((l) => l.trim());
  const recs = [];
  for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* 坏行 */ } }

  console.log(`帧 ${frames} 个（解得 ${okFrames}）→ ${(text.length / 1048576).toFixed(2)} MB，${lines.length} 行，${recs.length} 条记录\n`);

  const roles = new Map();
  for (const r of recs) {
    const k = r.role ?? r.message?.role ?? r.type ?? '(无)';
    roles.set(k, (roles.get(k) ?? 0) + 1);
  }
  console.log('类型分布:');
  for (const [k, n] of [...roles].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(22)} ${n}`);

  if (mode === 'user') {
    console.log('\n=== 用户消息 ===');
    let i = 0;
    for (const r of recs) {
      const role = roleOf(r);
      if (role !== 'user') continue;
      const c = pickContent(r);
      if (!c) continue;
      i++;
      console.log(`\n[${i}] ${c.slice(0, 600)}`);
    }
    console.log(`\n共 ${i} 条用户消息`);
  }

  if (mode === 'tail') {
    const n = Number(process.argv[4] ?? 12);
    console.log(`\n=== 最后 ${n} 条 ===`);
    for (const r of recs.slice(-n)) {
      const role = roleOf(r);
      const c = pickContent(r);
      console.log(`\n--- ${role} ---\n${c.slice(0, 900)}`);
    }
  }

  if (mode === 'grep') {
    const kw = process.argv[4];
    console.log(`\n=== 含「${kw}」的记录 ===`);
    let i = 0;
    for (const r of recs) {
      const c = pickContent(r);
      if (!c.includes(kw)) continue;
      i++;
      const role = r.role ?? r.message?.role ?? r.type;
      console.log(`\n[${i}] (${role}) ${c.slice(0, 700)}`);
    }
    console.log(`\n命中 ${i} 条`);
  }
}
