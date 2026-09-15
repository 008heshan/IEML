// 找出"某个类应该来自哪个库"，并检查它在磁盘上是否存在
// 用法：node tools/diag/class-comes-from-which-jar.mjs [类名片段] [版本目录名]
import fs from 'node:fs';
import path from 'node:path';

const needle = process.argv[2] ?? 'lwjgl';
const versionDir = process.argv[3] ?? 'fabric-loader-0.19.5-26.2';
const home = path.join(process.env.APPDATA ?? '', 'IEML', 'shared');
const vjson = path.join(home, 'versions', versionDir, `${versionDir}.json`);
const j = JSON.parse(fs.readFileSync(vjson, 'utf8'));

console.log(`版本 ${versionDir}：${(j.libraries ?? []).length} 个库`);
console.log(`筛选 name 含 "${needle}" 的条目：\n`);

for (const l of j.libraries ?? []) {
  if (!l.name.includes(needle)) continue;
  const art = l.downloads?.artifact;
  const rel = art?.path;
  const onDisk = rel ? fs.existsSync(path.join(home, 'libraries', rel)) : false;
  const rules = l.rules?.length
    ? l.rules
        .map((r) => `${r.action}${r.os?.name ? '/' + r.os.name : ''}${r.os?.arch ? '/' + r.os.arch : ''}`)
        .join(',')
    : '(无规则)';
  console.log(`  ${l.name}`);
  console.log(`      path=${rel ?? '(无)'}  url=${art?.url ? '有' : (l.url ?? '(无)')}`);
  console.log(`      规则=${rules}  磁盘存在=${onDisk}`);
}
