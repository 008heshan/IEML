// 诊断：26.2 的版本 JSON 里 natives 是怎么给的？启动命令里 java.library.path 指向哪？
// 用法：node tools/diag-262-natives.mjs
import fs from 'node:fs';
import path from 'node:path';

const p = path.join(process.env.APPDATA, 'IEML', 'shared', 'versions', '26.2', '26.2.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('id:', j.id);
console.log('mainClass:', j.mainClass);
console.log('javaVersion:', JSON.stringify(j.javaVersion));
console.log('assets:', j.assets, 'assetIndex:', j.assetIndex && j.assetIndex.id);

const jvm = (j.arguments && j.arguments.jvm) || [];
const flat = jvm.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
console.log('--- jvm 参数里提到 library / natives / classpath 的 ---');
for (const s of flat) if (/library|natives|classpath/i.test(s)) console.log('   ', s);

let modern = 0;
let legacy = 0;
const nativeNames = [];
for (const l of j.libraries || []) {
  const nm = l.name || '';
  if (/:natives-/.test(nm)) {
    modern++;
    nativeNames.push(nm);
  }
  if (l.natives && Object.keys(l.natives).length) legacy++;
}
console.log('--- natives 库 ---');
console.log('   现代格式（:natives-windows 独立条目）:', modern);
console.log('   老格式（natives 字段）:', legacy);
for (const n of nativeNames.slice(0, 12)) console.log('   ', n);

// 关键：这个版本的 java.library.path 是从模板来的，还是我们补的？
const hasLibraryPath = flat.some((s) => s.includes('java.library.path'));
console.log('模板里自带 java.library.path:', hasLibraryPath);

// lwjgl 相关的库
const lwjgl = (j.libraries || []).filter((l) => (l.name || '').includes('lwjgl'));
console.log('--- lwjgl 库条目数:', lwjgl.length, '---');
for (const l of lwjgl.slice(0, 20)) {
  const art = l.downloads && l.downloads.artifact;
  console.log('   ', l.name, '| artifact:', art ? art.path : '(none)');
}
