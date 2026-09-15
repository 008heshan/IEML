// 对比：Fabric 版 JSON 与其原版父版 JSON 的库，找出被漏掉的依赖
// 用法：node tools/diag/diff-loader-libs.mjs fabric-loader-0.19.5-26.2 26.2
import fs from 'node:fs';
import path from 'node:path';

const [loaderId, vanillaId] = process.argv.slice(2);
if (!loaderId || !vanillaId) {
  console.error('用法: node tools/diag/diff-loader-libs.mjs <加载器版本目录> <原版版本目录>');
  process.exit(2);
}
const vs = path.join(process.env.APPDATA ?? '', 'IEML', 'shared', 'versions');
const read = (id) => JSON.parse(fs.readFileSync(path.join(vs, id, `${id}.json`), 'utf8'));

const loader = read(loaderId);
const vanilla = read(vanillaId);

const names = (j) => new Set((j.libraries ?? []).map((l) => l.name));
const ln = names(loader);
const vn = names(vanilla);

console.log(`${loaderId}: ${ln.size} 个库（id=${loader.id}, inheritsFrom=${loader.inheritsFrom}）`);
console.log(`${vanillaId}: ${vn.size} 个库`);
console.log(`两者共有: ${[...ln].filter((n) => vn.has(n)).length}`);
console.log(`只在加载器版里: ${[...ln].filter((n) => !vn.has(n)).length}`);
console.log(`只在原版里: ${[...vn].filter((n) => !ln.has(n)).length}`);

console.log('\n--- 加载器版里的 lwjgl 库 ---');
for (const n of [...ln].filter((n) => /lwjgl/.test(n))) console.log('  ', n);
console.log('\n--- 原版里的 lwjgl 库（前 8 个）---');
for (const n of [...vn].filter((n) => /lwjgl/.test(n)).slice(0, 8)) console.log('  ', n);

console.log('\n--- 只在原版里、且原版版没有 downloads 的库 ---');
const vanillaOnly = [...vn].filter((n) => !ln.has(n));
console.log(`  共 ${vanillaOnly.length} 个`);
for (const n of vanillaOnly.slice(0, 10)) {
  const l = (vanilla.libraries ?? []).find((x) => x.name === n);
  const has = l?.downloads?.artifact?.path ? '有 downloads' : '无 downloads（靠 url 推）';
  console.log(`  · ${n}  [${has}]`);
}

// 关键：合并逻辑是靠 group:artifact 去重的。检查有没有"同名不同版本"被误去重
const key = (n) => n.split(':').slice(0, 2).join(':');
const dupes = [];
const seen = new Map();
for (const l of loader.libraries ?? []) {
  const k = key(l.name);
  if (seen.has(k) && seen.get(k) !== l.name) dupes.push([seen.get(k), l.name]);
  seen.set(k, l.name);
}
console.log(`\n--- 加载器版内部同名不同版本的条目（靠 group:artifact 去重会丢一个）---`);
console.log(`  共 ${dupes.length} 组`);
for (const [a, b] of dupes.slice(0, 8)) console.log(`  · ${a}  vs  ${b}`);
