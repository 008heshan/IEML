// 诊断：1.20.1 的 asset index 里有没有"两个不同 hash 指向同一个磁盘路径"
// 或"同一 hash 被多个名字引用"的情况 —— 这会让两个并发任务抢同一个文件。
// 用法：node tools/diag-asset-collisions.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const idx = path.join(os.tmpdir(), 'ieml-live-test', 'assets', 'indexes', '5.json');
const raw = JSON.parse(fs.readFileSync(idx, 'utf8'));
const objects = raw.objects;

const byHash = new Map();
const paths = new Map(); // 磁盘路径 -> 引用的条目

for (const [name, obj] of Object.entries(objects)) {
  const h = obj.hash;
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(name);
  const p = `${h.slice(0, 2)}/${h}`;
  if (!paths.has(p)) paths.set(p, []);
  paths.get(p).push({ name, hash: h });
}

console.log('资源条目:', Object.keys(objects).length, '唯一 hash:', byHash.size);

const shared = [...byHash.entries()].filter(([, names]) => names.length > 1);
console.log('同 hash 多个名字:', shared.length);
for (const [h, names] of shared.slice(0, 5)) console.log('   ', h.slice(0, 8), '→', names.length, '个名字');

// 磁盘路径冲突（不同 hash 落到同一个文件名）——不可能，因为文件名就是 hash；
// 但同一个 hash 路径被多个任务写是可能的（上面那种）
const ogg = Object.entries(objects).filter(([n]) => n.endsWith('.ogg'));
console.log('ogg 条目:', ogg.length);

// 那 23 个一直在失败的文件，它们的 hash 是否被别的名字也引用？
const failing = [
  'minecraft/sounds/liquid/swim1.ogg',
  'minecraft/sounds/liquid/swim2.ogg',
  'minecraft/sounds/liquid/swim3.ogg',
  'minecraft/sounds/liquid/swim4.ogg',
];
for (const f of failing) {
  const o = objects[f];
  if (!o) {
    console.log(f, '→ 索引里没有这个名字！');
    continue;
  }
  const names = byHash.get(o.hash) ?? [];
  console.log(
    f,
    '→ hash',
    o.hash.slice(0, 8),
    'size',
    o.size,
    '被',
    names.length,
    '个名字引用:',
    names.slice(0, 3).join(', '),
  );
  const onDisk = path.join(os.tmpdir(), 'ieml-live-test', 'assets', 'objects', o.hash.slice(0, 2), o.hash);
  console.log('    磁盘上存在:', fs.existsSync(onDisk));
}
