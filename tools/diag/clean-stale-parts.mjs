// 一次性清理：删掉 IEML 数据目录里卡死的下载残留（.part / .part.N / .part.chunks）
// 用法：node tools/diag/clean-stale-parts.mjs [--apply]
// 默认只报告不动手；加 --apply 才真删。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const apply = process.argv.includes('--apply');
const root = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'IEML');

/** 与 Rust 侧 net::download::is_part_file 保持一致的判据 */
function isPartFile(name) {
  return name.endsWith('.part') || name.includes('.part.');
}

const hits = [];
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (isPartFile(e.name)) {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* ignore */
      }
      hits.push({ p, size });
    }
  }
}

console.log(`扫描 ${root} …`);
walk(root);

const total = hits.reduce((a, h) => a + h.size, 0);
console.log(`找到 ${hits.length} 个下载残留，共 ${(total / 1024 / 1024).toFixed(2)} MB\n`);

const byDir = new Map();
for (const h of hits) {
  const d = path.dirname(h.p).replace(root, '') || '\\';
  const cur = byDir.get(d) ?? { n: 0, bytes: 0 };
  cur.n++;
  cur.bytes += h.size;
  byDir.set(d, cur);
}
for (const [d, v] of [...byDir.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${d}  ${v.n} 个 · ${(v.bytes / 1024 / 1024).toFixed(2)} MB`);
}

if (!apply) {
  console.log('\n（只报告。加 --apply 才会真的删除）');
} else {
  let removed = 0;
  let bytes = 0;
  for (const h of hits) {
    try {
      fs.unlinkSync(h.p);
      removed++;
      bytes += h.size;
    } catch (e) {
      console.log(`  删除失败 ${path.basename(h.p)}: ${e.code}`);
    }
  }
  console.log(`\n✓ 已删除 ${removed} 个文件，释放 ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}
