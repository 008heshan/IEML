// 检查一个版本 JSON 的关键字段（诊断用）
// 用法：node tools/diag/version-json-fields.mjs <版本目录名>
import fs from 'node:fs';
import path from 'node:path';

const id = process.argv[2];
if (!id) {
  console.error('用法: node tools/diag/version-json-fields.mjs <版本目录名>');
  process.exit(2);
}
const dir = path.join(process.env.APPDATA ?? '', 'IEML', 'shared', 'versions', id);
console.log(`目录 ${dir}`);
for (const f of fs.readdirSync(dir)) {
  console.log(`  · ${f}  ${fs.statSync(path.join(dir, f)).size} B`);
}

const jsonFile = path.join(dir, `${id}.json`);
if (!fs.existsSync(jsonFile)) {
  console.log('（没有 <id>.json）');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
console.log(`\nid          = ${j.id}`);
console.log(`mainClass   = ${j.mainClass}`);
console.log(`inheritsFrom= ${j.inheritsFrom ?? '(无)'}`);
console.log(`libraries   = ${(j.libraries ?? []).length} 个`);
const fabric = (j.libraries ?? []).filter((l) => /fabric/i.test(l.name ?? ''));
console.log(`其中含 fabric 的 = ${fabric.length} 个`);
for (const l of fabric.slice(0, 6)) {
  const art = l.downloads?.artifact;
  console.log(`  · ${l.name}  →  ${art?.path ?? '(无 artifact)'}`);
}
